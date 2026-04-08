/* =========================================================================
   Mocxy Mock Server — Standalone UI
   Pure vanilla JS, no dependencies, communicates with /mocxy/admin API
   ========================================================================= */

'use strict';

/* =========================================================================
   AI KEY GUARD — check once on load, cache result
   ========================================================================= */

let _aiKeyConfigured = false;

async function checkAiKey() {
  try {
    const r = await fetch('/mocxy/ai/has-key').then(x => x.json());
    _aiKeyConfigured = r.configured === true;
  } catch (_) { _aiKeyConfigured = false; }
  applyAiKeyGuards();
}

function applyAiKeyGuards() {
  // AI panel send button
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) {
    sendBtn.disabled = !_aiKeyConfigured;
    sendBtn.title    = _aiKeyConfigured ? 'Send (Ctrl+Enter)' : 'Configure an AI key in Settings first';
  }
  // Scenarios checkbox in import dialog
  const cb   = document.getElementById('withScenarios');
  const hint = document.getElementById('scenariosHint');
  if (cb) {
    cb.disabled = !_aiKeyConfigured;
    if (hint) hint.textContent = _aiKeyConfigured ? '' : '(requires AI key in Settings)';
  }
}

/* =========================================================================
   OPENAPI IMPORT DIALOG
   ========================================================================= */

let _specRawContent = '';

function initSpecDialog() {
  const backdrop   = document.getElementById('specDialogBackdrop');
  const browseBtn  = document.getElementById('specBrowseBtn');
  const fileInput  = document.getElementById('specFile');
  const filenameEl = document.getElementById('specFilename');
  const colNameEl  = document.getElementById('specColName');
  const importBtn  = document.getElementById('specDialogImport');
  const cancelBtn  = document.getElementById('specDialogCancel');
  const closeBtn   = document.getElementById('specDialogClose');
  const withAi     = document.getElementById('withScenarios');
  const aiDesc     = document.getElementById('scenariosDesc');

  function openDialog() {
    _specRawContent = '';
    filenameEl.textContent = 'No file selected';
    colNameEl.value  = '';
    importBtn.disabled = true;
    if (withAi) { withAi.checked = false; withAi.disabled = !_aiKeyConfigured; }
    if (aiDesc) aiDesc.style.display = 'none';
    backdrop.classList.remove('hidden');
    applyAiKeyGuards();
  }

  function closeDialog() { backdrop.classList.add('hidden'); }

  // Open via topbar button
  document.getElementById('importSpecBtn')?.addEventListener('click', openDialog);
  cancelBtn?.addEventListener('click', closeDialog);
  closeBtn?.addEventListener('click', closeDialog);
  backdrop?.addEventListener('click', e => { if (e.target === backdrop) closeDialog(); });

  // File picker
  browseBtn?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    filenameEl.textContent = file.name;
    const reader = new FileReader();
    reader.onload = ev => {
      _specRawContent = ev.target.result;
      importBtn.disabled = false;
      // Try to pre-fill collection name from spec
      try {
        const parsed = _specRawContent.trim().startsWith('{')
          ? JSON.parse(_specRawContent)
          : null; // YAML parsing happens server-side
        if (parsed?.info?.title && !colNameEl.value) {
          colNameEl.value = parsed.info.title;
        }
      } catch (_) {}
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Toggle AI description
  withAi?.addEventListener('change', () => {
    if (aiDesc) aiDesc.style.display = withAi.checked ? 'block' : 'none';
  });

  // Import
  importBtn?.addEventListener('click', async () => {
    if (!_specRawContent) return;
    importBtn.disabled = true;
    importBtn.textContent = withAi?.checked ? 'Generating scenarios…' : 'Importing…';
    try {
      const col = await colFetch('/import-openapi', {
        method: 'POST',
        body: JSON.stringify({
          spec:          _specRawContent,
          name:          colNameEl.value.trim() || undefined,
          withScenarios: withAi?.checked ?? false,
        }),
      });
      _expanded[col.id] = new Set(['__root__']);
      await loadMocks();
      closeDialog();
      toast(`Collection "${col.name}" created (${col.items?.length || 0} folder(s))`, 'success');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
      importBtn.disabled = false;
      importBtn.textContent = 'Import';
    }
  });
}

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
    await checkAiKey();   // re-enable AI features if key was just added
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

let _collections  = [];    // summary list from server
let _searchQuery  = '';
let _selectedId   = null;  // selected mock id
let _selectedColId = null; // collection the selected mock lives in
let _draft        = null;  // deep clone being edited
// Expanded state: collectionId → Set of expanded folderIds (+ '__root__' = expanded)
const _expanded   = {};

const API   = '/mocxy/admin';
const CAPI  = '/mocxy/admin/collections';

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

async function colFetch(path, opts = {}) {
  const res = await fetch(CAPI + path, {
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
/*  Health + load                                                             */
/* -------------------------------------------------------------------------- */

async function loadMocks() {
  try {
    _collections = await colFetch('/') || [];
    renderSidebar();
    updateHealthBar();
    restoreFromHash();
  } catch (err) {
    setOffline(err.message);
  }
}

function restoreFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash || hash === 'new') return;
  // Try to find and select the mock from the hash
  // We'll fetch full collections lazily when needed
  if (_selectedId !== hash) {
    // Defer: the full tree is fetched on demand
  }
}

async function updateHealthBar() {
  try {
    const h   = await apiFetch('/health');
    const total = _collections.reduce((s, c) => s + (c.mockCount || 0), 0);
    document.getElementById('statusDot').className = 'status-dot connected';
    document.getElementById('statusText').textContent =
      `Connected · v${h.version} · ${_collections.length} collection${_collections.length !== 1 ? 's' : ''} · ${total} mock${total !== 1 ? 's' : ''} · uptime ${Math.floor((h.uptime||0)/60)}m`;
  } catch (_) { setOffline('Server not reachable'); }
}

function setOffline(msg) {
  document.getElementById('statusDot').className = 'status-dot offline';
  document.getElementById('statusText').textContent = `Offline — ${msg}`;
}

/* -------------------------------------------------------------------------- */
/*  Helper: flatten all mocks from a collection items tree                   */
/* -------------------------------------------------------------------------- */

function flattenItems(items) {
  const mocks = [];
  for (const item of (items || [])) {
    if (item.type === 'mock')   mocks.push(item);
    else if (item.type === 'folder') mocks.push(...flattenItems(item.items));
  }
  return mocks;
}

function findMockInTree(items, id) {
  for (const item of (items || [])) {
    if (item.type === 'mock' && item.id === id) return item;
    if (item.type === 'folder') {
      const found = findMockInTree(item.items, id);
      if (found) return found;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Sidebar — collection tree                                                 */
/* -------------------------------------------------------------------------- */

function renderSidebar() {
  const container = document.getElementById('mockList');
  const countEl   = document.getElementById('mockCount');
  const total     = _collections.reduce((s, c) => s + (c.mockCount || 0), 0);
  countEl.textContent = `${_collections.length} collection${_collections.length !== 1 ? 's' : ''} · ${total} mock${total !== 1 ? 's' : ''}`;

  const q = _searchQuery.toLowerCase();

  if (_collections.length === 0) {
    container.innerHTML = '<div class="list-empty">No collections — click New Collection</div>';
    return;
  }
  container.innerHTML = '';
  _collections.forEach(col => renderCollectionRow(container, col, q));
}

function renderCollectionRow(container, colSummary, q) {
  const expanded = _expanded[colSummary.id]?.has('__root__') ?? true;

  const wrapper = el('div', { className: 'col-wrapper' });

  // ── Collection header row ──
  const header = el('div', { className: 'col-header' });
  const arrow  = el('span', { className: `col-arrow${expanded ? ' open' : ''}`, textContent: '▶' });
  const dot    = el('span', { className: `col-dot${colSummary.enabled !== false ? ' active' : ''}` });
  const name   = el('span', { className: 'col-name', textContent: colSummary.name });
  const count  = el('span', { className: 'col-count', textContent: colSummary.mockCount || 0 });
  const menu   = el('button', { className: 'col-menu-btn', textContent: '⋯', title: 'Options' });

  header.appendChild(arrow);
  header.appendChild(dot);
  header.appendChild(name);
  header.appendChild(count);
  header.appendChild(menu);
  wrapper.appendChild(header);

  // Toggle expand/collapse
  header.addEventListener('click', async (e) => {
    if (e.target === menu) return;
    const isNowExpanded = !(_expanded[colSummary.id]?.has('__root__') ?? true);
    toggleExpand(colSummary.id, '__root__', isNowExpanded);
    if (isNowExpanded) {
      // Fetch full collection on first expand
      try {
        const full = await colFetch(`/${colSummary.id}`);
        colSummary._full = full;
      } catch (_) {}
    }
    renderSidebar();
  });

  // Context menu
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    showColMenu(e, colSummary);
  });

  // ── Items tree (if expanded) ──
  if (expanded) {
    const items = el('div', { className: 'col-items' });

    if (!colSummary._full) {
      // Lazy load full collection
      const loading = el('div', { className: 'tree-loading', textContent: 'Loading…' });
      items.appendChild(loading);
      colFetch(`/${colSummary.id}`).then(full => {
        colSummary._full = full;
        renderSidebar();
      }).catch(() => { loading.textContent = 'Failed to load'; });
    } else {
      const visibleItems = filterItems(colSummary._full.items || [], q);
      if (visibleItems.length === 0 && !q) {
        items.appendChild(el('div', { className: 'tree-empty', textContent: 'Empty collection' }));
      } else {
        renderItems(items, colSummary, visibleItems, colSummary.id, null, q);
      }
    }
    wrapper.appendChild(items);
  }

  container.appendChild(wrapper);
}

function filterItems(items, q) {
  if (!q) return items;
  return items.filter(item => {
    if (item.type === 'mock') {
      return (item.name || '').toLowerCase().includes(q) ||
             (item.request?.url || '').toLowerCase().includes(q);
    }
    if (item.type === 'folder') {
      return (item.name || '').toLowerCase().includes(q) ||
             filterItems(item.items || [], q).length > 0;
    }
    return false;
  });
}

function renderItems(container, colSummary, items, colId, parentFolderId, q) {
  items.forEach(item => {
    if (item.type === 'folder') {
      renderFolderRow(container, colSummary, item, colId, q);
    } else if (item.type === 'mock') {
      renderMockRow(container, colSummary, item, colId, parentFolderId);
    }
  });
}

function renderFolderRow(container, colSummary, folder, colId, q) {
  const expanded = _expanded[colId]?.has(folder.id) ?? false;
  const wrapper  = el('div', { className: 'folder-wrapper' });
  const row      = el('div', { className: 'folder-row' });

  const arrow   = el('span', { className: `folder-arrow${expanded ? ' open' : ''}`, textContent: '▶' });
  const icon    = el('span', { className: 'folder-icon', textContent: '📁' });
  const name    = el('span', { className: 'folder-name', textContent: folder.name });
  const menu    = el('button', { className: 'col-menu-btn', textContent: '⋯', title: 'Folder options' });

  row.appendChild(arrow);
  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(menu);
  wrapper.appendChild(row);

  row.addEventListener('click', (e) => {
    if (e.target === menu) return;
    toggleExpand(colId, folder.id, !expanded);
    renderSidebar();
  });

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    showFolderMenu(e, colSummary, folder, colId);
  });

  if (expanded) {
    const children = el('div', { className: 'folder-children' });
    const visible  = filterItems(folder.items || [], q);
    if (visible.length === 0 && !q) {
      children.appendChild(el('div', { className: 'tree-empty', textContent: 'Empty folder' }));
    } else {
      renderItems(children, colSummary, visible, colId, folder.id, q);
    }
    wrapper.appendChild(children);
  }

  container.appendChild(wrapper);
}

function renderMockRow(container, colSummary, mock, colId, folderId) {
  const isActive = mock.id === _selectedId;
  const row      = el('div', { className: `mock-row${isActive ? ' active' : ''}` });
  const method   = (mock.request?.method || 'ANY').toUpperCase();
  const badge    = el('span', { className: `mock-item-badge badge-${method.toLowerCase()}`, textContent: method });
  const info     = el('div', { className: 'mock-row-info' });
  info.appendChild(el('div', { className: 'mock-item-name', textContent: mock.name || 'Untitled' }));
  info.appendChild(el('div', { className: 'mock-item-url',  textContent: mock.request?.url || '(any URL)' }));
  if (mock.stats?.matched) {
    info.appendChild(el('div', { className: 'mock-item-hits', textContent: `${mock.stats.matched} hits` }));
  }
  const menu = el('button', { className: 'col-menu-btn', textContent: '⋯', title: 'Mock options' });
  menu.addEventListener('click', (e) => { e.stopPropagation(); showMockMenu(e, colSummary, mock, colId, folderId); });

  row.appendChild(badge);
  row.appendChild(info);
  row.appendChild(menu);
  row.addEventListener('click', (e) => { if (e.target !== menu) selectMock(mock, colSummary, colId, folderId); });
  container.appendChild(row);
}

/* -------------------------------------------------------------------------- */
/*  Expand state                                                              */
/* -------------------------------------------------------------------------- */

function toggleExpand(colId, key, expand) {
  if (!_expanded[colId]) _expanded[colId] = new Set(['__root__']);
  if (expand) _expanded[colId].add(key);
  else        _expanded[colId].delete(key);
}

/* -------------------------------------------------------------------------- */
/*  Context menus                                                             */
/* -------------------------------------------------------------------------- */

function showColMenu(e, col) {
  showMenu(e, [
    { label: '+ Add Mock',         action: () => showNewMockDialog(col, null) },
    { label: '+ Add Folder',       action: () => showNewFolderDialog(col, null) },
    { separator: true },
    { label: '✎ Rename',           action: () => renameCollection(col) },
    { label: '⎘ Duplicate',        action: () => duplicateCollection(col) },
    { label: '↓ Export',           action: () => exportCol(col) },
    { separator: true },
    { label: col.enabled !== false ? '○ Disable' : '● Enable',
      action: () => toggleCollection(col) },
    { label: '✕ Delete',           action: () => deleteCollection(col), danger: true },
  ]);
}

function showFolderMenu(e, col, folder, colId) {
  showMenu(e, [
    { label: '+ Add Mock',      action: () => showNewMockDialog(col, folder.id) },
    { label: '+ Add Sub-folder',action: () => showNewFolderDialog(col, folder.id) },
    { separator: true },
    { label: '✎ Rename',        action: () => renameFolder(col, folder) },
    { label: '✕ Delete',        action: () => deleteFolder(col, folder), danger: true },
  ]);
}

function showMockMenu(e, col, mock, colId, folderId) {
  showMenu(e, [
    { label: '✎ Edit',    action: () => selectMock(mock, col, colId, folderId) },
    { label: '⎘ Duplicate', action: () => duplicateMock(col, mock, folderId) },
    { label: '↕ Move to…', action: () => showMoveDialog(col, mock) },
    { separator: true },
    { label: '✕ Delete',  action: () => deleteMockItem(col, mock), danger: true },
  ]);
}

let _activeMenu = null;
function showMenu(e, items) {
  _activeMenu?.remove();
  const menu = el('div', { className: 'ctx-menu' });
  items.forEach(item => {
    if (item.separator) { menu.appendChild(el('div', { className: 'ctx-sep' })); return; }
    const btn = el('button', {
      className: `ctx-item${item.danger ? ' danger' : ''}`,
      textContent: item.label,
    });
    btn.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  _activeMenu = menu;

  // Position near the click
  const rect = e.target.getBoundingClientRect();
  menu.style.top  = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;

  setTimeout(() => document.addEventListener('click', () => { menu.remove(); _activeMenu = null; }, { once: true }), 0);
}

/* -------------------------------------------------------------------------- */
/*  Selection                                                                 */
/* -------------------------------------------------------------------------- */

function selectMock(mock, colSummary, colId, folderId) {
  _selectedId    = mock.id;
  _selectedColId = colId;
  _draft = JSON.parse(JSON.stringify(mock));
  history.replaceState(null, '', `#${mock.id}`);
  renderSidebar();
  buildEditor(_draft, colId, folderId);
}

function showEmpty() {
  document.getElementById('editorEmpty').classList.remove('hidden');
  document.getElementById('editorForm').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
}

/* -------------------------------------------------------------------------- */
/*  New mock / folder dialogs                                                 */
/* -------------------------------------------------------------------------- */

async function showNewMockDialog(col, folderId) {
  const name = prompt('Mock name:', 'New Mock');
  if (!name) return;
  try {
    const mock = await colFetch(`/${col.id}/mocks`, {
      method: 'POST',
      body: JSON.stringify({ name, folderId: folderId || undefined }),
    });
    // Expand the parent so user can see the new mock
    if (!_expanded[col.id]) _expanded[col.id] = new Set(['__root__']);
    _expanded[col.id].add('__root__');
    if (folderId) _expanded[col.id].add(folderId);
    await loadMocks();
    // Select the new mock for editing
    const full = await colFetch(`/${col.id}`);
    col._full  = full;
    const found = findMockInTree(full.items, mock.id);
    if (found) selectMock(found, col, col.id, folderId);
    toast('Mock created', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function showNewFolderDialog(col, parentFolderId) {
  const name = prompt('Folder name:', 'New Folder');
  if (!name) return;
  try {
    await colFetch(`/${col.id}/folders`, {
      method: 'POST',
      body: JSON.stringify({ name, parentFolderId: parentFolderId || undefined }),
    });
    if (!_expanded[col.id]) _expanded[col.id] = new Set(['__root__']);
    _expanded[col.id].add('__root__');
    if (parentFolderId) _expanded[col.id].add(parentFolderId);
    await loadMocks();
    toast('Folder created', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

/* -------------------------------------------------------------------------- */
/*  Collection actions                                                        */
/* -------------------------------------------------------------------------- */

async function renameCollection(col) {
  const name = prompt('Collection name:', col.name);
  if (!name || name === col.name) return;
  try {
    await colFetch(`/${col.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
    await loadMocks();
    toast('Renamed', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function toggleCollection(col) {
  try {
    await colFetch(`/${col.id}`, { method: 'PUT', body: JSON.stringify({ enabled: col.enabled === false }) });
    await loadMocks();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function deleteCollection(col) {
  if (!confirm(`Delete collection "${col.name}" and ALL its mocks?`)) return;
  try {
    await colFetch(`/${col.id}`, { method: 'DELETE' });
    if (_selectedColId === col.id) { _selectedId = null; _selectedColId = null; showEmpty(); }
    await loadMocks();
    toast('Collection deleted', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function duplicateCollection(col) {
  const name = prompt('Name for the duplicate:', col.name + ' (copy)');
  if (!name) return;
  try {
    const dup = await colFetch(`/${col.id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    _expanded[dup.id] = new Set(['__root__']);
    await loadMocks();
    toast(`Duplicated as "${dup.name}"`, 'success');
  } catch (err) { toast('Duplicate failed: ' + err.message, 'error'); }
}

async function exportCol(col) {
  try {
    const res  = await fetch(`${CAPI}/${col.id}/export`);
    const data = await res.json();
    downloadJson(data, col.name.replace(/[^a-z0-9]/gi, '_'));
    toast(`Exported "${col.name}"`, 'success');
  } catch (err) { toast('Export failed: ' + err.message, 'error'); }
}

/* -------------------------------------------------------------------------- */
/*  Folder actions                                                            */
/* -------------------------------------------------------------------------- */

async function renameFolder(col, folder) {
  const name = prompt('Folder name:', folder.name);
  if (!name || name === folder.name) return;
  try {
    await colFetch(`/${col.id}/folders/${folder.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
    await loadMocks();
    toast('Renamed', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function deleteFolder(col, folder) {
  if (!confirm(`Delete folder "${folder.name}" and all its mocks?`)) return;
  try {
    await colFetch(`/${col.id}/folders/${folder.id}`, { method: 'DELETE' });
    await loadMocks();
    toast('Folder deleted', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

/* -------------------------------------------------------------------------- */
/*  Mock item actions                                                         */
/* -------------------------------------------------------------------------- */

async function deleteMockItem(col, mock) {
  if (!confirm(`Delete mock "${mock.name || 'Untitled'}"?`)) return;
  try {
    await colFetch(`/${col.id}/mocks/${mock.id}`, { method: 'DELETE' });
    if (_selectedId === mock.id) { _selectedId = null; showEmpty(); }
    await loadMocks();
    toast('Mock deleted', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function duplicateMock(col, mock, folderId) {
  const { id, createdAt, updatedAt, stats, ...rest } = mock;
  rest.name = (rest.name || 'Untitled') + ' (copy)';
  rest.folderId = folderId || undefined;
  try {
    await colFetch(`/${col.id}/mocks`, { method: 'POST', body: JSON.stringify(rest) });
    await loadMocks();
    toast('Mock duplicated', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function showMoveDialog(col, mock) {
  // Build a list of all folders in this collection
  const full = await colFetch(`/${col.id}`).catch(() => null);
  if (!full) return;
  const folders = [];
  function collectFolders(items, depth) {
    for (const item of (items || [])) {
      if (item.type === 'folder') {
        folders.push({ id: item.id, name: '  '.repeat(depth) + item.name });
        collectFolders(item.items, depth + 1);
      }
    }
  }
  collectFolders(full.items, 0);

  const options = ['(collection root)', ...folders.map(f => f.name)];
  const choice  = prompt(`Move "${mock.name}" to:\n${options.map((o,i) => `${i}: ${o}`).join('\n')}\n\nEnter number:`);
  if (choice === null) return;
  const idx = parseInt(choice, 10);
  if (isNaN(idx) || idx < 0 || idx > folders.length) return;
  const targetFolderId = idx === 0 ? null : folders[idx - 1].id;
  try {
    await colFetch(`/${col.id}/mocks/${mock.id}/move`, { method: 'PUT', body: JSON.stringify({ targetFolderId }) });
    await loadMocks();
    toast('Mock moved', 'success');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

/* -------------------------------------------------------------------------- */
/*  filteredMocks — for export + AI context                                  */
/* -------------------------------------------------------------------------- */

function filteredMocks() {
  const all = [];
  for (const col of _collections) {
    if (col._full) all.push(...flattenItems(col._full.items || []));
  }
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    return all.filter(m =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.request?.url || '').toLowerCase().includes(q)
    );
  }
  return all;
}

/* -------------------------------------------------------------------------- */
/*  Editor builder                                                            */
/* -------------------------------------------------------------------------- */

function buildEditor(draft, colId, folderId) {
  // Store context for save
  draft._colId    = colId;
  draft._folderId = folderId;
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
  bodyArea.addEventListener('input', e => { draft.response.body = e.target.value; updateLN(); applyHL(); });
  respSec.appendChild(edWrap);

  form.appendChild(respSec);

  // ── Footer ──────────────────────────────────────────────────────────────
  const footer = el('div', { className: 'form-footer' });
  const errEl  = el('div', { className: 'form-error hidden', id: 'formError' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }); cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { _selectedId = null; _draft = null; showEmpty(); renderSidebar(); });
  const saveBtn = el('button', { className: 'btn btn-primary' }); saveBtn.textContent = 'Save Mock';
  saveBtn.addEventListener('click', async () => {
    rebuildRespHdrs();
    if (!draft.name.trim()) { showFormError('Please enter a mock name.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const cid = draft._colId;
    const fid = draft._folderId;
    try {
      let saved;
      if (draft.id && cid) {
        saved = await colFetch(`/${cid}/mocks/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) });
      } else if (cid) {
        saved = await colFetch(`/${cid}/mocks`, { method: 'POST', body: JSON.stringify({ ...draft, folderId: fid || undefined }) });
      }
      if (saved) {
        _selectedId = saved.id;
        await loadMocks();
        // Re-select after reload
        const col = _collections.find(c => c.id === cid);
        if (col?._full) {
          const m = findMockInTree(col._full.items, saved.id);
          if (m) selectMock(m, col, cid, fid);
        }
        toast('Mock saved', 'success');
      }
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

function downloadJson(mocks, label) {
  const blob = new Blob([JSON.stringify(mocks, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `mocxy-${label}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportMocks() {
  // If a filter/search is active, offer to export filtered subset
  const visible = filteredMocks();
  const all     = _mocks;
  const isFiltered = visible.length !== all.length;

  if (isFiltered) {
    const choice = confirm(
      `Export options:\n\nOK = Export visible mocks (${visible.length})\nCancel = Export all mocks (${all.length})`
    );
    const toExport = choice ? visible : all;
    downloadJson(toExport, choice ? 'filtered' : 'all');
    toast(`Exported ${toExport.length} mock(s)`, 'success');
  } else {
    try {
      const mocks = await apiFetch('/mocks/export');
      downloadJson(mocks, 'all');
      toast(`Exported ${mocks.length} mock(s)`, 'success');
    } catch (err) { toast('Export failed: ' + err.message, 'error'); }
  }
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
  loadMocks();
  checkAiKey();       // check LLM key on load
  initSpecDialog();   // set up OpenAPI import dialog

  // Browser back/forward
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1);
    if (!hash) { _selectedId = null; _draft = null; showEmpty(); renderSidebar(); }
  });

  // AI panel
  initAiPanel();

  // Auto-refresh every 15s
  setInterval(loadMocks, 15000);

  // New Collection button (topbar)
  document.getElementById('newMockBtn').addEventListener('click', async () => {
    const name = prompt('Collection name:', 'New Collection');
    if (!name) return;
    try {
      const col = await colFetch('/', { method: 'POST', body: JSON.stringify({ name }) });
      _expanded[col.id] = new Set(['__root__']);
      await loadMocks();
      toast('Collection created', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  });

  document.getElementById('emptyNewBtn').addEventListener('click', async () => {
    const name = prompt('Collection name:', 'New Collection');
    if (!name) return;
    try {
      const col = await colFetch('/', { method: 'POST', body: JSON.stringify({ name }) });
      _expanded[col.id] = new Set(['__root__']);
      await loadMocks();
      toast('Collection created', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  });

  // Export — exports all collections or a selected one
  document.getElementById('exportBtn').addEventListener('click', async () => {
    if (_selectedColId) {
      const col = _collections.find(c => c.id === _selectedColId);
      if (col) { await exportCol(col); return; }
    }
    // Export all collections
    try {
      const all = await colFetch('/');
      downloadJson(all, 'all-collections');
      toast(`Exported ${all.length} collection(s)`, 'success');
    } catch (err) { toast('Export failed: ' + err.message, 'error'); }
  });

  // Import — import a collection JSON
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data   = JSON.parse(ev.target.result);
        const list   = Array.isArray(data) ? data : [data];
        for (const col of list) {
          await colFetch('/import', { method: 'POST', body: JSON.stringify(col) });
        }
        await loadMocks();
        toast(`Imported ${list.length} collection(s)`, 'success');
      } catch (err) { toast('Import failed: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
  });

  // Delete all collections
  document.getElementById('deleteAllBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ALL collections and mocks? This cannot be undone.`)) return;
    try {
      for (const col of _collections) {
        await colFetch(`/${col.id}`, { method: 'DELETE' }).catch(() => {});
      }
      _selectedId = null; _selectedColId = null; _draft = null;
      await loadMocks();
      showEmpty();
      toast('All collections deleted', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', e => {
    _searchQuery = e.target.value;
    renderSidebar();
  });

  // Remove method filter bar (not needed for tree view)
  const mf = document.getElementById('methodFilters');
  if (mf) mf.style.display = 'none';
});
