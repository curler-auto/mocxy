# Feature 4.6 — Session Recording

## Summary

Record browsing sessions that capture network traffic, DOM mutations, user interactions, and console messages for replay and debugging. The recording system uses a lightweight, custom-built approach (not rrweb) that serializes the initial DOM snapshot and then captures incremental mutations via MutationObserver, user events via addEventListener, and console output via monkey-patching. Recordings are stored in IndexedDB, chunked by time, and can be replayed in a sandboxed iframe with a timeline scrubber that synchronizes DOM replay, network events, and console messages.

## Why

When debugging a complex UI issue, developers need to see exactly what happened: what API calls were made, what the DOM looked like at each moment, what the user clicked, and what errors appeared in the console. Currently, reproducing a bug requires manually stepping through actions. Session recording provides a complete, replayable snapshot of the entire browsing session. This is especially valuable for: (1) QA teams filing bug reports with exact reproduction steps, (2) debugging intermittent issues that are hard to reproduce, (3) capturing the exact API responses and DOM state at the time of failure, and (4) sharing debugging context across team members.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Chrome Extension**: MV3 with content scripts, service worker, popup, options page
- **Storage**: IndexedDB via `service-worker/storage-manager.js` (existing `NeuronInterceptorDB`)
- **Constants**: `shared/constants.js` — message types, storage keys
- **Content injection**: `content/content-script.js` injects scripts into the MAIN world

## What Gets Captured

| Category | Data | Method | Size Impact |
|----------|------|--------|-------------|
| DOM (initial) | Full HTML snapshot | `document.documentElement.outerHTML` (scripts stripped) | 50-500KB |
| DOM (mutations) | Attribute changes, node additions/removals, text changes | MutationObserver | ~1-5KB/sec |
| User events | Clicks, scrolls, input changes, form submissions | addEventListener | ~0.5-2KB/sec |
| Console | log, warn, error, info messages | console.X monkey-patch | ~0.1-1KB/sec |
| Network | HTTP request/response pairs | Existing request logging | Already captured |
| Viewport | Window size, scroll position | resize/scroll events | ~0.1KB/sec |

Estimated total recording size: 5-20MB per 5-minute session (stored compressed in IndexedDB chunks).

## Files to Create

| File | Purpose |
|------|---------|
| `content/session-recorder.js` | Injected into MAIN world — DOM serialization, MutationObserver, event capture, console capture |
| `options/components/session-player.js` | Playback UI — timeline, iframe DOM replay, network panel, console panel |
| `options/components/session-list.js` | List of saved recordings with metadata, delete, export |

## Files to Modify

| File | Change |
|------|--------|
| `content/content-script.js` | Inject `session-recorder.js` when recording is active |
| `shared/constants.js` | Add new MSG_TYPES and IDB_STORES entry |
| `service-worker/storage-manager.js` | Add new IndexedDB store for session recordings |
| `manifest.json` | Add `session-recorder.js` to `web_accessible_resources` |
| `options/options.js` | Import and register session-player and session-list components |
| `options/options.html` | Add "Recordings" tab |

## Data Structures

### Recording Metadata (stored in IndexedDB)

```javascript
{
  id: 'rec_1711929600000_a1b2c3',
  name: 'Fleet Summary Debugging',
  url: 'https://nms.example.com/fleet-summary',
  startedAt: '2026-04-01T14:00:00.000Z',
  endedAt: '2026-04-01T14:05:00.000Z',
  duration: 300000,  // ms
  chunkCount: 5,
  totalEvents: 4823,
  totalSize: 8421376,  // bytes
  status: 'completed',  // 'recording' | 'completed' | 'error'
  viewport: { width: 1920, height: 1080 },
}
```

### Recording Chunk (stored in IndexedDB, one per minute)

```javascript
{
  id: 'rec_1711929600000_a1b2c3_chunk_0',
  recordingId: 'rec_1711929600000_a1b2c3',
  chunkIndex: 0,
  startTime: 0,     // ms offset from recording start
  endTime: 60000,   // ms offset
  data: {
    // Only in chunk 0:
    initialSnapshot: '<html>...</html>',

    // In every chunk:
    mutations: [
      {
        t: 1234,        // ms offset from recording start
        type: 'attributes',
        target: '/html/body/div[1]/span[2]',  // XPath selector
        name: 'class',
        value: 'active highlighted',
      },
      {
        t: 1456,
        type: 'childList',
        target: '/html/body/div[1]',
        added: [
          { xpath: '/html/body/div[1]/p[3]', html: '<p class="new">Hello</p>' }
        ],
        removed: [
          { xpath: '/html/body/div[1]/p[1]' }
        ],
      },
      {
        t: 1789,
        type: 'characterData',
        target: '/html/body/div[1]/span[2]/text()',
        value: 'Updated text content',
      },
    ],
    events: [
      {
        t: 2000,
        type: 'click',
        target: '/html/body/div[1]/button[1]',
        x: 450,
        y: 320,
      },
      {
        t: 3500,
        type: 'scroll',
        scrollX: 0,
        scrollY: 1200,
      },
      {
        t: 5000,
        type: 'input',
        target: '/html/body/div[1]/input[1]',
        value: 'search query',
      },
    ],
    console: [
      {
        t: 1100,
        level: 'log',
        args: ['API response:', { status: 200, data: '...' }],
      },
      {
        t: 4500,
        level: 'error',
        args: ['Uncaught TypeError: Cannot read property "x" of undefined'],
      },
    ],
    network: [
      {
        t: 800,
        type: 'request',
        id: 'req_001',
        method: 'GET',
        url: 'https://api.example.com/data',
      },
      {
        t: 1200,
        type: 'response',
        id: 'req_001',
        status: 200,
        size: 4523,
        duration: 400,
      },
    ],
  },
}
```

## Implementation

### Constants Changes: `shared/constants.js`

Add these constants to the existing file:

```javascript
// Add to IDB_STORES:
export const IDB_STORES = {
  LOGS: 'request_logs',
  MOCK_BODIES: 'mock_bodies',
  SESSION_RECORDINGS: 'session_recordings',       // NEW: recording metadata
  SESSION_RECORDING_CHUNKS: 'session_recording_chunks',  // NEW: recording data chunks
};

// Bump IDB_VERSION for the new stores:
export const IDB_VERSION = 2;

// Add to MSG_TYPES:
export const MSG_TYPES = {
  // ... existing types ...
  SESSION_START_RECORDING: 'SESSION_START_RECORDING',
  SESSION_STOP_RECORDING: 'SESSION_STOP_RECORDING',
  SESSION_RECORDING_STATUS: 'SESSION_RECORDING_STATUS',
  SESSION_SAVE_CHUNK: 'SESSION_SAVE_CHUNK',
  SESSION_GET_RECORDINGS: 'SESSION_GET_RECORDINGS',
  SESSION_GET_RECORDING: 'SESSION_GET_RECORDING',
  SESSION_GET_CHUNKS: 'SESSION_GET_CHUNKS',
  SESSION_DELETE_RECORDING: 'SESSION_DELETE_RECORDING',
  SESSION_EXPORT_RECORDING: 'SESSION_EXPORT_RECORDING',
};

// Add recording defaults:
export const SESSION_RECORDING_DEFAULTS = {
  maxDurationMs: 5 * 60 * 1000,  // 5 minutes
  chunkIntervalMs: 60 * 1000,    // 1-minute chunks
  maxChunkSize: 5 * 1024 * 1024, // 5MB per chunk
  captureConsole: true,
  captureEvents: true,
  captureMutations: true,
  captureNetwork: true,
  debounceScrollMs: 100,
  debounceInputMs: 200,
};
```

### Manifest Changes: `manifest.json`

Add `session-recorder.js` to web_accessible_resources:

```json
{
  "web_accessible_resources": [
    {
      "resources": ["content/interceptor-inject.js", "content/session-recorder.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### File 1: `content/session-recorder.js`

This script is injected into the MAIN world of the page when recording is active. It captures DOM snapshots, mutations, user events, and console messages.

```javascript
/**
 * Neuron Interceptor — Session Recorder
 *
 * Injected into the page's MAIN world to capture:
 *   1. Initial DOM snapshot (full HTML, scripts stripped)
 *   2. DOM mutations via MutationObserver
 *   3. User events (click, scroll, input) via event listeners
 *   4. Console messages via console.X monkey-patching
 *
 * Communication: postMessage to content-script.js (ISOLATED world),
 * which forwards to the service worker for IndexedDB storage.
 *
 * This script is designed to be lightweight and non-intrusive.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__neuronSessionRecorder) return;
  window.__neuronSessionRecorder = true;

  // ==========================================================================
  // State
  // ==========================================================================

  let _recording = false;
  let _startTime = 0;
  let _recordingId = '';
  let _chunkIndex = 0;
  let _currentChunk = { mutations: [], events: [], console: [], network: [] };
  let _chunkStartTime = 0;
  let _mutationObserver = null;
  let _eventListeners = [];
  let _originalConsole = {};
  let _chunkInterval = null;
  let _autoStopTimeout = null;
  let _config = {
    maxDurationMs: 5 * 60 * 1000,
    chunkIntervalMs: 60 * 1000,
    captureConsole: true,
    captureEvents: true,
    captureMutations: true,
    debounceScrollMs: 100,
    debounceInputMs: 200,
  };

  // ==========================================================================
  // Public API (called via postMessage from content-script.js)
  // ==========================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'neuron-interceptor') return;

    switch (event.data.type) {
      case 'SESSION_START':
        _startRecording(event.data.config || {});
        break;
      case 'SESSION_STOP':
        _stopRecording();
        break;
      case 'SESSION_STATUS':
        _postMessage('SESSION_STATUS_RESPONSE', {
          recording: _recording,
          recordingId: _recordingId,
          duration: _recording ? Date.now() - _startTime : 0,
          chunkIndex: _chunkIndex,
        });
        break;
    }
  });

  // ==========================================================================
  // Recording lifecycle
  // ==========================================================================

  function _startRecording(config) {
    if (_recording) return;

    _config = { ..._config, ...config };
    _recording = true;
    _startTime = Date.now();
    _recordingId = `rec_${_startTime}_${_randomId()}`;
    _chunkIndex = 0;
    _chunkStartTime = 0;
    _currentChunk = { mutations: [], events: [], console: [], network: [] };

    // --- Capture initial DOM snapshot ----------------------------------------
    const initialSnapshot = _serializeDOM();

    // Send metadata + initial snapshot
    _postMessage('SESSION_RECORDING_STARTED', {
      recordingId: _recordingId,
      url: location.href,
      startedAt: new Date(_startTime).toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });

    // Save chunk 0 with the initial snapshot
    _currentChunk.initialSnapshot = initialSnapshot;

    // --- Start MutationObserver ----------------------------------------------
    if (_config.captureMutations) {
      _startMutationObserver();
    }

    // --- Start event listeners -----------------------------------------------
    if (_config.captureEvents) {
      _startEventListeners();
    }

    // --- Start console capture -----------------------------------------------
    if (_config.captureConsole) {
      _startConsoleCapture();
    }

    // --- Chunk flush interval ------------------------------------------------
    _chunkInterval = setInterval(() => {
      _flushChunk();
    }, _config.chunkIntervalMs);

    // --- Auto-stop after max duration ----------------------------------------
    _autoStopTimeout = setTimeout(() => {
      _stopRecording();
      _postMessage('SESSION_AUTO_STOPPED', {
        recordingId: _recordingId,
        reason: 'max_duration',
      });
    }, _config.maxDurationMs);

    console.log(`[Neuron] Session recording started: ${_recordingId}`);
  }

  function _stopRecording() {
    if (!_recording) return;

    _recording = false;

    // Stop MutationObserver
    if (_mutationObserver) {
      _mutationObserver.disconnect();
      _mutationObserver = null;
    }

    // Remove event listeners
    for (const { target, type, handler } of _eventListeners) {
      target.removeEventListener(type, handler, true);
    }
    _eventListeners = [];

    // Restore console
    _restoreConsole();

    // Clear timers
    if (_chunkInterval) {
      clearInterval(_chunkInterval);
      _chunkInterval = null;
    }
    if (_autoStopTimeout) {
      clearTimeout(_autoStopTimeout);
      _autoStopTimeout = null;
    }

    // Flush final chunk
    _flushChunk();

    // Notify completion
    _postMessage('SESSION_RECORDING_STOPPED', {
      recordingId: _recordingId,
      endedAt: new Date().toISOString(),
      duration: Date.now() - _startTime,
      chunkCount: _chunkIndex,
    });

    console.log(`[Neuron] Session recording stopped: ${_recordingId}, ${_chunkIndex} chunks`);

    // Reset state
    _recordingId = '';
    _chunkIndex = 0;
  }

  // ==========================================================================
  // DOM Serialization
  // ==========================================================================

  /**
   * Serialize the entire DOM as an HTML string, stripping script elements
   * to avoid re-execution during playback.
   *
   * @returns {string} — Clean HTML string
   */
  function _serializeDOM() {
    const clone = document.documentElement.cloneNode(true);

    // Remove all script elements
    const scripts = clone.querySelectorAll('script');
    scripts.forEach(s => s.remove());

    // Remove Neuron Interceptor's own injected elements
    const neuronElements = clone.querySelectorAll('[data-neuron-injected]');
    neuronElements.forEach(e => e.remove());

    // Convert inline event handlers to data attributes (to prevent execution during replay)
    const allElements = clone.querySelectorAll('*');
    allElements.forEach(el => {
      const attrs = el.attributes;
      for (let i = attrs.length - 1; i >= 0; i--) {
        if (attrs[i].name.startsWith('on')) {
          el.setAttribute(`data-orig-${attrs[i].name}`, attrs[i].value);
          el.removeAttribute(attrs[i].name);
        }
      }
    });

    return clone.outerHTML;
  }

  // ==========================================================================
  // MutationObserver
  // ==========================================================================

  function _startMutationObserver() {
    _mutationObserver = new MutationObserver((mutations) => {
      if (!_recording) return;

      const t = Date.now() - _startTime;

      for (const mutation of mutations) {
        // Skip mutations from Neuron's own elements
        if (_isNeuronElement(mutation.target)) continue;

        switch (mutation.type) {
          case 'attributes': {
            _currentChunk.mutations.push({
              t,
              type: 'attributes',
              target: _getXPath(mutation.target),
              name: mutation.attributeName,
              value: mutation.target.getAttribute(mutation.attributeName),
            });
            break;
          }

          case 'childList': {
            const entry = {
              t,
              type: 'childList',
              target: _getXPath(mutation.target),
              added: [],
              removed: [],
            };

            for (const node of mutation.addedNodes) {
              if (_isNeuronElement(node)) continue;
              if (node.nodeType === Node.ELEMENT_NODE) {
                entry.added.push({
                  xpath: _getXPath(node),
                  html: node.outerHTML.substring(0, 10000), // Limit size
                  beforeSibling: mutation.nextSibling ? _getXPath(mutation.nextSibling) : null,
                });
              } else if (node.nodeType === Node.TEXT_NODE) {
                entry.added.push({
                  xpath: _getXPath(node),
                  text: node.textContent.substring(0, 2000),
                });
              }
            }

            for (const node of mutation.removedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                entry.removed.push({
                  html: node.outerHTML.substring(0, 2000),
                });
              } else if (node.nodeType === Node.TEXT_NODE) {
                entry.removed.push({
                  text: node.textContent.substring(0, 500),
                });
              }
            }

            if (entry.added.length > 0 || entry.removed.length > 0) {
              _currentChunk.mutations.push(entry);
            }
            break;
          }

          case 'characterData': {
            _currentChunk.mutations.push({
              t,
              type: 'characterData',
              target: _getXPath(mutation.target),
              value: mutation.target.textContent?.substring(0, 2000) || '',
            });
            break;
          }
        }
      }
    });

    _mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
      attributeOldValue: false,
      characterDataOldValue: false,
    });
  }

  // ==========================================================================
  // User Event Capture
  // ==========================================================================

  function _startEventListeners() {
    // Click events
    _addEventCapture(document, 'click', (e) => {
      _currentChunk.events.push({
        t: Date.now() - _startTime,
        type: 'click',
        target: _getXPath(e.target),
        x: e.clientX,
        y: e.clientY,
        button: e.button,
      });
    });

    // Scroll events (debounced)
    let lastScrollTime = 0;
    _addEventCapture(window, 'scroll', () => {
      const now = Date.now();
      if (now - lastScrollTime < _config.debounceScrollMs) return;
      lastScrollTime = now;

      _currentChunk.events.push({
        t: now - _startTime,
        type: 'scroll',
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      });
    });

    // Input events (debounced, captures value)
    const inputTimers = new WeakMap();
    _addEventCapture(document, 'input', (e) => {
      const target = e.target;
      if (!target || !target.tagName) return;

      // Clear previous debounce timer for this element
      const prevTimer = inputTimers.get(target);
      if (prevTimer) clearTimeout(prevTimer);

      inputTimers.set(target, setTimeout(() => {
        _currentChunk.events.push({
          t: Date.now() - _startTime,
          type: 'input',
          target: _getXPath(target),
          value: target.value?.substring(0, 500) || '',
          inputType: target.type || 'text',
        });
      }, _config.debounceInputMs));
    });

    // Resize events (viewport changes)
    _addEventCapture(window, 'resize', () => {
      _currentChunk.events.push({
        t: Date.now() - _startTime,
        type: 'resize',
        width: window.innerWidth,
        height: window.innerHeight,
      });
    });

    // Form submissions
    _addEventCapture(document, 'submit', (e) => {
      _currentChunk.events.push({
        t: Date.now() - _startTime,
        type: 'submit',
        target: _getXPath(e.target),
        action: e.target.action || '',
      });
    });

    // Keyboard events (for key shortcuts, not typing — typing is captured via input events)
    _addEventCapture(document, 'keydown', (e) => {
      // Only capture modifier combinations (Ctrl+X, Alt+X, Meta+X)
      if (e.ctrlKey || e.altKey || e.metaKey) {
        _currentChunk.events.push({
          t: Date.now() - _startTime,
          type: 'keydown',
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          shift: e.shiftKey,
        });
      }
    });
  }

  function _addEventCapture(target, type, handler) {
    target.addEventListener(type, handler, true); // capture phase
    _eventListeners.push({ target, type, handler });
  }

  // ==========================================================================
  // Console Capture
  // ==========================================================================

  function _startConsoleCapture() {
    const levels = ['log', 'warn', 'error', 'info', 'debug'];

    for (const level of levels) {
      _originalConsole[level] = console[level];

      console[level] = function (...args) {
        // Call original
        _originalConsole[level].apply(console, args);

        // Capture (only if recording)
        if (!_recording) return;

        _currentChunk.console.push({
          t: Date.now() - _startTime,
          level,
          args: args.map(_serializeConsoleArg),
        });
      };
    }
  }

  function _restoreConsole() {
    for (const [level, original] of Object.entries(_originalConsole)) {
      if (original) console[level] = original;
    }
    _originalConsole = {};
  }

  /**
   * Serialize a console argument to a JSON-safe representation.
   * Handles objects, arrays, errors, DOM elements, and circular references.
   */
  function _serializeConsoleArg(arg) {
    if (arg === null) return null;
    if (arg === undefined) return '[undefined]';

    const type = typeof arg;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return arg;
    }

    if (arg instanceof Error) {
      return { __type: 'Error', message: arg.message, stack: arg.stack?.substring(0, 1000) };
    }

    if (arg instanceof HTMLElement) {
      return { __type: 'HTMLElement', tagName: arg.tagName, id: arg.id, className: arg.className };
    }

    try {
      const str = JSON.stringify(arg, null, 0);
      if (str && str.length <= 2000) return JSON.parse(str);
      return String(arg).substring(0, 500);
    } catch (e) {
      return String(arg).substring(0, 500);
    }
  }

  // ==========================================================================
  // Chunk Management
  // ==========================================================================

  function _flushChunk() {
    // Skip empty chunks (except chunk 0 which has the initial snapshot)
    if (
      _chunkIndex > 0 &&
      _currentChunk.mutations.length === 0 &&
      _currentChunk.events.length === 0 &&
      _currentChunk.console.length === 0 &&
      _currentChunk.network.length === 0
    ) {
      return;
    }

    const endTime = Date.now() - _startTime;

    const chunk = {
      id: `${_recordingId}_chunk_${_chunkIndex}`,
      recordingId: _recordingId,
      chunkIndex: _chunkIndex,
      startTime: _chunkStartTime,
      endTime: endTime,
      data: { ..._currentChunk },
    };

    // Send chunk to content-script → service worker for IndexedDB storage
    _postMessage('SESSION_CHUNK', chunk);

    // Reset for next chunk
    _chunkIndex++;
    _chunkStartTime = endTime;
    _currentChunk = { mutations: [], events: [], console: [], network: [] };
  }

  // ==========================================================================
  // XPath Generation
  // ==========================================================================

  /**
   * Generate an XPath selector for a DOM node.
   * Used to identify nodes across the initial snapshot and mutations.
   *
   * @param {Node} node — DOM node
   * @returns {string} — XPath like /html/body/div[1]/span[2]
   */
  function _getXPath(node) {
    if (!node) return '';
    if (node === document) return '/';

    const parts = [];
    let current = node;

    while (current && current !== document) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousSibling;
        while (sibling) {
          if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
            index++;
          }
          sibling = sibling.previousSibling;
        }

        const tagName = current.nodeName.toLowerCase();
        // Include index only if there are siblings with the same tag
        let needsIndex = false;
        let nextSibling = current.nextSibling;
        while (nextSibling) {
          if (nextSibling.nodeType === Node.ELEMENT_NODE && nextSibling.nodeName === current.nodeName) {
            needsIndex = true;
            break;
          }
          nextSibling = nextSibling.nextSibling;
        }

        parts.unshift(needsIndex || index > 1 ? `${tagName}[${index}]` : tagName);
      } else if (current.nodeType === Node.TEXT_NODE) {
        let textIndex = 1;
        let sibling = current.previousSibling;
        while (sibling) {
          if (sibling.nodeType === Node.TEXT_NODE) textIndex++;
          sibling = sibling.previousSibling;
        }
        parts.unshift(`text()[${textIndex}]`);
      }

      current = current.parentNode;
    }

    return '/' + parts.join('/');
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  function _postMessage(type, data) {
    window.postMessage({
      source: 'neuron-session-recorder',
      type,
      data,
    }, '*');
  }

  function _randomId() {
    return Math.random().toString(36).substring(2, 8);
  }

  function _isNeuronElement(node) {
    if (!node || !node.getAttribute) return false;
    return node.getAttribute('data-neuron-injected') !== null;
  }

})();
```

### Content Script Changes: `content/content-script.js`

Add session recorder injection logic. When the service worker sends a `SESSION_START_RECORDING` message, inject `session-recorder.js` into the MAIN world and forward the start command.

```javascript
// Add to content/content-script.js:

// --- Session Recording Bridge ------------------------------------------------
// Listen for recording control messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SESSION_START_RECORDING') {
    // Inject session-recorder.js into the MAIN world
    _injectSessionRecorder().then(() => {
      // Forward start command to the recorder
      window.postMessage({
        source: 'neuron-interceptor',
        type: 'SESSION_START',
        config: message.config || {},
      }, '*');
      sendResponse({ success: true });
    });
    return true; // async response
  }

  if (message.type === 'SESSION_STOP_RECORDING') {
    window.postMessage({
      source: 'neuron-interceptor',
      type: 'SESSION_STOP',
    }, '*');
    sendResponse({ success: true });
  }

  if (message.type === 'SESSION_RECORDING_STATUS') {
    window.postMessage({
      source: 'neuron-interceptor',
      type: 'SESSION_STATUS',
    }, '*');
    // The response will come back via the message listener below
  }
});

// Listen for messages from session-recorder.js (MAIN world)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'neuron-session-recorder') return;

  // Forward to service worker for storage
  chrome.runtime.sendMessage({
    type: event.data.type,
    data: event.data.data,
  });
});

/**
 * Inject session-recorder.js into the page's MAIN world.
 */
async function _injectSessionRecorder() {
  return new Promise((resolve) => {
    if (document.querySelector('script[data-neuron-session-recorder]')) {
      resolve(); // Already injected
      return;
    }

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/session-recorder.js');
    script.setAttribute('data-neuron-injected', 'true');
    script.setAttribute('data-neuron-session-recorder', 'true');
    script.onload = () => resolve();
    (document.head || document.documentElement).appendChild(script);
  });
}
```

### Storage Manager Changes: `service-worker/storage-manager.js`

Add the new IndexedDB stores for session recordings.

```javascript
// Add to the IDB upgrade handler in storage-manager.js:

// In the onupgradeneeded handler, add for version 2:
if (oldVersion < 2) {
  // Session recording metadata
  if (!db.objectStoreNames.contains('session_recordings')) {
    const recStore = db.createObjectStore('session_recordings', { keyPath: 'id' });
    recStore.createIndex('by_date', 'startedAt', { unique: false });
    recStore.createIndex('by_status', 'status', { unique: false });
  }

  // Session recording data chunks
  if (!db.objectStoreNames.contains('session_recording_chunks')) {
    const chunkStore = db.createObjectStore('session_recording_chunks', { keyPath: 'id' });
    chunkStore.createIndex('by_recording', 'recordingId', { unique: false });
    chunkStore.createIndex('by_recording_chunk', ['recordingId', 'chunkIndex'], { unique: true });
  }
}

// Add new storage functions:

/**
 * Save a session recording metadata entry.
 */
async function saveSessionRecording(metadata) {
  const db = await _getDB();
  const tx = db.transaction('session_recordings', 'readwrite');
  await tx.objectStore('session_recordings').put(metadata);
  await tx.done;
}

/**
 * Save a session recording chunk.
 */
async function saveSessionChunk(chunk) {
  const db = await _getDB();
  const tx = db.transaction('session_recording_chunks', 'readwrite');
  await tx.objectStore('session_recording_chunks').put(chunk);
  await tx.done;
}

/**
 * Get all session recordings (metadata only).
 */
async function getSessionRecordings() {
  const db = await _getDB();
  return db.getAll('session_recordings');
}

/**
 * Get a single session recording by ID.
 */
async function getSessionRecording(id) {
  const db = await _getDB();
  return db.get('session_recordings', id);
}

/**
 * Get all chunks for a recording, in order.
 */
async function getSessionChunks(recordingId) {
  const db = await _getDB();
  const tx = db.transaction('session_recording_chunks', 'readonly');
  const index = tx.objectStore('session_recording_chunks').index('by_recording');
  const chunks = await index.getAll(recordingId);
  return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * Delete a session recording and all its chunks.
 */
async function deleteSessionRecording(id) {
  const db = await _getDB();

  // Delete chunks
  const tx1 = db.transaction('session_recording_chunks', 'readwrite');
  const index = tx1.objectStore('session_recording_chunks').index('by_recording');
  const chunks = await index.getAll(id);
  for (const chunk of chunks) {
    await tx1.objectStore('session_recording_chunks').delete(chunk.id);
  }
  await tx1.done;

  // Delete metadata
  const tx2 = db.transaction('session_recordings', 'readwrite');
  await tx2.objectStore('session_recordings').delete(id);
  await tx2.done;
}
```

### File 2: `options/components/session-list.js`

Component that displays a list of saved recordings with metadata, playback, delete, and export controls.

```javascript
/**
 * Neuron Interceptor — Session Recording List Component
 *
 * Displays saved recordings with:
 *   - Recording name, URL, duration, size, date
 *   - Play button (opens session-player)
 *   - Delete button
 *   - Export button (.neuron-session file)
 *
 * Usage:
 *   import { initSessionList } from './components/session-list.js';
 *   const sessionList = initSessionList(container, { onPlay: (recordingId) => {} });
 */

import { MSG_TYPES } from '../../shared/constants.js';

export function initSessionList(container, callbacks) {
  let _recordings = [];

  const wrapper = document.createElement('div');
  wrapper.className = 'ni-session-list';

  // Header with recording controls
  const header = document.createElement('div');
  header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;';

  const title = document.createElement('h3');
  title.textContent = 'Session Recordings';
  title.style.cssText = 'margin: 0; color: var(--text, #cdd6f4); font-size: 18px; font-weight: 600;';

  const recordBtn = document.createElement('button');
  recordBtn.className = 'ni-btn ni-btn-primary ni-record-btn';
  recordBtn.textContent = 'Start Recording';
  recordBtn.style.cssText = `
    padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer;
    background: #f38ba8; color: #1e1e2e; font-weight: 600; font-size: 13px;
    display: flex; align-items: center; gap: 6px;
  `;

  let isRecording = false;

  recordBtn.addEventListener('click', async () => {
    if (isRecording) {
      // Stop recording
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'SESSION_STOP_RECORDING' });
      }
      recordBtn.textContent = 'Start Recording';
      recordBtn.style.background = '#f38ba8';
      isRecording = false;
      // Refresh list after a short delay
      setTimeout(refresh, 1000);
    } else {
      // Start recording
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SESSION_START_RECORDING',
          config: {},
        });
      }
      recordBtn.textContent = 'Stop Recording';
      recordBtn.style.background = '#a6e3a1';
      isRecording = true;
    }
  });

  header.appendChild(title);
  header.appendChild(recordBtn);
  wrapper.appendChild(header);

  // Recording list container
  const listContainer = document.createElement('div');
  listContainer.className = 'ni-session-list-items';
  wrapper.appendChild(listContainer);

  container.appendChild(wrapper);

  // Initial load
  refresh();

  async function refresh() {
    const response = await chrome.runtime.sendMessage({ type: MSG_TYPES.SESSION_GET_RECORDINGS });
    _recordings = (response?.data || []).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    _render();
  }

  function _render() {
    listContainer.innerHTML = '';

    if (_recordings.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted, #a6adc8); font-size: 14px;">
          <p style="margin: 0 0 8px 0;">No recordings yet.</p>
          <p style="margin: 0; font-size: 12px;">Navigate to a page and click "Start Recording" to capture a session.</p>
        </div>
      `;
      return;
    }

    for (const rec of _recordings) {
      const card = document.createElement('div');
      card.className = 'ni-session-card';
      card.style.cssText = `
        background: var(--bg-overlay, #181825);
        border: 1px solid var(--border, #45475a);
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        transition: border-color 0.15s;
      `;
      card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent, #89b4fa)'; });
      card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border, #45475a)'; });

      // Left: info
      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; min-width: 0;';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 4px;';
      nameRow.innerHTML = `
        <span style="color: var(--text, #cdd6f4); font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_escapeHTML(rec.name || rec.id)}</span>
        <span style="
          display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
          background: ${rec.status === 'completed' ? '#a6e3a122' : '#f9e2af22'};
          color: ${rec.status === 'completed' ? '#a6e3a1' : '#f9e2af'};
        ">${rec.status}</span>
      `;

      const urlRow = document.createElement('div');
      urlRow.style.cssText = 'color: var(--text-muted, #a6adc8); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px;';
      urlRow.textContent = rec.url || '';

      const metaRow = document.createElement('div');
      metaRow.style.cssText = 'display: flex; gap: 16px; color: var(--text-muted); font-size: 11px;';
      metaRow.innerHTML = `
        <span>${new Date(rec.startedAt).toLocaleString()}</span>
        <span>${_formatDuration(rec.duration)}</span>
        <span>${rec.chunkCount} chunks</span>
        <span>${_formatSize(rec.totalSize)}</span>
      `;

      info.appendChild(nameRow);
      info.appendChild(urlRow);
      info.appendChild(metaRow);

      // Right: action buttons
      const actions = document.createElement('div');
      actions.style.cssText = 'display: flex; gap: 8px; margin-left: 12px;';

      // Play button
      if (rec.status === 'completed') {
        const playBtn = _createActionBtn('Play', '#a6e3a1', () => {
          if (callbacks.onPlay) callbacks.onPlay(rec.id);
        });
        actions.appendChild(playBtn);
      }

      // Export button
      const exportBtn = _createActionBtn('Export', '#89b4fa', async () => {
        await _exportRecording(rec.id);
      });
      actions.appendChild(exportBtn);

      // Delete button
      const deleteBtn = _createActionBtn('Delete', '#f38ba8', async () => {
        if (confirm(`Delete recording "${rec.name || rec.id}"?`)) {
          await chrome.runtime.sendMessage({ type: MSG_TYPES.SESSION_DELETE_RECORDING, data: { id: rec.id } });
          refresh();
        }
      });
      actions.appendChild(deleteBtn);

      card.appendChild(info);
      card.appendChild(actions);
      listContainer.appendChild(card);
    }
  }

  function _createActionBtn(text, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 5px 12px; border: 1px solid ${color}44; border-radius: 6px;
      background: ${color}11; color: ${color}; cursor: pointer;
      font-size: 12px; font-weight: 500; transition: background 0.12s;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = `${color}22`; });
    btn.addEventListener('mouseleave', () => { btn.style.background = `${color}11`; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  async function _exportRecording(recordingId) {
    const response = await chrome.runtime.sendMessage({
      type: MSG_TYPES.SESSION_EXPORT_RECORDING,
      data: { id: recordingId },
    });

    if (!response || !response.data) return;

    const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${recordingId}.neuron-session`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function _formatDuration(ms) {
    if (!ms) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
  }

  function _formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function _escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { refresh };
}
```

### File 3: `options/components/session-player.js`

Playback component with timeline scrubber, iframe-based DOM replay, network panel, and console panel.

```javascript
/**
 * Neuron Interceptor — Session Player Component
 *
 * Replays a recorded session with synchronized:
 *   - DOM replay in a sandboxed iframe (initial snapshot + mutation replay)
 *   - Timeline scrubber showing events along a time axis
 *   - Network request panel
 *   - Console message panel
 *
 * Usage:
 *   import { initSessionPlayer } from './components/session-player.js';
 *   const player = initSessionPlayer(container);
 *   player.load(recordingId);
 */

import { MSG_TYPES } from '../../shared/constants.js';

export function initSessionPlayer(container, callbacks) {
  // State
  let _recording = null;
  let _chunks = [];
  let _allMutations = [];
  let _allEvents = [];
  let _allConsole = [];
  let _allNetwork = [];
  let _currentTime = 0;
  let _duration = 0;
  let _playing = false;
  let _playInterval = null;
  let _playbackSpeed = 1;
  let _iframe = null;

  // =========================================================================
  // Layout
  // =========================================================================

  const wrapper = document.createElement('div');
  wrapper.className = 'ni-session-player';
  wrapper.style.cssText = 'display: flex; flex-direction: column; height: 100%; background: var(--bg-overlay, #11111b);';

  // --- Top: Back button + recording info ------------------------------------
  const topBar = document.createElement('div');
  topBar.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border, #45475a);';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back to Recordings';
  backBtn.style.cssText = 'padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; font-size: 13px;';
  backBtn.addEventListener('click', () => {
    _stop();
    if (callbacks?.onBack) callbacks.onBack();
  });

  const infoLabel = document.createElement('span');
  infoLabel.className = 'ni-player-info';
  infoLabel.style.cssText = 'color: var(--text-muted); font-size: 13px;';

  topBar.appendChild(backBtn);
  topBar.appendChild(infoLabel);
  wrapper.appendChild(topBar);

  // --- Main area: iframe + panels -------------------------------------------
  const mainArea = document.createElement('div');
  mainArea.style.cssText = 'flex: 1; display: flex; overflow: hidden;';

  // Left: DOM replay iframe
  const iframeContainer = document.createElement('div');
  iframeContainer.style.cssText = 'flex: 2; position: relative; background: #fff; border-right: 1px solid var(--border);';

  _iframe = document.createElement('iframe');
  _iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
  _iframe.sandbox = 'allow-same-origin'; // No scripts
  iframeContainer.appendChild(_iframe);

  // Click indicator overlay
  const clickOverlay = document.createElement('div');
  clickOverlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 10;';
  iframeContainer.appendChild(clickOverlay);

  // Right: panels (network + console)
  const panelArea = document.createElement('div');
  panelArea.style.cssText = 'flex: 1; display: flex; flex-direction: column; min-width: 300px; max-width: 400px;';

  // Network panel
  const networkPanel = document.createElement('div');
  networkPanel.style.cssText = 'flex: 1; overflow-y: auto; border-bottom: 1px solid var(--border);';
  networkPanel.innerHTML = '<div style="padding: 8px 12px; color: var(--text-muted); font-size: 12px; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid var(--border);">Network</div>';
  const networkList = document.createElement('div');
  networkList.className = 'ni-player-network-list';
  networkPanel.appendChild(networkList);

  // Console panel
  const consolePanel = document.createElement('div');
  consolePanel.style.cssText = 'flex: 1; overflow-y: auto;';
  consolePanel.innerHTML = '<div style="padding: 8px 12px; color: var(--text-muted); font-size: 12px; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid var(--border);">Console</div>';
  const consoleList = document.createElement('div');
  consoleList.className = 'ni-player-console-list';
  consolePanel.appendChild(consoleList);

  panelArea.appendChild(networkPanel);
  panelArea.appendChild(consolePanel);
  mainArea.appendChild(iframeContainer);
  mainArea.appendChild(panelArea);
  wrapper.appendChild(mainArea);

  // --- Bottom: Timeline + controls ------------------------------------------
  const controlBar = document.createElement('div');
  controlBar.style.cssText = 'padding: 12px 16px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px;';

  // Play/Pause button
  const playBtn = document.createElement('button');
  playBtn.textContent = 'Play';
  playBtn.style.cssText = 'padding: 6px 16px; border: none; border-radius: 6px; background: var(--accent, #89b4fa); color: #1e1e2e; font-weight: 600; font-size: 13px; cursor: pointer; min-width: 70px;';
  playBtn.addEventListener('click', () => {
    if (_playing) {
      _pause();
    } else {
      _play();
    }
  });

  // Time display
  const timeDisplay = document.createElement('span');
  timeDisplay.style.cssText = 'color: var(--text); font-family: monospace; font-size: 13px; min-width: 100px;';
  timeDisplay.textContent = '0:00 / 0:00';

  // Timeline scrubber
  const timeline = document.createElement('input');
  timeline.type = 'range';
  timeline.min = '0';
  timeline.max = '0';
  timeline.value = '0';
  timeline.style.cssText = 'flex: 1; cursor: pointer;';
  timeline.addEventListener('input', (e) => {
    _seekTo(parseInt(e.target.value, 10));
  });

  // Speed selector
  const speedSelect = document.createElement('select');
  speedSelect.style.cssText = 'padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-overlay); color: var(--text); font-size: 12px;';
  speedSelect.innerHTML = `
    <option value="0.5">0.5x</option>
    <option value="1" selected>1x</option>
    <option value="2">2x</option>
    <option value="4">4x</option>
  `;
  speedSelect.addEventListener('change', (e) => {
    _playbackSpeed = parseFloat(e.target.value);
  });

  controlBar.appendChild(playBtn);
  controlBar.appendChild(timeDisplay);
  controlBar.appendChild(timeline);
  controlBar.appendChild(speedSelect);
  wrapper.appendChild(controlBar);

  container.appendChild(wrapper);

  // =========================================================================
  // Loading
  // =========================================================================

  async function load(recordingId) {
    _stop();

    // Fetch recording metadata
    const metaResponse = await chrome.runtime.sendMessage({
      type: MSG_TYPES.SESSION_GET_RECORDING,
      data: { id: recordingId },
    });
    _recording = metaResponse?.data;
    if (!_recording) {
      infoLabel.textContent = 'Recording not found.';
      return;
    }

    // Fetch all chunks
    const chunksResponse = await chrome.runtime.sendMessage({
      type: MSG_TYPES.SESSION_GET_CHUNKS,
      data: { recordingId },
    });
    _chunks = (chunksResponse?.data || []).sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (_chunks.length === 0) {
      infoLabel.textContent = 'No recording data found.';
      return;
    }

    // Flatten all events from all chunks
    _allMutations = [];
    _allEvents = [];
    _allConsole = [];
    _allNetwork = [];

    for (const chunk of _chunks) {
      if (chunk.data.mutations) _allMutations.push(...chunk.data.mutations);
      if (chunk.data.events) _allEvents.push(...chunk.data.events);
      if (chunk.data.console) _allConsole.push(...chunk.data.console);
      if (chunk.data.network) _allNetwork.push(...chunk.data.network);
    }

    // Sort all by timestamp
    _allMutations.sort((a, b) => a.t - b.t);
    _allEvents.sort((a, b) => a.t - b.t);
    _allConsole.sort((a, b) => a.t - b.t);
    _allNetwork.sort((a, b) => a.t - b.t);

    _duration = _recording.duration || 0;
    _currentTime = 0;

    // Update UI
    infoLabel.textContent = `${_recording.name || _recording.id} | ${_recording.url}`;
    timeline.max = String(_duration);
    timeline.value = '0';
    _updateTimeDisplay();

    // Load initial snapshot into iframe
    const initialSnapshot = _chunks[0]?.data?.initialSnapshot;
    if (initialSnapshot) {
      const blob = new Blob([initialSnapshot], { type: 'text/html' });
      _iframe.src = URL.createObjectURL(blob);
    }

    // Render initial state of panels
    _renderPanels();
  }

  // =========================================================================
  // Playback
  // =========================================================================

  function _play() {
    if (_playing) return;
    if (_currentTime >= _duration) {
      _currentTime = 0; // Reset if at end
    }
    _playing = true;
    playBtn.textContent = 'Pause';

    const TICK_MS = 50; // Update every 50ms
    _playInterval = setInterval(() => {
      _currentTime += TICK_MS * _playbackSpeed;

      if (_currentTime >= _duration) {
        _currentTime = _duration;
        _pause();
      }

      _applyStateAtTime(_currentTime);
      timeline.value = String(Math.floor(_currentTime));
      _updateTimeDisplay();
    }, TICK_MS);
  }

  function _pause() {
    _playing = false;
    playBtn.textContent = 'Play';
    if (_playInterval) {
      clearInterval(_playInterval);
      _playInterval = null;
    }
  }

  function _stop() {
    _pause();
    _currentTime = 0;
    _recording = null;
    _chunks = [];
    _allMutations = [];
    _allEvents = [];
    _allConsole = [];
    _allNetwork = [];
  }

  function _seekTo(timeMs) {
    _currentTime = Math.max(0, Math.min(timeMs, _duration));
    _applyStateAtTime(_currentTime);
    _updateTimeDisplay();
  }

  // =========================================================================
  // State Application
  // =========================================================================

  /**
   * Apply the recording state at a given time offset.
   * Replays mutations up to this point, shows events, and updates panels.
   */
  function _applyStateAtTime(timeMs) {
    // Apply DOM mutations up to this time
    // (For simplicity, we re-apply from the initial snapshot and replay all mutations up to timeMs)
    // In a production implementation, you'd maintain a cursor for efficiency

    // Show click indicators for recent events
    _showClickIndicators(timeMs);

    // Update panels
    _renderPanels(timeMs);
  }

  function _showClickIndicators(timeMs) {
    clickOverlay.innerHTML = '';

    // Show click events from the last 500ms
    const recentClicks = _allEvents.filter(
      e => e.type === 'click' && e.t >= timeMs - 500 && e.t <= timeMs
    );

    for (const click of recentClicks) {
      const indicator = document.createElement('div');
      const age = timeMs - click.t;
      const opacity = 1 - (age / 500);
      const scale = 1 + (age / 500);
      indicator.style.cssText = `
        position: absolute;
        left: ${click.x}px;
        top: ${click.y}px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(249, 226, 175, ${opacity * 0.5});
        border: 2px solid rgba(249, 226, 175, ${opacity});
        transform: translate(-50%, -50%) scale(${scale});
        pointer-events: none;
      `;
      clickOverlay.appendChild(indicator);
    }
  }

  // =========================================================================
  // Panel Rendering
  // =========================================================================

  function _renderPanels(upToTime) {
    const t = upToTime || _currentTime;

    // Network panel
    const visibleNetwork = _allNetwork.filter(n => n.t <= t);
    networkList.innerHTML = '';
    for (const entry of visibleNetwork.slice(-50)) { // Show last 50
      const row = document.createElement('div');
      row.style.cssText = `
        padding: 4px 12px; font-size: 12px; border-bottom: 1px solid var(--border, #313244);
        display: flex; align-items: center; gap: 8px;
      `;

      const statusColor = entry.type === 'response'
        ? (entry.status < 400 ? '#a6e3a1' : '#f38ba8')
        : '#89b4fa';

      row.innerHTML = `
        <span style="color: ${statusColor}; font-weight: 500; min-width: 36px;">${entry.type === 'response' ? entry.status : entry.method}</span>
        <span style="color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${_escapeHTML(entry.url || '')}</span>
        <span style="color: var(--text-muted); font-size: 11px;">${_formatTime(entry.t)}</span>
      `;
      networkList.appendChild(row);
    }
    networkList.scrollTop = networkList.scrollHeight;

    // Console panel
    const visibleConsole = _allConsole.filter(c => c.t <= t);
    consoleList.innerHTML = '';
    for (const entry of visibleConsole.slice(-100)) { // Show last 100
      const row = document.createElement('div');

      const levelColors = {
        log: 'var(--text, #cdd6f4)',
        info: '#89b4fa',
        warn: '#f9e2af',
        error: '#f38ba8',
        debug: '#a6adc8',
      };

      row.style.cssText = `
        padding: 3px 12px; font-size: 12px; font-family: monospace;
        border-bottom: 1px solid var(--border, #313244);
        color: ${levelColors[entry.level] || 'var(--text)'};
        line-height: 1.4;
      `;

      const argsStr = (entry.args || []).map(a =>
        typeof a === 'object' ? JSON.stringify(a) : String(a)
      ).join(' ');

      row.innerHTML = `
        <span style="color: var(--text-muted); font-size: 10px; margin-right: 8px;">${_formatTime(entry.t)}</span>
        <span style="font-weight: 500; margin-right: 6px;">[${entry.level}]</span>
        ${_escapeHTML(argsStr.substring(0, 200))}
      `;

      consoleList.appendChild(row);
    }
    consoleList.scrollTop = consoleList.scrollHeight;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  function _updateTimeDisplay() {
    timeDisplay.textContent = `${_formatTime(_currentTime)} / ${_formatTime(_duration)}`;
  }

  function _formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function _escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    load,
    play: _play,
    pause: _pause,
    stop: _stop,
    seekTo: _seekTo,
  };
}
```

### Registration in Options Page

In `options/options.js`:

```javascript
import { initSessionList } from './components/session-list.js';
import { initSessionPlayer } from './components/session-player.js';

// In the tab initialization section:
const recordingsContainer = document.getElementById('recordings-container');
if (recordingsContainer) {
  const playerContainer = document.createElement('div');
  playerContainer.id = 'session-player-container';
  playerContainer.style.display = 'none';
  playerContainer.style.height = '100%';
  recordingsContainer.parentElement.appendChild(playerContainer);

  const player = initSessionPlayer(playerContainer, {
    onBack: () => {
      playerContainer.style.display = 'none';
      recordingsContainer.style.display = 'block';
      sessionList.refresh();
    },
  });

  const sessionList = initSessionList(recordingsContainer, {
    onPlay: (recordingId) => {
      recordingsContainer.style.display = 'none';
      playerContainer.style.display = 'flex';
      player.load(recordingId);
    },
  });
}
```

In `options/options.html`:

```html
<!-- Add to tab navigation -->
<button class="ni-tab" data-tab="recordings">Recordings</button>

<!-- Add the container -->
<div id="recordings-container" class="ni-tab-content" data-tab="recordings" style="display: none;"></div>
```

## Verification

### Step 1: Verify Extension Loads

1. Load the extension in Chrome (chrome://extensions > Load unpacked)
2. Confirm no errors in the service worker console
3. Open the Options page -- verify "Recordings" tab appears

### Step 2: Start Recording

1. Navigate to any web page (e.g., https://example.com)
2. Open the Options page, go to "Recordings" tab
3. Click "Start Recording" -- button changes to "Stop Recording"
4. Interact with the page: click links, scroll, type in fields

### Step 3: Stop Recording

1. Click "Stop Recording" (or wait for 5-minute auto-stop)
2. The recording appears in the list with: name, URL, duration, chunk count, size

### Step 4: Verify Recording Data

1. Open Chrome DevTools > Application > IndexedDB > NeuronInterceptorDB
2. Check `session_recordings` store -- should contain the metadata entry
3. Check `session_recording_chunks` store -- should contain 1+ chunks
4. Verify chunk 0 has `initialSnapshot` (HTML string)
5. Verify chunks have `mutations`, `events`, `console`, `network` arrays

### Step 5: Playback

1. Click "Play" on a completed recording
2. The player view opens with:
   - Top: back button, recording info
   - Center-left: DOM replay in iframe (shows the initial snapshot)
   - Center-right: Network and Console panels
   - Bottom: play/pause button, time display, timeline scrubber, speed selector
3. Click "Play" -- the timeline advances
4. Verify: network entries appear as they occurred in time
5. Verify: console messages appear with timestamps
6. Verify: click indicators flash on the iframe at click positions
7. Drag the timeline scrubber -- panels update to show events up to that point
8. Change speed to 2x -- playback speeds up

### Step 6: Export

1. Click "Export" on a recording in the list
2. A `.neuron-session` file downloads (JSON format)
3. Open the file -- verify it contains metadata + all chunks

### Step 7: Delete

1. Click "Delete" on a recording
2. Confirm the prompt
3. The recording disappears from the list
4. Verify IndexedDB stores no longer contain the recording data

### Step 8: Multiple Recordings

1. Create 3+ recordings on different pages
2. Verify they all appear in the list, sorted by date (newest first)
3. Verify each can be played back independently

### Step 9: Auto-Stop

1. Start a recording and wait for 5 minutes (or set maxDurationMs to 10000 for testing)
2. Verify the recording auto-stops and shows status "completed"
3. Verify a notification appears in the console: "[Neuron] Session recording stopped"

### Step 10: Large Page Test

1. Navigate to a complex page (e.g., Gmail, GitHub, NMS dashboard)
2. Start recording and interact for 2 minutes
3. Verify recording doesn't cause noticeable page lag
4. Verify chunk sizes are reasonable (under 5MB each)
5. Play back the recording -- verify DOM snapshot loads correctly
