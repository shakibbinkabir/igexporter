document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const newBtn = document.getElementById('newBtn');
  const statusEl = document.getElementById('status');
  const chatInfoEl = document.getElementById('chatInfo');
  const chatNameEl = document.getElementById('chatName');
  const messageCountEl = document.getElementById('messageCount');

  let isRecording = false;
  let recordingTabId = null;
  let captureInterval = null;

  function setStatus(message, type = 'normal') {
    statusEl.className = 'status' + (type !== 'normal' ? ' ' + type : '');
    if (type === 'recording') {
      statusEl.innerHTML = `<span class="recording-indicator"></span><span class="status-text">${message}</span>`;
    } else {
      statusEl.innerHTML = `<span class="status-text">${message}</span>`;
    }
  }

  function showChatInfo(name, count) {
    chatInfoEl.classList.remove('hidden');
    chatNameEl.textContent = name || '-';
    messageCountEl.textContent = count;
  }

  function hideChatInfo() {
    chatInfoEl.classList.add('hidden');
  }

  function showButtons(start, stop, newRec) {
    startBtn.classList.toggle('hidden', !start);
    stopBtn.classList.toggle('hidden', !stop);
    newBtn.classList.toggle('hidden', !newRec);
  }

  async function checkPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url || !tab.url.includes('instagram.com/direct')) {
        setStatus('Please open an Instagram chat first', 'error');
        startBtn.disabled = true;
        return null;
      }
      startBtn.disabled = false;
      return tab;
    } catch (error) {
      setStatus('Error checking page', 'error');
      return null;
    }
  }

  // Initialize
  checkPage();

  // START RECORDING
  startBtn.addEventListener('click', async () => {
    const tab = await checkPage();
    if (!tab) return;

    recordingTabId = tab.id;

    // Inject the recording script
    await chrome.scripting.executeScript({
      target: { tabId: recordingTabId },
      func: startRecordingOnPage
    });

    isRecording = true;
    setStatus('Recording... Scroll through the chat now!', 'recording');
    showButtons(false, true, false);
    showChatInfo('-', '0');

    // Start polling for message count updates
    captureInterval = setInterval(async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: recordingTabId },
          func: getRecordingStatus
        });

        if (results && results[0] && results[0].result) {
          const { messageCount, chatName } = results[0].result;
          showChatInfo(chatName, messageCount);
        }
      } catch (e) {
        // Tab might be closed
        console.error('Error getting status:', e);
      }
    }, 500);
  });

  // STOP RECORDING & EXPORT
  stopBtn.addEventListener('click', async () => {
    if (!recordingTabId) return;

    // Stop polling
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }

    setStatus('Processing messages...', 'normal');

    try {
      // Get all captured messages
      const results = await chrome.scripting.executeScript({
        target: { tabId: recordingTabId },
        func: stopRecordingAndGetMessages
      });

      if (results && results[0] && results[0].result) {
        const data = results[0].result;

        if (data.error) {
          setStatus(data.error, 'error');
          showButtons(true, false, false);
          return;
        }

        showChatInfo(data.chatName, data.messages.length);

        // Create export data
        const exportData = {
          exportDate: new Date().toISOString(),
          chatName: data.chatName,
          participants: data.participants,
          messageCount: data.messages.length,
          messages: data.messages
        };

        // Download JSON
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const filename = `instagram_chat_${data.chatName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;

        await chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: true
        });

        setStatus(`Exported ${data.messages.length} messages!`, 'success');
        showButtons(false, false, true);

      } else {
        setStatus('No messages captured', 'error');
        showButtons(true, false, false);
      }

    } catch (error) {
      console.error('Export error:', error);
      setStatus('Error: ' + error.message, 'error');
      showButtons(true, false, false);
    }

    isRecording = false;
    recordingTabId = null;
  });

  // NEW RECORDING
  newBtn.addEventListener('click', () => {
    setStatus('Ready to record', 'normal');
    hideChatInfo();
    showButtons(true, false, false);
    checkPage();
  });
});

// ============================================
// FUNCTIONS THAT RUN ON THE INSTAGRAM PAGE
// ============================================

function startRecordingOnPage() {
  // Initialize global storage for messages
  window.__igExporter = {
    messages: new Map(),
    chatName: 'Unknown',
    isRecording: true,
    currentDateContext: null  // Track the current date context from separators
  };

  // Try to get chat name from page header
  function getChatName() {
    // Skip these common navigation/UI elements
    const skipNames = ['Instagram', 'Direct', 'Messages', 'Active', 'Follow', 'Following',
                       'Message', 'Home', 'Search', 'Explore', 'Reels', 'Create', 'Profile',
                       'More', 'Settings', 'Threads', 'Notes', 'Requests'];

    // Method 1: Look at page title first (most reliable)
    const title = document.title;
    if (title && title.includes('Instagram')) {
      // Title format is usually "Name • Instagram" or "(1) Name • Instagram"
      const match = title.match(/^(?:\(\d+\)\s*)?(.+?)\s*[•·]\s*Instagram/);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name && !skipNames.includes(name) && name !== 'Direct') {
          return name;
        }
      }
    }

    // Method 2: Look for profile link in the chat header area
    const headerLinks = document.querySelectorAll('a[role="link"]');
    for (const link of headerLinks) {
      const href = link.getAttribute('href') || '';
      // Profile links have format /username/ (not /direct/, /explore/, etc.)
      if (href.match(/^\/[a-zA-Z0-9_.]+\/?$/) && !href.includes('/direct')) {
        const spans = link.querySelectorAll('span');
        for (const span of spans) {
          const name = span.textContent?.trim();
          if (name && name.length > 0 && name.length < 50 && !skipNames.includes(name)) {
            return name;
          }
        }
      }
    }

    return 'Unknown';
  }

  // Function to parse relative time strings into approximate timestamps
  function parseRelativeTime(timeStr) {
    if (!timeStr) return null;

    const now = new Date();
    const str = timeStr.toLowerCase().trim();

    // Match patterns like "56m", "2h", "3d", "1w"
    const relativeMatch = str.match(/^(\d+)\s*(m|min|h|hr|hour|d|day|w|week)s?$/i);
    if (relativeMatch) {
      const num = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2].charAt(0).toLowerCase();
      const date = new Date(now);

      switch (unit) {
        case 'm': date.setMinutes(date.getMinutes() - num); break;
        case 'h': date.setHours(date.getHours() - num); break;
        case 'd': date.setDate(date.getDate() - num); break;
        case 'w': date.setDate(date.getDate() - (num * 7)); break;
      }
      return date.toISOString();
    }

    // Match "Yesterday"
    if (str.includes('yesterday')) {
      const date = new Date(now);
      date.setDate(date.getDate() - 1);
      return date.toISOString().split('T')[0];
    }

    // Match day names like "Monday", "Tuesday", etc.
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayIndex = days.findIndex(d => str.includes(d));
    if (dayIndex !== -1) {
      const date = new Date(now);
      const currentDay = date.getDay();
      let daysAgo = currentDay - dayIndex;
      if (daysAgo <= 0) daysAgo += 7;
      date.setDate(date.getDate() - daysAgo);
      return date.toISOString().split('T')[0];
    }

    // Match date formats like "Jan 15", "January 15", "15 Jan", etc.
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    for (let i = 0; i < months.length; i++) {
      if (str.includes(months[i])) {
        const dayMatch = str.match(/\d+/);
        if (dayMatch) {
          const date = new Date(now.getFullYear(), i, parseInt(dayMatch[0]));
          // If the date is in the future, it's probably last year
          if (date > now) date.setFullYear(date.getFullYear() - 1);
          return date.toISOString().split('T')[0];
        }
      }
    }

    // Match time formats like "10:30 AM", "2:45 PM"
    const timeMatch = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const period = timeMatch[3]?.toLowerCase();

      if (period === 'pm' && hours !== 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;

      const date = new Date(now);
      date.setHours(hours, minutes, 0, 0);
      return date.toISOString();
    }

    return timeStr; // Return original if can't parse
  }

  // Function to find timestamp near a message element
  function findTimestampForMessage(messageDiv) {
    // Look for time elements in parent containers
    let parent = messageDiv.parentElement;
    let depth = 0;

    while (parent && depth < 10) {
      // Look for time element
      const timeEl = parent.querySelector('time');
      if (timeEl) {
        return timeEl.getAttribute('datetime') || timeEl.textContent;
      }

      // Look for elements with datetime attribute
      const dateTimeEl = parent.querySelector('[datetime]');
      if (dateTimeEl) {
        return dateTimeEl.getAttribute('datetime');
      }

      // Look for common timestamp patterns in siblings or nearby elements
      const allText = parent.textContent || '';
      const timePatterns = [
        /\d{1,2}:\d{2}\s*(AM|PM|am|pm)/,
        /\d{1,2}:\d{2}/,
        /(\d+)\s*(m|h|d|w)\s+ago/i,
        /yesterday/i,
        /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
      ];

      for (const pattern of timePatterns) {
        const match = allText.match(pattern);
        if (match) {
          return match[0];
        }
      }

      parent = parent.parentElement;
      depth++;
    }

    return null;
  }

  // Function to capture visible messages using div[dir="auto"]
  function captureMessages() {
    if (!window.__igExporter || !window.__igExporter.isRecording) return;

    // Get chat name if not already set
    if (window.__igExporter.chatName === 'Unknown') {
      window.__igExporter.chatName = getChatName();
    }

    // First, look for date separators to establish context
    // Instagram often shows dates like "Yesterday", "Friday", "Jan 15" as separators
    const allDivs = document.querySelectorAll('div[dir="auto"]');
    const dateSeparatorPatterns = [
      /^(yesterday|today)$/i,
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i,
      /^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
      /^\d{1,2}\/\d{1,2}\/\d{2,4}$/
    ];

    // Use div[dir="auto"] to find message text elements
    const messageDivs = document.querySelectorAll('div[dir="auto"]');

    messageDivs.forEach((div) => {
      const content = div.textContent?.trim() || '';

      // Skip empty or very short content
      if (!content || content.length < 1) return;

      // Check if this is a date separator
      for (const pattern of dateSeparatorPatterns) {
        if (pattern.test(content)) {
          window.__igExporter.currentDateContext = parseRelativeTime(content);
          return; // Don't add date separators as messages
        }
      }

      // Skip UI elements
      const skipTexts = ['Send', 'Like', 'Message', 'Messages', 'Active', 'Seen', 'Delivered',
        'Type a message', 'Search', 'GIF', 'Voice message', 'Mute', 'Delete', 'Reply', 'Unsend',
        'Enter', 'Translate', 'See translation', 'Aa', 'Instagram', 'Direct', 'Note to self'];
      if (skipTexts.includes(content)) return;
      if (content.startsWith('http')) return;
      if (content.includes('React to message from')) return;
      if (content.includes('Reply to message from')) return;

      // Determine sender by x-position
      // Right side (x > 550) = You, Left side (x <= 550) = Other person
      const rect = div.getBoundingClientRect();
      const isYourMessage = rect.x > 550;
      const sender = isYourMessage ? 'You' : window.__igExporter.chatName;

      // Try to find timestamp for this message
      const foundTimestamp = findTimestampForMessage(div);
      const timestamp = foundTimestamp ? parseRelativeTime(foundTimestamp) : window.__igExporter.currentDateContext;

      // Use ONLY content as key to prevent duplicates from position changes during scroll
      // First capture wins - the sender is determined by position when first seen
      const contentKey = content;

      if (!window.__igExporter.messages.has(contentKey)) {
        window.__igExporter.messages.set(contentKey, {
          sender: sender !== 'Unknown' ? sender : 'Other',
          content: content,
          timestamp: timestamp,
          capturedAt: Date.now()
        });
      }
    });
  }

  // Capture immediately
  captureMessages();

  // Set up interval to capture continuously while scrolling
  window.__igExporter.intervalId = setInterval(captureMessages, 200);

  // Also capture on scroll events
  const mainArea = document.querySelector('[role="main"]');
  if (mainArea) {
    window.__igExporter.scrollHandler = () => captureMessages();
    mainArea.addEventListener('scroll', window.__igExporter.scrollHandler, true);
  }

  console.log('Instagram Chat Exporter: Recording started');
}

function getRecordingStatus() {
  if (!window.__igExporter) {
    return { messageCount: 0, chatName: 'Unknown' };
  }
  return {
    messageCount: window.__igExporter.messages.size,
    chatName: window.__igExporter.chatName
  };
}

function stopRecordingAndGetMessages() {
  if (!window.__igExporter) {
    return { error: 'Recording not started' };
  }

  // Stop recording
  window.__igExporter.isRecording = false;

  // Clear interval
  if (window.__igExporter.intervalId) {
    clearInterval(window.__igExporter.intervalId);
  }

  // Remove scroll listener
  const mainArea = document.querySelector('[role="main"]');
  if (mainArea && window.__igExporter.scrollHandler) {
    mainArea.removeEventListener('scroll', window.__igExporter.scrollHandler, true);
  }

  // Convert messages to array
  // Sort by capture time - oldest captured first
  const messagesArray = Array.from(window.__igExporter.messages.values())
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .map((msg, index) => ({
      id: index + 1,
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp || null,
      type: 'text'
    }));

  const chatName = window.__igExporter.chatName;

  // Clean up
  delete window.__igExporter;

  console.log('Instagram Chat Exporter: Recording stopped, captured', messagesArray.length, 'messages');

  return {
    chatName: chatName !== 'Unknown' ? chatName : 'Chat',
    participants: ['You', chatName !== 'Unknown' ? chatName : 'Other'],
    messages: messagesArray
  };
}
