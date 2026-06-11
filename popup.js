const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  statusSub: document.getElementById("statusSub"),
  threadName: document.getElementById("threadName"),
  msgCount: document.getElementById("msgCount"),
  progress: document.getElementById("progress"),
  captureBtn: document.getElementById("captureBtn"),
  captureLabel: document.getElementById("captureLabel"),
  autoScrollBtn: document.getElementById("autoScrollBtn"),
  autoScrollLabel: document.getElementById("autoScrollLabel"),
  exportBtn: document.getElementById("exportBtn"),
  errorCard: document.getElementById("errorCard"),
  errorTitle: document.getElementById("errorTitle"),
  errorBody: document.getElementById("errorBody"),
  errorHint: document.getElementById("errorHint"),
  retryBtn: document.getElementById("retryBtn"),
  copyErrBtn: document.getElementById("copyErrBtn"),
  toast: document.getElementById("toast"),

  // Tabs
  tabChat: document.getElementById("tabChat"),
  tabProfile: document.getElementById("tabProfile"),
  chatPanel: document.getElementById("chatPanel"),
  profilePanel: document.getElementById("profilePanel"),

  // Profile form
  usernameInput: document.getElementById("usernameInput"),
  modeSelect: document.getElementById("modeSelect"),
  filterField: document.getElementById("filterField"),
  filterSelect: document.getElementById("filterSelect"),
  countField: document.getElementById("countField"),
  countFieldLabel: document.getElementById("countFieldLabel"),
  countInput: document.getElementById("countInput"),
  dateField: document.getElementById("dateField"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  profileExportBtn: document.getElementById("profileExportBtn"),
  profileHint: document.getElementById("profileHint"),
  profileStatus: document.getElementById("profileStatus"),
  pStatusDot: document.getElementById("pStatusDot"),
  pStatusText: document.getElementById("pStatusText"),
  pStatusSub: document.getElementById("pStatusSub"),
  pCount: document.getElementById("pCount"),
  pCountLabel: document.getElementById("pCountLabel"),
  pProgress: document.getElementById("pProgress"),
};

const state = {
  tabId: null,
  isInstagram: false,
  count: 0,
  threadTitle: "",
  autoScrolling: false,
  capturing: false,
  lastError: null,
  phase: "idle", // idle | capturing | scrolling | exporting | success | error
  errorContext: "chat", // chat | profile — which flow owns the shared error card
  profile: {
    jobId: null,
    running: false,
    detectedUsername: "",
    detectedShortcode: "",
    detectedHighlightId: "",
    lastJob: null,
  },
};

const HINTS = {
  no_thread: "Open a DM conversation at instagram.com/direct/t/...",
  no_messages: "Click Start Capture, then scroll up inside the thread to load history.",
  validation: "The data Instagram returned didn't match the expected shape. Try refreshing the page and capturing again.",
  download: "Chrome blocked the download. Check your download settings or try again.",
  bridge: "Press F5 on the Instagram tab, then reopen this popup.",
  unknown: "Try refreshing the Instagram tab, then reopen this popup.",
};

function setPhase(phase, label, sub) {
  state.phase = phase;
  els.statusDot.dataset.state =
    phase === "capturing" || phase === "exporting" ? "capturing"
    : phase === "scrolling" ? "scrolling"
    : phase === "success" ? "success"
    : phase === "error" ? "error"
    : "idle";

  els.statusText.firstChild.textContent = label || "Waiting";
  els.statusSub.textContent = sub ? ` · ${sub}` : "";

  if (phase === "capturing" || phase === "scrolling" || phase === "exporting") {
    els.progress.classList.add("active");
  } else {
    els.progress.classList.remove("active");
  }
}

function renderButtons() {
  // Capture toggle
  if (state.capturing) {
    els.captureLabel.textContent = "Stop Capture";
    els.captureBtn.classList.remove("btn-primary");
    els.captureBtn.classList.add("btn-danger");
  } else {
    els.captureLabel.textContent = "Start Capture";
    els.captureBtn.classList.add("btn-primary");
    els.captureBtn.classList.remove("btn-danger");
  }
  els.captureBtn.disabled = !state.isInstagram;

  // Auto-scroll requires capture to be on
  els.autoScrollBtn.disabled = !state.capturing;
  els.autoScrollLabel.textContent = state.autoScrolling ? "Stop scroll" : "Auto-scroll";
  els.autoScrollBtn.classList.toggle("active", state.autoScrolling);

  // Export available whenever we have data (even after stopping)
  if (state.count > 0 && state.phase !== "exporting") {
    els.exportBtn.disabled = false;
    els.exportBtn.classList.remove("btn-secondary");
    els.exportBtn.classList.add("btn-primary");
  } else if (state.phase !== "exporting") {
    els.exportBtn.disabled = true;
    els.exportBtn.classList.add("btn-secondary");
    els.exportBtn.classList.remove("btn-primary");
  }
}

function animateCount(from, to) {
  if (from === to) return;
  const duration = 280;
  const start = performance.now();
  els.msgCount.classList.add("bumping");
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (to - from) * eased);
    els.msgCount.textContent = value;
    if (t < 1) requestAnimationFrame(tick);
    else {
      els.msgCount.textContent = to;
      setTimeout(() => els.msgCount.classList.remove("bumping"), 200);
    }
  }
  requestAnimationFrame(tick);
}

function updateCount(newCount) {
  const old = state.count;
  state.count = newCount;
  animateCount(old, newCount);
  if (!state.threadTitle) updateThread(null);
  renderButtons();
}

function updateThread(title) {
  if (title) {
    if (title !== state.threadTitle) {
      state.threadTitle = title;
      els.threadName.textContent = title;
    }
    return;
  }
  if (state.count > 0) {
    els.threadName.textContent = "Active thread";
  } else {
    els.threadName.textContent = state.capturing ? "Waiting for messages…" : "Not capturing";
  }
}

function classifyError(msg, problems) {
  const m = (msg || "").toLowerCase();
  if (m.includes("bridge") || m.includes("refresh")) return "bridge";
  if (m.includes("no thread") || m.includes("not captured")) return "no_messages";
  if (m.includes("validation") || (problems && problems.length)) return "validation";
  if (m.includes("download")) return "download";
  if (m.includes("instagram")) return "no_thread";
  return "unknown";
}

function showError(title, body, problems) {
  state.errorContext = "chat";
  state.lastError = { title, body, problems };
  setPhase("error", "Error", "");
  els.errorTitle.textContent = title || "Something went wrong";
  els.errorBody.textContent = body + (problems?.length ? `\n• ${problems.slice(0, 3).join("\n• ")}` : "");
  els.errorHint.textContent = HINTS[classifyError(body, problems)] || "";
  els.errorCard.hidden = false;
  renderButtons();
  if (state.count > 0) {
    els.exportBtn.textContent = "Retry Export";
  }
}

function clearError() {
  state.lastError = null;
  els.errorCard.hidden = true;
}

function showToast(msg, ms = 1600) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function applyCaptureState(on) {
  state.capturing = on;
  if (on) {
    setPhase("capturing", "Capturing", state.count > 0 ? `${state.count} so far` : "scroll up to load");
  } else {
    if (state.count > 0) {
      setPhase("idle", "Stopped", `${state.count} captured`);
    } else {
      setPhase("idle", "Idle", "click Start to begin");
    }
  }
  updateThread(state.threadTitle || null);
  renderButtons();
}

function sendToTab(message, callback) {
  if (!state.tabId) return;
  chrome.tabs.sendMessage(state.tabId, message, (resp) => {
    if (chrome.runtime.lastError) {
      // Always invoke the callback so the popup can react (with null) instead
      // of waiting forever. This happens when the content script in the tab is
      // stale (after the extension was reloaded but the IG tab wasn't).
      callback?.(null);
      return;
    }
    callback?.(resp);
  });
}

/* ===== Profile media export ===== */

// Reserved first path segments that are never usernames.
const IG_RESERVED = new Set([
  "explore", "reels", "reel", "p", "tv", "direct", "stories", "accounts",
  "about", "legal", "developer", "api", "graphql", "your_activity",
  "settings", "emails", "challenge", "privacy",
]);

function parseIgUrl(url) {
  const result = { username: "", shortcode: "", highlightId: "", story: false };
  if (!url) return result;
  let u;
  try { u = new URL(url); } catch { return result; }
  if (!/(^|\.)instagram\.com$/.test(u.hostname)) return result;

  const segs = u.pathname.split("/").filter(Boolean);

  // /stories/highlights/{id}/  → a specific highlight (no username in URL)
  if (segs[0] === "stories" && segs[1] === "highlights" && segs[2]) {
    result.highlightId = segs[2];
    return result;
  }
  // /stories/{username}/...  → the active story viewer
  if (segs[0] === "stories" && segs[1] && segs[1] !== "highlights") {
    result.username = segs[1];
    result.story = true;
    return result;
  }

  const postIdx = segs.findIndex((s) => s === "p" || s === "reel" || s === "tv");
  if (postIdx !== -1 && segs[postIdx + 1]) {
    result.shortcode = segs[postIdx + 1];
    if (postIdx > 0 && !IG_RESERVED.has(segs[0])) result.username = segs[0];
    return result;
  }
  if (segs.length >= 1 && !IG_RESERVED.has(segs[0])) result.username = segs[0];
  return result;
}

function switchTab(panelId) {
  const onProfile = panelId === "profilePanel";
  state.activeTab = onProfile ? "profile" : "chat";
  els.chatPanel.hidden = onProfile;
  els.profilePanel.hidden = !onProfile;
  els.tabChat.classList.toggle("active", !onProfile);
  els.tabProfile.classList.toggle("active", onProfile);
}

function updateProfileHint() {
  const mode = els.modeSelect.value;
  if (mode === "post") {
    els.profileHint.textContent = state.profile.detectedShortcode
      ? `Will export the open post (${state.profile.detectedShortcode}).`
      : "Open a post or reel on instagram.com first.";
  } else if (mode === "profilePic") {
    els.profileHint.textContent = "Downloads the full-resolution profile picture.";
  } else if (mode === "stories") {
    els.profileHint.textContent = "Downloads all currently-active (24h) stories.";
  } else if (mode === "highlights") {
    els.profileHint.textContent = state.profile.detectedHighlightId
      ? "Open highlight detected — exporting just this one. Enter the @username too."
      : "Exports all of this account's story highlights.";
  } else {
    els.profileHint.textContent = state.profile.detectedUsername
      ? ""
      : "Tip: open a profile to auto-fill the username.";
  }
}

function refreshProfileFields() {
  const mode = els.modeSelect.value;
  const isFeed = mode === "posts" || mode === "images" || mode === "reels";
  const filter = els.filterSelect.value;
  els.filterField.hidden = !isFeed;
  els.countField.hidden = !(isFeed && (filter === "recent" || filter === "oldest"));
  els.dateField.hidden = !(isFeed && filter === "range");
  if (filter === "recent") els.countFieldLabel.textContent = "How many (most recent)";
  else if (filter === "oldest") els.countFieldLabel.textContent = "How many (oldest)";
  updateProfileHint();
}

function initProfile(url) {
  const { username, shortcode, highlightId, story } = parseIgUrl(url);
  state.profile.detectedUsername = username;
  state.profile.detectedShortcode = shortcode;
  state.profile.detectedHighlightId = highlightId || "";
  if (username) els.usernameInput.value = username;
  if (shortcode) els.modeSelect.value = "post";
  else if (highlightId) els.modeSelect.value = "highlights";
  else if (story) els.modeSelect.value = "stories";
  refreshProfileFields();
}

function setProfilePhase(phase, label, sub) {
  els.profileStatus.hidden = false;
  els.pStatusDot.dataset.state =
    phase === "running" ? "capturing"
    : phase === "success" ? "success"
    : phase === "error" ? "error"
    : "idle";
  els.pStatusText.firstChild.textContent = label || "Ready";
  els.pStatusSub.textContent = sub ? ` · ${sub}` : "";
}

function setProfileProgress({ indeterminate, pct }) {
  if (indeterminate) {
    els.pProgress.classList.add("active");
    els.pProgress.classList.remove("determinate");
    els.pProgress.style.removeProperty("--pct");
  } else {
    els.pProgress.classList.remove("active");
    els.pProgress.classList.add("determinate");
    els.pProgress.style.setProperty("--pct", `${pct}%`);
  }
}

function profileHintFor(body) {
  const m = (body || "").toLowerCase();
  if (m.includes("private")) return "You can only export from public accounts or ones you follow.";
  if (m.includes("logged in") || m.includes("authoriz")) return "Open instagram.com and log in, then try again.";
  if (m.includes("rate") || m.includes("429")) return "Instagram is throttling requests. Wait a minute and retry.";
  if (m.includes("no such user") || m.includes("not found")) return "Check the username spelling.";
  if (m.includes("no posts") || m.includes("no images") || m.includes("no reels")) return "Try a different range or mode.";
  if (m.includes("post") && m.includes("open")) return "Open a post/reel page first, or pick a different mode.";
  return "";
}

function showProfileError(title, body) {
  state.errorContext = "profile";
  state.lastError = { title, body, problems: null };
  els.errorTitle.textContent = title || "Export failed";
  els.errorBody.textContent = body || "";
  els.errorHint.textContent = profileHintFor(body);
  els.errorCard.hidden = false;
  setProfilePhase("error", "Error", "");
  els.pProgress.classList.remove("active");
  els.profileExportBtn.disabled = false;
  els.profileExportBtn.textContent = "Export";
  state.profile.running = false;
}

function summaryLabel(s) {
  if (!s) return "complete";
  const fail = s.failed ? `, ${s.failed} failed` : "";
  if (s.posts != null) return `${s.posts} posts${fail}`;
  if (s.reels != null) return `${s.reels} reels${fail}`;
  if (s.stories != null) return `${s.stories} stories${fail}`;
  if (s.highlights != null) return `${s.highlights} highlights, ${s.files} files${fail}`;
  if (s.files != null) return `${s.files} files${fail}`;
  if (s.profilePic) return "profile picture";
  return "complete";
}

function buildJobFromForm() {
  const mode = els.modeSelect.value;
  let username = els.usernameInput.value.trim().replace(/^@/, "");
  const options = {};

  if (mode === "post") {
    if (!state.profile.detectedShortcode) {
      showProfileError("No post open", "Open an Instagram post or reel in the active tab, then try again.");
      return null;
    }
    options.shortcode = state.profile.detectedShortcode;
    if (!username) username = state.profile.detectedUsername || "instagram";
  } else if (!username) {
    showProfileError("Username required", "Enter the @username you want to export.");
    return null;
  }

  if (mode === "posts" || mode === "images" || mode === "reels") {
    const ftype = els.filterSelect.value;
    const filter = { type: ftype };
    if (ftype === "recent" || ftype === "oldest") {
      const n = parseInt(els.countInput.value, 10);
      if (!Number.isFinite(n) || n < 1) {
        showProfileError("Invalid count", "Enter how many posts to export (1 or more).");
        return null;
      }
      filter.n = n;
    } else if (ftype === "range") {
      filter.fromDate = els.fromInput.value || null;
      filter.toDate = els.toInput.value || null;
      if (!filter.fromDate && !filter.toDate) {
        showProfileError("No dates", "Pick a From and/or To date for the range.");
        return null;
      }
    }
    options.filter = filter;
  }

  if (mode === "highlights" && state.profile.detectedHighlightId) {
    options.highlightId = state.profile.detectedHighlightId;
  }

  return { mode, username, options };
}

function startProfileExport(job) {
  clearError();
  state.profile.lastJob = job;
  state.profile.running = true;
  state.profile.jobId = null;
  els.profileExportBtn.disabled = true;
  els.profileExportBtn.textContent = "Exporting…";
  setProfilePhase("running", "Starting", "");
  setProfileProgress({ indeterminate: true });
  els.pCount.textContent = "0";
  els.pCountLabel.textContent = "starting";

  chrome.runtime.sendMessage(
    { type: "PROFILE_EXPORT", mode: job.mode, username: job.username, options: job.options },
    (resp) => {
      if (chrome.runtime.lastError || !resp || resp.ok === false) {
        showProfileError(
          "Couldn't start export",
          (resp && resp.error) || chrome.runtime.lastError?.message || "The background worker didn't respond."
        );
        return;
      }
      state.profile.jobId = resp.jobId;
    }
  );
}

function handleProfileMessage(msg) {
  if (!msg) return;
  // Ignore messages from a different job once ours is known.
  if (state.profile.jobId && msg.jobId && msg.jobId !== state.profile.jobId) return;

  if (msg.type === "EXPORT_PROGRESS") {
    state.profile.running = true;
    if (msg.phase === "resolving") {
      setProfilePhase("running", "Resolving", msg.message || "");
      setProfileProgress({ indeterminate: true });
      els.pCount.textContent = "…";
      els.pCountLabel.textContent = "profile";
    } else if (msg.phase === "enumerating") {
      setProfilePhase("running", "Scanning", "finding posts");
      setProfileProgress({ indeterminate: true });
      els.pCount.textContent = msg.done ?? 0;
      els.pCountLabel.textContent = "found";
    } else if (msg.phase === "downloading") {
      const pct = msg.total ? Math.floor((msg.done / msg.total) * 100) : 0;
      setProfilePhase("running", "Downloading", `${msg.done}/${msg.total}`);
      setProfileProgress({ indeterminate: false, pct });
      els.pCount.textContent = `${pct}%`;
      els.pCountLabel.textContent = "downloaded";
    } else if (msg.phase === "zipping") {
      setProfilePhase("running", "Packaging", "building ZIP");
      setProfileProgress({ indeterminate: true });
      els.pCount.textContent = "…";
      els.pCountLabel.textContent = "zipping";
    }
    return;
  }

  if (msg.type === "EXPORT_DONE") {
    state.profile.running = false;
    clearError();
    setProfilePhase("success", "Done", msg.filename || "");
    setProfileProgress({ indeterminate: false, pct: 100 });
    els.pCount.textContent = "✓";
    els.pCountLabel.textContent = summaryLabel(msg.summary);
    els.profileExportBtn.disabled = false;
    els.profileExportBtn.textContent = "Export";
    showToast("✓ Saved " + (msg.filename || "file"));
    return;
  }

  if (msg.type === "EXPORT_ERROR") {
    showProfileError("Export failed", msg.error || "Something went wrong.");
  }
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    state.tabId = tab.id;
    state.isInstagram = !!tab.url?.includes("instagram.com");

    // Profile tab works regardless of the active tab; autodetect runs first.
    initProfile(tab.url);

    if (!state.isInstagram) {
      setPhase("idle", "Not Instagram", "");
      els.threadName.textContent = "Open instagram.com to start";
      renderButtons();
      return;
    }

    // Paint defaults up front so the UI never sits at the raw HTML state
    // (e.g. when the content script in the tab is stale and never replies).
    applyCaptureState(false);

    sendToTab({ action: "GET_STATUS" }, (resp) => {
      if (!resp) {
        showError(
          "Bridge not responding",
          "The Instagram tab needs to be refreshed (the extension was reloaded after the page was open)."
        );
        return;
      }
      if (resp.threadTitle) updateThread(resp.threadTitle);
      if (resp.messageCount > 0) state.count = resp.messageCount;
      state.autoScrolling = !!resp.autoScrolling;
      applyCaptureState(!!resp.capturing);
      if (state.count > 0) els.msgCount.textContent = state.count;
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "IG_EXPORTER_UPDATED") {
      if (message.threadTitle) updateThread(message.threadTitle);
      updateCount(message.messageCount);
      if (state.capturing && state.phase !== "scrolling") {
        setPhase("capturing", "Capturing", `${message.messageCount}`);
        clearError();
      }
    }

    if (message.type === "IG_EXPORTER_CAPTURE_STATE") {
      applyCaptureState(message.capturing);
    }

    if (message.type === "IG_EXPORTER_AUTOSCROLL_STATE") {
      state.autoScrolling = message.scrolling;
      if (message.scrolling) {
        setPhase("scrolling", "Auto-scrolling", "loading history");
      } else if (state.phase === "scrolling") {
        applyCaptureState(state.capturing);
      }
      renderButtons();
    }

    if (message.type === "IG_EXPORTER_ERROR") {
      showError("Export failed", message.error, message.problems);
    }

    if (message.type === "IG_EXPORTER_SUCCESS") {
      const data = message.result;
      const safeTitle = (data.title || "thread").replace(/[^a-z0-9_-]/gi, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `instagram_${safeTitle}_${timestamp}.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      chrome.downloads.download({ url, filename, saveAs: true }, () => {
        if (chrome.runtime.lastError) {
          showError("Download failed", chrome.runtime.lastError.message);
          return;
        }
        setPhase("success", "Exported", `${data.messages.length} messages`);
        els.exportBtn.textContent = "Export JSON";
        renderButtons();
        showToast("✓ JSON downloaded");
      });
    }
  });

  /* ===== Buttons ===== */
  els.captureBtn.addEventListener("click", () => {
    clearError();
    if (state.capturing) {
      sendToTab({ action: "CAPTURE_STOP" });
    } else {
      sendToTab({ action: "CAPTURE_START" });
    }
  });

  els.exportBtn.addEventListener("click", () => {
    if (state.count === 0) return;
    clearError();
    els.exportBtn.disabled = true;
    els.exportBtn.textContent = "Validating…";
    setPhase("exporting", "Exporting", "validating");
    sendToTab({ action: "EXPORT_REQUEST" });
  });

  els.autoScrollBtn.addEventListener("click", () => {
    if (state.autoScrolling) {
      sendToTab({ action: "AUTOSCROLL_STOP" });
    } else {
      clearError();
      sendToTab({ action: "AUTOSCROLL_START" }, (resp) => {
        if (resp && resp.ok === false) {
          showError("Can't auto-scroll", resp.reason || "No scrollable thread container found.");
        }
      });
    }
  });

  els.retryBtn.addEventListener("click", () => {
    if (state.errorContext === "profile") {
      clearError();
      if (state.profile.lastJob) startProfileExport(state.profile.lastJob);
      return;
    }
    clearError();
    if (state.count > 0) {
      els.exportBtn.click();
    } else {
      sendToTab({ action: "GET_STATUS" }, (resp) => {
        if (resp?.messageCount > 0) updateCount(resp.messageCount);
        applyCaptureState(!!resp?.capturing);
      });
    }
  });

  els.copyErrBtn.addEventListener("click", async () => {
    if (!state.lastError) return;
    const payload = [
      `IG Exporter v3.0.1 — error report`,
      `URL pattern: instagram.com/direct/t/...`,
      `Phase: ${state.phase}`,
      `Captured: ${state.count}`,
      `Capturing: ${state.capturing}`,
      `Title: ${state.lastError.title}`,
      `Body: ${state.lastError.body}`,
      state.lastError.problems?.length ? `Problems:\n${state.lastError.problems.map(p => "  - " + p).join("\n")}` : null,
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(payload);
      showToast("Copied to clipboard");
    } catch {
      showToast("Copy failed");
    }
  });

  /* ===== Profile tab wiring ===== */
  els.tabChat.addEventListener("click", () => switchTab("chatPanel"));
  els.tabProfile.addEventListener("click", () => switchTab("profilePanel"));

  els.modeSelect.addEventListener("change", refreshProfileFields);
  els.filterSelect.addEventListener("change", refreshProfileFields);
  els.usernameInput.addEventListener("input", () => {
    state.profile.detectedUsername = els.usernameInput.value.trim();
    updateProfileHint();
  });

  els.profileExportBtn.addEventListener("click", () => {
    if (state.profile.running) return;
    const job = buildJobFromForm();
    if (job) startProfileExport(job);
  });

  // Progress / completion / error from the offscreen worker (relayed broadcast).
  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type === "EXPORT_PROGRESS" ||
      message?.type === "EXPORT_DONE" ||
      message?.type === "EXPORT_ERROR"
    ) {
      handleProfileMessage(message);
    }
  });
});
