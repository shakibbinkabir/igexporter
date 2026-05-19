// src/bridge.js
(async function() {
  const srcURL = chrome.runtime.getURL('src/');
  const { normalize } = await import(srcURL + 'normalizer.js');
  const { validate } = await import(srcURL + 'schema.js');

  // Inject interceptor
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/interceptor.js');
  (document.head || document.documentElement).appendChild(script);

  let threadCounts = {};

  function getActiveId() {
    const match = window.location.pathname.match(/\/direct\/t\/([^\/]+)/);
    return match ? match[1] : null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'IG_EXPORTER_UPDATED') {
      threadCounts = event.data.counts || {};
      const activeId = getActiveId() || event.data.latestId;
      const count = threadCounts[activeId] || 0;
      console.log(`[ig-exporter] Captured ${count} messages so far for thread ${activeId}.`);
      chrome.runtime.sendMessage({ type: 'IG_EXPORTER_UPDATED', messageCount: count }).catch(() => {});
    }

    if (event.data?.type === 'IG_EXPORTER_STORE_RESPONSE') {
      const store = event.data;
      if (!store.threadInfo) {
        const error = 'No thread data captured yet. Open a thread and scroll.';
        console.error(`[ig-exporter] ${error}`);
        chrome.runtime.sendMessage({ type: 'IG_EXPORTER_ERROR', error });
        return;
      }
      
      const result = normalize(store.threadInfo, store.messages);
      const problems = validate(result);
      
      if (problems.length > 0) {
        console.error('[ig-exporter] Export data structure invalid:', problems);
        chrome.runtime.sendMessage({ type: 'IG_EXPORTER_ERROR', error: 'Validation failed', problems });
      } else {
        console.log('[ig-exporter] Export valid! Validation passed.');
        chrome.runtime.sendMessage({ type: 'IG_EXPORTER_SUCCESS', result });
      }
      
      console.log(result);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EXPORT_REQUEST') {
      window.postMessage({ type: 'IG_EXPORTER_GET_STORE', activeId: getActiveId() }, '*');
    } else if (message.action === 'GET_STATUS') {
      const activeId = getActiveId();
      let count = 0;
      if (activeId && threadCounts[activeId]) {
        count = threadCounts[activeId];
      } else if (Object.keys(threadCounts).length > 0 && !activeId) {
         // Fallback to highest count if we can't parse URL
         count = Math.max(...Object.values(threadCounts));
      }
      sendResponse({ messageCount: count });
    }
  });
})();
