# Feature 2.1: Record Session & Export as Test Fixtures

**Priority**: Phase 2 - Test Automation (Differentiator)
**Status**: NOT STARTED
**Depends On**: None
**Estimated Effort**: Large (8-12 hours)

---

## Overview

Add the ability to record all API traffic during a browsing session and export the captured data as test fixtures in multiple formats. This is the foundational feature for the test automation pipeline: users browse the application normally while the extension captures every request/response pair, then exports them as ready-to-use mock data files, YAML test definitions, rule sets, and HAR archives.

---

## Architecture Context

### Current State

- **Logging**: `interceptor-inject.js` posts log entries via `postLog()` to the content script, which forwards them to the service worker for IndexedDB storage. However, log entries currently only capture metadata (URL, method, status, duration, headers) -- **response bodies are NOT captured** for passthrough (non-intercepted) requests.
- **Storage**: IndexedDB `request_logs` store holds log entries. `mock_bodies` store exists for large payloads.
- **Export**: The existing Import/Export component (`options/components/import-export.js`) exports rules/settings/mockCollections as JSON. It does NOT export request logs or response bodies.
- **Test Framework**: `health_check/test_declarative_runner.py` reads YAML from `health_check/test_definitions/*.yml`, uses `inject_proxy_interceptor()` from `page_validations.py`, and Flask proxy at `health_check/api_expectation_generator.py` on port 5000.

### Target State

- A "Record" toggle in the popup captures ALL request/response traffic (including full response bodies) into session-scoped storage.
- On stop, the user can name the session and export in four formats: Mock JSON files, YAML test definition, Rule set JSON, and HAR.
- A new "Test Export" panel in the options page provides the export UI with format selection, preview, and download.

---

## Detailed Design

### 1. Recording State Management

Recording state is stored in `chrome.storage.session` (session-scoped, automatically cleared on browser restart). This prevents stale recording state from persisting across sessions.

**Storage Keys** (add to `shared/constants.js`):

```javascript
// Add to STORAGE_KEYS:
RECORDING_STATE: 'neuron_recording_state',    // { active: boolean, startedAt: number, sessionName: string }
RECORDING_BUFFER: 'neuron_recording_buffer',  // Array of captured entries with full bodies

// Add to MSG_TYPES:
START_RECORDING: 'START_RECORDING',
STOP_RECORDING: 'STOP_RECORDING',
GET_RECORDING_STATUS: 'GET_RECORDING_STATUS',
GET_RECORDING_DATA: 'GET_RECORDING_DATA',
EXPORT_RECORDING: 'EXPORT_RECORDING',
```

**Recording Buffer Entry Schema**:

```javascript
{
  id: string,              // unique ID
  timestamp: number,       // Date.now()
  url: string,             // full request URL
  method: string,          // HTTP method
  statusCode: number,      // response status
  duration: number,        // ms
  requestHeaders: object,  // { headerName: value }
  requestBody: string|null, // serialized request body
  responseHeaders: object, // { headerName: value }
  responseBody: string|null, // FULL response body text (cloned)
  contentType: string,     // response Content-Type
  intercepted: boolean,    // whether a rule matched
  matchedRuleName: string|null,
  size: number,            // approximate response size in bytes
}
```

### 2. Files to Modify

#### 2.1 `shared/constants.js`

Add new storage keys and message types:

```javascript
// Inside STORAGE_KEYS, add:
RECORDING_STATE: 'neuron_recording_state',
RECORDING_BUFFER: 'neuron_recording_buffer',

// Inside MSG_TYPES, add:
START_RECORDING: 'START_RECORDING',
STOP_RECORDING: 'STOP_RECORDING',
GET_RECORDING_STATUS: 'GET_RECORDING_STATUS',
GET_RECORDING_DATA: 'GET_RECORDING_DATA',
EXPORT_RECORDING: 'EXPORT_RECORDING',
```

#### 2.2 `content/interceptor-inject.js`

Modify the `postLog()` calls throughout the file to include response body when recording is active. The interceptor must clone response bodies before they are consumed.

**Key changes to `interceptor-inject.js`**:

Add a `_recording` flag to the state section:

```javascript
// Add to State section (after line ~20):
let _recording = false;
```

Listen for recording state changes from the content script:

```javascript
// Add inside the existing window.addEventListener('message', ...) handler,
// after the RULES_UPDATED case:
if (event.data.type === 'RECORDING_STATE_CHANGED') {
  _recording = event.data.data.active;
  console.log('[Neuron] Recording state:', _recording ? 'ACTIVE' : 'STOPPED');
}
```

Modify the **fetch override** (the `window.fetch = async function(...)` block) to clone and capture response bodies when recording:

```javascript
// In the fetch override, REPLACE the passthrough section (currently around line 344-355):
// Before: just calls postLog with metadata only
// After: clone response and capture body when recording

// No match - passthrough with optional logging
const resp = await originalFetch.apply(this, arguments);
if (enabled) {
  const logEntry = {
    url,
    method,
    statusCode: resp.status,
    duration: Math.round(performance.now() - startTime),
    intercepted: false,
    requestHeaders: headers,
    requestBody: null,
  };

  // Capture request body if recording
  if (_recording) {
    try {
      if (init.body) {
        logEntry.requestBody = typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body);
      }
    } catch (_) {}
  }

  // Capture response body if recording
  if (_recording) {
    try {
      const cloned = resp.clone();
      const bodyText = await cloned.text();
      logEntry.responseBody = bodyText;
      logEntry.responseHeaders = {};
      resp.headers.forEach((value, key) => {
        logEntry.responseHeaders[key] = value;
      });
      logEntry.contentType = resp.headers.get('content-type') || '';
      logEntry.size = bodyText.length;
    } catch (err) {
      console.warn('[Neuron] Failed to clone response body:', err);
    }
  }

  postLog(logEntry);
}
return resp;
```

Similarly, modify the **intercepted request paths** (matched rule and matched mock blocks) to include response bodies when recording. For the rule-matched fetch path (around line 301-316):

```javascript
// Inside the matchedRule block, after getting result:
const result = await applyAction(matchedRule, url, init);
const duration = performance.now() - startTime;
const logEntry = {
  url,
  method,
  statusCode: result.response?.status,
  duration: Math.round(duration),
  matchedRuleId: matchedRule.id,
  matchedRuleName: matchedRule.name,
  actionTaken: matchedRule.action.type,
  intercepted: true,
  requestHeaders: headers,
};

// Capture bodies when recording
if (_recording && result.response) {
  try {
    const cloned = result.response.clone();
    const bodyText = await cloned.text();
    logEntry.responseBody = bodyText;
    logEntry.responseHeaders = {};
    result.response.headers.forEach((value, key) => {
      logEntry.responseHeaders[key] = value;
    });
    logEntry.contentType = result.response.headers.get('content-type') || '';
    logEntry.size = bodyText.length;
  } catch (_) {}
  try {
    if (init.body) {
      logEntry.requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    }
  } catch (_) {}
}

postLog(logEntry);
return result.response;
```

The XHR override paths similarly need request/response body capture. For the passthrough XHR case (around line 637-651):

```javascript
// In the XHR passthrough section, modify the onload handler:
if (enabled) {
  const origOnLoad = xhr.onload;
  xhr.onload = function () {
    const logEntry = {
      url,
      method,
      statusCode: xhr.status,
      duration: Math.round(performance.now() - startTime),
      intercepted: false,
    };

    if (_recording) {
      try {
        logEntry.requestBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        logEntry.responseBody = xhr.responseText || null;
        logEntry.responseHeaders = {};
        const rawHeaders = xhr.getAllResponseHeaders();
        if (rawHeaders) {
          rawHeaders.split('\r\n').forEach(line => {
            const idx = line.indexOf(': ');
            if (idx > 0) logEntry.responseHeaders[line.slice(0, idx)] = line.slice(idx + 2);
          });
        }
        logEntry.contentType = xhr.getResponseHeader('content-type') || '';
        logEntry.size = (xhr.responseText || '').length;
      } catch (_) {}
    }

    postLog(logEntry);
    if (origOnLoad) origOnLoad.call(xhr);
  };
}
```

#### 2.3 `content/content-script.js`

Add forwarding for recording state messages from the service worker to the inject script:

```javascript
// Add a new case in the chrome.runtime.onMessage.addListener switch (around line 76):
case 'RECORDING_STATE_CHANGED':
  window.postMessage({
    source: 'neuron-interceptor-content',
    type: 'RECORDING_STATE_CHANGED',
    data: message.data
  }, '*');
  sendResponse({ ok: true });
  break;
```

#### 2.4 `service-worker/storage-manager.js`

Add recording state management functions:

```javascript
/* -------------------------------------------------------------------------- */
/*  chrome.storage.session — Recording state                                  */
/* -------------------------------------------------------------------------- */

/**
 * Get current recording state.
 * @returns {Promise<{active: boolean, startedAt: number|null, sessionName: string}>}
 */
export async function getRecordingState() {
  const result = await chrome.storage.session.get('neuron_recording_state');
  return result.neuron_recording_state || { active: false, startedAt: null, sessionName: '' };
}

/**
 * Set recording state.
 * @param {Object} state
 */
export async function setRecordingState(state) {
  await chrome.storage.session.set({ neuron_recording_state: state });
}

/**
 * Get the recording buffer (captured entries with full bodies).
 * @returns {Promise<Array>}
 */
export async function getRecordingBuffer() {
  const result = await chrome.storage.session.get('neuron_recording_buffer');
  return result.neuron_recording_buffer || [];
}

/**
 * Append an entry to the recording buffer.
 * @param {Object} entry
 */
export async function appendRecordingEntry(entry) {
  const buffer = await getRecordingBuffer();
  buffer.push(entry);
  await chrome.storage.session.set({ neuron_recording_buffer: buffer });
}

/**
 * Clear the recording buffer.
 */
export async function clearRecordingBuffer() {
  await chrome.storage.session.set({ neuron_recording_buffer: [] });
}
```

#### 2.5 `service-worker/message-router.js`

Add handlers for the new recording message types.

Import the new functions:

```javascript
// Add to imports from storage-manager.js:
import {
  // ... existing imports ...
  getRecordingState,
  setRecordingState,
  getRecordingBuffer,
  appendRecordingEntry,
  clearRecordingBuffer,
} from './storage-manager.js';
```

Add cases to the `_route` function's switch statement:

```javascript
/* ---- Recording ---- */
case MSG_TYPES.START_RECORDING: {
  await clearRecordingBuffer();
  const state = { active: true, startedAt: Date.now(), sessionName: '' };
  await setRecordingState(state);

  // Notify all tabs to start recording
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'RECORDING_STATE_CHANGED',
        data: { active: true }
      });
    } catch (_) {}
  }

  return state;
}

case MSG_TYPES.STOP_RECORDING: {
  const sessionName = payload?.sessionName || `session-${Date.now()}`;
  const state = { active: false, startedAt: null, sessionName };
  await setRecordingState(state);

  // Notify all tabs to stop recording
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'RECORDING_STATE_CHANGED',
        data: { active: false }
      });
    } catch (_) {}
  }

  return { ok: true, sessionName };
}

case MSG_TYPES.GET_RECORDING_STATUS:
  return getRecordingState();

case MSG_TYPES.GET_RECORDING_DATA:
  return getRecordingBuffer();

case MSG_TYPES.EXPORT_RECORDING: {
  const buffer = await getRecordingBuffer();
  const recordingState = await getRecordingState();
  return {
    sessionName: recordingState.sessionName || payload?.sessionName || 'unnamed',
    entries: buffer,
    exportedAt: new Date().toISOString(),
  };
}
```

Also modify the existing `LOG_REQUEST` handler to additionally buffer entries when recording:

```javascript
case MSG_TYPES.LOG_REQUEST: {
  await addLogEntry(payload);

  // If recording is active, also buffer the full entry
  const recState = await getRecordingState();
  if (recState.active) {
    await appendRecordingEntry({
      ...payload,
      timestamp: payload.timestamp || Date.now(),
      id: payload.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    });
  }

  return { ok: true };
}
```

#### 2.6 `popup/popup.html`

Add a recording button row between the stats row and the "Recent Intercepts" section label:

```html
<!-- Recording Controls (insert after stats-row div, before section-label div) -->
<div class="recording-row" id="recordingRow">
  <button class="record-btn" id="recordBtn" title="Start/Stop Recording">
    <span class="record-dot" id="recordDot"></span>
    <span class="record-label" id="recordLabel">Record</span>
  </button>
  <span class="record-status" id="recordStatus"></span>
  <span class="record-count" id="recordCount" title="Captured requests"></span>
</div>
```

#### 2.7 `popup/popup.js`

Add recording functionality.

Add new MSG_TYPES:

```javascript
// Add to the MSG_TYPES object at the top:
const MSG_TYPES = {
  GET_STATUS:          'GET_STATUS',
  TOGGLE_ENABLED:      'TOGGLE_ENABLED',
  GET_LOGS:            'GET_LOGS',
  CLEAR_LOGS:          'CLEAR_LOGS',
  START_RECORDING:     'START_RECORDING',
  STOP_RECORDING:      'STOP_RECORDING',
  GET_RECORDING_STATUS: 'GET_RECORDING_STATUS',
  GET_RECORDING_DATA:  'GET_RECORDING_DATA',
};
```

Add DOM references:

```javascript
const $recordBtn    = document.getElementById('recordBtn');
const $recordDot    = document.getElementById('recordDot');
const $recordLabel  = document.getElementById('recordLabel');
const $recordStatus = document.getElementById('recordStatus');
const $recordCount  = document.getElementById('recordCount');
```

Add recording state and rendering:

```javascript
/* -------------------------------------------------------------------------- */
/*  Recording state                                                           */
/* -------------------------------------------------------------------------- */

let _isRecording = false;
let _recordingTimer = null;

/**
 * Update the recording button UI to reflect the current state.
 * @param {boolean} active
 * @param {number} [entryCount=0]
 */
function renderRecordingState(active, entryCount = 0) {
  _isRecording = active;
  $recordDot.classList.toggle('recording-active', active);
  $recordLabel.textContent = active ? 'Stop' : 'Record';
  $recordBtn.classList.toggle('active', active);
  $recordBtn.title = active ? 'Stop Recording' : 'Start Recording';
  $recordStatus.textContent = active ? 'Recording...' : '';
  $recordCount.textContent = active && entryCount > 0 ? `${entryCount} req` : '';
}

/**
 * Poll the recording buffer count while recording is active.
 */
function startRecordingPoller() {
  stopRecordingPoller();
  _recordingTimer = setInterval(async () => {
    try {
      const data = await sendMsg(MSG_TYPES.GET_RECORDING_DATA);
      const entries = Array.isArray(data) ? data : (data?.entries || data || []);
      $recordCount.textContent = entries.length > 0 ? `${entries.length} req` : '';
    } catch (_) {}
  }, 2000);
}

function stopRecordingPoller() {
  if (_recordingTimer) {
    clearInterval(_recordingTimer);
    _recordingTimer = null;
  }
}

/** Fetch recording status on popup open. */
async function refreshRecordingStatus() {
  try {
    const state = await sendMsg(MSG_TYPES.GET_RECORDING_STATUS);
    if (state) {
      renderRecordingState(state.active === true);
      if (state.active) {
        startRecordingPoller();
      }
    }
  } catch (_) {}
}

/** Toggle recording on/off. */
$recordBtn.addEventListener('click', async () => {
  if (_isRecording) {
    // Stop recording - prompt for session name
    const sessionName = prompt('Enter a name for this recording session:', `session-${Date.now()}`);
    if (sessionName === null) return; // User cancelled

    try {
      await sendMsg(MSG_TYPES.STOP_RECORDING, { sessionName });
      renderRecordingState(false);
      stopRecordingPoller();
    } catch (err) {
      console.warn('[NeuronPopup] Stop recording failed:', err);
    }
  } else {
    // Start recording
    try {
      await sendMsg(MSG_TYPES.START_RECORDING);
      renderRecordingState(true);
      startRecordingPoller();
    } catch (err) {
      console.warn('[NeuronPopup] Start recording failed:', err);
    }
  }
});
```

Update the DOMContentLoaded handler:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  refreshLogs();
  refreshRecordingStatus();
});
```

#### 2.8 `popup/popup.css`

Add recording styles:

```css
/* -------------------------------------------------------------------------- */
/*  Recording Controls                                                        */
/* -------------------------------------------------------------------------- */

.recording-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  flex-shrink: 0;
}

.record-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 6px;
  padding: 5px 12px;
  color: #cdd6f4;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

.record-btn:hover {
  background: #45475a;
}

.record-btn.active {
  background: #3a1e1e;
  border-color: #f38ba8;
}

.record-btn.active:hover {
  background: #4a2e2e;
}

.record-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #585b70;
  transition: background-color 0.3s ease;
}

.record-dot.recording-active {
  background: #f38ba8;
  animation: record-pulse 1.2s ease-in-out infinite;
}

@keyframes record-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.record-status {
  font-size: 11px;
  color: #f38ba8;
  font-weight: 500;
}

.record-count {
  font-size: 11px;
  color: #6c7086;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
```

### 3. New Files to Create

#### 3.1 `options/components/test-export.js`

This is the main export UI component mounted in the options page. It provides a panel where users can:
- Select export formats (checkboxes for each format)
- Enter/edit the session name
- Preview generated files
- Download individual files or all at once

```javascript
/**
 * Neuron Interceptor - Test Export Component
 *
 * Provides UI for exporting recorded API traffic as test fixtures in
 * multiple formats: Mock JSON, YAML test definition, Rule set, and HAR.
 */

import { MSG_TYPES } from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function sendMessage(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

/**
 * Sanitize a URL path into a safe filename segment.
 * /neuron-api/visualization/api/fleet-summary/get-metrics/v3
 * -> fleet-summary_get-metrics_v3
 *
 * @param {string} url - Full URL string
 * @returns {string} Sanitized filename segment
 */
function sanitizeUrlToFilename(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    // Remove common prefixes
    path = path.replace(/^\/(neuron-api|api|v\d+)\//i, '/');
    path = path.replace(/^\/visualization\/api\//, '/');
    // Remove leading/trailing slashes
    path = path.replace(/^\/+|\/+$/g, '');
    // Replace slashes with underscores
    path = path.replace(/\//g, '_');
    // Remove non-alphanumeric chars except underscores and hyphens
    path = path.replace(/[^a-zA-Z0-9_-]/g, '');
    // Collapse multiple underscores
    path = path.replace(/_+/g, '_');
    return path || 'unknown-endpoint';
  } catch (_) {
    return 'unknown-endpoint';
  }
}

/**
 * Group recorded entries by API endpoint (URL path without query params).
 * For each unique endpoint, keeps the most recent response.
 *
 * @param {Array} entries - Recorded buffer entries
 * @returns {Map<string, Object>} endpointKey -> { url, method, entry, filename }
 */
function groupByEndpoint(entries) {
  const groups = new Map();

  for (const entry of entries) {
    if (!entry.url) continue;

    let key;
    try {
      const u = new URL(entry.url);
      key = `${entry.method || 'GET'}_${u.pathname}`;
    } catch (_) {
      key = `${entry.method || 'GET'}_${entry.url}`;
    }

    // Keep the most recent entry for each endpoint
    const existing = groups.get(key);
    if (!existing || (entry.timestamp || 0) > (existing.entry.timestamp || 0)) {
      groups.set(key, {
        url: entry.url,
        method: entry.method || 'GET',
        entry,
        filename: sanitizeUrlToFilename(entry.url),
      });
    }
  }

  return groups;
}

/* -------------------------------------------------------------------------- */
/*  Export Format Generators                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generate Mock JSON files content.
 * Returns an array of { filename, content } objects.
 *
 * @param {Array} entries - Recorded buffer entries
 * @param {string} sessionName - Session identifier
 * @returns {Array<{filename: string, content: string}>}
 */
function generateMockJsonFiles(entries, sessionName) {
  const groups = groupByEndpoint(entries);
  const files = [];

  for (const [key, group] of groups) {
    let bodyContent = '{}';
    if (group.entry.responseBody) {
      try {
        // Try to parse and re-format JSON for readability
        const parsed = JSON.parse(group.entry.responseBody);
        bodyContent = JSON.stringify(parsed, null, 2);
      } catch (_) {
        bodyContent = group.entry.responseBody;
      }
    }

    files.push({
      filename: `${sessionName}/${group.filename}.json`,
      content: bodyContent,
    });
  }

  return files;
}

/**
 * Generate a YAML test definition scaffold matching the
 * health_check/test_definitions/fleet_summary.yml format.
 *
 * @param {Array} entries - Recorded buffer entries
 * @param {string} sessionName - Session identifier
 * @param {string} pageUrl - The page URL that was browsed during recording
 * @returns {string} YAML content
 */
function generateYamlTestDefinition(entries, sessionName, pageUrl) {
  const groups = groupByEndpoint(entries);

  // Infer page_name from sessionName or URL
  const pageName = sessionName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

  // Determine the primary API endpoint (the one with the most requests)
  let primaryEndpoint = '';
  let maxCount = 0;
  const endpointCounts = {};
  for (const entry of entries) {
    if (!entry.url) continue;
    try {
      const u = new URL(entry.url);
      const path = u.pathname;
      endpointCounts[path] = (endpointCounts[path] || 0) + 1;
      if (endpointCounts[path] > maxCount) {
        maxCount = endpointCounts[path];
        primaryEndpoint = path;
      }
    } catch (_) {}
  }

  // Generate data_scenarios from grouped endpoints
  const dataScenarios = [];
  for (const [key, group] of groups) {
    dataScenarios.push({
      name: group.filename,
      description: `Recorded ${group.method} ${group.url}`,
      responseFile: `health_check/test_data/${pageName}/${group.filename}.json`,
    });
  }

  // Build YAML manually for precise formatting control
  let yaml = '';
  yaml += 'test_info:\n';
  yaml += `  test_suite_name: "${sessionName}"\n`;
  yaml += '  test_suite_type: "ui"\n';
  yaml += `  page_name: "${pageName}"\n`;
  yaml += `  page_url: "${pageUrl || '/'}"\n`;
  yaml += `  api_endpoint: "${primaryEndpoint}"\n`;
  yaml += `  module: "Recorded Session"\n`;
  yaml += '  execution: "serial"\n';
  yaml += '  runner_mode: "v1"\n';
  yaml += `  description: "Auto-generated test definition from recorded session: ${sessionName}"\n`;
  yaml += `  tags: ["ui", "recorded", "${pageName}"]\n`;
  yaml += '  priority: 1\n';
  yaml += '\n';
  yaml += 'scenarios:\n';
  yaml += `  ${pageName}_recorded_test: #p1, regression, recorded\n`;
  yaml += `    description: "Recorded data scenarios from session: ${sessionName}"\n`;
  yaml += '    priority: 1\n';
  yaml += `    tags: ["p1", "regression", "recorded"]\n`;
  yaml += '\n';
  yaml += '    data_scenarios:\n';

  for (const ds of dataScenarios) {
    yaml += `      - name: "${ds.name}"\n`;
    yaml += `        description: "${ds.description}"\n`;
    yaml += `        response_file: "${ds.responseFile}"\n`;
    yaml += '\n';
  }

  yaml += '    pre_test:\n';
  yaml += '      - navigate_to_page: true\n';
  yaml += '        per_scenario: false\n';
  yaml += '\n';
  yaml += '      - inject_proxy:\n';
  yaml += '          mode: "RESPONSE_ONLY"\n';
  yaml += '          step_tag: "{{scenario_name}}"\n';
  yaml += `          api_patterns: ["${primaryEndpoint.split('/').slice(-2).join('/')}"]\n`;
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '      - trigger_filter_reload: true\n';
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '      - wait_for_load: 3000\n';
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '    validations:\n';
  yaml += '      - method: "capture_step_kpis"\n';
  yaml += '        params:\n';
  yaml += '          step_tag: "{{scenario_name}}"\n';
  yaml += '\n';
  yaml += '      # TODO: Add additional validations specific to this page\n';
  yaml += '      # - method: "capture_step_tooltips"\n';
  yaml += '      #   params:\n';
  yaml += '      #     step_tag: "{{scenario_name}}"\n';
  yaml += '      #     max_tooltips: 20\n';
  yaml += '\n';
  yaml += '    post_test:\n';
  yaml += '      - action: stop_proxy\n';

  return yaml;
}

/**
 * Generate a Rule set JSON that mocks each captured endpoint with its
 * recorded response. Uses mock_inline action type.
 *
 * @param {Array} entries - Recorded buffer entries
 * @param {string} sessionName - Session identifier
 * @returns {string} JSON string of rule set
 */
function generateRuleSet(entries, sessionName) {
  const groups = groupByEndpoint(entries);
  const rules = [];

  let priority = groups.size;

  for (const [key, group] of groups) {
    let urlPattern;
    try {
      const u = new URL(group.url);
      urlPattern = u.pathname;
    } catch (_) {
      urlPattern = group.url;
    }

    const responseBody = group.entry.responseBody || '{}';
    const statusCode = group.entry.statusCode || 200;
    const contentType = group.entry.contentType || 'application/json';

    rules.push({
      id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `[${sessionName}] Mock ${group.method} ${group.filename}`,
      enabled: true,
      priority: priority--,
      condition: {
        url: { type: 'contains', value: urlPattern },
        headers: [],
        methods: [group.method],
      },
      action: {
        type: 'mock_inline',
        mockInline: {
          statusCode,
          headers: { 'Content-Type': contentType },
          body: responseBody,
        },
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    });
  }

  return JSON.stringify({ rules }, null, 2);
}

/**
 * Generate HAR (HTTP Archive) format export.
 * Follows the HAR 1.2 specification.
 *
 * @param {Array} entries - Recorded buffer entries
 * @param {string} sessionName - Session identifier
 * @returns {string} JSON string in HAR format
 */
function generateHar(entries, sessionName) {
  const harEntries = entries.map((entry) => {
    // Parse request headers
    const requestHeaders = [];
    if (entry.requestHeaders && typeof entry.requestHeaders === 'object') {
      for (const [name, value] of Object.entries(entry.requestHeaders)) {
        requestHeaders.push({ name, value: String(value) });
      }
    }

    // Parse response headers
    const responseHeaders = [];
    if (entry.responseHeaders && typeof entry.responseHeaders === 'object') {
      for (const [name, value] of Object.entries(entry.responseHeaders)) {
        responseHeaders.push({ name, value: String(value) });
      }
    }

    // Parse URL for query string
    let queryString = [];
    try {
      const u = new URL(entry.url);
      for (const [name, value] of u.searchParams) {
        queryString.push({ name, value });
      }
    } catch (_) {}

    // Request body
    const postData = entry.requestBody
      ? {
          mimeType: entry.requestHeaders?.['content-type'] || 'application/json',
          text: entry.requestBody,
        }
      : undefined;

    // Response body
    const responseContent = {
      size: entry.size || (entry.responseBody || '').length,
      mimeType: entry.contentType || 'application/json',
      text: entry.responseBody || '',
    };

    return {
      startedDateTime: new Date(entry.timestamp || Date.now()).toISOString(),
      time: entry.duration || 0,
      request: {
        method: entry.method || 'GET',
        url: entry.url || '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: requestHeaders,
        queryString,
        postData,
        headersSize: -1,
        bodySize: entry.requestBody ? entry.requestBody.length : 0,
      },
      response: {
        status: entry.statusCode || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: responseHeaders,
        content: responseContent,
        redirectURL: '',
        headersSize: -1,
        bodySize: responseContent.size,
      },
      cache: {},
      timings: {
        send: 0,
        wait: entry.duration || 0,
        receive: 0,
      },
    };
  });

  const har = {
    log: {
      version: '1.2',
      creator: {
        name: 'Neuron Interceptor',
        version: '1.0.0',
      },
      pages: [
        {
          startedDateTime: entries.length > 0
            ? new Date(entries[0].timestamp || Date.now()).toISOString()
            : new Date().toISOString(),
          id: sessionName,
          title: `Neuron Recording: ${sessionName}`,
          pageTimings: {
            onContentLoad: -1,
            onLoad: -1,
          },
        },
      ],
      entries: harEntries,
    },
  };

  return JSON.stringify(har, null, 2);
}

/* -------------------------------------------------------------------------- */
/*  Download helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Trigger a browser file download with the given content.
 *
 * @param {string} content - File content
 * @param {string} filename - Download filename
 * @param {string} [mimeType='application/json'] - MIME type
 */
function downloadFile(content, filename, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download multiple files sequentially. Since we cannot create a real ZIP
 * without a library, we trigger individual downloads with a small delay.
 *
 * @param {Array<{filename: string, content: string}>} files
 */
async function downloadAllFiles(files) {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Use a flat filename (replace directory separators)
    const flatName = f.filename.replace(/\//g, '_');
    downloadFile(f.content, flatName);
    // Small delay between downloads to avoid browser throttling
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Component init                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build and mount the Test Export interface.
 *
 * @param {HTMLElement} container - The DOM element to render into.
 */
export function initTestExport(container) {
  let _entries = [];
  let _sessionName = '';
  let _pageUrl = '';

  // ----- Markup ---------------------------------------------------------- //

  container.innerHTML = `
    <div class="te-wrapper">
      <!-- Session Info -->
      <div class="te-section">
        <h3 class="te-section-title">Recording Session</h3>
        <div class="te-session-info" id="teSessionInfo">
          <div class="te-empty-state">No recorded session data available. Use the Record button in the popup to capture API traffic.</div>
        </div>
      </div>

      <!-- Export Controls -->
      <div class="te-section te-export-section hidden" id="teExportSection">
        <h3 class="te-section-title">Export Formats</h3>

        <div class="te-form-row">
          <label class="te-label">Session Name</label>
          <input type="text" class="te-input" id="teSessionNameInput" placeholder="my-test-session">
        </div>

        <div class="te-form-row">
          <label class="te-label">Page URL (for YAML generation)</label>
          <input type="text" class="te-input" id="tePageUrlInput" placeholder="/monitoring/fleet-monitor">
        </div>

        <div class="te-format-grid">
          <label class="te-format-card">
            <input type="checkbox" class="te-format-cb" value="mock_json" checked>
            <div class="te-format-info">
              <strong>Mock JSON Files</strong>
              <span>Individual JSON files for each API endpoint response</span>
            </div>
          </label>

          <label class="te-format-card">
            <input type="checkbox" class="te-format-cb" value="yaml" checked>
            <div class="te-format-info">
              <strong>YAML Test Definition</strong>
              <span>Test scaffold matching test_definitions/*.yml format</span>
            </div>
          </label>

          <label class="te-format-card">
            <input type="checkbox" class="te-format-cb" value="rules" checked>
            <div class="te-format-info">
              <strong>Rule Set JSON</strong>
              <span>Interception rules that mock each captured endpoint</span>
            </div>
          </label>

          <label class="te-format-card">
            <input type="checkbox" class="te-format-cb" value="har">
            <div class="te-format-info">
              <strong>HAR Archive</strong>
              <span>Standard HTTP Archive (importable by Chrome DevTools)</span>
            </div>
          </label>
        </div>

        <div class="te-btn-row">
          <button class="btn btn-primary" id="teExportBtn">Export Selected</button>
          <button class="btn btn-secondary" id="teExportAllBtn">Export All Formats</button>
          <button class="btn btn-secondary" id="tePreviewBtn">Preview</button>
        </div>
      </div>

      <!-- Preview Area -->
      <div class="te-section hidden" id="tePreviewSection">
        <h3 class="te-section-title">Preview</h3>
        <div class="te-preview-tabs" id="tePreviewTabs"></div>
        <pre class="te-preview-code" id="tePreviewCode"></pre>
      </div>

      <!-- Endpoint Summary -->
      <div class="te-section hidden" id="teEndpointSection">
        <h3 class="te-section-title">Captured Endpoints</h3>
        <div class="te-endpoint-list" id="teEndpointList"></div>
      </div>
    </div>
  `;

  // ----- DOM refs -------------------------------------------------------- //

  const $sessionInfo      = container.querySelector('#teSessionInfo');
  const $exportSection    = container.querySelector('#teExportSection');
  const $sessionNameInput = container.querySelector('#teSessionNameInput');
  const $pageUrlInput     = container.querySelector('#tePageUrlInput');
  const $exportBtn        = container.querySelector('#teExportBtn');
  const $exportAllBtn     = container.querySelector('#teExportAllBtn');
  const $previewBtn       = container.querySelector('#tePreviewBtn');
  const $previewSection   = container.querySelector('#tePreviewSection');
  const $previewTabs      = container.querySelector('#tePreviewTabs');
  const $previewCode      = container.querySelector('#tePreviewCode');
  const $endpointSection  = container.querySelector('#teEndpointSection');
  const $endpointList     = container.querySelector('#teEndpointList');

  // ----- Internal -------------------------------------------------------- //

  function getSelectedFormats() {
    const checkboxes = container.querySelectorAll('.te-format-cb:checked');
    return Array.from(checkboxes).map((cb) => cb.value);
  }

  function renderSessionInfo() {
    if (_entries.length === 0) {
      $sessionInfo.innerHTML = '<div class="te-empty-state">No recorded session data available. Use the Record button in the popup to capture API traffic.</div>';
      $exportSection.classList.add('hidden');
      $endpointSection.classList.add('hidden');
      return;
    }

    const groups = groupByEndpoint(_entries);
    const totalSize = _entries.reduce((sum, e) => sum + (e.size || 0), 0);
    const duration = _entries.length > 1
      ? (_entries[_entries.length - 1].timestamp - _entries[0].timestamp)
      : 0;

    $sessionInfo.innerHTML = `
      <div class="te-stats-row">
        <div class="te-stat"><strong>${_entries.length}</strong> requests</div>
        <div class="te-stat"><strong>${groups.size}</strong> unique endpoints</div>
        <div class="te-stat"><strong>${(totalSize / 1024).toFixed(1)} KB</strong> total</div>
        <div class="te-stat"><strong>${(duration / 1000).toFixed(1)}s</strong> duration</div>
      </div>
    `;

    // Show export section
    $exportSection.classList.remove('hidden');

    // Render endpoint summary
    $endpointSection.classList.remove('hidden');
    $endpointList.innerHTML = '';

    for (const [key, group] of groups) {
      const row = document.createElement('div');
      row.className = 'te-endpoint-row';
      row.innerHTML = `
        <span class="te-endpoint-method te-method-${group.method}">${group.method}</span>
        <span class="te-endpoint-url" title="${group.url}">${group.filename}</span>
        <span class="te-endpoint-status">${group.entry.statusCode || '--'}</span>
        <span class="te-endpoint-size">${((group.entry.size || 0) / 1024).toFixed(1)} KB</span>
      `;
      $endpointList.appendChild(row);
    }
  }

  function generateExportFiles(formats) {
    const name = $sessionNameInput.value.trim() || _sessionName || 'unnamed-session';
    const pageUrl = $pageUrlInput.value.trim() || _pageUrl || '/';
    const files = [];

    if (formats.includes('mock_json')) {
      const mockFiles = generateMockJsonFiles(_entries, name);
      files.push(...mockFiles);
    }

    if (formats.includes('yaml')) {
      files.push({
        filename: `${name}_test_definition.yml`,
        content: generateYamlTestDefinition(_entries, name, pageUrl),
      });
    }

    if (formats.includes('rules')) {
      files.push({
        filename: `${name}_rules.json`,
        content: generateRuleSet(_entries, name),
      });
    }

    if (formats.includes('har')) {
      files.push({
        filename: `${name}.har`,
        content: generateHar(_entries, name),
      });
    }

    return files;
  }

  function renderPreview(format) {
    const name = $sessionNameInput.value.trim() || _sessionName || 'unnamed-session';
    const pageUrl = $pageUrlInput.value.trim() || _pageUrl || '/';

    let content = '';
    switch (format) {
      case 'mock_json': {
        const files = generateMockJsonFiles(_entries, name);
        content = files.map((f) => `// --- ${f.filename} ---\n${f.content}`).join('\n\n');
        break;
      }
      case 'yaml':
        content = generateYamlTestDefinition(_entries, name, pageUrl);
        break;
      case 'rules':
        content = generateRuleSet(_entries, name);
        break;
      case 'har':
        content = generateHar(_entries, name);
        break;
    }

    $previewCode.textContent = content;
    $previewSection.classList.remove('hidden');
  }

  // ----- Events ---------------------------------------------------------- //

  $exportBtn.addEventListener('click', async () => {
    const formats = getSelectedFormats();
    if (formats.length === 0) return;

    const files = generateExportFiles(formats);
    await downloadAllFiles(files);
  });

  $exportAllBtn.addEventListener('click', async () => {
    const files = generateExportFiles(['mock_json', 'yaml', 'rules', 'har']);
    await downloadAllFiles(files);
  });

  $previewBtn.addEventListener('click', () => {
    const formats = getSelectedFormats();
    if (formats.length === 0) return;

    // Build preview tabs
    $previewTabs.innerHTML = '';
    const labels = {
      mock_json: 'Mock JSON',
      yaml: 'YAML',
      rules: 'Rules',
      har: 'HAR',
    };

    formats.forEach((fmt, idx) => {
      const tab = document.createElement('button');
      tab.className = `te-preview-tab${idx === 0 ? ' active' : ''}`;
      tab.textContent = labels[fmt] || fmt;
      tab.addEventListener('click', () => {
        container.querySelectorAll('.te-preview-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        renderPreview(fmt);
      });
      $previewTabs.appendChild(tab);
    });

    renderPreview(formats[0]);
  });

  // ----- Load data ------------------------------------------------------- //

  async function loadRecordingData() {
    try {
      const data = await sendMessage(MSG_TYPES.GET_RECORDING_DATA);
      _entries = Array.isArray(data) ? data : (data?.entries || []);

      const state = await sendMessage(MSG_TYPES.GET_RECORDING_STATUS);
      _sessionName = state?.sessionName || '';
      $sessionNameInput.value = _sessionName;

      // Try to infer page URL from entries
      if (_entries.length > 0) {
        try {
          const firstUrl = new URL(_entries[0].url);
          _pageUrl = firstUrl.pathname;
          $pageUrlInput.value = _pageUrl;
        } catch (_) {}
      }

      renderSessionInfo();
    } catch (err) {
      console.warn('[TestExport] Failed to load recording data:', err);
      $sessionInfo.innerHTML = '<div class="te-empty-state">Failed to load recording data.</div>';
    }
  }

  loadRecordingData();
}
```

#### 3.2 `options/options.html`

Add a new nav item and content section for the test export panel.

Add a new navigation button inside the `<nav class="sidebar-nav" id="sidebarNav">` block (after the Settings button):

```html
<button class="nav-item" data-section="test-export">
  <span class="nav-icon">&#9209;</span>
  <span class="nav-label">Test Export</span>
</button>
```

Add a new content section inside the `<div class="content-area" id="contentArea">` block (after the Settings section):

```html
<!-- ----------------------------------------------------------------- -->
<!--  Test Export Section                                               -->
<!-- ----------------------------------------------------------------- -->
<section class="content-section" id="section-test-export">
  <div class="section-header">
    <h2 class="section-title">Test Export</h2>
    <div class="section-actions">
      <button class="btn btn-secondary" id="refreshRecordingBtn">Refresh Data</button>
    </div>
  </div>
  <div class="section-body">
    <div id="testExportContainer"></div>
  </div>
</section>
```

#### 3.3 `options/options.js`

Add the import and initialization of the test export component.

Add to the imports:

```javascript
import { initTestExport } from './components/test-export.js';
```

Add container reference in the `containers` object (inside the `init()` function):

```javascript
testExport: document.getElementById('testExportContainer'),
```

Add initialization call at the end of `init()`:

```javascript
initTestExport(containers.testExport);
```

#### 3.4 `options/options.css`

Add styles for the test export component. Append these styles to the existing file:

```css
/* ======================================================================== */
/*  Test Export Component Styles                                             */
/* ======================================================================== */

.te-wrapper {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.te-section {
  background: #181825;
  border: 1px solid #313244;
  border-radius: 8px;
  padding: 16px;
}

.te-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #cdd6f4;
  margin-bottom: 12px;
}

.te-empty-state {
  text-align: center;
  padding: 32px 16px;
  color: #585b70;
  font-style: italic;
}

.te-stats-row {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}

.te-stat {
  font-size: 13px;
  color: #a6adc8;
}

.te-stat strong {
  color: #89b4fa;
  font-variant-numeric: tabular-nums;
}

.te-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.te-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #a6adc8;
}

.te-input {
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 4px;
  color: #cdd6f4;
  font-size: 13px;
  padding: 6px 10px;
  outline: none;
}

.te-input:focus {
  border-color: #89b4fa;
}

.te-format-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

.te-format-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: #1e1e2e;
  border: 1px solid #313244;
  border-radius: 6px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.te-format-card:hover {
  border-color: #45475a;
}

.te-format-card:has(input:checked) {
  border-color: #89b4fa;
  background: #1e2d3a;
}

.te-format-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.te-format-info strong {
  font-size: 12px;
  color: #cdd6f4;
}

.te-format-info span {
  font-size: 11px;
  color: #6c7086;
}

.te-btn-row {
  display: flex;
  gap: 8px;
}

.te-preview-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.te-preview-tab {
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 4px 4px 0 0;
  color: #a6adc8;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.te-preview-tab:hover {
  background: #45475a;
}

.te-preview-tab.active {
  background: #89b4fa;
  color: #1e1e2e;
  border-color: #89b4fa;
}

.te-preview-code {
  background: #11111b;
  border: 1px solid #313244;
  border-radius: 0 4px 4px 4px;
  padding: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #cdd6f4;
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 400px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #45475a transparent;
}

.te-endpoint-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.te-endpoint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  transition: background 0.15s;
}

.te-endpoint-row:hover {
  background: #313244;
}

.te-endpoint-method {
  flex-shrink: 0;
  min-width: 48px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}

.te-method-GET    { background: #1e3a2f; color: #a6e3a1; }
.te-method-POST   { background: #2d2a1e; color: #f9e2af; }
.te-method-PUT    { background: #1e2d3a; color: #89b4fa; }
.te-method-DELETE { background: #3a1e1e; color: #f38ba8; }

.te-endpoint-url {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  color: #bac2de;
}

.te-endpoint-status {
  flex-shrink: 0;
  width: 40px;
  text-align: right;
  font-weight: 600;
  color: #a6e3a1;
  font-variant-numeric: tabular-nums;
}

.te-endpoint-size {
  flex-shrink: 0;
  width: 60px;
  text-align: right;
  color: #6c7086;
  font-variant-numeric: tabular-nums;
}
```

---

## HAR Format Specification Reference

The generated HAR follows version 1.2 of the HTTP Archive spec:

```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "Neuron Interceptor", "version": "1.0.0" },
    "pages": [{
      "startedDateTime": "2026-04-01T12:00:00.000Z",
      "id": "session-name",
      "title": "Neuron Recording: session-name",
      "pageTimings": { "onContentLoad": -1, "onLoad": -1 }
    }],
    "entries": [{
      "startedDateTime": "2026-04-01T12:00:01.000Z",
      "time": 150,
      "request": {
        "method": "POST",
        "url": "https://gamma.hub.quvia.ai/neuron-api/visualization/api/fleet-summary/get-metrics/v3",
        "httpVersion": "HTTP/1.1",
        "cookies": [],
        "headers": [{ "name": "Content-Type", "value": "application/json" }],
        "queryString": [],
        "postData": { "mimeType": "application/json", "text": "{...}" },
        "headersSize": -1,
        "bodySize": 1234
      },
      "response": {
        "status": 200,
        "statusText": "",
        "httpVersion": "HTTP/1.1",
        "cookies": [],
        "headers": [{ "name": "content-type", "value": "application/json" }],
        "content": { "size": 56789, "mimeType": "application/json", "text": "{...}" },
        "redirectURL": "",
        "headersSize": -1,
        "bodySize": 56789
      },
      "cache": {},
      "timings": { "send": 0, "wait": 150, "receive": 0 }
    }]
  }
}
```

---

## YAML Template Reference

The generated YAML matches the structure of the existing `health_check/test_definitions/fleet_summary.yml`:

```yaml
test_info:
  test_suite_name: "fleet-monitor-recording"
  test_suite_type: "ui"
  page_name: "fleet_monitor_recording"
  page_url: "/monitoring/fleet-monitor"
  api_endpoint: "/neuron-api/visualization/api/fleet-summary/get-metrics/v3"
  module: "Recorded Session"
  execution: "serial"
  runner_mode: "v1"
  description: "Auto-generated test definition from recorded session: fleet-monitor-recording"
  tags: ["ui", "recorded", "fleet_monitor_recording"]
  priority: 1

scenarios:
  fleet_monitor_recording_recorded_test: #p1, regression, recorded
    description: "Recorded data scenarios from session: fleet-monitor-recording"
    priority: 1
    tags: ["p1", "regression", "recorded"]

    data_scenarios:
      - name: "fleet-summary_get-metrics_v3"
        description: "Recorded POST /neuron-api/visualization/api/fleet-summary/get-metrics/v3"
        response_file: "health_check/test_data/fleet_monitor_recording/fleet-summary_get-metrics_v3.json"

    pre_test:
      - navigate_to_page: true
        per_scenario: false

      - inject_proxy:
          mode: "RESPONSE_ONLY"
          step_tag: "{{scenario_name}}"
          api_patterns: ["get-metrics/v3"]
        per_scenario: true

      - trigger_filter_reload: true
        per_scenario: true

      - wait_for_load: 3000
        per_scenario: true

    validations:
      - method: "capture_step_kpis"
        params:
          step_tag: "{{scenario_name}}"

    post_test:
      - action: stop_proxy
```

---

## Verification Steps

### Manual Testing

1. **Load the extension** in Chrome via `chrome://extensions/` (Developer mode, Load unpacked).

2. **Test recording toggle**:
   - Open the popup. Verify the Record button appears with a gray dot.
   - Click Record. Verify the dot turns red and pulses, label changes to "Stop".
   - Navigate to `https://gamma.hub.quvia.ai/monitoring/fleet-monitor`.
   - Wait for the page to load (observe API requests).
   - Check the popup -- the request count should increment.
   - Click Stop. Verify prompt for session name appears.
   - Enter "test-fleet-monitor" and confirm.
   - Verify the dot returns to gray and label returns to "Record".

3. **Test export UI**:
   - Open the Options page (click "Options" in popup footer).
   - Navigate to the "Test Export" tab in the sidebar.
   - Verify session stats are displayed (request count, unique endpoints, total size, duration).
   - Verify the captured endpoints list shows all API calls.
   - Set session name to "fleet-monitor-test".
   - Set page URL to "/monitoring/fleet-monitor".

4. **Test Mock JSON export**:
   - Check only "Mock JSON Files" checkbox.
   - Click "Preview". Verify JSON files are displayed in the preview area.
   - Click "Export Selected". Verify individual JSON files download.

5. **Test YAML export**:
   - Check only "YAML Test Definition" checkbox.
   - Click "Preview". Verify YAML content matches the fleet_summary.yml structure.
   - Verify it includes test_info, scenarios, data_scenarios, pre_test, validations, post_test.
   - Click "Export Selected". Verify YAML file downloads.

6. **Test Rule Set export**:
   - Check only "Rule Set JSON" checkbox.
   - Click "Export Selected". Verify JSON file downloads with mock_inline rules.
   - Import the downloaded file via the Import/Export tab. Verify rules appear in the Rules tab.

7. **Test HAR export**:
   - Check only "HAR Archive" checkbox.
   - Click "Export Selected". Verify .har file downloads.
   - Open Chrome DevTools > Network tab > Import HAR file. Verify the captured requests appear.

8. **Test Export All**:
   - Click "Export All Formats". Verify all four file types download.

9. **Test recording persistence**:
   - Start recording, navigate several pages, then close and reopen the popup.
   - Verify recording state is preserved (red dot, count still visible).
   - Close the browser entirely and reopen. Verify recording state is reset (gray dot).

10. **Test YAML integration with test runner**:
    - Copy the exported YAML to `health_check/test_definitions/`.
    - Copy the mock JSON files to `health_check/test_data/<page_name>/`.
    - Run: `pytest health_check/test_declarative_runner.py --test-yaml=<exported>.yml -v -s`
    - Verify the test runner can parse and execute the generated definition.

### Edge Cases

- Record a session with no API traffic -- export should produce minimal/empty files.
- Record a session with binary responses (images, fonts) -- verify these are handled gracefully.
- Record a session with very large responses (>1MB) -- verify storage limits are handled.
- Start recording, close the tab, navigate to a new tab -- verify recording continues.
- Start recording while interception rules are active -- verify both intercepted and passthrough requests are captured.
