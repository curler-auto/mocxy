/**
 * Mocxy - Shared Utilities
 * Pure helper functions with zero side-effects.
 */

import { URL_MATCH_TYPES, HEADER_MATCH_TYPES } from './constants.js';

/**
 * Generate a unique identifier.
 * Uses `crypto.randomUUID()` where available, otherwise falls back to a
 * timestamp + random hex string.
 *
 * @returns {string}
 */
export function generateId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supports:
 *   `**` -- matches everything including `/`
 *   `*`  -- matches everything except `/`
 *   `?`  -- matches any single character
 *
 * All other regex-special characters are escaped.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegex(glob) {
  let i = 0;
  let regex = '^';
  const len = glob.length;

  while (i < len) {
    const ch = glob[i];

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        regex += '.*';
        i += 2;
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '.';
      i += 1;
    } else {
      // Escape regex-special characters
      regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }

  regex += '$';
  return new RegExp(regex);
}

/**
 * Test whether a URL matches the given condition.
 *
 * @param {string} url        The full URL string to test.
 * @param {string} matchType  One of URL_MATCH_TYPES.
 * @param {string} matchValue The pattern / substring / regex string.
 * @returns {boolean}
 */
export function matchUrl(url, matchType, matchValue) {
  if (!matchValue) return false;

  switch (matchType) {
    case URL_MATCH_TYPES.EQUALS:
      return url === matchValue;

    case URL_MATCH_TYPES.CONTAINS:
      return url.includes(matchValue);

    case URL_MATCH_TYPES.REGEX:
      try {
        return new RegExp(matchValue).test(url);
      } catch (_) {
        return false;
      }

    case URL_MATCH_TYPES.GLOB:
      return globToRegex(matchValue).test(url);

    default:
      return false;
  }
}

/**
 * Test whether a set of headers satisfies a single header condition.
 *
 * @param {Object}  headers   Key/value map of headers (keys lower-cased).
 * @param {Object}  condition { name: string, value: string, type: string }
 * @returns {boolean}
 */
export function matchHeader(headers, condition) {
  if (!condition || !condition.name) return false;

  const headerValue = headers[condition.name.toLowerCase()];
  if (headerValue === undefined) return false;
  if (!condition.value) return true; // Name-only match

  switch (condition.type) {
    case HEADER_MATCH_TYPES.EQUALS:
      return headerValue === condition.value;

    case HEADER_MATCH_TYPES.CONTAINS:
      return headerValue.includes(condition.value);

    case HEADER_MATCH_TYPES.REGEX:
      try {
        return new RegExp(condition.value).test(headerValue);
      } catch (_) {
        return false;
      }

    default:
      return headerValue === condition.value;
  }
}

/**
 * Deep-clone a value.
 * Prefers `structuredClone` where available; falls back to JSON round-trip.
 *
 * @param {*} obj
 * @returns {*}
 */
export function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch (_) {
    return JSON.parse(JSON.stringify(obj));
  }
}

/**
 * Standard debounce wrapper.
 *
 * @param {Function} fn
 * @param {number}   ms  Delay in milliseconds.
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Format a Unix-epoch timestamp to `YYYY-MM-DD HH:mm:ss.SSS`.
 *
 * @param {number} ts  Millisecond timestamp.
 * @returns {string}
 */
export function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds()) +
    '.' +
    pad3(d.getMilliseconds())
  );
}

/**
 * Format a millisecond duration into a human-readable string.
 *
 * Examples: "123ms", "1.5s", "2m 30s", "1h 5m"
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}

/**
 * Truncate a string, appending an ellipsis if it exceeds `maxLen`.
 *
 * @param {string} str
 * @param {number} [maxLen=100]
 * @returns {string}
 */
export function truncate(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\u2026';
}

/**
 * Safely parse a JSON string.
 * Returns the parsed value on success, or `null` on failure.
 *
 * @param {string} str
 * @returns {*|null}
 */
export function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}
