/**
 * dnr-manager.js
 *
 * Manages chrome.declarativeNetRequest (DNR) dynamic rules as a fast-path for
 * simple hostname redirects.  Only rules whose URL condition type is 'contains'
 * or 'equals' are eligible — regex / glob patterns are too expressive for the
 * DNR urlFilter syntax and are handled exclusively by the JS rule engine.
 */

/* -------------------------------------------------------------------------- */
/*  Eligible rule types for DNR conversion                                    */
/* -------------------------------------------------------------------------- */

const DNR_ELIGIBLE_URL_TYPES = new Set(['contains', 'equals']);

/**
 * Starting ID for dynamic DNR rules.  Using a high base avoids collisions with
 * any static rules defined in the manifest's rule_resources.
 */
const DNR_ID_BASE = 10000;

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Synchronise chrome.declarativeNetRequest dynamic rules with the current
 * application rules.
 *
 * Only **enabled redirect rules** whose URL condition uses 'contains' or
 * 'equals' and whose action config has `preservePath: true` are converted.
 *
 * The function replaces ALL existing dynamic rules on every call so the DNR
 * state always mirrors the application rule set exactly.
 *
 * @param {Array} rules — the full application rules array
 */
export async function syncDNRRules(rules) {
  if (!Array.isArray(rules)) {
    rules = [];
  }

  // ---- Build the new DNR rule set ----

  const dnrRules = [];
  let seqId = DNR_ID_BASE;

  for (const rule of rules) {
    if (!_isDNREligible(rule)) {
      continue;
    }

    const urlCondition = rule.condition?.url || {};
    const targetHost = rule.action?.config?.targetHost;

    if (!targetHost || !urlCondition.value) {
      continue;
    }

    dnrRules.push({
      id: seqId++,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          transform: {
            host: targetHost,
          },
        },
      },
      condition: {
        urlFilter: urlCondition.value,
        resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame'],
      },
    });
  }

  // ---- Replace existing dynamic rules ----

  // Fetch current dynamic rule IDs so we can remove them atomically
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: dnrRules,
  });

  console.log(
    `[Mocxy] DNR sync complete — ${dnrRules.length} rule(s) active`
  );
}

/**
 * Remove all dynamic DNR rules managed by this extension.
 */
export async function clearDNRRules() {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((r) => r.id);

  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: [],
    });
  }

  console.log('[Mocxy] All dynamic DNR rules cleared');
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Determine whether an application rule can be expressed as a DNR rule.
 *
 * Criteria:
 *  1. Rule is enabled
 *  2. Action type is 'redirect'
 *  3. Action config has preservePath: true
 *  4. URL condition type is 'contains' or 'equals'
 *
 * @param {Object} rule
 * @returns {boolean}
 */
function _isDNREligible(rule) {
  if (rule.enabled === false) {
    return false;
  }

  if (rule.action?.type !== 'redirect') {
    return false;
  }

  if (!rule.action?.config?.preservePath) {
    return false;
  }

  const urlType = rule.condition?.url?.type;
  if (!urlType || !DNR_ELIGIBLE_URL_TYPES.has(urlType)) {
    return false;
  }

  return true;
}
