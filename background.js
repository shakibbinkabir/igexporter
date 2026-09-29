// background.js — MV3 service worker (orchestrator)
//
// The popup is ephemeral and the real work lives in an offscreen document, so
// this worker is the stable hub: it spins up the offscreen document, forwards
// the export job, mirrors progress onto the toolbar badge, and performs every
// chrome.downloads.download (profile ZIPs and the chat JSON alike).
//
// The chat exporter (bridge.js) otherwise talks straight to the popup; it only
// comes here to save the finished file.

const OFFSCREEN_URL = "offscreen.html";

let jobCounter = 0;
const pendingDownloads = new Map(); // downloadId -> { url, jobId }

/* ===== downloads ===== */

// Download managers (e.g. IDM) hook every download and can drop the filename
// we ask for, leaving a blob UUID. Re-assert our own names when Chrome asks.
const wantedNames = new Map(); // download url -> filename

function saveFile(url, filename, callback) {
  wantedNames.set(url, filename);
  chrome.downloads.download({ url, filename, saveAs: true }, callback);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = wantedNames.get(item.url);
  if (!filename) return; // not ours — Chrome proceeds with its own choice
  wantedNames.delete(item.url);
  suggest({ filename, conflictAction: "uniquify" });
});

/* ===== offscreen lifecycle ===== */

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Fetch and package Instagram media into a downloadable ZIP.",
    });
  } catch (err) {
    // Two near-simultaneous requests can race; a "single offscreen document"
    // error just means it already exists.
    if (!/single offscreen/i.test(err?.message || "")) throw err;
  }
}

/* ===== badge ===== */

function setBadge(text, color = "#0095f6") {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function clearBadgeSoon(text, ms = 3500) {
  if (text) setBadge(text, text === "!" ? "#ff5470" : "#34d399");
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), ms);
}

/* ===== messaging ===== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From popup: kick off an export.
  if (msg?.type === "PROFILE_EXPORT") {
    const jobId = `job_${Date.now()}_${++jobCounter}`;
    (async () => {
      try {
        await ensureOffscreen();
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "RUN_EXPORT",
          job: { jobId, mode: msg.mode, username: msg.username, options: msg.options || {} },
        });
        setBadge("…");
        sendResponse({ ok: true, jobId });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "Could not start export." });
      }
    })();
    return true; // async sendResponse
  }

  // From offscreen: progress tick → badge.
  if (msg?.type === "EXPORT_PROGRESS") {
    if (msg.phase === "downloading" && msg.total) {
      setBadge(`${Math.floor((msg.done / msg.total) * 100)}%`);
    } else if (msg.phase === "zipping" || msg.phase === "resolving") {
      setBadge("…");
    }
    return; // also delivered to the popup, which renders the detail
  }

  // From offscreen: a finished artifact (a blob URL the offscreen doc owns).
  if (msg?.type === "EXPORT_DOWNLOAD_URL") {
    setBadge("…");
    saveFile(msg.url, msg.filename, (downloadId) => {
      if (chrome.runtime.lastError || downloadId == null) {
        const reason = chrome.runtime.lastError?.message || "Download failed.";
        chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", url: msg.url }).catch(() => {});
        clearBadgeSoon("!");
        chrome.runtime.sendMessage({ type: "EXPORT_ERROR", jobId: msg.jobId, error: /canceled/i.test(reason) ? "Download canceled." : reason }).catch(() => {});
        return;
      }
      pendingDownloads.set(downloadId, { url: msg.url, jobId: msg.jobId });
      clearBadgeSoon("✓");
      chrome.runtime.sendMessage({ type: "EXPORT_DONE", jobId: msg.jobId, filename: msg.filename, summary: msg.summary || {} }).catch(() => {});
    });
    return;
  }

  // From popup: save the chat export JSON.
  if (msg?.type === "SAVE_FILE") {
    saveFile(msg.url, msg.filename, (downloadId) => {
      const error = chrome.runtime.lastError?.message || (downloadId == null ? "Download failed." : null);
      sendResponse(error ? { ok: false, error } : { ok: true });
    });
    return true; // async sendResponse
  }

  // From offscreen: a failure.
  if (msg?.type === "EXPORT_ERROR") {
    clearBadgeSoon("!");
    return; // popup renders the message
  }
});

// Revoke the blob URL once Chrome has finished reading it.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const entry = pendingDownloads.get(delta.id);
  if (!entry) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", url: entry.url }).catch(() => {});
    pendingDownloads.delete(delta.id);
  }
});
