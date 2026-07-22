<p align="center">
  <img src="icons/icon256.png" width="128" alt="IG Exporter" />
</p>

<h1 align="center">IG Exporter</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://github.com/shakibbinkabir/igexporter/releases"><img src="https://img.shields.io/badge/version-3.1.0-blue.svg" alt="Version" /></a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/"><img src="https://img.shields.io/badge/Manifest-V3-green.svg" alt="Manifest V3" /></a>
</p>

A vanilla-JavaScript, fully local Chrome Extension that **(1)** exports an Instagram DM thread to a JSON file structurally equivalent to Instagram's official **"Download Your Information" (DYI)** export, and **(2)** downloads anyone's **posts, images, reels, or profile picture** as neatly foldered ZIP archives.

> **No servers. No tracking. No third-party calls.** Everything runs in your browser using your own logged-in session — the only network traffic is to `instagram.com` and its media CDNs.

---

## Why

Instagram's official DYI export can take **hours to weeks** to be ready, and you only get *everything* — not just the one conversation you actually need. IG Exporter pulls a single thread's full history directly from Instagram's own `direct_v2` API, normalizes it into the exact same shape as the DYI `message_*.json` files, and hands you a download.

Useful for:

- Personal backups of a single conversation
- Forensic / discovery work on your own DMs
- Importing one thread into tools that already understand the DYI schema
- Anything you'd otherwise have to wait days for

---

## Features

### Profile media export (new in 3.0)

- **All posts** — every post (images, carousels, videos, reels) as one ZIP, one folder per post, with each post's `caption.txt` and a top-level `index.json` manifest.
- **All images** — images only, post-wise foldered (carousels keep their images; pure-video posts are skipped).
- **All reels** — every reel as a flat set of `.mp4`s plus an `index.json`.
- **Current stories** — all currently-active (24h) stories as a ZIP.
- **Story highlights** — every highlight, one folder per highlight (named by its title), in one ZIP. Open a specific highlight first to grab just that one.
- **Profile picture** — the full-resolution DP, downloaded directly.
- **A single post / reel** — open it on instagram.com and grab just that post's media.
- **Filtering** — export *everything*, the *most recent N*, the *oldest N*, or a *date range*.
- Runs in the background, so closing the popup mid-download is safe; progress shows on the toolbar badge.

### Chat export

- **DYI-compatible schema** — drop the output into any tool that already parses Instagram's official export.
- **Manifest V3** — no remote code, no `<all_urls>`, scoped to `instagram.com` only.
- **Zero backend** — no analytics, no telemetry, no network calls beyond what Instagram itself makes.
- **Captures everything** — text, reactions, photos, videos, audio messages, shares, and call events, fetched from Instagram's own API as you scroll (or auto-scroll) the thread.
- **Newest-first ordering** matching DYI conventions.
- **Real display names** — `sender_name` is always the actual name, never `"You"`.
- **Schema validation** before download — invalid exports surface the exact problem rather than silently producing garbage.
- **Multi-thread aware** — switch between threads while the extension is running; counts are tracked per thread.

---

## Installation

This extension is distributed as an unpacked Chrome Extension. It is **not** on the Chrome Web Store.

1. Download or clone this repository:
   ```bash
   git clone https://github.com/shakibbinkabir/igexporter.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the cloned `igexporter` folder.
5. Pin the extension to your toolbar for easy access.

Works in any Chromium-based browser (Chrome, Edge, Brave, Arc, Vivaldi).

---

## Usage — Profile media export

1. Make sure you're **logged in** to Instagram in this browser.
2. (Optional) Open the profile, post, or reel you care about — the popup auto-fills the username and detects an open post.
3. Click the **IG Exporter** icon and switch to the **Profile** tab.
4. Type/confirm the `@username`, pick **What to export** (All posts / All images / All reels / Current stories / Story highlights / Profile picture / This post-reel). For the feed modes, choose a **Range** (Everything, Most recent N, Oldest N, or a Date range).
5. Click **Export**. The toolbar badge shows progress; when it finishes, Chrome prompts you to save the ZIP (or image).

> You can only export from **public accounts** or **private accounts you follow** — same as what your session can already see. Large accounts take a while and are subject to Instagram's rate limits; the exporter backs off automatically on `429`.

ZIP layout for **All posts**:

```
username_posts_2026-06-06.zip
├── index.json
├── 001_2024-05-01_Cabc123/
│   ├── 01.jpg
│   ├── 02.mp4
│   ├── 02_thumb.jpg
│   └── caption.txt
├── 002_2024-04-18_Cxyz789/
│   └── 01.jpg
└── …
```

---

## Usage — Chat export

1. Go to <https://www.instagram.com/> and open a DM thread.
2. Click the **IG Exporter** icon in your toolbar and click **Start Capture**. The most recent messages load right away.
3. **Scroll up** inside the thread to pull in older history — each scroll fetches the next page from Instagram's `direct_v2` API and the count climbs. Or click **Auto-scroll** to load the rest of the thread automatically; it stops when it reaches the beginning (or click it again to stop early).
4. When you've loaded as much as you want, click **Export JSON**.
5. The exporter validates the structure, then prompts you to save `instagram_<title>_<timestamp>.json`.

> You control how much gets exported: stop scrolling (or stop auto-scroll) whenever you have enough, and Export packages exactly what's loaded so far.

---

## Output Schema

The output mirrors Instagram's official DYI export at the top level:

```json
{
  "participants": [{ "name": "Alice" }, { "name": "Bob" }],
  "title": "Alice",
  "is_still_participant": true,
  "thread_path": "inbox/alice_17841400000000000",
  "magic_words": [],
  "messages": [
    {
      "sender_name": "Alice",
      "timestamp_ms": 1715000000000,
      "content": "hey",
      "is_geoblocked_for_viewer": false,
      "is_unsent_image_by_messenger_kid_parent": false
    }
  ]
}
```

Each message may additionally include any of: `photos`, `videos`, `audio_files`, `share`, `reactions`, `call_duration`.

---

## Architecture

The two capabilities use two independent pipelines.

**Chat export** (active, session-authenticated):

```
popup.js (Chat tab) ──▶ src/bridge.js (content script on instagram.com)
                                  │  fetches the open thread via the direct_v2 API
                                  ▼
                         instagram.com /api/v1/direct_v2/  (inbox lookup + paged thread history)
                                  │
                                  ▼
                       src/normalizer.js → src/schema.js
                                  │
                                  ▼
                          DYI-shaped JSON download
```

**Profile media export** (active, session-authenticated):

```
popup.js (Profile tab) ──job──▶ background.js (service worker)
                                       │  creates offscreen, mirrors progress → badge, runs chrome.downloads
                                       ▼
                                 offscreen.js (offscreen document)
                                       │  uses src/igapi.js + src/zip.js
              ┌────────────────────────┼─────────────────────────┐
              ▼                        ▼                          ▼
     instagram.com web API     *.cdninstagram.com /        builds ZIP in memory,
     (enumerate posts via       *.fbcdn.net (media bytes)  createObjectURL → SW download
      your session cookie)
```

- **`bridge.js`** — content script on instagram.com. On **Start Capture** it resolves the open `/direct/t/<id>/` thread to its `direct_v2` `thread_id` via an inbox lookup and loads the newest page; scrolling the thread (or **Auto-scroll**) pages older history from `/api/v1/direct_v2/threads/<id>/` using your session cookie, streaming the live count to the popup.
- **`normalizer.js` / `schema.js`** — map each `direct_v2` message item (`text`, `media`, `raven_media`, `voice_media`, `clip`, `media_share`, `reel_share`, `video_call_event`, …) to the DYI shape and validate it. If Instagram changes the DM API, these two plus `bridge.js` are where the fix goes.
- **`background.js`** — MV3 service worker; the stable hub for profile exports. Spins up the offscreen document, mirrors progress onto the toolbar badge, and performs the final `chrome.downloads.download`.
- **`offscreen.js` / `offscreen.html`** — a headless offscreen document (the only context that can both fetch with host permissions *and* `URL.createObjectURL` a blob). Runs the chosen export pipeline, fetches CDN bytes with bounded concurrency, and assembles the ZIP.
- **`src/igapi.js`** — thin client over Instagram's own web API endpoints (`web_profile_info`, the user feed, media info, active story, highlights tray, and reel media). The one file to patch if Instagram changes its endpoints.
- **`src/zip.js`** — dependency-free, store-only ZIP writer with CRC32. No compression because media is already compressed.

Nothing is sent off-device. The only network traffic is to Instagram and its media CDNs, using your existing session.

---

## Limitations

**Profile media export:**

- **Login required.** You can only export public accounts or private ones you follow — exactly what your session can already see.
- **Unofficial endpoints.** It uses Instagram's own web API, which is undocumented and changes periodically. When it breaks, `src/igapi.js` is almost always the fix.
- **In-memory ZIP.** The whole archive is assembled in memory before saving, so exporting a very large account (many GB) can exhaust memory. Use the *Most recent N* / *date range* filters for huge profiles.
- **Rate limits.** Aggressive exporting can trigger Instagram throttling (`429`); the exporter backs off and retries, but very large jobs may still be interrupted.
- **Media URLs expire**, so files are fetched immediately during the run rather than listed for later.

**Chat export** — these are intentional non-goals, because the web client doesn't expose the equivalent data:

- **Media URIs are CDN URLs**, not local file paths. Instagram's web client never downloads media to disk; you'd have to fetch each URL separately.
- **`thread_path`** is a best-effort slug; the inner DYI folder IDs are private to the mobile/desktop DYI pipeline.
- **`creation_timestamp`** on media is derived from the message timestamp when Instagram doesn't expose a separate one.
- **Call events** are collapsed to one message per call (Instagram sends a separate "started" and "ended" row); the real `call_duration` in seconds comes from the `video_call_event` payload when present, otherwise `0` for missed/declined calls.
- **Emojis are preserved natively** rather than mimicking the DYI export's well-known mojibake (`ð`) encoding.
- **Unsupported/expired rows are skipped.** "Message unavailable" placeholders and view-once media whose URL has already expired carry no content, so they're dropped rather than exported as empty messages.
- **The open conversation must be in your inbox.** The thread is located by scanning your inbox (the top several pages), so a conversation buried far down or in a separate message-requests folder may not resolve; open it fresh so it surfaces to the top.

---

## Privacy & Security

- **Only Instagram endpoints.** Inspect `manifest.json`: host permissions are limited to `instagram.com` and Instagram's media CDNs (`*.cdninstagram.com`, `*.fbcdn.net`). Profile export calls Instagram's own web API with *your* logged-in session — never a third party.
- **No remote code.** All scripts ship in this repo — Manifest V3 forbids loading anything else, and the ZIP writer is hand-rolled rather than a bundled library you can't read.
- **No analytics.** No pings, no error reporting, no usage stats.
- **You control the file.** Every export uses `chrome.downloads.download` with `saveAs: true` — Chrome shows the save dialog every time.

If you don't trust a binary you didn't build, you shouldn't — every file here is plain readable JavaScript. Read it.

---

## Development

The project is intentionally toolchain-free. There is **no build step, no bundler, no `npm install`**. Edit a `.js` file, hit reload on the extension card in `chrome://extensions/`, and you're done.

Layout:

```
igexporter/
├── manifest.json          # MV3 manifest
├── popup.html / popup.js  # toolbar UI (Chat + Profile tabs)
├── background.js          # service worker — profile export orchestrator
├── offscreen.html         # headless offscreen document host
├── offscreen.js           # profile export engine (fetch → zip → download)
├── src/
│   ├── bridge.js          # chat: content script — direct_v2 API fetch + paging
│   ├── normalizer.js      # chat: raw direct_v2 items → DYI shape
│   ├── schema.js          # chat: output validator
│   ├── igapi.js           # profile: Instagram web API client
│   └── zip.js             # profile: store-only ZIP writer
└── icons/
```

### Contributing

Issues and PRs welcome. Good first contributions:

- More content types in `normalizer.js` (stickers, polls, story replies)
- Tighter validation in `schema.js`
- Better thread-title fallbacks for group chats
- A Firefox port (the codebase is already MV3-compatible)

Please keep the project dependency-free. The whole point is that a privacy-sensitive user can read every line before installing.

---

## License

[MIT](LICENSE) © Shakib Bin Kabir

---

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. or Instagram. "Instagram" is a trademark of its respective owner. Use of this extension is subject to Instagram's Terms of Service. You are responsible for the content you export and how you use it.
