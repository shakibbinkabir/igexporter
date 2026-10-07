# Changelog

All notable changes to IG Exporter. Versions follow [Semantic Versioning](https://semver.org/).

## [3.2.2] — 2026-10-07

### Fixed

- **Call durations are back.** 3.2.1 exported calls as plain text with no `call_duration`, because Instagram's web API stopped exposing one. Each call is again a single message with a `call_duration` in seconds, now derived from the gap between Instagram's "started" and "ended" notices. That gap includes the time the call rang before it was answered, so it can read up to about a minute over the real talk time (checked against two calls with known durations: +2 s and +48 s). Missed calls get `0`.
- **Switching conversations while capturing left the popup stuck at 0.** The previous thread's messages were dropped, but nothing loaded for the new one until you stopped and restarted capture. Capture now follows you into the new thread, whether you reopen the popup or just scroll.
- **File names lost a leading or trailing underscore** from usernames and post codes, so `@some_user_`'s export was named after `@some_user` (`some_user_posts_…zip`), and a post code that starts or ends with `_` was clipped in its folder name. Both are kept verbatim now.
- Profile export summaries read "1 posts", "1 highlights": singular counts are worded properly.

### Changed

- A call message now also carries Instagram's "… started an audio call" / "… started a video chat" text as `content`. In 3.2.0 it had `call_duration` only.
- A call notice whose other half is outside the loaded range (for example an "ended" row at the very start of what you scrolled to) is exported as a plain text row without a duration.
- Call pairing matches Instagram's English notice text. With Instagram in another language, calls export as two plain text rows.

## [3.2.1] — 2026-10-07

### Fixed

- **DM export failed with *Unexpected response (404)*.** Instagram removed the `direct_v2` REST endpoints from the web — `/api/v1/direct_v2/inbox/` and `threads/<id>/` now answer `404` — so Start Capture failed before loading a single message. DM export now runs the same GraphQL queries as instagram.com's own message view.

### Changed

- The open `/direct/t/<id>/` thread is loaded straight from the id in its URL. The inbox lookup is gone, and with it the limit of only finding conversations among your 120 most recent.
- Rewrote the message normalizer for the new `SlideMessage` shape — text, photos/videos, view-once media, voice messages, GIFs/stickers, shared reels/posts/links, and reactions.
- **Call events are exported as their notice text** ("… started an audio call", "Audio call ended"), one message per row, with no `call_duration`: the new API exposes neither a call id nor a duration.
- Your own name in the export comes from messages you sent. If none are in the loaded range, you appear as "Viewer".
- Added `test/normalizer.test.mjs`, a self-check for the normalizer (`node test/normalizer.test.mjs`).

## [3.2.0] — 2026-09-29

### Fixed

- **Profile export was broken.** Instagram retired the REST endpoints the exporter relied on: `web_profile_info` and `users/<id>/info` now answer `429`, and the user-feed, story, and highlights-tray endpoints return an HTML page instead of JSON. Every mode except "This post / reel" sat on *Resolving…* for about 25 seconds and then failed with a misleading rate-limit error. Profile export now uses the same GraphQL queries as instagram.com's own profile page, with search to resolve usernames.
- **"This post / reel" hung on *Resolving @instagram…*.** When the URL had no username, it looked up the @instagram account before exporting. It now takes the owner from the post itself and skips the profile lookup entirely.
- **Posts from private accounts couldn't be exported.** Their URLs carry a 28-character suffix that was being decoded as part of the post id.
- **Pinned posts broke filtering.** A date range stopped as soon as it reached an old pinned post (returning nothing), and *Most recent N* counted pinned posts as recent.
- **Images were saved as `.jpg` even though Instagram serves most of them as WebP.** Files are now named by what they actually are (`.webp`, `.jpg`, `.png`), and `index.json` matches.
- **Downloads could be saved under a random UUID name** when a download-manager extension (e.g. IDM) is installed. The extension now re-asserts its own filenames.
- **Non-Latin names were flattened to underscores** in file and folder names (e.g. a Bengali thread title or highlight name). Letters from every script are kept now.
- A reel opened from the Reels feed (`/reels/<code>/`) wasn't detected as an open post.
- Chat: shared profiles were silently dropped from the export. They're exported as a `share` linking to the profile.
- Chat: shared stories linked to `/p/<code>/`, which doesn't open a story. They link to `/stories/<user>/<id>/` now.
- Chat: the live *captured* count included empty messages that the export drops, so it could read higher than what was exported.
- Chat: errors while capturing were titled *Export failed*, and login / rate-limit errors showed a hint telling you to open a DM.
- A stalled request could leave the popup spinning forever. API requests now time out after 20 seconds.

### Changed

- **Exporting a single highlight no longer needs a username** — open the highlight and click Export.
- Links shared in chat now also carry the URL as `share.link`, next to the message text.
- Single-file downloads (a lone post image/video, the profile picture) now go through the same fetch → type-check → save path as ZIPs.
- The popup's version label and *Copy details* report read the version from the manifest, and the report now covers profile-export errors too.

## [3.1.0] — 2026-07-22

### Fixed

- **DM export stopped detecting messages.** Instagram moved Direct Message traffic off the page's main thread, so the page-world GraphQL interception saw nothing and the capture count sat at 0.

### Changed

- DM export actively fetches Instagram's private `direct_v2` REST API with your logged-in session. The chat UI (Start Capture, scroll to load, Auto-scroll, Export JSON) is unchanged.
- Rewrote the message normalizer for the `direct_v2` item shape — text, photos/videos, view-once media, voice messages, reel/post shares, call events, and reactions.
- Removed the obsolete `src/interceptor.js`.

## [3.0.2] — 2026-06-17

### Fixed

- DMs with deactivated, deleted, or blocked accounts failed validation because those participants have no name; they're now exported as "Instagram User", matching Instagram's own UI.

## [3.0.1] — 2026-06-11

### Added

- **Profile tab** — download any account's posts, images, reels, stories, highlights, or profile picture as foldered ZIPs, via a background service worker and an offscreen document.

### Fixed

- DM capture after Instagram began splitting a thread across several GraphQL ids that no longer matched the `/direct/t/` URL.

## [2.2.1] — 2026-05-19

### Fixed

- Call events are captured as one `call_duration` row per call; other admin rows (theme changes, etc.) are dropped.
- Messages without a timestamp are rejected instead of slipping past validation.
- The popup reports a stale content script instead of getting stuck.

## [2.1.1] — 2026-05-19

### Changed

- New branded extension icons, plus a committed `icons/build.ps1` to regenerate them.

## [2.1.0] — 2026-05-19

### Added

- Dark popup, Start / Stop Capture, Auto-scroll, detected thread title, and an error card with hints, Retry, and Copy details.

### Fixed

- Auto-scroll direction on Instagram's reversed message list, live count matching the export, and thread title detection.

## [2.0.0] — 2026-05-19

First open-source release: Manifest V3 rewrite around GraphQL interception, with DYI-compatible output and schema validation before download.

[3.2.2]: https://github.com/shakibbinkabir/igexporter/releases/tag/v3.2.2
[3.2.1]: https://github.com/shakibbinkabir/igexporter/releases/tag/v3.2.1
[3.2.0]: https://github.com/shakibbinkabir/igexporter/releases/tag/v3.2.0
[3.1.0]: https://github.com/shakibbinkabir/igexporter/releases/tag/v3.1.0
[3.0.1]: https://github.com/shakibbinkabir/igexporter/releases/tag/v3.0.1
[2.2.1]: https://github.com/shakibbinkabir/igexporter/releases/tag/v2.2.1
[2.1.1]: https://github.com/shakibbinkabir/igexporter/releases/tag/v2.1.1
[2.1.0]: https://github.com/shakibbinkabir/igexporter/releases/tag/v2.1.0
[2.0.0]: https://github.com/shakibbinkabir/igexporter/releases/tag/v2.0.0
