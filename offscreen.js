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
  getActiveStory,
  getHighlightsTray,
  getReelMedia,
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

function sanitize(name) {
  return String(name).replace(/[^a-z0-9_\-.]+/gi, "_").replace(/^_+|_+$/g, "") || "untitled";
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
// file-level progress. Returns { entries, failed, total }.
async function fetchQueueToEntries(jobId, queue, label) {
  const total = queue.length;
  let done = 0;
  let failed = 0;
  progress(jobId, "downloading", 0, total, `Downloading ${total} ${label}…`);
  const fetched = await mapPool(queue, MEDIA_CONCURRENCY, async (q) => {
    try {
      const bytes = await fetchBytes(q.url);
      done++;
      progress(jobId, "downloading", done, total);
      return { path: q.path, bytes };
    } catch {
      failed++;
      done++;
      progress(jobId, "downloading", done, total);
      return null;
    }
  });
  return { entries: fetched.filter(Boolean), failed, total };
}

/* ===== enumeration ===== */

// Collect normalized posts from a user's feed, honoring the mode filter
// (e.g. reels-only) and the count/date filters. Returns newest-first.
async function collectItems(jobId, userId, modeFilter, filter) {
  const collected = [];
  const fromTs = filter?.fromDate ? Math.floor(Date.parse(filter.fromDate + "T00:00:00") / 1000) : null;
  const toTs = filter?.toDate ? Math.floor(Date.parse(filter.toDate + "T23:59:59") / 1000) : null;
  const recentLimit = filter?.type === "recent" ? Math.max(1, filter.n | 0) : null;

  let stop = false;
  await paginateFeed(userId, (rawItems) => {
    for (const raw of rawItems) {
      const ex = extractMedia(raw);

      if (filter?.type === "range") {
        // Feed is newest-first: once we drop below "from", nothing older
        // can qualify, so stop paging entirely.
        if (fromTs && ex.takenAt && ex.takenAt < fromTs) {
          stop = true;
          break;
        }
        if (toTs && ex.takenAt && ex.takenAt > toTs) continue;
      }

      if (!modeFilter(ex)) continue;

      collected.push(ex);
      progress(jobId, "enumerating", collected.length, null, `Found ${collected.length} items…`);

      if (recentLimit && collected.length >= recentLimit) {
        stop = true;
        break;
      }
    }
    return stop;
  });

  if (filter?.type === "oldest") {
    const n = Math.max(1, filter.n | 0);
    return collected.slice(-n);
  }
  return collected;
}

/* ===== packaging ===== */

// Build the per-post file list (names + urls) from a normalized item.
// `imagesOnly` drops videos and their poster thumbnails.
function planPostFiles(post, { imagesOnly = false, includeThumbs = true } = {}) {
  const files = [];
  let slot = 0;
  for (const m of post.media) {
    if (m.isThumb) {
      if (imagesOnly || !includeThumbs) continue;
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
  const items = await collectItems(jobId, user.id, () => true, job.options.filter);

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
    for (const f of p.files) queue.push({ path: `${folder}/${f.name}`, url: f.url });
  });

  const total = queue.length;
  let done = 0;
  let failed = 0;
  progress(jobId, "downloading", 0, total, `Downloading ${total} files…`);

  const fetched = await mapPool(queue, MEDIA_CONCURRENCY, async (q) => {
    try {
      const bytes = await fetchBytes(q.url);
      done++;
      progress(jobId, "downloading", done, total);
      return { path: q.path, bytes };
    } catch {
      failed++;
      done++;
      progress(jobId, "downloading", done, total);
      return null;
    }
  });

  const entries = fetched.filter(Boolean);

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
  finishZip(job, zipBytes, `${sanitize(user.username)}_${suffix}_${nowStamp()}.zip`, { posts: posts.length, files: total, failed });
}

async function exportReels(job, user) {
  const { jobId } = job;
  const reels = await collectItems(jobId, user.id, (ex) => ex.kind === "reel", job.options.filter);
  if (reels.length === 0) throw new IGError("No reels found for this selection.", 0);

  const queue = [];
  reels.forEach((r, i) => {
    const idx = i + 1;
    const video = r.media.find((m) => m.isVideo);
    if (!video) return;
    const name = `${pad(idx, 3)}_${dateStr(r.takenAt)}_${sanitize(r.shortcode)}.mp4`;
    queue.push({ path: name, url: video.url, post: r });
  });

  const total = queue.length;
  let done = 0;
  let failed = 0;
  progress(jobId, "downloading", 0, total, `Downloading ${total} reels…`);

  const fetched = await mapPool(queue, MEDIA_CONCURRENCY, async (q) => {
    try {
      const bytes = await fetchBytes(q.url);
      done++;
      progress(jobId, "downloading", done, total);
      return { path: q.path, bytes };
    } catch {
      failed++;
      done++;
      progress(jobId, "downloading", done, total);
      return null;
    }
  });

  const entries = fetched.filter(Boolean);
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
  finishZip(job, zipBytes, `${sanitize(user.username)}_reels_${nowStamp()}.zip`, { reels: total, failed });
}

async function exportStories(job, user) {
  const { jobId } = job;
  progress(jobId, "enumerating", 0, null, "Loading stories…");
  const rawItems = await getActiveStory(user.id);

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
  finishZip(job, createZip(entries), `${sanitize(user.username)}_stories_${nowStamp()}.zip`, { stories: total, failed });
}

async function exportHighlights(job, user) {
  const { jobId } = job;
  progress(jobId, "enumerating", 0, null, "Loading highlights…");
  const tray = await getHighlightsTray(user.id);
  if (tray.length === 0) throw new IGError(`@${user.username} has no highlights.`, 0);

  // Scope to a single highlight if one was opened in the tab.
  let selected = tray;
  const wantId = job.options.highlightId
    ? String(job.options.highlightId).replace(/^highlight:/, "")
    : null;
  if (wantId) {
    const match = tray.find((t) => t.id === wantId);
    selected = match ? [match] : [{ id: wantId, title: "Highlight" }];
  }

  // Build the download queue, one folder per highlight.
  const queue = [];
  for (let hi = 0; hi < selected.length; hi++) {
    const h = selected[hi];
    const map = await getReelMedia([`highlight:${h.id}`]);
    const items = map[`highlight:${h.id}`] || map[h.id] || [];
    const folder = `${pad(hi + 1, 2)}_${sanitize(h.title)}`;
    items.forEach((raw, i) => {
      const ex = extractMedia(raw);
      const m = primaryMedia(ex);
      if (!m) return;
      queue.push({ path: `${folder}/${pad(i + 1, 3)}_${dateStr(ex.takenAt)}.${m.type}`, url: m.url, ex, title: h.title });
    });
    progress(jobId, "enumerating", queue.length, null, `Scanned ${hi + 1}/${selected.length} highlights…`);
    if (hi < selected.length - 1) await sleep(300); // be gentle between calls
  }

  if (queue.length === 0) throw new IGError("No downloadable media found in those highlights.", 0);

  const { entries, failed, total } = await fetchQueueToEntries(jobId, queue, "items");
  entries.push({
    path: "index.json",
    bytes: textEncoder.encode(JSON.stringify({
      username: user.username,
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
  finishZip(job, createZip(entries), `${sanitize(user.username)}_highlights_${nowStamp()}.zip`, { highlights: selected.length, files: total, failed });
}

async function exportProfilePic(job, user) {
  const url = user.profile_pic_url_hd || user.profile_pic_url;
  if (!url) throw new IGError("No profile picture available.", 0);
  // The CDN URL downloads fine directly; no need to fetch+zip a single image.
  send({
    type: "EXPORT_DOWNLOAD_URL",
    jobId: job.jobId,
    url,
    filename: `${sanitize(user.username)}_profile.jpg`,
    summary: { profilePic: 1 },
  });
}

async function exportSinglePost(job, user) {
  const { jobId } = job;
  const code = job.options.shortcode;
  if (!code) throw new IGError("No post selected.", 0);

  progress(jobId, "enumerating", 1, 1, "Loading post…");
  const mediaId = shortcodeToMediaId(code);
  const raw = await getMediaInfo(mediaId);
  const post = extractMedia(raw);
  const files = planPostFiles(post, { imagesOnly: false });
  if (files.length === 0) throw new IGError("That post has no downloadable media.", 0);

  const base = `${sanitize(user.username || post.shortcode)}_${sanitize(code)}`;

  // Single media file → download it directly with the right extension.
  if (files.length === 1 && !post.caption) {
    send({
      type: "EXPORT_DOWNLOAD_URL",
      jobId,
      url: files[0].url,
      filename: `${base}.${files[0].name.split(".").pop()}`,
      summary: { files: 1 },
    });
    return;
  }

  const total = files.length;
  let done = 0;
  let failed = 0;
  progress(jobId, "downloading", 0, total, `Downloading ${total} files…`);
  const fetched = await mapPool(files, MEDIA_CONCURRENCY, async (f) => {
    try {
      const bytes = await fetchBytes(f.url);
      done++;
      progress(jobId, "downloading", done, total);
      return { path: f.name, bytes };
    } catch {
      failed++;
      done++;
      progress(jobId, "downloading", done, total);
      return null;
    }
  });

  const entries = fetched.filter(Boolean);
  if (post.caption) {
    entries.push({ path: "caption.txt", bytes: textEncoder.encode(post.caption) });
  }
  progress(jobId, "zipping", null, null, "Packaging ZIP…");
  const zipBytes = createZip(entries);
  finishZip(job, zipBytes, `${base}.zip`, { files: total, failed });
}

/* ===== finalize ===== */

function finishZip(job, zipBytes, filename, summary) {
  if (lastBlobUrl) {
    URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = null;
  }
  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  lastBlobUrl = url;
  send({ type: "EXPORT_DOWNLOAD_URL", jobId: job.jobId, url, filename, summary, revocable: true });
}

/* ===== dispatch ===== */

async function runExport(job) {
  const { jobId, mode, username } = job;
  try {
    progress(jobId, "resolving", null, null, `Resolving @${username}…`);
    const user = await resolveUser(username);

    if (mode === "profilePic") {
      await exportProfilePic(job, user);
      return;
    }

    if (mode === "post") {
      await exportSinglePost(job, user);
      return;
    }

    // Feed-based modes need access to the user's posts.
    if (user.is_private && !user.followed_by_viewer) {
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
