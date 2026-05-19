function getViewerName(rawThread) {
  return rawThread.viewer?.full_name || rawThread.viewer?.username || 'Viewer';
}

function getOtherParticipantName(rawThread, viewerName) {
  const users = rawThread.users || [];
  for (const user of users) {
    const name = user.full_name || user.username;
    if (name && name !== viewerName) return name;
  }
  return users[0]?.full_name || users[0]?.username || 'Unknown';
}

function getViewerIdCandidates(rawThread) {
  const ids = [
    rawThread.viewer_id,
    rawThread.viewer?.id,
    rawThread.viewer?.pk,
    rawThread.viewer?.interop_messaging_user_fbid,
    rawThread.viewer?.user_id,
    rawThread.viewer?.igid
  ].filter(Boolean);

  return new Set(ids.map(id => String(id)));
}

function isViewerSender(node, rawThread, viewerName) {
  const senderIds = [
    node.sender_fbid,
    node.sender?.id,
    node.sender?.igid,
    node.sender?.user_dict?.id,
    node.sender?.user_dict?.igid
  ].filter(Boolean).map(id => String(id));

  const viewerIds = getViewerIdCandidates(rawThread);
  for (const id of senderIds) {
    if (viewerIds.has(id)) return true;
  }

  const senderName = node.sender?.user_dict?.full_name || node.sender?.name;
  return !!(senderName && viewerName && senderName === viewerName);
}

function getXmaMediaUrl(xma) {
  return (
    xma?.preview_image?.url ||
    xma?.preview_image?.fallback_url ||
    xma?.xmaPreviewImage?.url ||
    xma?.xmaPreviewImage?.fallback_url ||
    xma?.xmaPreviewImage?.fallback_url ||
    null
  );
}

function getMediaUrlFromNode(node) {
  return (
    getXmaMediaUrl(node.content?.xma) ||
    node.content?.preview_image?.url ||
    node.content?.preview_image?.fallback_url ||
    node.content?.image?.url ||
    node.content?.image?.uri ||
    node.content?.image_versions2?.candidates?.[0]?.url ||
    node.media?.image_versions2?.candidates?.[0]?.url ||
    node.media?.video_versions?.[0]?.url ||
    node.media?.audio?.url ||
    null
  );
}

export function normalizeThreadInfo(rawThread) {
  const viewerName = getViewerName(rawThread);
  const participants = [
    ...(rawThread.users || []).map(u => ({ name: u.full_name || u.username })),
    { name: viewerName }
  ];
  
  const title = rawThread.thread_title || (rawThread.users?.[0]?.full_name || rawThread.users?.[0]?.username || 'Unknown Thread');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const thread_path = `inbox/${slug}_${rawThread.thread_id || 'unknown'}`;

  return {
    participants,
    title,
    is_still_participant: true,
    thread_path,
    magic_words: []
  };
}

export function normalizeMessage(node, threadInfo) {
  const viewerName = getViewerName(threadInfo);
  const otherName = getOtherParticipantName(threadInfo, viewerName);
  const fromViewer = isViewerSender(node, threadInfo, viewerName);

  const msg = {
    sender_name: node.sender?.user_dict?.full_name || node.sender?.name || 'Unknown',
    timestamp_ms: parseInt(node.timestamp_ms || node.id || '0', 10),
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false
  };

  if (typeof node.text_body === 'string' && node.text_body.trim().length > 0) {
    msg.content = node.text_body;
  } else if (typeof node.igd_snippet === 'string' && node.igd_snippet.trim().length > 0) {
    msg.content = node.igd_snippet;
  }

  if (node.reactions && Array.isArray(node.reactions) && node.reactions.length > 0) {
    msg.reactions = node.reactions.map(r => {
      const actorName = fromViewer ? (otherName || 'Unknown') : (viewerName || 'Unknown');
      return {
        reaction: r.reaction || r.emoji || r.reaction_type || '',
        actor: actorName
      };
    });
  }

  const contentType = node.content_type;
  const xma = node.content?.xma;
  const mediaUrl = getMediaUrlFromNode(node);

  if (contentType === 'IMAGES' && mediaUrl) {
    msg.photos = [{ uri: mediaUrl, creation_timestamp: Math.floor(msg.timestamp_ms / 1000) }];
  } else if (contentType === 'VIDEOS' && mediaUrl) {
    msg.videos = [{ uri: mediaUrl, creation_timestamp: Math.floor(msg.timestamp_ms / 1000) }];
  } else if (contentType === 'AUDIOS') {
    msg.audio_files = [{ uri: mediaUrl || 'audio.mp4', creation_timestamp: Math.floor(msg.timestamp_ms / 1000) }];
  } else if (contentType === 'MESSAGE_INLINE_SHARE' || contentType === 'MONTAGE_SHARE_XMA') {
    msg.share = {
      link: getXmaMediaUrl(xma) || '',
      share_text: xma?.header_title_text || xma?.xmaHeaderTitle || '',
      original_content_owner: '' // Not explicitly in findings
    };
  } else if (node.content_type === 'REACTION_LOG_XMAT' || node.content_type === 'ACTION_LOG' || node.content_type === 'IgDirectThreadActionLogXPItem') {
    return null; // Skip this event
  }

  const hasPayload = !!(
    msg.content ||
    msg.photos ||
    msg.videos ||
    msg.audio_files ||
    msg.share ||
    msg.call_duration ||
    (msg.reactions && msg.reactions.length > 0)
  );

  if (!hasPayload) return null;

  return msg;
}

export function normalize(rawThread, rawMessagesMap) {
  const base = normalizeThreadInfo(rawThread);
  
  const messages = Object.values(rawMessagesMap)
    .map(node => normalizeMessage(node, rawThread))
    .filter(Boolean)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);

  return {
    ...base,
    messages
  };
}
