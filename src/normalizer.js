// src/normalizer.js
//
// Transforms Instagram's private direct_v2 REST message items into the Meta
// "Download Your Information" (DYI) messages JSON shape.
//
// Instagram moved DM traffic off the page's main thread (into a worker /
// service worker), so the old passive GraphQL interception could no longer see
// any responses. bridge.js now actively fetches the thread through
// /api/v1/direct_v2/threads/<id>/ and hands the raw `items` (newest first) plus
// the thread metadata here. Each item carries an `item_type` discriminator;
// this file maps the ones that hold real content to DYI messages and drops the
// system rows (action logs, unsupported-message placeholders).

const UNKNOWN_PARTICIPANT = 'Instagram User';
const IG = 'https://www.instagram.com';

/* ===== name resolution ===== */

// pk (string) -> display name, covering the viewer and every other participant.
function buildUserMap(info) {
  const map = new Map();
  for (const u of info.users || []) {
    const name = u.full_name || u.username;
    if (u.pk != null && name) map.set(String(u.pk), name);
  }
  const vid = info.viewer_id != null ? String(info.viewer_id) : null;
  if (vid && info.viewer_name) map.set(vid, info.viewer_name);
  return map;
}

function viewerName(info) {
  return info.viewer_name || 'Viewer';
}

function otherName(info) {
  const vName = viewerName(info);
  for (const u of info.users || []) {
    const name = u.full_name || u.username;
    if (name && name !== vName) return name;
  }
  const u0 = (info.users || [])[0];
  return (u0 && (u0.full_name || u0.username)) || UNKNOWN_PARTICIPANT;
}

/* ===== media url helpers ===== */

function imageUrl(node) {
  return node?.image_versions2?.candidates?.[0]?.url || null;
}
function videoUrl(node) {
  return node?.video_versions?.[0]?.url || null;
}
function photoOrVideo(msg, node, timestamp_ms) {
  const creation_timestamp = Math.floor(timestamp_ms / 1000);
  if (node?.media_type === 2 && videoUrl(node)) {
    msg.videos = [{ uri: videoUrl(node), creation_timestamp }];
  } else if (imageUrl(node)) {
    msg.photos = [{ uri: imageUrl(node), creation_timestamp }];
  }
}

/* ===== reactions ===== */

// direct_v2 reactions: { likes: [{sender_id}], emojis: [{sender_id, emoji}] }.
// A "like" is the double-tap heart; emojis carry the actual emoji.
function mapReactions(item, userMap) {
  const r = item.reactions;
  if (!r) return null;
  const out = [];
  for (const like of r.likes || []) {
    const pk = String(like.sender_id || like.user_id || '');
    out.push({ reaction: '❤', actor: userMap.get(pk) || UNKNOWN_PARTICIPANT });
  }
  for (const e of r.emojis || []) {
    const pk = String(e.sender_id || e.user_id || '');
    out.push({ reaction: e.emoji || '', actor: userMap.get(pk) || UNKNOWN_PARTICIPANT });
  }
  return out.length ? out : null;
}

/* ===== per-item conversion ===== */

// direct_v2 timestamps are microseconds since epoch.
function tsMs(item) {
  const raw = Number(item.timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw / 1000);
}

function senderNameFor(item, info, userMap) {
  const fromViewer =
    item.is_sent_by_viewer === true ||
    (item.user_id != null && String(item.user_id) === String(info.viewer_id));
  return (
    userMap.get(String(item.user_id)) ||
    (fromViewer ? viewerName(info) : otherName(info)) ||
    UNKNOWN_PARTICIPANT
  );
}

// Returns a DYI message object, or null to drop the item. Call events
// (video_call_event) are handled separately in normalize() so paired
// started/ended rows collapse into one call_duration message.
export function normalizeItem(item, info, userMap) {
  const timestamp_ms = tsMs(item);
  if (timestamp_ms == null) return null;

  const type = item.item_type;
  if (type === 'action_log' || type === 'placeholder' || type === 'video_call_event') {
    return null;
  }

  const msg = {
    sender_name: senderNameFor(item, info, userMap),
    timestamp_ms,
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false,
  };

  switch (type) {
    case 'text':
      if (item.text && item.text.trim()) msg.content = item.text;
      break;

    case 'link': {
      const text = item.link?.text || item.text;
      if (text && text.trim()) msg.content = text;
      break;
    }

    case 'media':
      photoOrVideo(msg, item.media, timestamp_ms);
      break;

    // View-once (disappearing) photo/video. The media node still carries
    // image/video URLs while unviewed; treat it like a normal media message.
    case 'raven_media':
      photoOrVideo(msg, item.raven_media || item.visual_media?.media || item.visual_media, timestamp_ms);
      break;

    case 'voice_media': {
      const uri =
        item.voice_media?.media?.audio?.audio_src ||
        item.voice_media?.audio?.audio_src ||
        null;
      msg.audio_files = [{ uri: uri || 'audio.mp4', creation_timestamp: Math.floor(timestamp_ms / 1000) }];
      break;
    }

    // Animated GIF / sticker.
    case 'animated_media': {
      const url =
        item.animated_media?.images?.fixed_height?.url ||
        item.animated_media?.url ||
        null;
      if (url) msg.photos = [{ uri: url, creation_timestamp: Math.floor(timestamp_ms / 1000) }];
      break;
    }

    // Shared reel.
    case 'clip': {
      const clip = item.clip?.clip || item.clip;
      const code = clip?.code;
      msg.share = {
        link: code ? `${IG}/reel/${code}/` : '',
        share_text: clip?.caption?.text || '',
        original_content_owner: clip?.user?.username || '',
      };
      break;
    }

    // Shared feed post.
    case 'media_share': {
      const node = item.direct_media_share?.media || item.media_share;
      const code = node?.code;
      msg.share = {
        link: code ? `${IG}/p/${code}/` : '',
        share_text: item.direct_media_share?.text || '',
        original_content_owner: node?.user?.username || '',
      };
      break;
    }

    // Shared story.
    case 'story_share': {
      const node = item.story_share?.media;
      const code = node?.code;
      msg.share = {
        link: code ? `${IG}/p/${code}/` : item.story_share?.link || '',
        share_text: item.story_share?.text || item.story_share?.title || '',
        original_content_owner: item.story_share?.user?.username || node?.user?.username || '',
      };
      break;
    }

    // Reply/reaction to a story or reel: usually a text reply, sometimes a
    // reshare. Prefer the reply text; fall back to a link to the media.
    case 'reel_share': {
      const rs = item.reel_share;
      if (rs?.text && rs.text.trim()) {
        msg.content = rs.text;
      } else if (rs?.media?.code) {
        msg.share = { link: `${IG}/reel/${rs.media.code}/`, share_text: '', original_content_owner: '' };
      }
      break;
    }

    default:
      // Unknown/newer type: salvage any plain text so a real message is never
      // silently dropped.
      if (item.text && item.text.trim()) msg.content = item.text;
      break;
  }

  const reactions = mapReactions(item, userMap);
  if (reactions) msg.reactions = reactions;

  const hasPayload = !!(
    msg.content ||
    msg.photos ||
    msg.videos ||
    msg.audio_files ||
    msg.share ||
    (msg.reactions && msg.reactions.length)
  );
  if (!hasPayload) return null;
  return msg;
}

// IG sends a video_call_started AND a video_call_ended row per call. DYI emits
// one call_duration message per call, so collapse them by vc_id, keeping the
// largest duration seen (the "ended" row) at the earliest timestamp (the
// "started" row).
function callMessages(items, info, userMap) {
  const byVc = new Map();
  for (const item of items) {
    if (item.item_type !== 'video_call_event') continue;
    const ts = tsMs(item);
    if (ts == null) continue;
    const vce = item.video_call_event || {};
    const key = vce.vc_id || item.item_id;
    const duration = typeof vce.call_duration === 'number' ? vce.call_duration : 0;
    const prev = byVc.get(key);
    if (!prev) {
      byVc.set(key, {
        sender_name: senderNameFor(item, info, userMap),
        timestamp_ms: ts,
        call_duration: duration,
      });
    } else {
      prev.call_duration = Math.max(prev.call_duration, duration);
      prev.timestamp_ms = Math.min(prev.timestamp_ms, ts);
    }
  }
  return [...byVc.values()].map((c) => ({
    sender_name: c.sender_name,
    timestamp_ms: c.timestamp_ms,
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false,
    call_duration: c.call_duration,
  }));
}

/* ===== thread-level ===== */

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'thread'
  );
}

// `items` may be an array of raw direct_v2 items or a map of them.
export function normalize(threadInfo, items) {
  const info = threadInfo || {};
  const userMap = buildUserMap(info);
  const vName = viewerName(info);

  const others = (info.users || []).map((u) => u.full_name || u.username).filter(Boolean);
  const participants = [
    ...(others.length ? others : [UNKNOWN_PARTICIPANT]).map((name) => ({ name })),
    { name: vName },
  ];

  const title = info.thread_title || others[0] || UNKNOWN_PARTICIPANT;
  const thread_path = `inbox/${slugify(title)}_${info.thread_id || 'unknown'}`;

  const list = Array.isArray(items) ? items : Object.values(items || {});
  const messages = list
    .map((item) => normalizeItem(item, info, userMap))
    .filter(Boolean)
    .concat(callMessages(list, info, userMap))
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);

  return {
    participants,
    title,
    is_still_participant: true,
    thread_path,
    magic_words: [],
    messages,
  };
}
