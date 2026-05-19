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
  let threadTitles = {};
  let capturing = false;

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

  function getActiveTitle() {
    const activeId = getActiveId();
    if (activeId && threadTitles[activeId]) return threadTitles[activeId];
    let best = null;
    let bestCount = -1;
    for (const [id, count] of Object.entries(threadCounts)) {
      if (count > bestCount && threadTitles[id]) {
        best = threadTitles[id];
        bestCount = count;
      }
    }
    return best;
  }

  function broadcastUpdate(count) {
    // Only forward to popup when capture is active. The interceptor still
    // stores responses in the background so we don't lose any messages.
    if (!capturing) return;
    chrome.runtime.sendMessage({
      type: "IG_EXPORTER_UPDATED",
      messageCount: count,
      threadTitle: getActiveTitle(),
    }).catch(() => {});
  }

  function broadcastCaptureState() {
    chrome.runtime.sendMessage({
      type: "IG_EXPORTER_CAPTURE_STATE",
      capturing,
    }).catch(() => {});
  }

  /* ===== Capture toggle ===== */
  function setCapturing(on) {
    const wasCapturing = capturing;
    capturing = !!on;
    if (!capturing && autoScroll.active) {
      stopAutoScroll("capture stopped");
    }
    broadcastCaptureState();
    // On Start: surface whatever was already collected so the user sees
    // the existing message count instead of a misleading 0.
    if (capturing && !wasCapturing) {
      broadcastUpdate(getActiveCount());
    }
  }

  /* ===== Auto-scroll ===== */
  function findScrollContainer() {
    const root =
      document.querySelector('[role="main"]') ||
      document.querySelector("main") ||
      document.body;

    const candidates = [];
    const divs = root.querySelectorAll("div");

    for (const el of divs) {
      if (el.clientHeight === 0) continue;
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (!["auto", "scroll", "overlay"].includes(overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;

      const inner = el.innerHTML.length;
      const score =
        el.clientHeight * 2 +
        (el.scrollHeight - el.clientHeight) +
        Math.min(inner / 100, 500);
      candidates.push({ el, score });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  // IG's message list uses flex-direction: column-reverse. In that layout,
  // scrollTop=0 is the visual BOTTOM (newest). To reach the top (oldest),
  // we need to scroll into negative scrollTop territory. Setting a large
  // negative value works for both normal (clamped to 0) and reversed
  // (clamped to -(scrollHeight - clientHeight)) containers.
  function scrollToVisualTop(container) {
    container.scrollTop = -container.scrollHeight;
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
    announceAutoScrollState(false, reason);
  }

  function startAutoScroll() {
    if (autoScroll.active) return { ok: true, alreadyRunning: true };
    if (!capturing) {
      return { ok: false, reason: "Start capture first, then auto-scroll." };
    }
    const container = findScrollContainer();
    if (!container) {
      return { ok: false, reason: "No scrollable thread found. Open a DM and scroll once manually first." };
    }
    autoScroll.active = true;
    autoScroll.container = container;
    autoScroll.lastSeen = getActiveCount();
    autoScroll.stallCount = 0;

    announceAutoScrollState(true);

    const TICK_MS = 800;
    const MAX_STALL_TICKS = 13; // ~10.4s with no new messages → stop

    autoScroll.timer = setInterval(() => {
      if (!autoScroll.container || !autoScroll.container.isConnected) {
        stopAutoScroll("thread container disappeared");
        return;
      }
      scrollToVisualTop(autoScroll.container);

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
      threadTitles = event.data.titles || {};
      const activeId = getActiveId() || event.data.latestId;
      const count = threadCounts[activeId] || 0;
      broadcastUpdate(count);
    }

    if (event.data?.type === "IG_EXPORTER_STORE_RESPONSE") {
      const store = event.data;
      if (!store.threadInfo) {
        chrome.runtime.sendMessage({
          type: "IG_EXPORTER_ERROR",
          error: "No thread data captured yet. Open a thread and scroll.",
        });
        return;
      }

      const result = normalize(store.threadInfo, store.messages);
      const problems = validate(result);

      if (problems.length > 0) {
        chrome.runtime.sendMessage({
          type: "IG_EXPORTER_ERROR",
          error: "Validation failed",
          problems,
        });
      } else {
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
        threadTitle: getActiveTitle(),
        autoScrolling: autoScroll.active,
        capturing,
      });
      return true;
    }

    if (message.action === "CAPTURE_START") {
      setCapturing(true);
      sendResponse({ ok: true });
      return true;
    }

    if (message.action === "CAPTURE_STOP") {
      setCapturing(false);
      sendResponse({ ok: true });
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

  window.addEventListener("beforeunload", () => stopAutoScroll("page unload"));
})();
