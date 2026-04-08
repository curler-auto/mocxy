/**
 * Mocxy Extension — Mock Collections Editor
 *
 * Feature-parity with the standalone /mocxy-ui:
 *  • Postman-style collection tree (collections → folders → mocks)
 *  • Full WireMock-level mock editor
 *  • OpenAPI spec → collection import
 *  • AI scenario generation (gated on LLM key)
 *  • Duplicate collection
 *  • Export / import per collection
 *  • Context menus on every node
 */

import { STORAGE_KEYS, DEFAULT_MOCK_SERVER_URL } from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Module state                                                              */
/* -------------------------------------------------------------------------- */

let _container    = null;
let _serverUrl    = DEFAULT_MOCK_SERVER_URL;
let _serverStatus = 'unknown';
let _serverInfo   = null;
let _collections  = [];
let _selectedId   = null;
let _selectedColId = null;
let _draft        = null;
let _aiKeyConfigured = false;
let _refreshTimer = null;
const _expanded   = {};
let _specRaw      = '';
let _activeMenu   = null;

/* -------------------------------------------------------------------------- */
/*  Server helpers                                                            */
/* -------------------------------------------------------------------------- */

async function getMockServerUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEYS.MOCK_SERVER_URL, r =>
      resolve(r[STORAGE_KEYS.MOCK_SERVER_URL] || DEFAULT_MOCK_SERVER_URL)
    );
  });
}

async function colFetch(path, opts = {}) {
  const res = await fetch(_serverUrl + '/mocxy/admin/collections' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

async function checkConnection() {
  try {
    const r = await fetch(_serverUrl + '/mocxy/admin/health', { signal: AbortSignal.timeout(4000) });
    _serverInfo   = await r.json();
    _serverStatus = 'connected';
  } catch (_) {
    _serverStatus = 'offline';
    _serverInfo   = null;
  }
}

async function checkAiKey() {
  try {
    const r = await fetch(_serverUrl + '/mocxy/ai/has-key', { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    _aiKeyConfigured = d.configured === true;
  } catch (_) { _aiKeyConfigured = false; }
}

async function loadCollections() {
  if (_serverStatus !== 'connected') { _collections = []; return; }
  try { _collections = await colFetch('/') || []; }
  catch (_) { _collections = []; }
}

/* -------------------------------------------------------------------------- */
/*  DOM helper                                                                */
/* -------------------------------------------------------------------------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k === 'innerHTML') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  children.forEach(c => {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  });
  return node;
}

/* -------------------------------------------------------------------------- */
/*  JSON highlighting                                                         */
/* -------------------------------------------------------------------------- */

function highlightJson(raw) {
  if (!raw) return '';
  const e = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return e.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b)|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m,str,colon,bool,nul,num) => {
      if (str && colon) return `<span class="me-jh-key">${str}</span><span class="me-jh-punc">:</span>`;
      if (str)  return `<span class="me-jh-str">${str}</span>`;
      if (bool) return `<span class="me-jh-bool">${m}</span>`;
      if (nul !== undefined && m === 'null') return `<span class="me-jh-null">null</span>`;
      if (num)  return `<span class="me-jh-num">${m}</span>`;
      return m;
    }
  );
}

function showValMsg(el, valid, text) {
  el.textContent = (valid ? '✔ ' : '✖ ') + text;
  el.className = 'me-val-msg ' + (valid ? 'me-val-ok' : 'me-val-err');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; el.className = 'me-val-msg'; }, 4000);
}

/* -------------------------------------------------------------------------- */
/*  Method badge                                                              */
/* -------------------------------------------------------------------------- */

const METHOD_CLR = {
  ANY:'rgba(90,90,90,0.15)',     GET:'rgba(62,201,167,0.15)',
  POST:'rgba(215,186,125,0.15)',  PUT:'rgba(0,144,240,0.15)',
  DELETE:'rgba(244,112,103,0.15)',PATCH:'rgba(197,134,192,0.15)',
  HEAD:'rgba(90,90,90,0.12)',     OPTIONS:'rgba(90,90,90,0.12)',
};
const METHOD_TXT = {
  ANY:'var(--c-muted)',    GET:'var(--c-success)',  POST:'var(--c-warning)',
  PUT:'var(--c-accent)',   DELETE:'var(--c-error)', PATCH:'#c586c0',
  HEAD:'var(--c-muted)',   OPTIONS:'var(--c-muted)',
};

function methodBadge(method) {
  const m = (method || 'ANY').toUpperCase();
  const b = el('span', { className: 'me-badge' });
  b.textContent = m;
  b.style.background = METHOD_CLR[m] || METHOD_CLR.ANY;
  b.style.color      = METHOD_TXT[m] || METHOD_TXT.ANY;
  return b;
}

function applyMethodColor(sel) {
  const m = (sel.value || 'ANY').toUpperCase();
  sel.style.color = METHOD_TXT[m] || METHOD_TXT.ANY;
}

/* -------------------------------------------------------------------------- */
/*  Status bar                                                                */
/* -------------------------------------------------------------------------- */

function renderStatusBar() {
  const bar = _container.querySelector('#me-status-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const dot = el('span', { className: `me-dot me-dot-${_serverStatus === 'connected' ? 'ok' : 'off'}` });
  const txt = el('span', { className: 'me-status-txt' });

  if (_serverStatus === 'connected') {
    const i = _serverInfo || {};
    txt.innerHTML = `Connected to <strong>${_serverUrl}</strong>`;
    bar.appendChild(dot); bar.appendChild(txt);
    bar.appendChild(el('span', { className: 'me-status-meta',
      textContent: `${_collections.length} collection(s) · ${i.mocks || 0} mock(s)` }));
  } else {
    txt.innerHTML = '<span style="color:var(--c-error)">Mock server offline</span>';
    bar.appendChild(dot); bar.appendChild(txt);
    bar.appendChild(el('span', { className: 'me-status-meta',
      innerHTML: 'Start: <code>cd mock-server &amp;&amp; npm start</code>' }));
  }

  // Action buttons
  const actions = el('div', { className: 'me-status-actions' });

  const importSpecBtn = el('button', { className: 'me-status-btn', textContent: '↑ OpenAPI',
    title: 'Import OpenAPI spec as collection',
    onClick: () => { if (_serverStatus === 'connected') showSpecDialog(); },
  });

  const exportBtn = el('button', { className: 'me-status-btn', textContent: '↓ Export',
    title: 'Export selected collection',
    onClick: async () => {
      if (_serverStatus !== 'connected' || !_selectedColId) return;
      const col = _collections.find(c => c.id === _selectedColId);
      if (col) await exportCollection(col);
    },
  });

  const importBtn = el('button', { className: 'me-status-btn', textContent: '↑ Import',
    title: 'Import collection from JSON',
    onClick: () => {
      if (_serverStatus !== 'connected') return;
      const fi = _container.querySelector('#me-import-file');
      if (fi) fi.click();
    },
  });

  const refreshBtn = el('button', { className: 'me-status-btn me-status-refresh',
    textContent: '↻ Refresh',
    onClick: async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = '↻ …';
      _serverUrl = await getMockServerUrl();
      await checkConnection();
      if (_serverStatus === 'connected') { await checkAiKey(); await loadCollections(); }
      render();
    },
  });

  actions.appendChild(importSpecBtn);
  actions.appendChild(exportBtn);
  actions.appendChild(importBtn);
  actions.appendChild(refreshBtn);
  bar.appendChild(actions);

  // Hidden import file input
  let fi = _container.querySelector('#me-import-file');
  if (!fi) {
    fi = document.createElement('input');
    fi.type = 'file'; fi.id = 'me-import-file'; fi.accept = '.json';
    fi.style.display = 'none';
    fi.addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return; e.target.value = '';
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const data = JSON.parse(ev.target.result);
          const list = Array.isArray(data) ? data : [data];
          for (const col of list) {
            await colFetch('/import', { method: 'POST', body: JSON.stringify(col) });
          }
          await loadCollections(); render();
          showToastMsg(`Imported ${list.length} collection(s)`, 'success');
        } catch (err) { showToastMsg('Import failed: ' + err.message, 'error'); }
      };
      reader.readAsText(file);
    });
    _container.appendChild(fi);
  }
}

function showToastMsg(msg, type = 'info') {
  // Reuse the options page toast system if available
  const event = new CustomEvent('mocxy-toast', { detail: { msg, type } });
  document.dispatchEvent(event);
  // Fallback: inline message
  const t = el('div', { className: `me-toast me-toast-${type}`, textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 3000);
}

/* -------------------------------------------------------------------------- */
/*  Collection tree                                                           */
/* -------------------------------------------------------------------------- */

function renderTree() {
  const list  = _container.querySelector('#me-tree');
  const count = _container.querySelector('#me-count');
  if (!list) return;

  const total = _collections.reduce((s, c) => s + (c.mockCount || 0), 0);
  if (count) count.textContent = `${_collections.length} collection(s) · ${total} mock(s)`;

  if (_serverStatus !== 'connected') {
    list.innerHTML = '';
    list.appendChild(el('div', { className: 'me-empty',
      innerHTML: `Server offline<br><code>cd mock-server &amp;&amp; npm start</code>` }));
    return;
  }

  if (_collections.length === 0) {
    list.innerHTML = '';
    list.appendChild(el('div', { className: 'me-empty', textContent: 'No collections yet — click + New Collection' }));
    return;
  }

  list.innerHTML = '';
  _collections.forEach(col => renderCollectionNode(list, col));
}

function renderCollectionNode(container, col) {
  const open = _expanded[col.id]?.has('__root__') ?? true;
  const wrap = el('div', { className: 'me-col-wrap' });

  // Header
  const hdr = el('div', { className: 'me-col-hdr' });
  const arrow = el('span', { className: `me-arrow${open ? ' me-open' : ''}`, textContent: '▶' });
  const dot   = el('span', { className: `me-col-dot${col.enabled !== false ? ' me-dot-ok' : ''}` });
  const name  = el('span', { className: 'me-col-name', textContent: col.name });
  const cnt   = el('span', { className: 'me-col-cnt', textContent: col.mockCount || 0 });
  const menu  = el('button', { className: 'me-ctx-trigger', textContent: '⋯' });

  hdr.appendChild(arrow); hdr.appendChild(dot);
  hdr.appendChild(name);  hdr.appendChild(cnt); hdr.appendChild(menu);
  wrap.appendChild(hdr);

  hdr.addEventListener('click', async e => {
    if (e.target === menu) return;
    const nowOpen = !(_expanded[col.id]?.has('__root__') ?? true);
    toggleExpand(col.id, '__root__', nowOpen);
    if (nowOpen && !col._full) {
      try { col._full = await colFetch(`/${col.id}`); }
      catch (_) {}
    }
    renderTree();
  });

  menu.addEventListener('click', e => { e.stopPropagation(); showColCtxMenu(e, col); });

  // Items
  if (open) {
    const body = el('div', { className: 'me-col-body' });
    if (!col._full) {
      colFetch(`/${col.id}`).then(f => { col._full = f; renderTree(); }).catch(() => {});
      body.appendChild(el('div', { className: 'me-tree-loading', textContent: 'Loading…' }));
    } else {
      const items = col._full.items || [];
      if (items.length === 0) {
        body.appendChild(el('div', { className: 'me-tree-empty', textContent: 'Empty collection' }));
      } else {
        renderItems(body, col, items, col.id, null);
      }
    }
    wrap.appendChild(body);
  }

  container.appendChild(wrap);
}

function renderItems(container, col, items, colId, folderId) {
  items.forEach(item => {
    if (item.type === 'folder') renderFolderNode(container, col, item, colId);
    else if (item.type === 'mock') renderMockNode(container, col, item, colId, folderId);
  });
}

function renderFolderNode(container, col, folder, colId) {
  const open = _expanded[colId]?.has(folder.id) ?? false;
  const wrap = el('div', { className: 'me-folder-wrap' });

  const row = el('div', { className: 'me-folder-row' });
  row.appendChild(el('span', { className: `me-arrow${open ? ' me-open' : ''}`, textContent: '▶' }));
  row.appendChild(el('span', { className: 'me-folder-icon', textContent: '📁' }));
  row.appendChild(el('span', { className: 'me-folder-name', textContent: folder.name }));
  const menu = el('button', { className: 'me-ctx-trigger', textContent: '⋯' });
  row.appendChild(menu);
  wrap.appendChild(row);

  row.addEventListener('click', e => {
    if (e.target === menu) return;
    toggleExpand(colId, folder.id, !open);
    renderTree();
  });
  menu.addEventListener('click', e => { e.stopPropagation(); showFolderCtxMenu(e, col, folder, colId); });

  if (open) {
    const children = el('div', { className: 'me-folder-children' });
    const items = folder.items || [];
    if (items.length === 0) {
      children.appendChild(el('div', { className: 'me-tree-empty', textContent: 'Empty folder' }));
    } else {
      renderItems(children, col, items, colId, folder.id);
    }
    wrap.appendChild(children);
  }
  container.appendChild(wrap);
}

function renderMockNode(container, col, mock, colId, folderId) {
  const active = mock.id === _selectedId;
  const row    = el('div', { className: `me-mock-row${active ? ' me-mock-active' : ''}` });
  row.appendChild(methodBadge(mock.request?.method || 'ANY'));
  const info = el('div', { className: 'me-mock-info' });
  info.appendChild(el('div', { className: 'me-mock-name', textContent: mock.name || 'Untitled' }));
  info.appendChild(el('div', { className: 'me-mock-url',  textContent: mock.request?.url || '(any URL)' }));
  if (mock.stats?.matched) {
    info.appendChild(el('div', { className: 'me-mock-hits', textContent: `${mock.stats.matched} hits` }));
  }
  const menu = el('button', { className: 'me-ctx-trigger', textContent: '⋯' });
  menu.addEventListener('click', e => { e.stopPropagation(); showMockCtxMenu(e, col, mock, colId, folderId); });
  row.appendChild(info); row.appendChild(menu);
  row.addEventListener('click', e => { if (e.target !== menu) selectMock(mock, col, colId, folderId); });
  container.appendChild(row);
}

/* -------------------------------------------------------------------------- */
/*  Expand state                                                              */
/* -------------------------------------------------------------------------- */

function toggleExpand(colId, key, expand) {
  if (!_expanded[colId]) _expanded[colId] = new Set(['__root__']);
  expand ? _expanded[colId].add(key) : _expanded[colId].delete(key);
}

/* -------------------------------------------------------------------------- */
/*  Context menus                                                             */
/* -------------------------------------------------------------------------- */

function showCtxMenu(e, items) {
  _activeMenu?.remove();
  const menu = el('div', { className: 'me-ctx-menu' });
  items.forEach(item => {
    if (item.sep) { menu.appendChild(el('div', { className: 'me-ctx-sep' })); return; }
    const btn = el('button', { className: `me-ctx-item${item.danger ? ' me-ctx-danger' : ''}`, textContent: item.label });
    btn.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  _activeMenu = menu;
  const rect = e.target.getBoundingClientRect();
  menu.style.top  = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
  setTimeout(() => document.addEventListener('click', () => { menu.remove(); _activeMenu = null; }, { once: true }), 0);
}

function showColCtxMenu(e, col) {
  showCtxMenu(e, [
    { label: '+ Add Mock',    action: () => newMockInCollection(col, null) },
    { label: '+ Add Folder',  action: () => newFolderInCollection(col, null) },
    { sep: true },
    { label: '✎ Rename',      action: () => renameCollection(col) },
    { label: '⎘ Duplicate',   action: () => duplicateCollection(col) },
    { label: '↓ Export',      action: () => exportCollection(col) },
    { sep: true },
    { label: col.enabled !== false ? '○ Disable' : '● Enable', action: () => toggleCollection(col) },
    { label: '✕ Delete',      action: () => deleteCollection(col), danger: true },
  ]);
}

function showFolderCtxMenu(e, col, folder, colId) {
  showCtxMenu(e, [
    { label: '+ Add Mock',        action: () => newMockInCollection(col, folder.id) },
    { label: '+ Add Sub-folder',  action: () => newFolderInCollection(col, folder.id) },
    { sep: true },
    { label: '✎ Rename',          action: () => renameFolder(col, folder) },
    { label: '✕ Delete',          action: () => deleteFolder(col, folder), danger: true },
  ]);
}

function showMockCtxMenu(e, col, mock, colId, folderId) {
  showCtxMenu(e, [
    { label: '✎ Edit',      action: () => selectMock(mock, col, colId, folderId) },
    { label: '⎘ Duplicate', action: () => duplicateMock(col, mock, folderId) },
    { label: '↕ Move to…',  action: () => moveMockDialog(col, mock) },
    { sep: true },
    { label: '✕ Delete',    action: () => deleteMock(col, mock), danger: true },
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Selection + editor                                                        */
/* -------------------------------------------------------------------------- */

function selectMock(mock, col, colId, folderId) {
  _selectedId    = mock.id;
  _selectedColId = colId;
  _draft = JSON.parse(JSON.stringify(mock));
  _draft._colId    = colId;
  _draft._folderId = folderId;
  renderTree();
  renderEditor();
}

function showEditorEmpty() {
  const empty = _container.querySelector('#me-editor-empty');
  const form  = _container.querySelector('#me-editor-form');
  if (empty) empty.classList.remove('hidden');
  if (form)  form.classList.add('hidden');
}

function renderEditor() {
  const empty = _container.querySelector('#me-editor-empty');
  const form  = _container.querySelector('#me-editor-form');
  if (!form) return;
  if (!_draft) { showEditorEmpty(); return; }

  if (empty) empty.classList.add('hidden');
  form.classList.remove('hidden');
  form.innerHTML = '';
  form.appendChild(buildMockForm(_draft));
}

/* -------------------------------------------------------------------------- */
/*  Mock form builder                                                         */
/* -------------------------------------------------------------------------- */

function buildMockForm(draft) {
  const wrap = el('div', { className: 'me-form-wrap' });

  // Top row
  const top = el('div', { className: 'me-form-top' });
  const nameIn = el('input', { type: 'text', className: 'me-name-input', placeholder: 'Mock name…', value: draft.name || '' });
  nameIn.addEventListener('input', e => { draft.name = e.target.value; });
  const meta = el('div', { className: 'me-form-meta' });
  const prioLbl = el('label', { className: 'me-meta-label', textContent: 'Priority' });
  const prioIn  = el('input', { type: 'number', className: 'me-meta-input', value: String(draft.priority || 0), min: '0' });
  prioIn.addEventListener('input', e => { draft.priority = parseInt(e.target.value, 10) || 0; });
  const enLbl = el('label', { className: 'me-cb-label' });
  const enCb  = el('input', { type: 'checkbox' }); enCb.className = 'me-cb';
  enCb.checked = draft.enabled !== false;
  enCb.addEventListener('change', e => { draft.enabled = e.target.checked; });
  enLbl.appendChild(enCb); enLbl.appendChild(document.createTextNode(' Enabled'));
  prioLbl.appendChild(prioIn); meta.appendChild(prioLbl); meta.appendChild(enLbl);
  top.appendChild(nameIn); top.appendChild(meta);
  wrap.appendChild(top);

  // ── Request Matching ──
  const reqSec = formSection('① Request Matching');

  const urlRow = el('div', { className: 'me-url-row' });
  const methodSel = el('select', { className: 'me-method-sel' });
  ['ANY','GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].forEach(m => {
    const opt = el('option', { value: m, textContent: m });
    if ((draft.request?.method || 'ANY') === m) opt.selected = true;
    methodSel.appendChild(opt);
  });
  applyMethodColor(methodSel);
  methodSel.addEventListener('change', e => { draft.request.method = e.target.value; applyMethodColor(methodSel); });

  const urlTypeSel = el('select', { className: 'me-select me-url-type' });
  [['contains','Contains'],['equals','Equals'],['regex','Regex'],['path','Path Pattern']].forEach(([v,l]) => {
    const opt = el('option', { value: v, textContent: l });
    if ((draft.request?.urlMatchType || 'contains') === v) opt.selected = true;
    urlTypeSel.appendChild(opt);
  });
  urlTypeSel.addEventListener('change', e => { draft.request.urlMatchType = e.target.value; });

  const urlIn = el('input', { type: 'text', className: 'me-input me-url-in',
    placeholder: '/api/fleet/** or .*getAggByUrl.*', value: draft.request?.url || '' });
  urlIn.addEventListener('input', e => { draft.request.url = e.target.value; });
  urlRow.appendChild(methodSel); urlRow.appendChild(urlTypeSel); urlRow.appendChild(urlIn);
  reqSec.appendChild(urlRow);

  // Query params
  reqSec.appendChild(matchSectionHdr('Query Parameters', () => {
    draft.request.queryParams.push({ key:'', value:'', matchType:'equals', enabled:true });
    renderMatchTbl(qpWrap, draft.request.queryParams, 'Key', 'Value');
  }));
  draft.request.queryParams = draft.request.queryParams || [];
  const qpWrap = el('div', { className: 'me-match-wrap' });
  renderMatchTbl(qpWrap, draft.request.queryParams, 'Key', 'Value');
  reqSec.appendChild(qpWrap);

  // Request headers
  reqSec.appendChild(matchSectionHdr('Request Headers', () => {
    draft.request.headers.push({ name:'', value:'', matchType:'equals', enabled:true });
    renderMatchTbl(rhWrap, draft.request.headers, 'Name', 'Value');
  }));
  draft.request.headers = draft.request.headers || [];
  const rhWrap = el('div', { className: 'me-match-wrap' });
  renderMatchTbl(rhWrap, draft.request.headers, 'Name', 'Value');
  reqSec.appendChild(rhWrap);

  // Body patterns
  reqSec.appendChild(matchSectionHdr('Body Patterns', () => {
    draft.request.bodyPatterns.push({ type:'contains', value:'' });
    renderBodyPatterns(bpWrap, draft.request.bodyPatterns);
  }));
  draft.request.bodyPatterns = draft.request.bodyPatterns || [];
  const bpWrap = el('div', { className: 'me-match-wrap' });
  renderBodyPatterns(bpWrap, draft.request.bodyPatterns);
  reqSec.appendChild(bpWrap);
  wrap.appendChild(reqSec);

  // ── Response ──
  const respSec = formSection('② Response');

  // Status + Fault
  const metaRow = el('div', { className: 'me-resp-meta' });
  const stGrp = el('div', { className: 'me-resp-grp' });
  stGrp.appendChild(el('label', { className: 'me-field-label', textContent: 'Status Code' }));
  const stIn = el('input', { type:'number', className:'me-input me-input-sm',
    value: String(draft.response?.status || 200), min:'100', max:'599' });
  stIn.addEventListener('input', e => { draft.response.status = parseInt(e.target.value, 10) || 200; });
  stGrp.appendChild(stIn);

  const fltGrp = el('div', { className: 'me-resp-grp' });
  fltGrp.appendChild(el('label', { className: 'me-field-label', textContent: 'Fault Simulation' }));
  const fltSel = el('select', { className: 'me-select' });
  [['none','None'],['network_error','Network Error'],['empty_response','Empty Response']].forEach(([v,l]) => {
    const opt = el('option', { value: v, textContent: l });
    if ((draft.response?.fault || 'none') === v) opt.selected = true;
    fltSel.appendChild(opt);
  });
  fltSel.addEventListener('change', e => { draft.response.fault = e.target.value; });
  fltGrp.appendChild(fltSel);
  metaRow.appendChild(stGrp); metaRow.appendChild(fltGrp);
  respSec.appendChild(metaRow);

  // Delay + Jitter
  const delayRow = el('div', { className: 'me-resp-meta' });
  const dGrp = el('div', { className: 'me-resp-grp' });
  dGrp.appendChild(el('label', { className: 'me-field-label', textContent: 'Delay (ms)' }));
  const dIn = el('input', { type:'number', className:'me-input me-input-sm',
    value: String(draft.response?.delayMs || 0), min:'0' });
  dIn.addEventListener('input', e => { draft.response.delayMs = parseInt(e.target.value,10) || 0; });
  dGrp.appendChild(dIn);
  const jGrp = el('div', { className: 'me-resp-grp' });
  jGrp.appendChild(el('label', { className: 'me-field-label', textContent: 'Jitter (ms)' }));
  const jIn = el('input', { type:'number', className:'me-input me-input-sm',
    value: String(draft.response?.delayJitter || 0), min:'0', title:'Random 0–N ms added' });
  jIn.addEventListener('input', e => { draft.response.delayJitter = parseInt(e.target.value,10) || 0; });
  jGrp.appendChild(jIn);
  delayRow.appendChild(dGrp); delayRow.appendChild(jGrp);
  respSec.appendChild(delayRow);

  // Response headers KV
  respSec.appendChild(matchSectionHdr('Response Headers', () => addRespHdrRow('', '')));
  const rhContainer = el('div', { className: 'me-resp-hdrs' });
  function rebuildRespHdrs() {
    const rows = rhContainer.querySelectorAll('.me-resp-hdr-row');
    const obj  = {};
    rows.forEach(row => {
      const k = row.querySelector('.me-rhdr-k')?.value?.trim();
      const v = row.querySelector('.me-rhdr-v')?.value || '';
      if (k) obj[k] = v;
    });
    draft.response.headers = obj;
  }
  function addRespHdrRow(key, value) {
    const row = el('div', { className: 'me-resp-hdr-row' });
    const kIn = el('input', { type:'text', className:'me-input me-rhdr-k', placeholder:'Name', value:key });
    kIn.addEventListener('blur', rebuildRespHdrs);
    const vIn = el('input', { type:'text', className:'me-input me-rhdr-v', placeholder:'Value', value:value });
    vIn.addEventListener('blur', rebuildRespHdrs);
    const del = el('button', { className:'me-icon-del', innerHTML:'&#10005;' });
    del.addEventListener('click', () => { row.remove(); rebuildRespHdrs(); });
    row.appendChild(kIn); row.appendChild(vIn); row.appendChild(del);
    rhContainer.appendChild(row);
  }
  Object.entries(draft.response?.headers || {}).forEach(([k,v]) => addRespHdrRow(k, v));
  respSec.appendChild(rhContainer);

  // JSON body editor
  respSec.appendChild(el('label', { className: 'me-field-label', textContent: 'Response Body' }));
  const { editorEl, textarea } = buildJsonEditor(draft.response?.body || '{}');
  textarea.addEventListener('input', e => { draft.response.body = e.target.value; });
  respSec.appendChild(editorEl);
  wrap.appendChild(respSec);

  // Footer
  const footer = el('div', { className: 'me-form-footer' });
  const errEl  = el('div', { className: 'me-form-err hidden', id: 'me-form-err' });
  const cancelBtn = el('button', { className: 'me-btn me-btn-ghost', textContent: 'Cancel' });
  cancelBtn.addEventListener('click', () => { _selectedId = null; _draft = null; showEditorEmpty(); renderTree(); });
  const saveBtn = el('button', { className: 'me-btn me-btn-primary', textContent: 'Save Mock' });
  saveBtn.addEventListener('click', async () => {
    rebuildRespHdrs();
    if (!draft.name.trim()) { showFormErr('Please enter a mock name.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const cid = draft._colId; const fid = draft._folderId;
    try {
      let saved;
      if (draft.id && cid) {
        saved = await colFetch(`/${cid}/mocks/${draft.id}`, { method:'PUT', body:JSON.stringify(draft) });
      } else if (cid) {
        saved = await colFetch(`/${cid}/mocks`, { method:'POST', body:JSON.stringify({ ...draft, folderId: fid || undefined }) });
      }
      if (saved) {
        _selectedId = saved.id;
        // Invalidate the full-tree cache for this collection so it re-fetches on next expand
        const colObj = _collections.find(c => c.id === cid);
        if (colObj) colObj._full = null;
        await loadCollections();
        render();
        showToastMsg('Mock saved', 'success');
      }
    } catch (err) {
      showFormErr('Save failed: ' + err.message);
      saveBtn.disabled = false; saveBtn.textContent = 'Save Mock';
    }
  });
  footer.appendChild(errEl); footer.appendChild(cancelBtn); footer.appendChild(saveBtn);
  wrap.appendChild(footer);
  return wrap;
}

function showFormErr(msg) {
  const e = _container.querySelector('#me-form-err');
  if (!e) return; e.textContent = '⚠ ' + msg; e.classList.remove('hidden');
  setTimeout(() => e.classList.add('hidden'), 5000);
}

/* -------------------------------------------------------------------------- */
/*  Match table + body patterns                                               */
/* -------------------------------------------------------------------------- */

function formSection(title) {
  const sec = el('div', { className: 'me-section' });
  sec.appendChild(el('div', { className: 'me-section-title', textContent: title }));
  return sec;
}

function matchSectionHdr(label, onAdd) {
  const row = el('div', { className: 'me-match-hdr' });
  row.appendChild(el('span', { className: 'me-field-label', textContent: label }));
  const btn = el('button', { className: 'me-btn-add', textContent: '+ Add' });
  btn.addEventListener('click', onAdd);
  row.appendChild(btn);
  return row;
}

function renderMatchTbl(container, items, keyLbl, valLbl) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div', { className: 'me-match-empty', textContent: `No ${keyLbl.toLowerCase()} conditions` }));
    return;
  }
  const tbl = el('table', { className: 'me-match-tbl' });
  const thead = el('thead'); thead.innerHTML = `<tr><th></th><th>${keyLbl}</th><th>${valLbl}</th><th>Match</th><th></th></tr>`;
  tbl.appendChild(thead);
  const tbody = el('tbody');
  items.forEach((item, idx) => {
    const tr = el('tr');
    const cbTd = el('td'); const cb = el('input', { type:'checkbox' }); cb.checked = item.enabled !== false;
    cb.addEventListener('change', e => { items[idx].enabled = e.target.checked; }); cbTd.appendChild(cb); tr.appendChild(cbTd);
    const kTd = el('td'); const kIn = el('input', { type:'text', className:'me-match-in', value: item.key||item.name||'', placeholder:keyLbl });
    kIn.addEventListener('input', e => { items[idx].key = e.target.value; items[idx].name = e.target.value; }); kTd.appendChild(kIn); tr.appendChild(kTd);
    const vTd = el('td'); const vIn = el('input', { type:'text', className:'me-match-in', value: item.value||'', placeholder: item.matchType==='absent'?'(ignored)':valLbl });
    vIn.addEventListener('input', e => { items[idx].value = e.target.value; }); vTd.appendChild(vIn); tr.appendChild(vTd);
    const tTd = el('td'); const tSel = el('select', { className: 'me-match-type' });
    ['equals','contains','regex','absent'].forEach(v => { const opt = el('option',{value:v}); opt.textContent = v.charAt(0).toUpperCase()+v.slice(1); if((item.matchType||'equals')===v) opt.selected=true; tSel.appendChild(opt); });
    tSel.addEventListener('change', e => { items[idx].matchType = e.target.value; vIn.placeholder = e.target.value==='absent'?'(ignored)':valLbl; }); tTd.appendChild(tSel); tr.appendChild(tTd);
    const dTd = el('td'); const dBtn = el('button', { className:'me-icon-del', innerHTML:'&#10005;' });
    dBtn.addEventListener('click', () => { items.splice(idx,1); renderMatchTbl(container,items,keyLbl,valLbl); }); dTd.appendChild(dBtn); tr.appendChild(dTd);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); container.appendChild(tbl);
}

function renderBodyPatterns(container, patterns) {
  container.innerHTML = '';
  if (patterns.length === 0) { container.appendChild(el('div', { className:'me-match-empty', textContent:'No body patterns' })); return; }
  patterns.forEach((pat, idx) => {
    const row = el('div', { className:'me-bp-row' });
    const tSel = el('select', { className:'me-match-type' });
    ['contains','equals','jsonpath','regex'].forEach(v => { const opt = el('option',{value:v}); opt.textContent=v; if(pat.type===v) opt.selected=true; tSel.appendChild(opt); });
    tSel.addEventListener('change', e => { patterns[idx].type = e.target.value; });
    const vIn = el('input', { type:'text', className:'me-match-in me-bp-val', value:pat.value||'', placeholder:'e.g. $.version == "v3"' });
    vIn.addEventListener('input', e => { patterns[idx].value = e.target.value; });
    const del = el('button', { className:'me-icon-del', innerHTML:'&#10005;' });
    del.addEventListener('click', () => { patterns.splice(idx,1); renderBodyPatterns(container,patterns); });
    row.appendChild(tSel); row.appendChild(vIn); row.appendChild(del);
    container.appendChild(row);
  });
}

/* -------------------------------------------------------------------------- */
/*  JSON editor                                                               */
/* -------------------------------------------------------------------------- */

function buildJsonEditor(initialValue) {
  const editorEl = el('div', { className: 'me-json-wrap' });
  const toolbar  = el('div', { className: 'me-json-tb' });
  const valMsg   = el('span', { className: 'me-val-msg' });

  const fmtBtn = el('button', { className:'me-btn-sm', textContent:'Format' });
  const valBtn = el('button', { className:'me-btn-sm', textContent:'Validate' });
  const fileIn  = el('input', { type:'file', accept:'.json,.txt', style:'display:none' });
  const loadBtn = el('button', { className:'me-btn-sm', textContent:'Load File' });
  toolbar.appendChild(fmtBtn); toolbar.appendChild(valBtn);
  toolbar.appendChild(loadBtn); toolbar.appendChild(fileIn); toolbar.appendChild(valMsg);

  const edCont = el('div', { className: 'me-json-cont' });
  const lnEl   = el('div', { className: 'me-json-lns' });
  const inner  = el('div', { className: 'me-json-inner' });
  const hlPre  = el('pre', { className: 'me-json-hl' });
  const textarea = el('textarea', { className: 'me-json-ta', spellcheck: 'false' });
  textarea.value = initialValue;

  function updateLN() { lnEl.innerHTML = textarea.value.split('\n').map((_,i)=>`<span>${i+1}</span>`).join(''); }
  function applyHL()  { hlPre.innerHTML = highlightJson(textarea.value); }

  textarea.addEventListener('input',  e => { updateLN(); applyHL(); });
  textarea.addEventListener('scroll', () => { lnEl.scrollTop = textarea.scrollTop; hlPre.scrollTop = textarea.scrollTop; hlPre.scrollLeft = textarea.scrollLeft; });

  fmtBtn.addEventListener('click', () => { try { textarea.value = JSON.stringify(JSON.parse(textarea.value),null,2); applyHL(); updateLN(); showValMsg(valMsg,true,'Valid JSON'); } catch(e){ showValMsg(valMsg,false,e.message); } });
  valBtn.addEventListener('click', () => { try { JSON.parse(textarea.value); showValMsg(valMsg,true,'Valid JSON'); } catch(e){ showValMsg(valMsg,false,e.message); } });
  loadBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>{ textarea.value=ev.target.result; applyHL(); updateLN(); }; r.readAsText(f); });

  inner.appendChild(hlPre); inner.appendChild(textarea);
  edCont.appendChild(lnEl); edCont.appendChild(inner);
  editorEl.appendChild(toolbar); editorEl.appendChild(edCont);
  requestAnimationFrame(() => { updateLN(); applyHL(); });
  return { editorEl, textarea };
}

/* -------------------------------------------------------------------------- */
/*  Collection actions                                                        */
/* -------------------------------------------------------------------------- */

async function newMockInCollection(col, folderId) {
  const name = prompt('Mock name:', 'New Mock'); if (!name) return;
  try {
    const mock = await colFetch(`/${col.id}/mocks`, { method:'POST', body:JSON.stringify({ name, folderId: folderId||undefined }) });
    if (!_expanded[col.id]) _expanded[col.id] = new Set(['__root__']);
    _expanded[col.id].add('__root__');
    if (folderId) _expanded[col.id].add(folderId);
    col._full = await colFetch(`/${col.id}`);
    const found = findInTree(col._full.items, mock.id);
    if (found) selectMock(found, col, col.id, folderId);
    await loadCollections(); render();
  } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function newFolderInCollection(col, parentFolderId) {
  const name = prompt('Folder name:', 'New Folder'); if (!name) return;
  try {
    await colFetch(`/${col.id}/folders`, { method:'POST', body:JSON.stringify({ name, parentFolderId: parentFolderId||undefined }) });
    if (!_expanded[col.id]) _expanded[col.id] = new Set(['__root__']);
    _expanded[col.id].add('__root__');
    if (parentFolderId) _expanded[col.id].add(parentFolderId);
    await loadCollections(); col._full = null; render();
    showToastMsg('Folder created', 'success');
  } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function renameCollection(col) {
  const name = prompt('Collection name:', col.name); if (!name || name === col.name) return;
  try { await colFetch(`/${col.id}`, { method:'PUT', body:JSON.stringify({ name }) }); await loadCollections(); render(); showToastMsg('Renamed', 'success'); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function toggleCollection(col) {
  try { await colFetch(`/${col.id}`, { method:'PUT', body:JSON.stringify({ enabled: col.enabled === false }) }); await loadCollections(); render(); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function deleteCollection(col) {
  if (!confirm(`Delete collection "${col.name}" and ALL its mocks?`)) return;
  try {
    await colFetch(`/${col.id}`, { method:'DELETE' });
    if (_selectedColId === col.id) { _selectedId = null; _selectedColId = null; _draft = null; }
    await loadCollections(); render(); showToastMsg('Deleted', 'success');
  } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function duplicateCollection(col) {
  const name = prompt('Name for duplicate:', col.name + ' (copy)'); if (!name) return;
  try {
    const dup = await colFetch(`/${col.id}/duplicate`, { method:'POST', body:JSON.stringify({ name }) });
    _expanded[dup.id] = new Set(['__root__']);
    await loadCollections(); render(); showToastMsg(`Duplicated as "${dup.name}"`, 'success');
  } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function exportCollection(col) {
  try {
    const res  = await fetch(_serverUrl + `/mocxy/admin/collections/${col.id}/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${col.name.replace(/[^a-z0-9]/gi,'_')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToastMsg(`Exported "${col.name}"`, 'success');
  } catch (err) { showToastMsg('Export failed: ' + err.message, 'error'); }
}

async function renameFolder(col, folder) {
  const name = prompt('Folder name:', folder.name); if (!name || name === folder.name) return;
  try { await colFetch(`/${col.id}/folders/${folder.id}`, { method:'PUT', body:JSON.stringify({ name }) }); col._full = null; await loadCollections(); render(); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function deleteFolder(col, folder) {
  if (!confirm(`Delete folder "${folder.name}" and all its mocks?`)) return;
  try { await colFetch(`/${col.id}/folders/${folder.id}`, { method:'DELETE' }); col._full = null; await loadCollections(); render(); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function deleteMock(col, mock) {
  if (!confirm(`Delete mock "${mock.name || 'Untitled'}"?`)) return;
  try {
    await colFetch(`/${col.id}/mocks/${mock.id}`, { method:'DELETE' });
    if (_selectedId === mock.id) { _selectedId = null; _draft = null; showEditorEmpty(); }
    col._full = null; await loadCollections(); render();
  } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function duplicateMock(col, mock, folderId) {
  const { id, createdAt, updatedAt, stats, ...rest } = mock;
  rest.name = (rest.name || 'Untitled') + ' (copy)'; rest.folderId = folderId || undefined;
  try { await colFetch(`/${col.id}/mocks`, { method:'POST', body:JSON.stringify(rest) }); col._full = null; await loadCollections(); render(); showToastMsg('Duplicated', 'success'); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

async function moveMockDialog(col, mock) {
  const full = await colFetch(`/${col.id}`).catch(() => null); if (!full) return;
  const folders = []; function cf(items, d) { for (const i of (items||[])) { if (i.type==='folder') { folders.push({ id:i.id, name:'  '.repeat(d)+i.name }); cf(i.items, d+1); } } } cf(full.items, 0);
  const opts = ['(collection root)', ...folders.map(f=>f.name)];
  const choice = prompt(`Move "${mock.name}" to:\n${opts.map((o,i)=>`${i}: ${o}`).join('\n')}\n\nEnter number:`);
  if (choice === null) return;
  const idx = parseInt(choice, 10);
  if (isNaN(idx) || idx < 0 || idx > folders.length) return;
  const targetFolderId = idx === 0 ? null : folders[idx-1].id;
  try { await colFetch(`/${col.id}/mocks/${mock.id}/move`, { method:'PUT', body:JSON.stringify({ targetFolderId }) }); col._full = null; await loadCollections(); render(); showToastMsg('Moved', 'success'); }
  catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
}

function findInTree(items, id) {
  for (const item of (items||[])) {
    if (item.id === id) return item;
    if (item.type === 'folder') { const f = findInTree(item.items, id); if (f) return f; }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  OpenAPI import dialog                                                     */
/* -------------------------------------------------------------------------- */

function showSpecDialog() {
  const existing = _container.querySelector('#me-spec-dialog');
  if (existing) { existing.classList.remove('hidden'); return; }

  const backdrop = el('div', { className: 'me-spec-backdrop', id: 'me-spec-dialog' });
  const box = el('div', { className: 'me-spec-box' });

  // Header
  const hdr = el('div', { className: 'me-spec-hdr' });
  hdr.appendChild(el('span', { className: 'me-spec-title', textContent: 'Import OpenAPI Spec' }));
  const closeBtn = el('button', { className: 'me-spec-close', textContent: '×' });
  closeBtn.addEventListener('click', () => backdrop.classList.add('hidden'));
  hdr.appendChild(closeBtn); box.appendChild(hdr);

  // Body
  const body = el('div', { className: 'me-spec-body' });

  // Collection name
  body.appendChild(el('label', { className: 'me-spec-label', textContent: 'Collection Name' }));
  const nameIn = el('input', { type:'text', className:'me-input', placeholder:'Auto-detected from spec…' });
  body.appendChild(nameIn);

  // File picker
  body.appendChild(el('label', { className: 'me-spec-label', textContent: 'Spec File (JSON / YAML)' }));
  const fileRow  = el('div', { className: 'me-spec-file-row' });
  const fileLabel = el('span', { className: 'me-spec-filename', textContent: 'No file selected' });
  const browseBtn = el('button', { className: 'me-btn me-btn-ghost me-btn-sm', textContent: 'Browse…' });
  const fileIn    = el('input', { type:'file', accept:'.json,.yaml,.yml,.txt', style:'display:none' });
  browseBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    fileLabel.textContent = file.name;
    const r = new FileReader();
    r.onload = ev => {
      _specRaw = ev.target.result;
      importBtn.disabled = false;
      try {
        const p = JSON.parse(_specRaw);
        if (p?.info?.title && !nameIn.value) nameIn.value = p.info.title;
      } catch (_) {}
    };
    r.readAsText(file);
    e.target.value = '';
  });
  fileRow.appendChild(fileLabel); fileRow.appendChild(browseBtn); fileRow.appendChild(fileIn);
  body.appendChild(fileRow);

  // AI scenarios checkbox
  const scenRow = el('div', { className: 'me-spec-scen-row' });
  const scenCb  = el('input', { type:'checkbox' }); scenCb.className = 'me-cb';
  scenCb.disabled = !_aiKeyConfigured;
  const scenLbl = el('label', { className: 'me-cb-label' });
  scenLbl.appendChild(scenCb);
  scenLbl.appendChild(document.createTextNode(' Generate AI test scenarios'));
  const scenHint = el('span', { className: 'me-spec-hint',
    textContent: _aiKeyConfigured ? '' : '(configure AI key in Settings first)' });
  scenRow.appendChild(scenLbl); scenRow.appendChild(scenHint);
  body.appendChild(scenRow);

  const scenDesc = el('p', { className: 'me-spec-desc',
    textContent: 'AI will derive happy path, error (401/404/400/500) and create scenario mocks in a separate folder.' });
  scenDesc.style.display = 'none';
  scenCb.addEventListener('change', () => { scenDesc.style.display = scenCb.checked ? 'block' : 'none'; });
  body.appendChild(scenDesc);

  box.appendChild(body);

  // Footer
  const footer = el('div', { className: 'me-spec-footer' });
  const cancelBtn2 = el('button', { className: 'me-btn me-btn-ghost', textContent: 'Cancel' });
  cancelBtn2.addEventListener('click', () => backdrop.classList.add('hidden'));
  const importBtn  = el('button', { className: 'me-btn me-btn-primary', textContent: 'Import', disabled: true });
  importBtn.addEventListener('click', async () => {
    if (!_specRaw) return;
    importBtn.disabled = true;
    importBtn.textContent = scenCb.checked ? 'Generating scenarios…' : 'Importing…';
    try {
      const col = await colFetch('/import-openapi', { method:'POST', body:JSON.stringify({
        spec: _specRaw, name: nameIn.value.trim() || undefined, withScenarios: scenCb.checked,
      }) });
      _expanded[col.id] = new Set(['__root__']);
      await loadCollections(); render();
      backdrop.classList.add('hidden');
      showToastMsg(`"${col.name}" created`, 'success');
    } catch (err) {
      showToastMsg('Import failed: ' + err.message, 'error');
      importBtn.disabled = false; importBtn.textContent = 'Import';
    }
  });
  footer.appendChild(cancelBtn2); footer.appendChild(importBtn);
  box.appendChild(footer);

  backdrop.appendChild(box);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.classList.add('hidden'); });
  _container.appendChild(backdrop);
}

/* -------------------------------------------------------------------------- */
/*  Root render                                                               */
/* -------------------------------------------------------------------------- */

function render() {
  if (!_container) return;
  _container.innerHTML = '';

  // Status bar
  _container.appendChild(el('div', { id: 'me-status-bar', className: 'me-status-bar' }));

  // New collection button row
  const newRow = el('div', { className: 'me-new-row' });
  const newColBtn = el('button', { className: 'me-btn me-btn-primary me-btn-sm', textContent: '+ New Collection' });
  newColBtn.addEventListener('click', async () => {
    if (_serverStatus !== 'connected') return;
    const name = prompt('Collection name:', 'New Collection'); if (!name) return;
    try {
      const col = await colFetch('/', { method:'POST', body:JSON.stringify({ name }) });
      _expanded[col.id] = new Set(['__root__']);
      await loadCollections(); render(); showToastMsg('Collection created', 'success');
    } catch (err) { showToastMsg('Failed: ' + err.message, 'error'); }
  });
  const countEl = el('span', { id: 'me-count', className: 'me-col-cnt-total' });
  newRow.appendChild(newColBtn); newRow.appendChild(countEl);
  _container.appendChild(newRow);

  // Two-panel layout
  const layout = el('div', { className: 'me-layout' });

  // Left: tree
  const left = el('div', { className: 'me-left' });
  left.appendChild(el('div', { id: 'me-tree', className: 'me-tree' }));
  layout.appendChild(left);

  // Right: editor
  const right = el('div', { className: 'me-right' });
  const emptyEl = el('div', { id: 'me-editor-empty', className: 'me-editor-empty' });
  emptyEl.innerHTML = '<div style="font-size:32px;opacity:.3">📋</div><div>Select a mock to edit</div><div style="font-size:11px;margin-top:4px;opacity:.6">or click + New Collection to get started</div>';
  right.appendChild(emptyEl);
  right.appendChild(el('div', { id: 'me-editor-form', className: 'me-editor-form hidden' }));
  layout.appendChild(right);
  _container.appendChild(layout);

  renderStatusBar();
  renderTree();
  if (_draft && _selectedId) renderEditor();
}

/* -------------------------------------------------------------------------- */
/*  Injected styles                                                           */
/* -------------------------------------------------------------------------- */

function injectStyles() {
  if (document.getElementById('me-styles-v2')) return;
  const style = document.createElement('style');
  style.id = 'me-styles-v2';
  style.textContent = `
/* ── Status bar ─────────────────────────────────────────────────────────── */
.me-status-bar { display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--c-surface);border-bottom:1px solid var(--c-border);font-size:12px;flex-shrink:0;flex-wrap:wrap; }
.me-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0; }
.me-dot-ok  { background:var(--c-success);box-shadow:0 0 5px var(--c-success); }
.me-dot-off { background:var(--c-error); }
.me-status-txt  { color:var(--c-text); }
.me-status-meta { color:var(--c-subtle);margin-left:4px;font-size:11px; }
.me-status-meta code { background:var(--c-surface2);padding:1px 5px;border-radius:3px;color:var(--c-accent);font-family:var(--font-mono);font-size:10px; }
.me-status-actions { margin-left:auto;display:flex;gap:4px; }
.me-status-btn { background:none;border:1px solid var(--c-border);border-radius:3px;color:var(--c-muted);font-size:11px;padding:3px 8px;cursor:pointer;transition:background .12s;font-family:inherit; }
.me-status-btn:hover { background:var(--c-surface3);color:var(--c-text); }
.me-status-refresh { margin-left:2px; }

/* ── New row ─────────────────────────────────────────────────────────────── */
.me-new-row { display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--c-border);flex-shrink:0; }
.me-col-cnt-total { font-size:11px;color:var(--c-subtle); }

/* ── Layout ─────────────────────────────────────────────────────────────── */
.me-layout { display:flex;flex:1;overflow:hidden;min-height:480px; }
.me-left  { width:260px;min-width:220px;flex-shrink:0;border-right:1px solid var(--c-border);display:flex;flex-direction:column;overflow:hidden; }
.me-right { flex:1;overflow-y:auto;display:flex;flex-direction:column;background:var(--c-bg);scrollbar-width:thin;scrollbar-color:var(--c-border) transparent; }
.me-tree  { flex:1;overflow-y:auto;padding:4px 0;scrollbar-width:thin;scrollbar-color:var(--c-border) transparent; }

/* ── Collection nodes ────────────────────────────────────────────────────── */
.me-col-wrap { border-bottom:1px solid var(--c-border); }
.me-col-hdr  { display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;user-select:none;transition:background .12s; }
.me-col-hdr:hover { background:var(--c-surface3); }
.me-arrow { font-size:8px;color:var(--c-subtle);flex-shrink:0;width:10px;transition:transform .15s;display:inline-block; }
.me-open  { transform:rotate(90deg); }
.me-col-dot { width:7px;height:7px;border-radius:50%;background:var(--c-border2);flex-shrink:0; }
.me-col-name { flex:1;font-size:13px;font-weight:600;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-col-cnt  { font-size:10px;color:var(--c-subtle);background:var(--c-surface2);border-radius:10px;padding:1px 6px;flex-shrink:0; }
.me-ctx-trigger { background:none;border:none;color:var(--c-subtle);cursor:pointer;padding:0 4px;font-size:13px;line-height:1;border-radius:3px;opacity:0;transition:opacity .12s;flex-shrink:0;font-family:inherit; }
.me-col-hdr:hover .me-ctx-trigger,
.me-folder-row:hover .me-ctx-trigger,
.me-mock-row:hover .me-ctx-trigger { opacity:1; }
.me-ctx-trigger:hover { background:var(--c-surface3);color:var(--c-text); }
.me-col-body { background:var(--c-bg); }

/* ── Folder nodes ────────────────────────────────────────────────────────── */
.me-folder-row  { display:flex;align-items:center;gap:6px;padding:6px 10px 6px 20px;cursor:pointer;user-select:none;transition:background .12s; }
.me-folder-row:hover { background:var(--c-surface3); }
.me-folder-icon { font-size:11px;flex-shrink:0; }
.me-folder-name { flex:1;font-size:12px;color:var(--c-muted);font-weight:500; }
.me-folder-children { background:var(--c-bg); }

/* ── Mock nodes ──────────────────────────────────────────────────────────── */
.me-mock-row { display:flex;align-items:center;gap:8px;padding:6px 10px 6px 32px;cursor:pointer;border-bottom:1px solid var(--c-border);transition:background .12s; }
.me-mock-row:hover { background:var(--c-surface3); }
.me-mock-active { background:rgba(0,144,240,.08);border-left:3px solid var(--c-accent);padding-left:29px; }
.me-folder-children .me-mock-row { padding-left:42px; }
.me-folder-children .me-mock-active { padding-left:39px; }
.me-badge { font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;letter-spacing:.03em;flex-shrink:0;min-width:36px;text-align:center; }
.me-mock-info { flex:1;min-width:0; }
.me-mock-name { font-size:12px;font-weight:500;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-mock-url  { font-size:10px;color:var(--c-subtle);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-mock-hits { font-size:10px;color:var(--c-subtle); }
.me-tree-empty, .me-tree-loading { font-size:11px;color:var(--c-subtle);font-style:italic;padding:6px 10px 6px 26px; }
.me-empty { padding:32px 16px;text-align:center;font-size:12px;color:var(--c-subtle);line-height:1.8; }
.me-empty code { background:var(--c-surface2);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--c-accent);font-family:var(--font-mono); }

/* ── Context menu ────────────────────────────────────────────────────────── */
.me-ctx-menu { position:fixed;z-index:9999;background:var(--c-surface);border:1px solid var(--c-border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.4);min-width:160px;padding:4px 0; }
.me-ctx-item { display:block;width:100%;text-align:left;background:none;border:none;color:var(--c-text);font-size:12px;padding:7px 14px;cursor:pointer;transition:background .1s;font-family:inherit; }
.me-ctx-item:hover { background:var(--c-surface3); }
.me-ctx-danger { color:var(--c-error); }
.me-ctx-danger:hover { background:rgba(244,112,103,.1); }
.me-ctx-sep { height:1px;background:var(--c-border);margin:4px 0; }

/* ── Editor ──────────────────────────────────────────────────────────────── */
.me-editor-empty { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--c-subtle);font-size:13px;padding:40px;text-align:center; }
.me-editor-form  { flex:1;overflow-y:auto;padding:0;scrollbar-width:thin;scrollbar-color:var(--c-border) transparent; }
.me-form-wrap    { display:flex;flex-direction:column;gap:0;padding:16px; }
.me-form-top     { display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--c-border); }
.me-name-input   { flex:1;background:transparent;border:none;border-bottom:2px solid var(--c-border);color:var(--c-text);font-size:15px;font-weight:600;padding:2px 0 6px;outline:none;font-family:inherit;transition:border-color .2s; }
.me-name-input:focus { border-bottom-color:var(--c-accent); }
.me-name-input::placeholder { color:var(--c-subtle);font-weight:400; }
.me-form-meta { display:flex;align-items:center;gap:10px;flex-shrink:0; }
.me-meta-label { font-size:11px;color:var(--c-muted);display:flex;align-items:center;gap:5px; }
.me-meta-input { width:60px;background:var(--c-surface2);border:1px solid var(--c-border);border-radius:3px;color:var(--c-text);font-size:12px;padding:4px 6px;outline:none; }
.me-cb-label { display:flex;align-items:center;gap:5px;font-size:12px;color:var(--c-muted);cursor:pointer; }
.me-cb { accent-color:var(--c-accent); }

/* ── Form sections ───────────────────────────────────────────────────────── */
.me-section       { border:1px solid var(--c-border);border-radius:6px;padding:12px 14px;margin-bottom:12px; }
.me-section-title { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--c-accent);padding-bottom:10px;border-bottom:1px solid var(--c-border);margin-bottom:10px; }
.me-url-row       { display:flex;gap:6px;align-items:center;margin-bottom:10px; }
.me-method-sel    { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;font-size:12px;font-weight:700;padding:7px 10px;outline:none;cursor:pointer;min-width:82px;font-family:inherit; }
.me-url-type      { flex-shrink:0; }
.me-url-in        { flex:1; }
.me-field-label   { font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin:8px 0 4px; }
.me-input         { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;color:var(--c-text);font-size:12px;padding:7px 10px;outline:none;transition:border-color .2s;width:100%;box-sizing:border-box;font-family:inherit; }
.me-input:focus   { border-color:var(--c-accent); }
.me-input::placeholder { color:var(--c-subtle); }
.me-input-sm      { width:90px; }
.me-select        { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;color:var(--c-text);font-size:12px;padding:6px 8px;outline:none;cursor:pointer;font-family:inherit; }
.me-match-hdr     { display:flex;align-items:center;justify-content:space-between;margin:8px 0 4px; }
.me-btn-add       { background:none;border:1px solid var(--c-border);border-radius:3px;color:var(--c-accent);font-size:11px;padding:2px 8px;cursor:pointer;font-family:inherit; }
.me-btn-add:hover { background:var(--c-surface3); }
.me-match-wrap    { margin-bottom:6px; }
.me-match-empty   { font-size:11px;color:var(--c-subtle);font-style:italic;padding:3px 0; }
.me-match-tbl     { width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px; }
.me-match-tbl th  { text-align:left;padding:3px 5px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);background:var(--c-surface2);border-bottom:1px solid var(--c-border); }
.me-match-tbl td  { padding:2px 4px;border-bottom:1px solid var(--c-border); }
.me-match-in      { background:transparent;border:1px solid transparent;color:var(--c-text);font-size:12px;padding:3px 5px;outline:none;width:100%;border-radius:3px;transition:border-color .15s;font-family:inherit; }
.me-match-in:focus { border-color:var(--c-accent);background:var(--c-surface2); }
.me-match-type    { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:3px;color:var(--c-text);font-size:11px;padding:3px 5px;outline:none;cursor:pointer;font-family:inherit; }
.me-bp-row        { display:flex;gap:6px;align-items:center;margin-bottom:4px; }
.me-bp-val        { flex:1; }
.me-icon-del      { background:none;border:none;color:var(--c-subtle);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;border-radius:3px;font-family:inherit; }
.me-icon-del:hover { color:var(--c-error); }
.me-resp-meta     { display:flex;gap:14px;margin-bottom:8px;flex-wrap:wrap; }
.me-resp-grp      { display:flex;flex-direction:column;gap:4px; }
.me-resp-hdrs     { display:flex;flex-direction:column;gap:4px;margin-bottom:6px; }
.me-resp-hdr-row  { display:flex;gap:6px;align-items:center; }
.me-rhdr-k        { flex:2; }
.me-rhdr-v        { flex:3; }

/* ── JSON editor ─────────────────────────────────────────────────────────── */
.me-json-wrap { border:1px solid var(--c-border);border-radius:5px;overflow:hidden;margin-bottom:4px; }
.me-json-tb   { display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--c-surface2);border-bottom:1px solid var(--c-border); }
.me-btn-sm    { background:none;border:1px solid var(--c-border);border-radius:3px;color:var(--c-muted);font-size:11px;padding:2px 8px;cursor:pointer;font-family:inherit;transition:background .12s; }
.me-btn-sm:hover { background:var(--c-surface3);color:var(--c-text); }
.me-val-msg  { margin-left:auto;font-size:11px;font-weight:500; }
.me-val-ok   { color:var(--c-success); }
.me-val-err  { color:var(--c-error); }
.me-json-cont { display:flex;background:var(--c-bg-deep);min-height:140px;max-height:340px; }
.me-json-lns  { padding:10px 6px 10px 10px;text-align:right;color:var(--c-subtle);background:var(--c-surface);border-right:1px solid var(--c-border);font-family:var(--font-mono);font-size:12px;line-height:1.6;user-select:none;flex-shrink:0;min-width:34px;overflow:hidden; }
.me-json-lns span { display:block; }
.me-json-inner { flex:1;position:relative;overflow:auto; }
.me-json-hl   { position:absolute;inset:0;margin:0;padding:10px 12px;font-family:var(--font-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;pointer-events:none;overflow:auto;color:var(--c-text); }
.me-json-ta   { position:absolute;inset:0;background:transparent;border:none;color:transparent;caret-color:var(--c-text);font-family:var(--font-mono);font-size:12px;line-height:1.6;padding:10px 12px;resize:none;outline:none;overflow:auto;white-space:pre-wrap;z-index:1;pointer-events:auto;user-select:text;-webkit-user-select:text; }
.me-jh-key  { color:#9cdcfe; }
.me-jh-str  { color:#ce9178; }
.me-jh-num  { color:#b5cea8; }
.me-jh-bool { color:#569cd6; }
.me-jh-null { color:#569cd6; }
.me-jh-punc { color:var(--c-text); }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.me-btn { display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:background .12s;white-space:nowrap;font-family:inherit; }
.me-btn-primary { background:var(--c-accent);color:var(--c-accent-text); }
.me-btn-primary:hover { background:var(--c-accent-h); }
.me-btn-ghost   { background:transparent;color:var(--c-muted);border:1px solid var(--c-border); }
.me-btn-ghost:hover { background:var(--c-surface3);color:var(--c-text); }

/* ── Form footer ─────────────────────────────────────────────────────────── */
.me-form-footer { display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;border-top:1px solid var(--c-border);margin-top:4px; }
.me-form-err    { flex:1;padding:6px 10px;background:rgba(244,112,103,.1);border:1px solid var(--c-error);border-radius:4px;color:var(--c-error);font-size:12px; }

/* ── OpenAPI import dialog ───────────────────────────────────────────────── */
.me-spec-backdrop { position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center; }
.me-spec-box      { background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px;width:440px;max-width:95vw;box-shadow:0 16px 48px rgba(0,0,0,.4); }
.me-spec-hdr      { display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--c-border); }
.me-spec-title    { font-size:14px;font-weight:600;color:var(--c-text); }
.me-spec-close    { background:none;border:none;color:var(--c-muted);font-size:20px;cursor:pointer;padding:2px 6px;border-radius:3px;font-family:inherit; }
.me-spec-close:hover { background:var(--c-surface3);color:var(--c-text); }
.me-spec-body     { padding:14px 16px;display:flex;flex-direction:column;gap:10px; }
.me-spec-label    { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted); }
.me-spec-file-row { display:flex;align-items:center;gap:8px; }
.me-spec-filename { flex:1;font-size:12px;color:var(--c-muted);background:var(--c-surface2);border:1px solid var(--c-border);border-radius:3px;padding:6px 10px;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-spec-scen-row { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
.me-spec-hint     { font-size:11px;color:var(--c-subtle); }
.me-spec-desc     { font-size:11px;color:var(--c-subtle);line-height:1.5;margin:0; }
.me-spec-footer   { display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--c-border); }

/* ── Toast ───────────────────────────────────────────────────────────────── */
.me-toast { position:fixed;bottom:20px;right:20px;z-index:20000;padding:10px 16px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:5px;font-size:13px;color:var(--c-text);box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .2s; }
.me-toast-success { border-left:3px solid var(--c-success); }
.me-toast-error   { border-left:3px solid var(--c-error); }
.me-toast-info    { border-left:3px solid var(--c-accent); }
`;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  Public init                                                               */
/* -------------------------------------------------------------------------- */

export async function initMockEditor(container) {
  _container = container;
  injectStyles();

  _serverUrl = await getMockServerUrl();
  await checkConnection();
  if (_serverStatus === 'connected') {
    await checkAiKey();
    await loadCollections();
  }

  render();

  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(async () => {
    _serverUrl = await getMockServerUrl();
    await checkConnection();
    if (_serverStatus === 'connected') {
      await checkAiKey();
      await loadCollections();
    }
    renderStatusBar();
    renderTree();
  }, 30000);
}
