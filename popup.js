const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  statusSub: document.getElementById("statusSub"),
  threadName: document.getElementById("threadName"),
  msgCount: document.getElementById("msgCount"),
  progress: document.getElementById("progress"),
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
};

const state = {
  tabId: null,
  isInstagram: false,
  count: 0,
  threadTitle: "",
  autoScrolling: false,
  lastError: null,
  phase: "idle", // idle | capturing | scrolling | exporting | success | error
};

const HINTS = {
  no_thread: "Open a DM conversation at instagram.com/direct/t/...",
  no_messages: "Scroll up inside the thread once to trigger Instagram's history fetch.",
  validation: "The data Instagram returned didn't match the expected shape. Try refreshing the page and capturing again.",
  download: "Chrome blocked the download. Check your download settings or try again.",
  unknown: "Try refreshing the Instagram tab, then reopen this popup.",
};

function setPhase(phase, label, sub) {
  state.phase = phase;
  els.statusDot.dataset.state = phase === "idle" ? "idle"
    : phase === "capturing" || phase === "exporting" ? "capturing"
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
  if (newCount > 0) {
    els.exportBtn.disabled = false;
  }
}

function updateThread(title) {
  if (title && title !== state.threadTitle) {
    state.threadTitle = title;
    els.threadName.textContent = title;
  } else if (!title) {
    els.threadName.textContent = "No thread detected";
  }
}

function classifyError(msg, problems) {
  const m = (msg || "").toLowerCase();
  if (m.includes("no thread") || m.includes("not captured")) return "no_messages";
  if (m.includes("validation") || (problems && problems.length)) return "validation";
  if (m.includes("download")) return "download";
  if (m.includes("instagram")) return "no_thread";
  return "unknown";
}

function showError(title, body, problems) {
  state.lastError = { title, body, problems };
  setPhase("error", "Error", "");
  els.errorTitle.textContent = title || "Something went wrong";
  els.errorBody.textContent = body + (problems?.length ? `\n• ${problems.slice(0, 3).join("\n• ")}` : "");
  els.errorHint.textContent = HINTS[classifyError(body, problems)] || "";
  els.errorCard.hidden = false;
  els.exportBtn.disabled = state.count === 0;
  els.exportBtn.textContent = state.count > 0 ? "Retry Export" : "Export JSON";
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

function setAutoScrollUI(scrolling) {
  state.autoScrolling = scrolling;
  els.autoScrollLabel.textContent = scrolling ? "Stop" : "Auto-scroll";
  els.autoScrollBtn.classList.toggle("active", scrolling);
}

function sendToTab(message, callback) {
  if (!state.tabId) return;
  chrome.tabs.sendMessage(state.tabId, message, (resp) => {
    if (chrome.runtime.lastError) {
      console.warn("[popup] tab message failed:", chrome.runtime.lastError.message);
      return;
    }
    callback?.(resp);
  });
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    state.tabId = tab.id;
    state.isInstagram = !!tab.url?.includes("instagram.com");

    if (!state.isInstagram) {
      setPhase("idle", "Not Instagram", "");
      els.threadName.textContent = "Open instagram.com to start";
      els.autoScrollBtn.disabled = true;
      els.exportBtn.disabled = true;
      return;
    }

    setPhase("idle", "Ready", "");
    els.autoScrollBtn.disabled = false;

    sendToTab({ action: "GET_STATUS" }, (resp) => {
      if (!resp) return;
      if (resp.threadTitle) updateThread(resp.threadTitle);
      if (resp.messageCount > 0) {
        updateCount(resp.messageCount);
        setPhase("capturing", "Capturing", "");
      }
      if (resp.autoScrolling) setAutoScrollUI(true);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "IG_EXPORTER_UPDATED") {
      if (message.threadTitle) updateThread(message.threadTitle);
      updateCount(message.messageCount);
      if (state.phase === "idle" || state.phase === "error") {
        setPhase("capturing", "Capturing", "");
        clearError();
      }
    }

    if (message.type === "IG_EXPORTER_AUTOSCROLL_STATE") {
      setAutoScrollUI(message.scrolling);
      if (message.scrolling) {
        setPhase("scrolling", "Auto-scrolling", "loading history");
      } else if (state.phase === "scrolling") {
        setPhase(state.count > 0 ? "capturing" : "idle", state.count > 0 ? "Captured" : "Ready", message.reason || "");
      }
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
        els.exportBtn.disabled = false;
        els.exportBtn.textContent = "Export JSON";
        showToast("✓ JSON downloaded");
      });
    }
  });

  /* ===== Buttons ===== */
  els.exportBtn.addEventListener("click", () => {
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
    clearError();
    if (state.count > 0) {
      els.exportBtn.click();
    } else {
      setPhase("idle", "Ready", "");
      sendToTab({ action: "GET_STATUS" }, (resp) => {
        if (resp?.messageCount > 0) updateCount(resp.messageCount);
      });
    }
  });

  els.copyErrBtn.addEventListener("click", async () => {
    if (!state.lastError) return;
    const payload = [
      `IG Exporter v2.0 — error report`,
      `URL pattern: instagram.com/direct/t/...`,
      `Phase: ${state.phase}`,
      `Captured: ${state.count}`,
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
});
