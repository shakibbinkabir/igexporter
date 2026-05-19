// popup.js
document.addEventListener("DOMContentLoaded", async () => {
  const statusText = document.getElementById("statusText");
  const msgCount = document.getElementById("msgCount");
  const exportBtn = document.getElementById("exportBtn");
  const errorDiv = document.getElementById("error");

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.style.display = "block";
    statusText.textContent = "Error";
    exportBtn.disabled = true;
  }

  // Find active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url.includes("instagram.com")) {
      showError("Please open an Instagram DM thread.");
      return;
    }
    statusText.textContent = "Ready. Scroll up to load messages.";

    // Sync current status with the content script
    chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Could not connect to content script:", chrome.runtime.lastError.message);
        return;
      }
      if (response && response.messageCount !== undefined) {
        msgCount.textContent = response.messageCount;
        if (response.messageCount > 0) {
          statusText.textContent = "Capturing...";
          exportBtn.disabled = false;
        }
      }
    });
  });

  // Listen for messages from bridge.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "IG_EXPORTER_UPDATED") {
      statusText.textContent = "Capturing...";
      msgCount.textContent = message.messageCount;
      if (message.messageCount > 0) {
        exportBtn.disabled = false;
        exportBtn.textContent = "Export JSON";
      }
    }
    
    if (message.type === "IG_EXPORTER_ERROR") {
      showError(message.error + (message.problems ? "\n" + message.problems.join("\n") : ""));
      exportBtn.disabled = false;
      exportBtn.textContent = "Retry Export";
    }

    if (message.type === "IG_EXPORTER_SUCCESS") {
      const data = message.result;
      const safeTitle = (data.title || "thread").replace(/[^a-z0-9_-]/gi, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `instagram_${safeTitle}_${timestamp}.json`;
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          showError("Export failed: " + chrome.runtime.lastError.message);
          exportBtn.disabled = false;
          exportBtn.textContent = "Retry Export";
          return;
        }
        statusText.textContent = "Export complete!";
        exportBtn.disabled = false;
        exportBtn.textContent = "Export JSON";
      });
    }
  });

  exportBtn.addEventListener("click", () => {
    exportBtn.disabled = true;
    exportBtn.textContent = "Validating & Formatting...";
    errorDiv.style.display = "none";
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "EXPORT_REQUEST" });
      }
    });
  });
});
