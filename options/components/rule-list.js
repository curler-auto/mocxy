/**
 * Mocxy - Rule List Component
 * Drag-to-reorder rule list with search, toggle, duplicate, and delete.
 */

import { MSG_TYPES } from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Module state                                                              */
/* -------------------------------------------------------------------------- */

let _rules = [];
let _searchTerm = '';
let _container = null;
let _callbacks = null;
let _dragSourceIndex = null;

/* -------------------------------------------------------------------------- */
/*  Persistence helpers                                                       */
/* -------------------------------------------------------------------------- */

async function loadRules() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: MSG_TYPES.GET_RULES }, (response) => {
      const rules = (response && response.rules) || response || [];
      _rules = Array.isArray(rules) ? rules : [];
      resolve(_rules);
    });
  });
}

async function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MSG_TYPES.SET_RULES, rules },
      () => { _rules = rules; resolve(); },
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function _generateId() {
  try { return crypto.randomUUID(); }
  catch (_) { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
}

function filteredRules() {
  if (!_searchTerm) return _rules;
  const q = _searchTerm.toLowerCase();
  return _rules.filter((r) => {
    const name = (r.name || '').toLowerCase();
    const urlVal = (r.condition?.url?.value || '').toLowerCase();
    return name.includes(q) || urlVal.includes(q);
  });
}

function conditionSummary(rule) {
  const parts = [];
  const cond = rule.condition || {};
  if (cond.url && cond.url.value) {
    const val = cond.url.value.length > 50 ? cond.url.value.slice(0, 50) + '\u2026' : cond.url.value;
    parts.push(`URL ${cond.url.type || 'contains'}: ${val}`);
  }
  if (cond.methods && cond.methods.length) parts.push(cond.methods.join(', '));
  if (cond.headers && cond.headers.length) parts.push(`${cond.headers.length} header(s)`);
  return parts.length ? parts.join(' \u00B7 ') : 'No conditions';
}

const ACTION_BADGE_MAP = {
  redirect:       { cls: 'rl-badge-blue',    label: 'REDIRECT' },
  rewrite:        { cls: 'rl-badge-purple',  label: 'REWRITE' },
  mock_inline:    { cls: 'rl-badge-green',   label: 'MOCK' },
  mock_server:    { cls: 'rl-badge-orange',  label: 'MOCK SERVER' },
  modify_headers: { cls: 'rl-badge-cyan',    label: 'HEADERS' },
  delay:          { cls: 'rl-badge-yellow',  label: 'DELAY' },
  block:          { cls: 'rl-badge-red',     label: 'BLOCK' },
  modify_body:    { cls: 'rl-badge-purple',  label: 'MOD BODY' },
  set_user_agent: { cls: 'rl-badge-cyan',    label: 'USER-AGENT' },
  graphql_mock:   { cls: 'rl-badge-purple',  label: 'GRAPHQL' },
  inject_script:   { cls: 'rl-badge-yellow',  label: 'INJECT JS' },
  inject_css:      { cls: 'rl-badge-cyan',    label: 'INJECT CSS' },
  inject_payload:  { cls: 'rl-badge-orange',  label: 'INJECT BODY' },
};

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

function renderToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'rl-toolbar';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search rules\u2026';
  search.className = 'rl-search-input';
  search.value = _searchTerm;
  search.addEventListener('input', (e) => { _searchTerm = e.target.value; renderList(); });

  const count = document.createElement('span');
  count.className = 'rl-rule-count';
  count.textContent = `${_rules.length} rule${_rules.length !== 1 ? 's' : ''}`;

  toolbar.appendChild(search);
  toolbar.appendChild(count);
  return toolbar;
}

function renderCard(rule, index) {
  const card = document.createElement('div');
  card.className = `rl-card${rule.enabled === false ? ' rl-card-disabled' : ''}`;
  card.dataset.index = index;
  card.draggable = true;

  // Drag handle
  const grip = document.createElement('span');
  grip.className = 'rl-grip';
  grip.textContent = '\u22EE\u22EE';
  grip.title = 'Drag to reorder';
  card.appendChild(grip);

  // Enable toggle
  const toggle = document.createElement('label');
  toggle.className = 'rl-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = rule.enabled !== false;
  cb.addEventListener('change', async () => {
    rule.enabled = cb.checked;
    await saveRules(_rules);
    renderList();
  });
  const slider = document.createElement('span');
  slider.className = 'rl-toggle-slider';
  toggle.appendChild(cb);
  toggle.appendChild(slider);
  card.appendChild(toggle);

  // Body
  const body = document.createElement('div');
  body.className = 'rl-card-body';

  const nameEl = document.createElement('div');
  nameEl.className = 'rl-card-name';
  nameEl.textContent = rule.name || '(unnamed)';
  body.appendChild(nameEl);

  const summary = document.createElement('div');
  summary.className = 'rl-card-summary';
  summary.textContent = conditionSummary(rule);
  body.appendChild(summary);
  card.appendChild(body);

  // Action badge
  const actionType = rule.action?.type || 'redirect';
  const badgeInfo = ACTION_BADGE_MAP[actionType] || { cls: 'rl-badge-gray', label: actionType };
  const badge = document.createElement('span');
  badge.className = `rl-action-badge ${badgeInfo.cls}`;
  badge.textContent = badgeInfo.label;
  card.appendChild(badge);

  // Priority pill
  const prio = document.createElement('span');
  prio.className = 'rl-priority';
  prio.textContent = String(rule.priority ?? 0);
  prio.title = 'Priority';
  card.appendChild(prio);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'rl-card-actions';

  const editBtn = _iconBtn('Edit', () => {
    if (_callbacks?.onEdit) _callbacks.onEdit(rule);
  });
  const dupBtn = _iconBtn('Copy', async () => {
    const clone = JSON.parse(JSON.stringify(rule));
    clone.id = _generateId();
    clone.name = (clone.name || 'Rule') + ' (copy)';
    _rules.push(clone);
    await saveRules(_rules);
    renderList();
  });
  const delBtn = _iconBtn('Del', async () => {
    if (!confirm(`Delete rule "${rule.name || '(unnamed)'}"?`)) return;
    const idx = _rules.indexOf(rule);
    if (idx !== -1) _rules.splice(idx, 1);
    await saveRules(_rules);
    renderList();
  });
  delBtn.classList.add('rl-icon-btn-danger');

  const previewBtn = _iconBtn('{ }', () => showPreview(rule));
  previewBtn.title = 'Preview rule JSON';
  previewBtn.style.fontFamily = 'monospace';
  previewBtn.style.fontSize = '10px';
  actions.appendChild(previewBtn);
  actions.appendChild(editBtn);
  actions.appendChild(dupBtn);
  actions.appendChild(delBtn);
  card.appendChild(actions);

  // --- Drag events ---
  card.addEventListener('dragstart', (e) => {
    _dragSourceIndex = index;
    card.classList.add('rl-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('rl-dragging');
    _dragSourceIndex = null;
    _clearDropIndicators();
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    _showDropIndicator(card, e);
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('rl-drop-above', 'rl-drop-below');
  });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    _clearDropIndicators();
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (isNaN(from) || from === index) return;
    const rect = card.getBoundingClientRect();
    let to = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
    if (from < to) to -= 1;
    if (from === to) return;
    const [moved] = _rules.splice(from, 1);
    _rules.splice(to, 0, moved);
    await saveRules(_rules);
    renderList();
  });

  return card;
}

function _iconBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'rl-icon-btn';
  btn.textContent = label;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function renderList() {
  const listEl = _container.querySelector('.rl-list-body');
  if (!listEl) return;
  listEl.innerHTML = '';

  // Update count
  const countEl = _container.querySelector('.rl-rule-count');
  if (countEl) countEl.textContent = `${_rules.length} rule${_rules.length !== 1 ? 's' : ''}`;

  const visible = filteredRules();
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rl-empty';
    empty.textContent = _rules.length === 0
      ? 'No rules yet. Click "+ Add Rule" to create one.'
      : 'No rules match your search.';
    listEl.appendChild(empty);
    return;
  }

  visible.forEach((rule) => {
    listEl.appendChild(renderCard(rule, _rules.indexOf(rule)));
  });
}

function highlightJson(json) {
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b)|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([\[\]{},])/g,
    (match, str, colon, bool, nul, num, punc) => {
      if (str && colon) return `<span class="rl-j-key">${str}</span><span class="rl-j-punc">:</span>`;
      if (str)  return `<span class="rl-j-str">${str}</span>`;
      if (bool) return `<span class="rl-j-bool">${match}</span>`;
      if (nul !== undefined && match === 'null') return `<span class="rl-j-null">null</span>`;
      if (num)  return `<span class="rl-j-num">${match}</span>`;
      if (punc) return `<span class="rl-j-punc">${match}</span>`;
      return match;
    }
  );
}

function showPreview(rule) {
  const overlay = document.createElement('div');
  overlay.className = 'rl-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'rl-preview-panel';

  // Header
  const header = document.createElement('div');
  header.className = 'rl-preview-header';

  const title = document.createElement('span');
  title.className = 'rl-preview-title';
  title.textContent = rule.name || '(unnamed rule)';

  const btns = document.createElement('div');
  btns.className = 'rl-preview-header-btns';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'rl-preview-copy-btn';
  copyBtn.textContent = 'Copy JSON';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(rule, null, 2)).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy JSON';
        copyBtn.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      // Fallback for extension context
      const ta = document.createElement('textarea');
      ta.value = JSON.stringify(rule, null, 2);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1500);
    });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'rl-preview-close-btn';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => overlay.remove());

  btns.appendChild(copyBtn);
  btns.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(btns);
  panel.appendChild(header);

  // Body with line numbers + highlighted JSON
  const body = document.createElement('div');
  body.className = 'rl-preview-body';

  const code = document.createElement('div');
  code.className = 'rl-preview-code';

  const jsonStr = JSON.stringify(rule, null, 2);
  const lines = jsonStr.split('\n');

  const lineNums = document.createElement('div');
  lineNums.className = 'rl-preview-line-numbers';
  lineNums.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('');

  const jsonPre = document.createElement('div');
  jsonPre.className = 'rl-preview-json';
  jsonPre.innerHTML = highlightJson(jsonStr);

  code.appendChild(lineNums);
  code.appendChild(jsonPre);
  body.appendChild(code);
  panel.appendChild(body);
  overlay.appendChild(panel);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  // Close on Escape
  const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

function render() {
  if (!_container) return;
  _container.innerHTML = '';
  _container.appendChild(renderToolbar());
  const listBody = document.createElement('div');
  listBody.className = 'rl-list-body';
  _container.appendChild(listBody);
  renderList();
}

/* -------------------------------------------------------------------------- */
/*  Drag helpers                                                              */
/* -------------------------------------------------------------------------- */

function _showDropIndicator(card, e) {
  _clearDropIndicators();
  const rect = card.getBoundingClientRect();
  card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'rl-drop-above' : 'rl-drop-below');
}

function _clearDropIndicators() {
  if (!_container) return;
  _container.querySelectorAll('.rl-drop-above, .rl-drop-below')
    .forEach((el) => el.classList.remove('rl-drop-above', 'rl-drop-below'));
}

/* -------------------------------------------------------------------------- */
/*  Injected styles (Catppuccin Mocha)                                       */
/* -------------------------------------------------------------------------- */

function _injectStyles() {
  if (document.getElementById('rl-list-styles')) return;
  const style = document.createElement('style');
  style.id = 'rl-list-styles';
  style.textContent = `
/* Rule List Component */

.rl-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.rl-search-input {
  flex: 1;
  background: var(--c-surface2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  color: var(--c-text);
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  transition: border-color 0.2s;
}
.rl-search-input:focus { border-color: var(--c-accent); }
.rl-search-input::placeholder { color: var(--c-subtle); }

.rl-rule-count {
  font-size: 12px;
  color: var(--c-subtle);
  white-space: nowrap;
}

/* --- Card --- */

.rl-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  margin-bottom: 4px;
  transition: background 0.12s, border-color 0.12s, opacity 0.12s;
}
.rl-card:hover { background: var(--c-bg); border-color: var(--c-border2); }
.rl-card-disabled { opacity: 0.5; }
.rl-card.rl-dragging { opacity: 0.35; }
.rl-card.rl-drop-above { border-top: 2px solid var(--c-accent); margin-top: -2px; }
.rl-card.rl-drop-below { border-bottom: 2px solid var(--c-accent); margin-bottom: -2px; }

.rl-grip {
  cursor: grab;
  font-size: 14px;
  color: var(--c-subtle);
  padding: 0 2px;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: -2px;
}
.rl-grip:hover { color: var(--c-muted); }

/* Toggle */
.rl-toggle {
  position: relative;
  display: inline-block;
  width: 30px;
  height: 16px;
  cursor: pointer;
  flex-shrink: 0;
}
.rl-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.rl-toggle-slider {
  position: absolute; inset: 0;
  background: var(--c-toggle-off);
  border-radius: 8px;
  transition: background 0.2s;
}
.rl-toggle-slider::before {
  content: '';
  position: absolute; left: 2px; top: 2px;
  width: 12px; height: 12px;
  background: var(--c-toggle-thumb);
  border-radius: 50%;
  transition: transform 0.2s;
}
.rl-toggle input:checked + .rl-toggle-slider { background: var(--c-success); }
.rl-toggle input:checked + .rl-toggle-slider::before { transform: translateX(14px); }

/* Card body */
.rl-card-body { flex: 1; min-width: 0; overflow: hidden; }

.rl-card-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rl-card-summary {
  font-size: 11px;
  color: var(--c-subtle);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

/* Badge */
.rl-action-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.rl-badge-blue   { background: rgba(0,120,212,0.15);   color: var(--c-accent); }
.rl-badge-purple { background: rgba(197,134,192,0.15); color: #c586c0; }
.rl-badge-green  { background: rgba(78,201,176,0.15);  color: var(--c-success); }
.rl-badge-orange { background: rgba(214,160,108,0.15); color: #d6a06c; }
.rl-badge-cyan   { background: rgba(78,201,176,0.15);  color: #4ec9b0; }
.rl-badge-yellow { background: rgba(215,186,125,0.15); color: var(--c-warning); }
.rl-badge-gray   { background: var(--c-surface2);      color: var(--c-muted); }
.rl-badge-red    { background: rgba(244,112,103,0.15); color: var(--c-error); }

/* Priority */
.rl-priority {
  font-size: 10px;
  color: var(--c-subtle);
  background: var(--c-surface2);
  border-radius: 4px;
  padding: 2px 6px;
  flex-shrink: 0;
  min-width: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Actions */
.rl-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.rl-icon-btn {
  background: none;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 3px 8px;
  transition: background 0.12s, color 0.12s;
}
.rl-icon-btn:hover { background: var(--c-surface3); color: var(--c-text); }
.rl-icon-btn-danger { color: var(--c-muted); }
.rl-icon-btn-danger:hover { background: rgba(244,135,113,0.15); color: var(--c-error); border-color: var(--c-error); }

/* Empty */
.rl-empty {
  padding: 40px 16px;
  text-align: center;
  color: var(--c-subtle);
  font-size: 14px;
}

/* Rule preview overlay */
.rl-preview-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.rl-preview-panel {
  width: 640px; max-width: 92vw; max-height: 80vh;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.rl-preview-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px;
  background: var(--c-surface2);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.rl-preview-title {
  font-size: 13px; font-weight: 600; color: var(--c-text);
}
.rl-preview-header-btns {
  display: flex; gap: 8px; align-items: center;
}
.rl-preview-copy-btn {
  padding: 4px 12px;
  background: var(--c-accent); color: var(--c-accent-text);
  border: none; border-radius: 3px;
  font-size: 11px; font-weight: 600; cursor: pointer;
  transition: background 0.12s;
}
.rl-preview-copy-btn:hover { background: var(--c-accent-h); }
.rl-preview-copy-btn.copied { background: var(--c-success); }
.rl-preview-close-btn {
  background: none; border: none; color: var(--c-muted);
  font-size: 18px; cursor: pointer; padding: 2px 6px;
  border-radius: 3px;
}
.rl-preview-close-btn:hover { background: var(--c-surface3); color: var(--c-text); }
.rl-preview-body {
  flex: 1; overflow-y: auto;
  background: var(--c-bg-deep);
  padding: 0;
}
.rl-preview-code {
  display: flex;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.6;
  tab-size: 2;
  min-height: 100%;
}
.rl-preview-line-numbers {
  padding: 12px 8px 12px 12px;
  text-align: right;
  color: var(--c-subtle);
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
  user-select: none;
  flex-shrink: 0;
  min-width: 40px;
}
.rl-preview-line-numbers span { display: block; }
.rl-preview-json {
  padding: 12px 16px;
  flex: 1;
  white-space: pre;
  color: var(--c-text);
  overflow-x: auto;
}
/* JSON token colors — VS Code Dark+ palette */
.rl-j-key    { color: #9cdcfe; }
.rl-j-str    { color: #ce9178; }
.rl-j-num    { color: #b5cea8; }
.rl-j-bool   { color: #569cd6; }
.rl-j-null   { color: #569cd6; }
.rl-j-punc   { color: #d4d4d4; }
`;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export function initRuleList(container, { onEdit, onRefresh } = {}) {
  _container = container;
  _callbacks = { onEdit, onRefresh };
  _injectStyles();
  loadRules().then(() => render());

  async function refresh() {
    await loadRules();
    render();
    if (_callbacks.onRefresh) _callbacks.onRefresh();
  }

  return { refresh };
}
