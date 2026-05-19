// src/bridge.js
(async function () {
  const srcURL = chrome.runtime.getURL("src/");
  const { normalize } = await import(srcURL + "normalizer.js");
  const { validate } = await import(srcURL + "schema.js");

  // Inject interceptor into page world
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/interceptor.js");
  (document.head || document.documentElement).appendChild(script);

  let threadCounts = {};
  const autoScroll = {
    active: false,
    timer: null,
    stallCount: 0,
    lastSeen: -1,
    container: null,
  };

  function getActiveId() {
    const match = window.location.pathname.match(/\/direct\/t\/([^\/]+)/);
    return match ? match[1] : null;
  }

  function getActiveCount() {
    const activeId = getActiveId();
    if (activeId && threadCounts[activeId]) return threadCounts[activeId];
    if (!activeId && Object.keys(threadCounts).length > 0) {
      return Math.max(...Object.values(threadCounts));
    }
    return 0;
  }

  /* ===== Thread title detection ===== */
  function detectThreadTitle() {
    // Strategy: find the page header inside the DM layout.
    // IG renders the thread name inside an <h1> or <header> at the top of the conversation.
    const candidates = [
      document.querySelector('section header h1'),
      document.querySelector('header h1'),
      document.querySelector('[role="main"] header [dir="auto"]'),
      document.querySelector('[role="main"] header'),
    ].filter(Boolean);

    for (const el of candidates) {
      const text = (el.innerText || el.textContent || "").trim();
      if (!text) continue;
      // Skip obvious nav labels
      if (/^(Direct|Inbox|Messages?|Requests)$/i.test(text)) continue;
      // Take first line only
      const firstLine = text.split("\n")[0].trim();
      if (firstLine.length > 0 && firstLine.length < 120) return firstLine;
    }
    return null;
  }

  function broadcastUpdate(count) {
    chrome.runtime.sendMessage({
      type: "IG_EXPORTER_UPDATED",
      messageCount: count,
      threadTitle: detectThreadTitle(),
    }).catch(() => {});
  }

  /* ===== Auto-scroll ===== */
  function findScrollContainer() {
    // Look for the scrollable parent that contains the message rows.
    const sampleRow =
      document.querySelector('div[role="row"]') ||
      document.querySelector('[data-testid*="message"]') ||
      document.querySelector('[role="listbox"] > div');

    let node = sampleRow;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      if (canScroll && node.scrollHeight > node.clientHeight + 10) {
        return node;
      }
      node = node.parentElement;
    }

    // Fallback: among all scrollable divs, pick the one with the most descendant rows.
    let best = null;
    let bestRows = 0;
    document.querySelectorAll("div").forEach((el) => {
      const style = window.getComputedStyle(el);
      if (!["auto", "scroll", "overlay"].includes(style.overflowY)) return;
      if (el.scrollHeight <= el.clientHeight + 10) return;
      const rows = el.querySelectorAll('[role="row"]').length;
      if (rows > bestRows) {
        best = el;
        bestRows = rows;
      }
    });
    return best;
  }

  function announceAutoScrollState(scrolling, reason) {
    chrome.runtime.sendMessage({
      type: "IG_EXPORTER_AUTOSCROLL_STATE",
      scrolling,
      reason: reason || "",
    }).catch(() => {});
  }

  function stopAutoScroll(reason) {
    if (!autoScroll.active) return;
    autoScroll.active = false;
    clearInterval(autoScroll.timer);
    autoScroll.timer = null;
    autoScroll.stallCount = 0;
    autoScroll.lastSeen = -1;
    autoScroll.container = null;
    console.log(`[ig-exporter] Auto-scroll stopped: ${reason || "manual"}`);
    announceAutoScrollState(false, reason);
  }

  function startAutoScroll() {
    if (autoScroll.active) return { ok: true, alreadyRunning: true };
    const container = findScrollContainer();
    if (!container) {
      return { ok: false, reason: "No scrollable thread found. Open a DM and scroll once manually first." };
    }
    autoScroll.active = true;
    autoScroll.container = container;
    autoScroll.lastSeen = getActiveCount();
    autoScroll.stallCount = 0;

    console.log("[ig-exporter] Auto-scroll started.");
    announceAutoScrollState(true);

    const TICK_MS = 700;
    const MAX_STALL_TICKS = 8; // ~5.6s with no new messages → stop

    autoScroll.timer = setInterval(() => {
      if (!autoScroll.container || !autoScroll.container.isConnected) {
        stopAutoScroll("thread container disappeared");
        return;
      }
      // Scroll to the very top to trigger Instagram's history fetch
      autoScroll.container.scrollTop = 0;

      const current = getActiveCount();
      if (current > autoScroll.lastSeen) {
        autoScroll.lastSeen = current;
        autoScroll.stallCount = 0;
      } else {
        autoScroll.stallCount++;
        if (autoScroll.stallCount >= MAX_STALL_TICKS) {
          stopAutoScroll("reached beginning of thread");
        }
      }
    }, TICK_MS);

    return { ok: true };
  }

  /* ===== Page-world bridge ===== */
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "IG_EXPORTER_UPDATED") {
      threadCounts = event.data.counts || {};
      const activeId = getActiveId() || event.data.latestId;
      const count = threadCounts[activeId] || 0;
      broadcastUpdate(count);
    }

    if (event.data?.type === "IG_EXPORTER_STORE_RESPONSE") {
      const store = event.data;
      if (!store.threadInfo) {
        const error = "No thread data captured yet. Open a thread and scroll.";
        console.error(`[ig-exporter] ${error}`);
        chrome.runtime.sendMessage({ type: "IG_EXPORTER_ERROR", error });
        return;
      }

      const result = normalize(store.threadInfo, store.messages);
      const problems = validate(result);

      if (problems.length > 0) {
        console.error("[ig-exporter] Validation failed:", problems);
        chrome.runtime.sendMessage({
          type: "IG_EXPORTER_ERROR",
          error: "Validation failed",
          problems,
        });
      } else {
        console.log("[ig-exporter] Export valid.");
        chrome.runtime.sendMessage({ type: "IG_EXPORTER_SUCCESS", result });
      }
    }
  });

  /* ===== Popup commands ===== */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "EXPORT_REQUEST") {
      window.postMessage({ type: "IG_EXPORTER_GET_STORE", activeId: getActiveId() }, "*");
      return;
    }

    if (message.action === "GET_STATUS") {
      sendResponse({
        messageCount: getActiveCount(),
        threadTitle: detectThreadTitle(),
        autoScrolling: autoScroll.active,
      });
      return true;
    }

    if (message.action === "AUTOSCROLL_START") {
      const result = startAutoScroll();
      sendResponse(result);
      return true;
    }

    if (message.action === "AUTOSCROLL_STOP") {
      stopAutoScroll("manual");
      sendResponse({ ok: true });
      return true;
    }
  });

  // Stop auto-scroll if user navigates away
  window.addEventListener("beforeunload", () => stopAutoScroll("page unload"));
})();
