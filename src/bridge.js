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
    // Fallback: highest-count thread's title (handles alias gaps)
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
    chrome.runtime.sendMessage({
      type: "IG_EXPORTER_UPDATED",
      messageCount: count,
      threadTitle: getActiveTitle(),
    }).catch(() => {});
  }

  /* ===== Auto-scroll ===== */
  function findScrollContainer() {
    // Score every scrollable div in the main region and pick the best candidate.
    // We deliberately don't rely on role="row" — IG removed it in recent builds.
    const root =
      document.querySelector('[role="main"]') ||
      document.querySelector("main") ||
      document.body;

    const candidates = [];
    const divs = root.querySelectorAll("div");

    for (const el of divs) {
      // Skip elements that aren't visible (display:none parents will report 0 sizes)
      if (el.clientHeight === 0) continue;

      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (!["auto", "scroll", "overlay"].includes(overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;

      // Heuristic score: prefer taller containers with more media/text inside
      // (messages contain lots of images, anchors, and text spans).
      const inner = el.innerHTML.length;
      const score =
        el.clientHeight * 2 +
        (el.scrollHeight - el.clientHeight) +
        Math.min(inner / 100, 500);

      candidates.push({ el, score });
    }

    if (candidates.length === 0) {
      console.warn("[ig-exporter] No scrollable candidates found.");
      return null;
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0].el;
    console.log(
      `[ig-exporter] Auto-scroll container picked from ${candidates.length} candidates:`,
      winner,
      `(scrollHeight=${winner.scrollHeight}, clientHeight=${winner.clientHeight})`
    );
    return winner;
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
      threadTitles = event.data.titles || {};
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
        threadTitle: getActiveTitle(),
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
