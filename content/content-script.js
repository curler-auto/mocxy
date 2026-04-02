/**
 * Mocxy - Content Script (ISOLATED world)
 *
 * Bridges communication between the MAIN world inject script and the
 * extension service worker. Runs in the isolated content-script context
 * so it can access both chrome.runtime APIs and the page's window.
 *
 * Flow:
 *   interceptor-inject.js (MAIN world)
 *     -- window.postMessage -->
 *   content-script.js (ISOLATED world)
 *     -- chrome.runtime.sendMessage -->
 *   service-worker.js (background)
 *     -- chrome.runtime.onMessage -->
 *   content-script.js (ISOLATED world)
 *     -- window.postMessage -->
 *   interceptor-inject.js (MAIN world)
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Inject the MAIN-world interceptor script
  // ---------------------------------------------------------------------------
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/interceptor-inject.js');
  script.type = 'text/javascript';
  script.onload = function () {
    // Remove the tag after execution to keep the DOM clean
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // ---------------------------------------------------------------------------
  // Helper: send a message to the service worker, silently ignoring errors
  // caused by the extension context being invalidated (e.g. after reload).
  // ---------------------------------------------------------------------------
  function _safeSend(msg) {
    try {
      if (!chrome?.runtime?.id) return;          // context invalidated
      chrome.runtime.sendMessage(msg).catch((err) => {
        const text = err?.message || '';
        if (!text.includes('Receiving end does not exist') &&
            !text.includes('Extension context invalidated')) {
          console.warn('[Mocxy Content] sendMessage failed:', text);
        }
      });
    } catch (_) {
      // Extension context invalidated — ignore
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Listen for messages FROM the MAIN world (interceptor-inject.js)
  //    and forward to the service worker.
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    // Only accept messages from this window
    if (event.source !== window) return;

    const msg = event.data;
    if (!msg || msg.source !== 'mocxy-inject') return;

    switch (msg.type) {
      case 'INJECT_READY':
        // Inject script just finished loading — push rules to it immediately
        console.log('[Mocxy Content] Inject script ready, pushing rules');
        if (_latestSeedData) {
          window.postMessage({
            source: 'mocxy-content',
            type: 'RULES_UPDATED',
            data: _latestSeedData,
          }, '*');
        } else {
          fetchAndSeedRules();
        }
        break;

      case 'LOG_REQUEST':
        _safeSend({ type: 'LOG_REQUEST', data: msg.data });
        break;

      default:
        _safeSend({ type: msg.type, data: msg.data });
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Listen for messages FROM the service worker and forward to the page.
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'RULES_UPDATED':
        // Service worker is pushing updated rules/collections/enabled state
        window.postMessage({
          source: 'mocxy-content',
          type: 'RULES_UPDATED',
          data: message.data
        }, '*');
        sendResponse({ ok: true });
        break;

      case 'GET_RULES_RESPONSE':
        // Response to our startup GET_RULES request
        window.postMessage({
          source: 'mocxy-content',
          type: 'RULES_UPDATED',
          data: message.data
        }, '*');
        sendResponse({ ok: true });
        break;

      case 'SETTINGS_UPDATED':
        window.postMessage({
          source: 'mocxy-content',
          type: 'SETTINGS_UPDATED',
          data: message.data,
        }, '*');
        sendResponse({ ok: true });
        break;

      case 'PING':
        // Health check from service worker or popup
        sendResponse({ ok: true, context: 'content-script' });
        break;

      default:
        // Forward any other SW messages to the page
        window.postMessage({
          source: 'mocxy-content',
          type: message.type,
          data: message.data
        }, '*');
        break;
    }

    // Return true to keep the message channel open for async sendResponse
    return true;
  });

  // ---------------------------------------------------------------------------
  // 4. Fetch rules from service worker and push them to the inject script.
  //    Called on startup AND when the inject script signals INJECT_READY
  //    (handles race condition where inject script loads after initial push).
  // ---------------------------------------------------------------------------
  let _latestSeedData = null;

  function fetchAndSeedRules() {
    if (!chrome?.runtime?.id) return Promise.resolve();
    return Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_RULES' }),
      chrome.runtime.sendMessage({ type: 'GET_MOCK_COLLECTIONS' }),
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }),
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    ])
      .then(([rulesResult, collectionsResult, statusResult, settingsResult]) => {
        _latestSeedData = {
          rules: Array.isArray(rulesResult) ? rulesResult : [],
          mockCollections: Array.isArray(collectionsResult) ? collectionsResult : [],
          enabled: statusResult?.enabled ?? false,
          enableLogging: settingsResult?.enableLogging ?? true,
        };
        window.postMessage({
          source: 'mocxy-content',
          type: 'RULES_UPDATED',
          data: _latestSeedData,
        }, '*');
        console.log('[Mocxy Content] Rules seeded:',
          _latestSeedData.rules.length, 'rules,',
          _latestSeedData.mockCollections.length, 'collections,',
          'enabled:', _latestSeedData.enabled);
      })
      .catch((err) => {
        console.log('[Mocxy Content] Could not fetch rules:', err.message);
      });
  }

  // Initial fetch — may fire before inject script is ready (race condition),
  // but INJECT_READY will trigger a re-send once the inject script loads.
  fetchAndSeedRules();

  console.log('[Mocxy Content] Content script loaded');
})();
