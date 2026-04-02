# Feature 1.3: Quick Mock from Request Log

## Summary

Add a "Mock" action button to each request log entry row that instantly creates a mock rule pre-populated with that request's URL, method, status code, and response body. Clicking it navigates to the Rules section and opens the rule form ready to save.

## Why

The fastest path from "I see this API call" to "I want to mock it" should be one click. Currently a user must manually note down URL, status, body, navigate to Rules, create a new rule, and type everything in.

## Codebase Context

The extension uses a Manifest V3 Chrome Extension architecture with ES modules. All source lives under `health_check/utils/neuron-interceptor-plugin/`. Key facts:

- **Request log component** (`options/components/request-log.js`):
  - Exports one function: `export async function initRequestLog(container)` (line 984). Takes a single argument -- the container HTMLElement.
  - Module state: `_container`, `_logs` (array of log entry objects), `_filters`, etc.
  - Each log entry object has shape (from `shared/data-models.js` `createLogEntry()`): `{ id, timestamp, url, method, statusCode, duration, matchedRuleId, matchedRuleName, actionTaken, intercepted, requestHeaders, requestBody, responseHeaders, responseBody }`.
  - `renderLogEntry(entry)` (line 214) creates a `div.rl-entry` with a `div.rl-entry-summary` and (when expanded) a `div.rl-entry-detail`.
  - The summary row has cells: expand icon, time, method, URL, status, duration, rule, action. All are `<span>` elements appended to the summary div.
  - The `el(tag, attrs, children)` helper function (line 101) is used for DOM creation throughout the component.
  - CSS is injected via `injectStyles()` (line 562), which creates a `<style id="rl-styles">`.

- **Options page controller** (`options/options.js`):
  - `navigateTo(sectionId)` switches visible section (local function, not exported).
  - `showToast(message, variant, durationMs)` is exported.
  - `initRequestLog(containers.requestLog)` is called on line 311 with just the container.
  - `ruleForm` variable (line 278) has `{ open, close }` returned by `initRuleForm()`. It is a local variable inside the `init()` async function.
  - `ruleList` variable (line 305) has `{ refresh }` returned by `initRuleList()`.
  - The `onEdit` callback for rule list is `(rule) => ruleForm.open(rule)`.

- **Rule form** (`options/components/rule-form.js`):
  - `open(rule)` (line 882): Accepts a rule object (or null). When a rule is passed, it sets `_editingRule = rule` and pre-populates all form fields from it. The `id` is preserved for editing; for a new template-based rule, a pre-assigned `id` will also be preserved.
  - The rule object passed to `open()` must match the full shape with all action sub-fields present.

- **Rule data shape** (from `shared/data-models.js`): `{ id, name, enabled, priority, condition: { url: { type, value }, headers: [], methods: [] }, action: { type, redirect: { targetHost, preservePath }, rewrite: { pattern, replacement }, mockInline: { statusCode, headers, body }, mockServer: { serverUrl, mode, stepTag }, headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] }, delayMs } }`.

## Files to Modify

1. **`options/components/request-log.js`** -- Add "Mock" button to each log entry summary row. Accept an `onCreateMock` callback via `initRequestLog`.
2. **`options/options.js`** -- Pass `onCreateMock` callback when calling `initRequestLog`. Build the pre-populated rule, navigate to Rules section, and open the rule form.

## Implementation

### Step 1: Modify `initRequestLog` to accept a callbacks object

Change the function signature at line 984 from:

```javascript
export async function initRequestLog(container) {
```

to:

```javascript
export async function initRequestLog(container, { onCreateMock } = {}) {
```

Then store the callback in module state. Add a new module-level variable near the top (after `let _displayedCount = 50;` on line 28):

```javascript
let _onCreateMock = null;
```

At the beginning of the `initRequestLog` function body (after `_container = container;` and `injectStyles();`), add:

```javascript
_onCreateMock = onCreateMock || null;
```

### Step 2: Add "Mock" button to `renderLogEntry`

In the `renderLogEntry(entry)` function (line 214), after the "Action" cell is appended to `summary` (the last `summary.appendChild(...)` at approximately line 283), add a "Mock" button:

```javascript
  // Mock button (visible on hover)
  if (_onCreateMock && entry.responseBody) {
    const mockBtn = el('button', {
      className: 'rl-btn rl-btn-sm rl-btn-secondary rl-btn-mock',
      textContent: 'Mock',
      title: 'Create a mock rule from this request',
      onClick: (e) => {
        e.stopPropagation(); // Don't toggle row expansion
        _onCreateMock(entry);
      },
    });
    summary.appendChild(mockBtn);
  }
```

Note: `e.stopPropagation()` is critical. The summary row has a click handler that toggles `_expandedIds`. Without stopping propagation, clicking "Mock" would also expand/collapse the row.

### Step 3: Add hover-reveal CSS for the Mock button

In the `injectStyles()` function, append the following CSS rules inside the existing `style.textContent` template literal, before the closing backtick:

```css
/* Mock button - visible on hover */
.rl-btn-mock {
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
  margin-left: 4px;
}

.rl-entry-summary:hover .rl-btn-mock {
  opacity: 1;
}
```

### Step 4: Wire up the callback in `options/options.js`

The `initRequestLog` call is on line 311:

```javascript
initRequestLog(containers.requestLog);
```

Replace it with:

```javascript
initRequestLog(containers.requestLog, {
  onCreateMock: (logEntry) => {
    // Extract URL pathname for the condition
    let urlPath = logEntry.url || '';
    try {
      urlPath = new URL(logEntry.url).pathname;
    } catch (_) {
      // Use full URL if parsing fails
    }

    // Build a pre-populated rule matching the full data shape
    const rule = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      name: `Mock ${(logEntry.method || 'GET').toUpperCase()} ${urlPath.length > 40 ? urlPath.slice(0, 40) + '...' : urlPath}`,
      enabled: true,
      priority: 10,
      condition: {
        url: { type: 'contains', value: urlPath },
        headers: [],
        methods: logEntry.method ? [logEntry.method.toUpperCase()] : [],
      },
      action: {
        type: 'mock_inline',
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockInline: {
          statusCode: logEntry.statusCode || 200,
          headers: _normalizeHeaders(logEntry.responseHeaders),
          body: _formatBody(logEntry.responseBody),
        },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    };

    // Navigate to the Rules section and open the form
    navigateTo('rules');
    ruleForm.open(rule);
    showToast('Pre-populated mock rule from captured request', 'info');
  },
});
```

Also add two small helper functions right before the `init()` function:

```javascript
/**
 * Normalize response headers into { string: string } object for mockInline.
 * Handles arrays (Chrome format), objects, and missing values.
 */
function _normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return { 'Content-Type': 'application/json' };
  }
  if (Array.isArray(headers)) {
    const obj = {};
    headers.forEach((h) => {
      if (h.name && h.value !== undefined) obj[h.name] = h.value;
    });
    return Object.keys(obj).length > 0 ? obj : { 'Content-Type': 'application/json' };
  }
  return Object.keys(headers).length > 0 ? { ...headers } : { 'Content-Type': 'application/json' };
}

/**
 * Format the response body for use as mock body text.
 * If it's an object, stringify with indentation. Otherwise return as string.
 */
function _formatBody(body) {
  if (!body) return '{}';
  if (typeof body === 'object') {
    try { return JSON.stringify(body, null, 2); } catch (_) { return '{}'; }
  }
  // Try to pretty-print if it's a JSON string
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return String(body);
  }
}
```

**Important scoping note**: The `onCreateMock` callback accesses `ruleForm`, `navigateTo`, and `showToast` -- all of which are available in the `init()` function's scope:
- `ruleForm` is a local variable declared on line 278.
- `navigateTo` is a module-level function declared on line 150.
- `showToast` is a module-level exported function declared on line 72.

The `_normalizeHeaders` and `_formatBody` helpers should be placed at module scope (outside `init()`) so they're accessible from the callback.

## How the Flow Works

1. User opens Options -> Request Log section.
2. The log table shows captured requests. Each row with a response body has a "Mock" button that appears on hover.
3. User hovers over a row showing `POST /api/v2/fleet-summary 200` -- the "Mock" button fades in on the right.
4. User clicks "Mock":
   - `e.stopPropagation()` prevents the row from expanding.
   - The `_onCreateMock(entry)` callback fires with the full log entry.
5. In `options.js`, the callback:
   - Extracts the URL pathname from the log entry.
   - Builds a complete rule object with `action.type = 'mock_inline'`, status code from the response, and the response body pre-filled.
   - Calls `navigateTo('rules')` to switch to the Rules section.
   - Calls `ruleForm.open(rule)` to open the form pre-populated.
   - Shows a toast "Pre-populated mock rule from captured request".
6. The rule form appears with all fields filled in. The user can adjust the URL pattern, change the response body, etc.
7. User clicks "Save" -- the existing save handler in `options.js` persists the rule and refreshes the rule list.

## Verification

1. **Setup**: Enable the interceptor, navigate to a web page that makes API calls, then open Options -> Request Log.
2. **Button visibility**: Hover over a log entry row that has a response body -- confirm the "Mock" button appears on the right edge of the summary row with a fade-in transition.
3. **Button hidden for bodyless entries**: Entries without a response body (e.g., failed requests with `responseBody: null`) should NOT show a Mock button.
4. **Click behavior**: Click the "Mock" button on a `GET /api/users 200` entry:
   - Confirm the view switches to the Rules section.
   - Confirm the rule form modal opens.
   - Confirm pre-populated values:
     - Name: "Mock GET /api/users"
     - URL condition: contains "/api/users"
     - Methods: GET checked
     - Action type: mock inline
     - Status Code: 200
     - Response Headers: Content-Type: application/json (or whatever the actual response had)
     - Response Body: the pretty-printed JSON from the captured response
   - A toast notification appears saying "Pre-populated mock rule from captured request".
5. **Save and test**: Modify the response body to `{"users": []}`, click Save, confirm the rule appears in the rule list, then reload the page -- the mocked response is returned.
6. **Row doesn't expand**: Clicking "Mock" should NOT expand/collapse the log entry detail panel.
7. **Long URLs**: If the captured URL is very long (e.g., `/api/v2/fleet-summary?filter=status&region=all&page=1`), confirm the rule name is truncated sensibly and the URL condition contains the full pathname.
