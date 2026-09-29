// offscreen.js
//
// The export engine. Runs inside an offscreen document so it can:
//   - fetch instagram.com's API with the user's session (host permission)
//   - fetch CDN media bytes cross-origin (host permission bypasses CORS)
//   - URL.createObjectURL the finished ZIP (unavailable in a service worker)
//
// It receives one job at a time from background.js, streams progress back, and
// hands the finished blob URL + filename to the service worker to download.

import { createZip } from "./src/zip.js";
import {
  resolveUser,
  paginateFeed,
  extractMedia,
  shortcodeToMediaId,
  getMediaInfo,
  getReel,
  getHighlightsTray,
  IGError,
} from "./src/igapi.js";

const MEDIA_CONCURRENCY = 6;
const textEncoder = new TextEncoder();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastBlobUrl = null;

/* ===== messaging ===== */

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function progress(jobId, phase, done, total, message) {
  send({ type: "EXPORT_PROGRESS", jobId, phase, done, total, message });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;

  if (msg.type === "RUN_EXPORT") {
    runExport(msg.job);
  } else if (msg.type === "REVOKE" && msg.url) {
    if (msg.url === lastBlobUrl) lastBlobUrl = null;
    URL.revokeObjectURL(msg.url);
  }
});

/* ===== small utilities ===== */

// Keep letters/marks/digits from any script (Bengali, Arabic, CJK, …) so names
// stay readable; replace everything else, including path separators. Emoji
// selectors/joiners go first so a dropped emoji doesn't leave one behind.
function sanitize(name) {
  return String(name)
    .replace(/[\uFE00-\uFE0F\u200D]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}_\-.]+/gu, "_")
    .replace(/^[_.]+|_+$/g, "") || "untitled";
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function dateStr(takenAt) {
  if (!takenAt) return "0000-00-00";
  const d = new Date(takenAt * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function fetchBytes(url) {
  // credentials omitted: CDN media is public and sending IG cookies to the
  // CDN can trigger 403s. Host permission still lets us read the body.
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`media ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Instagram's CDN serves most images as WebP even where the API implies JPEG,
// so name image files by what the bytes actually are.
function imageExt(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "webp";
  return null;
}

function withRealExt(path, bytes) {
  const ext = /\.(jpg|png|webp)$/.test(path) && imageExt(bytes);
  return ext ? path.replace(/\.\w+$/, `.${ext}`) : path;
}

// Run `worker` over `items` with bounded concurrency, preserving index order.
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx], idx);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

// A story / highlight item is a single logical media; grab its primary file
// (the video or image) and ignore the video poster thumbnail.
function primaryMedia(ex) {
  return ex.media.find((m) => !m.isThumb) || null;
}

// Download a flat queue of { path, url } media into ZIP entries, reporting
// file-level progress. Fixes each q.path's extension to the real file type in
// place, so indexes built afterwards from the queue match the ZIP.
// Returns { entries, failed, total }.
async function fetchQueueToEntries(jobId, queue, label) {
  const total = queue.length;
  let done = 0;
  let failed = 0;
  progress(jobId, "downloading", 0, total, `Downloading ${total} ${label}…`);
  const fetched = await mapPool(queue, MEDIA_CONCURRENCY, async (q) => {
    try {
      const bytes = await fetchBytes(q.url);
      q.path = withRealExt(q.path, bytes);
      return { path: q.path, bytes };
    } catch {
      failed++;
      return null;
    } finally {
      done++;
      progress(jobId, "downloading", done, total);
    }
  });
  return { entries: fetched.filter(Boolean), failed, total };
}

/* ===== enumeration ===== */

// Collect normalized posts from a user's grid, honoring the mode filter
// (e.g. reels-only) and the count/date filters. Returns newest-first.
async function collectItems(jobId, username, modeFilter, filter) {
  const collected = [];
  const seen = new Set();
  const fromTs = filter?.fromDate ? Math.floor(Date.parse(filter.fromDate + "T00:00:00") / 1000) : null;
  const toTs = filter?.toDate ? Math.floor(Date.parse(filter.toDate + "T23:59:59") / 1000) : null;
  const n = Math.max(1, filter?.n | 0);
  let unpinned = 0;

  let stop = false;
  await paginateFeed(username, (rawItems) => {
    for (const raw of rawItems) {
      const ex = extractMedia(raw);
      if (seen.has(ex.shortcode)) continue;
      seen.add(ex.shortcode);

      if (filter?.type === "range") {
        if (fromTs && ex.takenAt && ex.takenAt < fromTs) {
          // Past the pinned posts the grid is newest-first: once we drop below
          // "from", nothing older can qualify, so stop paging entirely.
          if (ex.pinned) continue;
          stop = true;
          break;
        }
        if (toTs && ex.takenAt && ex.takenAt > toTs) continue;
      }

      if (!modeFilter(ex)) continue;

      collected.push(ex);
      progress(jobId, "enumerating", collected.length, null, `Found ${collected.length} items…`);

      // Pinned posts can be arbitrarily old, so only chronological ones count
      // towards "most recent N"; the sort below puts pinned ones in place.
      if (filter?.type === "recent" && !ex.pinned && ++unpinned >= n) {
        stop = true;
        break;
      }
    }
    return stop;
  });

  collected.sort((a, b) => b.takenAt - a.takenAt);
  if (filter?.type === "recent") return collected.slice(0, n);
  if (filter?.type === "oldest") return collected.slice(-n);
  return collected;
}

/* ===== packaging ===== */

// Build the per-post file list (names + urls) from a normalized item.
// `imagesOnly` drops videos and their poster thumbnails.
function planPostFiles(post, { imagesOnly = false } = {}) {
  const files = [];
  let slot = 0;
  for (const m of post.media) {
    if (m.isThumb) {
      if (imagesOnly) continue;
      files.push({ name: `${pad(slot)}_thumb.jpg`, url: m.url });
      continue;
    }
    if (imagesOnly && m.isVideo) continue;
    slot++;
    files.push({ name: `${pad(slot)}.${m.type}`, url: m.url });
  }
  return files;
}

// Shared pipeline for the foldered ZIP modes (posts / images).
async function exportFolderedZip(job, user, { imagesOnly }) {
  const { jobId } = job;
  const items = await collectItems(jobId, user.username, () => true, job.options.filter);

  // Attach a planned file list to each post; drop posts that contribute nothing.
  const posts = [];
  for (const post of items) {
    const files = planPostFiles(post, { imagesOnly });
    if (files.length === 0) continue;
    posts.push({ post, files });
  }

  if (posts.length === 0) {
    throw new IGError(
      imagesOnly ? "No images found for this selection." : "No posts found for this selection.",
      0
    );
  }

  // Flatten to a download queue so we can show real file-level progress.
  const queue = [];
  posts.forEach((p, i) => {
    const idx = i + 1;
    const folder = `${pad(idx, 3)}_${dateStr(p.post.takenAt)}_${sanitize(p.post.shortcode)}`;
    p.folder = folder;
    for (const f of p.files) queue.push({ path: `${folder}/${f.name}`, url: f.url, file: f });
  });

  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "files");
  for (const q of queue) q.file.name = q.path.slice(q.path.indexOf("/") + 1);

  // caption.txt per post + a top-level index.json.
  const index = [];
  posts.forEach((p, i) => {
    const idx = i + 1;
    if (p.post.caption) {
      entries.push({
        path: `${p.folder}/caption.txt`,
        bytes: textEncoder.encode(p.post.caption),
      });
    }
    index.push({
      index: idx,
      folder: p.folder,
      shortcode: p.post.shortcode,
      taken_at: p.post.takenAt,
      date: dateStr(p.post.takenAt),
      kind: p.post.kind,
      url: `https://www.instagram.com/p/${p.post.shortcode}/`,
      caption: p.post.caption,
      files: p.files.map((f) => f.name),
    });
  });
  entries.push({
    path: "index.json",
    bytes: textEncoder.encode(JSON.stringify({ username: user.username, exported_at: nowStamp(), count: posts.length, posts: index }, null, 2)),
  });

  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  const zipBytes = createZip(entries);
  const suffix = imagesOnly ? "images" : "posts";
  finishBlob(job, zipBytes, `${sanitize(user.username)}_${suffix}_${nowStamp()}.zip`, { posts: posts.length, files: total, failed });
}

async function exportReels(job, user) {
  const { jobId } = job;
  const reels = await collectItems(jobId, user.username, (ex) => ex.kind === "reel", job.options.filter);
  if (reels.length === 0) throw new IGError("No reels found for this selection.", 0);

  const queue = [];
  reels.forEach((r, i) => {
    const idx = i + 1;
    const video = r.media.find((m) => m.isVideo);
    if (!video) return;
    const name = `${pad(idx, 3)}_${dateStr(r.takenAt)}_${sanitize(r.shortcode)}.mp4`;
    queue.push({ path: name, url: video.url, post: r });
  });

  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "reels");
  entries.push({
    path: "index.json",
    bytes: textEncoder.encode(JSON.stringify({
      username: user.username,
      exported_at: nowStamp(),
      count: queue.length,
      reels: queue.map((q, i) => ({
        index: i + 1,
        file: q.path,
        shortcode: q.post.shortcode,
        taken_at: q.post.takenAt,
        date: dateStr(q.post.takenAt),
        url: `https://www.instagram.com/reel/${q.post.shortcode}/`,
        caption: q.post.caption,
      })),
    }, null, 2)),
  });

  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  const zipBytes = createZip(entries);
  finishBlob(job, zipBytes, `${sanitize(user.username)}_reels_${nowStamp()}.zip`, { reels: total, failed });
}

async function exportStories(job, user) {
  const { jobId } = job;
  progress(jobId, "enumerating", 0, null, "Loading stories…");
  const { items: rawItems } = await getReel(user.id);

  const queue = [];
  rawItems.forEach((raw, i) => {
    const ex = extractMedia(raw);
    const m = primaryMedia(ex);
    if (!m) return;
    queue.push({
      path: `${pad(i + 1, 3)}_${dateStr(ex.takenAt)}_${sanitize(ex.shortcode)}.${m.type}`,
      url: m.url,
      ex,
    });
  });

  if (queue.length === 0) {
    throw new IGError(`@${user.username} has no active stories right now.`, 0);
  }
  progress(jobId, "enumerating", queue.length, null, `Found ${queue.length} stories…`);

  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "stories");
  entries.push({
    path: "index.json",
    bytes: textEncoder.encode(JSON.stringify({
      username: user.username,
      exported_at: nowStamp(),
      type: "stories",
      count: queue.length,
      items: queue.map((q, i) => ({
        index: i + 1,
        file: q.path,
        taken_at: q.ex.takenAt,
        date: dateStr(q.ex.takenAt),
        kind: q.ex.kind,
      })),
    }, null, 2)),
  });

  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  finishBlob(job, createZip(entries), `${sanitize(user.username)}_stories_${nowStamp()}.zip`, { stories: total, failed });
}

// `user` is null when exporting just the highlight open in the tab — the
// highlight itself says who owns it, so no username is needed.
async function exportHighlights(job, user) {
  const { jobId } = job;
  progress(jobId, "enumerating", 0, null, "Loading highlights…");
  const wantId = job.options.highlightId
    ? String(job.options.highlightId).replace(/^highlight:/, "")
    : null;
  const selected = wantId ? [{ id: wantId, title: "" }] : await getHighlightsTray(user.id);
  if (selected.length === 0) throw new IGError(`@${user.username} has no highlights.`, 0);

  // Build the download queue, one folder per highlight.
  let owner = user?.username || "";
  const queue = [];
  for (let hi = 0; hi < selected.length; hi++) {
    const h = selected[hi];
    const reel = await getReel(`highlight:${h.id}`);
    const title = h.title || reel.title || "Highlight";
    owner = owner || reel.owner;
    const folder = `${pad(hi + 1, 2)}_${sanitize(title)}`;
    reel.items.forEach((raw, i) => {
      const ex = extractMedia(raw);
      const m = primaryMedia(ex);
      if (!m) return;
      queue.push({ path: `${folder}/${pad(i + 1, 3)}_${dateStr(ex.takenAt)}.${m.type}`, url: m.url, ex, title });
    });
    progress(jobId, "enumerating", queue.length, null, `Scanned ${hi + 1}/${selected.length} highlights…`);
    if (hi < selected.length - 1) await sleep(300); // be gentle between calls
  }

  if (queue.length === 0) throw new IGError("No downloadable media found in those highlights.", 0);

  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "items");
  entries.push({
    path: "index.json",
    bytes: textEncoder.encode(JSON.stringify({
      username: owner,
      exported_at: nowStamp(),
      type: "highlights",
      highlights: selected.length,
      count: queue.length,
      items: queue.map((q, i) => ({
        index: i + 1,
        file: q.path,
        highlight: q.title,
        taken_at: q.ex.takenAt,
        date: dateStr(q.ex.takenAt),
        kind: q.ex.kind,
      })),
    }, null, 2)),
  });

  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  finishBlob(job, createZip(entries), `${sanitize(owner || "instagram")}_highlights_${nowStamp()}.zip`, { highlights: selected.length, files: total, failed });
}

async function exportProfilePic(job, user) {
  if (!user.profile_pic_url_hd) throw new IGError("No profile picture available.", 0);
  const bytes = await fetchBytes(user.profile_pic_url_hd);
  finishBlob(job, bytes, withRealExt(`${sanitize(user.username)}_profile.jpg`, bytes), { profilePic: 1 });
}

async function exportSinglePost(job) {
  const { jobId } = job;
  const code = job.options.shortcode;
  if (!code) throw new IGError("No post selected.", 0);

  progress(jobId, "enumerating", 1, 1, "Loading post…");
  const raw = await getMediaInfo(shortcodeToMediaId(code));
  const post = extractMedia(raw);
  const files = planPostFiles(post);
  if (files.length === 0) throw new IGError("That post has no downloadable media.", 0);

  const base = `${sanitize(raw.user?.username || job.username || post.shortcode)}_${sanitize(post.shortcode || code)}`;
  const queue = files.map((f) => ({ path: f.name, url: f.url }));
  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "files");
  if (entries.length === 0) throw new IGError("Couldn't download that post's media.", 0);

  // A lone media file with no caption is saved as-is rather than zipped.
  if (queue.length === 1 && !post.caption) {
    finishBlob(job, entries[0].bytes, `${base}.${entries[0].path.split(".").pop()}`, { files: 1 });
    return;
  }

  if (post.caption) {
    entries.push({ path: "caption.txt", bytes: textEncoder.encode(post.caption) });
  }
  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  finishBlob(job, createZip(entries), `${base}.zip`, { files: total, failed });
}

/* ===== finalize ===== */

// Without a type Chrome sniffs the blob and may swap the extension (.zip → .txt).
const MIME = { zip: "application/zip", jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4" };

function finishBlob(job, bytes, filename, summary) {
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = null;
  }
  const type = MIME[filename.split(".").pop()] || "application/octet-stream";
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  lastBlobUrl = url;
  send({ type: "EXPORT_DOWNLOAD_URL", jobId: job.jobId, url, filename, summary });
}

/* ===== dispatch ===== */

async function runExport(job) {
  const { jobId, mode, username } = job;
  try {
    // A single post, or the one highlight open in the tab, carries its own
    // owner — no profile lookup needed.
    if (mode === "post") {
      await exportSinglePost(job);
      return;
    }
    if (mode === "highlights" && job.options.highlightId) {
      await exportHighlights(job, null);
      return;
    }

    progress(jobId, "resolving", null, null, `Resolving @${username}…`);
    const user = await resolveUser(username);

    if (mode === "profilePic") {
      await exportProfilePic(job, user);
      return;
    }

    // Everything else needs access to the user's content.
    if (!user.can_view) {
      throw new IGError(`@${user.username} is private and you don't follow them.`, 403);
    }

    if (mode === "posts") {
      await exportFolderedZip(job, user, { imagesOnly: false });
    } else if (mode === "images") {
      await exportFolderedZip(job, user, { imagesOnly: true });
    } else if (mode === "reels") {
      await exportReels(job, user);
    } else if (mode === "stories") {
      await exportStories(job, user);
    } else if (mode === "highlights") {
      await exportHighlights(job, user);
    } else {
      throw new IGError(`Unknown export mode: ${mode}`, 0);
    }
  } catch (err) {
    send({
      type: "EXPORT_ERROR",
      jobId,
      error: err?.message || "Export failed.",
      status: err?.status ?? null,
    });
  }
}
