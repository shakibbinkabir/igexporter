// src/bridge.js
//
// Content script on instagram.com. Drives the DM export UI (Start Capture /
// Auto-scroll / Export) by actively fetching the open thread through
// Instagram's private direct_v2 REST API.
//
// Why active fetch instead of interception: Instagram moved DM GraphQL traffic
// off the page's main thread into a worker / service worker, so a page-world
// window.fetch / XMLHttpRequest hook (the previous approach in interceptor.js)
// never saw the responses — the popup counted zero forever. The REST endpoints
// below are the same ones IG's own web client hits; a same-origin credentialed
// fetch from this content script carries the logged-in session cookie.
//
// The UI is unchanged: Start Capture loads the most recent page and lets the
// count grow as you scroll up (each scroll pulls the next older page); Auto-
// scroll keeps pulling older pages on its own until the thread runs out or you
// stop. Export packages whatever has been loaded — so you still control how
// much gets exported by how far you scroll.

(function () {
  const srcURL = chrome.runtime.getURL("src/");
  const APP_ID = "936619743392459"; // Instagram Web app id (see src/igapi.js)
  const PAGE = 20; // messages per fetch — mirrors IG's own scroll granularity

  // Export helpers load lazily on the first export so a slow/blocked module
  // import can never delay capture or status replies.
  let exportLib = null;
  async function getExportLib() {
    if (!exportLib) {
      const [{ normalize }, { validate }] = await Promise.all([
        import(srcURL + "normalizer.js"),
        import(srcURL + "schema.js"),
      ]);
      exportLib = { normalize, validate };
    }
    return exportLib;
  }

  /* ===== state ===== */
  const store = {
    urlId: null, // messaging_thread_key from /direct/t/<id>/
    threadId: null, // resolved direct_v2 thread_id (the long number)
    threadInfo: null, // { thread_id, thread_title, users, viewer_id, viewer_name }
    items: new Map(), // item_id -> raw direct_v2 item
    cursor: null, // pagination cursor for the next older page
    hasOlder: true, // is there more history to fetch?
    loadedFirst: false, // has the newest page been fetched yet?
  };

  let capturing = false;
  let fetching = false; // a page request is in flight

  const autoScroll = {
    active: false,
    timer: null,
    container: null,
    stallTicks: 0,
    lastCount: -1,
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getUrlId() {
    const m = window.location.pathname.match(/\/direct\/t\/([^\/]+)/);
    return m ? m[1] : null;
  }

  /* ===== REST client ===== */
  // GET an instagram.com JSON endpoint with IG's web headers, retrying on
  // transient throttling (429) and 5xx with exponential backoff.
  async function igFetch(path, tries = 4) {
    let lastErr = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      let res;
      try {
        res = await fetch(path, {
          method: "GET",
          credentials: "include",
          headers: {
            "x-ig-app-id": APP_ID,
            "x-requested-with": "XMLHttpRequest",
            Accept: "application/json",
          },
        });
      } catch (e) {
        lastErr = new Error("Network request failed.");
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(
          res.status === 429
            ? "Instagram is rate-limiting requests (429). Slow down and retry."
            : `Instagram server error (${res.status}).`
        );
        await sleep(1200 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("Not authorized — make sure you're logged in to Instagram in this browser.");
      }
      if (!res.ok) throw new Error(`Unexpected response (${res.status}).`);
      try {
        return await res.json();
      } catch {
        throw new Error("Instagram returned a non-JSON response.");
      }
    }
    throw lastErr || new Error("Request failed.");
  }

  // The /direct/t/<id>/ id is a messaging_thread_key, which the thread endpoint
  // won't accept — it needs the long numeric thread_id. Scan the inbox (the
  // open thread is almost always near the top, since the user just interacted
  // with it) to find the matching thread and the viewer's own identity.
  async function resolveThread(urlId) {
    let cursor = null;
    let viewer = null;
    for (let page = 0; page < 6; page++) {
      const qs = new URLSearchParams({
        visual_message_return_type: "unseen",
        persistentBadging: "true",
        limit: "20",
      });
      if (cursor) qs.set("cursor", cursor);
      const data = await igFetch(`/api/v1/direct_v2/inbox/?${qs.toString()}`);
      if (!viewer && data.viewer) viewer = data.viewer;

      const threads = data.inbox?.threads || [];
      for (const t of threads) {
        const ids = [
          t.thread_id,
          t.thread_v2_id,
          t.messaging_thread_key,
          ...(t.users || []).map((u) => u.interop_messaging_user_fbid),
        ]
          .filter(Boolean)
          .map(String);
        if (ids.includes(String(urlId))) return { thread: t, viewer };
      }

      cursor = data.inbox?.oldest_cursor || null;
      if (!cursor || !data.inbox?.has_older) break;
    }
    return { thread: null, viewer };
  }

  function usersOf(thread) {
    return (thread.users || []).map((u) => ({
      pk: u.pk,
      username: u.username,
      full_name: u.full_name,
    }));
  }

  function absorbThreadMeta(t) {
    // The thread endpoint carries fuller participant/viewer metadata than the
    // inbox preview; keep the richest we've seen.
    if (!store.threadInfo) return;
    if ((t.users || []).length) store.threadInfo.users = usersOf(t);
    if (t.thread_title) store.threadInfo.thread_title = t.thread_title;
    if (t.viewer_id) store.threadInfo.viewer_id = t.viewer_id;
  }

  // Approximate count of items that will survive normalization, so the popup's
  // live count tracks the export.
  function exportableCount() {
    let n = 0;
    const calls = new Set();
    for (const item of store.items.values()) {
      const t = item.item_type;
      if (t === "action_log" || t === "placeholder") continue;
      if (t === "video_call_event") {
        calls.add(item.video_call_event?.vc_id || item.item_id);
        continue;
      }
      n++;
    }
    return n + calls.size;
  }

  function titleForPopup() {
    const info = store.threadInfo;
    if (!info) return null;
    if (info.thread_title) return info.thread_title;
    const first = (info.users || [])[0];
    return first ? first.full_name || first.username : null;
  }

  /* ===== fetching ===== */
  // Fetch the most recent page and resolve the thread. Runs once per capture.
  async function loadNewest() {
    if (store.loadedFirst || fetching) return;
    fetching = true;
    try {
      const urlId = getUrlId();
      if (!urlId) throw new Error("Open a DM conversation (instagram.com/direct/t/...) first.");
      store.urlId = urlId;

      const { thread, viewer } = await resolveThread(urlId);
      if (!thread) {
        throw new Error("Couldn't find this conversation in your inbox. Open it fresh, then try again.");
      }
      store.threadId = thread.thread_id;
      store.threadInfo = {
        thread_id: thread.thread_id,
        thread_v2_id: thread.thread_v2_id,
        thread_title: thread.thread_title || null,
        users: usersOf(thread),
        viewer_id: thread.viewer_id || viewer?.pk || null,
        viewer_name: viewer ? viewer.full_name || viewer.username : null,
      };

      // Seed with the inbox preview's items, then fetch the newest full page.
      for (const it of thread.items || []) if (it.item_id) store.items.set(it.item_id, it);

      const data = await igFetch(`/api/v1/direct_v2/threads/${store.threadId}/?limit=${PAGE}`);
      const t = data.thread || {};
      for (const it of t.items || []) if (it.item_id) store.items.set(it.item_id, it);
      absorbThreadMeta(t);
      store.cursor = t.oldest_cursor || null;
      store.hasOlder = !!(t.has_older && store.cursor);
      store.loadedFirst = true;

      broadcastUpdate();
    } catch (err) {
      capturing = false;
      broadcastCaptureState(false);
      broadcastError(err?.message || String(err));
    } finally {
      fetching = false;
    }
  }

  // Fetch the next older page. Returns true if new messages were added.
  async function loadOlder() {
    if (fetching || !store.threadId || !store.hasOlder) return false;
    if (getUrlId() !== store.urlId) return false; // user switched threads
    fetching = true;
    const before = store.items.size;
    try {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (store.cursor) {
        qs.set("cursor", store.cursor);
        qs.set("direction", "older");
      }
      const data = await igFetch(`/api/v1/direct_v2/threads/${store.threadId}/?${qs.toString()}`);
      const t = data.thread || {};
      for (const it of t.items || []) if (it.item_id) store.items.set(it.item_id, it);
      absorbThreadMeta(t);
      store.cursor = t.oldest_cursor || null;
      store.hasOlder = !!(t.has_older && store.cursor);
      broadcastUpdate();
      return store.items.size > before;
    } catch (err) {
      broadcastError(err?.message || String(err));
      return false;
    } finally {
      fetching = false;
    }
  }

  /* ===== scroll container (for Auto-scroll's visual feedback) ===== */
  function findScrollContainer() {
    const root =
      document.querySelector('[role="main"]') ||
      document.querySelector("main") ||
      document.body;

    const candidates = [];
    for (const el of root.querySelectorAll("div")) {
      if (el.clientHeight === 0) continue;
      const overflowY = window.getComputedStyle(el).overflowY;
      if (!["auto", "scroll", "overlay"].includes(overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const score =
        el.clientHeight * 2 +
        (el.scrollHeight - el.clientHeight) +
        Math.min(el.innerHTML.length / 100, 500);
      candidates.push({ el, score });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  // IG's message list is flex-direction: column-reverse, so scrollTop=0 is the
  // visual BOTTOM (newest). A large negative value clamps to the visual top.
  function scrollToVisualTop(container) {
    container.scrollTop = -container.scrollHeight;
  }

  /* ===== scroll-driven loading (manual) ===== */
  // Loading follows the user's scroll: when capturing and not auto-scrolling,
  // a scroll gesture pulls the next older page. A capture-phase listener on the
  // document catches scroll events from the thread's inner scroller (scroll
  // doesn't bubble, but it does reach capture-phase listeners on ancestors).
  let scrollDebounce = null;
  function onDocumentScroll() {
    if (!capturing || autoScroll.active || fetching) return;
    if (!store.loadedFirst || !store.hasOlder) return;
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      if (capturing && !autoScroll.active) loadOlder();
    }, 250);
  }
  document.addEventListener("scroll", onDocumentScroll, true);

  /* ===== auto-scroll ===== */
  function announceAutoScroll(scrolling, reason) {
    chrome.runtime
      .sendMessage({ type: "IG_EXPORTER_AUTOSCROLL_STATE", scrolling, reason: reason || "" })
      .catch(() => {});
  }

  function stopAutoScroll(reason) {
    if (!autoScroll.active) return;
    autoScroll.active = false;
    clearTimeout(autoScroll.timer);
    autoScroll.timer = null;
    autoScroll.container = null;
    autoScroll.stallTicks = 0;
    autoScroll.lastCount = -1;
    announceAutoScroll(false, reason);
  }

  function startAutoScroll() {
    if (autoScroll.active) return { ok: true, alreadyRunning: true };
    if (!capturing) return { ok: false, reason: "Start capture first, then auto-scroll." };
    if (!store.hasOlder && store.loadedFirst) {
      return { ok: false, reason: "Already at the beginning of this thread." };
    }
    autoScroll.active = true;
    autoScroll.container = findScrollContainer();
    autoScroll.stallTicks = 0;
    autoScroll.lastCount = store.items.size; // track raw history progress
    announceAutoScroll(true);
    autoTick();
    return { ok: true };
  }

  const TICK_MS = 500;
  const MAX_STALL_TICKS = 6; // ~3s of no progress → give up

  async function autoTick() {
    if (!autoScroll.active) return;

    // Scroll the visible thread for familiar feedback (and to nudge IG's own
    // lazy-rendering); the actual data comes from the fetch below.
    if (autoScroll.container && autoScroll.container.isConnected) {
      scrollToVisualTop(autoScroll.container);
    } else {
      autoScroll.container = findScrollContainer();
    }

    // Wait for Start Capture's first-page resolve to finish before doing any
    // work — don't fetch or count stalls against a thread that isn't ready yet.
    if (!store.loadedFirst || fetching) {
      autoScroll.timer = setTimeout(autoTick, TICK_MS);
      return;
    }

    await loadOlder();

    if (!autoScroll.active) return; // stopped mid-fetch

    if (!store.hasOlder) {
      stopAutoScroll("reached beginning of thread");
      return;
    }

    // Stall detection uses raw item growth (not exportable count): a page of
    // only system rows still advances us through history, so it isn't a stall.
    if (store.items.size > autoScroll.lastCount) {
      autoScroll.lastCount = store.items.size;
      autoScroll.stallTicks = 0;
    } else if (++autoScroll.stallTicks >= MAX_STALL_TICKS) {
      stopAutoScroll("reached beginning of thread");
      return;
    }

    autoScroll.timer = setTimeout(autoTick, TICK_MS);
  }

  /* ===== capture toggle ===== */
  function setCapturing(on) {
    const was = capturing;
    capturing = !!on;
    if (!capturing && autoScroll.active) stopAutoScroll("capture stopped");
    broadcastCaptureState(capturing);
    if (capturing && !was) {
      // Surface the most recent page immediately (mirrors the old behavior of
      // showing whatever was already loaded, instead of a misleading 0).
      loadNewest();
    }
  }

  /* ===== messaging to popup ===== */
  function broadcastUpdate() {
    if (!capturing) return; // only stream while the popup expects updates
    chrome.runtime
      .sendMessage({
        type: "IG_EXPORTER_UPDATED",
        messageCount: exportableCount(),
        threadTitle: titleForPopup(),
      })
      .catch(() => {});
  }

  function broadcastCaptureState(on) {
    chrome.runtime.sendMessage({ type: "IG_EXPORTER_CAPTURE_STATE", capturing: on }).catch(() => {});
  }

  function broadcastError(error, problems) {
    chrome.runtime.sendMessage({ type: "IG_EXPORTER_ERROR", error, problems }).catch(() => {});
  }

  /* ===== export ===== */
  async function doExport() {
    if (store.items.size === 0) {
      broadcastError("No messages captured yet. Start capture, then scroll up to load history.");
      return;
    }
    try {
      const { normalize, validate } = await getExportLib();
      const result = normalize(store.threadInfo, [...store.items.values()]);
      const problems = validate(result);
      if (problems.length > 0) {
        broadcastError("Validation failed", problems);
      } else {
        chrome.runtime.sendMessage({ type: "IG_EXPORTER_SUCCESS", result }).catch(() => {});
      }
    } catch (err) {
      broadcastError("Couldn't build the export: " + (err?.message || err));
    }
  }

  // When the user switches to a different thread, drop the previous thread's
  // data so a later capture/export can't mix conversations.
  function resetIfThreadChanged() {
    const urlId = getUrlId();
    if (urlId && urlId !== store.urlId) {
      store.urlId = urlId;
      store.threadId = null;
      store.threadInfo = null;
      store.items.clear();
      store.cursor = null;
      store.hasOlder = true;
      store.loadedFirst = false;
    }
  }

  /* ===== popup commands ===== */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "GET_STATUS") {
      resetIfThreadChanged();
      sendResponse({
        messageCount: exportableCount(),
        threadTitle: titleForPopup(),
        autoScrolling: autoScroll.active,
        capturing,
      });
      return true;
    }

    if (message.action === "CAPTURE_START") {
      resetIfThreadChanged();
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
      sendResponse(startAutoScroll());
      return true;
    }

    if (message.action === "AUTOSCROLL_STOP") {
      stopAutoScroll("manual");
      sendResponse({ ok: true });
      return true;
    }

    if (message.action === "EXPORT_REQUEST") {
      doExport();
      return;
    }
  });

  window.addEventListener("beforeunload", () => stopAutoScroll("page unload"));
})();
