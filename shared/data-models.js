/**
 * Mocxy - Data Model Factories
 * Each factory returns a plain object with sensible defaults.
 * Pass partial overrides to customise individual fields.
 */

import { generateId } from './utils.js';

/**
 * Create an interception rule.
 *
 * @param {Object} [overrides]
 * @returns {Object} A fully-populated rule object.
 */
export function createRule(overrides = {}) {
  const defaults = {
    id: generateId(),
    name: '',
    enabled: true,
    priority: 0,
    condition: {
      url: { type: 'contains', value: '' },
      headers: [],
      methods: [],
      payload: { enabled: false, type: 'contains', expression: '' },
      graphql: { enabled: false, operationName: '', operationType: 'any' },
    },
    action: {
      type: 'redirect',
      redirect: {
        targetHost: '',
        preservePath: true,
        protocol: 'auto',   // 'auto' | 'http' | 'https'
        additionalHeaders: [],
        injectPayload: { enabled: false, contentType: 'json', operation: 'replace', jsonPath: '', key: '', value: '', find: '' },
      },
      rewrite: {
        pattern: '',
        replacement: '',
        injectPayload: { enabled: false, contentType: 'json', operation: 'replace', jsonPath: '', key: '', value: '', find: '' },
      },
      mockInline: {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      mockServer: {
        serverUrl: 'http://localhost:5000/proxy',
        mode: 'RESPONSE_ONLY',
        stepTag: '',
        injectPayload: { enabled: false, contentType: 'json', operation: 'replace', jsonPath: '', key: '', value: '', find: '' },
      },
      headerMods: {
        addRequest: [],
        removeRequest: [],
        addResponse: [],
        removeResponse: [],
      },
      delayMs: 0,
      block: { reason: '' },
      modifyBody: { type: 'replace', find: '', replace: '', jsonPath: '', value: '' },
      setUserAgent: { preset: 'Chrome Mac', custom: '' },
      graphqlMock: { operationName: '', operationType: 'any', statusCode: 200, body: '{"data":{}}' },
      injectScript: { code: '', runAt: 'document_end' },
      injectCss:    { code: '' },
      injectPayload: {
        contentType: 'json',    // json | form | text
        operation:   'replace', // replace | append | remove
        jsonPath:    '',        // JSON replace/remove: path e.g. $.version
        key:         '',        // JSON append: new key; form replace/append/remove: field name
        value:       '',        // replace/append: new value (JSON literal or plain string)
        find:        '',        // text replace/remove: substring to find
      },
    },
  };

  return _mergeDeep(defaults, overrides);
}

/**
 * Create a mock collection (a named group of mock responses).
 *
 * @param {Object} [overrides]
 * @returns {Object} A fully-populated mock-collection object.
 */
export function createMockCollection(overrides = {}) {
  const defaults = {
    id: generateId(),
    name: '',
    active: false,
    mocks: [],
  };

  return _mergeDeep(defaults, overrides);
}

/**
 * Create an individual mock entry inside a collection.
 *
 * @param {Object} [overrides]
 * @returns {Object} A fully-populated mock object.
 */
export function createMock(overrides = {}) {
  const defaults = {
    id: generateId(),
    name: '',
    priority: 0,

    // ── Request matching ──────────────────────────────────────────────
    urlMatch: '',
    urlMatchType: 'contains',      // 'contains' | 'equals' | 'regex' | 'path'
    methods: [],                   // empty = match all
    queryParams: [],               // [{key, value, matchType, enabled}]
    requestHeaders: [],            // [{name, value, matchType, enabled}]
    bodyMatch: {
      enabled: false,
      type: 'contains',            // 'contains' | 'equals' | 'jsonpath' | 'regex'
      value: '',
    },

    // ── Response ──────────────────────────────────────────────────────
    statusCode: 200,
    responseHeaders: { 'Content-Type': 'application/json' },
    body: '{}',
    delayMs: 0,
    delayJitter: 0,                // 0 = no jitter; N = random 0-N ms added
    fault: 'none',                 // 'none' | 'network_error' | 'empty_response'
  };

  return _mergeDeep(defaults, overrides);
}

/**
 * Create a request-log entry.
 *
 * @param {Object} [overrides]
 * @returns {Object} A fully-populated log-entry object.
 */
export function createLogEntry(overrides = {}) {
  const defaults = {
    id: generateId(),
    timestamp: Date.now(),
    url: '',
    method: '',
    statusCode: 0,
    duration: 0,
    matchedRuleId: null,
    matchedRuleName: null,
    actionTaken: null,
    intercepted: false,
    requestHeaders: {},
    requestBody: null,
    responseHeaders: {},
    responseBody: null,
  };

  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively merge source into target (plain objects only).
 * Arrays and non-plain values in source replace target values outright.
 */
function _mergeDeep(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = target[key];
    const sVal = source[key];
    if (
      sVal !== null &&
      typeof sVal === 'object' &&
      !Array.isArray(sVal) &&
      tVal !== null &&
      typeof tVal === 'object' &&
      !Array.isArray(tVal)
    ) {
      output[key] = _mergeDeep(tVal, sVal);
    } else {
      output[key] = sVal;
    }
  }
  return output;
}
