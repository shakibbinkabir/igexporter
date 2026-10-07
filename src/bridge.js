// src/bridge.js
//
// Content script on instagram.com. Drives the DM export UI (Start Capture /
// Auto-scroll / Export) by actively fetching the open thread through the same
// persisted GraphQL queries Instagram's own web client runs.
//
// Why active fetch instead of interception: Instagram loads DM history off the
// page's main thread, so a page-world window.fetch / XMLHttpRequest hook (the
// original approach in interceptor.js) never saw the responses — the popup
// counted zero forever. The direct_v2 REST endpoints this script used after
// that (/api/v1/direct_v2/inbox/ and threads/<id>/) are gone from the web:
// they answer 404 now.
//
// These queries are NOT public and Instagram rotates the doc ids every so
// often. When capture starts failing with a GraphQL error, open a DM thread on
// instagram.com and run require("<query name>.graphql").params.id in the
// DevTools console for the two query names below, then paste the new ids here.
//
// The UI is unchanged: Start Capture loads the most recent page and lets the
// count grow as you scroll up (each scroll pulls the next older page); Auto-
// scroll keeps pulling older pages on its own until the thread runs out or you
// stop. Export packages whatever has been loaded — so you still control how
// much gets exported by how far you scroll.

(function () {
  const srcURL = chrome.runtime.getURL("src/");
  const APP_ID = "936619743392459"; // Instagram Web app id (see src/igapi.js)
  const PAGE = 20; // messages per fetch — the server caps a page at 20
  const DOC_THREAD = "28784987187762419"; // IGDInboxHeaderOffMsysQuery: title + participants
  const DOC_MESSAGES = "28742488222105007"; // IGDMessageListOffMsysQuery: paged history
  const PAGE_VAR = "__relay_internal__pv__IGDInitialMessagePageCountrelayprovider";

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
    urlId: null, // thread key from /direct/t/<id>/ — the queries take it as-is
    threadInfo: null, // { thread_id, thread_title, users, viewer_fbid }
    items: new Map(), // message_id -> raw SlideMessage node
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

  /* ===== GraphQL client ===== */
  // /api/graphql only answers with the session's fb_dtsg CSRF token, which
  // Instagram embeds in every page's HTML. Fetched once per page load.
  let dtsg = null;
  async function getDtsg() {
    if (dtsg) return dtsg;
    let html;
    try {
      const res = await fetch("/direct/inbox/", { credentials: "include", signal: AbortSignal.timeout(20000) });
      html = await res.text();
    } catch {
      throw new Error("Network request failed.");
    }
    dtsg = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] || null;
    if (!dtsg) throw new Error("Not authorized — make sure you're logged in to Instagram in this browser.");
    return dtsg;
  }

  // Run one of Instagram's persisted queries and return its `data`, retrying
  // on transient throttling (429) and 5xx with exponential backoff.
  async function gql(docId, variables, tries = 4) {
    const body = new URLSearchParams({
      fb_dtsg: await getDtsg(),
      doc_id: docId,
      variables: JSON.stringify(variables),
    });
    let lastErr = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      let res;
      try {
        res = await fetch("/api/graphql", {
          method: "POST",
          credentials: "include",
          // A stalled request would otherwise hang capture forever.
          signal: AbortSignal.timeout(20000),
          headers: { "x-ig-app-id": APP_ID },
          body,
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
      let json;
      try {
        json = await res.json();
      } catch {
        dtsg = null; // a rejected token gets the HTML app shell back — refetch next time
        throw new Error("Instagram returned a non-JSON response.");
      }
      if (!json.data) {
        throw new Error(`Instagram GraphQL error: ${json.errors?.[0]?.message || "no data"}`);
      }
      return json.data;
    }
    throw lastErr || new Error("Request failed.");
  }

  // Approximate count of items that will survive normalization, so the popup's
  // live count tracks the export.
  function exportableCount() {
    let n = 0;
    let afterEnd = false; // the previous (newer) call notice was an "ended"/"missed" one
    for (const node of store.items.values()) {
      const c = node.content || {};
      if (c.__typename === "SlideMessageAdminText") {
        // System rows are dropped, except call notices. The normalizer folds a
        // call's two notices into one message: the store runs newest first, so
        // a "started" notice right after an "ended"/"missed" one is that fold.
        if (!/CALL/.test(node.content_type || "")) continue;
        const text = (c.text_fragments || []).map((f) => f.plaintext || "").join("");
        const start = /started/i.test(text);
        if (!(start && afterEnd)) n++;
        afterEnd = !start && /ended|missed/i.test(text);
        continue;
      }
      // Placeholders for shares that are no longer available are dropped too.
      if (/Placeholder/.test(c.xma?.__typename || "") && !node.text_body) continue;
      n++;
    }
    return n;
  }

  function titleForPopup() {
    const info = store.threadInfo;
    if (!info) return null;
    if (info.thread_title) return info.thread_title;
    const first = (info.users || [])[0];
    return first ? first.full_name || first.username : null;
  }

  /* ===== fetching ===== */
  // Fetch one page of history into the store: the newest page while there's no
  // cursor yet, the next older one after that.
  async function fetchPage() {
    const urlId = store.urlId;
    const data = await gql(DOC_MESSAGES, { id: urlId, after: store.cursor, [PAGE_VAR]: PAGE });
    if (urlId !== store.urlId) return; // switched threads mid-request — not this thread's page
    const conn = data.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;
    for (const { node } of conn?.edges || []) {
      if (node?.message_id) store.items.set(node.message_id, node);
    }
    store.cursor = conn?.page_info?.end_cursor || null;
    store.hasOlder = !!(conn?.page_info?.has_next_page && store.cursor);
  }

  // Load the thread's metadata and its most recent page. Runs once per capture.
  async function loadNewest() {
    if (store.loadedFirst || fetching) return;
    fetching = true;
    try {
      const urlId = getUrlId();
      if (!urlId) throw new Error("Open a DM conversation (instagram.com/direct/t/...) first.");
      store.urlId = urlId;

      const head = await gql(DOC_THREAD, { thread_fbid: urlId });
      if (urlId !== store.urlId) return; // switched threads mid-request
      const thread = head.get_slide_thread_nullable?.as_ig_direct_thread;
      if (!thread) {
        throw new Error("Couldn't load this conversation. Open it fresh, then try again.");
      }
      store.threadInfo = {
        thread_id: thread.thread_fbid,
        thread_title: thread.thread_title || null,
        users: (thread.users || []).map((u) => ({
          fbid: u.interop_messaging_user_fbid,
          username: u.username,
          full_name: u.full_name,
        })),
        viewer_fbid: thread.viewer?.interop_messaging_user_fbid || null,
      };

      await fetchPage();
      if (urlId !== store.urlId) return;
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
    if (fetching || !store.loadedFirst || !store.hasOlder) return false;
    if (getUrlId() !== store.urlId) return false; // user switched threads
    fetching = true;
    const before = store.items.size;
    try {
      await fetchPage();
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
    if (!capturing || autoScroll.active) return;
    resetIfThreadChanged(); // capture follows the user into another thread
    if (fetching || !store.loadedFirst || !store.hasOlder) return;
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
  // data so a later capture/export can't mix conversations. Capture stays on
  // across the switch, so start over on the new thread — otherwise nothing
  // would load until capture was stopped and started again.
  function resetIfThreadChanged() {
    const urlId = getUrlId();
    if (urlId && urlId !== store.urlId) {
      store.urlId = urlId;
      store.threadInfo = null;
      store.items.clear();
      store.cursor = null;
      store.hasOlder = true;
      store.loadedFirst = false;
      fetching = false; // a request still in flight belongs to the old thread
      if (capturing) loadNewest();
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
