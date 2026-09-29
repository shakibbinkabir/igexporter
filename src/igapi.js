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

// Persisted GraphQL queries used by instagram.com's own profile page (the old
// REST profile/feed endpoints now answer 429 or an HTML page). Instagram
// rotates these ids every so often; when profile export starts failing with a
// GraphQL "execution error", open a profile on instagram.com, watch the
// /graphql/query requests in DevTools, and copy the new doc_id + variables.
const DOC_TIMELINE = "28570182382647478"; // a user's posts grid, by username
const DOC_USER = "28036671149327607"; // profile header info, by user id
const DOC_HIGHLIGHTS = "26970053832668570"; // highlights tray, by user id
const TIMELINE_FLAGS = {
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
};
const USER_FLAGS = {
  __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
  __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
  __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
  __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
};

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
        // A stalled request would otherwise leave the popup spinning forever.
        signal: AbortSignal.timeout(20000),
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

// Run a persisted GraphQL query. GET needs no CSRF token, so this works from
// the offscreen document with nothing but the session cookie.
async function graphql(docId, variables) {
  const qs = new URLSearchParams({ doc_id: docId, variables: JSON.stringify(variables) });
  const res = await fetchJson(`/graphql/query/?${qs}`);
  if (!res?.data) {
    const e = res?.errors?.[0];
    throw new IGError(`Instagram GraphQL error: ${e?.description || e?.message || "no data"}.`, 0);
  }
  return res.data;
}

/**
 * Resolve a username to its profile metadata.
 * @returns {{id, username, full_name, is_private, can_view, profile_pic_url_hd}}
 */
export async function resolveUser(username) {
  const clean = String(username).trim().replace(/^@/, "").toLowerCase();
  if (!clean) throw new IGError("Enter a username.", 0);

  const search = await fetchJson(
    `/api/v1/web/search/topsearch/?${new URLSearchParams({ query: clean, context: "blended" })}`
  );
  const hit = (search.users || []).map((u) => u.user).find((u) => u?.username?.toLowerCase() === clean);
  if (!hit) throw new IGError(`No such user: @${clean}`, 404);

  const { user = {} } = await graphql(DOC_USER, { id: String(hit.pk), enable_integrity_filters: true, ...USER_FLAGS });
  const isPrivate = !!(user.is_private ?? hit.is_private);
  return {
    id: String(hit.pk),
    username: user.username || hit.username,
    full_name: user.full_name || hit.full_name || "",
    is_private: isPrivate,
    // friendship_status is null on your own profile, which you can always see.
    can_view: !isPrivate || !user.friendship_status || !!user.friendship_status.following,
    profile_pic_url_hd: user.hd_profile_pic_url_info?.url || user.profile_pic_url || hit.profile_pic_url || "",
  };
}

/**
 * Walk a user's posts grid page by page (pinned posts first, then newest
 * first). onItems(rawItems) may return true to stop pagination early.
 */
export async function paginateFeed(username, onItems, { pageDelayMs = 600 } = {}) {
  let after = null;
  do {
    const data = await graphql(DOC_TIMELINE, {
      data: { count: 33 }, // the server caps pages at 33
      username,
      ...(after ? { after } : {}),
      ...TIMELINE_FLAGS,
    });
    const conn = data.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!conn) throw new IGError("Instagram returned no posts grid.", 0);

    const stop = await onItems((conn.edges || []).map((e) => e.node));
    if (stop) break;

    after = conn.page_info?.has_next_page ? conn.page_info.end_cursor : null;
    if (!after) break;
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
    // Pinned posts lead the grid out of date order.
    pinned: !!item.timeline_pinned_user_ids?.length,
    media,
  };
}

// Instagram shortcodes are base64 (URL-safe alphabet) of the media's numeric
// primary key. Decode it so we can hit the media-info endpoint for a single
// post given only its /p/<code>/ URL.
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortcodeToMediaId(shortcode) {
  let code = String(shortcode);
  // Posts from private accounts get a 28-char suffix appended to the real code.
  if (code.length > 28) code = code.slice(0, -28);
  let id = 0n;
  for (const ch of code) {
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
 * Fetch one "reel" — a user's active story ring (numeric user id) or a
 * highlight ("highlight:1790…"). Each item has the same media_type /
 * image_versions2 / video_versions shape as a feed post.
 * @returns {{items: Array, title: string, owner: string}}
 */
export async function getReel(reelId) {
  const data = await fetchJson(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
  const reel = data?.reels?.[reelId] || {};
  return {
    items: Array.isArray(reel.items) ? reel.items : [],
    title: reel.title || "",
    owner: reel.user?.username || "",
  };
}

/** Highlights tray for a user → [{ id (numeric string), title }]. */
export async function getHighlightsTray(userId) {
  const data = await graphql(DOC_HIGHLIGHTS, { user_id: String(userId) });
  return (data.highlights?.edges || []).map(({ node }) => ({
    id: String(node.id || "").replace(/^highlight:/, ""),
    title: node.title || "Highlight",
  }));
}

export { IGError };
