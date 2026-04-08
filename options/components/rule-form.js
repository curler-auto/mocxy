/**
 * Mocxy - Rule Form Component
 * Modal/panel form for creating and editing interception rules.
 * Provides condition builder + action configuration with dynamic sub-forms.
 */

import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
  USER_AGENT_PRESETS,
} from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Module state                                                              */
/* -------------------------------------------------------------------------- */

let _container = null;
let _callbacks = null;
let _editingRule = null;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function _generateId() {
  try { return crypto.randomUUID(); }
  catch (_) { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
}

function _defaultRule() {
  return {
    id: _generateId(),
    name: '',
    enabled: true,
    priority: 0,
    condition: {
      url: { type: URL_MATCH_TYPES.CONTAINS, value: '' },
      headers: [],
      methods: [],
    },
    action: {
      type: ACTION_TYPES.REDIRECT,
      redirect: { targetHost: '', preservePath: true },
      rewrite: { pattern: '', replacement: '' },
      mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
      mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: MOCK_SERVER_MODES.RESPONSE_ONLY, stepTag: '' },
      headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
      delayMs: 0,
    },
  };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'innerHTML') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/*  Form builder                                                              */
/* -------------------------------------------------------------------------- */

function _buildForm() {
  const form = el('form', { className: 'rf-form' });
  form.addEventListener('submit', (e) => e.preventDefault());

  // Title
  form.appendChild(el('h2', {
    className: 'rf-title',
    textContent: _editingRule ? 'Edit Rule' : 'New Rule',
  }));

  // Basic section
  form.appendChild(_buildBasicSection());
  // Conditions section
  form.appendChild(_buildConditionsSection());
  // Action section
  form.appendChild(_buildActionSection());
  // Footer
  form.appendChild(_buildFooter());

  return form;
}

/* ----- Basic ----- */

function _buildBasicSection() {
  const sec = el('fieldset', { className: 'rf-section' });
  sec.appendChild(el('legend', { className: 'rf-legend', textContent: 'Basic' }));

  // Name
  const nameInput = el('input', {
    type: 'text', id: 'rf-name', className: 'rf-input',
    placeholder: 'Rule name', value: _editingRule?.name || '',
  });
  nameInput.required = true;
  sec.appendChild(_row('Name', nameInput));

  // Priority
  const prioInput = el('input', {
    type: 'number', id: 'rf-priority', className: 'rf-input rf-input-short',
    placeholder: '0', value: String(_editingRule?.priority ?? 0), min: '0',
  });
  sec.appendChild(_row('Priority', prioInput));

  // Enabled
  const enabledCb = el('input', { type: 'checkbox', id: 'rf-enabled' });
  enabledCb.checked = _editingRule?.enabled !== false;
  enabledCb.className = 'rf-checkbox';
  sec.appendChild(_row('Enabled', enabledCb));

  return sec;
}

/* ----- Conditions ----- */

function _buildConditionsSection() {
  const sec = el('fieldset', { className: 'rf-section' });
  sec.appendChild(el('legend', { className: 'rf-legend', textContent: 'Conditions' }));

  // URL row
  const urlRow = el('div', { className: 'rf-url-row' });
  urlRow.appendChild(el('label', { className: 'rf-label', textContent: 'URL' }));

  const urlType = el('select', { id: 'rf-url-type', className: 'rf-select' });
  for (const [, val] of Object.entries(URL_MATCH_TYPES)) {
    const opt = el('option', { value: val, textContent: val });
    if ((_editingRule?.condition?.url?.type || URL_MATCH_TYPES.CONTAINS) === val) opt.selected = true;
    urlType.appendChild(opt);
  }
  urlRow.appendChild(urlType);

  const urlInput = el('input', {
    type: 'text', id: 'rf-url-value', className: 'rf-input',
    placeholder: 'URL pattern', value: _editingRule?.condition?.url?.value || '',
    style: 'flex:1',
  });
  urlRow.appendChild(urlInput);
  sec.appendChild(urlRow);

  // Methods
  const methodsBox = el('fieldset', { className: 'rf-methods-box' });
  methodsBox.appendChild(el('legend', { className: 'rf-sub-legend', textContent: 'Methods' }));
  const methodsGrid = el('div', { className: 'rf-methods-grid' });
  const activeMethods = _editingRule?.condition?.methods || [];
  HTTP_METHODS.forEach((m) => {
    const lbl = el('label', { className: 'rf-cb-label' });
    const cb = el('input', { type: 'checkbox', value: m, className: 'rf-method-cb' });
    cb.checked = activeMethods.includes(m);
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(m));
    methodsGrid.appendChild(lbl);
  });
  methodsBox.appendChild(methodsGrid);
  sec.appendChild(methodsBox);

  // Headers
  const headersWrap = el('div', { className: 'rf-headers-wrap' });
  const headersBar = el('div', { className: 'rf-row-between' });
  headersBar.appendChild(el('span', { className: 'rf-label', textContent: 'Headers' }));
  const addHdrBtn = el('button', { type: 'button', className: 'rf-small-btn', textContent: '+ Add' });
  headersBar.appendChild(addHdrBtn);
  headersWrap.appendChild(headersBar);

  const headersList = el('div', { id: 'rf-headers-list', className: 'rf-kv-list' });
  headersWrap.appendChild(headersList);

  const existingHeaders = _editingRule?.condition?.headers || [];
  existingHeaders.forEach((h) => _appendHeaderRow(headersList, h));
  addHdrBtn.addEventListener('click', () => {
    _appendHeaderRow(headersList, { name: '', type: HEADER_MATCH_TYPES.EQUALS, value: '' });
  });

  sec.appendChild(headersWrap);

  // Payload condition
  const payloadWrap = el('div', { className: 'rf-payload-wrap' });
  const payloadBar = el('div', { className: 'rf-row-between' });
  payloadBar.appendChild(el('span', { className: 'rf-label', textContent: 'Payload Match' }));

  const payloadEnabled = el('input', { type: 'checkbox', id: 'rf-payload-enabled', className: 'rf-checkbox' });
  payloadEnabled.checked = _editingRule?.condition?.payload?.enabled || false;

  const payloadToggleLabel = el('label', { className: 'rf-cb-label' });
  payloadToggleLabel.appendChild(payloadEnabled);
  payloadToggleLabel.appendChild(document.createTextNode(' Enable'));
  payloadBar.appendChild(payloadToggleLabel);
  payloadWrap.appendChild(payloadBar);

  const payloadFields = el('div', { id: 'rf-payload-fields' });
  payloadFields.style.display = payloadEnabled.checked ? 'block' : 'none';

  // Type select
  const payloadTypeSelect = el('select', { id: 'rf-payload-type', className: 'rf-select' });
  [
    { value: 'contains', label: 'Contains' },
    { value: 'equals',   label: 'Equals (JSON)' },
    { value: 'jsonpath', label: 'JSONPath' },
    { value: 'js',       label: 'Custom JS' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((_editingRule?.condition?.payload?.type || 'contains') === value) opt.selected = true;
    payloadTypeSelect.appendChild(opt);
  });
  payloadFields.appendChild(_row('Match Type', payloadTypeSelect));

  const payloadExpr = el('textarea', {
    id: 'rf-payload-expression',
    className: 'rf-textarea',
    placeholder: 'e.g. $.version == "v3"  or  (body) => body.type === "flight"',
    rows: '3',
  });
  payloadExpr.value = _editingRule?.condition?.payload?.expression || '';
  payloadFields.appendChild(el('label', { className: 'rf-label rf-label-block', textContent: 'Expression' }));
  payloadFields.appendChild(payloadExpr);

  const payloadHint = el('div', { className: 'rf-payload-hint' });
  payloadHint.innerHTML = '<span style="opacity:0.6;font-size:11px">JSONPath: <code>$.key == "val"</code> · JS: <code>(body) => body.type === "v3"</code></span>';
  payloadFields.appendChild(payloadHint);

  payloadWrap.appendChild(payloadFields);
  payloadEnabled.addEventListener('change', () => {
    payloadFields.style.display = payloadEnabled.checked ? 'block' : 'none';
  });
  sec.appendChild(payloadWrap);

  // GraphQL condition
  const section = sec;
  const gqlWrap = el('div', { className: 'rf-payload-wrap' });
  const gqlBar = el('div', { className: 'rf-row-between' });
  gqlBar.appendChild(el('span', { className: 'rf-label', textContent: 'GraphQL Match' }));
  const gqlEnabled = el('input', { type: 'checkbox', id: 'rf-gql-enabled', className: 'rf-checkbox' });
  gqlEnabled.checked = _editingRule?.condition?.graphql?.enabled || false;
  const gqlToggleLabel = el('label', { className: 'rf-cb-label' });
  gqlToggleLabel.appendChild(gqlEnabled);
  gqlToggleLabel.appendChild(document.createTextNode(' Enable'));
  gqlBar.appendChild(gqlToggleLabel);
  gqlWrap.appendChild(gqlBar);

  const gqlCondFields = el('div', { id: 'rf-gql-cond-fields' });
  gqlCondFields.style.display = gqlEnabled.checked ? 'block' : 'none';

  const gqlCondOpType = el('select', { id: 'rf-gql-cond-type', className: 'rf-select' });
  [
    { value: 'any', label: 'Any' },
    { value: 'query', label: 'Query' },
    { value: 'mutation', label: 'Mutation' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((_editingRule?.condition?.graphql?.operationType || 'any') === value) opt.selected = true;
    gqlCondOpType.appendChild(opt);
  });
  gqlCondFields.appendChild(_row('Op Type', gqlCondOpType));
  gqlCondFields.appendChild(_row('Op Name', el('input', {
    type: 'text', id: 'rf-gql-cond-opname', className: 'rf-input',
    placeholder: 'GetFleet', value: _editingRule?.condition?.graphql?.operationName || '',
  })));
  gqlWrap.appendChild(gqlCondFields);
  gqlEnabled.addEventListener('change', () => {
    gqlCondFields.style.display = gqlEnabled.checked ? 'block' : 'none';
  });
  section.appendChild(gqlWrap);

  return sec;
}

function _appendHeaderRow(container, header) {
  const row = el('div', { className: 'rf-hdr-row' });
  row.appendChild(el('input', {
    type: 'text', className: 'rf-input rf-hdr-name',
    placeholder: 'Header name', value: header.name || '', style: 'flex:1',
  }));

  const typeSelect = el('select', { className: 'rf-select rf-hdr-type' });
  for (const [, val] of Object.entries(HEADER_MATCH_TYPES)) {
    const opt = el('option', { value: val, textContent: val });
    if ((header.type || HEADER_MATCH_TYPES.EQUALS) === val) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  row.appendChild(typeSelect);

  row.appendChild(el('input', {
    type: 'text', className: 'rf-input rf-hdr-value',
    placeholder: 'Header value', value: header.value || '', style: 'flex:1',
  }));

  const removeBtn = el('button', {
    type: 'button', className: 'rf-small-btn rf-remove-btn', textContent: '\u2715',
    onClick: () => row.remove(),
  });
  row.appendChild(removeBtn);
  container.appendChild(row);
}

/* ----- Action ----- */

function _buildActionSection() {
  const sec = el('fieldset', { className: 'rf-section' });
  sec.appendChild(el('legend', { className: 'rf-legend', textContent: 'Action' }));

  // Type selector
  const typeRow = el('div', { className: 'rf-url-row' });
  typeRow.appendChild(el('label', { className: 'rf-label', textContent: 'Type' }));
  const typeSelect = el('select', { id: 'rf-action-type', className: 'rf-select' });
  const currentType = _editingRule?.action?.type || ACTION_TYPES.REDIRECT;
  for (const [, val] of Object.entries(ACTION_TYPES)) {
    const opt = el('option', { value: val, textContent: val.replace(/_/g, ' ') });
    if (val === currentType) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeSelect);
  sec.appendChild(typeRow);

  // Sub-forms container
  const sub = el('div', { id: 'rf-action-subs' });
  sub.appendChild(_subRedirect());
  sub.appendChild(_subRewrite());
  sub.appendChild(_subMockInline());
  sub.appendChild(_subMockServer());
  sub.appendChild(_subModifyHeaders());
  sub.appendChild(_subDelay());
  sub.appendChild(_subBlock());
  sub.appendChild(_subModifyBody());
  sub.appendChild(_subSetUserAgent());
  sub.appendChild(_subGraphqlMock());
  sub.appendChild(_subInjectScript());
  sub.appendChild(_subInjectCss());
  sub.appendChild(_subInjectPayload());
  sec.appendChild(sub);

  typeSelect.addEventListener('change', () => _toggleSub(typeSelect.value));
  requestAnimationFrame(() => _toggleSub(currentType));

  return sec;
}

function _toggleSub(type) {
  _container.querySelectorAll('.rf-action-sub').forEach((el) => {
    el.style.display = el.dataset.type === type ? 'block' : 'none';
  });
}

function _actionSub(type) {
  const div = el('div', { className: 'rf-action-sub' });
  div.dataset.type = type;
  div.style.display = 'none';
  return div;
}

/**
 * Build a reusable "Inject Payload" collapsible section for action sub-forms.
 * @param {string} prefix   Unique prefix for element IDs (e.g. 'redir', 'rw', 'ms')
 * @param {object} cfg      Existing injectPayload config from the rule being edited
 */
function _buildPayloadSection(prefix, cfg) {
  const existing = cfg || {};
  const wrap = el('div', { className: 'rf-payload-action-wrap' });

  // Separator
  const sep = el('div'); sep.style.cssText = 'border-top:1px solid var(--c-border);margin:12px 0 8px';
  wrap.appendChild(sep);

  // Enable toggle
  const toggleBar = el('div', { className: 'rf-row-between' });
  const toggleLbl = el('label', { className: 'rf-cb-label' });
  const enableCb  = el('input', { type: 'checkbox', id: `rf-${prefix}-ip-enabled`, className: 'rf-checkbox' });
  enableCb.checked = existing.enabled === true;
  toggleLbl.appendChild(enableCb);
  toggleLbl.appendChild(document.createTextNode(' Inject / Modify Payload'));
  toggleBar.appendChild(toggleLbl);
  wrap.appendChild(toggleBar);

  // Fields (hidden until enabled)
  const fields = el('div', { id: `rf-${prefix}-ip-fields` });
  fields.style.display = existing.enabled ? 'block' : 'none';
  fields.style.marginTop = '8px';

  // Content type
  const ctSel = el('select', { id: `rf-${prefix}-ip-ct`, className: 'rf-select' });
  [['json','JSON'],['form','Form (urlencoded)'],['text','Text / Plain']].forEach(([v,l]) => {
    const opt = el('option', { value: v, textContent: l });
    if ((existing.contentType || 'json') === v) opt.selected = true;
    ctSel.appendChild(opt);
  });
  fields.appendChild(_row('Content Type', ctSel));

  // Operation
  const opSel = el('select', { id: `rf-${prefix}-ip-op`, className: 'rf-select' });
  [['replace','Replace'],['append','Append'],['remove','Remove']].forEach(([v,l]) => {
    const opt = el('option', { value: v, textContent: l });
    if ((existing.operation || 'replace') === v) opt.selected = true;
    opSel.appendChild(opt);
  });
  fields.appendChild(_row('Operation', opSel));

  // JSON Path (replace/remove)
  const jpRow = el('div', { id: `rf-${prefix}-ip-jp-row` });
  jpRow.appendChild(_row('JSON Path', el('input', {
    type: 'text', id: `rf-${prefix}-ip-jsonpath`, className: 'rf-input',
    placeholder: '$.version  or  $.user.role', value: existing.jsonPath || '',
  })));
  fields.appendChild(jpRow);

  // Key (JSON append / Form field)
  const keyRow = el('div', { id: `rf-${prefix}-ip-key-row` });
  keyRow.appendChild(_row('Key / Field', el('input', {
    type: 'text', id: `rf-${prefix}-ip-key`, className: 'rf-input',
    placeholder: 'newField  or  username', value: existing.key || '',
  })));
  fields.appendChild(keyRow);

  // Find text (text replace/remove)
  const findRow = el('div', { id: `rf-${prefix}-ip-find-row` });
  findRow.appendChild(_row('Find Text', el('input', {
    type: 'text', id: `rf-${prefix}-ip-find`, className: 'rf-input',
    placeholder: 'text to find', value: existing.find || '',
  })));
  fields.appendChild(findRow);

  // Value (replace/append)
  const valRow = el('div', { id: `rf-${prefix}-ip-val-row` });
  const valLbl = el('label', { className: 'rf-label', id: `rf-${prefix}-ip-val-lbl`, textContent: 'New Value' });
  const valIn  = el('input', { type: 'text', id: `rf-${prefix}-ip-value`, className: 'rf-input',
    value: existing.value || '' });
  valRow.appendChild(valLbl); valRow.appendChild(valIn);
  fields.appendChild(valRow);

  // Hint line
  const hint = el('div', { id: `rf-${prefix}-ip-hint` });
  hint.style.cssText = 'font-size:11px;color:var(--c-subtle);margin-top:3px';
  fields.appendChild(hint);

  function refresh() {
    const ct = ctSel.value;
    const op = opSel.value;
    jpRow.style.display  = (ct === 'json' && (op === 'replace' || op === 'remove')) ? '' : 'none';
    keyRow.style.display = (ct === 'json' && op === 'append') || ct === 'form' ? '' : 'none';
    findRow.style.display = (ct === 'text' && (op === 'replace' || op === 'remove')) ? '' : 'none';
    valRow.style.display  = op !== 'remove' ? '' : 'none';

    // Dynamic label
    valLbl.textContent = ct === 'text' && op === 'append' ? 'Append Text'
      : ct === 'json' ? 'Value (JSON literal)' : 'Field Value';
    valIn.placeholder  = ct === 'json' ? '"v4"  or  42  or  true' : 'value';

    // Hint
    const hints = {
      json_replace: 'Sets $.path to the given JSON value. Creates missing nested objects.',
      json_append:  'Adds a new key to the root JSON object.',
      json_remove:  'Removes the key at $.path from the JSON body.',
      form_replace: 'Sets the form field (adds it if not present).',
      form_append:  'Adds a duplicate form field entry.',
      form_remove:  'Removes all entries for the field.',
      text_replace: 'Replaces ALL occurrences of the found text.',
      text_append:  'Appends text to the end of the body.',
      text_remove:  'Removes ALL occurrences of the found text.',
    };
    hint.textContent = hints[`${ct}_${op}`] || '';
  }

  ctSel.addEventListener('change', refresh);
  opSel.addEventListener('change', refresh);
  requestAnimationFrame(refresh);

  enableCb.addEventListener('change', () => {
    fields.style.display = enableCb.checked ? 'block' : 'none';
  });

  wrap.appendChild(fields);
  return wrap;
}

/** Collect injectPayload config from a prefixed section. */
function _collectPayloadSection(prefix) {
  return {
    enabled:     _checked(`rf-${prefix}-ip-enabled`),
    contentType: _val(`rf-${prefix}-ip-ct`)        || 'json',
    operation:   _val(`rf-${prefix}-ip-op`)        || 'replace',
    jsonPath:    _val(`rf-${prefix}-ip-jsonpath`)  || '',
    key:         _val(`rf-${prefix}-ip-key`)       || '',
    find:        _val(`rf-${prefix}-ip-find`)      || '',
    value:       _val(`rf-${prefix}-ip-value`)     || '',
  };
}

function _subRedirect() {
  const div = _actionSub(ACTION_TYPES.REDIRECT);
  div.appendChild(_row('Target Host', el('input', {
    type: 'text', id: 'rf-redirect-host', className: 'rf-input',
    placeholder: 'staging.hub.example.com', value: _editingRule?.action?.redirect?.targetHost || '',
  })));
  const preserveCb = el('input', { type: 'checkbox', id: 'rf-redirect-preserve', className: 'rf-checkbox' });
  preserveCb.checked = _editingRule?.action?.redirect?.preservePath !== false;
  div.appendChild(_row('Preserve Path', preserveCb));

  // Protocol override
  const protoSel = el('select', { id: 'rf-redirect-protocol', className: 'rf-select' });
  [
    { value: 'auto',  label: 'Auto — keep original protocol' },
    { value: 'http',  label: 'Force HTTP' },
    { value: 'https', label: 'Force HTTPS' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((_editingRule?.action?.redirect?.protocol || 'auto') === value) opt.selected = true;
    protoSel.appendChild(opt);
  });
  div.appendChild(_row('Protocol', protoSel));

  // Additional Headers
  const hdrsBar = el('div', { className: 'rf-row-between' });
  hdrsBar.style.marginTop = '10px';
  hdrsBar.appendChild(el('span', { className: 'rf-label', textContent: 'Additional Headers' }));
  const redirectHdrsList = el('div', { id: 'rf-redirect-headers-list', className: 'rf-kv-list' });
  hdrsBar.appendChild(el('button', {
    type: 'button', className: 'rf-small-btn', textContent: '+ Add',
    onClick: () => _appendKvRow(redirectHdrsList, '', ''),
  }));
  div.appendChild(hdrsBar);

  const hint = el('div');
  hint.style.cssText = 'font-size:11px;color:var(--c-subtle);margin-bottom:4px';
  hint.textContent = 'Override or add request headers sent to the redirected host (e.g. Authorization)';
  div.appendChild(hint);
  div.appendChild(redirectHdrsList);

  // Pre-populate
  const existingRedirectHdrs = _editingRule?.action?.redirect?.additionalHeaders || [];
  existingRedirectHdrs.forEach((h) => {
    _appendKvRow(redirectHdrsList, h.name || '', h.value || '');
  });

  // Inject Payload section
  div.appendChild(_buildPayloadSection('redir', _editingRule?.action?.redirect?.injectPayload));

  return div;
}

function _subRewrite() {
  const div = _actionSub(ACTION_TYPES.REWRITE);
  div.appendChild(_row('Pattern (regex)', el('input', {
    type: 'text', id: 'rf-rewrite-pattern', className: 'rf-input',
    placeholder: '/old-path/(.*)', value: _editingRule?.action?.rewrite?.pattern || '',
  })));
  div.appendChild(_row('Replacement', el('input', {
    type: 'text', id: 'rf-rewrite-replacement', className: 'rf-input',
    placeholder: '/new-path/$1', value: _editingRule?.action?.rewrite?.replacement || '',
  })));

  // Inject Payload section
  div.appendChild(_buildPayloadSection('rw', _editingRule?.action?.rewrite?.injectPayload));

  return div;
}

function _subMockInline() {
  const div = _actionSub(ACTION_TYPES.MOCK_INLINE);
  const mock = _editingRule?.action?.mockInline || {};

  div.appendChild(_row('Status Code', el('input', {
    type: 'number', id: 'rf-mock-status', className: 'rf-input rf-input-short',
    value: String(mock.statusCode ?? 200), min: '100', max: '599',
  })));

  // Response Headers
  const hdrsBar = el('div', { className: 'rf-row-between' });
  hdrsBar.appendChild(el('span', { className: 'rf-label', textContent: 'Response Headers' }));
  const mockHdrsList = el('div', { id: 'rf-mock-headers-list', className: 'rf-kv-list' });
  const addMockHdr = el('button', {
    type: 'button', className: 'rf-small-btn', textContent: '+ Add',
    onClick: () => _appendKvRow(mockHdrsList, '', ''),
  });
  hdrsBar.appendChild(addMockHdr);
  div.appendChild(hdrsBar);
  div.appendChild(mockHdrsList);
  for (const [k, v] of Object.entries(mock.headers || {})) _appendKvRow(mockHdrsList, k, v);

  // Body textarea
  div.appendChild(el('label', { className: 'rf-label rf-label-block', textContent: 'Response Body' }));
  const bodyArea = el('textarea', {
    id: 'rf-mock-body', className: 'rf-textarea', rows: '8', spellcheck: 'false',
  });
  bodyArea.value = mock.body ?? '{}';
  div.appendChild(bodyArea);

  const formatBtn = el('button', {
    type: 'button', className: 'rf-small-btn', textContent: 'Format JSON',
    onClick: () => {
      try {
        bodyArea.value = JSON.stringify(JSON.parse(bodyArea.value), null, 2);
      } catch (_) { alert('Invalid JSON'); }
    },
  });
  div.appendChild(formatBtn);
  return div;
}

function _subMockServer() {
  const div = _actionSub(ACTION_TYPES.MOCK_SERVER);
  const ms = _editingRule?.action?.mockServer || {};

  div.appendChild(_row('Server URL', el('input', {
    type: 'text', id: 'rf-ms-url', className: 'rf-input',
    placeholder: 'http://localhost:5000/proxy', value: ms.serverUrl || 'http://localhost:5000/proxy',
  })));

  const modeSelect = el('select', { id: 'rf-ms-mode', className: 'rf-select' });
  for (const [, val] of Object.entries(MOCK_SERVER_MODES)) {
    const opt = el('option', { value: val, textContent: val });
    if ((ms.mode || MOCK_SERVER_MODES.RESPONSE_ONLY) === val) opt.selected = true;
    modeSelect.appendChild(opt);
  }
  div.appendChild(_row('Mode', modeSelect));

  div.appendChild(_row('Step Tag', el('input', {
    type: 'text', id: 'rf-ms-tag', className: 'rf-input',
    placeholder: 'step_tag', value: ms.stepTag || '',
  })));

  // Inject Payload section
  div.appendChild(_buildPayloadSection('ms', _editingRule?.action?.mockServer?.injectPayload));

  return div;
}

function _subModifyHeaders() {
  const div = _actionSub(ACTION_TYPES.MODIFY_HEADERS);
  const hm = _editingRule?.action?.headerMods || {};
  const groups = [
    { id: 'add-req', label: 'Add Request Headers', data: hm.addRequest || [] },
    { id: 'remove-req', label: 'Remove Request Headers', data: hm.removeRequest || [] },
    { id: 'add-res', label: 'Add Response Headers', data: hm.addResponse || [] },
    { id: 'remove-res', label: 'Remove Response Headers', data: hm.removeResponse || [] },
  ];
  groups.forEach((g) => {
    const bar = el('div', { className: 'rf-row-between' });
    bar.appendChild(el('span', { className: 'rf-label', textContent: g.label }));
    const list = el('div', { id: `rf-hm-${g.id}`, className: 'rf-kv-list' });
    bar.appendChild(el('button', {
      type: 'button', className: 'rf-small-btn', textContent: '+ Add',
      onClick: () => _appendKvRow(list, '', ''),
    }));
    div.appendChild(bar);
    div.appendChild(list);
    (g.data || []).forEach((item) => {
      if (typeof item === 'object') _appendKvRow(list, item.name || item.key || '', item.value || '');
      else _appendKvRow(list, String(item), '');
    });
  });
  return div;
}

function _subDelay() {
  const div = _actionSub(ACTION_TYPES.DELAY);
  div.appendChild(_row('Delay (ms)', el('input', {
    type: 'number', id: 'rf-delay-ms', className: 'rf-input rf-input-short',
    value: String(_editingRule?.action?.delayMs ?? 0), min: '0',
  })));
  return div;
}

function _subBlock() {
  const div = _actionSub(ACTION_TYPES.BLOCK);
  div.appendChild(el('div', {
    className: 'rf-label rf-label-block',
    textContent: 'Matching requests will be blocked — no network call is made, a 0-status error is returned.',
    style: 'color:var(--c-warning);font-size:12px;padding:4px 0',
  }));
  div.appendChild(_row('Reason (optional)', el('input', {
    type: 'text', id: 'rf-block-reason', className: 'rf-input',
    placeholder: 'e.g. Not available in this environment',
    value: _editingRule?.action?.block?.reason || '',
  })));
  return div;
}

function _subModifyBody() {
  const div = _actionSub(ACTION_TYPES.MODIFY_BODY);

  const typeSelect = el('select', { id: 'rf-mbody-type', className: 'rf-select' });
  [
    { value: 'replace', label: 'String Replace' },
    { value: 'jsonpath', label: 'Set JSON Path' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((_editingRule?.action?.modifyBody?.type || 'replace') === value) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  div.appendChild(_row('Mode', typeSelect));

  // Replace mode fields
  const replaceFields = el('div', { id: 'rf-mbody-replace-fields' });
  replaceFields.appendChild(_row('Find', el('input', {
    type: 'text', id: 'rf-mbody-find', className: 'rf-input',
    placeholder: '"v3"', value: _editingRule?.action?.modifyBody?.find || '',
  })));
  replaceFields.appendChild(_row('Replace with', el('input', {
    type: 'text', id: 'rf-mbody-replace', className: 'rf-input',
    placeholder: '"v4"', value: _editingRule?.action?.modifyBody?.replace || '',
  })));

  // JSONPath mode fields
  const jsonpathFields = el('div', { id: 'rf-mbody-jsonpath-fields' });
  jsonpathFields.style.display = 'none';
  jsonpathFields.appendChild(_row('JSON Path', el('input', {
    type: 'text', id: 'rf-mbody-jsonpath', className: 'rf-input',
    placeholder: '$.version', value: _editingRule?.action?.modifyBody?.jsonPath || '',
  })));
  jsonpathFields.appendChild(_row('New Value', el('input', {
    type: 'text', id: 'rf-mbody-value', className: 'rf-input',
    placeholder: '"v4"', value: _editingRule?.action?.modifyBody?.value || '',
  })));

  const toggleFields = () => {
    const isReplace = typeSelect.value === 'replace';
    replaceFields.style.display = isReplace ? '' : 'none';
    jsonpathFields.style.display = isReplace ? 'none' : '';
  };
  typeSelect.addEventListener('change', toggleFields);
  requestAnimationFrame(toggleFields);

  div.appendChild(replaceFields);
  div.appendChild(jsonpathFields);
  return div;
}

function _subSetUserAgent() {
  const div = _actionSub(ACTION_TYPES.SET_USER_AGENT);

  div.appendChild(el('div', {
    style: 'font-size:11px;color:var(--c-warning);margin-bottom:8px',
    textContent: 'Note: Browsers block User-Agent via JS. For full UA override, use Modify Headers action with declarativeNetRequest instead.',
  }));

  const presetSelect = el('select', { id: 'rf-ua-preset', className: 'rf-select' });
  const currentPreset = _editingRule?.action?.setUserAgent?.preset || 'Chrome Mac';
  Object.keys(USER_AGENT_PRESETS).forEach((name) => {
    const opt = el('option', { value: name, textContent: name });
    if (currentPreset === name) opt.selected = true;
    presetSelect.appendChild(opt);
  });
  div.appendChild(_row('Preset', presetSelect));

  const customRow = el('div', { id: 'rf-ua-custom-row' });
  customRow.style.display = currentPreset === 'Custom' ? '' : 'none';
  customRow.appendChild(_row('Custom UA', el('textarea', {
    id: 'rf-ua-custom', className: 'rf-textarea', rows: '3',
    placeholder: 'Mozilla/5.0 ...',
  })));
  if (_editingRule?.action?.setUserAgent?.custom) {
    requestAnimationFrame(() => {
      const ta = div.querySelector('#rf-ua-custom');
      if (ta) ta.value = _editingRule.action.setUserAgent.custom;
    });
  }
  div.appendChild(customRow);

  presetSelect.addEventListener('change', () => {
    customRow.style.display = presetSelect.value === 'Custom' ? '' : 'none';
  });

  return div;
}

function _subGraphqlMock() {
  const div = _actionSub(ACTION_TYPES.GRAPHQL_MOCK);
  const cfg = _editingRule?.action?.graphqlMock || {};

  div.appendChild(el('div', {
    style: 'font-size:11px;color:var(--c-info);margin-bottom:8px',
    textContent: 'Matches POST requests containing a GraphQL body. The URL condition should match your GraphQL endpoint.',
  }));

  const opTypeSelect = el('select', { id: 'rf-gql-type', className: 'rf-select' });
  [
    { value: 'any', label: 'Any operation type' },
    { value: 'query', label: 'Query' },
    { value: 'mutation', label: 'Mutation' },
    { value: 'subscription', label: 'Subscription' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((cfg.operationType || 'any') === value) opt.selected = true;
    opTypeSelect.appendChild(opt);
  });
  div.appendChild(_row('Operation Type', opTypeSelect));
  div.appendChild(_row('Operation Name', el('input', {
    type: 'text', id: 'rf-gql-opname', className: 'rf-input',
    placeholder: 'GetFleetSummary (leave empty to match all)',
    value: cfg.operationName || '',
  })));

  const statusInput = el('input', {
    type: 'number', id: 'rf-gql-status', className: 'rf-input rf-input-short',
    min: '100', max: '599', value: String(cfg.statusCode || 200),
  });
  div.appendChild(_row('Status Code', statusInput));

  div.appendChild(el('label', { className: 'rf-label rf-label-block', textContent: 'Response Body (JSON)' }));
  const bodyArea = el('textarea', {
    id: 'rf-gql-body', className: 'rf-textarea', rows: '8', spellcheck: 'false',
  });
  bodyArea.value = cfg.body || '{"data":{}}';
  div.appendChild(bodyArea);

  const formatBtn = el('button', {
    type: 'button', className: 'rf-small-btn', textContent: 'Format JSON',
    onClick: () => {
      try { bodyArea.value = JSON.stringify(JSON.parse(bodyArea.value), null, 2); }
      catch(_) { alert('Invalid JSON'); }
    },
  });
  div.appendChild(formatBtn);
  return div;
}

function _subInjectScript() {
  const div = _actionSub(ACTION_TYPES.INJECT_SCRIPT);
  const cfg = _editingRule?.action?.injectScript || {};

  div.appendChild(el('div', {
    style: 'font-size:11px;color:var(--c-info);margin-bottom:8px',
    textContent: 'JavaScript code injected into pages matching the URL condition.',
  }));

  const runAtSelect = el('select', { id: 'rf-inject-runat', className: 'rf-select' });
  [
    { value: 'document_end', label: 'After page load (document_idle)' },
    { value: 'document_start', label: 'Before page load (document_start)' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((cfg.runAt || 'document_end') === value) opt.selected = true;
    runAtSelect.appendChild(opt);
  });
  div.appendChild(_row('Run At', runAtSelect));

  div.appendChild(el('label', { className: 'rf-label rf-label-block', textContent: 'JavaScript Code' }));
  const jsArea = el('textarea', {
    id: 'rf-inject-js', className: 'rf-textarea', rows: '10', spellcheck: 'false',
  });
  jsArea.style.fontFamily = 'SF Mono, Cascadia Code, Fira Code, Consolas, monospace';
  jsArea.style.fontSize = '12px';
  jsArea.value = cfg.code || '// Your JavaScript here\nconsole.log("Mocxy injected!");';
  div.appendChild(jsArea);

  return div;
}

function _subInjectCss() {
  const div = _actionSub(ACTION_TYPES.INJECT_CSS);
  const cfg = _editingRule?.action?.injectCss || {};

  div.appendChild(el('div', {
    style: 'font-size:11px;color:var(--c-info);margin-bottom:8px',
    textContent: 'CSS injected into pages matching the URL condition.',
  }));

  div.appendChild(el('label', { className: 'rf-label rf-label-block', textContent: 'CSS Code' }));
  const cssArea = el('textarea', {
    id: 'rf-inject-css', className: 'rf-textarea', rows: '10', spellcheck: 'false',
  });
  cssArea.style.fontFamily = 'SF Mono, Cascadia Code, Fira Code, Consolas, monospace';
  cssArea.style.fontSize = '12px';
  cssArea.value = cfg.code || '/* Your CSS here */\nbody { background: #000; }';
  div.appendChild(cssArea);

  return div;
}

function _subInjectPayload() {
  const div = _actionSub(ACTION_TYPES.INJECT_PAYLOAD);
  const cfg = _editingRule?.action?.injectPayload || {};

  div.appendChild(el('div', {
    style: 'font-size:11px;color:var(--c-info);margin-bottom:10px',
    textContent: 'Modifies the outgoing request body before it is sent.',
  }));

  // Content type
  const ctSel = el('select', { id: 'rf-ip-ct', className: 'rf-select' });
  [
    { value: 'json', label: 'JSON (application/json)' },
    { value: 'form', label: 'Form (application/x-www-form-urlencoded)' },
    { value: 'text', label: 'Text (text/plain)' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((cfg.contentType || 'json') === value) opt.selected = true;
    ctSel.appendChild(opt);
  });
  div.appendChild(_row('Content Type', ctSel));

  // Operation
  const opSel = el('select', { id: 'rf-ip-op', className: 'rf-select' });
  [
    { value: 'replace', label: 'Replace — set / overwrite a value' },
    { value: 'append',  label: 'Append — add new key or text' },
    { value: 'remove',  label: 'Remove — delete a key or substring' },
  ].forEach(({ value, label }) => {
    const opt = el('option', { value, textContent: label });
    if ((cfg.operation || 'replace') === value) opt.selected = true;
    opSel.appendChild(opt);
  });
  div.appendChild(_row('Operation', opSel));

  // ── Dynamic fields (shown/hidden based on contentType + operation) ──

  // JSON: path for replace/remove
  const jsonPathRow = el('div', { id: 'rf-ip-jsonpath-row' });
  jsonPathRow.appendChild(_row('JSON Path', el('input', {
    type: 'text', id: 'rf-ip-jsonpath', className: 'rf-input',
    placeholder: '$.version  or  $.user.role',
    value: cfg.jsonPath || '',
  })));
  div.appendChild(jsonPathRow);

  // JSON: key for append
  const jsonKeyRow = el('div', { id: 'rf-ip-jsonkey-row' });
  jsonKeyRow.appendChild(_row('New Key', el('input', {
    type: 'text', id: 'rf-ip-key', className: 'rf-input',
    placeholder: 'newField',
    value: cfg.key || '',
  })));
  div.appendChild(jsonKeyRow);

  // Form: field name (replace / append / remove)
  const formKeyRow = el('div', { id: 'rf-ip-formkey-row' });
  formKeyRow.appendChild(_row('Field Name', el('input', {
    type: 'text', id: 'rf-ip-formkey', className: 'rf-input',
    placeholder: 'username',
    value: cfg.key || '',
  })));
  div.appendChild(formKeyRow);

  // Text: find string (replace / remove)
  const textFindRow = el('div', { id: 'rf-ip-find-row' });
  textFindRow.appendChild(_row('Find Text', el('input', {
    type: 'text', id: 'rf-ip-find', className: 'rf-input',
    placeholder: 'old string',
    value: cfg.find || '',
  })));
  div.appendChild(textFindRow);

  // Value field (replace + append) — used for JSON value, form value, and text replace/append
  const valueRow = el('div', { id: 'rf-ip-value-row' });
  const valueLabel = el('label', { className: 'rf-label', id: 'rf-ip-value-label', textContent: 'New Value' });
  const valueHint  = el('span', { id: 'rf-ip-value-hint', style: 'font-size:10px;color:var(--c-subtle);margin-left:6px' });
  const valueIn    = el('input', {
    type: 'text', id: 'rf-ip-value', className: 'rf-input',
    value: cfg.value || '',
  });
  const labelRow = el('div', { style: 'display:flex;align-items:center;margin-bottom:4px' });
  labelRow.appendChild(valueLabel);
  labelRow.appendChild(valueHint);
  valueRow.appendChild(labelRow);
  valueRow.appendChild(valueIn);
  div.appendChild(valueRow);

  // Hint line
  const hintEl = el('div', { id: 'rf-ip-hint', style: 'font-size:11px;color:var(--c-subtle);margin-top:4px' });
  div.appendChild(hintEl);

  // Update visible fields based on contentType + operation
  function updateFields() {
    const ct = ctSel.value;
    const op = opSel.value;

    jsonPathRow.style.display = (ct === 'json' && (op === 'replace' || op === 'remove')) ? '' : 'none';
    jsonKeyRow.style.display  = (ct === 'json' && op === 'append') ? '' : 'none';
    formKeyRow.style.display  = (ct === 'form') ? '' : 'none';
    textFindRow.style.display = (ct === 'text' && (op === 'replace' || op === 'remove')) ? '' : 'none';
    valueRow.style.display    = (op !== 'remove') ? '' : 'none';

    // Update value label + hint
    if (ct === 'json') {
      valueLabel.textContent = op === 'append' ? 'Value (JSON literal)' : 'New Value (JSON literal)';
      valueHint.textContent  = '— strings need quotes: "v4"  numbers: 42  bool: true';
      valueIn.placeholder    = op === 'append' ? '"newValue"' : '"v4"';
    } else if (ct === 'form') {
      valueLabel.textContent = 'Field Value';
      valueHint.textContent  = '';
      valueIn.placeholder    = 'fieldValue';
    } else {
      valueLabel.textContent = op === 'append' ? 'Text to Append' : 'Replace With';
      valueHint.textContent  = '';
      valueIn.placeholder    = op === 'append' ? 'appended text' : 'new string';
    }

    // Hint
    if (ct === 'json' && op === 'replace') hintEl.textContent = 'Sets the value at the given JSON path. Nested paths are created if missing.';
    else if (ct === 'json' && op === 'append') hintEl.textContent = 'Adds a new key to the root JSON object.';
    else if (ct === 'json' && op === 'remove') hintEl.textContent = 'Removes the key at the given JSON path.';
    else if (ct === 'form' && op === 'replace') hintEl.textContent = 'Updates the field if it exists, adds it if not.';
    else if (ct === 'form' && op === 'append') hintEl.textContent = 'Adds a duplicate field entry (multiple values).';
    else if (ct === 'form' && op === 'remove') hintEl.textContent = 'Removes all entries for the given field name.';
    else if (ct === 'text' && op === 'replace') hintEl.textContent = 'Replaces ALL occurrences of the found text.';
    else if (ct === 'text' && op === 'append') hintEl.textContent = 'Appends text to the end of the body.';
    else if (ct === 'text' && op === 'remove') hintEl.textContent = 'Removes ALL occurrences of the found text.';
    else hintEl.textContent = '';
  }

  ctSel.addEventListener('change', updateFields);
  opSel.addEventListener('change', updateFields);
  requestAnimationFrame(updateFields);

  return div;
}

/* ----- Footer ----- */

function _buildFooter() {
  const footer = el('div', { className: 'rf-footer' });
  footer.appendChild(el('button', {
    type: 'button', className: 'rf-btn rf-btn-secondary', textContent: 'Cancel',
    onClick: () => { close(); if (_callbacks?.onCancel) _callbacks.onCancel(); },
  }));
  footer.appendChild(el('button', {
    type: 'button', className: 'rf-btn rf-btn-primary', textContent: 'Save Rule',
    onClick: _handleSave,
  }));
  return footer;
}

/* -------------------------------------------------------------------------- */
/*  DOM helpers                                                               */
/* -------------------------------------------------------------------------- */

function _row(label, inputEl) {
  const row = el('div', { className: 'rf-field-row' });
  row.appendChild(el('label', { className: 'rf-label', textContent: label }));
  row.appendChild(inputEl);
  return row;
}

function _appendKvRow(container, key, value) {
  const row = el('div', { className: 'rf-kv-row' });
  row.appendChild(el('input', {
    type: 'text', className: 'rf-input rf-kv-key', placeholder: 'Key', value: key, style: 'flex:1',
  }));
  row.appendChild(el('input', {
    type: 'text', className: 'rf-input rf-kv-value', placeholder: 'Value', value: value, style: 'flex:1',
  }));
  row.appendChild(el('button', {
    type: 'button', className: 'rf-small-btn rf-remove-btn', textContent: '\u2715',
    onClick: () => row.remove(),
  }));
  container.appendChild(row);
}

function _val(id) {
  const el = _container.querySelector(`#${id}`);
  return el ? el.value : '';
}
function _checked(id) {
  const el = _container.querySelector(`#${id}`);
  return el ? el.checked : false;
}

function _collectKvAsObject(containerId) {
  const c = _container.querySelector(`#${containerId}`);
  if (!c) return {};
  const obj = {};
  c.querySelectorAll('.rf-kv-row').forEach((row) => {
    const k = row.querySelector('.rf-kv-key')?.value?.trim();
    const v = row.querySelector('.rf-kv-value')?.value || '';
    if (k) obj[k] = v;
  });
  return obj;
}

function _collectKvAsArray(containerId) {
  const c = _container.querySelector(`#${containerId}`);
  if (!c) return [];
  return Array.from(c.querySelectorAll('.rf-kv-row'))
    .map((row) => ({
      name: row.querySelector('.rf-kv-key')?.value?.trim() || '',
      value: row.querySelector('.rf-kv-value')?.value || '',
    }))
    .filter((i) => i.name);
}

/* -------------------------------------------------------------------------- */
/*  Collect + Validate + Save                                                 */
/* -------------------------------------------------------------------------- */

function _collectRule() {
  const rule = _defaultRule();
  if (_editingRule?.id) rule.id = _editingRule.id;

  rule.name = _val('rf-name');
  rule.priority = parseInt(_val('rf-priority'), 10) || 0;
  rule.enabled = _checked('rf-enabled');

  rule.condition.url.type = _val('rf-url-type');
  rule.condition.url.value = _val('rf-url-value');
  rule.condition.methods = Array.from(_container.querySelectorAll('.rf-method-cb:checked')).map((cb) => cb.value);
  rule.condition.headers = Array.from(_container.querySelectorAll('#rf-headers-list .rf-hdr-row')).map((row) => ({
    name: row.querySelector('.rf-hdr-name')?.value || '',
    type: row.querySelector('.rf-hdr-type')?.value || HEADER_MATCH_TYPES.EQUALS,
    value: row.querySelector('.rf-hdr-value')?.value || '',
  })).filter((h) => h.name);

  // Payload condition
  rule.condition.payload = {
    enabled: _checked('rf-payload-enabled'),
    type: _val('rf-payload-type') || 'contains',
    expression: _val('rf-payload-expression') || '',
  };

  rule.action.type = _val('rf-action-type');
  rule.action.redirect.targetHost        = _val('rf-redirect-host');
  rule.action.redirect.preservePath      = _checked('rf-redirect-preserve');
  rule.action.redirect.protocol          = _val('rf-redirect-protocol') || 'auto';
  rule.action.redirect.additionalHeaders = _collectKvAsArray('rf-redirect-headers-list');
  rule.action.redirect.injectPayload     = _collectPayloadSection('redir');

  rule.action.rewrite.pattern        = _val('rf-rewrite-pattern');
  rule.action.rewrite.replacement    = _val('rf-rewrite-replacement');
  rule.action.rewrite.injectPayload  = _collectPayloadSection('rw');
  rule.action.mockInline.statusCode = parseInt(_val('rf-mock-status'), 10) || 200;
  rule.action.mockInline.headers = _collectKvAsObject('rf-mock-headers-list');
  rule.action.mockInline.body = _val('rf-mock-body') || '{}';
  rule.action.mockServer.serverUrl      = _val('rf-ms-url') || 'http://localhost:5000/proxy';
  rule.action.mockServer.mode           = _val('rf-ms-mode') || MOCK_SERVER_MODES.RESPONSE_ONLY;
  rule.action.mockServer.stepTag        = _val('rf-ms-tag');
  rule.action.mockServer.injectPayload  = _collectPayloadSection('ms');
  rule.action.headerMods.addRequest = _collectKvAsArray('rf-hm-add-req');
  rule.action.headerMods.removeRequest = _collectKvAsArray('rf-hm-remove-req');
  rule.action.headerMods.addResponse = _collectKvAsArray('rf-hm-add-res');
  rule.action.headerMods.removeResponse = _collectKvAsArray('rf-hm-remove-res');
  rule.action.delayMs = parseInt(_val('rf-delay-ms'), 10) || 0;
  rule.action.block = { reason: _val('rf-block-reason') };
  rule.action.modifyBody = {
    type: _val('rf-mbody-type') || 'replace',
    find: _val('rf-mbody-find'),
    replace: _val('rf-mbody-replace'),
    jsonPath: _val('rf-mbody-jsonpath'),
    value: _val('rf-mbody-value'),
  };
  rule.action.setUserAgent = {
    preset: _val('rf-ua-preset') || 'Chrome Mac',
    custom: _val('rf-ua-custom') || '',
  };

  // GraphQL condition
  rule.condition.graphql = {
    enabled: _checked('rf-gql-enabled'),
    operationType: _val('rf-gql-cond-type') || 'any',
    operationName: _val('rf-gql-cond-opname') || '',
  };

  // GraphQL mock action
  rule.action.graphqlMock = {
    operationType: _val('rf-gql-type') || 'any',
    operationName: _val('rf-gql-opname') || '',
    statusCode: parseInt(_val('rf-gql-status'), 10) || 200,
    body: _val('rf-gql-body') || '{"data":{}}',
  };

  rule.action.injectScript = {
    code: _val('rf-inject-js') || '',
    runAt: _val('rf-inject-runat') || 'document_end',
  };
  rule.action.injectCss = {
    code: _val('rf-inject-css') || '',
  };

  rule.action.injectPayload = {
    contentType: _val('rf-ip-ct')       || 'json',
    operation:   _val('rf-ip-op')       || 'replace',
    jsonPath:    _val('rf-ip-jsonpath') || '',
    key:         _val('rf-ip-key')      || _val('rf-ip-formkey') || '',
    value:       _val('rf-ip-value')    || '',
    find:        _val('rf-ip-find')     || '',
  };

  return rule;
}

function _validate(rule) {
  if (!rule.name.trim()) return 'Rule name is required.';
  if (!rule.condition.url.value.trim() && rule.action.type !== ACTION_TYPES.MODIFY_HEADERS)
    return 'URL pattern is required for this action type.';
  return null;
}

function _handleSave() {
  const rule = _collectRule();
  const error = _validate(rule);
  if (error) { alert(error); return; }
  close();
  if (_callbacks?.onSave) _callbacks.onSave(rule);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

function open(rule) {
  _editingRule = rule || null;
  if (!_container) return;

  _container.classList.remove('hidden');
  _container.innerHTML = '';
  _container.style.display = 'flex';

  const panel = el('div', { className: 'rf-panel' });
  panel.appendChild(_buildForm());
  _container.appendChild(panel);

  // Backdrop close
  _container.addEventListener('click', (e) => {
    if (e.target === _container) { close(); if (_callbacks?.onCancel) _callbacks.onCancel(); }
  });

  const currentType = _editingRule?.action?.type || ACTION_TYPES.REDIRECT;
  _toggleSub(currentType);
}

function close() {
  if (!_container) return;
  _container.innerHTML = '';
  _container.style.display = 'none';
  _container.classList.add('hidden');
  _editingRule = null;
}

/* -------------------------------------------------------------------------- */
/*  Injected styles (Catppuccin Mocha)                                       */
/* -------------------------------------------------------------------------- */

function _injectStyles() {
  if (document.getElementById('rf-styles')) return;
  const style = document.createElement('style');
  style.id = 'rf-styles';
  style.textContent = `
/* Rule Form — Overlay */
#ruleFormContainer {
  position: fixed; inset: 0; z-index: 10000;
  align-items: center; justify-content: center;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(3px);
}

.rf-panel {
  width: 680px; max-width: 95vw; max-height: 90vh;
  overflow-y: auto; border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  scrollbar-width: thin;
  scrollbar-color: var(--c-border) transparent;
}

.rf-form {
  display: flex; flex-direction: column; gap: 16px;
  padding: 24px;
  background: var(--c-bg);
  border-radius: 10px;
  color: var(--c-text);
}

.rf-title {
  margin: 0; font-size: 18px; font-weight: 700; color: var(--c-text);
}

/* Section */
.rf-section {
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 0;
}

.rf-legend {
  font-size: 12px; font-weight: 700; color: var(--c-accent);
  padding: 0 6px; text-transform: uppercase; letter-spacing: 0.04em;
}

.rf-sub-legend {
  font-size: 11px; font-weight: 600; color: var(--c-muted);
  padding: 0 4px;
}

/* Field row */
.rf-field-row {
  display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
}

.rf-label {
  font-size: 12px; color: var(--c-muted); min-width: 100px; flex-shrink: 0;
}
.rf-label-block { display: block; margin-bottom: 4px; }

/* Inputs */
.rf-input {
  background: var(--c-surface2); border: 1px solid var(--c-border); border-radius: 5px;
  color: var(--c-text); font-size: 13px; padding: 7px 10px;
  outline: none; transition: border-color 0.2s; box-sizing: border-box;
}
.rf-input:focus { border-color: var(--c-accent); }
.rf-input::placeholder { color: var(--c-subtle); }
.rf-input-short { width: 100px; }

.rf-select {
  background: var(--c-surface2); border: 1px solid var(--c-border); border-radius: 5px;
  color: var(--c-text); font-size: 13px; padding: 7px 10px;
  outline: none; cursor: pointer; transition: border-color 0.2s;
}
.rf-select:focus { border-color: var(--c-accent); }

.rf-checkbox { accent-color: var(--c-accent); cursor: pointer; }

.rf-textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 5px;
  background: var(--c-surface); color: var(--c-text);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px; line-height: 1.5; resize: vertical;
  box-sizing: border-box; outline: none;
}
.rf-textarea:focus { border-color: var(--c-accent); }

/* URL row */
.rf-url-row {
  display: flex; gap: 8px; align-items: center; margin-bottom: 8px;
}

/* Methods */
.rf-methods-box {
  border: 1px solid var(--c-border); border-radius: 6px;
  padding: 8px 12px; margin: 8px 0 0;
}
.rf-methods-grid { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.rf-cb-label {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--c-text); cursor: pointer;
}
.rf-cb-label input { accent-color: var(--c-accent); }

/* Headers */
.rf-headers-wrap { margin-top: 8px; }

/* Payload */
.rf-payload-wrap { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--c-border); }
.rf-payload-hint { margin-top: 4px; }
.rf-payload-hint code { background: var(--c-surface2); padding: 1px 4px; border-radius: 3px; font-size: 10px; color: var(--c-info); }
.rf-row-between {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.rf-kv-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.rf-hdr-row, .rf-kv-row { display: flex; gap: 6px; align-items: center; }

/* Small buttons */
.rf-small-btn {
  padding: 3px 10px; border: 1px solid var(--c-border); border-radius: 4px;
  background: transparent; color: var(--c-accent); cursor: pointer;
  font-size: 11px; transition: background 0.12s;
}
.rf-small-btn:hover { background: var(--c-surface2); }
.rf-remove-btn { color: var(--c-error); }
.rf-remove-btn:hover { background: rgba(244,135,113,0.15); border-color: var(--c-error); }

/* Action sub */
.rf-action-sub { margin-top: 10px; }

/* Footer */
.rf-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding-top: 14px; border-top: 1px solid var(--c-border);
}

.rf-btn {
  padding: 8px 22px; border: none; border-radius: 6px;
  cursor: pointer; font-weight: 600; font-size: 13px;
  transition: background 0.15s;
}
.rf-btn-primary { background: var(--c-accent); color: var(--c-accent-text); }
.rf-btn-primary:hover { background: var(--c-accent-h); }
.rf-btn-secondary { background: transparent; border: 1px solid var(--c-border); color: var(--c-muted); }
.rf-btn-secondary:hover { background: var(--c-surface3); color: var(--c-text); }
`;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/*  Init                                                                      */
/* -------------------------------------------------------------------------- */

export function initRuleForm(container, { onSave, onCancel } = {}) {
  _container = container;
  _callbacks = { onSave, onCancel };
  _container.style.display = 'none';
  _injectStyles();
  return { open, close };
}
