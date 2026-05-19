export function validate(obj) {
  const problems = [];
  
  if (!obj || typeof obj !== 'object') {
    return ['Top-level should be an object'];
  }

  if (!Array.isArray(obj.participants)) problems.push('participants should be an array');
  else if (obj.participants.some(p => !p.name)) problems.push('each participant should have a name');

  if (!Array.isArray(obj.messages)) problems.push('messages should be an array');
  else {
    let lastTime = Infinity;
    obj.messages.forEach((m, idx) => {
      if (typeof m.sender_name !== 'string') problems.push(`messages[${idx}] missing sender_name`);
      if (typeof m.timestamp_ms !== 'number') problems.push(`messages[${idx}] missing/invalid timestamp_ms`);
      else {
        if (m.timestamp_ms > lastTime) problems.push(`messages[${idx}] is older than previous message (not sorted by newest first)`);
        lastTime = m.timestamp_ms;
      }
      if (m.is_geoblocked_for_viewer !== false) problems.push(`messages[${idx}] is_geoblocked_for_viewer should be false`);
      if (m.is_unsent_image_by_messenger_kid_parent !== false) problems.push(`messages[${idx}] is_unsent_image_by_messenger_kid_parent should be false`);
    });
  }

  if (typeof obj.title !== 'string') problems.push('title should be a string');
  if (obj.is_still_participant !== true) problems.push('is_still_participant should be true');
  if (typeof obj.thread_path !== 'string') problems.push('thread_path should be a string');
  if (!Array.isArray(obj.magic_words) || obj.magic_words.length !== 0) problems.push('magic_words should be empty array');

  return problems;
}
