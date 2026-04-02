/**
 * Mocxy - Request Log Component
 *
 * Live request log viewer with filtering, auto-refresh, expandable row
 * details, pagination, and JSON export.
 */

import { MSG_TYPES } from '../../shared/constants.js';
import { formatTimestamp, formatDuration, truncate } from '../../shared/utils.js';

/* -------------------------------------------------------------------------- */
/*  Module state                                                              */
/* -------------------------------------------------------------------------- */

let _container = null;
let _logs = [];
let _filters = {
  url: '',
  method: '',
  status: '',
  interceptedOnly: true,  // default to intercepted only
};
let _autoRefresh = true;
let _autoRefreshTimer = null;
let _expandedIds = new Set();
let _showFullBodyIds = new Set();
let _pageSize = 50;
let _displayedCount = 50;

/* -------------------------------------------------------------------------- */
/*  Chrome messaging helpers                                                  */
/* -------------------------------------------------------------------------- */

function sendMsg(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

async function loadLogs(filter) {
  try {
    const response = await sendMsg(MSG_TYPES.GET_LOGS, { filter });
    const raw = Array.isArray(response) ? response : (response?.logs || []);
    _logs = applyClientFilters(raw, filter || _filters);
  } catch (err) {
    console.warn('[Mocxy RequestLog] Failed to load logs:', err);
    _logs = [];
  }
}

async function clearLogs() {
  try {
    await sendMsg(MSG_TYPES.CLEAR_LOGS);
    _logs = [];
    _expandedIds.clear();
    _showFullBodyIds.clear();
    _displayedCount = _pageSize;
  } catch (err) {
    console.warn('[Mocxy RequestLog] Failed to clear logs:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Client-side filtering                                                     */
/* -------------------------------------------------------------------------- */

function applyClientFilters(logs, filters) {
  return logs.filter((entry) => {
    // URL pattern
    if (filters.url) {
      const pattern = filters.url.toLowerCase();
      if (!(entry.url || '').toLowerCase().includes(pattern)) return false;
    }

    // Method
    if (filters.method) {
      if ((entry.method || '').toUpperCase() !== filters.method.toUpperCase()) return false;
    }

    // Status range
    if (filters.status) {
      const code = entry.statusCode || 0;
      switch (filters.status) {
        case '2xx': if (code < 200 || code >= 300) return false; break;
        case '3xx': if (code < 300 || code >= 400) return false; break;
        case '4xx': if (code < 400 || code >= 500) return false; break;
        case '5xx': if (code < 500 || code >= 600) return false; break;
        default: break;
      }
    }

    // Intercepted only
    if (filters.interceptedOnly && !entry.intercepted) return false;

    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      node.className = value;
    } else if (key === 'textContent') {
      node.textContent = value;
    } else if (key === 'innerHTML') {
      node.innerHTML = value;
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else if (child) {
      node.appendChild(child);
    }
  }
  return node;
}

function statusColorClass(code) {
  const n = parseInt(code, 10);
  if (!n || n === 0) return 'rl-status-0';
  if (n < 300) return 'rl-status-2xx';
  if (n < 400) return 'rl-status-3xx';
  if (n < 500) return 'rl-status-4xx';
  return 'rl-status-5xx';
}

function methodClass(method) {
  return 'rl-method-' + (method || 'GET').toUpperCase();
}

function tryFormatJson(str) {
  if (!str) return str || '';
  if (typeof str === 'object') {
    try { return JSON.stringify(str, null, 2); } catch (_) { return String(str); }
  }
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return str;
  }
}

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

function exportLogs() {
  const data = JSON.stringify(_logs, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const a = document.createElement('a');
  a.href = url;
  a.download = `mocxy-logs-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/*  Format headers as a key-value table                                       */
/* -------------------------------------------------------------------------- */

function formatHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return el('div', { className: 'rl-no-data', textContent: 'No headers.' });
  }

  const entries = Array.isArray(headers)
    ? headers.map((h) => [h.name || h.key || '', h.value || ''])
    : Object.entries(headers);

  if (entries.length === 0) {
    return el('div', { className: 'rl-no-data', textContent: 'No headers.' });
  }

  const table = el('table', { className: 'rl-headers-table' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { textContent: 'Name' }),
      el('th', { textContent: 'Value' }),
    ]),
  ]);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const [name, value] of entries) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { className: 'rl-header-name', textContent: name }),
        el('td', { className: 'rl-header-value', textContent: value }),
      ])
    );
  }
  table.appendChild(tbody);
  return table;
}

/* -------------------------------------------------------------------------- */
/*  Log entry row                                                             */
/* -------------------------------------------------------------------------- */

function renderLogEntry(entry) {
  const isExpanded = _expandedIds.has(entry.id);
  const method = (entry.method || 'GET').toUpperCase();

  const row = el('div', {
    className: `rl-entry${entry.intercepted ? ' rl-intercepted' : ''}${isExpanded ? ' rl-expanded' : ''}`,
  });

  // Summary row
  const summary = el('div', {
    className: 'rl-entry-summary',
    onClick: () => {
      if (_expandedIds.has(entry.id)) {
        _expandedIds.delete(entry.id);
      } else {
        _expandedIds.add(entry.id);
      }
      renderTable();
    },
  });

  // Expand indicator
  summary.appendChild(
    el('span', { className: 'rl-expand-icon', textContent: isExpanded ? '\u25BC' : '\u25B6' })
  );

  // Time
  summary.appendChild(
    el('span', { className: 'rl-cell rl-cell-time', textContent: formatTimestamp(entry.timestamp) })
  );

  // Method
  summary.appendChild(
    el('span', { className: `rl-cell rl-cell-method ${methodClass(method)}`, textContent: method })
  );

  // URL
  const urlText = truncate(entry.url || '', 80);
  summary.appendChild(
    el('span', { className: 'rl-cell rl-cell-url', textContent: urlText, title: entry.url || '' })
  );

  // Status code
  summary.appendChild(
    el('span', {
      className: `rl-cell rl-cell-status ${statusColorClass(entry.statusCode)}`,
      textContent: entry.statusCode || '--',
    })
  );

  // Duration
  summary.appendChild(
    el('span', {
      className: 'rl-cell rl-cell-duration',
      textContent: entry.duration ? formatDuration(entry.duration) : '--',
    })
  );

  // Rule
  summary.appendChild(
    el('span', {
      className: 'rl-cell rl-cell-rule',
      textContent: entry.matchedRuleName || '--',
      title: entry.matchedRuleId || '',
    })
  );

  // Action
  summary.appendChild(
    el('span', { className: 'rl-cell rl-cell-action', textContent: entry.actionTaken || '--' })
  );

  row.appendChild(summary);

  // Detail panel (expanded)
  if (isExpanded) {
    const detail = el('div', { className: 'rl-entry-detail' });

    // --- Changes diff section ---
    if (entry.modifiedUrl || entry.actionTaken === 'modify_headers') {
      detail.appendChild(el('h4', { className: 'rl-detail-heading', textContent: 'Changes' }));
      const diffBox = el('div', { className: 'rl-diff-box' });

      if (entry.modifiedUrl && entry.modifiedUrl !== entry.url) {
        // URL diff
        const urlSection = el('div', { className: 'rl-diff-section' });
        urlSection.appendChild(el('div', { className: 'rl-diff-label', textContent: 'URL' }));

        const removedLine = el('div', { className: 'rl-diff-line rl-diff-removed' });
        removedLine.appendChild(el('span', { className: 'rl-diff-marker', textContent: '\u2212' }));
        removedLine.appendChild(el('span', { className: 'rl-diff-content', textContent: entry.url }));

        const addedLine = el('div', { className: 'rl-diff-line rl-diff-added' });
        addedLine.appendChild(el('span', { className: 'rl-diff-marker', textContent: '+' }));
        addedLine.appendChild(el('span', { className: 'rl-diff-content', textContent: entry.modifiedUrl }));

        urlSection.appendChild(removedLine);
        urlSection.appendChild(addedLine);
        diffBox.appendChild(urlSection);
      }

      detail.appendChild(diffBox);
    }

    // Request headers
    detail.appendChild(el('h4', { className: 'rl-detail-heading', textContent: 'Request Headers' }));
    detail.appendChild(formatHeaders(entry.requestHeaders));

    // Request body
    detail.appendChild(el('h4', { className: 'rl-detail-heading', textContent: 'Request Body' }));
    if (entry.requestBody) {
      const formatted = tryFormatJson(entry.requestBody);
      detail.appendChild(
        el('pre', { className: 'rl-body-pre', textContent: formatted })
      );
    } else {
      detail.appendChild(el('div', { className: 'rl-no-data', textContent: 'No body.' }));
    }

    // Response headers
    detail.appendChild(el('h4', { className: 'rl-detail-heading', textContent: 'Response Headers' }));
    detail.appendChild(formatHeaders(entry.responseHeaders));

    // Response body (truncate if > 10KB)
    detail.appendChild(el('h4', { className: 'rl-detail-heading', textContent: 'Response Body' }));
    if (entry.responseBody) {
      const formatted = tryFormatJson(entry.responseBody);
      const maxLen = 10 * 1024;
      const showFull = _showFullBodyIds.has(entry.id);

      if (formatted.length > maxLen && !showFull) {
        const truncated = formatted.slice(0, maxLen);
        const pre = el('pre', { className: 'rl-body-pre', textContent: truncated + '\n...' });
        detail.appendChild(pre);
        detail.appendChild(
          el('button', {
            className: 'rl-btn rl-btn-sm rl-btn-secondary',
            textContent: `Show All (${(formatted.length / 1024).toFixed(1)} KB)`,
            onClick: () => {
              _showFullBodyIds.add(entry.id);
              renderTable();
            },
          })
        );
      } else {
        detail.appendChild(
          el('pre', { className: 'rl-body-pre', textContent: formatted })
        );
      }
    } else {
      detail.appendChild(el('div', { className: 'rl-no-data', textContent: 'No body.' }));
    }

    row.appendChild(detail);
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/*  Toolbar                                                                   */
/* -------------------------------------------------------------------------- */

function renderToolbar() {
  const toolbar = _container.querySelector('.rl-toolbar');
  if (!toolbar) return;
  toolbar.innerHTML = '';

  // URL filter
  const urlInput = el('input', {
    type: 'text',
    className: 'rl-filter-input',
    placeholder: 'Filter by URL...',
    value: _filters.url,
    onInput: (e) => {
      _filters.url = e.target.value;
      _displayedCount = _pageSize;
      refreshAndRender();
    },
  });
  toolbar.appendChild(urlInput);

  // Method dropdown
  const methodSelect = el('select', {
    className: 'rl-filter-select',
    onChange: (e) => {
      _filters.method = e.target.value;
      _displayedCount = _pageSize;
      refreshAndRender();
    },
  });
  for (const opt of ['', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const option = el('option', {
      value: opt,
      textContent: opt || 'All Methods',
    });
    if (opt === _filters.method) option.selected = true;
    methodSelect.appendChild(option);
  }
  toolbar.appendChild(methodSelect);

  // Status dropdown
  const statusSelect = el('select', {
    className: 'rl-filter-select',
    onChange: (e) => {
      _filters.status = e.target.value;
      _displayedCount = _pageSize;
      refreshAndRender();
    },
  });
  for (const opt of ['', '2xx', '3xx', '4xx', '5xx']) {
    const option = el('option', {
      value: opt,
      textContent: opt || 'All Status',
    });
    if (opt === _filters.status) option.selected = true;
    statusSelect.appendChild(option);
  }
  toolbar.appendChild(statusSelect);

  // Intercepted Only checkbox
  const interceptedLabel = el('label', { className: 'rl-checkbox-label' });
  const interceptedCb = el('input', {
    type: 'checkbox',
    ..._filters.interceptedOnly ? { checked: '' } : {},
    onChange: (e) => {
      _filters.interceptedOnly = e.target.checked;
      _displayedCount = _pageSize;
      refreshAndRender();
    },
  });
  interceptedLabel.appendChild(interceptedCb);
  interceptedLabel.appendChild(document.createTextNode(' Intercepted Only'));
  toolbar.appendChild(interceptedLabel);

  // Spacer
  toolbar.appendChild(el('div', { className: 'rl-toolbar-spacer' }));

  // Refresh button
  toolbar.appendChild(el('button', {
    className: 'rl-btn rl-btn-secondary',
    textContent: 'Refresh',
    onClick: () => refreshAndRender(),
  }));

  // Clear All button
  toolbar.appendChild(el('button', {
    className: 'rl-btn rl-btn-danger',
    textContent: 'Clear All',
    onClick: async () => {
      await clearLogs();
      renderTable();
    },
  }));

  // Export JSON button
  toolbar.appendChild(el('button', {
    className: 'rl-btn rl-btn-secondary',
    textContent: 'Export JSON',
    onClick: exportLogs,
  }));

  // Auto-refresh toggle
  const autoLabel = el('label', { className: 'rl-checkbox-label' });
  const autoCb = el('input', {
    type: 'checkbox',
    ..._autoRefresh ? { checked: '' } : {},
    onChange: (e) => {
      _autoRefresh = e.target.checked;
      setupAutoRefresh();
    },
  });
  autoLabel.appendChild(autoCb);
  autoLabel.appendChild(document.createTextNode(' Auto-refresh'));
  toolbar.appendChild(autoLabel);
}

/* -------------------------------------------------------------------------- */
/*  Table rendering                                                           */
/* -------------------------------------------------------------------------- */

function renderTable() {
  const tableArea = _container.querySelector('.rl-table-area');
  if (!tableArea) return;
  tableArea.innerHTML = '';

  if (_logs.length === 0) {
    tableArea.appendChild(
      el('div', { className: 'rl-empty-state', textContent: 'No requests captured yet.' })
    );
    return;
  }

  // Column header
  const headerRow = el('div', { className: 'rl-header-row' }, [
    el('span', { className: 'rl-expand-icon-placeholder' }),
    el('span', { className: 'rl-cell rl-cell-time rl-col-header', textContent: 'Time' }),
    el('span', { className: 'rl-cell rl-cell-method rl-col-header', textContent: 'Method' }),
    el('span', { className: 'rl-cell rl-cell-url rl-col-header', textContent: 'URL' }),
    el('span', { className: 'rl-cell rl-cell-status rl-col-header', textContent: 'Status' }),
    el('span', { className: 'rl-cell rl-cell-duration rl-col-header', textContent: 'Duration' }),
    el('span', { className: 'rl-cell rl-cell-rule rl-col-header', textContent: 'Rule' }),
    el('span', { className: 'rl-cell rl-cell-action rl-col-header', textContent: 'Action' }),
  ]);
  tableArea.appendChild(headerRow);

  // Log entries (paginated)
  const visible = _logs.slice(0, _displayedCount);
  for (const entry of visible) {
    tableArea.appendChild(renderLogEntry(entry));
  }

  // Load More / count indicator
  const remaining = _logs.length - _displayedCount;
  if (remaining > 0) {
    tableArea.appendChild(
      el('div', { className: 'rl-load-more-row' }, [
        el('button', {
          className: 'rl-btn rl-btn-secondary rl-btn-load-more',
          textContent: `Load More (${remaining} remaining)`,
          onClick: () => {
            _displayedCount += _pageSize;
            renderTable();
          },
        }),
      ])
    );
  }

  // Summary footer
  const total = _logs.length;
  const interceptedCount = _logs.filter((l) => l.intercepted).length;
  tableArea.appendChild(
    el('div', { className: 'rl-footer-summary' }, [
      el('span', { textContent: `${total} request${total !== 1 ? 's' : ''}` }),
      el('span', { className: 'rl-footer-sep', textContent: '|' }),
      el('span', { textContent: `${interceptedCount} intercepted` }),
    ])
  );
}

/* -------------------------------------------------------------------------- */
/*  Refresh & auto-refresh                                                    */
/* -------------------------------------------------------------------------- */

async function refreshAndRender() {
  await loadLogs(_filters);
  renderTable();
}

function setupAutoRefresh() {
  if (_autoRefreshTimer) {
    clearInterval(_autoRefreshTimer);
    _autoRefreshTimer = null;
  }

  if (_autoRefresh) {
    _autoRefreshTimer = setInterval(() => {
      refreshAndRender();
    }, 2000);
  }
}

function destroyAutoRefresh() {
  if (_autoRefreshTimer) {
    clearInterval(_autoRefreshTimer);
    _autoRefreshTimer = null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Inject component styles                                                   */
/* -------------------------------------------------------------------------- */

function injectStyles() {
  if (document.getElementById('rl-styles')) return;

  const style = document.createElement('style');
  style.id = 'rl-styles';
  style.textContent = `
/* ======================================================================== */
/*  Request Log — Scoped Styles                                             */
/* ======================================================================== */

.rl-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 400px;
}

/* --- Toolbar ------------------------------------------------------------ */

.rl-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 8px 8px 0 0;
}

.rl-filter-input {
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-text);
  font-size: 12px;
  padding: 5px 10px;
  outline: none;
  width: 200px;
  transition: border-color 0.2s;
}

.rl-filter-input:focus {
  border-color: var(--c-accent);
}

.rl-filter-select {
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-text);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  cursor: pointer;
}

.rl-filter-select:focus {
  border-color: var(--c-accent);
}

.rl-checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--c-muted);
  cursor: pointer;
  white-space: nowrap;
}

.rl-checkbox-label input[type="checkbox"] {
  accent-color: var(--c-accent);
}

.rl-toolbar-spacer {
  flex: 1;
}

/* --- Buttons ------------------------------------------------------------ */

.rl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.rl-btn-sm {
  padding: 3px 8px;
  font-size: 11px;
}

.rl-btn-secondary {
  background: var(--c-surface3);
  color: var(--c-text);
}

.rl-btn-secondary:hover {
  background: var(--c-border2);
}

.rl-btn-danger {
  background: var(--c-surface3);
  color: var(--c-error);
}

.rl-btn-danger:hover {
  background: rgba(244,135,113,0.15);
}

/* --- Table area --------------------------------------------------------- */

.rl-table-area {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  overflow-y: auto;
  max-height: 600px;
  scrollbar-width: thin;
  scrollbar-color: var(--c-border) transparent;
}

/* --- Header row --------------------------------------------------------- */

.rl-header-row {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
  position: sticky;
  top: 0;
  z-index: 2;
}

.rl-col-header {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--c-muted);
}

/* --- Cell layout -------------------------------------------------------- */

.rl-expand-icon {
  width: 16px;
  font-size: 9px;
  color: var(--c-subtle);
  cursor: pointer;
  flex-shrink: 0;
  text-align: center;
  user-select: none;
}

.rl-expand-icon-placeholder {
  width: 16px;
  flex-shrink: 0;
}

.rl-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 0 6px;
}

.rl-cell-time {
  width: 170px;
  flex-shrink: 0;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--c-subtle);
}

.rl-cell-method {
  width: 60px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  border-radius: 3px;
  padding: 1px 4px;
  line-height: 16px;
}

.rl-cell-url {
  flex: 1;
  min-width: 0;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--c-text);
}

.rl-cell-status {
  width: 50px;
  flex-shrink: 0;
  text-align: right;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.rl-cell-duration {
  width: 70px;
  flex-shrink: 0;
  text-align: right;
  color: var(--c-muted);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.rl-cell-rule {
  width: 120px;
  flex-shrink: 0;
  color: var(--c-muted);
  font-size: 11px;
}

.rl-cell-action {
  width: 90px;
  flex-shrink: 0;
  color: var(--c-muted);
  font-size: 11px;
}

/* --- Method colours ----------------------------------------------------- */

.rl-method-GET     { background: rgba(78,201,176,0.12);  color: var(--c-success); }
.rl-method-POST    { background: rgba(215,186,125,0.12); color: var(--c-warning); }
.rl-method-PUT     { background: rgba(0,120,212,0.12);   color: var(--c-accent); }
.rl-method-PATCH   { background: rgba(197,134,192,0.12); color: #c586c0; }
.rl-method-DELETE  { background: rgba(244,135,113,0.12); color: var(--c-error); }
.rl-method-HEAD    { background: var(--c-surface2);      color: var(--c-muted); }
.rl-method-OPTIONS { background: var(--c-surface2);      color: var(--c-muted); }

/* --- Status colours ----------------------------------------------------- */

.rl-status-2xx { color: var(--c-success); }
.rl-status-3xx { color: var(--c-warning); }
.rl-status-4xx { color: #d6a06c; }
.rl-status-5xx { color: var(--c-error); }
.rl-status-0   { color: var(--c-subtle); }

/* --- Entry row ---------------------------------------------------------- */

.rl-entry {
  border-bottom: 1px solid var(--c-border);
}

.rl-entry:last-child {
  border-bottom: none;
}

.rl-entry-summary {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.rl-entry-summary:hover {
  background: var(--c-surface3);
}

.rl-intercepted > .rl-entry-summary {
  border-left: 3px solid var(--c-warning);
  padding-left: 9px;
}

.rl-expanded > .rl-entry-summary {
  background: var(--c-surface3);
}

.rl-expanded > .rl-entry-summary .rl-expand-icon {
  color: var(--c-accent);
}

/* --- Detail panel ------------------------------------------------------- */

.rl-entry-detail {
  padding: 12px 16px 16px 32px;
  background: var(--c-surface);
  border-top: 1px solid var(--c-border);
}

.rl-detail-heading {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--c-accent);
  margin: 12px 0 6px;
}

.rl-detail-heading:first-child {
  margin-top: 0;
}

.rl-headers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  margin-bottom: 4px;
}

.rl-headers-table th {
  text-align: left;
  padding: 3px 8px;
  background: var(--c-surface2);
  color: var(--c-muted);
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.rl-headers-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--c-border);
}

.rl-header-name {
  color: var(--c-accent);
  font-weight: 500;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  white-space: nowrap;
  width: 200px;
}

.rl-header-value {
  color: var(--c-text);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  word-break: break-all;
}

.rl-body-pre {
  background: var(--c-bg-deep);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  padding: 10px;
  margin: 4px 0;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--c-text);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--c-border) transparent;
}

.rl-no-data {
  font-size: 11px;
  color: var(--c-subtle);
  font-style: italic;
  padding: 4px 0;
}

/* --- Load More ---------------------------------------------------------- */

.rl-load-more-row {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.rl-btn-load-more {
  padding: 6px 24px;
}

/* --- Footer summary ----------------------------------------------------- */

.rl-footer-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--c-border);
  font-size: 11px;
  color: var(--c-subtle);
}

.rl-footer-sep {
  color: var(--c-border);
}

/* --- Empty state -------------------------------------------------------- */

.rl-empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--c-subtle);
  font-style: italic;
  font-size: 14px;
}

/* Diff view */
.rl-diff-box {
  margin-bottom: 8px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  overflow: hidden;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
}
.rl-diff-section { padding: 0; }
.rl-diff-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-muted);
  padding: 4px 10px;
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
}
.rl-diff-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 10px;
  word-break: break-all;
}
.rl-diff-removed {
  background: rgba(244, 135, 113, 0.08);
  border-left: 3px solid var(--c-error);
  color: var(--c-error);
}
.rl-diff-added {
  background: rgba(78, 201, 176, 0.08);
  border-left: 3px solid var(--c-success);
  color: var(--c-success);
}
.rl-diff-marker {
  font-weight: 700;
  flex-shrink: 0;
  width: 12px;
}
.rl-diff-content {
  flex: 1;
  word-break: break-all;
}
`;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  Public init                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Initialise the Request Log component inside the given container element.
 *
 * @param {HTMLElement} container  The DOM node to mount into.
 */
export async function initRequestLog(container) {
  _container = container;
  injectStyles();

  // Reset state
  _logs = [];
  _expandedIds.clear();
  _showFullBodyIds.clear();
  _displayedCount = _pageSize;
  _filters = { url: '', method: '', status: '', interceptedOnly: true };
  _autoRefresh = true;

  // Build skeleton
  _container.innerHTML = '';
  const wrapper = el('div', { className: 'rl-wrapper' });
  wrapper.appendChild(el('div', { className: 'rl-toolbar' }));
  wrapper.appendChild(el('div', { className: 'rl-table-area' }));
  _container.appendChild(wrapper);

  // Render toolbar (static structure, rebuilt in renderToolbar)
  renderToolbar();

  // Initial data load
  await refreshAndRender();

  // Start auto-refresh
  setupAutoRefresh();

  // Clean up auto-refresh when the section is hidden.
  // The options page controls visibility; we observe class changes on the
  // container's closest content-section ancestor.
  const section = _container.closest('.content-section');
  if (section) {
    const observer = new MutationObserver(() => {
      if (!section.classList.contains('active')) {
        destroyAutoRefresh();
      } else if (_autoRefresh) {
        setupAutoRefresh();
      }
    });
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
  }
}
