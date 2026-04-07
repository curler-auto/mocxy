/**
 * Mocxy Mock Server — Matcher
 * WireMock-level request matching engine.
 */

/**
 * Find the highest-priority enabled mock that matches the incoming request.
 * @param {import('express').Request} req
 * @param {Array} mocks
 * @returns {object|null}
 */
export function findMatch(req, mocks) {
  const candidates = mocks
    .filter((m) => m.enabled !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const mock of candidates) {
    if (matches(req, mock)) return mock;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Core matching                                                             */
/* -------------------------------------------------------------------------- */

function matches(req, mock) {
  const r = mock.request || {};

  // 1. Method
  if (r.method && r.method !== 'ANY') {
    if (req.method.toUpperCase() !== r.method.toUpperCase()) return false;
  }

  // 2. URL / path
  if (r.url) {
    if (!matchUrl(req.path, req.originalUrl, r.url, r.urlMatchType || 'contains')) return false;
  }

  // 3. Query parameters
  if (r.queryParams && r.queryParams.length > 0) {
    const qp = req.query || {};
    for (const cond of r.queryParams) {
      if (!cond.enabled || !cond.key) continue;
      const actual = qp[cond.key];
      if (cond.matchType === 'absent') {
        if (actual !== undefined) return false;
        continue;
      }
      if (actual === undefined) return false;
      if (!matchValue(String(actual), cond.matchType || 'equals', cond.value || '')) return false;
    }
  }

  // 4. Request headers
  if (r.headers && r.headers.length > 0) {
    for (const cond of r.headers) {
      if (!cond.enabled || !cond.name) continue;
      const actual = req.headers[cond.name.toLowerCase()] || '';
      if (cond.matchType === 'absent') {
        if (actual) return false;
        continue;
      }
      if (!matchValue(actual, cond.matchType || 'equals', cond.value || '')) return false;
    }
  }

  // 5. Body patterns (AND logic — all must match)
  if (r.bodyPatterns && r.bodyPatterns.length > 0) {
    const rawBody = req._rawBody || '';
    let parsed = null;
    try { parsed = JSON.parse(rawBody); } catch (_) {}

    for (const pattern of r.bodyPatterns) {
      if (!pattern.value) continue;
      if (!matchBodyPattern(rawBody, parsed, pattern)) return false;
    }
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*  URL matching                                                              */
/* -------------------------------------------------------------------------- */

function matchUrl(path, originalUrl, pattern, type) {
  switch (type) {
    case 'equals':
      return path === pattern || originalUrl === pattern;

    case 'contains':
      return originalUrl.includes(pattern) || path.includes(pattern);

    case 'regex':
      try { return new RegExp(pattern).test(originalUrl); }
      catch (_) { return false; }

    case 'path': {
      // Glob: /api/** or /api/*/data — only matches the path portion
      const regex = '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*') + '$';
      try { return new RegExp(regex).test(path); }
      catch (_) { return false; }
    }

    default:
      return originalUrl.includes(pattern);
  }
}

/* -------------------------------------------------------------------------- */
/*  Value matching                                                            */
/* -------------------------------------------------------------------------- */

function matchValue(actual, type, expected) {
  switch (type) {
    case 'equals':   return actual === expected;
    case 'contains': return actual.includes(expected);
    case 'regex':
      try { return new RegExp(expected).test(actual); }
      catch (_) { return false; }
    default: return actual === expected;
  }
}

/* -------------------------------------------------------------------------- */
/*  Body pattern matching                                                     */
/* -------------------------------------------------------------------------- */

function matchBodyPattern(rawBody, parsed, pattern) {
  switch (pattern.type) {
    case 'contains':
      return rawBody.includes(pattern.value);

    case 'equals':
      return rawBody === pattern.value ||
        JSON.stringify(parsed) === pattern.value;

    case 'regex':
      try { return new RegExp(pattern.value).test(rawBody); }
      catch (_) { return false; }

    case 'jsonpath':
      if (!parsed) return false;
      return evaluateJsonPath(parsed, pattern.value);

    default:
      return rawBody.includes(pattern.value);
  }
}

/* -------------------------------------------------------------------------- */
/*  JSONPath evaluator                                                        */
/*  Supports: $.field, $.field.sub, $.arr[0]                                 */
/*  Comparisons: == != > < >= <= contains                                    */
/* -------------------------------------------------------------------------- */

function evaluateJsonPath(obj, path) {
  // Comparison expression: $.field == "value"
  const cmpMatch = path.match(/^(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/);
  if (cmpMatch) {
    const [, lhs, op, rhs] = cmpMatch;
    const lhsVal = resolvePath(obj, lhs.trim());
    let rhsVal;
    try { rhsVal = JSON.parse(rhs.trim()); }
    catch (_) { rhsVal = rhs.trim().replace(/^['"]|['"]$/g, ''); }

    switch (op) {
      case '==':       return lhsVal == rhsVal;   // eslint-disable-line
      case '!=':       return lhsVal != rhsVal;   // eslint-disable-line
      case '>':        return lhsVal > rhsVal;
      case '<':        return lhsVal < rhsVal;
      case '>=':       return lhsVal >= rhsVal;
      case '<=':       return lhsVal <= rhsVal;
      case 'contains': return String(lhsVal).includes(String(rhsVal));
      default:         return false;
    }
  }

  // Plain path: $.field.sub[0]
  const val = resolvePath(obj, path);
  return val !== undefined && val !== null && val !== false;
}

function resolvePath(obj, path) {
  const segs = path.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean);
  let cur = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[/^\d+$/.test(seg) ? parseInt(seg, 10) : seg];
  }
  return cur;
}
