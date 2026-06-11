// src/igapi.js
//
// Thin client over Instagram's own web API endpoints. Everything here runs in
// an extension context (the offscreen document), which — combined with the
// host permissions in manifest.json — lets fetch() reach instagram.com with
// the user's logged-in session cookie attached and without CORS blocking the
// response body.
//
// These endpoints are NOT public/documented and Instagram changes them
// periodically. When the exporter breaks, this is almost always the file to
// fix. App id 936619743392459 is the well-known Instagram Web app id.

const APP_ID = "936619743392459";
const ORIGIN = "https://www.instagram.com";

class IGError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "IGError";
    this.status = status;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET an instagram.com JSON endpoint with the headers IG's web client sends.
// Retries on transient throttling (429) and 5xx with exponential backoff.
async function fetchJson(path, { tries = 4 } = {}) {
  const url = path.startsWith("http") ? path : ORIGIN + path;
  let lastErr = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "x-ig-app-id": APP_ID,
          "x-requested-with": "XMLHttpRequest",
          Accept: "application/json",
        },
      });
    } catch (err) {
      lastErr = new IGError("Network request failed: " + err.message, 0);
      await delay(800 * (attempt + 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new IGError(
        res.status === 429
          ? "Instagram is rate-limiting requests (429). Slow down and retry."
          : `Instagram server error (${res.status}).`,
        res.status
      );
      // Backoff: 1.5s, 3s, 6s, ...
      await delay(1500 * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new IGError(
        "Not authorized. Make sure you're logged in to Instagram in this browser.",
        res.status
      );
    }
    if (res.status === 404) {
      throw new IGError("Not found (404).", 404);
    }
    if (!res.ok) {
      throw new IGError(`Unexpected response (${res.status}).`, res.status);
    }

    try {
      return await res.json();
    } catch {
      throw new IGError("Instagram returned a non-JSON response.", res.status);
    }
  }

  throw lastErr || new IGError("Request failed.", 0);
}

/**
 * Resolve a username to its profile metadata.
 * @returns {{id, username, full_name, is_private, follows_viewer, followed_by_viewer, profile_pic_url, profile_pic_url_hd, media_count}}
 */
export async function resolveUser(username) {
  const clean = String(username).trim().replace(/^@/, "").toLowerCase();
  if (!clean) throw new IGError("Enter a username.", 0);

  const data = await fetchJson(
    `/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`
  );
  const user = data?.data?.user;
  if (!user) throw new IGError(`No such user: @${clean}`, 404);

  return {
    id: user.id,
    username: user.username || clean,
    full_name: user.full_name || "",
    is_private: !!user.is_private,
    followed_by_viewer: !!user.followed_by_viewer,
    profile_pic_url: user.profile_pic_url || "",
    profile_pic_url_hd: user.profile_pic_url_hd || user.profile_pic_url || "",
    media_count: user.edge_owner_to_timeline_media?.count ?? null,
  };
}

/**
 * Walk a user's timeline feed page by page (newest first).
 * onItems(rawItems) may return true to stop pagination early.
 */
export async function paginateFeed(userId, onItems, { pageDelayMs = 600 } = {}) {
  let maxId = null;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ count: "33" });
    if (maxId) qs.set("max_id", maxId);

    const data = await fetchJson(`/api/v1/feed/user/${userId}/?${qs.toString()}`);
    const items = Array.isArray(data.items) ? data.items : [];

    const stop = await onItems(items);
    if (stop) break;

    maxId = data.next_max_id || null;
    const more = data.more_available && maxId;
    if (!more) break;

    pages++;
    await delay(pageDelayMs);
  } while (true);
}

function pickImageUrl(node) {
  const cands = node?.image_versions2?.candidates;
  return Array.isArray(cands) && cands.length ? cands[0].url : null;
}

function pickVideoUrl(node) {
  const vers = node?.video_versions;
  return Array.isArray(vers) && vers.length ? vers[0].url : null;
}

// Turn one raw feed/media node into its constituent media files.
function mediaFromNode(node) {
  const out = [];
  if (node.media_type === 2) {
    const url = pickVideoUrl(node);
    if (url) out.push({ url, type: "mp4", isVideo: true });
    // The poster frame is useful context for reels/videos.
    const thumb = pickImageUrl(node);
    if (thumb) out.push({ url: thumb, type: "jpg", isVideo: false, isThumb: true });
  } else {
    const url = pickImageUrl(node);
    if (url) out.push({ url, type: "jpg", isVideo: false });
  }
  return out;
}

/**
 * Normalize a raw feed/media item into a flat, export-friendly shape.
 * @returns {{shortcode, takenAt, productType, kind, caption, media: Array}}
 */
export function extractMedia(item) {
  const productType = item.product_type || "feed";
  let kind;
  if (productType === "clips") kind = "reel";
  else if (item.media_type === 8) kind = "carousel";
  else if (item.media_type === 2) kind = "video";
  else kind = "image";

  let media = [];
  if (item.media_type === 8 && Array.isArray(item.carousel_media)) {
    for (const child of item.carousel_media) {
      media = media.concat(mediaFromNode(child));
    }
  } else {
    media = mediaFromNode(item);
  }

  return {
    shortcode: item.code || item.id || "",
    takenAt: typeof item.taken_at === "number" ? item.taken_at : 0,
    productType,
    kind,
    caption: item.caption?.text || "",
    media,
  };
}

// Instagram shortcodes are base64 (URL-safe alphabet) of the media's numeric
// primary key. Decode it so we can hit the media-info endpoint for a single
// post given only its /p/<code>/ URL.
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of String(shortcode)) {
    const idx = SHORTCODE_ALPHABET.indexOf(ch);
    if (idx === -1) throw new IGError(`Invalid post code: ${shortcode}`, 0);
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

/** Fetch a single media item by its numeric id. Returns the raw item node. */
export async function getMediaInfo(mediaId) {
  const data = await fetchJson(`/api/v1/media/${mediaId}/info/`);
  const item = Array.isArray(data.items) ? data.items[0] : null;
  if (!item) throw new IGError("Could not load that post.", 404);
  return item;
}

/**
 * Currently-active (24h) story items for a user. Each item is a raw media node
 * with the same media_type / image_versions2 / video_versions shape as a feed
 * post. Returns [] when there's nothing live.
 */
export async function getActiveStory(userId) {
  const data = await fetchJson(`/api/v1/feed/user/${userId}/story/`);
  const items = data?.reel?.items || data?.story?.items;
  return Array.isArray(items) ? items : [];
}

/** Highlights tray for a user → [{ id (numeric string), title }]. */
export async function getHighlightsTray(userId) {
  const data = await fetchJson(`/api/v1/highlights/${userId}/highlights_tray/`);
  const tray = Array.isArray(data?.tray) ? data.tray : [];
  return tray.map((t) => ({
    id: String(t.id || "").replace(/^highlight:/, ""),
    title: t.title || "Highlight",
  }));
}

/**
 * Fetch media items for one or more "reels" (story rings or highlights).
 * `reelIds` entries look like "highlight:1790…" or a numeric user id.
 * Returns a map: reelId → raw items[].
 */
export async function getReelMedia(reelIds) {
  const qs = reelIds.map((id) => `reel_ids=${encodeURIComponent(id)}`).join("&");
  const data = await fetchJson(`/api/v1/feed/reels_media/?${qs}`);
  const out = {};

  // Newer shape: { reels: { "<id>": { items: [...] } } }
  const reels = data?.reels || {};
  for (const [key, val] of Object.entries(reels)) {
    out[key] = Array.isArray(val?.items) ? val.items : [];
  }
  // Older shape: { reels_media: [ { id, items: [...] } ] }
  if (Array.isArray(data?.reels_media)) {
    for (const r of data.reels_media) {
      const key = r.id != null ? String(r.id) : null;
      if (key && !out[key]) out[key] = Array.isArray(r.items) ? r.items : [];
    }
  }
  return out;
}

export { IGError };
