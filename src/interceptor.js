// src/interceptor.js
(function() {
  const OriginalXHR = window.XMLHttpRequest;

  window._igExporterStore = window._igExporterStore || {
    threads: new Map(), // thread_key or thread_id -> { threadInfo, messages: Map() }
    aliases: new Map(), // alias id -> canonical id
    latestUpdatedId: null
  };

  /* ===== Exportable filter (mirrors normalizer.js logic) ===== */
  function getXmaMediaUrl(xma) {
    return (
      xma?.preview_image?.url ||
      xma?.preview_image?.fallback_url ||
      xma?.xmaPreviewImage?.url ||
      xma?.xmaPreviewImage?.fallback_url ||
      null
    );
  }
  function getMediaUrlFromNode(node) {
    return (
      getXmaMediaUrl(node.content?.xma) ||
      node.content?.preview_image?.url ||
      node.content?.preview_image?.fallback_url ||
      node.content?.image?.url ||
      node.content?.image?.uri ||
      node.content?.image_versions2?.candidates?.[0]?.url ||
      node.media?.image_versions2?.candidates?.[0]?.url ||
      node.media?.video_versions?.[0]?.url ||
      node.media?.audio?.url ||
      null
    );
  }
  function isExportable(node) {
    if (!node) return false;
    const ct = node.content_type;
    if (ct === 'REACTION_LOG_XMAT' || ct === 'ACTION_LOG' || ct === 'IgDirectThreadActionLogXPItem') {
      return false;
    }
    if ((typeof node.text_body === 'string' && node.text_body.trim()) ||
        (typeof node.igd_snippet === 'string' && node.igd_snippet.trim())) {
      return true;
    }
    if (Array.isArray(node.reactions) && node.reactions.length > 0) return true;
    if (ct === 'AUDIOS') return true; // normalizer falls back to a placeholder uri
    if (ct === 'MESSAGE_INLINE_SHARE' || ct === 'MONTAGE_SHARE_XMA') return true;
    if (ct === 'IMAGES' || ct === 'VIDEOS') return getMediaUrlFromNode(node) !== null;
    return false;
  }

  function getOrInitThread(id) {
    if (!id) return null;
    if (!window._igExporterStore.threads.has(id)) {
      window._igExporterStore.threads.set(id, {
        threadInfo: null,
        messages: new Map()
      });
    }
    return window._igExporterStore.threads.get(id);
  }

  function getCanonicalId(id) {
    if (!id) return null;
    return window._igExporterStore.aliases.get(id) || id;
  }

  function setAlias(id, canonical) {
    if (!id || !canonical) return;
    window._igExporterStore.aliases.set(id, canonical);
  }

  function getOrInitCanonical(ids, preferredId) {
    const candidates = (ids || []).filter(Boolean);
    let canonical = preferredId || null;

    if (!canonical) {
      for (const id of candidates) {
        const mapped = getCanonicalId(id);
        if (mapped) {
          canonical = mapped;
          break;
        }
      }
    }

    if (!canonical && candidates.length > 0) canonical = candidates[0];
    if (!canonical) return null;

    const canonicalStore = getOrInitThread(canonical);

    for (const id of candidates) {
      const mapped = getCanonicalId(id);
      if (mapped && mapped !== canonical && window._igExporterStore.threads.has(mapped)) {
        const other = window._igExporterStore.threads.get(mapped);
        if (other) {
          if (!canonicalStore.threadInfo && other.threadInfo) {
            canonicalStore.threadInfo = other.threadInfo;
          }
          for (const [k, v] of other.messages.entries()) {
            canonicalStore.messages.set(k, v);
          }
        }
        window._igExporterStore.threads.delete(mapped);
      }
      setAlias(id, canonical);
    }

    setAlias(canonical, canonical);
    return canonicalStore;
  }

  function tryParseJSON(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^for\s*\(;;\);\s*/, '');
    cleaned = cleaned.replace(/^\)\]\}',?\s*/, '');
    cleaned = cleaned.replace(/^while\s*\(1\);\s*/, '');
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      return null;
    }
  }

  function collectThreads(root) {
    const results = [];
    const visited = new Set();
    const stack = [root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (visited.has(node)) continue;
      visited.add(node);

      if (node.slide_messages?.edges && (node.thread_id || node.thread_key || node.thread_fbid || node.id)) {
        results.push(node);
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          stack.push(item);
        }
      } else {
        for (const value of Object.values(node)) {
          stack.push(value);
        }
      }
    }

    return results;
  }

  function processGraphQLResponse(payload) {
    // Always parse and store. The bridge decides whether to forward updates
    // to the popup — that way, clicking "Start Capture" can immediately show
    // any messages that Instagram already loaded before the user opened the
    // popup, instead of waiting for the next scroll to trigger a new fetch.
    const data = typeof payload === 'string' ? tryParseJSON(payload) : payload;
    if (!data || typeof data !== 'object') return;

    const threadsToProcess = collectThreads(data);

    for (const thread of threadsToProcess) {
      const edges = thread.slide_messages?.edges || [];
      const edgeThreadId = edges.find(e => e?.node?.thread_fbid)?.node?.thread_fbid;
      const idCandidates = [
        thread.thread_id,
        thread.thread_key,
        thread.thread_fbid,
        thread.id,
        edgeThreadId
      ].filter(Boolean);

      if (idCandidates.length === 0) continue;

      let preferredId = thread.thread_id;
      if (!preferredId) {
        for (const id of idCandidates) {
          const mapped = getCanonicalId(id);
          if (mapped) {
            preferredId = mapped;
            break;
          }
        }
      }

      const store = getOrInitCanonical(idCandidates, preferredId);
      if (!store) continue;

      const hasThreadInfo = !!(
        thread.thread_title ||
        (Array.isArray(thread.users) && thread.users.length > 0) ||
        thread.viewer ||
        thread.viewer_id
      );

      if (hasThreadInfo) {
        const threadInfo = {
          thread_id: thread.thread_id,
          thread_key: thread.thread_key,
          thread_title: thread.thread_title,
          users: thread.users,
          viewer: thread.viewer,
          viewer_id: thread.viewer_id
        };

        if (!store.threadInfo || thread.thread_title) {
          store.threadInfo = threadInfo;
        }
      }

      if (edges.length > 0) {
        for (const edge of edges) {
          if (!edge?.node) continue;
          const id = edge.node.id || edge.node.message_id;
          if (!id) continue;
          store.messages.set(id, edge.node);
        }
      }

      window._igExporterStore.latestUpdatedId = getCanonicalId(idCandidates[0]);
    }

    if (threadsToProcess.length > 0) {
      const threadCounts = {};
      const threadTitles = {};

      function titleFor(store) {
        const info = store?.threadInfo;
        if (!info) return null;
        if (info.thread_title) return info.thread_title;
        const users = info.users || [];
        for (const u of users) {
          const name = u.full_name || u.username;
          if (name) return name;
        }
        return null;
      }

      function exportableCount(store) {
        let n = 0;
        for (const msg of store.messages.values()) {
          if (isExportable(msg)) n++;
        }
        return n;
      }

      for (const [key, store] of window._igExporterStore.threads.entries()) {
        threadCounts[key] = exportableCount(store);
        const t = titleFor(store);
        if (t) threadTitles[key] = t;
      }

      for (const [alias, canonical] of window._igExporterStore.aliases.entries()) {
        const store = window._igExporterStore.threads.get(canonical);
        if (store) {
          threadCounts[alias] = exportableCount(store);
          const t = titleFor(store);
          if (t) threadTitles[alias] = t;
        }
      }

      window.postMessage({
        type: 'IG_EXPORTER_UPDATED',
        counts: threadCounts,
        titles: threadTitles,
        latestId: window._igExporterStore.latestUpdatedId
      }, '*');
    }
  }

  function interceptXHR() {
    window.XMLHttpRequest = class InterceptedXHR extends OriginalXHR {
      open(method, url, ...args) {
        this._interceptedUrl = url;
        super.open(method, url, ...args);
      }
      
      send(body) {
        this.addEventListener('load', () => {
          if (this._interceptedUrl && (this._interceptedUrl.includes('/api/graphql') || this._interceptedUrl.includes('/graphql/query'))) {
            let payload = null;
            if (this.responseType && this.responseType !== 'text') {
              payload = this.response;
            } else {
              payload = this.responseText;
            }
            processGraphQLResponse(payload);
          }
        });
        super.send(body);
      }
    };
  }

  function interceptFetch() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      
      if (url.includes('/api/graphql') || url.includes('/graphql/query')) {
        // We clone the response to read it natively without consuming the original stream
        response.clone().text().then(text => processGraphQLResponse(text)).catch(() => {});
      }
      return response;
    };
  }

  interceptXHR();
  interceptFetch();
  console.log('[ig-exporter] Interceptor installed.');

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;

    if (event.data?.type === 'IG_EXPORTER_GET_STORE') {
      const activeId = event.data.activeId || window._igExporterStore.latestUpdatedId;
      const canonicalId = getCanonicalId(activeId) || getCanonicalId(window._igExporterStore.latestUpdatedId) || activeId;
      let store = window._igExporterStore.threads.get(canonicalId);

      if (!store && activeId) {
        store = window._igExporterStore.threads.get(activeId);
      }

      if (!store && window._igExporterStore.threads.size > 0) {
        let best = null;
        for (const candidate of window._igExporterStore.threads.values()) {
          if (!best || candidate.messages.size > best.messages.size) best = candidate;
        }
        store = best;
      }
      
      const messagesObj = {};
      if (store) {
        for (const [k, v] of store.messages.entries()) {
          messagesObj[k] = v;
        }
      }
      
      window.postMessage({
        type: 'IG_EXPORTER_STORE_RESPONSE',
        threadInfo: store ? store.threadInfo : null,
        messages: messagesObj
      }, '*');
    }
  });

  window.getExportData = function(activeId) {
    window.postMessage({ type: 'IG_EXPORTER_GET_STORE', activeId: activeId }, '*');
  };
})();
