# Feature 1.5: GraphQL Operation Matching

## Summary

Add the ability to match rules based on GraphQL operation name, extracted from the request body of POST requests to GraphQL endpoints. This allows users to create rules that target specific GraphQL operations (e.g., mock `GetUsers` but let `GetOrders` pass through), even though all operations share the same `/graphql` URL.

## Why

Modern apps heavily use GraphQL. All requests go to the same URL (e.g., `/graphql`), so URL matching alone cannot differentiate between operations. The request body contains an `operationName` field that uniquely identifies the operation. Without this feature, users must mock ALL requests to `/graphql` or none.

## Codebase Context

The extension uses a Manifest V3 Chrome Extension architecture with ES modules. All source lives under `health_check/utils/neuron-interceptor-plugin/`. Key facts:

### Data Model (`shared/data-models.js`)

The `createRule()` function (line 15) defines the rule shape. The `condition` object currently has:

```javascript
condition: {
  url: { type: 'contains', value: '' },
  headers: [],
  methods: [],
}
```

The `_mergeDeep()` helper (line 132) recursively merges partial overrides into defaults, so adding a new `graphql` key to the condition defaults will automatically be included in new rules while existing rules (without the key) will still work.

### Content-Script Interceptor (`content/interceptor-inject.js`)

This is an IIFE that runs in the MAIN world. It overrides `window.fetch` and `XMLHttpRequest`.

Key functions:
- `findMatchingRule(url, method, headers)` (line 67): Currently takes 3 args. It filters enabled rules, sorts by priority, and calls `matchesRule()` for each.
- `matchesRule(url, method, headers, rule)` (line 148): Evaluates URL, method, and header conditions. Returns boolean.
- `matchUrl(url, type, value)` (line 107): String matching helper (equals/contains/regex/glob).
- `globToRegex(glob)` (line 127): Converts glob to regex.

**fetch override** (line 285): Calls `findMatchingRule(url, method, headers)`. The request body is available as `init.body` (where `init` is the second arg to `fetch(input, init)`).

**XHR.send override** (line 408): Has `body` as the argument to `send(body)`. Calls `findMatchingRule(url, method, headers)` -- does NOT currently pass body.

### Service Worker Rule Engine (`service-worker/rule-engine.js`)

ES module with:
- `matchCondition(requestInfo, condition)` (line 88): Takes `requestInfo` object `{ url, method, headers }`. Calls `matchUrlCondition`, `matchHeaderConditions`, `matchMethodCondition`.
- `evaluateRules(requestInfo, rules)` (line 143): Iterates sorted rules, calls `matchCondition()`.

This module handles DNR-level evaluation. For GraphQL, we need to extend `matchCondition` to also check `requestInfo.graphqlOperationName`.

### Rule Form (`options/components/rule-form.js`)

- `_buildConditionsSection()` (line 160): Builds the URL row, Methods checkboxes, and Headers list.
- `_collectRule()` (line 619): Reads form state into a rule object.
- `open(rule)` (line 882): Populates form from rule object.
- Imports: `URL_MATCH_TYPES`, `HEADER_MATCH_TYPES`, `HTTP_METHODS`, `ACTION_TYPES`, `MOCK_SERVER_MODES` from constants.

### Constants (`shared/constants.js`)

Already has `URL_MATCH_TYPES`, `HEADER_MATCH_TYPES`, etc.

## Files to Modify

1. **`shared/constants.js`** -- Add `GRAPHQL_MATCH_TYPES` constant.
2. **`shared/data-models.js`** -- Extend the default condition in `createRule()` with a `graphql` field.
3. **`content/interceptor-inject.js`** -- Pass request body to matching, add GraphQL condition evaluation.
4. **`service-worker/rule-engine.js`** -- Add GraphQL condition check to `matchCondition()`.
5. **`options/components/rule-form.js`** -- Add GraphQL section to condition builder, read/write in `_collectRule()` and `open()`.

## Implementation

### Step 1: Add `GRAPHQL_MATCH_TYPES` to `shared/constants.js`

After the `HEADER_MATCH_TYPES` block (line 41), add:

```javascript
/** Supported GraphQL operation name matching strategies. */
export const GRAPHQL_MATCH_TYPES = {
  EQUALS: 'equals',
  CONTAINS: 'contains',
  REGEX: 'regex',
};
```

### Step 2: Extend condition model in `shared/data-models.js`

In the `createRule()` function, update the `condition` defaults from:

```javascript
condition: {
  url: { type: 'contains', value: '' },
  headers: [],
  methods: [],
},
```

to:

```javascript
condition: {
  url: { type: 'contains', value: '' },
  headers: [],
  methods: [],
  graphql: {
    operationName: { type: 'equals', value: '' },
  },
},
```

Because `_mergeDeep()` only deep-merges plain objects and existing saved rules won't have a `graphql` key, the matching code must treat `undefined`/missing `graphql` as "no GraphQL condition" (i.e., always match). This is already handled by the guard clauses we'll add.

### Step 3: Update `content/interceptor-inject.js`

#### 3a. Add `extractGraphQLOperationName` helper

Add this function after the existing `globToRegex()` function (after line 138):

```javascript
  /**
   * Extract the GraphQL operationName from a request body.
   * Returns the operation name string, or null if not found/parseable.
   */
  function extractGraphQLOperationName(body) {
    if (!body) return null;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      // Handle single operation
      if (parsed.operationName) return parsed.operationName;
      // Handle batched operations (array of operations) - use first
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].operationName) {
        return parsed[0].operationName;
      }
      return null;
    } catch (_) {
      return null;
    }
  }
```

#### 3b. Modify `findMatchingRule` to accept `body`

Change the signature from:

```javascript
function findMatchingRule(url, method, headers) {
```

to:

```javascript
function findMatchingRule(url, method, headers, body) {
```

And update the call to `matchesRule` inside the loop from:

```javascript
if (matchesRule(url, method, headers, rule)) {
```

to:

```javascript
if (matchesRule(url, method, headers, body, rule)) {
```

#### 3c. Modify `matchesRule` to accept `body` and check GraphQL condition

Change the signature from:

```javascript
function matchesRule(url, method, headers, rule) {
```

to:

```javascript
function matchesRule(url, method, headers, body, rule) {
```

After the existing headers check block (after line 167, before `return true;`), add:

```javascript
    // GraphQL operation name match
    if (cond.graphql && cond.graphql.operationName && cond.graphql.operationName.value) {
      const opName = extractGraphQLOperationName(body);
      if (!opName || !matchUrl(opName, cond.graphql.operationName.type || 'equals', cond.graphql.operationName.value)) {
        return false;
      }
    }
```

Note: We reuse `matchUrl()` here since it handles equals/contains/regex matching. Glob is also supported but less useful for operation names.

#### 3d. Update fetch override to pass body

In the fetch override (line 285), find:

```javascript
const matchedRule = findMatchingRule(url, method, headers);
```

Change to:

```javascript
const matchedRule = findMatchingRule(url, method, headers, init?.body);
```

#### 3e. Update XHR.send override to pass body

In the `XMLHttpRequest.prototype.send` override (line 408), find:

```javascript
const matchedRule = findMatchingRule(url, method, headers);
```

Change to:

```javascript
const matchedRule = findMatchingRule(url, method, headers, body);
```

The `body` parameter is already the argument to `send(body)` on line 408.

### Step 4: Update `service-worker/rule-engine.js`

In the `matchCondition(requestInfo, condition)` function (line 88), after the method match check (line 106, before `return true;`), add:

```javascript
  // GraphQL operation name match
  if (condition.graphql?.operationName?.value) {
    const opName = requestInfo.graphqlOperationName || null;
    if (!opName) return false;
    const type = condition.graphql.operationName.type || 'equals';
    switch (type) {
      case 'equals':
        if (opName !== condition.graphql.operationName.value) return false;
        break;
      case 'contains':
        if (!opName.includes(condition.graphql.operationName.value)) return false;
        break;
      case 'regex':
        try {
          if (!new RegExp(condition.graphql.operationName.value).test(opName)) return false;
        } catch (_) { return false; }
        break;
      default:
        if (opName !== condition.graphql.operationName.value) return false;
    }
  }
```

Note: `requestInfo.graphqlOperationName` is a new optional field on the request descriptor. The service worker's DNR pipeline would need to populate it if it has access to the body. If the service worker doesn't have body access (which is common in MV3), this check will only work for the content-script interception path. The guard `if (!opName) return false;` ensures that if the field is missing, rules with GraphQL conditions won't match at the DNR level.

### Step 5: Update `options/components/rule-form.js`

#### 5a. Import `GRAPHQL_MATCH_TYPES`

Update the import at the top of the file from:

```javascript
import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
} from '../../shared/constants.js';
```

to:

```javascript
import {
  URL_MATCH_TYPES,
  HEADER_MATCH_TYPES,
  GRAPHQL_MATCH_TYPES,
  HTTP_METHODS,
  ACTION_TYPES,
  MOCK_SERVER_MODES,
} from '../../shared/constants.js';
```

#### 5b. Add GraphQL section to `_buildConditionsSection()`

At the end of `_buildConditionsSection()`, just before `return section;`, add:

```javascript
  // GraphQL operation name
  const gqlFieldset = document.createElement('fieldset');
  gqlFieldset.style.cssText =
    'border:1px solid #1f2937; border-radius:6px; padding:10px 14px; margin:0; margin-top:8px;';
  const gqlLegend = document.createElement('legend');
  gqlLegend.textContent = 'GraphQL';
  gqlLegend.style.cssText = 'font-size:12px; color:#9ca3af; padding:0 4px;';
  gqlFieldset.appendChild(gqlLegend);

  const gqlRow = document.createElement('div');
  gqlRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

  const gqlLabel = document.createElement('label');
  gqlLabel.textContent = 'Operation';
  gqlLabel.style.cssText = 'font-size:13px; color:#9ca3af; min-width:70px;';

  const gqlTypeSelect = document.createElement('select');
  gqlTypeSelect.id = 'ni-field-graphql-op-type';
  _applySelectStyle(gqlTypeSelect);
  const currentGqlType = _editingRule?.condition?.graphql?.operationName?.type || GRAPHQL_MATCH_TYPES.EQUALS;
  for (const [, val] of Object.entries(GRAPHQL_MATCH_TYPES)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    if (val === currentGqlType) opt.selected = true;
    gqlTypeSelect.appendChild(opt);
  }

  const gqlInput = _input('text', 'ni-field-graphql-op-value', 'e.g. GetUsers, CreateOrder');
  gqlInput.value = _editingRule?.condition?.graphql?.operationName?.value || '';
  gqlInput.style.flex = '1';

  gqlRow.appendChild(gqlLabel);
  gqlRow.appendChild(gqlTypeSelect);
  gqlRow.appendChild(gqlInput);
  gqlFieldset.appendChild(gqlRow);

  // Hint text
  const gqlHint = document.createElement('div');
  gqlHint.style.cssText = 'font-size:11px; color:#6c7086; margin-top:6px; font-style:italic;';
  gqlHint.textContent = 'Match by operationName in POST body. Leave empty to match any operation.';
  gqlFieldset.appendChild(gqlHint);

  section.appendChild(gqlFieldset);
```

#### 5c. Read GraphQL fields in `_collectRule()`

In the `_collectRule()` function (line 619), after the headers collection block (around line 648), add:

```javascript
  // Conditions - GraphQL
  rule.condition.graphql = {
    operationName: {
      type: _val('ni-field-graphql-op-type') || 'equals',
      value: _val('ni-field-graphql-op-value') || '',
    },
  };
```

This must be placed after `rule.condition.headers = ...` and before `// Action type`.

#### 5d. Update `_defaultRule()` to include graphql

In the `_defaultRule()` function (line 44), update the condition object from:

```javascript
condition: {
  url: { type: URL_MATCH_TYPES.CONTAINS, value: '' },
  headers: [],
  methods: [],
},
```

to:

```javascript
condition: {
  url: { type: URL_MATCH_TYPES.CONTAINS, value: '' },
  headers: [],
  methods: [],
  graphql: {
    operationName: { type: GRAPHQL_MATCH_TYPES.EQUALS, value: '' },
  },
},
```

#### 5e. Update `conditionSummary()` in `rule-list.js` (optional but recommended)

In `options/components/rule-list.js`, the `conditionSummary(rule)` function (line 99) generates a short text summary for each rule card. After the headers check (line 122), add:

```javascript
  // GraphQL operation
  if (cond.graphql && cond.graphql.operationName && cond.graphql.operationName.value) {
    const gqlVal = cond.graphql.operationName.value;
    parts.push(`GQL: ${gqlVal.length > 30 ? gqlVal.slice(0, 30) + '\u2026' : gqlVal}`);
  }
```

This makes GraphQL operation names visible in the rule list card summary.

### Step 6: Update dry-run test panel (if spec 04 is implemented)

If the dry-run test panel from spec 04-test-rule-dry-run has been implemented, update the `_evaluateMatch()` function to also check GraphQL conditions:

After the headers check in `_evaluateMatch()`, add:

```javascript
  // GraphQL operation name match
  if (condition.graphql?.operationName?.value) {
    // For dry-run, we don't have a body -- show an informational message
    reasons.push(
      `GraphQL operation "${condition.graphql.operationName.value}" cannot be tested here (requires POST body). The rule will match at runtime when the operation name is present.`
    );
    // Don't fail the match -- just inform
  }
```

Alternatively, add a "Request Body" textarea to the test panel and parse `operationName` from it. This is optional.

## How the Flow Works

1. User creates a rule with:
   - URL: contains `/graphql`
   - Methods: POST
   - GraphQL Operation: equals `GetUsers`
   - Action: mock_inline with custom response
2. User saves the rule.
3. The web app sends a POST to `/graphql` with body `{"operationName": "GetUsers", "query": "query GetUsers { ... }"}`.
4. The content-script interceptor (`interceptor-inject.js`):
   - `window.fetch` override extracts `url`, `method`, `headers`, and `init.body`.
   - Calls `findMatchingRule(url, method, headers, body)`.
   - `matchesRule()` checks URL (matches `/graphql`), method (matches POST), headers (none required).
   - Sees `cond.graphql.operationName.value = "GetUsers"`.
   - Calls `extractGraphQLOperationName(body)` which parses the body JSON and returns `"GetUsers"`.
   - `matchUrl("GetUsers", "equals", "GetUsers")` returns true.
   - Rule matches. Mock response is returned.
5. The app sends another POST to `/graphql` with body `{"operationName": "GetOrders", ...}`.
   - Same URL, method, headers match.
   - `extractGraphQLOperationName` returns `"GetOrders"`.
   - `matchUrl("GetOrders", "equals", "GetUsers")` returns false.
   - Rule does NOT match. Request passes through to the real server.

## Backward Compatibility

- Existing rules without a `graphql` field in their condition will NOT be broken. The matching code checks `if (cond.graphql && cond.graphql.operationName && cond.graphql.operationName.value)` -- all three must be truthy. Missing `graphql` key means the condition is skipped (always matches).
- `_mergeDeep()` in `data-models.js` will add the `graphql` default when `createRule()` is called for new rules, but won't affect existing saved rules.
- The rule form's `_collectRule()` will write a `graphql` field even for old rules when they're edited and saved, which is fine.

## Verification

1. **Form UI**: Open Options -> Rules -> Add Rule. Scroll to the Conditions section. Below the Headers area, there should be a "GraphQL" fieldset with:
   - Label: "Operation"
   - A dropdown with options: equals, contains, regex
   - A text input with placeholder "e.g. GetUsers, CreateOrder"
   - A hint: "Match by operationName in POST body. Leave empty to match any operation."

2. **Create a GraphQL mock rule**:
   - Name: "Mock GetUsers"
   - URL: contains "/graphql"
   - Methods: POST
   - GraphQL Operation: equals "GetUsers"
   - Action: mock_inline, status 200, body `{"data": {"users": [{"id": 1, "name": "Test"}]}}`
   - Save.

3. **Rule list summary**: The rule card in the list should show summary text including `GQL: GetUsers`.

4. **Test matching** (requires a page making GraphQL calls):
   - Enable the interceptor.
   - Navigate to a page that sends GraphQL queries.
   - A POST to `/graphql` with `operationName: "GetUsers"` should return the mock.
   - A POST to `/graphql` with `operationName: "GetOrders"` should pass through normally.
   - Check the Request Log: the GetUsers request should show as intercepted with action "mock_inline".

5. **Regex matching**:
   - Change the operation match type to "regex" with value `^Get`.
   - Now any operation starting with "Get" should match (GetUsers, GetOrders, GetProducts).

6. **Contains matching**:
   - Set operation match type to "contains" with value "User".
   - Matches: GetUsers, UpdateUser, DeleteUserProfile.
   - Does NOT match: GetOrders, CreateProduct.

7. **Empty operation (backward compat)**:
   - Leave the GraphQL Operation field empty.
   - Rule should match based on URL/method/headers only, ignoring GraphQL operation.
   - Existing rules without a `graphql` condition should still work normally.

8. **Batched queries**: If a request sends an array of operations:
   ```json
   [{"operationName": "GetUsers", "query": "..."}, {"operationName": "GetPosts", "query": "..."}]
   ```
   The matching uses the first operation name ("GetUsers").

9. **Edit existing rule**: Open an old rule (without GraphQL field) for editing. The GraphQL fields should appear empty. Save without changes -- the rule should still work identically.
