# Feature 1.4: Test Rule (Dry-Run)

## Summary

Add a collapsible "Test This Rule" panel at the bottom of the rule form that lets users enter a sample URL, method, and headers, then click "Run Test" to see whether the current rule configuration would match -- and if so, what action would be taken -- without saving or applying the rule.

## Why

When building complex rules (regex URL patterns, multiple header conditions, specific methods), users need a way to verify their rule will match the requests they expect. Without a dry-run, the only option is to save, reload the page, trigger a real request, and check the logs.

## Codebase Context

The extension uses a Manifest V3 Chrome Extension architecture with ES modules. All source lives under `health_check/utils/neuron-interceptor-plugin/`. Key facts:

- **Rule form component** (`options/components/rule-form.js`):
  - Exports `initRuleForm(container, { onSave, onCancel })` returning `{ open, close }`.
  - Internally builds the form via `_buildForm()` (line 88), which creates sections: `_buildBasicSection()`, `_buildConditionsSection()`, `_buildActionSection()`, `_buildFooter()`, and appends them to a `<form class="ni-rule-form">`.
  - `_collectRule()` (line 619) reads all form inputs and assembles a complete rule object from the current form state. It returns the same shape as `createRule()` from `data-models.js`. This is the function to call for getting the "current rule without saving".
  - `_container` is the module-level reference to the modal overlay element.
  - Matching logic is NOT in this file -- it lives in `content/interceptor-inject.js` (for content-script context) and `service-worker/rule-engine.js` (for background context).
  - URL match types: `equals`, `contains`, `regex`, `glob`.
  - The form uses inline styles heavily. CSS variables from `options.css` are available: `--bg-overlay: #181825`, `--border: #45475a`, `--text: #cdd6f4`, `--text-muted: #a6adc8`, `--accent: #89b4fa`, `--accent-green: #a6e3a1`, `--accent-red: #f38ba8`.
  - The form is rendered inside a fixed-position modal: `_container.style.cssText` includes `position:fixed; inset:0; z-index:10000;`. Inside is a panel div (`width:680px; max-width:95vw; max-height:90vh; overflow-y:auto;`).
  - `_defaultRule()` (line 44) returns a default rule scaffold.
  - Helper functions already in the file: `_section(title)`, `_field(label, inputFactory)`, `_input(type, id, placeholder)`, `_applySelectStyle(select)`, `_smallButton(text, onClick)`.

- **Matching logic** exists in two places:
  1. `content/interceptor-inject.js` -- runs in MAIN world (IIFE, no imports). Has `matchUrl(url, type, value)` and `matchesRule(url, method, headers, rule)`. Also has `globToRegex(glob)`.
  2. `service-worker/rule-engine.js` -- ES module. Has `matchUrlCondition()`, `matchHeaderConditions()`, `matchMethodCondition()`, `matchCondition(requestInfo, condition)`. Imports `matchUrl` and `matchHeader` from `shared/utils.js`.

  The test panel needs its OWN matching logic since `rule-form.js` runs in the options page context (not content script or service worker). We'll implement simple matching functions locally in the file, matching the same semantics as both existing implementations.

## Files to Modify

1. **`options/components/rule-form.js`** -- Add the test panel to the form, implement matching and result display.

No other files need modification.

## Implementation

### Step 1: Add matching helper functions

Add these functions before the `_buildForm()` function (or anywhere in the file before they're used):

```javascript
// ---------------------------------------------------------------------------
// Dry-run matching helpers (mirrors interceptor-inject.js logic)
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a regex string.
 * Supports *, **, and ? wildcards.
 */
function _globToRegex(glob) {
  return (
    '^' +
    glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*') +
    '$'
  );
}

/**
 * Test whether a string matches a pattern using the given match type.
 * Works for both URL and header value matching.
 */
function _matchString(str, type, pattern) {
  if (!pattern) return false;
  switch (type) {
    case 'equals':
      return str === pattern;
    case 'contains':
      return str.includes(pattern);
    case 'regex':
      try { return new RegExp(pattern).test(str); }
      catch (_) { return false; }
    case 'glob':
      try { return new RegExp(_globToRegex(pattern)).test(str); }
      catch (_) { return false; }
    default:
      return false;
  }
}

/**
 * Evaluate whether a test request matches a rule's conditions.
 * Returns { matches: boolean, reasons: string[] }.
 * reasons lists human-readable explanations for each failed condition.
 */
function _evaluateMatch(url, method, headers, condition) {
  const reasons = [];
  let matches = true;

  // URL match
  if (condition.url && condition.url.value) {
    if (!_matchString(url, condition.url.type || 'contains', condition.url.value)) {
      matches = false;
      reasons.push(
        `URL "${url.length > 60 ? url.slice(0, 57) + '...' : url}" does not ${condition.url.type || 'contains'} "${condition.url.value}"`
      );
    }
  }

  // Method match
  if (condition.methods && condition.methods.length > 0) {
    if (!condition.methods.includes(method.toUpperCase())) {
      matches = false;
      reasons.push(
        `Method ${method.toUpperCase()} is not in [${condition.methods.join(', ')}]`
      );
    }
  }

  // Header matches (AND logic)
  if (condition.headers && condition.headers.length > 0) {
    for (const hc of condition.headers) {
      if (!hc.name) continue;
      const headerVal = headers[hc.name] || headers[hc.name.toLowerCase()] || '';
      if (!_matchString(headerVal, hc.type || 'equals', hc.value)) {
        matches = false;
        reasons.push(
          `Header "${hc.name}" value "${headerVal || '(empty)'}" does not ${hc.type || 'equals'} "${hc.value}"`
        );
      }
    }
  }

  return { matches, reasons };
}

/**
 * Generate a human-readable description of what a rule's action would do.
 */
function _describeAction(action, url) {
  switch (action.type) {
    case 'redirect': {
      const host = action.redirect?.targetHost || '(none)';
      try {
        const u = new URL(url);
        u.host = host;
        return `Redirect to: <code>${_escapeHtml(u.toString())}</code>`;
      } catch (_) {
        return `Redirect to host: <code>${_escapeHtml(host)}</code>`;
      }
    }
    case 'rewrite': {
      const pattern = action.rewrite?.pattern || '';
      const replacement = action.rewrite?.replacement || '';
      try {
        const newUrl = url.replace(new RegExp(pattern), replacement);
        return `Rewrite URL to: <code>${_escapeHtml(newUrl)}</code>`;
      } catch (_) {
        return `Rewrite: s/${_escapeHtml(pattern)}/${_escapeHtml(replacement)}/`;
      }
    }
    case 'mock_inline': {
      const mock = action.mockInline || {};
      const bodyLen = (mock.body || '').length;
      return `Return mock response: HTTP ${mock.statusCode || 200}, ${bodyLen} byte${bodyLen !== 1 ? 's' : ''}`;
    }
    case 'mock_server': {
      const ms = action.mockServer || {};
      return `Proxy to: <code>${_escapeHtml(ms.serverUrl || 'http://localhost:5000/proxy')}</code> (mode: ${ms.mode || 'RESPONSE_ONLY'})`;
    }
    case 'modify_headers': {
      const mods = action.headerMods || {};
      const count =
        (mods.addRequest?.length || 0) +
        (mods.removeRequest?.length || 0) +
        (mods.addResponse?.length || 0) +
        (mods.removeResponse?.length || 0);
      return `Modify ${count} header${count !== 1 ? 's' : ''}`;
    }
    case 'delay':
      return `Delay request by ${action.delayMs || 0}ms`;
    default:
      return `Action: ${action.type}`;
  }
}

/** Escape HTML special characters to prevent XSS in innerHTML. */
function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

### Step 2: Add `_buildTestPanel()` function

Add this function after the existing `_buildFooter()` function:

```javascript
// ----------------------------- Test Panel ----------------------------------

function _buildTestPanel() {
  const details = document.createElement('details');
  details.className = 'rf-test-panel';
  details.style.cssText = `
    margin-top:16px; border:1px solid #45475a; border-radius:8px;
    background:#181825; overflow:hidden;
  `;

  const summary = document.createElement('summary');
  summary.textContent = 'Test This Rule';
  summary.style.cssText = `
    padding:12px 16px; cursor:pointer; color:#89b4fa; font-weight:600;
    font-size:13px; user-select:none; list-style:none;
  `;
  // Custom disclosure triangle
  summary.innerHTML = '<span style="margin-right:6px;">&#9654;</span> Test This Rule';
  details.addEventListener('toggle', () => {
    summary.innerHTML = details.open
      ? '<span style="margin-right:6px;">&#9660;</span> Test This Rule'
      : '<span style="margin-right:6px;">&#9654;</span> Test This Rule';
  });
  details.appendChild(summary);

  // Input section
  const inputs = document.createElement('div');
  inputs.style.cssText = `
    padding:12px 16px; display:flex; flex-direction:column; gap:10px;
    border-top:1px solid #45475a;
  `;

  // URL input
  const urlRow = document.createElement('div');
  urlRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
  const urlLabel = document.createElement('label');
  urlLabel.textContent = 'URL';
  urlLabel.style.cssText = 'min-width:80px; font-size:13px; color:#a6adc8;';
  const urlInput = _input('text', 'rf-test-url', 'https://example.com/api/users');
  urlInput.style.flex = '1';
  urlRow.appendChild(urlLabel);
  urlRow.appendChild(urlInput);
  inputs.appendChild(urlRow);

  // Method select
  const methodRow = document.createElement('div');
  methodRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
  const methodLabel = document.createElement('label');
  methodLabel.textContent = 'Method';
  methodLabel.style.cssText = 'min-width:80px; font-size:13px; color:#a6adc8;';
  const methodSelect = document.createElement('select');
  methodSelect.id = 'rf-test-method';
  _applySelectStyle(methodSelect);
  ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    methodSelect.appendChild(opt);
  });
  methodRow.appendChild(methodLabel);
  methodRow.appendChild(methodSelect);
  inputs.appendChild(methodRow);

  // Headers textarea
  const headersRow = document.createElement('div');
  headersRow.style.cssText = 'display:flex; align-items:flex-start; gap:8px;';
  const headersLabel = document.createElement('label');
  headersLabel.textContent = 'Headers';
  headersLabel.style.cssText = 'min-width:80px; font-size:13px; color:#a6adc8; margin-top:6px;';
  const headersArea = document.createElement('textarea');
  headersArea.id = 'rf-test-headers';
  headersArea.rows = 2;
  headersArea.placeholder = '{"Authorization": "Bearer xxx"}';
  headersArea.style.cssText = `
    flex:1; padding:6px 10px; border:1px solid #374151; border-radius:6px;
    background:#1f2937; color:#e5e7eb; font-family:monospace; font-size:12px;
    resize:vertical; box-sizing:border-box; outline:none;
  `;
  headersRow.appendChild(headersLabel);
  headersRow.appendChild(headersArea);
  inputs.appendChild(headersRow);

  // Run Test button
  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.textContent = 'Run Test';
  runBtn.style.cssText = `
    align-self:flex-start; padding:7px 18px; border:1px solid #45475a;
    border-radius:6px; background:transparent; color:#89b4fa;
    cursor:pointer; font-weight:600; font-size:13px; transition:background .12s;
  `;
  runBtn.addEventListener('mouseenter', () => { runBtn.style.background = '#3b3f58'; });
  runBtn.addEventListener('mouseleave', () => { runBtn.style.background = 'transparent'; });
  inputs.appendChild(runBtn);

  details.appendChild(inputs);

  // Result area (hidden until test is run)
  const resultDiv = document.createElement('div');
  resultDiv.id = 'rf-test-result';
  resultDiv.style.cssText = 'display:none; padding:12px 16px; border-top:1px solid #45475a;';
  details.appendChild(resultDiv);

  // Run Test click handler
  runBtn.addEventListener('click', () => {
    const testUrl = urlInput.value.trim();
    if (!testUrl) {
      urlInput.focus();
      return;
    }

    const testMethod = methodSelect.value;
    let testHeaders = {};
    try {
      const raw = headersArea.value.trim();
      if (raw) testHeaders = JSON.parse(raw);
    } catch (e) {
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="padding:4px 12px; border-radius:4px; font-weight:700; font-size:13px;
                       background:rgba(243,139,168,0.2); color:#f38ba8;">ERROR</span>
          <span style="color:#a6adc8; font-size:13px;">Invalid JSON in Headers field: ${_escapeHtml(e.message)}</span>
        </div>
      `;
      return;
    }

    // Collect current form state as a rule (without saving)
    const rule = _collectRule();
    rule.enabled = true;

    // Evaluate
    const result = _evaluateMatch(testUrl, testMethod, testHeaders, rule.condition);

    resultDiv.style.display = 'block';

    if (result.matches) {
      resultDiv.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="padding:4px 12px; border-radius:4px; font-weight:700; font-size:13px;
                         background:rgba(166,227,161,0.2); color:#a6e3a1;">MATCH</span>
            <span style="color:#a6adc8; font-size:13px;">Rule would intercept this request</span>
          </div>
          <div style="color:#a6adc8; font-size:13px; margin-top:4px;">
            <strong style="color:#cdd6f4;">Action:</strong> ${rule.action.type.replace(/_/g, ' ')}
            <br>${_describeAction(rule.action, testUrl)}
          </div>
        </div>
      `;
    } else {
      const reasonsHtml = result.reasons
        .map((r) => `<div style="color:#a6adc8; font-size:12px; padding-left:8px;">&bull; ${_escapeHtml(r)}</div>`)
        .join('');
      resultDiv.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="padding:4px 12px; border-radius:4px; font-weight:700; font-size:13px;
                         background:rgba(243,139,168,0.2); color:#f38ba8;">NO MATCH</span>
            <span style="color:#a6adc8; font-size:13px;">Rule would NOT intercept this request</span>
          </div>
          <div style="margin-top:4px;">
            <div style="color:#cdd6f4; font-size:12px; font-weight:600; margin-bottom:4px;">Reasons:</div>
            ${reasonsHtml}
          </div>
        </div>
      `;
    }
  });

  return details;
}
```

### Step 3: Insert the test panel into the form

In `_buildForm()` (line 88), the form currently appends sections in this order:

```javascript
form.appendChild(title);
form.appendChild(_buildBasicSection());
form.appendChild(_buildConditionsSection());
form.appendChild(_buildActionSection());
form.appendChild(_buildFooter());
```

After `form.appendChild(_buildFooter());`, add:

```javascript
form.appendChild(_buildTestPanel());
```

The test panel will appear below the Save/Cancel buttons, collapsed by default.

## How the Flow Works

1. User opens the rule form (Add Rule or Edit Rule).
2. Fills in conditions: URL contains `/api/users`, Methods: GET, POST.
3. Sets action: mock_inline, status 200, body `{"users": []}`.
4. Clicks "Test This Rule" summary to expand the panel.
5. Enters test URL: `https://prod.example.com/api/users/123`.
6. Selects method: GET.
7. Clicks "Run Test".
8. `_collectRule()` reads the current form state (URL pattern, methods, action config).
9. `_evaluateMatch()` tests the sample URL/method/headers against the collected conditions.
10. Result shows: **MATCH** - Action: mock inline - Return mock response: HTTP 200, 15 bytes.
11. User changes test URL to `https://prod.example.com/other/path`.
12. Clicks "Run Test" again.
13. Result shows: **NO MATCH** - URL "/other/path" does not contains "/api/users".

The test panel does NOT save the rule, does NOT apply it, and does NOT send any messages to the service worker. It is purely a client-side evaluation.

## Verification

1. **Panel collapsed by default**: Open rule form (new or edit). Confirm "Test This Rule" is collapsed at the bottom, below Save/Cancel.
2. **Expand/collapse**: Click the summary text -- panel opens showing URL, Method, Headers inputs and "Run Test" button. Click again -- collapses. Disclosure triangle icon changes between right-pointing and down-pointing.
3. **MATCH case**:
   - Set URL condition: contains "/api/users"
   - Set action: redirect, target host: staging.example.com
   - In test panel: URL = `https://prod.example.com/api/users/123`, Method = GET
   - Click "Run Test"
   - Result: Green "MATCH" badge + "Action: redirect" + "Redirect to: https://staging.example.com/api/users/123"
4. **NO MATCH case**:
   - Same rule as above
   - Test URL: `https://prod.example.com/other/endpoint`
   - Result: Red "NO MATCH" badge + reason: URL does not contains "/api/users"
5. **Method mismatch**:
   - Set methods: only POST checked
   - Test with method GET
   - Result: NO MATCH + reason: "Method GET is not in [POST]"
6. **Header mismatch**:
   - Add header condition: name=Authorization, type=contains, value="Bearer"
   - Test headers: `{"Authorization": "Basic xxx"}`
   - Result: NO MATCH + reason about Authorization header
7. **Regex URL matching**:
   - URL type: regex, value: `/api/v[0-9]+/users`
   - Test URL: `https://example.com/api/v2/users` -- MATCH
   - Test URL: `https://example.com/api/legacy/users` -- NO MATCH
8. **Glob URL matching**:
   - URL type: glob, value: `**/api/*/users`
   - Test URL: `https://example.com/api/v2/users` -- MATCH
9. **Invalid headers JSON**: Type `{bad json` in headers -- shows ERROR badge with parse error message.
10. **Empty URL**: Click "Run Test" with empty URL field -- URL input is focused, no error shown.
11. **Mock action description**: Set action to mock_inline, status 404, body `{"error": "not found"}` -- match result shows "Return mock response: HTTP 404, 22 bytes".
12. **Delay action description**: Set action to delay, 3000ms -- match result shows "Delay request by 3000ms".
13. **Form scrolling**: The test panel is inside the scrollable form panel. Confirm scrolling to the bottom reveals the full test panel.
