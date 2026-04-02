/**
 * popup.js
 *
 * Controls the Mocxy browser-action popup.
 * Communicates with the service worker via chrome.runtime.sendMessage
 * using the MSG_TYPES message protocol.
 */

/* -------------------------------------------------------------------------- */
/*  Message types — must match shared/constants.js                            */
/* -------------------------------------------------------------------------- */

const MSG_TYPES = {
  GET_STATUS:     'GET_STATUS',
  TOGGLE_ENABLED: 'TOGGLE_ENABLED',
  GET_LOGS:       'GET_LOGS',
  CLEAR_LOGS:     'CLEAR_LOGS',
};

/* -------------------------------------------------------------------------- */
/*  DOM references                                                            */
/* -------------------------------------------------------------------------- */

const $toggleInput       = document.getElementById('toggleInput');
const $activeRulesCount  = document.getElementById('activeRulesCount');
const $interceptedCount  = document.getElementById('interceptedCount');
const $requestList       = document.getElementById('requestList');
const $emptyState        = document.getElementById('emptyState');
const $optionsLink       = document.getElementById('optionsLink');
const $clearLogsLink     = document.getElementById('clearLogsLink');

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send a message to the service worker and return the response.
 * @param {string} type   — MSG_TYPES key
 * @param {Object} [data] — optional payload
 * @returns {Promise<*>}
 */
function sendMsg(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

/**
 * Return the CSS class suffix for a given HTTP status code.
 * @param {number|string} code
 * @returns {string}
 */
function statusClass(code) {
  const n = parseInt(code, 10);
  if (!n || n === 0) return 'status-0';
  if (n < 300) return 'status-2xx';
  if (n < 400) return 'status-3xx';
  if (n < 500) return 'status-4xx';
  return 'status-5xx';
}

/**
 * Extract a displayable pathname from a full URL, truncating long paths.
 * @param {string} url
 * @returns {string}
 */
function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 60 ? path.slice(0, 57) + '...' : path;
  } catch {
    return url && url.length > 60 ? url.slice(0, 57) + '...' : (url || '');
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Update the master toggle and the enabled/disabled body state.
 * @param {boolean} enabled
 */
function renderToggle(enabled) {
  $toggleInput.checked = enabled;
  document.body.classList.toggle('disabled', !enabled);
}

/**
 * Update the stats counters.
 * @param {number} activeRules
 * @param {number} intercepted
 */
function renderStats(activeRules, intercepted) {
  $activeRulesCount.textContent = activeRules;
  $interceptedCount.textContent = intercepted;
}

/**
 * Render the recent intercepts list.
 * @param {Array} logs — array of log entry objects (newest first)
 */
function renderLogs(logs) {
  // Clear existing items (keep the empty state element)
  $requestList.innerHTML = '';

  if (!logs || logs.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'request-empty';
    emptyLi.id = 'emptyState';
    emptyLi.textContent = 'No recent intercepts';
    $requestList.appendChild(emptyLi);
    return;
  }

  for (const entry of logs) {
    const li = document.createElement('li');
    li.className = 'request-item';

    // Method badge
    const method = (entry.method || 'GET').toUpperCase();
    const methodBadge = document.createElement('span');
    methodBadge.className = `method-badge method-${method}`;
    methodBadge.textContent = method;

    // Status code
    const statusCode = document.createElement('span');
    const code = entry.statusCode || 0;
    statusCode.className = `status-code ${statusClass(code)}`;
    statusCode.textContent = code || '--';

    // URL
    const urlSpan = document.createElement('span');
    urlSpan.className = 'request-url';
    urlSpan.textContent = truncateUrl(entry.url);
    urlSpan.title = entry.url || '';

    li.appendChild(methodBadge);
    li.appendChild(statusCode);
    li.appendChild(urlSpan);

    // Intercepted indicator dot
    if (entry.intercepted) {
      const dot = document.createElement('span');
      dot.className = 'intercepted-badge';
      dot.title = 'Intercepted by rule';
      li.appendChild(dot);
    }

    $requestList.appendChild(li);
  }
}

/* -------------------------------------------------------------------------- */
/*  Data fetching                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Fetch current status from the service worker and update the popup UI.
 */
async function refreshStatus() {
  try {
    const status = await sendMsg(MSG_TYPES.GET_STATUS);
    if (status) {
      renderToggle(status.enabled !== false);
      renderStats(
        status.activeRules || 0,
        status.interceptedCount || 0
      );
    }
  } catch (err) {
    console.warn('[Mocxy Popup] Failed to get status:', err);
  }
}

/**
 * Fetch recent log entries and render them.
 */
async function refreshLogs() {
  try {
    const response = await sendMsg(MSG_TYPES.GET_LOGS, { limit: 5 });
    const logs = Array.isArray(response) ? response : (response?.logs || []);
    renderLogs(logs);
  } catch (err) {
    console.warn('[Mocxy Popup] Failed to get logs:', err);
    renderLogs([]);
  }
}

/* -------------------------------------------------------------------------- */
/*  Event handlers                                                            */
/* -------------------------------------------------------------------------- */

/** Master toggle click — toggle the global enabled state. */
$toggleInput.addEventListener('change', async () => {
  const enabled = $toggleInput.checked;
  try {
    await sendMsg(MSG_TYPES.TOGGLE_ENABLED, { enabled });
    renderToggle(enabled);
  } catch (err) {
    console.warn('[Mocxy Popup] Toggle failed:', err);
    // Revert the toggle on failure
    $toggleInput.checked = !enabled;
  }
});

/** Options link — open the extension options page. */
$optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/** Clear Logs — wipe log entries and reset the list. */
$clearLogsLink.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await sendMsg(MSG_TYPES.CLEAR_LOGS);
    renderLogs([]);
    renderStats(
      parseInt($activeRulesCount.textContent, 10) || 0,
      0
    );
  } catch (err) {
    console.warn('[Mocxy Popup] Clear logs failed:', err);
  }
});

/* -------------------------------------------------------------------------- */
/*  Storage change listener — auto-update when background state changes       */
/* -------------------------------------------------------------------------- */

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // If the enabled flag changed, update the toggle
  if (changes.mocxy_enabled) {
    renderToggle(changes.mocxy_enabled.newValue !== false);
  }

  // If rules changed, refresh the active count
  if (changes.mocxy_rules) {
    const rules = changes.mocxy_rules.newValue || [];
    const activeCount = rules.filter((r) => r.enabled !== false).length;
    $activeRulesCount.textContent = activeCount;
  }
});

/* -------------------------------------------------------------------------- */
/*  Initialise on DOM ready                                                   */
/* -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  refreshLogs();
});
