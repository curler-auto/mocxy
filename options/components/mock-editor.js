/**
 * Mocxy - Mock Editor Component (Postman-style)
 *
 * Two-panel layout: left panel shows collections with collapsible mock entries,
 * right panel shows the mock detail editor with tabs (Body / Headers / Settings).
 */

import { MSG_TYPES, HTTP_METHODS } from '../../shared/constants.js';
import { generateId } from '../../shared/utils.js';
import { createMock } from '../../shared/data-models.js';

/* -------------------------------------------------------------------------- */
/*  Method badge color palette (VS Code Dark+ inspired)                      */
/* -------------------------------------------------------------------------- */

const METHOD_COLORS = {
  GET:     { bg: 'rgba(78,201,176,0.15)',  text: '#4ec9b0' },
  POST:    { bg: 'rgba(215,186,125,0.15)', text: '#d7ba7d' },
  PUT:     { bg: 'rgba(0,120,212,0.15)',   text: '#0078d4' },
  DELETE:  { bg: 'rgba(244,135,113,0.15)', text: '#f48771' },
  PATCH:   { bg: 'rgba(197,134,192,0.15)', text: '#c586c0' },
  OPTIONS: { bg: 'rgba(110,110,110,0.15)', text: '#9e9e9e' },
  HEAD:    { bg: 'rgba(110,110,110,0.15)', text: '#9e9e9e' },
};

/* -------------------------------------------------------------------------- */
/*  Module state                                                              */
/* -------------------------------------------------------------------------- */

let _container = null;
let _collections = [];
let _selectedCollectionId = null;
let _selectedMockId = null;
let _expandedCollections = new Set();
let _activeTab = 'body';

/* -------------------------------------------------------------------------- */
/*  Chrome messaging helpers                                                  */
/* -------------------------------------------------------------------------- */

function sendMsg(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

async function loadCollections() {
  try {
    const response = await sendMsg(MSG_TYPES.GET_MOCK_COLLECTIONS);
    _collections = Array.isArray(response) ? response : (response?.collections || []);
  } catch (err) {
    console.warn('[Mocxy MockEditor] Failed to load collections:', err);
    _collections = [];
  }
}

async function saveCollections(collections) {
  try {
    await sendMsg(MSG_TYPES.SET_MOCK_COLLECTIONS, { collections });
    _collections = collections;
  } catch (err) {
    console.warn('[Mocxy MockEditor] Failed to save collections:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  DOM helper                                                                */
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

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function getMethodColor(method) {
  return METHOD_COLORS[method] || METHOD_COLORS['GET'];
}

function renderMethodBadge(method) {
  const colors = getMethodColor(method);
  const badge = el('span', {
    className: 'me-method-badge',
    textContent: method || 'GET',
  });
  badge.style.background = colors.bg;
  badge.style.color = colors.text;
  return badge;
}

function applyMethodSelectStyle(select) {
  const colors = METHOD_COLORS[select.value] || METHOD_COLORS['GET'];
  select.style.color = colors.text;
  select.style.fontWeight = '700';
}

/* -------------------------------------------------------------------------- */
/*  JSON syntax highlighting (lightweight, no external lib dependency)       */
/* -------------------------------------------------------------------------- */

function highlightJson(raw) {
  if (!raw) return '';

  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false)\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, nul, num) => {
      if (str) {
        if (colon) return `<span class="jh-key">${str}</span>:`;
        return `<span class="jh-string">${str}</span>`;
      }
      if (bool) return `<span class="jh-bool">${match}</span>`;
      if (nul)  return `<span class="jh-null">${match}</span>`;
      if (num)  return `<span class="jh-number">${match}</span>`;
      return match;
    }
  );
}

/* -------------------------------------------------------------------------- */
/*  Validation feedback                                                       */
/* -------------------------------------------------------------------------- */

function showValidation(msgEl, valid, text) {
  msgEl.textContent = valid ? '\u2714 ' + text : '\u2716 ' + text;
  msgEl.className = 'me-json-validation ' + (valid ? 'me-json-valid' : 'me-json-invalid');
  clearTimeout(msgEl._timer);
  msgEl._timer = setTimeout(() => {
    msgEl.textContent = '';
    msgEl.className = 'me-json-validation';
  }, 4000);
}

/* -------------------------------------------------------------------------- */
/*  State selectors                                                           */
/* -------------------------------------------------------------------------- */

function getSelectedCollection() {
  return _collections.find((c) => c.id === _selectedCollectionId) || null;
}

function getSelectedMock() {
  const col = getSelectedCollection();
  if (!col) return null;
  return (col.mocks || []).find((m) => m.id === _selectedMockId) || null;
}

function selectMock(collectionId, mockId) {
  _selectedCollectionId = collectionId;
  _selectedMockId = mockId;
  _activeTab = 'body';
  render();
}

/* -------------------------------------------------------------------------- */
/*  Left panel — collections list                                             */
/* -------------------------------------------------------------------------- */

function renderLeftPanel() {
  const panel = el('div', { className: 'me-left' });

  // Header
  const header = el('div', { className: 'me-left-header' }, [
    el('span', { className: 'me-left-title', textContent: 'Collections' }),
  ]);

  const newBtn = el('button', {
    className: 'me-new-collection-btn',
    textContent: '+ New',
    onClick: async () => {
      const newCol = {
        id: generateId(),
        name: 'New Collection',
        active: false,
        mocks: [],
      };
      _collections.push(newCol);
      _selectedCollectionId = newCol.id;
      _selectedMockId = null;
      _expandedCollections.add(newCol.id);
      await saveCollections(_collections);
      render();
    },
  });
  header.appendChild(newBtn);
  panel.appendChild(header);

  // Collection list
  const listEl = el('div', { className: 'me-collection-list' });

  for (const col of _collections) {
    listEl.appendChild(renderCollectionItem(col));
  }

  panel.appendChild(listEl);
  return panel;
}

function renderCollectionItem(col) {
  const isExpanded = _expandedCollections.has(col.id);
  const mocks = col.mocks || [];

  const colItem = el('div', { className: 'me-col-item' });

  // Collection header row
  const colHeader = el('div', { className: 'me-col-header' });

  // Arrow
  const arrow = el('span', {
    className: 'me-col-arrow' + (isExpanded ? ' expanded' : ''),
    textContent: '▶',
  });

  // Active dot
  const dot = el('span', {
    className: 'me-col-dot ' + (col.active ? 'active' : 'inactive'),
  });

  // Name (editable on double-click)
  const nameSpan = el('span', {
    className: 'me-col-name',
    textContent: col.name || 'Untitled',
    title: col.name || 'Untitled',
  });
  nameSpan.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const input = el('input', {
      type: 'text',
      className: 'me-col-name-input',
      value: col.name || '',
    });
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      col.name = input.value.trim() || 'Untitled';
      await saveCollections(_collections);
      render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') input.blur();
      if (ke.key === 'Escape') { input.value = col.name || ''; input.blur(); }
    });
  });

  // Count badge
  const countBadge = el('span', {
    className: 'me-col-count',
    textContent: String(mocks.length),
  });

  // Action buttons
  const actions = el('div', { className: 'me-col-actions' });

  // Toggle active button
  const toggleBtn = el('button', {
    className: 'me-col-action-btn' + (col.active ? ' active' : ''),
    title: col.active ? 'Deactivate collection' : 'Activate collection',
    innerHTML: '&#9898;',
    onClick: async (e) => {
      e.stopPropagation();
      col.active = !col.active;
      await saveCollections(_collections);
      render();
    },
  });
  actions.appendChild(toggleBtn);

  // Delete button
  const delBtn = el('button', {
    className: 'me-col-action-btn danger',
    title: 'Delete collection',
    innerHTML: '&#10005;',
    onClick: async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete collection "${col.name || 'Untitled'}"?`)) return;
      _collections = _collections.filter((c) => c.id !== col.id);
      if (_selectedCollectionId === col.id) {
        _selectedCollectionId = null;
        _selectedMockId = null;
      }
      _expandedCollections.delete(col.id);
      await saveCollections(_collections);
      render();
    },
  });
  actions.appendChild(delBtn);

  colHeader.appendChild(arrow);
  colHeader.appendChild(dot);
  colHeader.appendChild(nameSpan);
  colHeader.appendChild(countBadge);
  colHeader.appendChild(actions);

  // Toggle expand on header click (but not on action buttons)
  colHeader.addEventListener('click', () => {
    if (isExpanded) {
      _expandedCollections.delete(col.id);
    } else {
      _expandedCollections.add(col.id);
      _selectedCollectionId = col.id;
    }
    render();
  });

  colItem.appendChild(colHeader);

  // Expanded mock entries
  if (isExpanded) {
    const entriesEl = el('div', { className: 'me-mock-entries' });

    for (const mock of mocks) {
      entriesEl.appendChild(renderMockEntry(col, mock));
    }

    // Add Mock button
    const addBtn = el('button', {
      className: 'me-entry-add-btn',
      textContent: '+ Add Mock',
      onClick: async () => {
        const newMock = createMock({ name: 'New Mock', methods: ['GET'] });
        col.mocks = col.mocks || [];
        col.mocks.push(newMock);
        _selectedCollectionId = col.id;
        _selectedMockId = newMock.id;
        _activeTab = 'body';
        await saveCollections(_collections);
        render();
      },
    });
    entriesEl.appendChild(addBtn);
    colItem.appendChild(entriesEl);
  }

  return colItem;
}

function renderMockEntry(col, mock) {
  const isSelected = _selectedMockId === mock.id && _selectedCollectionId === col.id;
  const primaryMethod = (mock.methods && mock.methods.length > 0) ? mock.methods[0] : 'GET';

  const entry = el('div', {
    className: 'me-mock-entry' + (isSelected ? ' selected' : ''),
    onClick: () => selectMock(col.id, mock.id),
  });

  entry.appendChild(renderMethodBadge(primaryMethod));

  const urlEl = el('span', {
    className: 'me-entry-url',
    textContent: mock.urlMatch || '(no URL)',
    title: mock.urlMatch || '',
  });
  entry.appendChild(urlEl);

  const dot = el('span', {
    className: 'me-entry-dot',
  });
  dot.style.background = mock.active !== false ? 'var(--c-success)' : 'var(--c-border2)';
  entry.appendChild(dot);

  return entry;
}

/* -------------------------------------------------------------------------- */
/*  Right panel — mock editor                                                 */
/* -------------------------------------------------------------------------- */

function renderRightPanel() {
  const panel = el('div', { className: 'me-right' });

  const mock = getSelectedMock();
  const col = getSelectedCollection();

  if (!mock || !col) {
    const emptyState = el('div', { className: 'me-empty-state' }, [
      el('div', { className: 'me-empty-icon', textContent: '\uD83D\uDCCB' }),
      el('span', { textContent: 'Select a mock to edit' }),
    ]);
    panel.appendChild(emptyState);
    return panel;
  }

  panel.appendChild(renderEditorPanel(col, mock));
  return panel;
}

function renderEditorPanel(col, mock) {
  const editorPanel = el('div', { className: 'me-editor-panel' });
  editorPanel.appendChild(renderMockForm(mock, col));
  return editorPanel;
}

/* -------------------------------------------------------------------------- */
/*  Match table helper (query params + request headers)                      */
/* -------------------------------------------------------------------------- */

function renderMatchTable(container, items, keyPlaceholder, valuePlaceholder) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div', {
      className: 'me-empty-state',
      style: 'padding:8px;font-size:11px',
      textContent: 'No conditions added.',
    }));
    return;
  }
  const table = el('table', { className: 'me-match-table' });
  const thead = el('thead');
  thead.innerHTML = `<tr><th></th><th>${keyPlaceholder}</th><th>${valuePlaceholder}</th><th>Match</th><th></th></tr>`;
  table.appendChild(thead);
  const tbody = el('tbody');

  items.forEach((item, idx) => {
    const tr = el('tr');

    // Enable checkbox
    const cbTd = el('td');
    const cb = el('input', { type: 'checkbox', ...(item.enabled !== false ? { checked: '' } : {}) });
    cb.addEventListener('change', (e) => { items[idx].enabled = e.target.checked; });
    cbTd.appendChild(cb);
    tr.appendChild(cbTd);

    // Key input
    const keyTd = el('td');
    const keyInput = el('input', {
      type: 'text',
      className: 'me-match-input',
      value: item.key || item.name || '',
      placeholder: keyPlaceholder,
      onInput: (e) => { items[idx].key = e.target.value; items[idx].name = e.target.value; },
    });
    keyTd.appendChild(keyInput);
    tr.appendChild(keyTd);

    // Value input
    const valTd = el('td');
    const valInput = el('input', {
      type: 'text',
      className: 'me-match-input',
      value: item.value || '',
      placeholder: item.matchType === 'absent' ? '(ignored)' : valuePlaceholder,
      onInput: (e) => { items[idx].value = e.target.value; },
    });
    valTd.appendChild(valInput);
    tr.appendChild(valTd);

    // Match type select
    const typeTd = el('td');
    const typeSelect = el('select', { className: 'me-match-type-select' });
    [
      { value: 'equals',   label: 'Equals' },
      { value: 'contains', label: 'Contains' },
      { value: 'regex',    label: 'Regex' },
      { value: 'absent',   label: 'Absent' },
    ].forEach(({ value, label }) => {
      const opt = el('option', { value, textContent: label });
      if ((item.matchType || 'equals') === value) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', (e) => {
      items[idx].matchType = e.target.value;
      valInput.placeholder = e.target.value === 'absent' ? '(ignored)' : valuePlaceholder;
    });
    typeTd.appendChild(typeSelect);
    tr.appendChild(typeTd);

    // Delete
    const delTd = el('td');
    const delBtn = el('button', {
      className: 'me-icon-btn me-icon-btn-danger',
      innerHTML: '&#10005;',
      onClick: () => { items.splice(idx, 1); renderMatchTable(container, items, keyPlaceholder, valuePlaceholder); },
    });
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

/* -------------------------------------------------------------------------- */
/*  WireMock-style mock form                                                  */
/* -------------------------------------------------------------------------- */

function renderMockForm(mock, collection) {
  const form = el('div', { className: 'me-mock-form' });

  // ── Name ────────────────────────────────────────────────────────────
  form.appendChild(el('label', { className: 'me-form-label', textContent: 'Name' }));
  form.appendChild(el('input', {
    type: 'text', className: 'me-form-input',
    value: mock.name || '',
    placeholder: 'Mock name\u2026',
    onInput: (e) => { mock.name = e.target.value; },
  }));

  // ── Priority ────────────────────────────────────────────────────────
  form.appendChild(el('label', { className: 'me-form-label', textContent: 'Priority (higher = matched first)' }));
  form.appendChild(el('input', {
    type: 'number', className: 'me-form-input me-form-input-short',
    value: String(mock.priority || 0), min: '0',
    onInput: (e) => { mock.priority = parseInt(e.target.value, 10) || 0; },
  }));

  // ════════════════════════════════════════════════════════════════════
  // REQUEST MATCHING
  // ════════════════════════════════════════════════════════════════════
  const reqSection = el('fieldset', { className: 'me-wiremock-section' });
  reqSection.appendChild(el('legend', { className: 'me-wiremock-legend', textContent: 'Request Matching' }));

  // URL match
  reqSection.appendChild(el('label', { className: 'me-form-label', textContent: 'URL / Path Pattern' }));
  const urlRow = el('div', { className: 'me-url-match-row' });

  const urlTypeSelect = el('select', { className: 'me-form-select me-url-type-select' });
  [
    { value: 'contains', label: 'Contains' },
    { value: 'equals',   label: 'Equals' },
    { value: 'regex',    label: 'Regex' },
    { value: 'path',     label: 'Path Pattern' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((mock.urlMatchType || 'contains') === value) opt.selected = true;
    urlTypeSelect.appendChild(opt);
  });
  urlTypeSelect.addEventListener('change', (e) => { mock.urlMatchType = e.target.value; });

  const urlInput = el('input', {
    type: 'text', className: 'me-form-input',
    value: mock.urlMatch || '',
    placeholder: '/api/fleet/** or .*getAggByUrl.*',
    style: 'flex:1',
    onInput: (e) => { mock.urlMatch = e.target.value; },
  });
  urlRow.appendChild(urlTypeSelect);
  urlRow.appendChild(urlInput);
  reqSection.appendChild(urlRow);

  // Methods
  reqSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Methods (empty = any)' }));
  const methodsGrid = el('div', { className: 'me-methods-grid' });
  for (const m of HTTP_METHODS) {
    const checked = (mock.methods || []).includes(m);
    const lbl = el('label', { className: 'me-checkbox-label' });
    const cb = el('input', { type: 'checkbox', value: m, ...(checked ? { checked: '' } : {}) });
    cb.addEventListener('change', (e) => {
      mock.methods = mock.methods || [];
      if (e.target.checked) { if (!mock.methods.includes(m)) mock.methods.push(m); }
      else mock.methods = mock.methods.filter((x) => x !== m);
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${m}`));
    methodsGrid.appendChild(lbl);
  }
  reqSection.appendChild(methodsGrid);

  // Query Parameters
  reqSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Query Parameters' }));
  const qpList = el('div', { className: 'me-match-table-wrap' });
  mock.queryParams = mock.queryParams || [];
  renderMatchTable(qpList, mock.queryParams, 'Key', 'Value');
  reqSection.appendChild(qpList);
  reqSection.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Query Param',
    onClick: () => {
      mock.queryParams.push({ key: '', value: '', matchType: 'equals', enabled: true });
      renderMatchTable(qpList, mock.queryParams, 'Key', 'Value');
    },
  }));

  // Request Headers
  reqSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Request Headers' }));
  const rhList = el('div', { className: 'me-match-table-wrap' });
  mock.requestHeaders = mock.requestHeaders || [];
  renderMatchTable(rhList, mock.requestHeaders, 'Header Name', 'Value');
  reqSection.appendChild(rhList);
  reqSection.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Header Match',
    onClick: () => {
      mock.requestHeaders.push({ name: '', value: '', matchType: 'equals', enabled: true });
      renderMatchTable(rhList, mock.requestHeaders, 'Header Name', 'Value');
    },
  }));

  // Body match
  reqSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Body / Payload Match' }));
  const bodyMatchWrap = el('div', { className: 'me-body-match-wrap' });
  mock.bodyMatch = mock.bodyMatch || { enabled: false, type: 'contains', value: '' };

  const bmEnableLabel = el('label', { className: 'me-checkbox-label', style: 'margin-bottom:6px' });
  const bmEnable = el('input', { type: 'checkbox', ...(mock.bodyMatch.enabled ? { checked: '' } : {}) });
  bmEnable.addEventListener('change', (e) => {
    mock.bodyMatch.enabled = e.target.checked;
    bmFields.style.display = e.target.checked ? 'block' : 'none';
  });
  bmEnableLabel.appendChild(bmEnable);
  bmEnableLabel.appendChild(document.createTextNode(' Enable body matching'));
  bodyMatchWrap.appendChild(bmEnableLabel);

  const bmFields = el('div');
  bmFields.style.display = mock.bodyMatch.enabled ? 'block' : 'none';

  const bmTypeSelect = el('select', { className: 'me-form-select', style: 'margin-bottom:6px' });
  [
    { value: 'contains', label: 'Contains' },
    { value: 'equals',   label: 'Equals (exact)' },
    { value: 'jsonpath', label: 'JSONPath expression' },
    { value: 'regex',    label: 'Regex' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((mock.bodyMatch.type || 'contains') === value) opt.selected = true;
    bmTypeSelect.appendChild(opt);
  });
  bmTypeSelect.addEventListener('change', (e) => { mock.bodyMatch.type = e.target.value; });

  const bmHint = el('div', { className: 'me-hint' });
  const updateBmHint = () => {
    const hints = {
      contains: 'Body string contains this substring',
      equals: 'Body string exactly equals this value',
      jsonpath: 'e.g. $.version == "v3" or $.data[0].status contains "CRIT"',
      regex: 'JavaScript regex pattern',
    };
    bmHint.textContent = hints[bmTypeSelect.value] || '';
  };
  bmTypeSelect.addEventListener('change', updateBmHint);
  updateBmHint();

  const bmExpr = el('textarea', {
    className: 'me-form-input', rows: '3',
    placeholder: 'Expression\u2026',
  });
  bmExpr.value = mock.bodyMatch.value || '';
  bmExpr.style.fontFamily = 'SF Mono, Cascadia Code, Fira Code, Consolas, monospace';
  bmExpr.style.fontSize = '12px';
  bmExpr.addEventListener('input', (e) => { mock.bodyMatch.value = e.target.value; });

  bmFields.appendChild(bmTypeSelect);
  bmFields.appendChild(bmHint);
  bmFields.appendChild(bmExpr);
  bodyMatchWrap.appendChild(bmFields);
  reqSection.appendChild(bodyMatchWrap);

  form.appendChild(reqSection);

  // ════════════════════════════════════════════════════════════════════
  // RESPONSE
  // ════════════════════════════════════════════════════════════════════
  const respSection = el('fieldset', { className: 'me-wiremock-section' });
  respSection.appendChild(el('legend', { className: 'me-wiremock-legend', textContent: 'Response' }));

  // Status Code
  respSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Status Code' }));
  respSection.appendChild(el('input', {
    type: 'number', className: 'me-form-input me-form-input-short',
    value: String(mock.statusCode || 200), min: '100', max: '599',
    onInput: (e) => { mock.statusCode = parseInt(e.target.value, 10) || 200; },
  }));

  // Response Headers (KV table)
  respSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Response Headers' }));
  const headersContainer = el('div', { className: 'me-headers-list' });
  const headers = mock.responseHeaders || {};

  function rebuildHeaders() {
    const rows = headersContainer.querySelectorAll('.me-header-row');
    const newHeaders = {};
    rows.forEach((row) => {
      const keyInput = row.querySelector('.me-header-key');
      const valInput = row.querySelector('.me-header-value');
      if (keyInput && valInput && keyInput.value.trim()) {
        newHeaders[keyInput.value.trim()] = valInput.value;
      }
    });
    mock.responseHeaders = newHeaders;
  }

  function addResponseHeaderRow(key, value) {
    const k = key || '';
    const v = value || '';
    const row = el('div', { className: 'me-header-row' });
    row.appendChild(el('input', {
      type: 'text', className: 'me-form-input me-header-key',
      value: k, placeholder: 'Header name', onBlur: rebuildHeaders,
    }));
    row.appendChild(el('input', {
      type: 'text', className: 'me-form-input me-header-value',
      value: v, placeholder: 'Header value', onBlur: rebuildHeaders,
    }));
    row.appendChild(el('button', {
      className: 'me-icon-btn me-icon-btn-danger', innerHTML: '&#10005;',
      title: 'Remove', onClick: () => { row.remove(); rebuildHeaders(); },
    }));
    headersContainer.appendChild(row);
  }

  for (const [k, v] of Object.entries(headers)) addResponseHeaderRow(k, v);
  respSection.appendChild(headersContainer);
  respSection.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Response Header',
    onClick: () => addResponseHeaderRow(),
  }));

  // Body editor
  respSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Response Body (JSON)' }));
  const editorWrapper = el('div', { className: 'me-json-editor-wrapper' });
  const toolbar = el('div', { className: 'me-json-toolbar' });
  const validationMsg = el('span', { className: 'me-json-validation-msg' });

  const textarea = el('textarea', {
    className: 'me-json-textarea', spellcheck: 'false',
    onInput: (e) => {
      mock.body = e.target.value;
      updateLineNumbers();
    },
    onBlur: () => { applyHighlighting(); },
    onScroll: () => {
      lineNumbers.scrollTop = textarea.scrollTop;
      highlightPre.scrollTop = textarea.scrollTop;
      highlightPre.scrollLeft = textarea.scrollLeft;
    },
  });
  textarea.value = mock.body || '{}';

  toolbar.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: 'Format',
    onClick: () => {
      try {
        const parsed = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(parsed, null, 2);
        mock.body = textarea.value;
        applyHighlighting();
        showValidation(validationMsg, true, 'Valid JSON');
      } catch (err) { showValidation(validationMsg, false, err.message); }
    },
  }));
  toolbar.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: 'Validate',
    onClick: () => {
      try { JSON.parse(textarea.value); showValidation(validationMsg, true, 'Valid JSON'); }
      catch (err) { showValidation(validationMsg, false, err.message); }
    },
  }));
  const fileInput = el('input', {
    type: 'file', accept: '.json,.txt', className: 'me-hidden-file-input',
    onChange: (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        textarea.value = ev.target.result;
        mock.body = textarea.value;
        applyHighlighting();
        validationMsg.textContent = '';
      };
      reader.readAsText(file);
    },
  });
  toolbar.appendChild(el('button', {
    className: 'me-btn me-btn-secondary me-btn-sm', textContent: 'Load from File',
    onClick: () => fileInput.click(),
  }));
  toolbar.appendChild(fileInput);
  toolbar.appendChild(validationMsg);
  editorWrapper.appendChild(toolbar);

  const editorContainer = el('div', { className: 'me-json-editor-container' });
  const lineNumbers = el('div', { className: 'me-json-line-numbers' });
  const highlightPre = el('pre', { className: 'me-json-highlight-pre' });

  function updateLineNumbers() {
    const lines = textarea.value.split('\n');
    lineNumbers.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
  }
  function applyHighlighting() {
    highlightPre.innerHTML = highlightJson(textarea.value);
  }

  editorContainer.appendChild(lineNumbers);
  editorContainer.appendChild(highlightPre);
  editorContainer.appendChild(textarea);
  editorWrapper.appendChild(editorContainer);
  respSection.appendChild(editorWrapper);
  requestAnimationFrame(() => { updateLineNumbers(); applyHighlighting(); });

  // Delay + Jitter
  const delayRow = el('div', { className: 'me-delay-row' });
  const delayGroup = el('div', { className: 'me-delay-group' });
  delayGroup.appendChild(el('label', { className: 'me-form-label', textContent: 'Delay (ms)' }));
  delayGroup.appendChild(el('input', {
    type: 'number', className: 'me-form-input me-form-input-short',
    value: String(mock.delayMs || 0), min: '0',
    onInput: (e) => { mock.delayMs = parseInt(e.target.value, 10) || 0; },
  }));
  const jitterGroup = el('div', { className: 'me-delay-group' });
  jitterGroup.appendChild(el('label', { className: 'me-form-label', textContent: 'Jitter (ms)' }));
  jitterGroup.appendChild(el('input', {
    type: 'number', className: 'me-form-input me-form-input-short',
    value: String(mock.delayJitter || 0), min: '0',
    title: 'Random additional 0-N ms added to delay',
    onInput: (e) => { mock.delayJitter = parseInt(e.target.value, 10) || 0; },
  }));
  delayRow.appendChild(delayGroup);
  delayRow.appendChild(jitterGroup);
  respSection.appendChild(delayRow);

  // Fault simulation
  respSection.appendChild(el('label', { className: 'me-form-label', textContent: 'Fault Simulation' }));
  const faultSelect = el('select', { className: 'me-form-select' });
  [
    { value: 'none',           label: 'None \u2014 normal response' },
    { value: 'network_error',  label: 'Network Error (fetch fails)' },
    { value: 'empty_response', label: 'Empty Response (200, no body)' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((mock.fault || 'none') === value) opt.selected = true;
    faultSelect.appendChild(opt);
  });
  faultSelect.addEventListener('change', (e) => { mock.fault = e.target.value; });
  respSection.appendChild(faultSelect);

  form.appendChild(respSection);

  // ── Save / Cancel ────────────────────────────────────────────────
  const formActions = el('div', { className: 'me-form-actions' });
  formActions.appendChild(el('button', {
    className: 'me-btn me-btn-primary', textContent: 'Save',
    onClick: async () => {
      rebuildHeaders();
      _selectedMockId = null;
      await saveCollections(_collections);
      render();
    },
  }));
  formActions.appendChild(el('button', {
    className: 'me-btn me-btn-secondary', textContent: 'Cancel',
    onClick: () => { _selectedMockId = null; loadCollections().then(() => render()); },
  }));
  form.appendChild(formActions);

  return form;
}

/* -------------------------------------------------------------------------- */
/*  Root render                                                               */
/* -------------------------------------------------------------------------- */

function render() {
  if (!_container) return;

  const wrapper = _container.querySelector('.me-wrapper');
  if (!wrapper) return;

  // Replace left and right panels in place
  const oldLeft = wrapper.querySelector('.me-left');
  const oldRight = wrapper.querySelector('.me-right');

  const newLeft = renderLeftPanel();
  const newRight = renderRightPanel();

  if (oldLeft) wrapper.replaceChild(newLeft, oldLeft);
  else wrapper.insertBefore(newLeft, wrapper.firstChild);

  if (oldRight) wrapper.replaceChild(newRight, oldRight);
  else wrapper.appendChild(newRight);
}

/* -------------------------------------------------------------------------- */
/*  Inject component styles                                                   */
/* -------------------------------------------------------------------------- */

function injectStyles() {
  if (document.getElementById('me-styles')) return;

  const style = document.createElement('style');
  style.id = 'me-styles';
  style.textContent = `
/* ============================================================
   Mocxy Mock Editor — Postman-style layout
   ============================================================ */

.me-wrapper {
  display: flex;
  height: 100%;
  min-height: 500px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  overflow: hidden;
}

/* ── LEFT PANEL ─────────────────────────────────────────── */

.me-left {
  width: 260px;
  min-width: 220px;
  flex-shrink: 0;
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
}

.me-left-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}

.me-left-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-muted);
}

.me-new-collection-btn {
  background: var(--c-accent);
  color: var(--c-accent-text);
  border: none;
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}
.me-new-collection-btn:hover { background: var(--c-accent-h); }

.me-collection-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

/* Collection item */
.me-col-item { border-bottom: 1px solid var(--c-border); }

.me-col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  transition: background 0.12s;
  user-select: none;
}
.me-col-header:hover { background: var(--c-surface3); }

.me-col-arrow {
  font-size: 10px;
  color: var(--c-subtle);
  flex-shrink: 0;
  width: 12px;
  transition: transform 0.15s;
}
.me-col-arrow.expanded { transform: rotate(90deg); }

.me-col-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.me-col-dot.active   { background: var(--c-success); }
.me-col-dot.inactive { background: var(--c-border2); }

.me-col-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.me-col-name-input {
  flex: 1;
  background: var(--c-surface2);
  border: 1px solid var(--c-accent);
  border-radius: 3px;
  color: var(--c-text);
  font-size: 13px;
  padding: 1px 6px;
  outline: none;
}

.me-col-count {
  font-size: 10px;
  color: var(--c-subtle);
  background: var(--c-surface2);
  border-radius: 10px;
  padding: 1px 6px;
  flex-shrink: 0;
}

.me-col-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.me-col-action-btn {
  background: none;
  border: none;
  color: var(--c-subtle);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
  transition: color 0.12s, background 0.12s;
}
.me-col-action-btn:hover { background: var(--c-surface3); color: var(--c-text); }
.me-col-action-btn.danger:hover { background: rgba(244,135,113,0.15); color: var(--c-error); }
.me-col-action-btn.active { color: var(--c-success); }

/* Mock entries inside a collection */
.me-mock-entries { background: var(--c-bg); }

.me-mock-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 28px;
  cursor: pointer;
  border-bottom: 1px solid var(--c-border);
  transition: background 0.12s;
}
.me-mock-entry:last-child { border-bottom: none; }
.me-mock-entry:hover { background: var(--c-surface3); }
.me-mock-entry.selected { background: rgba(0,120,212,0.1); border-left: 3px solid var(--c-accent); padding-left: 25px; }

.me-method-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 2px 5px;
  border-radius: 3px;
  letter-spacing: 0.03em;
  flex-shrink: 0;
  min-width: 36px;
  text-align: center;
}

.me-entry-url {
  font-size: 11px;
  color: var(--c-muted);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.me-entry-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.me-entry-add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 28px;
  cursor: pointer;
  font-size: 12px;
  color: var(--c-accent);
  background: none;
  border: none;
  border-top: 1px dashed var(--c-border);
  width: 100%;
  text-align: left;
  transition: background 0.12s;
}
.me-entry-add-btn:hover { background: var(--c-surface3); }

/* ── RIGHT PANEL ─────────────────────────────────────────── */

.me-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
  overflow: hidden;
}

.me-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--c-subtle);
  font-size: 14px;
  gap: 8px;
}
.me-empty-icon { font-size: 32px; opacity: 0.4; }

.me-editor-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Top fields: name, method+url, status */
.me-editor-top {
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.me-mock-name-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--c-border);
  color: var(--c-text);
  font-size: 15px;
  font-weight: 600;
  padding: 2px 0 6px;
  outline: none;
  width: 100%;
  transition: border-color 0.2s;
}
.me-mock-name-input:focus { border-bottom-color: var(--c-accent); }
.me-mock-name-input::placeholder { color: var(--c-subtle); font-weight: 400; }

.me-method-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  overflow: hidden;
}

.me-method-select {
  border: none;
  background: transparent;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  outline: none;
  min-width: 80px;
  border-right: 1px solid var(--c-border);
}

.me-url-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--c-text);
  font-size: 13px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  padding: 7px 10px;
  outline: none;
}
.me-url-input::placeholder { color: var(--c-subtle); font-family: var(--font-sans); }

.me-meta-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.me-meta-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--c-muted);
}
.me-meta-field label { font-weight: 600; flex-shrink: 0; }
.me-meta-input {
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 3px;
  color: var(--c-text);
  font-size: 12px;
  padding: 4px 8px;
  width: 80px;
  outline: none;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.2s;
}
.me-meta-input:focus { border-color: var(--c-accent); }

/* Tabs */
.me-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--c-border);
  padding: 0 16px;
  flex-shrink: 0;
  background: var(--c-surface);
}
.me-tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--c-muted);
  font-size: 12px;
  font-weight: 500;
  padding: 8px 12px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  margin-bottom: -1px;
}
.me-tab-btn:hover { color: var(--c-text); }
.me-tab-btn.active {
  color: var(--c-accent);
  border-bottom-color: var(--c-accent);
  font-weight: 600;
}

.me-tab-panel { display: none; flex: 1; overflow: hidden; flex-direction: column; }
.me-tab-panel.active { display: flex; }

/* Body tab */
.me-body-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.me-toolbar-btn {
  background: none;
  border: 1px solid var(--c-border);
  border-radius: 3px;
  color: var(--c-muted);
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.me-toolbar-btn:hover { background: var(--c-surface3); color: var(--c-text); }

.me-json-validation {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
}
.me-json-valid   { color: var(--c-success); }
.me-json-invalid { color: var(--c-error); }

.me-json-editor {
  flex: 1;
  display: flex;
  background: var(--c-bg-deep);
  overflow: hidden;
  min-height: 180px;
}
.me-line-nums {
  padding: 10px 6px 10px 10px;
  text-align: right;
  color: var(--c-subtle);
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  user-select: none;
  flex-shrink: 0;
  min-width: 36px;
  overflow: hidden;
}
.me-line-nums span { display: block; }
.me-highlight-pre {
  position: absolute; inset: 0;
  margin: 0; padding: 10px 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-wrap: break-word;
  pointer-events: none; overflow: auto;
}
.me-editor-inner {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.me-body-textarea {
  position: absolute; inset: 0;
  background: transparent;
  border: none;
  color: transparent;
  caret-color: var(--c-text);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.6;
  padding: 10px 12px;
  resize: none; outline: none;
  overflow: auto;
  white-space: pre-wrap;
  z-index: 1;
}

/* JSON token colors — VS Code Dark+ */
.jh-key    { color: #9cdcfe; }
.jh-string { color: #ce9178; }
.jh-number { color: #b5cea8; }
.jh-bool   { color: #569cd6; }
.jh-null   { color: #569cd6; }

/* Headers tab */
.me-headers-panel {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.me-headers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.me-headers-table th {
  text-align: left;
  padding: 4px 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-muted);
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
}
.me-headers-table td {
  padding: 3px 4px;
  border-bottom: 1px solid var(--c-border);
}
.me-headers-table tr:last-child td { border-bottom: none; }
.me-hdr-input {
  background: transparent;
  border: 1px solid transparent;
  color: var(--c-text);
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  padding: 3px 6px;
  outline: none;
  width: 100%;
  border-radius: 3px;
  transition: border-color 0.15s;
}
.me-hdr-input:focus { border-color: var(--c-accent); background: var(--c-surface2); }
.me-add-hdr-btn {
  margin-top: 8px;
  background: none;
  border: 1px dashed var(--c-border);
  border-radius: 3px;
  color: var(--c-accent);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
  width: 100%;
  transition: background 0.12s;
}
.me-add-hdr-btn:hover { background: var(--c-surface2); }
.me-del-hdr-btn {
  background: none;
  border: none;
  color: var(--c-subtle);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  line-height: 1;
}
.me-del-hdr-btn:hover { color: var(--c-error); }

/* Footer */
.me-editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--c-border);
  flex-shrink: 0;
  background: var(--c-surface);
}
.me-footer-btn {
  padding: 6px 18px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s;
}
.me-footer-cancel {
  background: transparent;
  color: var(--c-muted);
  border-color: var(--c-border);
}
.me-footer-cancel:hover { background: var(--c-surface3); color: var(--c-text); }
.me-footer-save {
  background: var(--c-accent);
  color: var(--c-accent-text);
  border-color: var(--c-accent);
}
.me-footer-save:hover { background: var(--c-accent-h); }

/* Methods checkboxes in settings tab */
.me-settings-panel { flex: 1; padding: 14px 16px; overflow-y: auto; }
.me-setting-group { margin-bottom: 16px; }
.me-setting-label {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--c-muted); margin-bottom: 8px; display: block;
}
.me-methods-grid { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.me-method-cb-label {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--c-text); cursor: pointer;
}
.me-method-cb-label input { accent-color: var(--c-accent); }

/* ── WireMock-style mock form ─────────────────────────────── */
.me-mock-form {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.me-form-label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--c-muted);
  margin: 8px 0 4px;
}
.me-form-input {
  display: block;
  width: 100%;
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-text);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.me-form-input:focus { border-color: var(--c-accent); }
.me-form-input-short { width: 100px; display: inline-block; }
.me-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 0 4px;
  flex-shrink: 0;
}
.me-btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.12s;
}
.me-btn-primary {
  background: var(--c-accent);
  color: var(--c-accent-text);
  border-color: var(--c-accent);
}
.me-btn-primary:hover { background: var(--c-accent-h); }
.me-btn-secondary {
  background: transparent;
  color: var(--c-muted);
  border-color: var(--c-border);
}
.me-btn-secondary:hover { background: var(--c-surface3); color: var(--c-text); }
.me-btn-sm { padding: 3px 10px; font-size: 11px; margin-top: 4px; }
.me-icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--c-subtle);
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}
.me-icon-btn-danger:hover { color: var(--c-error); }
.me-header-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
.me-header-row .me-form-input { flex: 1; }
.me-hidden-file-input { display: none; }
.me-json-editor-wrapper {
  border: 1px solid var(--c-border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 4px;
}
.me-json-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
}
.me-json-validation-msg {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
}
.me-json-editor-container {
  position: relative;
  display: flex;
  background: var(--c-bg-deep);
  min-height: 100px;
  max-height: 280px;
  overflow: hidden;
}
.me-json-line-numbers {
  padding: 8px 6px 8px 8px;
  text-align: right;
  color: var(--c-subtle);
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  user-select: none;
  flex-shrink: 0;
  min-width: 32px;
  overflow: hidden;
}
.me-json-line-numbers span { display: block; }
.me-json-highlight-pre {
  position: absolute;
  top: 0; left: 32px; right: 0; bottom: 0;
  margin: 0; padding: 8px 10px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-wrap: break-word;
  pointer-events: none; overflow: auto;
}
.me-json-textarea {
  position: absolute;
  top: 0; left: 32px; right: 0; bottom: 0;
  background: transparent;
  border: none;
  color: transparent;
  caret-color: var(--c-text);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.6;
  padding: 8px 10px;
  resize: none; outline: none;
  overflow: auto;
  white-space: pre-wrap;
  z-index: 1;
}

/* WireMock-style sections */
.me-wiremock-section {
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 12px 14px;
  margin: 0 0 12px;
}
.me-wiremock-legend {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--c-accent);
  padding: 0 6px;
}
.me-url-match-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.me-url-type-select, .me-form-select, .me-match-type-select {
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-text);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  cursor: pointer;
}
.me-hint {
  font-size: 11px;
  color: var(--c-subtle);
  margin: 2px 0 6px;
  font-style: italic;
}
.me-match-table-wrap { margin-bottom: 4px; overflow-x: auto; }
.me-match-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-bottom: 4px;
}
.me-match-table th {
  text-align: left;
  padding: 4px 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--c-muted);
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
}
.me-match-table td { padding: 3px 4px; border-bottom: 1px solid var(--c-border); }
.me-match-input {
  background: transparent;
  border: 1px solid transparent;
  color: var(--c-text);
  font-size: 12px;
  padding: 3px 6px;
  outline: none;
  width: 100%;
  border-radius: 3px;
  transition: border-color 0.15s;
}
.me-match-input:focus { border-color: var(--c-accent); background: var(--c-surface2); }
.me-match-type-select { font-size: 11px; padding: 3px 6px; }
.me-delay-row { display: flex; gap: 16px; margin-bottom: 4px; }
.me-delay-group { display: flex; flex-direction: column; gap: 4px; }
.me-body-match-wrap { margin-bottom: 4px; }
.me-checkbox-label {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--c-text); cursor: pointer;
}
.me-checkbox-label input { accent-color: var(--c-accent); }
`;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  Public init                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Initialise the Mock Editor component inside the given container element.
 *
 * @param {HTMLElement} container  The DOM node to mount into.
 */
export async function initMockEditor(container) {
  _container = container;
  injectStyles();

  _container.innerHTML = '';

  const wrapper = el('div', { className: 'me-wrapper' });
  // Placeholder panels — render() will populate them
  wrapper.appendChild(el('div', { className: 'me-left' }));
  wrapper.appendChild(el('div', { className: 'me-right' }));
  _container.appendChild(wrapper);

  await loadCollections();
  render();
}
