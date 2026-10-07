// src/normalizer.js
//
// Transforms the SlideMessage nodes returned by Instagram's DM GraphQL query
// (IGDMessageListOffMsysQuery, see bridge.js) into the Meta "Download Your
// Information" (DYI) messages JSON shape.
//
// bridge.js fetches the open thread and hands the raw nodes (newest first)
// plus the thread metadata here. Each node's content.__typename says what kind
// of message it is; this file maps the ones that hold real content to DYI
// messages and drops the system rows (SlideMessageAdminText) other than calls,
// which become one message per call with a derived call_duration.

const UNKNOWN_PARTICIPANT = 'Instagram User';

/* ===== name resolution ===== */

// Messaging fbid (string) -> display name. Every message carries its sender's
// name, which is what covers the viewer: the thread metadata doesn't name them.
function buildNameMap(info, nodes) {
  const map = new Map();
  for (const u of info.users || []) {
    const name = u.full_name || u.username;
    if (u.fbid && name) map.set(String(u.fbid), name);
  }
  for (const n of nodes) {
    const u = n.sender?.user_dict;
    const name = u?.full_name || n.sender?.name || u?.username;
    if (n.sender_fbid && name) map.set(String(n.sender_fbid), name);
  }
  return map;
}

/* ===== media helpers ===== */

function cdnUrl(attachment) {
  return attachment?.attachment_cdn_url || attachment?.preview_cdn_url || null;
}

function addMedia(msg, key, uris, timestamp_ms) {
  const creation_timestamp = Math.floor(timestamp_ms / 1000);
  const list = uris.filter(Boolean).map((uri) => ({ uri, creation_timestamp }));
  if (list.length) msg[key] = (msg[key] || []).concat(list);
}

/* ===== calls ===== */

// Call rows are admin text with a content_type like IG_VIDEO_CALL_XMAT (audio
// calls use it too).
function isCallNotice(node) {
  return /CALL/.test(node.content_type || '');
}

function adminText(node) {
  return (node.content?.text_fragments || []).map((f) => f.plaintext || '').join('');
}

// A call arrives as two notices: "X started an audio call", then "Audio call
// ended" or "You missed an audio call". DYI has one message per call with a
// call_duration, so the second notice is folded into the first. Instagram's
// web API exposes no duration: it is taken as the gap between the two notices,
// which includes the time the call rang before it was answered (so it reads up
// to about a minute over the talk time). Missed calls get 0.
// ponytail: matches the English notices only; in another UI language a call
// stays as two plain text rows. Add that language's words to the regexes below.
//
// Returns message_id -> seconds for a call's first notice, null for a folded
// second one. Notices that don't pair up are absent and export as plain text.
function pairCalls(nodes) {
  const rows = nodes.filter(isCallNotice).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const calls = new Map();
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    if (!next || !/started/i.test(adminText(row))) return;
    const end = adminText(next);
    const missed = /missed/i.test(end);
    if (!missed && !/ended/i.test(end)) return;
    calls.set(row.message_id, missed ? 0 : Math.round((next.timestamp_ms - row.timestamp_ms) / 1000));
    calls.set(next.message_id, null);
  });
  return calls;
}

/* ===== per-item conversion ===== */

// Returns a DYI message object, or null to drop the node. `calls` is the
// pairCalls() result for the thread.
export function normalizeItem(node, names, calls = new Map()) {
  const timestamp_ms = Number(node.timestamp_ms);
  if (!Number.isFinite(timestamp_ms) || timestamp_ms <= 0) return null;

  const c = node.content || {};
  const type = (c.__typename || '').replace('SlideMessage', '');

  // Plain text, or the caption typed alongside a share.
  let text = node.text_body || c.text_body || c.xma_text_body;

  // System rows: only call notices are kept (minus the ones folded into their
  // call). Reaction logs, "X named the group" and the like go.
  if (type === 'AdminText') {
    if (!isCallNotice(node) || calls.get(node.message_id) === null) return null;
    text = adminText(node);
  }

  const msg = {
    sender_name: names.get(String(node.sender_fbid)) || UNKNOWN_PARTICIPANT,
    timestamp_ms,
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false,
  };
  if (text && text.trim()) msg.content = text;
  if (calls.has(node.message_id)) msg.call_duration = calls.get(node.message_id);

  switch (type) {
    case 'ImageContent':
      addMedia(msg, 'photos', (c.attachments || []).map(cdnUrl), timestamp_ms);
      break;

    case 'VideosContent':
      addMedia(msg, 'videos', (c.videos || []).map(cdnUrl), timestamp_ms);
      break;

    // View-once (disappearing) photo/video. The attachment still carries its
    // URL while unviewed; treat it like a normal media message.
    case 'RavenImageContent':
      addMedia(msg, 'photos', [cdnUrl(c.attachment)], timestamp_ms);
      break;
    case 'RavenVideoContent':
      addMedia(msg, 'videos', [cdnUrl(c.attachment)], timestamp_ms);
      break;

    // Mixed photo/video album.
    // ponytail: videos are told apart by file extension because the
    // attachment_type enum is undocumented; map the enum if a video ever
    // lands in `photos`.
    case 'MultiMediaContent':
      for (const a of c.ordered_photo_video_attachments || []) {
        const uri = cdnUrl(a);
        addMedia(msg, /\.mp4(\?|$)/.test(uri || '') ? 'videos' : 'photos', [uri], timestamp_ms);
      }
      break;

    case 'AudiosContent':
      addMedia(msg, 'audio_files', (c.audio_attachments || []).map(cdnUrl), timestamp_ms);
      break;

    // Animated GIF / GIF sticker.
    case 'AnimatedMediaContent':
      addMedia(
        msg,
        'photos',
        [c.animated_media?.attachment_webp_url || c.animated_media?.preview_cdn_url],
        timestamp_ms
      );
      break;

    // Shared reel, post, story, profile or link — all arrive as an "XMA" card.
    case 'XMAContent': {
      const x = c.xma || {};
      // "Message unavailable" / expired-story placeholders carry no content.
      if (/Placeholder/.test(x.__typename || '')) break;
      msg.share = {
        link: x.target_url || '',
        share_text: x.title_text || x.caption_body_text || '',
        original_content_owner: x.header_title_text || '',
      };
      break;
    }

    case 'MusicStickerXMAContent': {
      const track = c.audio_track || {};
      msg.share = {
        link: c.attribution_link || '',
        share_text: [track.title, track.display_artist].filter(Boolean).join(' — '),
        original_content_owner: '',
      };
      break;
    }

    default:
      // Stickers (store / cutout / AI / avatar) carry a single preview image.
      // Unknown/newer types fall through with whatever text was salvaged above,
      // so a real message is never silently dropped.
      addMedia(msg, 'photos', [c.preview_url], timestamp_ms);
      break;
  }

  // Each reaction carries its own emoji and the reactor's messaging fbid.
  const reactions = (node.reactions || []).map((r) => ({
    reaction: r.reaction || '',
    actor: names.get(String(r.sender_fbid)) || UNKNOWN_PARTICIPANT,
  }));
  if (reactions.length) msg.reactions = reactions;

  const hasPayload = !!(
    msg.content ||
    msg.photos ||
    msg.videos ||
    msg.audio_files ||
    msg.share ||
    msg.reactions
  );
  if (!hasPayload) return null;
  return msg;
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

// `items` may be an array of raw SlideMessage nodes or a map of them.
export function normalize(threadInfo, items) {
  const info = threadInfo || {};
  const list = Array.isArray(items) ? items : Object.values(items || {});
  const names = buildNameMap(info, list);
  const viewer = info.viewer_fbid != null ? String(info.viewer_fbid) : null;
  const vName = names.get(viewer) || 'Viewer';

  const others = (info.users || [])
    .filter((u) => String(u.fbid) !== viewer)
    .map((u) => u.full_name || u.username)
    .filter(Boolean);
  const participants = [
    ...(others.length ? others : [UNKNOWN_PARTICIPANT]).map((name) => ({ name })),
    { name: vName },
  ];

  const title = info.thread_title || others[0] || UNKNOWN_PARTICIPANT;
  const thread_path = `inbox/${slugify(title)}_${info.thread_id || 'unknown'}`;

  const calls = pairCalls(list);
  const messages = list
    .map((node) => normalizeItem(node, names, calls))
    .filter(Boolean)
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
