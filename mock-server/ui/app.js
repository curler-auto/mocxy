/* =========================================================================
   Mocxy Mock Server — Standalone UI
   Pure vanilla JS, no dependencies, communicates with /mocxy/admin API
   ========================================================================= */

'use strict';

/* =========================================================================
   AI PANEL
   ========================================================================= */

let _aiMessages = [];   // {role, content}
let _aiOpen     = false;

const MODEL_HINTS = {
  openai:     'Recommended: gpt-4o-mini (fast & cheap) · gpt-4o · gpt-3.5-turbo',
  anthropic:  'Recommended: claude-haiku-4-5-20251001 (fastest) · claude-sonnet-4-6',
  custom:     'Any OpenAI-compatible model name (e.g. llama3, mistral)',
};

function openAiPanel() {
  document.getElementById('aiPanel').classList.remove('hidden');
  document.getElementById('aiBackdrop').classList.remove('hidden');
  _aiOpen = true;
  loadAiConfig();
}

function closeAiPanel() {
  document.getElementById('aiPanel').classList.add('hidden');
  document.getElementById('aiBackdrop').classList.add('hidden');
  document.getElementById('aiSettings').classList.add('hidden');
  _aiOpen = false;
}

async function loadAiConfig() {
  try {
    const cfg = await fetch('/mocxy/ai/config').then(r => r.json());
    document.getElementById('aiProvider').value = cfg.provider || 'openai';
    document.getElementById('aiApiKey').value   = cfg.apiKey   || '';
    document.getElementById('aiModel').value    = cfg.model    || '';
    updateModelHints();
    toggleBaseUrl();
  } catch (_) {}
}

function updateModelHints() {
  const provider = document.getElementById('aiProvider').value;
  const hint = document.getElementById('aiModelHints');
  if (hint) hint.textContent = MODEL_HINTS[provider] || '';
}

function toggleBaseUrl() {
  const provider = document.getElementById('aiProvider').value;
  const label = document.getElementById('aiBaseUrlLabel');
  const input = document.getElementById('aiBaseUrl');
  const show  = provider === 'custom';
  if (label) label.style.display = show ? 'block' : 'none';
  if (input) input.classList.toggle('hidden', !show);
}

async function saveAiConfig() {
  const cfg = {
    provider:    document.getElementById('aiProvider').value,
    apiKey:      document.getElementById('aiApiKey').value,
    model:       document.getElementById('aiModel').value,
    baseUrl:     document.getElementById('aiBaseUrl').value,
  };
  try {
    await fetch('/mocxy/ai/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    document.getElementById('aiSettings').classList.add('hidden');
    toast('AI settings saved', 'success');
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

function appendMessage(role, content, stubs = []) {
  _aiMessages.push({ role, content });

  const container = document.getElementById('aiMessages');
  const msgDiv    = document.createElement('div');
  msgDiv.className = `ai-msg ai-msg-${role}`;

  const bubble = document.createElement('div');
  bubble.className = `ai-bubble ai-bubble-${role}`;

  if (role === 'assistant') {
    // Render markdown-ish: code blocks, bold, inline code
    bubble.innerHTML = formatAiResponse(content);
  } else {
    bubble.textContent = content;
  }
  msgDiv.appendChild(bubble);

  // "Apply stub" buttons for each extracted stub
  if (stubs.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'ai-stub-actions';
    stubs.forEach((stub, i) => {
      const btn = document.createElement('button');
      btn.className = 'ai-apply-btn';
      btn.textContent = stubs.length === 1
        ? `✓ Create stub "${stub.name || 'Untitled'}"`
        : `✓ Create stub ${i + 1}: "${stub.name || 'Untitled'}"`;
      btn.addEventListener('click', async () => {
        try {
          await apiFetch('/mocks', { method: 'POST', body: JSON.stringify(stub) });
          await loadMocks();
          btn.textContent = '✓ Created!';
          btn.disabled = true;
          btn.style.opacity = '0.6';
          toast(`Stub "${stub.name || 'Untitled'}" created`, 'success');
        } catch (err) { toast('Create failed: ' + err.message, 'error'); }
      });
      actions.appendChild(btn);
    });
    msgDiv.appendChild(actions);
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = document.getElementById('aiMessages');
  const div = document.createElement('div');
  div.id = 'aiTyping';
  div.className = 'ai-msg ai-msg-assistant';
  div.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function hideTyping() {
  document.getElementById('aiTyping')?.remove();
}

function showAiError(msg) {
  const container = document.getElementById('aiMessages');
  const div = document.createElement('div');
  div.className = 'ai-error';
  div.textContent = '⚠ ' + msg;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendAiMessage(text) {
  if (!text.trim()) return;
  const input = document.getElementById('aiInput');
  const sendBtn = document.getElementById('aiSendBtn');

  input.value = '';
  input.style.height = 'auto';
  appendMessage('user', text);
  showTyping();
  sendBtn.disabled = true;

  try {
    const res = await fetch('/mocxy/ai/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: _aiMessages,
      }),
    });
    const data = await res.json();
    hideTyping();
    if (!res.ok) throw new Error(data.error || 'AI request failed');
    appendMessage('assistant', data.reply, data.stubs || []);
  } catch (err) {
    hideTyping();
    showAiError(err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

/** Basic markdown-ish formatter for AI responses */
function formatAiResponse(text) {
  return text
    // Code blocks (```lang\n...\n```)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Bullet points
    .replace(/^• /gm, '• ')
    // Newlines
    .replace(/\n/g, '<br>');
}

function initAiPanel() {
  document.getElementById('aiPanelBtn').addEventListener('click', openAiPanel);
  document.getElementById('aiCloseBtn').addEventListener('click', closeAiPanel);
  document.getElementById('aiBackdrop').addEventListener('click', closeAiPanel);

  document.getElementById('aiSettingsBtn').addEventListener('click', () => {
    document.getElementById('aiSettings').classList.toggle('hidden');
  });
  document.getElementById('aiSettingsCancelBtn').addEventListener('click', () => {
    document.getElementById('aiSettings').classList.add('hidden');
  });
  document.getElementById('aiSettingsSaveBtn').addEventListener('click', saveAiConfig);

  document.getElementById('aiProvider').addEventListener('change', () => {
    updateModelHints();
    toggleBaseUrl();
  });

  // Quick action chips
  document.getElementById('aiQuickActions').addEventListener('click', (e) => {
    const chip = e.target.closest('.ai-chip');
    if (!chip) return;
    sendAiMessage(chip.dataset.prompt);
  });

  // Send button
  document.getElementById('aiSendBtn').addEventListener('click', () => {
    sendAiMessage(document.getElementById('aiInput').value);
  });

  // Ctrl+Enter to send
  document.getElementById('aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendAiMessage(e.target.value);
    }
  });

  // Clear chat
  document.getElementById('aiClearBtn').addEventListener('click', () => {
    _aiMessages = [];
    const container = document.getElementById('aiMessages');
    container.innerHTML = `
      <div class="ai-welcome">
        <strong>Mocxy AI</strong> — Ask me to generate stubs, analyze mocks, or explain matching rules.<br>
        <span style="color:var(--subtle)">Strictly focused on API mocking.</span>
      </div>`;
  });
}

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let _mocks       = [];
let _selectedId  = null;
let _filterMethod = '';
let _searchQuery = '';
let _draft       = null;   // currently editing mock (deep clone)

const API = '/mocxy/admin';

/* -------------------------------------------------------------------------- */
/*  API helpers                                                               */
/* -------------------------------------------------------------------------- */

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

/* -------------------------------------------------------------------------- */
/*  Load + refresh                                                            */
/* -------------------------------------------------------------------------- */

async function loadMocks() {
  try {
    const list  = await apiFetch('/mocks');
    _mocks = Array.isArray(list) ? list : [];
    renderMockList();
    updateHealthBar();
  } catch (err) {
    setOffline(err.message);
  }
}

async function updateHealthBar() {
  try {
    const h = await apiFetch('/health');
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    dot.className = 'status-dot connected';
    text.textContent = `Connected · v${h.version} · ${h.mocks} mock${h.mocks !== 1 ? 's' : ''} · uptime ${Math.floor((h.uptime||0)/60)}m`;
  } catch (_) {
    setOffline('Server not reachable');
  }
}

function setOffline(msg) {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'status-dot offline';
  text.textContent = `Offline — ${msg}`;
}

/* -------------------------------------------------------------------------- */
/*  Mock list rendering                                                       */
/* -------------------------------------------------------------------------- */

function filteredMocks() {
  let list = [..._mocks];
  if (_filterMethod) {
    list = list.filter(m => (m.request?.method || 'ANY').toUpperCase() === _filterMethod);
  }
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    list = list.filter(m =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.request?.url || '').toLowerCase().includes(q)
    );
  }
  return list.sort((a,b) => (b.priority||0) - (a.priority||0));
}

function renderMockList() {
  const container = document.getElementById('mockList');
  const count     = document.getElementById('mockCount');
  const list      = filteredMocks();

  count.textContent = `${_mocks.length} mock${_mocks.length !== 1 ? 's' : ''}`;

  if (list.length === 0) {
    container.innerHTML = `<div class="list-empty">${_mocks.length === 0 ? 'No mocks yet — click New Mock' : 'No results'}</div>`;
    return;
  }

  container.innerHTML = '';
  list.forEach(mock => {
    const item   = document.createElement('div');
    item.className = `mock-item${mock.id === _selectedId ? ' active' : ''}`;
    item.dataset.id = mock.id;

    const method = (mock.request?.method || 'ANY').toUpperCase();
    const badge  = document.createElement('span');
    badge.className = `mock-item-badge badge-${method.toLowerCase()}`;
    badge.textContent = method;

    const info = document.createElement('div');
    info.className = 'mock-item-info';

    const name = document.createElement('div');
    name.className = 'mock-item-name';
    name.textContent = mock.name || 'Untitled';

    const url = document.createElement('div');
    url.className = 'mock-item-url';
    url.textContent = mock.request?.url || '(any URL)';

    const meta = document.createElement('div');
    meta.className = 'mock-item-meta';

    const hits = document.createElement('span');
    hits.className = 'mock-item-hits';
    hits.textContent = `${mock.stats?.matched || 0} hits`;
    meta.appendChild(hits);

    if (mock.enabled === false) {
      const dis = document.createElement('span');
      dis.className = 'mock-item-disabled';
      dis.textContent = 'disabled';
      meta.appendChild(dis);
    }

    info.appendChild(name);
    info.appendChild(url);
    info.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'mock-item-del';
    del.innerHTML = '&#10005;';
    del.title = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${mock.name || 'Untitled'}"?`)) return;
      try {
        await apiFetch(`/mocks/${mock.id}`, { method: 'DELETE' });
        if (_selectedId === mock.id) { _selectedId = null; showEmpty(); }
        await loadMocks();
        toast('Mock deleted', 'success');
      } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
      }
    });

    item.appendChild(badge);
    item.appendChild(info);
    item.appendChild(del);
    item.addEventListener('click', () => selectMock(mock.id));
    container.appendChild(item);
  });
}

/* -------------------------------------------------------------------------- */
/*  Selection                                                                 */
/* -------------------------------------------------------------------------- */

function selectMock(id) {
  const mock = _mocks.find(m => m.id === id);
  if (!mock) return;
  _selectedId = id;
  _draft = JSON.parse(JSON.stringify(mock));
  renderMockList();
  buildEditor(_draft);
}

function newMock() {
  _selectedId = null;
  _draft = {
    id: null, name: '', priority: 0, enabled: true,
    request:  { method: 'ANY', urlMatchType: 'contains', url: '', queryParams: [], headers: [], bodyPatterns: [] },
    response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}', delayMs: 0, delayJitter: 0, fault: 'none' },
  };
  renderMockList();
  buildEditor(_draft);
}

function showEmpty() {
  document.getElementById('editorEmpty').classList.remove('hidden');
  document.getElementById('editorForm').classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/*  Editor builder                                                            */
/* -------------------------------------------------------------------------- */

function buildEditor(draft) {
  document.getElementById('editorEmpty').classList.add('hidden');
  const form = document.getElementById('editorForm');
  form.classList.remove('hidden');
  form.innerHTML = '';

  // ── Top row ────────────────────────────────────────────────────────────
  const topRow = el('div', { className: 'form-toprow' });

  const nameIn = el('input', { type: 'text', className: 'name-input', placeholder: 'Mock name…', value: draft.name || '' });
  nameIn.addEventListener('input', e => { draft.name = e.target.value; });

  const metaDiv = el('div', { className: 'form-meta' });

  const prioLabel = el('label');
  prioLabel.textContent = 'Priority ';
  const prioIn = el('input', { type: 'number', className: 'input input-short', value: String(draft.priority||0), min: '0' });
  prioIn.addEventListener('input', e => { draft.priority = parseInt(e.target.value,10)||0; });
  prioLabel.appendChild(prioIn);

  const enLabel = el('label');
  const enCb = el('input', { type: 'checkbox' });
  enCb.checked = draft.enabled !== false;
  enCb.addEventListener('change', e => { draft.enabled = e.target.checked; });
  enLabel.appendChild(enCb);
  enLabel.appendChild(tn(' Enabled'));

  metaDiv.appendChild(prioLabel);
  metaDiv.appendChild(enLabel);
  topRow.appendChild(nameIn);
  topRow.appendChild(metaDiv);
  form.appendChild(topRow);

  // ════════════════════════════════════════════════════════════════════════
  // REQUEST MATCHING
  // ════════════════════════════════════════════════════════════════════════
  const reqSec = section('① Request Matching');

  // Method + urlType + url
  const urlRow = el('div', { className: 'url-row' });

  const methodSel = el('select', { className: 'method-select' });
  ['ANY','GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].forEach(m => {
    const opt = el('option', { value: m }); opt.textContent = m;
    if ((draft.request.method||'ANY') === m) opt.selected = true;
    methodSel.appendChild(opt);
  });
  applyMethodColor(methodSel);
  methodSel.addEventListener('change', e => { draft.request.method = e.target.value; applyMethodColor(methodSel); });

  const urlTypeSel = el('select', { className: 'select', style: 'width:auto' });
  [['contains','Contains'],['equals','Equals'],['regex','Regex'],['path','Path Pattern']].forEach(([v,l]) => {
    const opt = el('option',{value:v}); opt.textContent=l;
    if ((draft.request.urlMatchType||'contains')===v) opt.selected=true;
    urlTypeSel.appendChild(opt);
  });
  urlTypeSel.addEventListener('change', e => { draft.request.urlMatchType = e.target.value; });

  const urlIn = el('input', { type:'text', className:'input input-flex', placeholder:'/api/fleet/** or .*getAggByUrl.*', value: draft.request.url||'' });
  urlIn.addEventListener('input', e => { draft.request.url = e.target.value; });

  urlRow.appendChild(methodSel); urlRow.appendChild(urlTypeSel); urlRow.appendChild(urlIn);
  reqSec.appendChild(urlRow);

  // Query Params
  reqSec.appendChild(matchSectionHeader('Query Parameters', () => {
    draft.request.queryParams.push({ key:'', value:'', matchType:'equals', enabled:true });
    renderMatchTable(qpTable, draft.request.queryParams, 'Key', 'Value');
  }));
  draft.request.queryParams = draft.request.queryParams || [];
  const qpTable = el('div');
  renderMatchTable(qpTable, draft.request.queryParams, 'Key', 'Value');
  reqSec.appendChild(qpTable);

  // Request Headers
  reqSec.appendChild(matchSectionHeader('Request Headers', () => {
    draft.request.headers.push({ name:'', value:'', matchType:'equals', enabled:true });
    renderMatchTable(rhTable, draft.request.headers, 'Name', 'Value');
  }));
  draft.request.headers = draft.request.headers || [];
  const rhTable = el('div');
  renderMatchTable(rhTable, draft.request.headers, 'Name', 'Value');
  reqSec.appendChild(rhTable);

  // Body Patterns
  reqSec.appendChild(matchSectionHeader('Body Patterns', () => {
    draft.request.bodyPatterns.push({ type:'contains', value:'' });
    renderBodyPatterns(bpList, draft.request.bodyPatterns);
  }));
  draft.request.bodyPatterns = draft.request.bodyPatterns || [];
  const bpList = el('div');
  renderBodyPatterns(bpList, draft.request.bodyPatterns);
  reqSec.appendChild(bpList);

  form.appendChild(reqSec);

  // ════════════════════════════════════════════════════════════════════════
  // RESPONSE
  // ════════════════════════════════════════════════════════════════════════
  const respSec = section('② Response');

  // Status + Fault
  const metaRow = el('div', { className: 'resp-meta-row' });

  const stGrp = el('div', { className: 'resp-meta-group' });
  stGrp.appendChild(el('label', { className: 'form-label', textContent: 'Status Code' }));
  const stIn = el('input', { type:'number', className:'input input-short', value:String(draft.response.status||200), min:'100', max:'599' });
  stIn.addEventListener('input', e => { draft.response.status = parseInt(e.target.value,10)||200; });
  stGrp.appendChild(stIn);

  const fltGrp = el('div', { className: 'resp-meta-group' });
  fltGrp.appendChild(el('label', { className: 'form-label', textContent: 'Fault Simulation' }));
  const fltSel = el('select', { className: 'select', style: 'width:auto' });
  [['none','None — normal response'],['network_error','Network Error'],['empty_response','Empty Response']].forEach(([v,l]) => {
    const opt = el('option',{value:v}); opt.textContent=l;
    if ((draft.response.fault||'none')===v) opt.selected=true;
    fltSel.appendChild(opt);
  });
  fltSel.addEventListener('change', e => { draft.response.fault = e.target.value; });
  fltGrp.appendChild(fltSel);

  metaRow.appendChild(stGrp); metaRow.appendChild(fltGrp);
  respSec.appendChild(metaRow);

  // Delay + Jitter
  const delayRow = el('div', { className: 'resp-meta-row' });
  const dGrp = el('div', { className: 'resp-meta-group' });
  dGrp.appendChild(el('label', { className: 'form-label', textContent: 'Delay (ms)' }));
  const dIn = el('input', { type:'number', className:'input input-short', value:String(draft.response.delayMs||0), min:'0' });
  dIn.addEventListener('input', e => { draft.response.delayMs = parseInt(e.target.value,10)||0; });
  dGrp.appendChild(dIn);
  const jGrp = el('div', { className: 'resp-meta-group' });
  jGrp.appendChild(el('label', { className: 'form-label', textContent: 'Jitter (ms)' }));
  const jIn = el('input', { type:'number', className:'input input-short', value:String(draft.response.delayJitter||0), min:'0', title:'Random 0–N ms added to delay' });
  jIn.addEventListener('input', e => { draft.response.delayJitter = parseInt(e.target.value,10)||0; });
  jGrp.appendChild(jIn);
  delayRow.appendChild(dGrp); delayRow.appendChild(jGrp);
  respSec.appendChild(delayRow);

  // Response headers
  respSec.appendChild(matchSectionHeader('Response Headers', () => addRespHdr()));
  const rhContainer = el('div', { className: 'resp-headers-list' });
  function rebuildRespHdrs() {
    const rows = rhContainer.querySelectorAll('.resp-header-row'); const obj={};
    rows.forEach(row => { const k=row.querySelector('.hdr-key')?.value?.trim(); const v=row.querySelector('.hdr-val')?.value||''; if(k) obj[k]=v; });
    draft.response.headers = obj;
  }
  function addRespHdr(key='', value='') {
    const row = el('div',{className:'resp-header-row'});
    const kIn = el('input',{type:'text',className:'input input-flex hdr-key',placeholder:'Header name',value:key}); kIn.addEventListener('blur', rebuildRespHdrs);
    const vIn = el('input',{type:'text',className:'input input-flex hdr-val',placeholder:'Value',value:value}); vIn.addEventListener('blur', rebuildRespHdrs);
    const del = el('button',{className:'row-del',innerHTML:'&#10005;'}); del.addEventListener('click',()=>{ row.remove(); rebuildRespHdrs(); });
    row.appendChild(kIn); row.appendChild(vIn); row.appendChild(del);
    rhContainer.appendChild(row);
  }
  Object.entries(draft.response.headers||{}).forEach(([k,v]) => addRespHdr(k,v));
  respSec.appendChild(rhContainer);

  // Body editor
  respSec.appendChild(el('label', { className: 'form-label', textContent: 'Response Body' }));
  const { wrap: edWrap, textarea: bodyArea, updateLN, applyHL } = buildJsonEditor(draft.response.body || '{}');
  bodyArea.addEventListener('input', e => { draft.response.body = e.target.value; updateLN(); });
  bodyArea.addEventListener('blur', () => applyHL());
  respSec.appendChild(edWrap);

  form.appendChild(respSec);

  // ── Footer ──────────────────────────────────────────────────────────────
  const footer = el('div', { className: 'form-footer' });
  const errEl  = el('div', { className: 'form-error hidden', id: 'formError' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }); cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { _selectedId = null; _draft = null; showEmpty(); renderMockList(); });
  const saveBtn = el('button', { className: 'btn btn-primary' }); saveBtn.textContent = 'Save Mock';
  saveBtn.addEventListener('click', async () => {
    rebuildRespHdrs();
    if (!draft.name.trim()) { showFormError('Please enter a mock name.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const saved = draft.id
        ? await apiFetch(`/mocks/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
        : await apiFetch('/mocks', { method: 'POST', body: JSON.stringify(draft) });
      _selectedId = saved.id;
      await loadMocks();
      selectMock(saved.id);
      toast('Mock saved', 'success');
    } catch (err) {
      showFormError('Save failed: ' + err.message);
      saveBtn.disabled = false; saveBtn.textContent = 'Save Mock';
    }
  });
  footer.appendChild(errEl);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  form.appendChild(footer);
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  if (!el) return;
  el.textContent = '⚠ ' + msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

/* -------------------------------------------------------------------------- */
/*  JSON editor                                                               */
/* -------------------------------------------------------------------------- */

function buildJsonEditor(initialValue) {
  const wrap    = el('div', { className: 'json-editor-wrap' });
  const toolbar = el('div', { className: 'json-toolbar' });
  const valMsg  = el('span', { className: 'json-val-msg' });

  const fmtBtn = el('button', { className: 'btn btn-ghost btn-sm' }); fmtBtn.textContent = 'Format';
  const valBtn = el('button', { className: 'btn btn-ghost btn-sm' }); valBtn.textContent = 'Validate';
  const fileIn = el('input', { type: 'file', accept: '.json,.txt', style: 'display:none' });
  const loadBtn = el('button', { className: 'btn btn-ghost btn-sm' }); loadBtn.textContent = 'Load File';

  toolbar.appendChild(fmtBtn); toolbar.appendChild(valBtn);
  toolbar.appendChild(loadBtn); toolbar.appendChild(fileIn);
  toolbar.appendChild(valMsg);

  const container = el('div', { className: 'json-editor-container' });
  const lnEl      = el('div', { className: 'json-line-nums' });
  const inner     = el('div', { className: 'json-editor-inner' });
  const hlPre     = el('pre', { className: 'json-highlight-pre' });
  const textarea  = el('textarea', { className: 'json-textarea', spellcheck: 'false' });
  textarea.value  = initialValue;

  function updateLN() {
    const lines = textarea.value.split('\n');
    lnEl.innerHTML = lines.map((_,i) => `<span>${i+1}</span>`).join('');
  }
  function applyHL() { hlPre.innerHTML = highlightJson(textarea.value); }

  textarea.addEventListener('scroll', () => {
    lnEl.scrollTop = textarea.scrollTop;
    hlPre.scrollTop = textarea.scrollTop;
    hlPre.scrollLeft = textarea.scrollLeft;
  });

  fmtBtn.addEventListener('click', () => {
    try {
      textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
      applyHL(); updateLN();
      setValMsg(valMsg, true, 'Valid JSON');
    } catch (err) { setValMsg(valMsg, false, err.message); }
  });
  valBtn.addEventListener('click', () => {
    try { JSON.parse(textarea.value); setValMsg(valMsg, true, 'Valid JSON'); }
    catch (err) { setValMsg(valMsg, false, err.message); }
  });
  loadBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => { textarea.value = ev.target.result; applyHL(); updateLN(); };
    r.readAsText(f);
  });

  inner.appendChild(hlPre); inner.appendChild(textarea);
  container.appendChild(lnEl); container.appendChild(inner);
  wrap.appendChild(toolbar); wrap.appendChild(container);

  requestAnimationFrame(() => { updateLN(); applyHL(); });

  return { wrap, textarea, updateLN, applyHL };
}

function setValMsg(el, valid, text) {
  el.textContent = (valid ? '✔ ' : '✖ ') + text;
  el.className = 'json-val-msg ' + (valid ? 'json-valid' : 'json-invalid');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; el.className = 'json-val-msg'; }, 4000);
}

function highlightJson(raw) {
  if (!raw) return '';
  const esc = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return esc.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b)|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, nul, num) => {
      if (str && colon) return `<span class="jh-key">${str}</span>:`;
      if (str)  return `<span class="jh-string">${str}</span>`;
      if (bool) return `<span class="jh-bool">${m}</span>`;
      if (nul !== undefined && m === 'null') return `<span class="jh-null">null</span>`;
      if (num)  return `<span class="jh-number">${m}</span>`;
      return m;
    }
  );
}

/* -------------------------------------------------------------------------- */
/*  Match table                                                               */
/* -------------------------------------------------------------------------- */

function renderMatchTable(container, items, keyLabel, valueLabel) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div', { className: 'match-empty', textContent: `No ${keyLabel.toLowerCase()} conditions` }));
    return;
  }
  const table = el('table', { className: 'match-table' });
  const thead = el('thead');
  thead.innerHTML = `<tr><th></th><th>${keyLabel}</th><th>${valueLabel}</th><th>Match</th><th></th></tr>`;
  table.appendChild(thead);
  const tbody = el('tbody');
  items.forEach((item, idx) => {
    const tr = el('tr');
    const cbTd = el('td'); const cb = el('input', { type: 'checkbox' }); cb.checked = item.enabled !== false; cb.addEventListener('change', e => { items[idx].enabled = e.target.checked; }); cbTd.appendChild(cb);
    const kTd = el('td'); const kIn = el('input', { type:'text', className:'match-input', value: item.key||item.name||'', placeholder: keyLabel }); kIn.addEventListener('input', e => { items[idx].key = e.target.value; items[idx].name = e.target.value; }); kTd.appendChild(kIn);
    const vTd = el('td'); const vIn = el('input', { type:'text', className:'match-input', value: item.value||'', placeholder: item.matchType==='absent'?'(ignored)':valueLabel }); vIn.addEventListener('input', e => { items[idx].value = e.target.value; }); vTd.appendChild(vIn);
    const tTd = el('td'); const tSel = el('select', { className: 'match-type-select' }); ['equals','contains','regex','absent'].forEach(v => { const opt=el('option',{value:v}); opt.textContent=v.charAt(0).toUpperCase()+v.slice(1); if((item.matchType||'equals')===v) opt.selected=true; tSel.appendChild(opt); }); tSel.addEventListener('change', e => { items[idx].matchType=e.target.value; vIn.placeholder=e.target.value==='absent'?'(ignored)':valueLabel; }); tTd.appendChild(tSel);
    const dTd = el('td'); const dBtn = el('button', { className: 'row-del', innerHTML: '&#10005;' }); dBtn.addEventListener('click', () => { items.splice(idx,1); renderMatchTable(container,items,keyLabel,valueLabel); }); dTd.appendChild(dBtn);
    tr.appendChild(cbTd); tr.appendChild(kTd); tr.appendChild(vTd); tr.appendChild(tTd); tr.appendChild(dTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); container.appendChild(table);
}

function renderBodyPatterns(container, patterns) {
  container.innerHTML = '';
  if (patterns.length === 0) { container.appendChild(el('div', { className: 'match-empty', textContent: 'No body patterns' })); return; }
  patterns.forEach((pat, idx) => {
    const row = el('div', { className: 'body-pattern-row' });
    const tSel = el('select', { className: 'match-type-select' }); ['contains','equals','jsonpath','regex'].forEach(v => { const opt=el('option',{value:v}); opt.textContent=v; if(pat.type===v) opt.selected=true; tSel.appendChild(opt); }); tSel.addEventListener('change', e => { patterns[idx].type=e.target.value; });
    const vIn = el('input', { type:'text', className:'match-input input-flex', value: pat.value||'', placeholder:'e.g.  $.version == "v3"  or  "getAggByUrl"' }); vIn.addEventListener('input', e => { patterns[idx].value = e.target.value; });
    const del = el('button', { className: 'row-del', innerHTML: '&#10005;' }); del.addEventListener('click', () => { patterns.splice(idx,1); renderBodyPatterns(container,patterns); });
    row.appendChild(tSel); row.appendChild(vIn); row.appendChild(del);
    container.appendChild(row);
  });
}

/* -------------------------------------------------------------------------- */
/*  Import / Export                                                           */
/* -------------------------------------------------------------------------- */

async function exportMocks() {
  try {
    const mocks = await apiFetch('/mocks/export');
    const blob  = new Blob([JSON.stringify(mocks, null, 2)], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = `mocxy-mocks-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Exported ${mocks.length} mocks`, 'success');
  } catch (err) { toast('Export failed: ' + err.message, 'error'); }
}

async function importMocks(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data  = JSON.parse(e.target.result);
      const list  = Array.isArray(data) ? data : (data.mocks || []);
      const mode  = confirm(`Import ${list.length} mocks?\n\nOK = Replace all existing mocks\nCancel = Merge (add alongside existing)`) ? 'replace' : 'merge';
      if (mode === 'replace') {
        await apiFetch('/mocks/import', { method: 'POST', body: JSON.stringify(list) });
      } else {
        for (const m of list) {
          const { id, ...rest } = m;
          await apiFetch('/mocks', { method: 'POST', body: JSON.stringify(rest) }).catch(() => {});
        }
      }
      await loadMocks();
      toast(`Imported ${list.length} mocks`, 'success');
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
}

/* -------------------------------------------------------------------------- */
/*  Toast                                                                     */
/* -------------------------------------------------------------------------- */

function toast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='all .2s'; setTimeout(()=>t.remove(),200); }, 3000);
}

/* -------------------------------------------------------------------------- */
/*  DOM helpers                                                               */
/* -------------------------------------------------------------------------- */

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k === 'innerHTML') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function tn(text) { return document.createTextNode(text); }

function section(title) {
  const div = el('div', { className: 'form-section' });
  div.appendChild(el('div', { className: 'form-section-title', textContent: title }));
  return div;
}

function matchSectionHeader(label, onAdd) {
  const row = el('div', { className: 'match-section-header' });
  row.appendChild(el('span', { className: 'match-section-label', textContent: label }));
  const btn = el('button', { className: 'btn btn-ghost btn-sm' }); btn.textContent = '+ Add';
  btn.addEventListener('click', onAdd);
  row.appendChild(btn);
  return row;
}

function applyMethodColor(sel) {
  const colors = {
    ANY:'#a0a0a0', GET:'#3ec9a7', POST:'#d7ba7d', PUT:'#0090f0',
    DELETE:'#f47067', PATCH:'#c586c0', HEAD:'#a0a0a0', OPTIONS:'#a0a0a0',
  };
  sel.style.color = colors[(sel.value||'ANY').toUpperCase()] || '#a0a0a0';
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  // Initial load
  loadMocks();

  // AI panel
  initAiPanel();

  // Auto-refresh every 15s
  setInterval(loadMocks, 15000);

  // New mock buttons
  document.getElementById('newMockBtn').addEventListener('click', newMock);
  document.getElementById('emptyNewBtn').addEventListener('click', newMock);

  // Export
  document.getElementById('exportBtn').addEventListener('click', exportMocks);

  // Import
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', e => {
    importMocks(e.target.files[0]);
    e.target.value = '';
  });

  // Delete all
  document.getElementById('deleteAllBtn').addEventListener('click', async () => {
    if (!confirm(`Delete all ${_mocks.length} mocks? This cannot be undone.`)) return;
    try {
      await apiFetch('/mocks', { method: 'DELETE' });
      _selectedId = null; _draft = null;
      await loadMocks();
      showEmpty();
      toast('All mocks deleted', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', e => {
    _searchQuery = e.target.value;
    renderMockList();
  });

  // Method filters
  document.getElementById('methodFilters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _filterMethod = btn.dataset.method;
    renderMockList();
  });
});
