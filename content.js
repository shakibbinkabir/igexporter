// Content script for Instagram Chat Exporter
// This script runs in the context of Instagram pages

(function() {
  'use strict';

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMessages') {
      const result = extractAllMessages();
      sendResponse(result);
    } else if (request.action === 'loadMore') {
      loadMoreMessages().then(result => sendResponse(result));
      return true; // Indicates async response
    }
    return true;
  });

  function extractAllMessages() {
    try {
      // Find the main chat area
      const mainArea = document.querySelector('[role="main"]') ||
                       document.querySelector('section main');

      if (!mainArea) {
        return { error: 'Please open a chat conversation first.' };
      }

      // Get chat participant name
      let chatName = getChatName();

      // Get all messages
      const messages = getMessages(chatName);

      return {
        success: true,
        chatName: chatName,
        participants: ['You', chatName],
        messages: messages
      };

    } catch (error) {
      console.error('Instagram Chat Exporter Error:', error);
      return { error: error.message };
    }
  }

  function getChatName() {
    // Try multiple selectors to find the chat name
    const selectors = [
      // Header username
      'header h1',
      'header a[role="link"] span',
      'header span[dir="auto"]',
      // Profile link in header
      '[role="main"] header a span',
      // Thread header
      'div[role="heading"] span'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent && el.textContent.trim().length > 0) {
        const text = el.textContent.trim();
        // Filter out navigation text
        if (text !== 'Messages' && text !== 'Instagram' && !text.includes('request')) {
          return text;
        }
      }
    }

    return 'Unknown';
  }

  function getMessages(chatName) {
    const messages = [];
    const seen = new Set();

    // Try to find message containers using various selectors
    // Instagram's class names are obfuscated, so we try multiple approaches

    // Method 1: Look for role="row" elements (common in DM threads)
    const rowElements = document.querySelectorAll('[role="row"]');

    if (rowElements.length > 0) {
      rowElements.forEach((row, idx) => {
        const messageData = parseMessageRow(row, idx, chatName, seen);
        if (messageData) {
          messages.push(messageData);
        }
      });
    }

    // Method 2: Look for div elements with text content in the chat area
    if (messages.length === 0) {
      const chatArea = document.querySelector('[role="grid"]') ||
                       document.querySelector('[role="main"] > div > div > div');

      if (chatArea) {
        const textElements = chatArea.querySelectorAll('div[dir="auto"]');
        textElements.forEach((el, idx) => {
          const messageData = parseTextElement(el, idx, chatName, seen);
          if (messageData) {
            messages.push(messageData);
          }
        });
      }
    }

    return messages;
  }

  function parseMessageRow(row, index, chatName, seen) {
    // Find the text content
    const textEl = row.querySelector('div[dir="auto"]') ||
                   row.querySelector('span[dir="auto"]');

    if (!textEl) return null;

    const content = textEl.textContent?.trim();
    if (!content || content.length === 0) return null;

    // Skip UI elements
    if (isUIElement(content)) return null;

    // Check for duplicates
    const key = content.substring(0, 100) + index;
    if (seen.has(key)) return null;
    seen.add(key);

    // Determine sender
    const isSent = isSentMessage(row);

    // Get timestamp
    const timestamp = getTimestamp(row);

    return {
      id: index,
      content: content,
      sender: isSent ? 'You' : chatName,
      timestamp: timestamp,
      type: 'text'
    };
  }

  function parseTextElement(el, index, chatName, seen) {
    const content = el.textContent?.trim();
    if (!content || content.length === 0) return null;

    // Skip UI elements
    if (isUIElement(content)) return null;

    // Check for duplicates
    const key = content.substring(0, 100);
    if (seen.has(key)) return null;
    seen.add(key);

    // Determine sender based on position
    const rect = el.getBoundingClientRect();
    const isSent = rect.x > window.innerWidth / 2;

    // Try to find timestamp nearby
    const timestamp = getTimestamp(el.closest('div[class]'));

    return {
      id: index,
      content: content,
      sender: isSent ? 'You' : chatName,
      timestamp: timestamp,
      type: 'text'
    };
  }

  function isSentMessage(element) {
    // Check various indicators that a message is sent by the user
    const classStr = element.className || '';
    const parentClass = element.parentElement?.className || '';
    const grandparentClass = element.parentElement?.parentElement?.className || '';

    // Check for alignment classes (sent messages are usually aligned right)
    const allClasses = classStr + ' ' + parentClass + ' ' + grandparentClass;

    // Instagram often uses flexbox with justify-end for sent messages
    if (allClasses.includes('xo1l8bm') || allClasses.includes('x1n2onr6')) {
      return true;
    }

    // Check computed style for alignment
    const style = window.getComputedStyle(element);
    if (style.alignSelf === 'flex-end' || style.justifyContent === 'flex-end') {
      return true;
    }

    // Check position on screen (sent messages are on the right)
    const rect = element.getBoundingClientRect();
    return rect.x > window.innerWidth / 2;
  }

  function getTimestamp(element) {
    if (!element) return null;

    // Look for time element
    const timeEl = element.querySelector('time');
    if (timeEl) {
      return timeEl.getAttribute('datetime') || timeEl.textContent?.trim();
    }

    // Look for timestamp text (e.g., "2:30 PM", "Yesterday", etc.)
    const timePatterns = [
      /\d{1,2}:\d{2}\s*(AM|PM)/i,
      /\d{1,2}:\d{2}/,
      /yesterday/i,
      /\d+\s*(min|hour|day|week)s?\s*ago/i
    ];

    const text = element.textContent || '';
    for (const pattern of timePatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return null;
  }

  function isUIElement(text) {
    const uiTexts = [
      'Send', 'Like', 'Message', 'Messages', 'requests', 'Request',
      'Active', 'Seen', 'Delivered', 'Sent', 'Type a message',
      'Search', 'New message', 'Edit', 'Delete', 'Reply', 'Forward',
      'Copy', 'Report', 'Block', 'Restrict', 'Unrestrict',
      'View profile', 'Mute', 'Unmute'
    ];

    const lowerText = text.toLowerCase();
    return uiTexts.some(ui => lowerText === ui.toLowerCase());
  }

  async function loadMoreMessages() {
    const scrollContainer = document.querySelector('[role="grid"]') ||
                           document.querySelector('[role="main"] > div > div');

    if (!scrollContainer) {
      return { error: 'Could not find message container' };
    }

    return new Promise((resolve) => {
      let previousHeight = scrollContainer.scrollHeight;
      let noChangeCount = 0;
      let scrollAttempts = 0;
      const maxAttempts = 30;

      const scrollUp = () => {
        scrollContainer.scrollTop = 0;
        scrollAttempts++;

        setTimeout(() => {
          const currentHeight = scrollContainer.scrollHeight;

          if (currentHeight === previousHeight) {
            noChangeCount++;
          } else {
            noChangeCount = 0;
            previousHeight = currentHeight;
          }

          // Stop if no new content loaded after 3 attempts or max attempts reached
          if (noChangeCount >= 3 || scrollAttempts >= maxAttempts) {
            resolve({
              success: true,
              message: `Loaded messages after ${scrollAttempts} scroll attempts`
            });
          } else {
            scrollUp();
          }
        }, 800);
      };

      scrollUp();
    });
  }

  // Initialize
  console.log('Instagram Chat Exporter content script loaded');
})();
