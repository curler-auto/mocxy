/**
 * Mocxy — Mock Collections Editor
 *
 * Connects to the standalone Mocxy mock server and provides a
 * WireMock-level UI for creating, editing and deleting mocks.
 *
 * Left panel  : flat mock list with method badge, URL, hit count
 * Right panel : full mock editor (request matching + response config)
 * Top bar     : server connection status + refresh
 */

import { HTTP_METHODS, STORAGE_KEYS, DEFAULT_MOCK_SERVER_URL } from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let _container    = null;
let _mocks        = [];       // flat array from server
let _selectedId   = null;
let _serverUrl    = DEFAULT_MOCK_SERVER_URL;
let _serverStatus = 'unknown'; // 'connected' | 'offline' | 'unknown'
let _serverInfo   = null;
let _refreshTimer = null;

/* -------------------------------------------------------------------------- */
/*  Server API helpers                                                        */
/* -------------------------------------------------------------------------- */

async function getMockServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.MOCK_SERVER_URL, (r) => {
      resolve(r[STORAGE_KEYS.MOCK_SERVER_URL] || DEFAULT_MOCK_SERVER_URL);
    });
  });
}

async function serverFetch(path, options = {}) {
  const url = _serverUrl + '/mocxy/admin' + path;
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal:  AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

async function checkConnection() {
  try {
    _serverInfo   = await serverFetch('/health');
    _serverStatus = 'connected';
  } catch (_) {
    _serverStatus = 'offline';
    _serverInfo   = null;
  }
}

async function loadMocks() {
  if (_serverStatus !== 'connected') { _mocks = []; return; }
  try {
    const list = await serverFetch('/mocks');
    _mocks = Array.isArray(list) ? list : [];
  } catch (_) {
    _mocks = [];
  }
}

async function saveMock(mock) {
  if (mock.id) {
    return serverFetch(`/mocks/${mock.id}`, { method: 'PUT',  body: JSON.stringify(mock) });
  }
  return serverFetch('/mocks', { method: 'POST', body: JSON.stringify(mock) });
}

async function deleteMock(id) {
  return serverFetch(`/mocks/${id}`, { method: 'DELETE' });
}

/**
 * Called whenever a server call fails.
 * Immediately rechecks the connection and refreshes the status bar
 * so the user sees "● Offline" right away instead of waiting 30s.
 */
async function handleServerError(err) {
  const isNetworkErr = err.name === 'TypeError' || err.name === 'AbortError'
    || err.message.toLowerCase().includes('fetch')
    || err.message.toLowerCase().includes('network')
    || err.message.toLowerCase().includes('failed');
  if (isNetworkErr) {
    await checkConnection();
    updateStatusBar();
  }
  return err.message;
}

/** Show an inline error below the form (auto-dismisses after 5s). */
function showFormError(msg) {
  const old = _container?.querySelector('.me-form-error');
  if (old) old.remove();
  const div = document.createElement('div');
  div.className = 'me-form-error';
  div.innerHTML = `<span>⚠ ${msg}</span>`;
  const footer = _container?.querySelector('.me-form-actions');
  if (footer) footer.before(div);
  setTimeout(() => div.remove(), 5000);
}

/** Show an inline error in the left panel (for delete failures). */
function showListError(msg) {
  const old = _container?.querySelector('.me-list-error');
  if (old) old.remove();
  const div = document.createElement('div');
  div.className = 'me-list-error';
  div.innerHTML = `<span>⚠ ${msg}</span>`;
  const list = _container?.querySelector('.me-mock-list');
  if (list) list.before(div);
  setTimeout(() => div.remove(), 5000);
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
  children.forEach((c) => {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  });
  return node;
}

/* -------------------------------------------------------------------------- */
/*  Method badge colours                                                      */
/* -------------------------------------------------------------------------- */

const METHOD_COLORS = {
  ANY:     { bg: 'rgba(110,110,110,0.15)', text: 'var(--c-muted)' },
  GET:     { bg: 'rgba(78,201,176,0.15)',  text: 'var(--c-success)' },
  POST:    { bg: 'rgba(215,186,125,0.15)', text: 'var(--c-warning)' },
  PUT:     { bg: 'rgba(0,120,212,0.15)',   text: 'var(--c-accent)' },
  DELETE:  { bg: 'rgba(244,112,103,0.15)', text: 'var(--c-error)' },
  PATCH:   { bg: 'rgba(197,134,192,0.15)', text: '#c586c0' },
  HEAD:    { bg: 'rgba(110,110,110,0.15)', text: 'var(--c-muted)' },
  OPTIONS: { bg: 'rgba(110,110,110,0.15)', text: 'var(--c-muted)' },
};

function methodBadge(method) {
  const m      = (method || 'ANY').toUpperCase();
  const colors = METHOD_COLORS[m] || METHOD_COLORS.ANY;
  const badge  = document.createElement('span');
  badge.className = 'me-method-badge';
  badge.textContent = m;
  badge.style.background = colors.bg;
  badge.style.color      = colors.text;
  return badge;
}

function applyMethodSelectStyle(sel) {
  const colors = METHOD_COLORS[(sel.value || 'ANY').toUpperCase()] || METHOD_COLORS.ANY;
  sel.style.color = colors.text;
}

/* -------------------------------------------------------------------------- */
/*  JSON highlighting                                                         */
/* -------------------------------------------------------------------------- */

function highlightJson(raw) {
  if (!raw) return '';
  const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b)|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, nul, num) => {
      if (str && colon) return `<span class="jh-key">${str}</span><span class="jh-punc">:</span>`;
      if (str)  return `<span class="jh-string">${str}</span>`;
      if (bool) return `<span class="jh-bool">${m}</span>`;
      if (nul !== undefined && m === 'null') return `<span class="jh-null">null</span>`;
      if (num)  return `<span class="jh-number">${m}</span>`;
      return m;
    }
  );
}

function showValidation(msgEl, valid, text) {
  msgEl.textContent = (valid ? '✔ ' : '✖ ') + text;
  msgEl.className = 'me-json-validation-msg ' + (valid ? 'me-valid' : 'me-invalid');
  clearTimeout(msgEl._t);
  msgEl._t = setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'me-json-validation-msg'; }, 4000);
}

/* -------------------------------------------------------------------------- */
/*  Status bar                                                                */
/* -------------------------------------------------------------------------- */

function updateStatusBar() {
  const bar = _container?.querySelector('#me-status-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const dot  = el('span', { className: `me-status-dot me-status-${_serverStatus === 'connected' ? 'connected' : 'offline'}` });
  const text = el('span', { className: 'me-status-text' });
  const meta = el('span', { className: 'me-status-meta' });

  if (_serverStatus === 'connected') {
    const info = _serverInfo || {};
    text.innerHTML = `Connected to <strong>${_serverUrl}</strong>`;
    meta.textContent = `${info.mocks || 0} mocks · v${info.version || '?'} · uptime ${Math.floor((info.uptime || 0) / 60)}m`;
  } else {
    text.innerHTML = '<span style="color:var(--c-error)">Mock server offline</span>';
    meta.innerHTML = `Start: <code>cd mock-server &amp;&amp; npm start</code>`;
  }

  const refreshBtn = el('button', {
    className: 'me-status-refresh',
    textContent: '↻ Refresh',
    onClick: async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '↻ …';
      _serverUrl = await getMockServerUrl();
      await checkConnection();
      if (_serverStatus === 'connected') await loadMocks();
      render();
    },
  });

  bar.appendChild(dot);
  bar.appendChild(text);
  bar.appendChild(meta);
  bar.appendChild(refreshBtn);
}

/* -------------------------------------------------------------------------- */
/*  Left panel — mock list                                                    */
/* -------------------------------------------------------------------------- */

function renderMockList() {
  const panel = _container.querySelector('#me-left-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const header = el('div', { className: 'me-left-header' });
  header.appendChild(el('span', { className: 'me-left-title', textContent: 'Mocks' }));
  header.appendChild(el('button', {
    className: 'me-new-btn', textContent: '+ New',
    onClick: () => { _selectedId = null; renderEditor(); },
  }));
  panel.appendChild(header);

  if (_serverStatus !== 'connected') {
    panel.appendChild(el('div', {
      className: 'me-offline-hint',
      innerHTML: 'Start the server to<br>manage mocks<br><code>cd mock-server &amp;&amp; npm start</code>',
    }));
    return;
  }

  if (_mocks.length === 0) {
    panel.appendChild(el('div', {
      className: 'me-offline-hint',
      textContent: 'No mocks yet. Click + New.',
    }));
    return;
  }

  const list   = el('div', { className: 'me-mock-list' });
  const sorted = [..._mocks].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  sorted.forEach((mock) => {
    const item    = el('div', { className: `me-mock-item${mock.id === _selectedId ? ' selected' : ''}` });
    const badge   = methodBadge(mock.request?.method || 'ANY');
    const info    = el('div', { className: 'me-mock-item-info' });
    info.appendChild(el('div', { className: 'me-mock-item-name', textContent: mock.name || 'Untitled' }));
    info.appendChild(el('div', { className: 'me-mock-item-url',  textContent: mock.request?.url || '(any URL)' }));
    info.appendChild(el('div', { className: 'me-mock-item-hits', textContent: `${mock.stats?.matched || 0} hits` }));

    const actions = el('div', { className: 'me-mock-item-actions' });
    actions.appendChild(el('button', {
      className: 'me-icon-btn me-icon-btn-danger', innerHTML: '&#10005;', title: 'Delete',
      onClick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete mock "${mock.name || 'Untitled'}"?`)) return;
        try {
          await deleteMock(mock.id);
          if (_selectedId === mock.id) _selectedId = null;
          await loadMocks();
          render();
        } catch (err) {
          const msg = await handleServerError(err);
          showListError(`Delete failed: ${msg}`);
        }
      },
    }));

    item.appendChild(badge);
    item.appendChild(info);
    item.appendChild(actions);
    item.addEventListener('click', () => { _selectedId = mock.id; render(); });
    list.appendChild(item);
  });

  panel.appendChild(list);
}

/* -------------------------------------------------------------------------- */
/*  Right panel — mock editor                                                 */
/* -------------------------------------------------------------------------- */

function renderEditor() {
  const panel = _container.querySelector('#me-right-panel');
  if (!panel) return;
  panel.innerHTML = '';

  if (_serverStatus !== 'connected') {
    panel.appendChild(el('div', {
      className: 'me-empty-state',
      innerHTML: `<div class="me-empty-icon">⚡</div>
        <div><strong>Mock server offline</strong></div>
        <div style="font-size:12px;margin-top:6px">Start: <code>cd mock-server &amp;&amp; npm start</code></div>`,
    }));
    return;
  }

  const existing = _selectedId ? _mocks.find((m) => m.id === _selectedId) : null;

  if (!_selectedId) {
    panel.appendChild(buildMockForm(createBlankMock()));
    return;
  }
  if (!existing) {
    panel.appendChild(el('div', { className: 'me-empty-state', textContent: 'Select a mock to edit.' }));
    return;
  }
  panel.appendChild(buildMockForm(existing));
}

function createBlankMock() {
  return {
    id: null, name: '', priority: 0, enabled: true,
    request:  { method: 'ANY', urlMatchType: 'contains', url: '', queryParams: [], headers: [], bodyPatterns: [] },
    response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}', delayMs: 0, delayJitter: 0, fault: 'none' },
  };
}

/* -------------------------------------------------------------------------- */
/*  Mock form                                                                 */
/* -------------------------------------------------------------------------- */

function buildMockForm(mock) {
  const draft = JSON.parse(JSON.stringify(mock));
  draft.request  = draft.request  || {};
  draft.response = draft.response || {};

  const form = el('div', { className: 'me-mock-form' });

  // Top row: name + priority + enabled
  const topRow = el('div', { className: 'me-form-top-row' });
  const nameIn = el('input', {
    type: 'text', className: 'me-form-input me-name-input',
    placeholder: 'Mock name…', value: draft.name || '',
    onInput: (e) => { draft.name = e.target.value; },
  });
  const prioLbl = el('label', { className: 'me-prio-label', textContent: 'Priority' });
  const prioIn  = el('input', {
    type: 'number', className: 'me-form-input me-prio-input',
    value: String(draft.priority || 0), min: '0',
    onInput: (e) => { draft.priority = parseInt(e.target.value, 10) || 0; },
  });
  const enLbl = el('label', { className: 'me-enabled-label' });
  const enCb  = el('input', { type: 'checkbox' });
  enCb.checked = draft.enabled !== false;
  enCb.addEventListener('change', (e) => { draft.enabled = e.target.checked; });
  enLbl.appendChild(enCb);
  enLbl.appendChild(document.createTextNode(' Enabled'));
  topRow.appendChild(nameIn); topRow.appendChild(prioLbl);
  topRow.appendChild(prioIn); topRow.appendChild(enLbl);
  form.appendChild(topRow);

  // ── REQUEST MATCHING ────────────────────────────────────────────────────
  const reqSec = el('fieldset', { className: 'me-wm-section' });
  reqSec.appendChild(el('legend', { className: 'me-wm-legend', textContent: '① Request Matching' }));

  // Method + urlType + url
  const urlRow    = el('div', { className: 'me-url-row' });
  const methodSel = el('select', { className: 'me-method-select' });
  ['ANY','GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].forEach((m) => {
    const opt = el('option', { value: m, textContent: m });
    if ((draft.request.method || 'ANY') === m) opt.selected = true;
    methodSel.appendChild(opt);
  });
  applyMethodSelectStyle(methodSel);
  methodSel.addEventListener('change', (e) => { draft.request.method = e.target.value; applyMethodSelectStyle(methodSel); });

  const urlTypeSel = el('select', { className: 'me-form-select me-url-type-sel' });
  [['contains','Contains'],['equals','Equals'],['regex','Regex'],['path','Path Pattern']].forEach(([v,l]) => {
    const opt = el('option', { value: v, textContent: l });
    if ((draft.request.urlMatchType || 'contains') === v) opt.selected = true;
    urlTypeSel.appendChild(opt);
  });
  urlTypeSel.addEventListener('change', (e) => { draft.request.urlMatchType = e.target.value; });

  const urlIn = el('input', {
    type: 'text', className: 'me-form-input me-url-input',
    placeholder: '/api/fleet/** or .*getAggByUrl.*',
    value: draft.request.url || '',
    onInput: (e) => { draft.request.url = e.target.value; },
  });
  urlRow.appendChild(methodSel); urlRow.appendChild(urlTypeSel); urlRow.appendChild(urlIn);
  reqSec.appendChild(urlRow);

  // Query Params
  reqSec.appendChild(el('div', { className: 'me-form-label', textContent: 'Query Parameters' }));
  draft.request.queryParams = draft.request.queryParams || [];
  const qpWrap = el('div', { className: 'me-match-table-wrap' });
  renderMatchTable(qpWrap, draft.request.queryParams, 'Key', 'Value');
  reqSec.appendChild(qpWrap);
  reqSec.appendChild(el('button', {
    type: 'button', className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Query Param',
    onClick: () => { draft.request.queryParams.push({ key:'', value:'', matchType:'equals', enabled:true }); renderMatchTable(qpWrap, draft.request.queryParams, 'Key', 'Value'); },
  }));

  // Request Headers
  reqSec.appendChild(el('div', { className: 'me-form-label', textContent: 'Request Headers' }));
  draft.request.headers = draft.request.headers || [];
  const rhWrap = el('div', { className: 'me-match-table-wrap' });
  renderMatchTable(rhWrap, draft.request.headers, 'Header Name', 'Value');
  reqSec.appendChild(rhWrap);
  reqSec.appendChild(el('button', {
    type: 'button', className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Header Match',
    onClick: () => { draft.request.headers.push({ name:'', value:'', matchType:'equals', enabled:true }); renderMatchTable(rhWrap, draft.request.headers, 'Header Name', 'Value'); },
  }));

  // Body Patterns
  reqSec.appendChild(el('div', { className: 'me-form-label', textContent: 'Body Patterns (AND logic)' }));
  draft.request.bodyPatterns = draft.request.bodyPatterns || [];
  const bpList = el('div', { className: 'me-body-patterns-list' });
  renderBodyPatterns(bpList, draft.request.bodyPatterns);
  reqSec.appendChild(bpList);
  reqSec.appendChild(el('button', {
    type: 'button', className: 'me-btn me-btn-secondary me-btn-sm', textContent: '+ Add Body Pattern',
    onClick: () => { draft.request.bodyPatterns.push({ type:'contains', value:'' }); renderBodyPatterns(bpList, draft.request.bodyPatterns); },
  }));

  form.appendChild(reqSec);

  // ── RESPONSE ────────────────────────────────────────────────────────────
  const respSec = el('fieldset', { className: 'me-wm-section' });
  respSec.appendChild(el('legend', { className: 'me-wm-legend', textContent: '② Response' }));

  // Status + Fault
  const statusRow = el('div', { className: 'me-meta-row' });
  const stGrp = el('div', { className: 'me-meta-group' });
  stGrp.appendChild(el('label', { className: 'me-form-label', textContent: 'Status Code' }));
  stGrp.appendChild(el('input', { type:'number', className:'me-form-input me-form-input-short', value:String(draft.response.status||200), min:'100', max:'599', onInput:(e)=>{ draft.response.status=parseInt(e.target.value,10)||200; } }));
  const fltGrp = el('div', { className: 'me-meta-group' });
  fltGrp.appendChild(el('label', { className: 'me-form-label', textContent: 'Fault Simulation' }));
  const fltSel = el('select', { className: 'me-form-select' });
  [['none','None — normal response'],['network_error','Network Error'],['empty_response','Empty Response']].forEach(([v,l])=>{
    const opt = el('option',{value:v,textContent:l}); if((draft.response.fault||'none')===v) opt.selected=true; fltSel.appendChild(opt);
  });
  fltSel.addEventListener('change',(e)=>{ draft.response.fault=e.target.value; });
  fltGrp.appendChild(fltSel);
  statusRow.appendChild(stGrp); statusRow.appendChild(fltGrp);
  respSec.appendChild(statusRow);

  // Delay + Jitter
  const delayRow = el('div', { className: 'me-meta-row' });
  const dGrp = el('div', { className: 'me-meta-group' });
  dGrp.appendChild(el('label',{className:'me-form-label',textContent:'Delay (ms)'}));
  dGrp.appendChild(el('input',{type:'number',className:'me-form-input me-form-input-short',value:String(draft.response.delayMs||0),min:'0',onInput:(e)=>{ draft.response.delayMs=parseInt(e.target.value,10)||0; }}));
  const jGrp = el('div',{className:'me-meta-group'});
  jGrp.appendChild(el('label',{className:'me-form-label',textContent:'Jitter (ms)'}));
  jGrp.appendChild(el('input',{type:'number',className:'me-form-input me-form-input-short',value:String(draft.response.delayJitter||0),min:'0',title:'Random 0–N ms added',onInput:(e)=>{ draft.response.delayJitter=parseInt(e.target.value,10)||0; }}));
  delayRow.appendChild(dGrp); delayRow.appendChild(jGrp);
  respSec.appendChild(delayRow);

  // Response Headers
  respSec.appendChild(el('div',{className:'me-form-label',textContent:'Response Headers'}));
  const rhContainer = el('div',{className:'me-headers-list'});
  const respHdrs = draft.response.headers || {};

  function rebuildRespHdrs() {
    const rows = rhContainer.querySelectorAll('.me-header-row'); const obj={};
    rows.forEach((row)=>{ const k=row.querySelector('.me-header-key')?.value?.trim(); const v=row.querySelector('.me-header-value')?.value||''; if(k) obj[k]=v; });
    draft.response.headers=obj;
  }
  function addRespHdrRow(key='',value='') {
    const row=el('div',{className:'me-header-row'});
    row.appendChild(el('input',{type:'text',className:'me-form-input me-header-key',value:key,placeholder:'Header name',onBlur:rebuildRespHdrs}));
    row.appendChild(el('input',{type:'text',className:'me-form-input me-header-value',value:value,placeholder:'Header value',onBlur:rebuildRespHdrs}));
    row.appendChild(el('button',{className:'me-icon-btn me-icon-btn-danger',innerHTML:'&#10005;',onClick:()=>{ row.remove(); rebuildRespHdrs(); }}));
    rhContainer.appendChild(row);
  }
  Object.entries(respHdrs).forEach(([k,v])=>addRespHdrRow(k,v));
  respSec.appendChild(rhContainer);
  respSec.appendChild(el('button',{type:'button',className:'me-btn me-btn-secondary me-btn-sm',textContent:'+ Add Header',onClick:()=>addRespHdrRow()}));

  // Body editor
  respSec.appendChild(el('div',{className:'me-form-label',textContent:'Response Body'}));
  const edWrap  = el('div',{className:'me-json-editor-wrapper'});
  const toolbar = el('div',{className:'me-json-toolbar'});
  const valMsg  = el('span',{className:'me-json-validation-msg'});
  const bodyArea = el('textarea',{
    className:'me-json-textarea', spellcheck:'false',
    onInput:(e)=>{ draft.response.body=e.target.value; updateLN(); },
    onBlur:()=>applyHL(),
    onScroll:()=>{ lnEl.scrollTop=bodyArea.scrollTop; hlPre.scrollTop=bodyArea.scrollTop; hlPre.scrollLeft=bodyArea.scrollLeft; },
  });
  bodyArea.value = draft.response.body || '{}';

  toolbar.appendChild(el('button',{type:'button',className:'me-btn me-btn-secondary me-btn-sm',textContent:'Format',onClick:()=>{ try{ const p=JSON.parse(bodyArea.value); bodyArea.value=JSON.stringify(p,null,2); draft.response.body=bodyArea.value; applyHL(); showValidation(valMsg,true,'Valid JSON'); }catch(err){ showValidation(valMsg,false,err.message); }}}));
  toolbar.appendChild(el('button',{type:'button',className:'me-btn me-btn-secondary me-btn-sm',textContent:'Validate',onClick:()=>{ try{ JSON.parse(bodyArea.value); showValidation(valMsg,true,'Valid JSON'); }catch(err){ showValidation(valMsg,false,err.message); }}}));
  const fileIn=el('input',{type:'file',accept:'.json,.txt',className:'me-hidden-file-input',onChange:(e)=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=(ev)=>{ bodyArea.value=ev.target.result; draft.response.body=bodyArea.value; applyHL(); }; r.readAsText(f); }});
  toolbar.appendChild(el('button',{type:'button',className:'me-btn me-btn-secondary me-btn-sm',textContent:'Load File',onClick:()=>fileIn.click()}));
  toolbar.appendChild(fileIn); toolbar.appendChild(valMsg);
  edWrap.appendChild(toolbar);

  const edCont = el('div',{className:'me-json-editor-container'});
  const lnEl   = el('div',{className:'me-json-line-numbers'});
  const hlPre  = el('pre',{className:'me-json-highlight-pre'});

  function updateLN(){ const lines=bodyArea.value.split('\n'); lnEl.innerHTML=lines.map((_,i)=>`<span>${i+1}</span>`).join(''); }
  function applyHL(){ hlPre.innerHTML=highlightJson(bodyArea.value); }

  edCont.appendChild(lnEl); edCont.appendChild(hlPre); edCont.appendChild(bodyArea);
  edWrap.appendChild(edCont);
  respSec.appendChild(edWrap);
  requestAnimationFrame(()=>{ updateLN(); applyHL(); });
  form.appendChild(respSec);

  // Footer
  const footer = el('div',{className:'me-form-actions'});
  footer.appendChild(el('button',{type:'button',className:'me-btn me-btn-secondary',textContent:'Cancel',onClick:()=>{ _selectedId=null; render(); }}));
  footer.appendChild(el('button',{type:'button',className:'me-btn me-btn-primary',textContent:'Save Mock',
    onClick: async () => {
      rebuildRespHdrs();
      if (!draft.name) { showFormError('Please enter a mock name.'); return; }
      const saveBtn = form.querySelector('.me-btn-primary');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
      try {
        const saved = await saveMock(draft);
        _selectedId = saved.id;
        await loadMocks();
        render();
      } catch (err) {
        const msg = await handleServerError(err);
        showFormError(`Save failed: ${msg}`);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Mock'; }
      }
    },
  }));
  form.appendChild(footer);
  return form;
}

/* -------------------------------------------------------------------------- */
/*  Match table + body patterns                                               */
/* -------------------------------------------------------------------------- */

function renderMatchTable(container, items, keyLabel, valueLabel) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div',{className:'me-match-empty',textContent:`No ${keyLabel.toLowerCase()} conditions.`}));
    return;
  }
  const table = el('table',{className:'me-match-table'});
  const thead = el('thead'); thead.innerHTML=`<tr><th></th><th>${keyLabel}</th><th>${valueLabel}</th><th>Match</th><th></th></tr>`;
  table.appendChild(thead);
  const tbody = el('tbody');
  items.forEach((item,idx) => {
    const tr=el('tr');
    const cbTd=el('td'); const cb=el('input',{type:'checkbox'}); cb.checked=item.enabled!==false; cb.addEventListener('change',(e)=>{ items[idx].enabled=e.target.checked; }); cbTd.appendChild(cb); tr.appendChild(cbTd);
    const kTd=el('td'); const kIn=el('input',{type:'text',className:'me-match-input',value:item.key||item.name||'',placeholder:keyLabel,onInput:(e)=>{ items[idx].key=e.target.value; items[idx].name=e.target.value; }}); kTd.appendChild(kIn); tr.appendChild(kTd);
    const vTd=el('td'); const vIn=el('input',{type:'text',className:'me-match-input',value:item.value||'',placeholder:item.matchType==='absent'?'(ignored)':valueLabel,onInput:(e)=>{ items[idx].value=e.target.value; }}); vTd.appendChild(vIn); tr.appendChild(vTd);
    const tTd=el('td'); const tSel=el('select',{className:'me-match-type-select'}); ['equals','contains','regex','absent'].forEach((v)=>{ const opt=el('option',{value:v,textContent:v.charAt(0).toUpperCase()+v.slice(1)}); if((item.matchType||'equals')===v) opt.selected=true; tSel.appendChild(opt); }); tSel.addEventListener('change',(e)=>{ items[idx].matchType=e.target.value; vIn.placeholder=e.target.value==='absent'?'(ignored)':valueLabel; }); tTd.appendChild(tSel); tr.appendChild(tTd);
    const dTd=el('td'); const dBtn=el('button',{className:'me-icon-btn me-icon-btn-danger',innerHTML:'&#10005;',onClick:()=>{ items.splice(idx,1); renderMatchTable(container,items,keyLabel,valueLabel); }}); dTd.appendChild(dBtn); tr.appendChild(dTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); container.appendChild(table);
}

function renderBodyPatterns(container, patterns) {
  container.innerHTML = '';
  if (patterns.length===0){ container.appendChild(el('div',{className:'me-match-empty',textContent:'No body patterns.'})); return; }
  patterns.forEach((pat,idx) => {
    const row=el('div',{className:'me-body-pattern-row'});
    const tSel=el('select',{className:'me-match-type-select'});
    ['contains','equals','jsonpath','regex'].forEach((v)=>{ const opt=el('option',{value:v,textContent:v}); if(pat.type===v) opt.selected=true; tSel.appendChild(opt); });
    tSel.addEventListener('change',(e)=>{ patterns[idx].type=e.target.value; });
    const vIn=el('input',{type:'text',className:'me-match-input',value:pat.value||'',placeholder:'e.g.  $.version == "v3"  or  "getAggByUrl"',onInput:(e)=>{ patterns[idx].value=e.target.value; }}); vIn.style.flex='1';
    const del=el('button',{className:'me-icon-btn me-icon-btn-danger',innerHTML:'&#10005;',onClick:()=>{ patterns.splice(idx,1); renderBodyPatterns(container,patterns); }});
    row.appendChild(tSel); row.appendChild(vIn); row.appendChild(del);
    container.appendChild(row);
  });
}

/* -------------------------------------------------------------------------- */
/*  Root render                                                               */
/* -------------------------------------------------------------------------- */

function render() {
  if (!_container) return;
  _container.innerHTML = '';

  const statusBar = el('div',{className:'me-status-bar',id:'me-status-bar'});
  _container.appendChild(statusBar);
  updateStatusBar();

  const layout = el('div',{className:'me-layout'});
  layout.appendChild(el('div',{className:'me-left',id:'me-left-panel'}));
  layout.appendChild(el('div',{className:'me-right',id:'me-right-panel'}));
  _container.appendChild(layout);

  renderMockList();
  renderEditor();
}

/* -------------------------------------------------------------------------- */
/*  Styles                                                                    */
/* -------------------------------------------------------------------------- */

function injectStyles() {
  if (document.getElementById('me-styles')) return;
  const style = document.createElement('style');
  style.id = 'me-styles';
  style.textContent = `
.me-status-bar { display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--c-surface);border-bottom:1px solid var(--c-border);font-size:12px;flex-shrink:0; }
.me-status-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0; }
.me-status-connected { background:var(--c-success);box-shadow:0 0 5px var(--c-success); }
.me-status-offline   { background:var(--c-error); }
.me-status-unknown   { background:var(--c-muted); }
.me-status-text { color:var(--c-text); }
.me-status-meta { color:var(--c-subtle);margin-left:4px; }
.me-status-meta code { background:var(--c-surface2);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--c-accent);font-family:var(--font-mono); }
.me-status-refresh { margin-left:auto;background:none;border:1px solid var(--c-border);border-radius:3px;color:var(--c-muted);font-size:11px;padding:3px 10px;cursor:pointer; }
.me-status-refresh:hover { background:var(--c-surface3);color:var(--c-text); }
.me-layout { display:flex;flex:1;overflow:hidden;min-height:500px; }
.me-left { width:280px;min-width:240px;flex-shrink:0;background:var(--c-surface);border-right:1px solid var(--c-border);display:flex;flex-direction:column;overflow:hidden; }
.me-left-header { display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--c-border);flex-shrink:0; }
.me-left-title { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--c-muted); }
.me-new-btn { background:var(--c-accent);color:var(--c-accent-text);border:none;border-radius:3px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer; }
.me-new-btn:hover { background:var(--c-accent-h); }
.me-mock-list { flex:1;overflow-y:auto;padding:4px 0; }
.me-mock-item { display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--c-border);transition:background .12s; }
.me-mock-item:hover { background:var(--c-surface3); }
.me-mock-item.selected { background:rgba(0,120,212,.1);border-left:3px solid var(--c-accent);padding-left:7px; }
.me-method-badge { font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;letter-spacing:.03em;flex-shrink:0;min-width:36px;text-align:center; }
.me-mock-item-info { flex:1;min-width:0; }
.me-mock-item-name { font-size:12px;font-weight:500;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-mock-item-url { font-size:10px;color:var(--c-subtle);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.me-mock-item-hits { font-size:10px;color:var(--c-subtle); }
.me-mock-item-actions { flex-shrink:0; }
.me-offline-hint { padding:24px 16px;text-align:center;font-size:12px;color:var(--c-subtle);font-style:italic;line-height:1.8; }
.me-offline-hint code { background:var(--c-surface2);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--c-accent);font-family:var(--font-mono); }
.me-right { flex:1;overflow-y:auto;background:var(--c-bg);display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:var(--c-border) transparent; }
.me-empty-state { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--c-subtle);font-size:13px;gap:8px;padding:40px;text-align:center;line-height:1.8; }
.me-empty-icon { font-size:36px;opacity:.4; }
.me-empty-state code { background:var(--c-surface2);padding:1px 6px;border-radius:3px;font-size:11px;color:var(--c-accent);font-family:var(--font-mono); }
.me-mock-form { display:flex;flex-direction:column;gap:0;padding:16px;flex:1; }
.me-form-top-row { display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--c-border); }
.me-name-input { flex:1;font-size:14px;font-weight:600; }
.me-prio-label { font-size:11px;color:var(--c-muted);white-space:nowrap;flex-shrink:0; }
.me-prio-input { width:64px; }
.me-enabled-label { display:flex;align-items:center;gap:4px;font-size:12px;color:var(--c-muted);cursor:pointer;white-space:nowrap;flex-shrink:0; }
.me-enabled-label input { accent-color:var(--c-accent); }
.me-wm-section { border:1px solid var(--c-border);border-radius:6px;padding:12px 14px;margin-bottom:12px; }
.me-wm-legend { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--c-accent);padding:0 6px; }
.me-url-row { display:flex;gap:6px;align-items:center;margin-bottom:10px; }
.me-method-select { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;font-size:12px;font-weight:700;padding:7px 10px;outline:none;cursor:pointer;min-width:80px; }
.me-url-type-sel { flex-shrink:0; }
.me-url-input { flex:1; }
.me-form-label { font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin:8px 0 4px; }
.me-form-input { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;color:var(--c-text);font-size:13px;padding:7px 10px;outline:none;transition:border-color .2s;width:100%;box-sizing:border-box; }
.me-form-input:focus { border-color:var(--c-accent); }
.me-form-input::placeholder { color:var(--c-subtle); }
.me-form-input-short { width:100px; }
.me-form-select,.me-match-type-select,.me-url-type-sel { background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;color:var(--c-text);font-size:12px;padding:6px 8px;outline:none;cursor:pointer; }
.me-match-table-wrap { margin:4px 0;overflow-x:auto; }
.me-match-empty { font-size:11px;color:var(--c-subtle);font-style:italic;padding:4px 0; }
.me-match-table { width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px; }
.me-match-table th { text-align:left;padding:4px 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);background:var(--c-surface2);border-bottom:1px solid var(--c-border); }
.me-match-table td { padding:3px 4px;border-bottom:1px solid var(--c-border); }
.me-match-input { background:transparent;border:1px solid transparent;color:var(--c-text);font-size:12px;padding:3px 6px;outline:none;width:100%;border-radius:3px;transition:border-color .15s; }
.me-match-input:focus { border-color:var(--c-accent);background:var(--c-surface2); }
.me-match-type-select { font-size:11px;padding:3px 6px; }
.me-body-pattern-row { display:flex;gap:6px;align-items:center;margin-bottom:4px; }
.me-meta-row { display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap; }
.me-meta-group { display:flex;flex-direction:column;gap:4px; }
.me-headers-list { display:flex;flex-direction:column;gap:4px;margin-bottom:6px; }
.me-header-row { display:flex;gap:6px;align-items:center; }
.me-header-key { flex:2; }
.me-header-value { flex:3; }
.me-json-editor-wrapper { border:1px solid var(--c-border);border-radius:6px;overflow:hidden;margin-bottom:4px; }
.me-json-toolbar { display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--c-surface2);border-bottom:1px solid var(--c-border); }
.me-json-validation-msg { margin-left:auto;font-size:11px;font-weight:500; }
.me-valid { color:var(--c-success); }
.me-invalid { color:var(--c-error); }
.me-json-editor-container { position:relative;display:flex;background:var(--c-bg-deep);min-height:160px;max-height:380px; }
.me-json-line-numbers { padding:10px 6px 10px 10px;text-align:right;color:var(--c-subtle);background:var(--c-surface);border-right:1px solid var(--c-border);font-family:var(--font-mono);font-size:12px;line-height:1.6;user-select:none;flex-shrink:0;min-width:36px;overflow:hidden; }
.me-json-line-numbers span { display:block; }
.me-json-highlight-pre { position:absolute;inset:0;margin:0;padding:10px 12px;font-family:var(--font-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;pointer-events:none;overflow:auto;color:var(--c-text); }
.me-json-textarea { flex:1;background:transparent;border:none;color:transparent;caret-color:var(--c-text);font-family:var(--font-mono);font-size:12px;line-height:1.6;padding:10px 12px;resize:none;outline:none;overflow:auto;white-space:pre-wrap;word-wrap:break-word;min-height:160px;max-height:380px;z-index:1; }
.jh-key { color:#9cdcfe; }
.jh-string { color:#ce9178; }
.jh-number { color:#b5cea8; }
.jh-bool { color:#569cd6; }
.jh-null { color:#569cd6; }
.jh-punc { color:var(--c-text); }
.me-btn { display:inline-flex;align-items:center;justify-content:center;padding:6px 14px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap; }
.me-btn-sm { padding:3px 8px;font-size:11px; }
.me-btn-primary { background:var(--c-accent);color:var(--c-accent-text); }
.me-btn-primary:hover { background:var(--c-accent-h); }
.me-btn-secondary { background:var(--c-surface3);color:var(--c-text); }
.me-btn-secondary:hover { background:var(--c-border2); }
.me-icon-btn { background:none;border:none;color:var(--c-subtle);font-size:14px;cursor:pointer;padding:2px 4px;border-radius:3px;line-height:1;transition:color .15s; }
.me-icon-btn:hover { color:var(--c-text); }
.me-icon-btn-danger:hover { color:var(--c-error); }
.me-hidden-file-input { display:none; }
.me-form-actions { display:flex;justify-content:flex-end;gap:8px;padding-top:14px;margin-top:auto;border-top:1px solid var(--c-border); }
.me-form-error,.me-list-error { padding:8px 12px;background:rgba(244,112,103,.1);border:1px solid var(--c-error);border-radius:4px;color:var(--c-error);font-size:12px;animation:meErrIn .2s ease; }
.me-list-error { margin:0 0 4px; }
@keyframes meErrIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
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
  if (_serverStatus === 'connected') await loadMocks();

  render();

  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(async () => {
    _serverUrl = await getMockServerUrl();
    await checkConnection();
    if (_serverStatus === 'connected') await loadMocks();
    updateStatusBar();
    renderMockList();
  }, 30000);
}
