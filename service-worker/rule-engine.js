/**
 * rule-engine.js
 *
 * Rule condition matching engine.  Given a request descriptor and an array of
 * rules, evaluates conditions (URL, headers, method) and returns the first
 * matching enabled rule (highest priority first) or null.
 */

import { matchUrl, matchHeader } from '../shared/utils.js';

/* -------------------------------------------------------------------------- */
/*  URL condition matching                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Test whether `url` satisfies a single URL condition object.
 *
 * @param {string} url               — full request URL
 * @param {Object} urlCondition       — { type, value }
 *        type: 'equals' | 'contains' | 'regex' | 'glob'
 *        value: the pattern string
 * @returns {boolean}
 */
export function matchUrlCondition(url, urlCondition) {
  if (!urlCondition || !urlCondition.value) {
    // No URL condition means "match any URL"
    return true;
  }
  return matchUrl(url, urlCondition.type, urlCondition.value);
}

/* -------------------------------------------------------------------------- */
/*  Header condition matching                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Verify that ALL header conditions are satisfied.
 *
 * @param {Object}  headers          — request headers as { name: value } map
 * @param {Array}   headerConditions — array of { name, value, type? } objects
 * @returns {boolean}
 */
export function matchHeaderConditions(headers, headerConditions) {
  if (!Array.isArray(headerConditions) || headerConditions.length === 0) {
    return true;
  }

  return headerConditions.every((condition) => {
    const headerValue = headers
      ? headers[condition.name] || headers[condition.name.toLowerCase()]
      : undefined;
    return matchHeader(headerValue, condition.value, condition.type);
  });
}

/* -------------------------------------------------------------------------- */
/*  Method condition matching                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Check whether the request method is in the allowed list.
 * An empty / missing array means "match all methods".
 *
 * @param {string}       method  — e.g. 'GET', 'POST'
 * @param {Array<string>} methods — allowed methods (upper-case)
 * @returns {boolean}
 */
export function matchMethodCondition(method, methods) {
  if (!Array.isArray(methods) || methods.length === 0) {
    return true;
  }
  return methods.includes(method.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/*  Full condition evaluation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate a single rule's condition block against a request.
 * All specified sub-conditions must match (AND logic).
 *
 * @param {Object} requestInfo        — { url, method, headers }
 * @param {Object} condition          — rule.condition object:
 *        { url?: { type, value }, headers?: [...], methods?: [...] }
 * @returns {boolean}
 */
export function matchCondition(requestInfo, condition) {
  if (!condition) {
    // No conditions means the rule matches everything
    return true;
  }

  // URL match
  if (condition.url && !matchUrlCondition(requestInfo.url, condition.url)) {
    return false;
  }

  // Header matches
  if (!matchHeaderConditions(requestInfo.headers || {}, condition.headers)) {
    return false;
  }

  // Method match
  if (!matchMethodCondition(requestInfo.method || 'GET', condition.methods)) {
    return false;
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*  Action result builder                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract the action descriptor from a matched rule for downstream handling.
 *
 * @param {Object} rule — the matched rule object
 * @returns {Object} { ruleId, ruleName, actionType, actionConfig }
 */
export function buildActionResult(rule) {
  return {
    ruleId: rule.id,
    ruleName: rule.name || '',
    actionType: rule.action?.type || 'passthrough',
    actionConfig: rule.action?.config || {},
  };
}

/* -------------------------------------------------------------------------- */
/*  Main evaluation entry point                                               */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate an array of rules against a request and return the first matching
 * enabled rule (sorted by priority descending — higher priority wins).
 *
 * @param {Object}  requestInfo — { url, method, headers }
 * @param {Array}   rules       — array of rule objects
 * @returns {Object|null} action result for the first match, or null
 */
export function evaluateRules(requestInfo, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return null;
  }

  // Sort by priority descending (higher number = higher priority)
  const sorted = [...rules].sort(
    (a, b) => (b.priority || 0) - (a.priority || 0)
  );

  for (const rule of sorted) {
    // Skip disabled rules
    if (rule.enabled === false) {
      continue;
    }

    if (matchCondition(requestInfo, rule.condition)) {
      return buildActionResult(rule);
    }
  }

  return null;
}
