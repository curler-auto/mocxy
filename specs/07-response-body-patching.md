# Feature 1.7 — Response Body Patching

## Summary

Add a new action type `patch_response` that fetches the real API response, parses its JSON body, applies a series of patch operations (set, delete, merge) to specific fields, and returns the modified response. Unlike `mock_inline` which replaces the entire body, this allows surgically modifying individual fields while preserving the rest of the real data.

## Why

Full response mocking (`mock_inline`) requires maintaining an entire response body, which is fragile and impractical for large API responses (e.g., a fleet summary with hundreds of tails). Response patching lets developers and testers:

- Override a single field (e.g., set `data.totalCount` to 0 to test empty-state UI)
- Remove sensitive fields before passing to UI (e.g., delete `data.users[0].email`)
- Merge additional data into a real response (e.g., add a mock alert object)
- Test edge cases without maintaining full mock snapshots

This is especially valuable in the Neuron NMS test suite where API responses are complex JSON structures and only specific field values need modification for scenario testing.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Tech**: Chrome Extension MV3, vanilla JS (ES modules), no build step
- **Theme**: Dark (Catppuccin Mocha palette), CSS variables in `options/options.css`
- **Interception**: Dual layer -- DNR (fast-path redirects) + fetch/XHR override (`content/interceptor-inject.js`)
- **Data model**: Factory functions in `shared/data-models.js`, constants in `shared/constants.js`
- **Rule form**: `options/components/rule-form.js` builds the rule editor modal dynamically
- **JSON path resolver**: If Feature 1.6 (Request Body Matching) is implemented first, reuse `resolveJsonPath()` from `interceptor-inject.js`. Otherwise, implement the same function as described below.

## Files to Modify

| File | Change |
|------|--------|
| `shared/constants.js` | Add `ACTION_TYPES.PATCH_RESPONSE` and `PATCH_OPS` constant |
| `shared/data-models.js` | Add `action.patchResponse` field to `createRule` defaults |
| `content/interceptor-inject.js` | Add `setJsonPath()`, `deleteJsonPath()`, `deepMergeAtPath()`, `applyPatchAction()` functions; add `patch_response` case to `applyAction()` and XHR send override |
| `options/components/rule-form.js` | Add patch response sub-form with patch list editor; update `_buildActionSection()`, `_collectRule()`, `_toggleActionSub()` |
| `options/options.css` | Add styles for patch editor rows |

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
  PATCH_RESPONSE: 'patch_response',   // <-- NEW
};
```

Add a new constant for patch operations:

```js
/** Supported response patch operations. */
export const PATCH_OPS = {
  SET: 'set',
  DELETE: 'delete',
  MERGE: 'merge',
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
  patchResponse: {       // <-- NEW
    patches: [],
  },
},
```

Each patch object in the `patches` array has this shape:

```js
{
  op: 'set',           // one of PATCH_OPS: 'set', 'delete', 'merge'
  path: '',            // dot-notation JSON path, e.g. "data.users[0].name"
  value: '',           // stringified value for 'set'; JSON string for 'merge'; ignored for 'delete'
}
```

## Implementation

### 1. JSON Path Resolver and Mutators (`content/interceptor-inject.js`)

If Feature 1.6 has already been implemented, `resolveJsonPath()` will already exist. The following functions are **new** and should be added in the Helpers section.

#### `resolveJsonPath()` (only if not already present from Feature 1.6)

```js
/**
 * Resolve a simple JSON path (dot notation with array indexing) against an object.
 * Returns { found: true, value: <resolved> } or { found: false }.
 */
function resolveJsonPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path === '') {
    return { found: false };
  }

  const tokens = _tokenizePath(path);
  let current = obj;

  for (const token of tokens) {
    if (current == null || typeof current !== 'object') {
      return { found: false };
    }
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

#### Path tokenizer (shared between resolve/set/delete)

```js
/**
 * Tokenize a dot-notation JSON path into individual property/index tokens.
 * "items[0].name" -> ["items", "0", "name"]
 */
function _tokenizePath(path) {
  const tokens = [];
  const segments = path.split('.');

  for (const segment of segments) {
    const bracketPattern = /([^[]*?)(?:\[(\d+)\])/g;
    let match;
    let lastIndex = 0;
    let hadBracket = false;

    while ((match = bracketPattern.exec(segment)) !== null) {
      hadBracket = true;
      if (match[1]) tokens.push(match[1]);
      tokens.push(match[2]);
      lastIndex = bracketPattern.lastIndex;
    }

    if (!hadBracket) {
      if (segment) tokens.push(segment);
    } else if (lastIndex < segment.length) {
      const trailing = segment.slice(lastIndex);
      if (trailing) tokens.push(trailing);
    }
  }

  return tokens;
}
```

#### `setJsonPath()` -- set a value at a path

```js
/**
 * Set a value at a JSON path in the object, creating intermediate objects/arrays as needed.
 * Mutates the original object.
 *
 * @param {Object} obj    The root object.
 * @param {string} path   Dot-notation path.
 * @param {*}      value  The value to set.
 * @returns {boolean}     True if set succeeded.
 */
function setJsonPath(obj, path, value) {
  if (obj == null || typeof path !== 'string' || path === '') return false;

  const tokens = _tokenizePath(path);
  if (tokens.length === 0) return false;

  let current = obj;

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    const nextIsIndex = /^\d+$/.test(nextToken);

    if (Array.isArray(current)) {
      const index = parseInt(token, 10);
      if (isNaN(index)) return false;
      // Ensure the slot exists
      while (current.length <= index) current.push(undefined);
      if (current[index] == null || typeof current[index] !== 'object') {
        current[index] = nextIsIndex ? [] : {};
      }
      current = current[index];
    } else {
      if (current[token] == null || typeof current[token] !== 'object') {
        current[token] = nextIsIndex ? [] : {};
      }
      current = current[token];
    }
  }

  const lastToken = tokens[tokens.length - 1];
  if (Array.isArray(current)) {
    const index = parseInt(lastToken, 10);
    if (isNaN(index)) return false;
    while (current.length <= index) current.push(undefined);
    current[index] = value;
  } else {
    current[lastToken] = value;
  }

  return true;
}
```

#### `deleteJsonPath()` -- remove a field at a path

```js
/**
 * Delete a value at a JSON path in the object.
 * Mutates the original object.
 *
 * @param {Object} obj   The root object.
 * @param {string} path  Dot-notation path.
 * @returns {boolean}    True if deletion succeeded (field existed).
 */
function deleteJsonPath(obj, path) {
  if (obj == null || typeof path !== 'string' || path === '') return false;

  const tokens = _tokenizePath(path);
  if (tokens.length === 0) return false;

  let current = obj;

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (current == null || typeof current !== 'object') return false;

    if (Array.isArray(current)) {
      const index = parseInt(token, 10);
      if (isNaN(index) || index >= current.length) return false;
      current = current[index];
    } else {
      if (!(token in current)) return false;
      current = current[token];
    }
  }

  const lastToken = tokens[tokens.length - 1];
  if (current == null || typeof current !== 'object') return false;

  if (Array.isArray(current)) {
    const index = parseInt(lastToken, 10);
    if (isNaN(index) || index >= current.length) return false;
    current.splice(index, 1);
  } else {
    if (!(lastToken in current)) return false;
    delete current[lastToken];
  }

  return true;
}
```

#### `deepMergeAtPath()` -- deep merge an object at a path

```js
/**
 * Deep merge a source object into the value at the given path.
 * If the path doesn't exist or isn't an object, it's set to the source.
 * Mutates the original object.
 *
 * @param {Object} obj     The root object.
 * @param {string} path    Dot-notation path.
 * @param {Object} source  The object to merge.
 * @returns {boolean}
 */
function deepMergeAtPath(obj, path, source) {
  if (obj == null || typeof source !== 'object' || source === null) return false;

  const existing = resolveJsonPath(obj, path);

  if (existing.found && typeof existing.value === 'object' && existing.value !== null && !Array.isArray(existing.value)) {
    // Deep merge into existing object
    _deepMerge(existing.value, source);
    return true;
  } else {
    // Path doesn't exist or isn't an object -- set it directly
    return setJsonPath(obj, path, source);
  }
}

/**
 * Recursive deep merge helper. Mutates target.
 */
function _deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = target[key];

    if (
      sVal !== null &&
      typeof sVal === 'object' &&
      !Array.isArray(sVal) &&
      tVal !== null &&
      typeof tVal === 'object' &&
      !Array.isArray(tVal)
    ) {
      _deepMerge(tVal, sVal);
    } else {
      target[key] = sVal;
    }
  }
}
```

### 2. Patch Action Handler (`content/interceptor-inject.js`)

Add this new function in the Action Execution section, before or after `applyAction`:

```js
/**
 * Apply patch_response action: fetch the real response, parse JSON,
 * apply patches in order, return a new Response with the modified body.
 *
 * @param {Object} rule     The matched rule.
 * @param {string} url      The original request URL.
 * @param {Object} options  The original fetch options.
 * @returns {Promise<{ response: Response, patched: boolean }>}
 */
async function applyPatchAction(rule, url, options) {
  const action = rule.action;
  const patchConfig = action.patchResponse || {};
  const patches = patchConfig.patches || [];

  // 1. Fetch the real response
  const realResponse = await originalFetch(url, options);

  // 2. Clone and read the body as text
  const bodyText = await realResponse.text();

  // 3. Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    console.warn('[Neuron] patch_response: response body is not valid JSON, returning unmodified');
    return {
      response: new Response(bodyText, {
        status: realResponse.status,
        statusText: realResponse.statusText,
        headers: realResponse.headers,
      }),
      patched: false,
    };
  }

  // 4. Apply patches in order
  for (const patch of patches) {
    switch (patch.op) {
      case 'set': {
        // Parse the value: try JSON first, fall back to raw string
        let val;
        try {
          val = JSON.parse(patch.value);
        } catch (e) {
          val = patch.value; // Use as raw string
        }
        setJsonPath(parsed, patch.path, val);
        break;
      }

      case 'delete': {
        deleteJsonPath(parsed, patch.path);
        break;
      }

      case 'merge': {
        let mergeObj;
        try {
          mergeObj = JSON.parse(patch.value);
        } catch (e) {
          console.warn('[Neuron] patch_response: merge value is not valid JSON, skipping patch at', patch.path);
          continue;
        }
        if (typeof mergeObj !== 'object' || mergeObj === null) {
          console.warn('[Neuron] patch_response: merge value is not an object, skipping patch at', patch.path);
          continue;
        }
        deepMergeAtPath(parsed, patch.path, mergeObj);
        break;
      }

      default:
        console.warn('[Neuron] patch_response: unknown op', patch.op);
        break;
    }
  }

  // 5. Build modified response
  const modifiedBody = JSON.stringify(parsed);
  const modifiedResponse = new Response(modifiedBody, {
    status: realResponse.status,
    statusText: realResponse.statusText,
    headers: realResponse.headers,
  });

  console.log('[Neuron] Patch response:', url, patches.length, 'patches applied');
  return { response: modifiedResponse, patched: true };
}
```

### 3. Integrate into `applyAction()` (`content/interceptor-inject.js`)

Add a new case in the `switch (action.type)` block inside `applyAction()`:

```js
case 'patch_response': {
  const result = await applyPatchAction(rule, url, options);
  return result;
}
```

This goes after the existing `case 'delay':` block and before `default:`.

### 4. Integrate into XHR `send` override (`content/interceptor-inject.js`)

Add a new block in the XHR send override to handle `patch_response`. Insert this after the `mock_inline` block and before the `redirect/rewrite` block:

```js
// ----- patch_response via rule -----
if (matchedRule && matchedRule.action.type === 'patch_response') {
  const delay = matchedRule.action.delayMs || 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  // Use fetch to get the real response, then apply patches
  const fetchOpts = { method, headers };
  if (body) fetchOpts.body = body;

  applyPatchAction(matchedRule, url, fetchOpts).then((result) => {
    result.response.text().then((responseText) => {
      simulateXHRResponse(
        xhr,
        result.response.status,
        result.response.statusText || 'OK',
        responseText,
        { 'Content-Type': 'application/json' },
        () => {
          postLog({
            url,
            method,
            statusCode: result.response.status,
            duration: Math.round(performance.now() - startTime),
            matchedRuleId: matchedRule.id,
            matchedRuleName: matchedRule.name,
            actionTaken: 'patch_response',
            intercepted: true,
          });
        }
      );
    });
  }).catch((err) => {
    console.error('[Neuron] XHR patch_response error:', err);
    originalXHRSend.call(xhr, body);
  });
  return;
}
```

**Important**: Because XHR send is synchronous but our patch action is async, we use the fetch API internally to get the response, apply patches, then simulate the XHR response. This is the same pattern used for mock_inline -- we intercept the send and simulate the response asynchronously.

### 5. Rule Form UI (`options/components/rule-form.js`)

#### Add import

Add `PATCH_OPS` to the import from `shared/constants.js`:

```js
import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
  PATCH_OPS,            // <-- NEW
} from '../../shared/constants.js';
```

#### Add patch response sub-form builder

Add this new function alongside the other `_build*Sub()` functions:

```js
function _buildPatchResponseSub() {
  const div = _actionSub(ACTION_TYPES.PATCH_RESPONSE);
  const patchConfig = _editingRule?.action?.patchResponse || {};
  const existingPatches = patchConfig.patches || [];

  // Description
  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:12px; color:#9ca3af; margin-bottom:12px; line-height:1.5;';
  desc.innerHTML =
    'Fetch the real response, then apply patches to the JSON body. ' +
    'Patches are applied in order.<br>' +
    '<strong>set</strong>: Set a field value (auto-parses JSON or uses raw string).<br>' +
    '<strong>delete</strong>: Remove a field.<br>' +
    '<strong>merge</strong>: Deep-merge a JSON object into the field.';
  div.appendChild(desc);

  // Patches header
  const patchHeader = document.createElement('div');
  patchHeader.style.cssText =
    'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
  const patchLabel = document.createElement('span');
  patchLabel.textContent = 'Patches';
  patchLabel.style.cssText = 'font-size:13px; color:#9ca3af; font-weight:600;';

  const patchList = document.createElement('div');
  patchList.id = 'ni-patch-list';
  patchList.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

  const addPatchBtn = _smallButton('+ Add Patch', () => {
    _appendPatchRow(patchList, { op: PATCH_OPS.SET, path: '', value: '' });
  });

  patchHeader.appendChild(patchLabel);
  patchHeader.appendChild(addPatchBtn);
  div.appendChild(patchHeader);
  div.appendChild(patchList);

  // Pre-populate existing patches
  existingPatches.forEach((p) => _appendPatchRow(patchList, p));

  return div;
}
```

#### Add patch row helper

```js
/**
 * Append one patch operation row to the given container.
 * @param {HTMLElement} container
 * @param {{ op: string, path: string, value: string }} patch
 */
function _appendPatchRow(container, patch) {
  const row = document.createElement('div');
  row.className = 'ni-patch-row';
  row.style.cssText =
    'display:flex; flex-direction:column; gap:6px; padding:10px; ' +
    'border:1px solid #1f2937; border-radius:6px; background:#0f172a;';

  // Top row: op + path + remove
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

  // Op selector
  const opSelect = document.createElement('select');
  opSelect.className = 'ni-patch-op';
  _applySelectStyle(opSelect);
  opSelect.style.minWidth = '80px';
  for (const [, val] of Object.entries(PATCH_OPS)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    if ((patch.op || PATCH_OPS.SET) === val) opt.selected = true;
    opSelect.appendChild(opt);
  }

  // Path input
  const pathIn = _input('text', '', 'data.users[0].name');
  pathIn.className = 'ni-patch-path';
  pathIn.value = patch.path || '';
  pathIn.style.flex = '1';
  pathIn.title = 'JSON path (dot notation)';

  // Remove button
  const removeBtn = _smallButton('\u2715', () => row.remove());
  removeBtn.style.color = '#ef4444';

  topRow.appendChild(opSelect);
  topRow.appendChild(pathIn);
  topRow.appendChild(removeBtn);
  row.appendChild(topRow);

  // Value row (hidden for 'delete' op)
  const valueRow = document.createElement('div');
  valueRow.style.cssText = 'display:flex; gap:6px; align-items:flex-start;';

  const valueLabel = document.createElement('span');
  valueLabel.textContent = 'Value:';
  valueLabel.style.cssText = 'font-size:12px; color:#6b7280; min-width:46px; padding-top:8px;';

  const valueArea = document.createElement('textarea');
  valueArea.className = 'ni-patch-value';
  valueArea.rows = 2;
  valueArea.style.cssText = `
    flex:1; padding:6px 10px; border:1px solid #374151; border-radius:6px;
    background:#1f2937; color:#e5e7eb; font-family:monospace; font-size:12px;
    resize:vertical; box-sizing:border-box;
  `;
  valueArea.placeholder = patch.op === 'merge' ? '{"key": "value"}' : 'New value';
  valueArea.value = patch.value || '';

  valueRow.appendChild(valueLabel);
  valueRow.appendChild(valueArea);
  row.appendChild(valueRow);

  // Toggle value visibility based on op
  if (patch.op === 'delete') {
    valueRow.style.display = 'none';
  }

  opSelect.addEventListener('change', () => {
    const isDelete = opSelect.value === 'delete';
    valueRow.style.display = isDelete ? 'none' : 'flex';
    if (opSelect.value === 'merge') {
      valueArea.placeholder = '{"key": "value"}';
    } else {
      valueArea.placeholder = 'New value';
    }
  });

  container.appendChild(row);
}
```

#### Register the sub-form in `_buildActionSection()`

In `_buildActionSection()`, after the line `subContainer.appendChild(_buildDelaySub());`, add:

```js
subContainer.appendChild(_buildPatchResponseSub());
```

#### Update `_collectRule()` to gather patches

Inside `_collectRule()`, after the `rule.action.delayMs` line, add:

```js
  // Patch response
  rule.action.patchResponse = {
    patches: Array.from(
      _container.querySelectorAll('#ni-patch-list .ni-patch-row'),
    ).map((row) => ({
      op: row.querySelector('.ni-patch-op')?.value || PATCH_OPS.SET,
      path: row.querySelector('.ni-patch-path')?.value || '',
      value: row.querySelector('.ni-patch-value')?.value || '',
    })).filter((p) => p.path),  // Filter out rows with empty paths
  };
```

#### Update `_defaultRule()` to include patchResponse

In the `_defaultRule()` function, add to the `action` object:

```js
patchResponse: {
  patches: [],
},
```

## CSS

Add to `options/options.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Patch Response Rows                                                       */
/* -------------------------------------------------------------------------- */

.ni-patch-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
  padding: 10px;
  transition: border-color var(--transition);
}

.ni-patch-row:hover {
  border-color: var(--surface-hover);
}

.ni-patch-row select {
  min-width: 80px;
}

.ni-patch-row textarea {
  min-height: 36px;
}
```

## Example Usage

### Example 1: Set a field value

Override the total tail count to 0 in a fleet summary response:

```json
{
  "name": "Empty fleet summary",
  "condition": {
    "url": { "type": "contains", "value": "/api/fleet-summary" },
    "methods": ["POST"]
  },
  "action": {
    "type": "patch_response",
    "patchResponse": {
      "patches": [
        { "op": "set", "path": "data.totalTails", "value": "0" },
        { "op": "set", "path": "data.tails", "value": "[]" }
      ]
    }
  }
}
```

### Example 2: Delete sensitive fields

```json
{
  "name": "Strip user emails",
  "condition": {
    "url": { "type": "contains", "value": "/api/users" }
  },
  "action": {
    "type": "patch_response",
    "patchResponse": {
      "patches": [
        { "op": "delete", "path": "data.users[0].email" },
        { "op": "delete", "path": "data.users[0].phone" }
      ]
    }
  }
}
```

### Example 3: Deep merge additional data

```json
{
  "name": "Add mock alert",
  "condition": {
    "url": { "type": "contains", "value": "/api/dashboard" }
  },
  "action": {
    "type": "patch_response",
    "patchResponse": {
      "patches": [
        {
          "op": "merge",
          "path": "data.alerts",
          "value": "{\"critical\": 5, \"warning\": 10}"
        }
      ]
    }
  }
}
```

### Example 4: Combined operations

```json
{
  "name": "Modify response for edge case testing",
  "condition": {
    "url": { "type": "contains", "value": "/api/kpi" }
  },
  "action": {
    "type": "patch_response",
    "delayMs": 500,
    "patchResponse": {
      "patches": [
        { "op": "set", "path": "data.status", "value": "\"CRITICAL\"" },
        { "op": "delete", "path": "data.metadata.cacheKey" },
        { "op": "merge", "path": "data.counts", "value": "{\"active\": 0, \"inactive\": 100}" }
      ]
    }
  }
}
```

## Verification Steps

### Manual Testing

1. **Load the extension** in `chrome://extensions` (developer mode, load unpacked).

2. **Create a patch response rule**:
   - Open Options page.
   - Click "New Rule".
   - Name: "Test Patch".
   - URL: contains `/api/`.
   - Action type: `patch response` (select from dropdown).
   - Click "+ Add Patch".
   - Op: `set`, Path: `data.count`, Value: `42`.
   - Click "+ Add Patch" again.
   - Op: `delete`, Path: `data.debug`.
   - Save.

3. **Test in browser console** (on a page that has a real API endpoint):
   ```js
   // The response should have data.count=42 and data.debug removed
   fetch('/api/some-endpoint')
     .then(r => r.json())
     .then(data => {
       console.log('count:', data.data?.count);  // Should be 42
       console.log('debug:', data.data?.debug);   // Should be undefined
     });
   ```

4. **Test the `set` operation**:
   - Set a string value: Path `name`, Value `"TestUser"` -- result should be the string `"TestUser"`.
   - Set a number value: Path `count`, Value `42` -- result should be the number 42.
   - Set an array value: Path `items`, Value `[1,2,3]` -- result should be the array [1,2,3].
   - Set a nested path that doesn't exist yet: Path `a.b.c`, Value `"deep"` -- intermediate objects should be created.

5. **Test the `delete` operation**:
   - Delete a top-level field.
   - Delete a nested field.
   - Delete an array element (should use splice, removing the element and shifting subsequent indices).
   - Delete a non-existent path -- should not error.

6. **Test the `merge` operation**:
   - Merge into an existing object -- existing keys should be preserved, new keys added, overlapping keys overwritten.
   - Merge into a non-existent path -- the object should be created.
   - Merge with invalid JSON value -- should be skipped with a console warning.

7. **Test with non-JSON response**:
   - Rule should pass through the unmodified response if the body is not valid JSON.
   - Console should show a warning.

8. **Test patch ordering**:
   - Create two patches: first `set` a field, then `delete` it.
   - Verify the field is deleted (patches apply in order).

9. **Test with delay**:
   - Set `delayMs` to 1000 on the rule.
   - Verify the response is delayed by ~1 second before being returned with patches applied.

10. **Test XHR interception**:
    ```js
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/some-endpoint');
    xhr.onload = function() {
      const data = JSON.parse(xhr.responseText);
      console.log('patched:', data);
    };
    xhr.send();
    ```

11. **Verify existing action types** still work correctly (no regression).

12. **Test the form UI**:
    - Create a rule with patches, save, then edit -- patches should be pre-populated.
    - Toggle between `set`/`delete`/`merge` -- value field should show/hide correctly.
    - Add multiple patches, remove some, save -- only non-empty patches should be saved.
    - Verify the op dropdown updates the value placeholder text.

### Edge Cases to Verify

- Empty patches array -- should fetch and return the real response unmodified.
- Patch with empty path -- should be filtered out during collection.
- `set` with a value that looks like JSON but isn't valid (e.g., `{bad}`) -- should be set as a raw string.
- `merge` with a non-object JSON value (e.g., `"hello"`) -- should be skipped with a warning.
- Response with empty body -- should handle gracefully.
- Very large response body -- should still work (no size limit).
- Multiple rules matching the same request -- only the highest priority rule's patches should be applied (normal rule priority behavior).
