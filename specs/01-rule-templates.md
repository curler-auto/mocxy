# Feature 1.1: Rule Templates

## Summary

Add a "Templates" dropdown to the rule list toolbar that lets users create rules from common patterns with one click.

## Why

New users don't know what rules look like. Templates give them a working starting point instead of building from scratch.

## Codebase Context

The extension uses a Manifest V3 Chrome Extension architecture with ES modules. All source lives under `health_check/utils/neuron-interceptor-plugin/`. Key facts:

- **Theme**: Catppuccin Mocha dark palette. CSS variables are defined in `options/options.css` under `:root` (e.g. `--bg-overlay: #181825`, `--border: #45475a`, `--surface-hover: #3b3f58`, `--text: #cdd6f4`, `--text-muted: #a6adc8`, `--accent: #89b4fa`).
- **Rule data shape**: Defined in `shared/data-models.js` via `createRule()`. Every rule has: `{ id, name, enabled, priority, condition: { url: { type, value }, headers: [], methods: [] }, action: { type, redirect: {...}, rewrite: {...}, mockInline: {...}, mockServer: {...}, headerMods: {...}, delayMs } }`.
- **Action types** (from `shared/constants.js`): `redirect`, `rewrite`, `mock_inline`, `mock_server`, `modify_headers`, `delay`.
- **Mock server modes**: `REQUEST_ONLY`, `RESPONSE_ONLY`, `PASSTHROUGH`.
- **URL match types**: `equals`, `contains`, `regex`, `glob`.
- **Rule list component** (`options/components/rule-list.js`): Exports `initRuleList(container, { onEdit, onRefresh })` which returns `{ refresh }`. The `onEdit` callback is called with a rule object (or `null` for new). Internally it has module-scoped `_rules`, `_callbacks`, and renders via `render()` -> `renderToolbar()` + `renderList()`.
- **Rule form component** (`options/components/rule-form.js`): Exports `initRuleForm(container, { onSave, onCancel })` which returns `{ open, close }`. Calling `open(rule)` with a pre-populated rule object opens the form with fields pre-filled. Calling `open(null)` opens an empty new-rule form.
- **Wiring** (in `options/options.js`): `ruleList` is initialized with `onEdit: (rule) => ruleForm.open(rule)`. So calling `_callbacks.onEdit(someRule)` from rule-list.js opens the rule form pre-populated.
- **ID generation**: `rule-list.js` has its own local `_generateId()` function using `crypto.randomUUID()` with fallback.

## Files to Modify

1. **`shared/constants.js`** -- Add `RULE_TEMPLATES` array constant.
2. **`options/components/rule-list.js`** -- Import `RULE_TEMPLATES`, add a Templates dropdown button to the toolbar, inject dropdown CSS.

No changes needed to `rule-form.js`, `options.js`, or `data-models.js`.

## Implementation

### Step 1: Add RULE_TEMPLATES to `shared/constants.js`

At the end of the file (after `export const LOG_TAG = '[Neuron]';`), add:

```javascript
/** Pre-built rule templates for common interception patterns. */
export const RULE_TEMPLATES = [
  {
    name: 'Redirect to Staging',
    description: 'Redirect all API calls from production to staging host',
    rule: {
      name: 'Redirect to Staging',
      enabled: true,
      priority: 10,
      condition: { url: { type: 'contains', value: '/api/' }, headers: [], methods: [] },
      action: {
        type: 'redirect',
        redirect: { targetHost: 'staging.example.com', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    },
  },
  {
    name: 'Mock 200 JSON Response',
    description: 'Return a static JSON response for matching URLs',
    rule: {
      name: 'Mock Response',
      enabled: true,
      priority: 10,
      condition: { url: { type: 'contains', value: '/api/endpoint' }, headers: [], methods: [] },
      action: {
        type: 'mock_inline',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"message": "mocked"}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    },
  },
  {
    name: 'Mock 500 Error',
    description: 'Simulate a server error for testing error handling',
    rule: {
      name: 'Mock Server Error',
      enabled: true,
      priority: 10,
      condition: { url: { type: 'contains', value: '/api/endpoint' }, headers: [], methods: [] },
      action: {
        type: 'mock_inline',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: '{"error": "Internal Server Error"}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    },
  },
  {
    name: 'Add Auth Header',
    description: 'Add an Authorization header to all API requests',
    rule: {
      name: 'Add Auth Header',
      enabled: true,
      priority: 5,
      condition: { url: { type: 'contains', value: '/api/' }, headers: [], methods: [] },
      action: {
        type: 'modify_headers',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: {
          addRequest: [{ name: 'Authorization', value: 'Bearer YOUR_TOKEN_HERE' }],
          removeRequest: [],
          addResponse: [],
          removeResponse: [],
        },
        delayMs: 0,
      },
    },
  },
  {
    name: 'Add CORS Headers',
    description: 'Add permissive CORS response headers',
    rule: {
      name: 'CORS Headers',
      enabled: true,
      priority: 5,
      condition: { url: { type: 'contains', value: '/api/' }, headers: [], methods: [] },
      action: {
        type: 'modify_headers',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: {
          addRequest: [],
          removeRequest: [],
          addResponse: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: '*' },
          ],
          removeResponse: [],
        },
        delayMs: 0,
      },
    },
  },
  {
    name: 'Slow Network (2s Delay)',
    description: 'Add a 2-second delay to simulate slow network',
    rule: {
      name: 'Slow Network',
      enabled: true,
      priority: 1,
      condition: { url: { type: 'contains', value: '/api/' }, headers: [], methods: [] },
      action: {
        type: 'delay',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 2000,
      },
    },
  },
  {
    name: 'Proxy to Flask Mock Server',
    description: 'Route requests through the local Flask proxy for capture/mock',
    rule: {
      name: 'Flask Proxy',
      enabled: true,
      priority: 10,
      condition: { url: { type: 'contains', value: '/neuron-api/' }, headers: [], methods: [] },
      action: {
        type: 'mock_server',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: 'test' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    },
  },
];
```

**Important**: Each template's `rule.action` object must include ALL sub-fields (redirect, rewrite, mockInline, mockServer, headerMods, delayMs) with defaults, even if only one action type is active. This matches the shape returned by `_defaultRule()` in `rule-form.js` and `createRule()` in `data-models.js`. The form will read whichever sub-fields correspond to the selected `action.type`.

### Step 2: Modify `options/components/rule-list.js`

#### 2a. Add import

At the top of the file, change:

```javascript
import { MSG_TYPES } from '../../shared/constants.js';
```

to:

```javascript
import { MSG_TYPES, RULE_TEMPLATES } from '../../shared/constants.js';
```

#### 2b. Add Templates dropdown to `renderToolbar()`

The existing `renderToolbar()` function (around line 151) creates a toolbar div, appends `addBtn` and `search`. After the `addBtn` is created but before it is appended to the toolbar, add the templates dropdown.

Replace the entire `renderToolbar()` function body with:

```javascript
function renderToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'ni-rule-toolbar';
  toolbar.style.cssText =
    'display:flex; align-items:center; gap:12px; margin-bottom:16px;';

  // Add Rule button
  const addBtn = document.createElement('button');
  addBtn.className = 'ni-btn ni-btn-primary ni-add-rule-btn';
  addBtn.textContent = '+ Add Rule';
  addBtn.style.cssText = `
    padding:8px 16px; border:none; border-radius:6px; cursor:pointer;
    background:#3b82f6; color:#fff; font-weight:600; font-size:13px;
    white-space:nowrap;
  `;
  addBtn.addEventListener('click', () => {
    if (_callbacks && _callbacks.onEdit) _callbacks.onEdit(null);
  });

  // Templates dropdown
  const templatesDropdown = _buildTemplatesDropdown();

  // Search input
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search rules\u2026';
  search.className = 'ni-rule-search';
  search.style.cssText = `
    flex:1; padding:8px 12px; border:1px solid #374151; border-radius:6px;
    background:#1f2937; color:#e5e7eb; font-size:13px; outline:none;
  `;
  search.value = _searchTerm;
  search.addEventListener('input', (e) => {
    _searchTerm = e.target.value;
    renderList();
  });

  toolbar.appendChild(addBtn);
  toolbar.appendChild(templatesDropdown);
  toolbar.appendChild(search);
  return toolbar;
}
```

#### 2c. Add `_buildTemplatesDropdown()` function

Add this new function before `renderToolbar()` (or anywhere in the file after the internal state declarations):

```javascript
/**
 * Build the Templates dropdown button + menu.
 * @returns {HTMLElement}
 */
function _buildTemplatesDropdown() {
  const wrapper = document.createElement('div');
  wrapper.className = 'ni-templates-dropdown';
  wrapper.style.cssText = 'position:relative; display:inline-block;';

  // Trigger button
  const btn = document.createElement('button');
  btn.className = 'ni-btn ni-btn-secondary ni-templates-btn';
  btn.innerHTML = 'Templates &#9662;';
  btn.style.cssText = `
    padding:8px 14px; border:1px solid #374151; border-radius:6px; cursor:pointer;
    background:transparent; color:#d1d5db; font-weight:600; font-size:13px;
    white-space:nowrap; transition:background .12s;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.background = '#374151'; });
  btn.addEventListener('mouseleave', () => {
    if (!menu.style.display || menu.style.display === 'none') {
      btn.style.background = 'transparent';
    }
  });

  // Dropdown menu
  const menu = document.createElement('div');
  menu.className = 'ni-templates-menu';
  menu.style.cssText = `
    display:none; position:absolute; top:calc(100% + 4px); left:0; z-index:100;
    min-width:320px; background:#181825; border:1px solid #45475a; border-radius:8px;
    box-shadow:0 8px 24px rgba(0,0,0,0.4); padding:4px 0;
    max-height:400px; overflow-y:auto;
  `;

  // Populate menu items from RULE_TEMPLATES
  RULE_TEMPLATES.forEach((template) => {
    const item = document.createElement('div');
    item.className = 'ni-templates-menu-item';
    item.style.cssText = `
      padding:10px 16px; cursor:pointer;
      border-bottom:1px solid #313244; transition:background .12s;
    `;

    const nameEl = document.createElement('div');
    nameEl.className = 'ni-templates-item-name';
    nameEl.textContent = template.name;
    nameEl.style.cssText = 'font-weight:600; color:#cdd6f4; font-size:13px;';

    const descEl = document.createElement('div');
    descEl.className = 'ni-templates-item-desc';
    descEl.textContent = template.description;
    descEl.style.cssText = 'font-size:12px; color:#a6adc8; margin-top:2px;';

    item.appendChild(nameEl);
    item.appendChild(descEl);

    item.addEventListener('mouseenter', () => { item.style.background = '#3b3f58'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });

    item.addEventListener('click', () => {
      // Deep-clone template rule and assign a new ID
      const newRule = JSON.parse(JSON.stringify(template.rule));
      newRule.id = _generateId();
      // Open the rule form pre-populated with this template
      if (_callbacks && _callbacks.onEdit) _callbacks.onEdit(newRule);
      // Close the dropdown
      menu.style.display = 'none';
    });

    menu.appendChild(item);
  });

  // Remove border-bottom from last item
  if (menu.lastChild) {
    menu.lastChild.style.borderBottom = 'none';
  }

  // Toggle menu on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      menu.style.display = 'none';
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);
  return wrapper;
}
```

Note: `_generateId()` is already defined in `rule-list.js` (around line 464). It uses `crypto.randomUUID()` with a fallback. No new ID helper is needed.

### Step 3: Inject additional CSS for the dropdown

The file already has an `_injectStyles()` function (around line 476) that appends a `<style id="ni-rule-list-styles">` tag. Append the following CSS rules inside the existing `style.textContent` template literal, before the closing backtick:

```css
    /* Templates dropdown */
    .ni-templates-menu::-webkit-scrollbar {
      width: 6px;
    }
    .ni-templates-menu::-webkit-scrollbar-thumb {
      background: #45475a;
      border-radius: 3px;
    }
```

The bulk of the dropdown styling is inline (set in `_buildTemplatesDropdown`), so only scrollbar styles need injection.

## How the Flow Works

1. User clicks "Templates" button in the rule list toolbar.
2. A dropdown appears listing 7 templates with name + description.
3. User clicks a template (e.g., "Mock 200 JSON Response").
4. `_buildTemplatesDropdown()` deep-clones the template's `rule` object, assigns a fresh UUID via `_generateId()`.
5. It calls `_callbacks.onEdit(newRule)` -- which is wired in `options.js` to `ruleForm.open(rule)`.
6. The rule form opens as a modal overlay, pre-populated with all the template values (name, URL pattern, action type, mock body, etc.).
7. The user tweaks the values as needed and clicks "Save".
8. The existing `onSave` handler in `options.js` persists the rule to storage and refreshes the list.

## Verification

1. Open the extension Options page (right-click extension icon -> "Options").
2. Confirm the Rules section is visible with a toolbar containing: `[+ Add Rule]  [Templates v]  [Search...]`.
3. Click "Templates" -- a dropdown menu appears with 7 items.
4. Click "Redirect to Staging" -- the rule form modal opens with:
   - Name: "Redirect to Staging"
   - URL condition: contains "/api/"
   - Action type: redirect
   - Target Host: "staging.example.com"
   - Preserve Path: checked
5. Change the target host to "staging.myapp.com" and click "Save".
6. The rule appears in the rule list with the name "Redirect to Staging" and a blue "redirect" badge.
7. Click "Templates" again, click "Mock 200 JSON Response":
   - Name: "Mock Response"
   - Action type: mock inline
   - Status Code: 200
   - Body: `{"message": "mocked"}`
8. Click "Templates" again, click "Proxy to Flask Mock Server":
   - Action type: mock server
   - Server URL: "http://localhost:5000/proxy"
   - Mode: RESPONSE_ONLY
   - Step Tag: "test"
9. Click outside the dropdown -- it closes.
10. Press Escape while dropdown is open -- verify the modal (if open) closes properly and doesn't interfere.
