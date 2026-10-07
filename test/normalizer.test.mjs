// Self-check for the DM normalizer. Run: node test/normalizer.test.mjs
import assert from 'node:assert/strict';
import { normalize } from '../src/normalizer.js';
import { validate } from '../src/schema.js';

const sender = (fbid, full_name) => ({ sender_fbid: fbid, sender: { name: full_name, user_dict: { full_name } } });
const me = sender('1', 'Me Myself');
const them = sender('2', 'Other Person');
const node = (ts, who, content_type, content, extra = {}) => ({
  message_id: `mid.${ts}`,
  timestamp_ms: String(ts),
  content_type,
  content,
  ...who,
  ...extra,
});

const call = (ts, who, plaintext) =>
  node(ts, who, 'IG_VIDEO_CALL_XMAT', { __typename: 'SlideMessageAdminText', text_fragments: [{ plaintext }] });

const info = {
  thread_id: '999',
  thread_title: null,
  users: [{ fbid: '2', username: 'other', full_name: 'Other Person' }],
  viewer_fbid: '1',
};

const out = normalize(info, [
  node(1000, me, 'TEXT', { __typename: 'SlideMessageText', text_body: 'hi' }, {
    text_body: 'hi',
    reactions: [{ reaction: '❤', sender_fbid: '2' }],
  }),
  node(2000, them, 'IMAGES', {
    __typename: 'SlideMessageImageContent',
    attachments: [{ attachment_cdn_url: 'https://cdn/a.jpg' }, { preview_cdn_url: 'https://cdn/b.jpg' }],
  }),
  node(3000, them, 'AUDIOS', {
    __typename: 'SlideMessageAudiosContent',
    audio_attachments: [{ attachment_cdn_url: 'https://cdn/a.mp4' }],
  }),
  node(4000, me, 'MESSAGE_INLINE_SHARE', {
    __typename: 'SlideMessageXMAContent',
    xma: { target_url: 'https://www.instagram.com/reel/abc/', header_title_text: 'owner' },
  }),
  // Answered call: started + ended fold into one message, 60s apart.
  call(5000, them, 'Other started an audio call'),
  call(65000, them, 'Audio call ended'),
  // Missed call: duration 0.
  call(70000, them, 'Other started a video chat'),
  call(90000, them, 'You missed a video chat'),
  // An end notice whose start wasn't loaded stays a plain text row.
  call(100000, them, 'Audio call ended'),
  node(6000, them, 'REACTION_LOG_XMAT', {
    __typename: 'SlideMessageAdminText',
    text_fragments: [{ plaintext: 'Liked a message' }],
  }),
  node(7000, me, 'MULTI', {
    __typename: 'SlideMessageMultiMediaContent',
    ordered_photo_video_attachments: [
      { attachment_cdn_url: 'https://cdn/v.mp4?x=1' },
      { attachment_cdn_url: 'https://cdn/p.jpg' },
    ],
  }),
  node(8000, me, 'TEXT', { __typename: 'SlideMessageText', text_body: '   ' }), // empty → dropped
  node(9000, them, 'MESSAGE_INLINE_SHARE', {
    __typename: 'SlideMessageXMAContent',
    xma: { __typename: 'SlideMessagePlaceholderXMA', title_text: 'Message unavailable' },
  }), // placeholder → dropped
]);

assert.deepEqual(validate(out), []);
assert.deepEqual(out.participants, [{ name: 'Other Person' }, { name: 'Me Myself' }]);
assert.equal(out.title, 'Other Person');
assert.equal(out.thread_path, 'inbox/other_person_999');

// Newest first; the reaction log, the blank text and the placeholder are gone.
assert.deepEqual(out.messages.map((m) => m.timestamp_ms), [100000, 70000, 7000, 5000, 4000, 3000, 2000, 1000]);
const at = (ts) => out.messages.find((m) => m.timestamp_ms === ts);

assert.equal(at(1000).content, 'hi');
assert.equal(at(1000).sender_name, 'Me Myself');
assert.deepEqual(at(1000).reactions, [{ reaction: '❤', actor: 'Other Person' }]);
assert.deepEqual(at(2000).photos.map((p) => p.uri), ['https://cdn/a.jpg', 'https://cdn/b.jpg']);
assert.equal(at(2000).photos[0].creation_timestamp, 2);
assert.equal(at(3000).audio_files[0].uri, 'https://cdn/a.mp4');
assert.deepEqual(at(4000).share, {
  link: 'https://www.instagram.com/reel/abc/',
  share_text: '',
  original_content_owner: 'owner',
});
assert.equal(at(5000).content, 'Other started an audio call');
assert.equal(at(5000).call_duration, 60);
assert.equal(at(70000).call_duration, 0);
assert.equal(at(100000).content, 'Audio call ended');
assert.equal('call_duration' in at(100000), false);
assert.equal('call_duration' in at(1000), false);
assert.equal(at(7000).videos[0].uri, 'https://cdn/v.mp4?x=1');
assert.equal(at(7000).photos[0].uri, 'https://cdn/p.jpg');

console.log('normalizer ok');
