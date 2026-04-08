/**
 * Mocxy - Inject Script (MAIN world)
 *
 * Runs in the page's execution context. Overrides window.fetch and
 * XMLHttpRequest to evaluate interception rules and apply actions
 * (redirect, rewrite, mock, delay, header modification, proxy server).
 *
 * Receives rule configuration from the content script via window messages.
 * Posts request log entries back to the content script for the service worker.
 */

(function () {
  'use strict';

  // =========================================================================
  // State
  // =========================================================================
  let rules = [];
  let mockCollections = [];
  let enabled = false;
  let enableLogging = true;

  // =========================================================================
  // Save original natives
  // =========================================================================
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // =========================================================================
  // Listen for config updates from the content script
  // =========================================================================
  window.addEventListener('message', (event) => {
    if (event.data?.source === 'mocxy-content') {
      if (event.data.type === 'RULES_UPDATED') {
        rules = event.data.data.rules || [];
        mockCollections = event.data.data.mockCollections || [];
        enabled = event.data.data.enabled ?? false;
        enableLogging = event.data.data.enableLogging ?? true;
        console.log(
          '[Mocxy] Rules updated:',
          rules.length, 'rules,',
          mockCollections.length, 'collections,',
          'enabled:', enabled
        );
      }
      if (event.data.type === 'SETTINGS_UPDATED') {
        if (event.data.data.enableLogging !== undefined) {
          enableLogging = event.data.data.enableLogging;
        }
      }
    }
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Post a log entry to the content script for forwarding to the service worker.
   */
  function postLog(entry) {
    window.postMessage(
      { source: 'mocxy-inject', type: 'LOG_REQUEST', data: entry },
      '*'
    );
  }

  /**
   * Find the first matching rule for a given request.
   * Rules are sorted by priority (descending) and only enabled rules are considered.
   */
  function findMatchingRule(url, method, headers, body) {
    if (!enabled || rules.length === 0) return null;

    const sorted = [...rules]
      .filter((r) => r.enabled)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of sorted) {
      if (matchesRule(url, method, headers, body, rule)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * Find a matching mock from active mock collections.
   * Mocks are sorted by priority (descending) across all active collections.
   */
  function findMatchingMock(url, method, requestHeaders, body) {
    if (!enabled) return null;

    // Collect all mocks from active collections, sorted by priority desc
    const candidates = [];
    for (const collection of mockCollections) {
      if (!collection.active) continue;
      for (const mock of (collection.mocks || [])) {
        candidates.push(mock);
      }
    }
    candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const mock of candidates) {
      if (matchesMock(url, method, requestHeaders, body, mock)) return mock;
    }
    return null;
  }

  /**
   * Evaluate whether a request matches all criteria of a mock entry.
   */
  function matchesMock(url, method, reqHeaders, body, mock) {
    // 1. URL match
    if (mock.urlMatch) {
      const type = mock.urlMatchType || 'contains';
      if (!matchUrl(url, type, mock.urlMatch)) return false;
    }

    // 2. Method match
    if (mock.methods && mock.methods.length > 0) {
      if (!mock.methods.includes((method || 'GET').toUpperCase())) return false;
    }

    // 3. Query parameter matching
    if (mock.queryParams && mock.queryParams.length > 0) {
      let parsedParams = {};
      try {
        const fullUrl = url.startsWith('http') ? url : 'https://x.com' + url;
        const u = new URL(fullUrl);
        u.searchParams.forEach((v, k) => { parsedParams[k] = v; });
      } catch (_) {}

      for (const qp of mock.queryParams) {
        if (!qp.enabled || !qp.key) continue;
        const actualVal = parsedParams[qp.key];
        if (qp.matchType === 'absent') {
          if (actualVal !== undefined) return false;
          continue;
        }
        if (actualVal === undefined) return false;
        if (!matchValueByType(actualVal, qp.matchType || 'equals', qp.value || '')) return false;
      }
    }

    // 4. Request header matching
    if (mock.requestHeaders && mock.requestHeaders.length > 0) {
      for (const hc of mock.requestHeaders) {
        if (!hc.enabled || !hc.name) continue;
        const actualVal = (reqHeaders || {})[hc.name] || (reqHeaders || {})[hc.name.toLowerCase()] || '';
        if (hc.matchType === 'absent') {
          if (actualVal) return false;
          continue;
        }
        if (!matchValueByType(actualVal, hc.matchType || 'equals', hc.value || '')) return false;
      }
    }

    // 5. Body/payload matching
    if (mock.bodyMatch && mock.bodyMatch.enabled && mock.bodyMatch.value) {
      if (!matchPayload(body, mock.bodyMatch.type, mock.bodyMatch.value)) return false;
    }

    return true;
  }

  /**
   * Match a string value using the given match type.
   */
  function matchValueByType(actual, type, expected) {
    switch (type) {
      case 'equals':   return actual === expected;
      case 'contains': return actual.includes(expected);
      case 'regex':    try { return new RegExp(expected).test(actual); } catch (_) { return false; }
      default:         return actual === expected;
    }
  }

  // ---------------------------------------------------------------------------
  // URL matching
  // ---------------------------------------------------------------------------

  /**
   * Match a URL against a value using the specified match type.
   * Supports: equals, contains, regex, glob.
   */
  function matchUrl(url, type, value) {
    if (!value) return false;
    switch (type) {
      case 'equals':
        return url === value;
      case 'contains':
        return url.includes(value);
      case 'regex':
        return new RegExp(value).test(url);
      case 'glob':
        return new RegExp(globToRegex(value)).test(url);
      default:
        return false;
    }
  }

  /**
   * Convert a glob pattern to a regular expression string.
   * Supports *, **, and ? wildcards.
   */
  function globToRegex(glob) {
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

  // ---------------------------------------------------------------------------
  // Rule matching
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether a request matches a rule's conditions.
   * Conditions are ANDed: URL, method, header, and payload conditions must match.
   */
  function matchesRule(url, method, headers, body, rule) {
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

    // Payload match
    const payloadCond = cond.payload;
    if (payloadCond && payloadCond.enabled && payloadCond.expression) {
      if (!matchPayload(body, payloadCond.type, payloadCond.expression)) return false;
    }

    // GraphQL match
    const gqlCond = cond.graphql;
    if (gqlCond && gqlCond.enabled && gqlCond.operationName) {
      if (!matchGraphQL(body, gqlCond)) return false;
    }

    return true;
  }

  function matchPayload(body, type, expression) {
    if (!body) return false;

    let parsed;
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (_) {
      // Not JSON — fall back to string matching
      const str = typeof body === 'string' ? body : String(body);
      if (type === 'contains') return str.includes(expression);
      if (type === 'equals') return str === expression;
      return false;
    }

    switch (type) {
      case 'contains': {
        const str = JSON.stringify(parsed);
        return str.includes(expression);
      }
      case 'equals': {
        try {
          return JSON.stringify(parsed) === JSON.stringify(JSON.parse(expression));
        } catch (_) {
          return JSON.stringify(parsed) === expression;
        }
      }
      case 'jsonpath': {
        // Simple JSONPath evaluator — supports $.key, $.key.subkey, $.key[0], comparisons
        try {
          const result = simpleJsonPath(parsed, expression);
          return result !== undefined && result !== null && result !== false;
        } catch (_) {
          return false;
        }
      }
      case 'js': {
        // Custom JS: expression is a function body or arrow function
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('body', 'return (' + expression + ')');
          return !!fn(parsed);
        } catch (_) {
          return false;
        }
      }
      default:
        return false;
    }
  }

  function matchGraphQL(body, cond) {
    if (!body) return false;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;

      // Check operation name
      if (cond.operationName) {
        const opName = parsed.operationName || '';
        if (!opName.toLowerCase().includes(cond.operationName.toLowerCase())) return false;
      }

      // Check operation type (query/mutation/subscription)
      if (cond.operationType && cond.operationType !== 'any') {
        const query = parsed.query || '';
        const typeMatch = query.trim().toLowerCase().startsWith(cond.operationType.toLowerCase());
        if (!typeMatch) return false;
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Minimal JSONPath evaluator supporting:
   *   $.field                    → value of field
   *   $.field.sub                → nested value
   *   $.field[0]                 → array index
   *   $.field == "value"         → equality check
   *   $.field != "value"         → inequality
   *   $.field > 5                → numeric comparison
   *   $.field contains "substr"  → string contains
   */
  function simpleJsonPath(obj, path) {
    // Check for comparison operators
    const cmpMatch = path.match(/^(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/);
    if (cmpMatch) {
      const [, lhs, op, rhs] = cmpMatch;
      const lhsVal = simpleJsonPath(obj, lhs.trim());
      let rhsVal;
      try {
        rhsVal = JSON.parse(rhs.trim());
      } catch (_) {
        rhsVal = rhs.trim().replace(/^['"]|['"]$/g, '');
      }
      switch (op) {
        case '==': return lhsVal == rhsVal; // eslint-disable-line
        case '!=': return lhsVal != rhsVal; // eslint-disable-line
        case '>':  return lhsVal > rhsVal;
        case '<':  return lhsVal < rhsVal;
        case '>=': return lhsVal >= rhsVal;
        case '<=': return lhsVal <= rhsVal;
        case 'contains': return String(lhsVal).includes(String(rhsVal));
        default:   return false;
      }
    }

    // Path traversal: $.a.b[0].c
    const segments = path.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean);
    let current = obj;
    for (const seg of segments) {
      if (current === null || current === undefined) return undefined;
      const idx = /^\d+$/.test(seg) ? parseInt(seg, 10) : seg;
      current = current[idx];
    }
    return current;
  }

  // =========================================================================
  // Payload injection helpers
  // =========================================================================

  /** Convert any body value to a plain string. */
  function _bodyToString(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    try { return JSON.stringify(body); } catch (_) { return String(body); }
  }

  /** Parse a string as a JSON value; fall back to the raw string if it fails. */
  function _parseVal(str) {
    if (str === undefined || str === null || str === '') return str;
    try { return JSON.parse(str); } catch (_) { return str; }
  }

  /** Set value at a dot-notation path inside obj (mutates obj). */
  function _setJsonPath(obj, path, value) {
    const parts = path.replace(/^\$\.?/, '').split('.');
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] === null || cur[p] === undefined || typeof cur[p] !== 'object') {
        cur[p] = {};
      }
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /** Remove the key at a dot-notation path from obj (mutates obj). */
  function _removeJsonPath(obj, path) {
    const parts = path.replace(/^\$\.?/, '').split('.');
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur || typeof cur !== 'object') return;
      cur = cur[p];
    }
    if (cur && typeof cur === 'object') {
      delete cur[parts[parts.length - 1]];
    }
  }

  /**
   * Apply inject_payload logic to a raw body string.
   * Returns the transformed body string (original returned on any error).
   */
  function _applyPayloadInjection(rawBody, cfg) {
    if (!cfg) return rawBody;
    try {
      switch (cfg.contentType) {
        case 'json': {
          const obj = JSON.parse(rawBody || '{}');
          if (cfg.operation === 'replace' && cfg.jsonPath) {
            _setJsonPath(obj, cfg.jsonPath, _parseVal(cfg.value));
            console.log('[Mocxy] Inject payload – JSON replace:', cfg.jsonPath, '=', cfg.value);
          } else if (cfg.operation === 'append' && cfg.key) {
            _setJsonPath(obj, '$.' + cfg.key.replace(/^\$\.?/, ''), _parseVal(cfg.value));
            console.log('[Mocxy] Inject payload – JSON append key:', cfg.key);
          } else if (cfg.operation === 'remove' && cfg.jsonPath) {
            _removeJsonPath(obj, cfg.jsonPath);
            console.log('[Mocxy] Inject payload – JSON remove:', cfg.jsonPath);
          }
          return JSON.stringify(obj);
        }
        case 'form': {
          const params = new URLSearchParams(rawBody || '');
          if (cfg.operation === 'remove' && cfg.key) {
            params.delete(cfg.key);
          } else if (cfg.key) {
            // replace → overwrite; append → add duplicate entry
            if (cfg.operation === 'append') {
              params.append(cfg.key, cfg.value || '');
            } else {
              params.set(cfg.key, cfg.value || '');
            }
          }
          console.log('[Mocxy] Inject payload – form', cfg.operation, cfg.key);
          return params.toString();
        }
        case 'text': {
          if (cfg.operation === 'replace' && cfg.find) {
            const result = rawBody.split(cfg.find).join(cfg.value || '');
            console.log('[Mocxy] Inject payload – text replace "' + cfg.find + '"');
            return result;
          } else if (cfg.operation === 'append') {
            console.log('[Mocxy] Inject payload – text append');
            return rawBody + (cfg.value || '');
          } else if (cfg.operation === 'remove' && cfg.find) {
            console.log('[Mocxy] Inject payload – text remove "' + cfg.find + '"');
            return rawBody.split(cfg.find).join('');
          }
          return rawBody;
        }
        default:
          return rawBody;
      }
    } catch (err) {
      console.warn('[Mocxy] Inject payload failed (' + (cfg.contentType || '?') + '):', err.message, '— original body preserved');
      return rawBody;
    }
  }

  // =========================================================================
  // Action execution
  // =========================================================================

  /**
   * Apply the action defined by a matched rule.
   * Returns { response, ...metadata } for the fetch override.
   */
  async function applyAction(rule, url, options) {
    const action = rule.action;

    // Apply delay if present
    if (action.delayMs > 0) {
      await new Promise((r) => setTimeout(r, action.delayMs));
    }

    switch (action.type) {
      case 'redirect': {
        const redirectCfg = action.redirect || {};
        let newUrl = url;
        if (redirectCfg.targetHost && redirectCfg.preservePath) {
          try {
            const parsed = new URL(url);
            parsed.host = redirectCfg.targetHost;
            newUrl = parsed.toString();
          } catch (e) {
            // If URL parsing fails, try string replacement
            newUrl = url.replace(/\/\/[^/]+/, '//' + redirectCfg.targetHost);
          }
        } else if (redirectCfg.targetHost) {
          newUrl = redirectCfg.targetHost;
        }
        console.log('[Mocxy] Redirect:', url, '->', newUrl);
        // Apply payload injection if enabled
        if (redirectCfg.injectPayload?.enabled) {
          const rawBody = _bodyToString(options?.body);
          const injected = _applyPayloadInjection(rawBody, redirectCfg.injectPayload);
          options = { ...options, body: injected };
        }
        // Merge additional headers: override existing key (case-insensitive), add if new
        const additionalHdrs = redirectCfg.additionalHeaders || [];
        if (additionalHdrs.length > 0) {
          const merged = { ...(options?.headers || {}) };
          additionalHdrs.forEach((h) => {
            if (!h.name) return;
            // Remove any existing entry with same header name (case-insensitive)
            for (const existing of Object.keys(merged)) {
              if (existing.toLowerCase() === h.name.toLowerCase()) {
                delete merged[existing];
              }
            }
            merged[h.name] = h.value;
          });
          options = { ...options, headers: merged };
        }
        const resp = await originalFetch(newUrl, options);
        return { response: resp, redirectedUrl: newUrl };
      }

      case 'rewrite': {
        const rewriteCfg = action.rewrite || {};
        if (!rewriteCfg.pattern) {
          console.warn('[Mocxy] Rewrite rule has empty pattern — skipping rewrite, using original URL');
          return { response: await originalFetch(url, options) };
        }
        let newUrl;
        try {
          newUrl = url.replace(new RegExp(rewriteCfg.pattern), rewriteCfg.replacement || '');
        } catch (regexErr) {
          console.error('[Mocxy] Rewrite: invalid regex pattern "' + rewriteCfg.pattern + '":', regexErr.message);
          return { response: await originalFetch(url, options) };
        }
        if (newUrl === url) {
          console.warn('[Mocxy] Rewrite: pattern "' + rewriteCfg.pattern + '" did not match URL:', url);
          return { response: await originalFetch(url, options) };
        }
        console.log('[Mocxy] Rewrite:', url, '->', newUrl);
        // Apply payload injection if enabled
        if (rewriteCfg.injectPayload?.enabled) {
          const rawBody = _bodyToString(options?.body);
          const injected = _applyPayloadInjection(rawBody, rewriteCfg.injectPayload);
          options = { ...options, body: injected };
        }
        const resp = await originalFetch(newUrl, options);
        return { response: resp, rewrittenUrl: newUrl };
      }

      case 'mock_inline': {
        const mock = action.mockInline || {};
        console.log('[Mocxy] Mock inline:', url, 'status:', mock.statusCode);
        const response = new Response(mock.body || '{}', {
          status: mock.statusCode || 200,
          headers: mock.headers || { 'Content-Type': 'application/json' }
        });
        return { response, mocked: true };
      }

      case 'mock_server': {
        const serverCfg = action.mockServer || {};
        const serverUrl = serverCfg.serverUrl || 'http://localhost:5000/proxy';
        let proxyOptions = { ...options };
        proxyOptions.headers = { ...(options?.headers || {}) };
        if (serverCfg.stepTag) {
          proxyOptions.headers['X-Proxy-Step-Tag'] = serverCfg.stepTag;
        }
        proxyOptions.headers['X-Proxy-Timestamp-Mode'] = serverCfg.mode || 'RESPONSE_ONLY';

        if (serverCfg.mode === 'REQUEST_ONLY') {
          // Send to proxy but return a synthetic response
          originalFetch(serverUrl + new URL(url).pathname, proxyOptions).catch(() => {});
          return {
            response: new Response(
              JSON.stringify({ status: 'ok', _mode: 'REQUEST_ONLY' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ),
            mocked: true
          };
        } else {
          // RESPONSE_ONLY or PASSTHROUGH - redirect to proxy server
          // Apply payload injection if enabled
          if (serverCfg.injectPayload?.enabled) {
            const rawBody = _bodyToString(proxyOptions?.body);
            const injected = _applyPayloadInjection(rawBody, serverCfg.injectPayload);
            proxyOptions = { ...proxyOptions, body: injected };
          }
          const parsed = new URL(url);
          const apiPath = parsed.pathname + parsed.search;
          const resp = await originalFetch(serverUrl + apiPath, proxyOptions);
          return { response: resp, proxied: true };
        }
      }

      case 'modify_headers': {
        const mods = action.headerMods || {};
        let modOptions = { ...options, headers: { ...(options?.headers || {}) } };
        // Add request headers
        (mods.addRequest || []).forEach((h) => {
          modOptions.headers[h.name] = h.value;
        });
        // Remove request headers
        (mods.removeRequest || []).forEach((name) => {
          delete modOptions.headers[name];
        });
        const resp = await originalFetch(url, modOptions);
        return { response: resp, headersModified: true };
      }

      case 'delay': {
        // Delay was already applied above; proceed with original request
        const resp = await originalFetch(url, options);
        return { response: resp, delayed: true };
      }

      case 'block': {
        console.log('[Mocxy] Block:', url);
        // Return a synthetic 0-status network error response
        // For mock purposes return a Response that signals blocked
        const blockedResp = new Response(
          JSON.stringify({ blocked: true, reason: action.block?.reason || 'Blocked by Mocxy rule' }),
          { status: 0, headers: { 'Content-Type': 'application/json', 'X-Mocxy-Blocked': 'true' } }
        );
        return { response: blockedResp, blocked: true };
      }

      case 'modify_body': {
        const cfg = action.modifyBody || {};
        let newBody = typeof options?.body === 'string' ? options.body :
          (options?.body ? JSON.stringify(options.body) : null);

        if (newBody && cfg.type === 'replace' && cfg.find) {
          newBody = newBody.split(cfg.find).join(cfg.replace || '');
          console.log('[Mocxy] Modify body (replace):', cfg.find, '->', cfg.replace);
        } else if (newBody && cfg.type === 'jsonpath' && cfg.jsonPath) {
          try {
            const parsed = JSON.parse(newBody);
            // Set value at JSONPath
            const parts = cfg.jsonPath.replace(/^\$\.?/, '').split('.');
            let obj = parsed;
            for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
            const lastKey = parts[parts.length - 1];
            try { obj[lastKey] = JSON.parse(cfg.value); } catch(_) { obj[lastKey] = cfg.value; }
            newBody = JSON.stringify(parsed);
            console.log('[Mocxy] Modify body (jsonpath):', cfg.jsonPath, '=', cfg.value);
          } catch (e) {
            console.warn('[Mocxy] Modify body JSONPath failed:', e.message);
          }
        }

        const modOptions = { ...options, body: newBody };
        const resp = await originalFetch(url, modOptions);
        return { response: resp, bodyModified: true };
      }

      case 'set_user_agent': {
        const cfg = action.setUserAgent || {};
        const ua = cfg.preset === 'Custom' ? cfg.custom : (cfg.preset || '');
        if (!ua) return { response: await originalFetch(url, options) };
        const uaOptions = { ...options, headers: { ...(options?.headers || {}), 'User-Agent': ua } };
        console.log('[Mocxy] Set User-Agent:', ua.slice(0, 60) + '...');
        const resp = await originalFetch(url, uaOptions);
        return { response: resp, userAgentSet: true };
      }

      case 'graphql_mock': {
        const cfg = action.graphqlMock || {};
        console.log('[Mocxy] GraphQL Mock:', cfg.operationName);
        const response = new Response(cfg.body || '{"data":{}}', {
          status: cfg.statusCode || 200,
          headers: { 'Content-Type': 'application/json' },
        });
        return { response, mocked: true };
      }

      case 'inject_payload': {
        const cfg = action.injectPayload || {};
        const rawBody = _bodyToString(options?.body);
        const newBody = _applyPayloadInjection(rawBody, cfg);
        const injectedOptions = { ...options, body: newBody };
        const resp = await originalFetch(url, injectedOptions);
        return { response: resp, payloadInjected: true };
      }

      default:
        return { response: await originalFetch(url, options) };
    }
  }

  // =========================================================================
  // fetch override
  // =========================================================================
  window.fetch = async function (input, init = {}) {
    // Normalise input — preserve Request object properties
    let url, method, headers, mergedInit;
    if (input instanceof Request) {
      url = input.url;
      mergedInit = {
        method:      input.method,
        headers:     Object.fromEntries(input.headers || []),
        mode:        input.mode,
        credentials: input.credentials,
        cache:       input.cache,
        redirect:    input.redirect,
        referrer:    input.referrer,
        ...init,     // explicit init overrides
      };
      // Body can only be read once — clone if needed
      if (input.body && !init.body) {
        try { mergedInit.body = await input.clone().arrayBuffer(); } catch (_) {}
      }
    } else {
      url = typeof input === 'string' ? input : String(input);
      mergedInit = init;
    }
    method = mergedInit.method || 'GET';
    headers = mergedInit.headers || {};
    const startTime = performance.now();

    // Extract body string for payload matching
    let bodyStr = null;
    if (mergedInit.body) {
      try {
        bodyStr = typeof mergedInit.body === 'string'
          ? mergedInit.body
          : mergedInit.body instanceof ArrayBuffer
            ? new TextDecoder().decode(mergedInit.body)
            : JSON.stringify(mergedInit.body);
      } catch (_) {}
    }

    // Check rules first (higher priority)
    const matchedRule = findMatchingRule(url, method, headers, bodyStr);

    // Check mock collections only if no rule matched
    const matchedMock = !matchedRule ? findMatchingMock(url, method, headers, bodyStr) : null;

    if (matchedRule) {
      try {
        const result = await applyAction(matchedRule, url, mergedInit);
        const duration = performance.now() - startTime;
        postLog({
          url,
          modifiedUrl: result.rewrittenUrl || result.redirectedUrl || null,
          method,
          statusCode: result.response?.status,
          duration: Math.round(duration),
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          actionTaken: matchedRule.action.type,
          intercepted: true,
          requestHeaders: headers,
        });
        return result.response;
      } catch (err) {
        console.error('[Mocxy] Error applying rule "' + matchedRule.name + '" (' + matchedRule.action.type + '):', err.message);
        // Fall back to original but use mergedInit so Request body is preserved
        return originalFetch(url, mergedInit);
      }
    }

    if (matchedMock) {
      const delay = (matchedMock.delayMs || 0) + Math.floor(Math.random() * ((matchedMock.delayJitter || 0) + 1));
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      // Fault simulation
      if (matchedMock.fault === 'network_error') {
        throw new TypeError('Mocxy: simulated network error');
      }
      if (matchedMock.fault === 'empty_response') {
        return new Response('', { status: 200 });
      }

      const resp = new Response(matchedMock.body || '{}', {
        status: matchedMock.statusCode || 200,
        headers: matchedMock.responseHeaders || { 'Content-Type': 'application/json' },
      });
      postLog({
        url,
        method,
        statusCode: resp.status,
        duration: delay,
        matchedRuleId: matchedMock.id,
        matchedRuleName: matchedMock.name,
        actionTaken: 'mock_collection',
        intercepted: true,
      });
      return resp;
    }

    // No match - passthrough with optional logging
    const resp = await originalFetch(input, init);
    if (enabled && enableLogging) {
      postLog({
        url,
        method,
        statusCode: resp.status,
        duration: Math.round(performance.now() - startTime),
        intercepted: false
      });
    }
    return resp;
  };

  // =========================================================================
  // XMLHttpRequest overrides
  // =========================================================================

  /**
   * Override XHR.open to capture the URL and method.
   */
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._neuronUrl = url;
    this._neuronMethod = method;
    this._neuronHeaders = {};
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  /**
   * Override XHR.setRequestHeader to accumulate headers for rule matching.
   */
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._neuronHeaders) this._neuronHeaders[name] = value;
    return originalXHRSetRequestHeader.apply(this, arguments);
  };

  /**
   * Helper: simulate a completed XHR response with the given properties.
   */
  function simulateXHRResponse(xhr, statusCode, statusText, body, headers, callback) {
    Object.defineProperty(xhr, 'status', { writable: true, value: statusCode });
    Object.defineProperty(xhr, 'statusText', { writable: true, value: statusText });
    Object.defineProperty(xhr, 'responseText', { writable: true, value: body });
    Object.defineProperty(xhr, 'response', { writable: true, value: body });
    Object.defineProperty(xhr, 'readyState', { writable: true, value: 4 });

    if (headers) {
      const headersStr = Object.entries(headers)
        .map(([k, v]) => k + ': ' + v)
        .join('\r\n');
      xhr.getAllResponseHeaders = () => headersStr;
      xhr.getResponseHeader = (name) => headers[name] || null;
    }

    if (xhr.onreadystatechange) xhr.onreadystatechange();
    if (xhr.onload) xhr.onload();
    xhr.dispatchEvent(new Event('load'));
    xhr.dispatchEvent(new Event('loadend'));

    if (callback) callback();
  }

  /**
   * Override XHR.send to evaluate rules and intercept as needed.
   */
  XMLHttpRequest.prototype.send = function (body) {
    const url = this._neuronUrl;
    const method = this._neuronMethod || 'GET';
    const headers = this._neuronHeaders || {};
    const startTime = performance.now();
    const xhr = this;

    const matchedRule = findMatchingRule(url, method, headers, typeof body === 'string' ? body : null);
    const matchedMock = !matchedRule ? findMatchingMock(url, method, headers, typeof body === 'string' ? body : null) : null;

    // ----- block via rule -----
    if (matchedRule && matchedRule.action.type === 'block') {
      console.log('[Mocxy] Block XHR:', url);
      setTimeout(() => {
        Object.defineProperty(xhr, 'status', { writable: true, value: 0 });
        Object.defineProperty(xhr, 'statusText', { writable: true, value: '' });
        Object.defineProperty(xhr, 'readyState', { writable: true, value: 4 });
        if (xhr.onerror) xhr.onerror(new Event('error'));
        xhr.dispatchEvent(new Event('error'));
        xhr.dispatchEvent(new Event('loadend'));
        postLog({ url, method, statusCode: 0, duration: 0,
          matchedRuleId: matchedRule.id, matchedRuleName: matchedRule.name,
          actionTaken: 'block', intercepted: true });
      }, matchedRule.action.delayMs || 0);
      return;
    }

    // ----- mock_inline via rule -----
    if (matchedRule && matchedRule.action.type === 'mock_inline') {
      const mock = matchedRule.action.mockInline || {};
      const delay = matchedRule.action.delayMs || 0;
      setTimeout(() => {
        simulateXHRResponse(
          xhr,
          mock.statusCode || 200,
          'OK',
          mock.body || '{}',
          mock.headers || {},
          () => {
            postLog({
              url,
              method,
              statusCode: mock.statusCode || 200,
              duration: delay,
              matchedRuleId: matchedRule.id,
              matchedRuleName: matchedRule.name,
              actionTaken: 'mock_inline',
              intercepted: true
            });
          }
        );
      }, delay);
      return;
    }

    // ----- mock_collection -----
    if (matchedMock) {
      const delay = (matchedMock.delayMs || 0) + Math.floor(Math.random() * ((matchedMock.delayJitter || 0) + 1));

      // Fault simulation — network_error
      if (matchedMock.fault === 'network_error') {
        setTimeout(() => {
          Object.defineProperty(xhr, 'status', { writable: true, value: 0 });
          Object.defineProperty(xhr, 'statusText', { writable: true, value: '' });
          Object.defineProperty(xhr, 'readyState', { writable: true, value: 4 });
          if (xhr.onerror) xhr.onerror(new Event('error'));
          xhr.dispatchEvent(new Event('error'));
          xhr.dispatchEvent(new Event('loadend'));
          postLog({
            url, method, statusCode: 0, duration: delay,
            matchedRuleId: matchedMock.id, matchedRuleName: matchedMock.name,
            actionTaken: 'mock_collection', intercepted: true,
          });
        }, delay);
        return;
      }

      // Fault simulation — empty_response
      if (matchedMock.fault === 'empty_response') {
        setTimeout(() => {
          simulateXHRResponse(xhr, 200, 'OK', '', {}, () => {
            postLog({
              url, method, statusCode: 200, duration: delay,
              matchedRuleId: matchedMock.id, matchedRuleName: matchedMock.name,
              actionTaken: 'mock_collection', intercepted: true,
            });
          });
        }, delay);
        return;
      }

      setTimeout(() => {
        simulateXHRResponse(
          xhr,
          matchedMock.statusCode || 200,
          'OK',
          matchedMock.body || '{}',
          matchedMock.responseHeaders || null,
          () => {
            postLog({
              url,
              method,
              statusCode: matchedMock.statusCode || 200,
              duration: delay,
              matchedRuleId: matchedMock.id,
              matchedRuleName: matchedMock.name,
              actionTaken: 'mock_collection',
              intercepted: true,
            });
          }
        );
      }, delay);
      return;
    }

    // ----- redirect / rewrite via rule -----
    if (matchedRule && (matchedRule.action.type === 'redirect' || matchedRule.action.type === 'rewrite')) {
      let newUrl = url;
      if (matchedRule.action.type === 'redirect') {
        const cfg = matchedRule.action.redirect || {};
        if (cfg.targetHost && cfg.preservePath) {
          try {
            const p = new URL(url);
            p.host = cfg.targetHost;
            newUrl = p.toString();
          } catch (e) {
            newUrl = url.replace(/\/\/[^/]+/, '//' + cfg.targetHost);
          }
        } else if (cfg.targetHost) {
          newUrl = cfg.targetHost;
        }
      } else {
        const cfg = matchedRule.action.rewrite || {};
        if (!cfg.pattern) {
          console.warn('[Mocxy] XHR Rewrite: empty pattern — passthrough');
          return originalXHRSend.call(xhr, body);
        }
        try {
          newUrl = url.replace(new RegExp(cfg.pattern), cfg.replacement || '');
        } catch (e) {
          console.error('[Mocxy] XHR Rewrite: invalid regex "' + cfg.pattern + '":', e.message);
          return originalXHRSend.call(xhr, body);
        }
        if (newUrl === url) {
          console.warn('[Mocxy] XHR Rewrite: pattern "' + cfg.pattern + '" did not match:', url);
          return originalXHRSend.call(xhr, body);
        }
      }
      console.log('[Mocxy] XHR ' + matchedRule.action.type + ':', url, '->', newUrl);
      // Apply payload injection for redirect or rewrite before sending
      const xhrIpCfg = matchedRule.action.type === 'redirect'
        ? matchedRule.action.redirect?.injectPayload
        : matchedRule.action.rewrite?.injectPayload;
      if (xhrIpCfg?.enabled) {
        const rawBody = typeof body === 'string' ? body : _bodyToString(body);
        body = _applyPayloadInjection(rawBody, xhrIpCfg);
      }
      originalXHROpen.call(xhr, method, newUrl, true);
      // Merge additional redirect headers (case-insensitive override):
      // build a set of override keys so original headers are skipped when
      // the same key is also in additionalHdrs — prevents XHR appending both values.
      const additionalHdrs = matchedRule.action.redirect?.additionalHeaders || [];
      const overrideKeys   = new Set(
        additionalHdrs.map(h => (h.name || '').toLowerCase()).filter(Boolean)
      );
      // Set original captured headers, skipping any that will be overridden
      for (const [k, v] of Object.entries(headers)) {
        if (!overrideKeys.has(k.toLowerCase())) {
          originalXHRSetRequestHeader.call(xhr, k, v);
        }
      }
      // Set additional headers — these override or add
      additionalHdrs.forEach((h) => {
        if (h.name) originalXHRSetRequestHeader.call(xhr, h.name, h.value);
      });

      const origOnLoad = xhr.onload;
      xhr.onload = function () {
        postLog({
          url,
          modifiedUrl: newUrl,
          method,
          statusCode: xhr.status,
          duration: Math.round(performance.now() - startTime),
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          actionTaken: matchedRule.action.type,
          intercepted: true
        });
        if (origOnLoad) origOnLoad.call(xhr);
      };
      return originalXHRSend.call(xhr, body);
    }

    // ----- mock_server via rule -----
    if (matchedRule && matchedRule.action.type === 'mock_server') {
      const cfg = matchedRule.action.mockServer || {};
      const serverUrl = cfg.serverUrl || 'http://localhost:5000/proxy';
      if (cfg.stepTag) {
        originalXHRSetRequestHeader.call(xhr, 'X-Proxy-Step-Tag', cfg.stepTag);
      }
      originalXHRSetRequestHeader.call(xhr, 'X-Proxy-Timestamp-Mode', cfg.mode || 'RESPONSE_ONLY');

      if (cfg.mode === 'REQUEST_ONLY') {
        // Fire and forget to proxy, return synthetic response
        try {
          const p = new URL(url);
          originalXHROpen.call(xhr, method, serverUrl + p.pathname, true);
        } catch (e) {
          // URL parse failed; skip proxy call
        }
        setTimeout(() => {
          simulateXHRResponse(
            xhr,
            200,
            'OK',
            JSON.stringify({ status: 'ok', _mode: 'REQUEST_ONLY' }),
            { 'Content-Type': 'application/json' },
            () => {
              postLog({
                url,
                method,
                statusCode: 200,
                duration: 0,
                matchedRuleId: matchedRule.id,
                matchedRuleName: matchedRule.name,
                actionTaken: 'mock_server',
                intercepted: true
              });
            }
          );
        }, 0);
        return;
      } else {
        // RESPONSE_ONLY or PASSTHROUGH - redirect to proxy server
        try {
          const p = new URL(url);
          originalXHROpen.call(xhr, method, serverUrl + p.pathname + p.search, true);
        } catch (e) {
          // URL parse failed; fall through to normal send
        }
        for (const [k, v] of Object.entries(headers)) {
          originalXHRSetRequestHeader.call(xhr, k, v);
        }

        const origOnLoad = xhr.onload;
        xhr.onload = function () {
          postLog({
            url,
            method,
            statusCode: xhr.status,
            duration: Math.round(performance.now() - startTime),
            matchedRuleId: matchedRule.id,
            matchedRuleName: matchedRule.name,
            actionTaken: 'mock_server',
            intercepted: true
          });
          if (origOnLoad) origOnLoad.call(xhr);
        };
        return originalXHRSend.call(xhr, body);
      }
    }

    // ----- modify_headers via rule -----
    if (matchedRule && matchedRule.action.type === 'modify_headers') {
      const mods = matchedRule.action.headerMods || {};
      (mods.addRequest || []).forEach((h) => {
        originalXHRSetRequestHeader.call(xhr, h.name, h.value);
      });
      // Note: removeRequest is not directly possible with XHR after open,
      // but the headers won't be re-sent if not explicitly set

      const origOnLoad = xhr.onload;
      xhr.onload = function () {
        postLog({
          url,
          method,
          statusCode: xhr.status,
          duration: Math.round(performance.now() - startTime),
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          actionTaken: 'modify_headers',
          intercepted: true
        });
        if (origOnLoad) origOnLoad.call(xhr);
      };
      return originalXHRSend.call(xhr, body);
    }

    // ----- delay via rule -----
    if (matchedRule && matchedRule.action.type === 'delay') {
      const delay = matchedRule.action.delayMs || 0;
      if (delay > 0) {
        setTimeout(() => {
          const origOnLoad = xhr.onload;
          xhr.onload = function () {
            postLog({
              url,
              method,
              statusCode: xhr.status,
              duration: Math.round(performance.now() - startTime),
              matchedRuleId: matchedRule.id,
              matchedRuleName: matchedRule.name,
              actionTaken: 'delay',
              intercepted: true
            });
            if (origOnLoad) origOnLoad.call(xhr);
          };
          originalXHRSend.call(xhr, body);
        }, delay);
        return;
      }
    }

    // ----- inject_payload via rule -----
    if (matchedRule && matchedRule.action.type === 'inject_payload') {
      const cfg       = matchedRule.action.injectPayload || {};
      const rawBody   = typeof body === 'string' ? body : _bodyToString(body);
      const newBody   = _applyPayloadInjection(rawBody, cfg);
      const origOnLoad = xhr.onload;
      xhr.onload = function () {
        postLog({
          url,
          method,
          statusCode: xhr.status,
          duration: Math.round(performance.now() - startTime),
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          actionTaken: 'inject_payload',
          intercepted: true
        });
        if (origOnLoad) origOnLoad.call(xhr);
      };
      return originalXHRSend.call(xhr, newBody);
    }

    // ----- Passthrough with optional logging -----
    if (enabled && enableLogging) {
      const origOnLoad = xhr.onload;
      xhr.onload = function () {
        postLog({
          url,
          method,
          statusCode: xhr.status,
          duration: Math.round(performance.now() - startTime),
          intercepted: false
        });
        if (origOnLoad) origOnLoad.call(xhr);
      };
    }

    return originalXHRSend.call(xhr, body);
  };

  // =========================================================================
  // Cleanup function - restores all original natives
  // =========================================================================
  window._neuronInterceptorCleanup = function () {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXHROpen;
    XMLHttpRequest.prototype.send = originalXHRSend;
    XMLHttpRequest.prototype.setRequestHeader = originalXHRSetRequestHeader;
    console.log('[Mocxy] Interceptor cleaned up');
  };

  console.log('[Mocxy] Interceptor injected and waiting for rules');

  // Signal content script that we are ready to receive rules.
  // This handles the race condition where the content script fetched rules
  // and sent them via postMessage before this script finished loading.
  window.postMessage({ source: 'mocxy-inject', type: 'INJECT_READY' }, '*');
})();
