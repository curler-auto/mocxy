# Feature 1.6 — Request Body Matching

## Summary

Add the ability to match interception rules based on request body content using JSON path conditions. This enables rules that fire only when specific fields exist or have specific values in a POST/PUT/PATCH request body -- for example, intercepting only when `$.filters.airline` equals `"AA"`.

## Why

Currently rules can only match on URL, HTTP method, and headers. Many APIs (especially in the Neuron NMS dashboard) use POST requests with JSON bodies where the URL is identical across different operations. Without body matching, users cannot distinguish between a fleet summary request filtered by airline "AA" versus one filtered by airline "UA" -- both hit the same endpoint. Body matching closes this gap and is critical for targeted mocking and request validation in the test automation suite.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Tech**: Chrome Extension MV3, vanilla JS (ES modules), no build step
- **Theme**: Dark (Catppuccin Mocha palette), CSS variables in `options/options.css`
- **Interception**: Dual layer -- DNR (fast-path redirects) + fetch/XHR override (`content/interceptor-inject.js`)
- **Data model**: Factory functions in `shared/data-models.js`, constants in `shared/constants.js`
- **Rule form**: `options/components/rule-form.js` builds the rule editor modal dynamically

## Files to Modify

| File | Change |
|------|--------|
| `shared/constants.js` | Add `BODY_MATCH_TYPES` constant |
| `shared/data-models.js` | Add `condition.body` field to `createRule` defaults |
| `content/interceptor-inject.js` | Add JSON path resolver + body matching logic in `matchesRule()` and capture request body in `findMatchingRule()` |
| `options/components/rule-form.js` | Add body condition UI section inside `_buildConditionsSection()` |
| `options/options.css` | Add styles for body condition rows |

## Data Model Changes

### `shared/constants.js`

Add a new constant after the existing `HEADER_MATCH_TYPES`:

```js
/** Supported request body matching strategies. */
export const BODY_MATCH_TYPES = {
  EQUALS: 'equals',
  CONTAINS: 'contains',
  REGEX: 'regex',
  EXISTS: 'exists',
};
```

No other changes to constants.js are needed.

### `shared/data-models.js`

In `createRule()`, extend the `condition` object inside `defaults` to include a `body` array:

```js
condition: {
  url: { type: 'contains', value: '' },
  headers: [],
  methods: [],
  body: [],   // <-- NEW: array of body conditions
},
```

Each body condition object has this shape:

```js
{
  jsonPath: '',       // dot-notation path, e.g. "filters.airline" or "items[0].id"
  type: 'equals',     // one of BODY_MATCH_TYPES: 'equals', 'contains', 'regex', 'exists'
  value: '',          // the value to compare against (ignored when type is 'exists')
}
```

## Implementation

### 1. JSON Path Resolver (`content/interceptor-inject.js`)

Add this function in the Helpers section (after `postLog()`, before `findMatchingRule()`):

```js
/**
 * Resolve a simple JSON path (dot notation with array indexing) against an object.
 *
 * Supported syntax:
 *   - Dot notation:   "filters.airline"
 *   - Array indexing:  "items[0].id"
 *   - Nested arrays:  "data.results[2].nested[0].value"
 *
 * Returns { found: true, value: <resolved> } or { found: false }.
 *
 * @param {Object} obj       The parsed JSON object to traverse.
 * @param {string} path      The dot-notation JSON path.
 * @returns {{ found: boolean, value?: * }}
 */
function resolveJsonPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path === '') {
    return { found: false };
  }

  // Tokenize: split on dots, but also split array indices.
  // "items[0].id" -> ["items", "0", "id"]
  // "filters.airline" -> ["filters", "airline"]
  const tokens = [];
  const segments = path.split('.');

  for (const segment of segments) {
    // Handle array brackets: "items[0]" -> "items", "0"
    // Also handles multiple brackets: "a[0][1]" -> "a", "0", "1"
    const bracketPattern = /([^[]*?)(?:\[(\d+)\])/g;
    let match;
    let lastIndex = 0;
    let hadBracket = false;

    while ((match = bracketPattern.exec(segment)) !== null) {
      hadBracket = true;
      // The part before the bracket (could be empty string for chained brackets)
      if (match[1]) {
        tokens.push(match[1]);
      }
      // The index inside brackets
      tokens.push(match[2]);
      lastIndex = bracketPattern.lastIndex;
    }

    if (!hadBracket) {
      // No brackets in this segment -- use it directly
      if (segment) tokens.push(segment);
    } else if (lastIndex < segment.length) {
      // Trailing text after last bracket (unlikely but handle gracefully)
      const trailing = segment.slice(lastIndex);
      if (trailing) tokens.push(trailing);
    }
  }

  let current = obj;
  for (const token of tokens) {
    if (current == null || typeof current !== 'object') {
      return { found: false };
    }

    // For array indices, token is a numeric string -- coerce to number for arrays
    if (Array.isArray(current)) {
      const index = parseInt(token, 10);
      if (isNaN(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      if (!(token in current)) {
        return { found: false };
      }
      current = current[token];
    }
  }

  return { found: true, value: current };
}
```

### 2. Body Matching Logic (`content/interceptor-inject.js`)

Add this function after `resolveJsonPath`:

```js
/**
 * Check whether a parsed JSON body satisfies a single body condition.
 *
 * @param {Object} parsedBody   The parsed JSON request body.
 * @param {Object} condition    { jsonPath, type, value }
 * @returns {boolean}
 */
function matchBodyCondition(parsedBody, condition) {
  if (!condition || !condition.jsonPath) return false;

  const result = resolveJsonPath(parsedBody, condition.jsonPath);

  switch (condition.type) {
    case 'exists':
      return result.found;

    case 'equals': {
      if (!result.found) return false;
      const actual = typeof result.value === 'object'
        ? JSON.stringify(result.value)
        : String(result.value);
      return actual === condition.value;
    }

    case 'contains': {
      if (!result.found) return false;
      const actual = typeof result.value === 'object'
        ? JSON.stringify(result.value)
        : String(result.value);
      return actual.includes(condition.value);
    }

    case 'regex': {
      if (!result.found) return false;
      try {
        const actual = typeof result.value === 'object'
          ? JSON.stringify(result.value)
          : String(result.value);
        return new RegExp(condition.value).test(actual);
      } catch (e) {
        return false;
      }
    }

    default:
      return false;
  }
}
```

### 3. Integrate into `matchesRule()` (`content/interceptor-inject.js`)

Modify the `matchesRule` function signature and body. The function currently takes `(url, method, headers, rule)`. Add a 5th parameter `requestBody`:

```js
/**
 * Evaluate whether a request matches a rule's conditions.
 * Conditions are ANDed: URL, method, headers, and body conditions must all match.
 */
function matchesRule(url, method, headers, rule, requestBody) {
  const cond = rule.condition || {};

  // URL match
  if (cond.url && cond.url.value) {
    if (!matchUrl(url, cond.url.type || 'contains', cond.url.value)) return false;
  }

  // Method match
  if (cond.methods && cond.methods.length > 0) {
    if (!cond.methods.includes(method.toUpperCase())) return false;
  }

  // Header matches (AND logic)
  if (cond.headers && cond.headers.length > 0) {
    for (const hc of cond.headers) {
      const headerVal = headers?.[hc.name] || headers?.[hc.name.toLowerCase()] || '';
      if (!matchUrl(headerVal, hc.type || 'contains', hc.value)) return false;
    }
  }

  // Body matches (AND logic) -- NEW
  if (cond.body && cond.body.length > 0 && requestBody != null) {
    // Only parse JSON if Content-Type indicates JSON
    let parsedBody = null;
    if (typeof requestBody === 'string') {
      try { parsedBody = JSON.parse(requestBody); } catch (e) { /* not JSON */ }
    } else if (typeof requestBody === 'object') {
      parsedBody = requestBody;
    }

    if (parsedBody === null) {
      // Body conditions exist but body is not valid JSON -- no match
      return false;
    }

    for (const bc of cond.body) {
      if (!matchBodyCondition(parsedBody, bc)) return false;
    }
  }

  return true;
}
```

### 4. Pass Request Body Through the Matching Pipeline (`content/interceptor-inject.js`)

#### Update `findMatchingRule`

Add a 4th parameter `requestBody`:

```js
function findMatchingRule(url, method, headers, requestBody) {
  if (!enabled || rules.length === 0) return null;

  const sorted = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of sorted) {
    if (matchesRule(url, method, headers, rule, requestBody)) {
      return rule;
    }
  }
  return null;
}
```

#### Update fetch override

In the `window.fetch` override, extract the body from init and pass it to `findMatchingRule`:

```js
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string'
    ? input
    : input instanceof Request
      ? input.url
      : String(input);
  const method = init.method || (input instanceof Request ? input.method : 'GET');
  const headers = init.headers || {};
  const startTime = performance.now();

  // Extract request body for body matching
  let requestBody = init.body || null;
  if (input instanceof Request && !requestBody) {
    // Clone the request to read the body without consuming it
    try {
      requestBody = await input.clone().text();
    } catch (e) { /* body not readable */ }
  }

  // Check rules first (higher priority)
  const matchedRule = findMatchingRule(url, method, headers, requestBody);

  // ... rest of fetch override unchanged ...
};
```

#### Update XHR `send` override

In `XMLHttpRequest.prototype.send`, the `body` parameter is already available. Pass it through:

```js
XMLHttpRequest.prototype.send = function (body) {
  const url = this._neuronUrl;
  const method = this._neuronMethod || 'GET';
  const headers = this._neuronHeaders || {};
  const startTime = performance.now();
  const xhr = this;

  // Pass body to rule matching
  const matchedRule = findMatchingRule(url, method, headers, body);
  const matchedMock = !matchedRule ? findMatchingMock(url, method) : null;

  // ... rest of XHR send override unchanged ...
};
```

### 5. Rule Form UI (`options/components/rule-form.js`)

#### Add import

At the top of the file, add `BODY_MATCH_TYPES` to the import:

```js
import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  BODY_MATCH_TYPES,   // <-- NEW
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
} from '../../shared/constants.js';
```

#### Add body conditions UI in `_buildConditionsSection()`

After the headers container section (after `section.appendChild(headersContainer);`), add the body conditions block:

```js
  // Body conditions (dynamic list)
  const bodyContainer = document.createElement('div');
  bodyContainer.id = 'ni-condition-body';
  bodyContainer.style.cssText = 'display:flex; flex-direction:column; gap:6px;';

  const bodyLabel = document.createElement('div');
  bodyLabel.style.cssText =
    'display:flex; align-items:center; justify-content:space-between;';
  const bl = document.createElement('span');
  bl.textContent = 'Request Body (JSON)';
  bl.style.cssText = 'font-size:13px; color:#9ca3af;';
  const addBodyBtn = _smallButton('+ Add', () => {
    _appendBodyConditionRow(bodyList, { jsonPath: '', type: BODY_MATCH_TYPES.EQUALS, value: '' });
  });
  bodyLabel.appendChild(bl);
  bodyLabel.appendChild(addBodyBtn);
  bodyContainer.appendChild(bodyLabel);

  const bodyHint = document.createElement('div');
  bodyHint.style.cssText = 'font-size:11px; color:#6b7280; margin-bottom:4px;';
  bodyHint.textContent = 'Match JSON fields in POST/PUT/PATCH request bodies. Use dot notation: filters.airline, items[0].id';
  bodyContainer.appendChild(bodyHint);

  const bodyList = document.createElement('div');
  bodyList.id = 'ni-body-list';
  bodyList.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
  bodyContainer.appendChild(bodyList);

  // Pre-populate existing body conditions
  const existingBody = _editingRule?.condition?.body || [];
  existingBody.forEach((b) => _appendBodyConditionRow(bodyList, b));

  section.appendChild(bodyContainer);
```

#### Add body condition row helper

Add this new function after `_appendHeaderRow()`:

```js
/**
 * Append one body condition row to the given container.
 * @param {HTMLElement} container
 * @param {{ jsonPath: string, type: string, value: string }} condition
 */
function _appendBodyConditionRow(container, condition) {
  const row = document.createElement('div');
  row.className = 'ni-body-row';
  row.style.cssText = 'display:flex; gap:6px; align-items:center;';

  // JSON path input
  const pathIn = _input('text', '', '$.filters.airline');
  pathIn.className = 'ni-body-path';
  pathIn.value = condition.jsonPath || '';
  pathIn.style.flex = '1';
  pathIn.title = 'JSON path (dot notation)';

  // Match type select
  const typeSelect = document.createElement('select');
  typeSelect.className = 'ni-body-type';
  _applySelectStyle(typeSelect);
  for (const [, val] of Object.entries(BODY_MATCH_TYPES)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    if ((condition.type || BODY_MATCH_TYPES.EQUALS) === val) opt.selected = true;
    typeSelect.appendChild(opt);
  }

  // Value input (hidden when type is 'exists')
  const valIn = _input('text', '', 'Expected value');
  valIn.className = 'ni-body-value';
  valIn.value = condition.value || '';
  valIn.style.flex = '1';

  // Hide value field when 'exists' is selected
  if (condition.type === 'exists') {
    valIn.style.display = 'none';
  }
  typeSelect.addEventListener('change', () => {
    valIn.style.display = typeSelect.value === 'exists' ? 'none' : '';
  });

  // Remove button
  const removeBtn = _smallButton('\u2715', () => row.remove());
  removeBtn.style.color = '#ef4444';

  row.appendChild(pathIn);
  row.appendChild(typeSelect);
  row.appendChild(valIn);
  row.appendChild(removeBtn);
  container.appendChild(row);
}
```

#### Update `_collectRule()` to gather body conditions

Inside `_collectRule()`, after the headers collection block (after the `rule.condition.headers = ...` line), add:

```js
  // Conditions - Body
  rule.condition.body = Array.from(
    _container.querySelectorAll('#ni-body-list .ni-body-row'),
  ).map((row) => ({
    jsonPath: row.querySelector('.ni-body-path')?.value || '',
    type: row.querySelector('.ni-body-type')?.value || BODY_MATCH_TYPES.EQUALS,
    value: row.querySelector('.ni-body-value')?.value || '',
  })).filter((b) => b.jsonPath);
```

## CSS

Add to `options/options.css` at the end, before the disabled-body state section:

```css
/* -------------------------------------------------------------------------- */
/*  Body Condition Rows                                                       */
/* -------------------------------------------------------------------------- */

.ni-body-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.ni-body-row select {
  min-width: 90px;
}

.ni-body-row input {
  min-width: 0;
}
```

## Example Usage

### Rule: Match when `filters.airline` equals "AA"

```json
{
  "name": "Mock AA Fleet Summary",
  "condition": {
    "url": { "type": "contains", "value": "/api/fleet-summary" },
    "methods": ["POST"],
    "headers": [],
    "body": [
      {
        "jsonPath": "filters.airline",
        "type": "equals",
        "value": "AA"
      }
    ]
  },
  "action": {
    "type": "mock_inline",
    "mockInline": {
      "statusCode": 200,
      "headers": { "Content-Type": "application/json" },
      "body": "{\"tails\": 100, \"airline\": \"AA\"}"
    }
  }
}
```

### Rule: Match when `items[0].id` exists

```json
{
  "condition": {
    "url": { "type": "contains", "value": "/api/batch" },
    "methods": ["POST"],
    "body": [
      {
        "jsonPath": "items[0].id",
        "type": "exists",
        "value": ""
      }
    ]
  }
}
```

### Rule: Match when `query` contains "SELECT"

```json
{
  "condition": {
    "url": { "type": "contains", "value": "/api/query" },
    "methods": ["POST"],
    "body": [
      {
        "jsonPath": "query",
        "type": "contains",
        "value": "SELECT"
      }
    ]
  }
}
```

## Verification Steps

### Manual Testing

1. **Load the extension** in `chrome://extensions` (developer mode, load unpacked).

2. **Create a body-matching rule**:
   - Open Options page.
   - Click "New Rule".
   - Name: "Test Body Match".
   - URL: contains `/api/test`.
   - Methods: check POST.
   - In the "Request Body (JSON)" section, click "+ Add".
   - JSON Path: `filters.airline`, Type: `equals`, Value: `AA`.
   - Action: Mock Inline, Body: `{"matched": true}`.
   - Save.

3. **Test in browser console**:
   ```js
   // Should return mocked response
   fetch('/api/test', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ filters: { airline: 'AA' } })
   }).then(r => r.json()).then(console.log);
   // Expected: { matched: true }

   // Should NOT match (different airline)
   fetch('/api/test', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ filters: { airline: 'UA' } })
   }).then(r => r.json()).then(console.log);
   // Expected: real server response (or network error)
   ```

4. **Test `exists` type**:
   - Create rule with body condition: jsonPath `user.id`, type `exists`.
   - POST with `{ user: { id: 123 } }` -- should match.
   - POST with `{ user: { name: "test" } }` -- should NOT match.

5. **Test array indexing**:
   - Create rule with body condition: jsonPath `items[0].type`, type `equals`, value `widget`.
   - POST with `{ items: [{ type: "widget" }] }` -- should match.
   - POST with `{ items: [{ type: "gadget" }] }` -- should NOT match.

6. **Test `contains` type**:
   - Create rule with body condition: jsonPath `query`, type `contains`, value `SELECT`.
   - POST with `{ query: "SELECT * FROM tails" }` -- should match.
   - POST with `{ query: "INSERT INTO tails" }` -- should NOT match.

7. **Test `regex` type**:
   - Create rule with body condition: jsonPath `email`, type `regex`, value `@example\\.com$`.
   - POST with `{ email: "user@example.com" }` -- should match.
   - POST with `{ email: "user@other.com" }` -- should NOT match.

8. **Test non-JSON body**:
   - Rule with body conditions should NOT match requests with non-JSON bodies (form data, plain text).

9. **Test multiple body conditions (AND logic)**:
   - Create rule with two body conditions.
   - Verify both must match for the rule to fire.

10. **Test XHR interception**:
    ```js
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/test');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() { console.log(xhr.responseText); };
    xhr.send(JSON.stringify({ filters: { airline: 'AA' } }));
    // Expected: mocked response
    ```

11. **Verify existing rules without body conditions** still work exactly as before (no regression).

12. **Verify the rule form** properly saves and loads body conditions when editing an existing rule.

### Edge Cases to Verify

- Empty body conditions array -- rule should match (body matching is skipped).
- Body condition with empty `jsonPath` -- should be filtered out during collection.
- Deeply nested paths: `a.b.c.d.e[0].f` -- should resolve correctly.
- JSON path pointing to a boolean or number -- `equals` should compare stringified values.
- JSON path pointing to a nested object -- `equals` should compare `JSON.stringify(value)`.
- Request with no body (GET request) -- body conditions should be skipped (rule can still match on URL/method/headers alone if no body conditions are defined).
