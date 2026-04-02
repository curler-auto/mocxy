# Feature 1.8 — Script & CSS Injection

## Summary

Add a new action type `inject` that injects custom JavaScript or CSS into pages when the URL matches a rule's conditions. Unlike the other action types that intercept network requests via fetch/XHR overrides, this feature works through the content script (`content-script.js`) by creating `<script>` or `<style>` elements and injecting them into the page's DOM.

## Why

Developers and testers frequently need to:

- Add debug logging or instrumentation to specific pages
- Override CSS styles to test responsive layouts or dark mode
- Inject shims, polyfills, or monkey-patches for testing
- Add custom UI elements (overlays, debug panels) during development
- Run setup scripts before the page's own scripts execute (`document_start`)

This complements the existing interception capabilities by operating at the DOM level rather than the network level.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Tech**: Chrome Extension MV3, vanilla JS (ES modules), no build step
- **Theme**: Dark (Catppuccin Mocha palette), CSS variables in `options/options.css`
- **Content script**: `content/content-script.js` runs in the ISOLATED world at `document_start`
- **Interception**: `content/interceptor-inject.js` runs in the MAIN world -- this **cannot** be used for DOM injection because it overrides fetch/XHR, not DOM APIs
- **Manifest**: `content_scripts` already declares `content-script.js` running at `document_start` on `<all_urls>`
- **Important**: `content-script.js` runs in the ISOLATED world, which can access the DOM but cannot directly run JS in the page's execution context. For JS injection, we must create a `<script>` element (which runs in the MAIN world).

## Files to Modify

| File | Change |
|------|--------|
| `shared/constants.js` | Add `ACTION_TYPES.INJECT` and `INJECT_RUN_AT` constant |
| `shared/data-models.js` | Add `action.inject` field to `createRule` defaults |
| `content/content-script.js` | Add injection logic: check rules on page load, inject `<script>` and `<style>` tags for matching `inject` rules |
| `options/components/rule-form.js` | Add inject sub-form with JS textarea + CSS textarea + runAt dropdown + security warning |
| `options/options.css` | Add styles for inject form section |

## Data Model Changes

### `shared/constants.js`

Add to `ACTION_TYPES`:

```js
export const ACTION_TYPES = {
  REDIRECT: 'redirect',
  REWRITE: 'rewrite',
  MOCK_INLINE: 'mock_inline',
  MOCK_SERVER: 'mock_server',
  MODIFY_HEADERS: 'modify_headers',
  DELAY: 'delay',
  PATCH_RESPONSE: 'patch_response',   // if Feature 1.7 is implemented
  INJECT: 'inject',                    // <-- NEW
};
```

Add a new constant for injection timing:

```js
/** Timing options for script/CSS injection. */
export const INJECT_RUN_AT = {
  DOCUMENT_START: 'document_start',
  DOCUMENT_END: 'document_end',
  DOCUMENT_IDLE: 'document_idle',
};
```

### `shared/data-models.js`

In `createRule()`, extend the `action` object inside `defaults`:

```js
action: {
  type: 'redirect',
  redirect: { ... },
  rewrite: { ... },
  mockInline: { ... },
  mockServer: { ... },
  headerMods: { ... },
  delayMs: 0,
  patchResponse: { patches: [] },   // if Feature 1.7 is implemented
  inject: {                          // <-- NEW
    js: '',
    css: '',
    runAt: 'document_end',
  },
},
```

## Implementation

### 1. Content Script Injection Logic (`content/content-script.js`)

The content script already runs at `document_start` and receives rules from the service worker. We need to add logic that, upon receiving rules, evaluates which ones have `action.type === 'inject'` and whose URL conditions match the current page, then injects the appropriate `<script>` and/or `<style>` elements.

**Key design decisions:**

- Injection happens when rules are received (both on initial load and on RULES_UPDATED).
- Each injected rule is tracked by its rule ID to avoid duplicate injection.
- `document_start` injection happens immediately. `document_end` injection waits for `DOMContentLoaded`. `document_idle` injection waits for `load` event.
- CSS is injected via `<style>` tags in the `<head>`.
- JS is injected via `<script>` tags in the `<head>` (runs in MAIN world).

Add the following code to `content/content-script.js`, after the initial script injection block (section 1) and before the message listeners (section 2):

```js
// ---------------------------------------------------------------------------
// 1b. Script & CSS Injection Engine
// ---------------------------------------------------------------------------

/** Set of rule IDs that have already been injected to prevent duplicates. */
const _injectedRuleIds = new Set();

/** Track DOMContentLoaded state. */
let _domContentLoaded = false;
let _domLoadComplete = false;
const _pendingDomReady = [];
const _pendingLoadComplete = [];

document.addEventListener('DOMContentLoaded', () => {
  _domContentLoaded = true;
  _pendingDomReady.forEach((fn) => fn());
  _pendingDomReady.length = 0;
});

window.addEventListener('load', () => {
  _domLoadComplete = true;
  _pendingLoadComplete.forEach((fn) => fn());
  _pendingLoadComplete.length = 0;
});

/**
 * URL matching helper (simplified version for content-script context).
 * Content scripts don't have access to ES module imports, so we inline this.
 */
function _matchUrl(url, type, value) {
  if (!value) return false;
  switch (type) {
    case 'equals':
      return url === value;
    case 'contains':
      return url.includes(value);
    case 'regex':
      try { return new RegExp(value).test(url); } catch (e) { return false; }
    case 'glob': {
      const re = '^' + value
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*') + '$';
      return new RegExp(re).test(url);
    }
    default:
      return false;
  }
}

/**
 * Check if the current page URL matches a rule's conditions.
 * For inject rules, we only check URL and method (method is N/A for page loads).
 */
function _ruleMatchesCurrentPage(rule) {
  const cond = rule.condition || {};
  const pageUrl = window.location.href;

  if (cond.url && cond.url.value) {
    if (!_matchUrl(pageUrl, cond.url.type || 'contains', cond.url.value)) return false;
  }

  return true;
}

/**
 * Inject CSS into the page by creating a <style> element.
 */
function _injectCSS(css, ruleId) {
  if (!css || !css.trim()) return;

  const style = document.createElement('style');
  style.setAttribute('data-neuron-rule', ruleId);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  console.log('[Neuron Content] Injected CSS for rule:', ruleId);
}

/**
 * Inject JavaScript into the page by creating a <script> element.
 * The script runs in the MAIN world (page context), not the isolated content-script world.
 */
function _injectJS(js, ruleId) {
  if (!js || !js.trim()) return;

  const script = document.createElement('script');
  script.setAttribute('data-neuron-rule', ruleId);
  script.textContent = js;
  (document.head || document.documentElement).appendChild(script);
  // Remove after execution to keep DOM clean (script has already run)
  script.remove();
  console.log('[Neuron Content] Injected JS for rule:', ruleId);
}

/**
 * Schedule injection based on the runAt timing.
 */
function _scheduleInjection(rule) {
  const inject = rule.action?.inject || {};
  const runAt = inject.runAt || 'document_end';

  const doInject = () => {
    if (_injectedRuleIds.has(rule.id)) return; // Already injected
    _injectedRuleIds.add(rule.id);

    // CSS is always safe to inject (no execution context issues)
    _injectCSS(inject.css, rule.id);

    // JS runs in MAIN world via <script> tag
    _injectJS(inject.js, rule.id);
  };

  switch (runAt) {
    case 'document_start':
      // Inject immediately (content script is running at document_start)
      doInject();
      break;

    case 'document_end':
      if (_domContentLoaded) {
        doInject();
      } else {
        _pendingDomReady.push(doInject);
      }
      break;

    case 'document_idle':
      if (_domLoadComplete) {
        doInject();
      } else {
        _pendingLoadComplete.push(doInject);
      }
      break;

    default:
      // Fallback: treat as document_end
      if (_domContentLoaded) {
        doInject();
      } else {
        _pendingDomReady.push(doInject);
      }
      break;
  }
}

/**
 * Process all rules and inject scripts/CSS for matching inject rules.
 * Called whenever rules are updated.
 */
function _processInjectRules(rules, enabled) {
  if (!enabled || !Array.isArray(rules)) return;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.action?.type !== 'inject') continue;
    if (_injectedRuleIds.has(rule.id)) continue; // Skip already injected
    if (!_ruleMatchesCurrentPage(rule)) continue;

    _scheduleInjection(rule);
  }
}
```

#### Update the message listeners to trigger injection

Modify the existing RULES_UPDATED handler in the content script (section 3, `chrome.runtime.onMessage.addListener`) to also call `_processInjectRules`:

In the `case 'RULES_UPDATED':` block, after the `window.postMessage(...)` call, add:

```js
// Process inject rules
_processInjectRules(message.data?.rules, message.data?.enabled);
```

Similarly, in the `case 'GET_RULES_RESPONSE':` block, after the `window.postMessage(...)` call, add:

```js
// Process inject rules
_processInjectRules(message.data?.rules, message.data?.enabled);
```

And in the initial rules request at the bottom (section 4), inside the `.then()` callback, after the `window.postMessage(...)` call, add:

```js
// Process inject rules
_processInjectRules(response.data?.rules, response.data?.enabled);
```

### 2. Rule Form UI (`options/components/rule-form.js`)

#### Add import

Add `INJECT_RUN_AT` to the import from `shared/constants.js`:

```js
import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
  INJECT_RUN_AT,         // <-- NEW
} from '../../shared/constants.js';
```

#### Add inject sub-form builder

Add this new function alongside the other `_build*Sub()` functions:

```js
function _buildInjectSub() {
  const div = _actionSub(ACTION_TYPES.INJECT);
  const inject = _editingRule?.action?.inject || {};

  // Security warning
  const warning = document.createElement('div');
  warning.style.cssText =
    'display:flex; gap:8px; padding:10px 12px; margin-bottom:12px; ' +
    'border:1px solid #92400e; border-radius:6px; background:rgba(245,158,11,0.08); ' +
    'font-size:12px; color:#fbbf24; line-height:1.5;';
  const warnIcon = document.createElement('span');
  warnIcon.textContent = '\u26A0';
  warnIcon.style.cssText = 'font-size:16px; flex-shrink:0;';
  const warnText = document.createElement('span');
  warnText.textContent =
    'Security notice: Injected scripts run with full page privileges. ' +
    'They can access cookies, localStorage, and all page data. ' +
    'Only inject code you trust.';
  warning.appendChild(warnIcon);
  warning.appendChild(warnText);
  div.appendChild(warning);

  // Run At dropdown
  div.appendChild(
    _field('Run At', () => {
      const select = document.createElement('select');
      select.id = 'ni-act-inject-runat';
      _applySelectStyle(select);
      for (const [, val] of Object.entries(INJECT_RUN_AT)) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val.replace(/_/g, ' ');
        if ((inject.runAt || 'document_end') === val) opt.selected = true;
        select.appendChild(opt);
      }
      return select;
    }),
  );

  // Run At description
  const runAtDesc = document.createElement('div');
  runAtDesc.style.cssText = 'font-size:11px; color:#6b7280; margin-bottom:12px; line-height:1.5; padding-left:110px;';
  runAtDesc.innerHTML =
    '<strong>document_start</strong>: Before any page scripts run (earliest).<br>' +
    '<strong>document_end</strong>: After DOM is parsed but before images/subresources load.<br>' +
    '<strong>document_idle</strong>: After the page fully loads (safest).';
  div.appendChild(runAtDesc);

  // JavaScript textarea
  const jsLabel = document.createElement('label');
  jsLabel.textContent = 'JavaScript';
  jsLabel.style.cssText = 'font-size:13px; color:#9ca3af; display:block; margin-top:4px; font-weight:600;';
  div.appendChild(jsLabel);

  const jsHint = document.createElement('div');
  jsHint.style.cssText = 'font-size:11px; color:#6b7280; margin-bottom:4px;';
  jsHint.textContent = 'Runs in the page context (MAIN world). Has access to window, document, and all page APIs.';
  div.appendChild(jsHint);

  const jsArea = document.createElement('textarea');
  jsArea.id = 'ni-act-inject-js';
  jsArea.rows = 10;
  jsArea.style.cssText = `
    width:100%; padding:10px 12px; border:1px solid #374151; border-radius:6px;
    background:#0f172a; color:#a6e3a1; font-family:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;
    font-size:12px; line-height:1.6; resize:vertical; box-sizing:border-box;
    tab-size:2;
  `;
  jsArea.value = inject.js || '';
  jsArea.placeholder = '// Your JavaScript code here\nconsole.log("Neuron injected!");';
  jsArea.spellcheck = false;

  // Allow Tab key in textarea
  jsArea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = jsArea.selectionStart;
      const end = jsArea.selectionEnd;
      jsArea.value = jsArea.value.substring(0, start) + '  ' + jsArea.value.substring(end);
      jsArea.selectionStart = jsArea.selectionEnd = start + 2;
    }
  });

  div.appendChild(jsArea);

  // CSS textarea
  const cssLabel = document.createElement('label');
  cssLabel.textContent = 'CSS';
  cssLabel.style.cssText = 'font-size:13px; color:#9ca3af; display:block; margin-top:14px; font-weight:600;';
  div.appendChild(cssLabel);

  const cssHint = document.createElement('div');
  cssHint.style.cssText = 'font-size:11px; color:#6b7280; margin-bottom:4px;';
  cssHint.textContent = 'Injected as a <style> tag in the page head. Applies to the entire page.';
  div.appendChild(cssHint);

  const cssArea = document.createElement('textarea');
  cssArea.id = 'ni-act-inject-css';
  cssArea.rows = 8;
  cssArea.style.cssText = `
    width:100%; padding:10px 12px; border:1px solid #374151; border-radius:6px;
    background:#0f172a; color:#89b4fa; font-family:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;
    font-size:12px; line-height:1.6; resize:vertical; box-sizing:border-box;
    tab-size:2;
  `;
  cssArea.value = inject.css || '';
  cssArea.placeholder = '/* Your CSS here */\nbody {\n  outline: 2px solid red;\n}';
  cssArea.spellcheck = false;

  // Allow Tab key in textarea
  cssArea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = cssArea.selectionStart;
      const end = cssArea.selectionEnd;
      cssArea.value = cssArea.value.substring(0, start) + '  ' + cssArea.value.substring(end);
      cssArea.selectionStart = cssArea.selectionEnd = start + 2;
    }
  });

  div.appendChild(cssArea);

  return div;
}
```

#### Register the sub-form in `_buildActionSection()`

In `_buildActionSection()`, add after the last `subContainer.appendChild(...)` call:

```js
subContainer.appendChild(_buildInjectSub());
```

#### Update `_collectRule()` to gather inject data

Inside `_collectRule()`, after the other action sub-data collection, add:

```js
  // Inject
  rule.action.inject = {
    js: _val('ni-act-inject-js') || '',
    css: _val('ni-act-inject-css') || '',
    runAt: _val('ni-act-inject-runat') || 'document_end',
  };
```

#### Update `_defaultRule()` to include inject

In the `_defaultRule()` function, add to the `action` object:

```js
inject: {
  js: '',
  css: '',
  runAt: 'document_end',
},
```

#### Update validation

In `_validate()`, the inject action type does NOT require a URL pattern (it could match all pages). However, at least one of JS or CSS should be non-empty. Add this check:

```js
  // Inject requires at least JS or CSS content
  if (rule.action.type === 'inject') {
    const inj = rule.action.inject || {};
    if (!inj.js?.trim() && !inj.css?.trim()) {
      return 'At least one of JavaScript or CSS must be provided for inject rules.';
    }
  }
```

Add this after the existing URL validation block (the `typesNeedingUrl` check). Also, do NOT include `ACTION_TYPES.INJECT` in the `typesNeedingUrl` array, since inject rules may legitimately match all URLs.

### 3. No Changes to `interceptor-inject.js`

The inject action type does **not** go through the fetch/XHR override pipeline. It is handled entirely by `content-script.js`. The `interceptor-inject.js` file should simply ignore inject rules (they will never match in `findMatchingRule` because the URL matching runs against request URLs, not page URLs, and inject rules should not intercept network requests).

To be safe, if an inject rule somehow reaches `applyAction()`, add a no-op case:

```js
case 'inject': {
  // Inject rules are handled by content-script.js, not the interceptor.
  // If we reach here, just pass through the original request.
  const resp = await originalFetch(url, options);
  return { response: resp };
}
```

## CSS

Add to `options/options.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Script & CSS Injection Form                                               */
/* -------------------------------------------------------------------------- */

.ni-inject-warning {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid #92400e;
  border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.08);
  font-size: 12px;
  color: var(--accent-yellow);
  line-height: 1.5;
}

/* Code editor textareas for JS/CSS injection */
.action-section[data-type="inject"] textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--bg-overlay);
  color: var(--accent-green);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  resize: vertical;
}

.action-section[data-type="inject"] textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.2);
}
```

Also add an action-type badge for inject in the options CSS:

```css
.badge-inject { background: rgba(203, 166, 247, 0.15); color: #cba6f7; }
```

## Example Usage

### Example 1: Inject debug logging

```json
{
  "name": "Debug API calls",
  "condition": {
    "url": { "type": "contains", "value": "nms-dashboard" }
  },
  "action": {
    "type": "inject",
    "inject": {
      "js": "const origFetch = window.fetch;\nwindow.fetch = async function(...args) {\n  console.log('[DEBUG] fetch:', args[0]);\n  const resp = await origFetch.apply(this, args);\n  console.log('[DEBUG] response:', resp.status);\n  return resp;\n};",
      "css": "",
      "runAt": "document_start"
    }
  }
}
```

### Example 2: Inject CSS overlay for testing

```json
{
  "name": "Highlight clickable elements",
  "condition": {
    "url": { "type": "contains", "value": "localhost" }
  },
  "action": {
    "type": "inject",
    "inject": {
      "js": "",
      "css": "button, a, [role='button'] {\n  outline: 2px dashed rgba(255, 0, 0, 0.5) !important;\n  outline-offset: 2px;\n}",
      "runAt": "document_end"
    }
  }
}
```

### Example 3: Inject both JS and CSS

```json
{
  "name": "Performance monitor overlay",
  "condition": {
    "url": { "type": "regex", "value": "https://.*\\.example\\.com" }
  },
  "action": {
    "type": "inject",
    "inject": {
      "js": "const div = document.createElement('div');\ndiv.id = 'neuron-perf';\ndiv.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;padding:8px 12px;font-size:12px;';\ndocument.body.appendChild(div);\nsetInterval(() => {\n  const perf = performance.getEntriesByType('navigation')[0];\n  div.textContent = 'Load: ' + Math.round(perf?.loadEventEnd || 0) + 'ms';\n}, 1000);",
      "css": "#neuron-perf {\n  background: rgba(0,0,0,0.8);\n  color: #a6e3a1;\n  font-family: monospace;\n  border-bottom-left-radius: 6px;\n}",
      "runAt": "document_idle"
    }
  }
}
```

## Verification Steps

### Manual Testing

1. **Load the extension** in `chrome://extensions` (developer mode, load unpacked).

2. **Create a CSS injection rule**:
   - Open Options page.
   - Click "New Rule".
   - Name: "Red Border Test".
   - URL: contains `localhost` (or the URL of a test page).
   - Action type: `inject`.
   - Leave JS empty.
   - CSS: `body { border: 5px solid red !important; }`
   - Run At: `document_end`.
   - Save.
   - Navigate to a matching page -- should see a red border around the body.

3. **Create a JS injection rule**:
   - Name: "Console Log Test".
   - URL: contains the test page domain.
   - JS: `console.log("Neuron injection working!", document.title);`
   - Run At: `document_end`.
   - Save.
   - Navigate to a matching page -- open DevTools console and verify the log message appears.

4. **Test `document_start` timing**:
   - Create rule with `runAt: document_start`.
   - JS: `window.__neuronStartTime = performance.now();`
   - Create another rule with `runAt: document_idle`.
   - JS: `console.log("Time from start to idle:", performance.now() - window.__neuronStartTime, "ms");`
   - Navigate to a matching page -- verify both scripts ran and the timing shows a positive number.

5. **Test `document_idle` timing**:
   - Create rule with `runAt: document_idle`.
   - JS: `console.log("Page fully loaded:", document.readyState);`
   - Navigate -- should log `"Page fully loaded: complete"`.

6. **Test duplicate prevention**:
   - Navigate to a matching page.
   - Click the extension popup and toggle off then on.
   - Verify the script/CSS is NOT injected a second time (check `data-neuron-rule` attributes in DOM).

7. **Test rule URL matching**:
   - Create rule with `url.type = 'regex'` and `url.value = 'example\\.com'`.
   - Navigate to `https://example.com` -- should inject.
   - Navigate to `https://other.com` -- should NOT inject.

8. **Test non-matching pages**:
   - Create rule matching only `localhost`.
   - Navigate to a different domain -- verify no injection occurs.

9. **Test editing inject rules**:
   - Create an inject rule, save, then click Edit.
   - Verify JS, CSS, and runAt are pre-populated correctly.
   - Modify and save -- verify changes take effect on next page load.

10. **Test with both JS and CSS**:
    - Create a rule with both JS and CSS content.
    - Verify both are injected (check for `<style>` tag with `data-neuron-rule` attribute).

11. **Test Tab key in textareas**:
    - In the JS or CSS textarea, press Tab.
    - Verify it inserts 2 spaces instead of moving focus.

12. **Test the security warning**:
    - When creating an inject rule, verify the yellow security warning is visible.

13. **Verify existing rule types** still work (no regression in redirect, mock, etc.).

14. **Verify form validation**:
    - Try to save an inject rule with both JS and CSS empty -- should show validation error.
    - Save with only JS filled -- should succeed.
    - Save with only CSS filled -- should succeed.

### Edge Cases to Verify

- Rule with empty JS and non-empty CSS -- should inject only CSS.
- Rule with non-empty JS and empty CSS -- should inject only JS.
- JS that throws an error -- should not break the page or the extension (the error is contained in the `<script>` tag).
- CSS with syntax errors -- should not break the page (browser ignores invalid CSS rules).
- Very long JS/CSS content -- should handle without truncation.
- Multiple inject rules matching the same page -- each should inject independently.
- Disabling an inject rule -- already-injected content persists until page reload (this is expected behavior; document this in the UI).
- Page navigation (SPA) -- inject rules fire on initial load only, not on SPA route changes (this is by design since content scripts run once per page load).
