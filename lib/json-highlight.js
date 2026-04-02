/**
 * Mocxy - JSON Syntax Highlighter
 * Lightweight, zero-dependency JSON syntax highlighting and validation utilities.
 */

/* -------------------------------------------------------------------------- */
/*  CSS class → token type mapping                                            */
/*                                                                            */
/*    .json-key      — object keys        (#89b4fa / blue)                    */
/*    .json-string   — string values       (#a6e3a1 / green)                  */
/*    .json-number   — numbers             (#fab387 / peach)                  */
/*    .json-boolean  — true / false        (#f9e2af / yellow)                 */
/*    .json-null     — null                (#a6adc8 / muted)                  */
/*    .json-bracket  — { } [ ]             (#cdd6f4 / text)                   */
/*    .json-comma    — , :                 (#6c7086 / dim)                    */
/* -------------------------------------------------------------------------- */

/**
 * HTML-escape a plain-text string so it can be safely injected into markup.
 *
 * @param {string} str  Raw string.
 * @returns {string}    Escaped string.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Apply syntax-highlighting spans to a pre-formatted JSON string.
 *
 * The input should already be pretty-printed (e.g. via `JSON.stringify(v, null, 2)`).
 * The function HTML-escapes the source first, then wraps recognised tokens in
 * `<span class="json-*">` elements.
 *
 * @param {string} jsonString  A formatted JSON string.
 * @returns {string}           HTML string with highlighting spans.
 */
export function highlightJson(jsonString) {
  if (typeof jsonString !== 'string' || jsonString.length === 0) {
    return '';
  }

  // Step 1 — HTML-escape the entire input.
  const escaped = escapeHtml(jsonString);

  // Step 2 — Replace tokens with highlighted spans.
  // Order matters: keys (quoted strings before a colon) must be matched before
  // generic string values so they receive the correct class.

  const highlighted = escaped
    // Object keys — a quoted string followed by a colon
    .replace(
      /(&quot;)((?:[^&]|&(?!quot;))*)(&quot;)(\s*:)/g,
      '<span class="json-key">$1$2$3</span><span class="json-comma">$4</span>'
    )
    // String values — remaining quoted strings
    .replace(
      /(&quot;)((?:[^&]|&(?!quot;))*)(&quot;)/g,
      '<span class="json-string">$1$2$3</span>'
    )
    // Booleans
    .replace(
      /\b(true|false)\b/g,
      '<span class="json-boolean">$1</span>'
    )
    // Null
    .replace(
      /\bnull\b/g,
      '<span class="json-null">null</span>'
    )
    // Numbers — integers and floats (including negative and scientific notation)
    .replace(
      /\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
      '<span class="json-number">$1</span>'
    )
    // Brackets — { } [ ]
    .replace(
      /([{}[\]])/g,
      '<span class="json-bracket">$1</span>'
    )
    // Commas (standalone, not already inside a span)
    .replace(
      /,(\s*\n)/g,
      '<span class="json-comma">,</span>$1'
    );

  return highlighted;
}

/**
 * Pretty-print a JSON string with 2-space indentation.
 *
 * If the input is not valid JSON the original string is returned unchanged.
 *
 * @param {string} str  Raw JSON string (may be compact or malformed).
 * @returns {string}    Formatted JSON string, or the original on parse failure.
 */
export function formatJson(str) {
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return str;
  }
}

/**
 * Validate a JSON string.
 *
 * @param {string} str  The JSON string to validate.
 * @returns {{ valid: boolean, parsed?: *, error?: string }}
 *   On success: `{ valid: true, parsed }`.
 *   On failure: `{ valid: false, error }`.
 */
export function validateJson(str) {
  try {
    const parsed = JSON.parse(str);
    return { valid: true, parsed };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
