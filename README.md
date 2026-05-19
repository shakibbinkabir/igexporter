<p align="center">
  <img src="icons/icon256.png" width="128" alt="IG Exporter" />
</p>

<h1 align="center">IG Exporter</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://github.com/shakibbinkabir/igexporter/releases"><img src="https://img.shields.io/badge/version-2.2.1-blue.svg" alt="Version" /></a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/"><img src="https://img.shields.io/badge/Manifest-V3-green.svg" alt="Manifest V3" /></a>
</p>

A vanilla-JavaScript, fully local Chrome Extension that exports a single Instagram DM thread to a JSON file structurally equivalent to Instagram's official **"Download Your Information" (DYI)** export — without waiting days for the official archive.

> **No servers. No tracking. No third-party calls.** Everything runs in your browser tab.

---

## Why

Instagram's official DYI export can take **hours to weeks** to be ready, and you only get *everything* — not just the one conversation you actually need. IG Exporter captures messages directly from Instagram's own GraphQL responses as you scroll a thread, normalizes them into the exact same shape as the DYI `message_*.json` files, and hands you a download.

Useful for:

- Personal backups of a single conversation
- Forensic / discovery work on your own DMs
- Importing one thread into tools that already understand the DYI schema
- Anything you'd otherwise have to wait days for

---

## Features

- **DYI-compatible schema** — drop the output into any tool that already parses Instagram's official export.
- **Manifest V3** — no remote code, no `<all_urls>`, scoped to `instagram.com` only.
- **Zero backend** — no analytics, no telemetry, no network calls beyond what Instagram itself makes.
- **Captures everything visible** — text, reactions, photos, videos, audio messages, shares, and call events.
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

## Usage

1. Go to <https://www.instagram.com/> and open a DM thread.
2. **Scroll up** inside the thread to load as much history as you want exported. The extension captures messages from Instagram's own GraphQL responses as they stream in.
3. Click the **IG Exporter** icon in your toolbar.
4. The popup shows the live capture count for the active thread. When you're done scrolling, click **Export JSON**.
5. The exporter validates the structure, then prompts you to save `instagram_<title>_<timestamp>.json`.

> Tip: Instagram only loads ~20 messages per scroll. For long threads, scroll patiently until the count stops growing.

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

```
popup.html / popup.js          ← extension UI, triggers export & downloads file
        │
        ▼
src/bridge.js                  ← content script; relays messages between page & extension
        │
        ▼  (injects)
src/interceptor.js             ← runs in page context; wraps XHR + fetch
        │
        ▼
Instagram GraphQL responses    ← thread metadata + message edges captured here
        │
        ▼
src/normalizer.js              ← reshapes raw GraphQL into DYI schema
        │
        ▼
src/schema.js                  ← validates output before download
```

- **`bridge.js`** runs as a content script. It imports `normalizer.js` and `schema.js` via ES modules and injects `interceptor.js` into the page's main world.
- **`interceptor.js`** patches `XMLHttpRequest` and `fetch` to clone responses from `/api/graphql` and `/graphql/query`, harvesting any `slide_messages.edges` it sees and de-duplicating across thread-ID aliases.
- **`normalizer.js`** maps the raw GraphQL shape to the DYI schema, resolving sender identity, media URLs, reactions, and shares.
- **`schema.js`** runs a final structural check (required fields, sort order, boolean invariants) and refuses to export if the result is malformed.

Nothing is sent off-device. The only network traffic is what Instagram itself initiates.

---

## Limitations

These are intentional non-goals — they exist because the web client doesn't expose the equivalent data, not because they're hard:

- **Media URIs are CDN URLs**, not local file paths. Instagram's web client never downloads media to disk; you'd have to fetch each URL separately.
- **`thread_path`** is a best-effort slug; the inner DYI folder IDs are private to the mobile/desktop DYI pipeline.
- **`creation_timestamp`** on media is derived from the message timestamp when Instagram doesn't expose a separate one.
- **Call events are emitted as `call_duration: 0`**. IG's web client surfaces calls as admin-text rows ("Started an audio call", "You missed a video call") without exposing the actual seconds the call lasted, so each call becomes one row but the real duration isn't filled in the way DYI does.
- **Emojis are preserved natively** rather than mimicking the DYI export's well-known mojibake (`ð`) encoding.
- **Realtime WebSocket payloads** are binary LightSpeed and are deliberately not decoded. Anything that only arrives over WebSocket without a GraphQL backfill will be missed — scroll the thread to force a GraphQL fetch.

---

## Privacy & Security

- **No remote endpoints.** Inspect `manifest.json`: the only host permission is `https://www.instagram.com/*`.
- **No remote code.** All scripts ship in this repo — Manifest V3 forbids loading anything else.
- **No analytics.** No pings, no error reporting, no usage stats.
- **You control the file.** The export uses `chrome.downloads.download` with `saveAs: true` — Chrome shows the save dialog every time.

If you don't trust a binary you didn't build, you shouldn't — every file here is plain readable JavaScript. Read it.

---

## Development

The project is intentionally toolchain-free. There is **no build step, no bundler, no `npm install`**. Edit a `.js` file, hit reload on the extension card in `chrome://extensions/`, and you're done.

Layout:

```
igexporter/
├── manifest.json          # MV3 manifest
├── popup.html / popup.js  # toolbar UI
├── src/
│   ├── bridge.js          # content script (isolated world)
│   ├── interceptor.js     # page-world XHR/fetch hook
│   ├── normalizer.js      # raw → DYI shape
│   └── schema.js          # output validator
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
