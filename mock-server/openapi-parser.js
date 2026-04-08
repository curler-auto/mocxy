/**
 * Mocxy — OpenAPI → Mock Collection Parser
 *
 * Converts an OpenAPI 3.x or Swagger 2.x spec into a Mocxy collection.
 * Organises mocks into folders by tag (same as Postman).
 * Generates realistic response bodies from schemas or examples.
 */

import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a raw spec string (JSON or YAML) into a Mocxy collection object.
 * @param {string} raw       Raw spec content
 * @param {object} [opts]    { name?: string }
 * @returns {object}         Mocxy collection (not yet persisted)
 */
export function parseSpec(raw, opts = {}) {
  const spec = parseRaw(raw);
  return specToCollection(spec, opts);
}

/**
 * Parse spec, then ask the AI for richer test scenarios per endpoint.
 * Returns a prompt string that should be sent to the LLM.
 * The LLM response should be passed to applyScenarios().
 *
 * @param {string} raw
 * @returns {{ collection: object, scenarioPrompt: string, spec: object }}
 */
export function prepareScenarios(raw) {
  const spec       = parseRaw(raw);
  const collection = specToCollection(spec);

  const ops = summariseOperations(spec);
  const scenarioPrompt = buildScenarioPrompt(ops, spec.info?.title || 'API');

  return { collection, scenarioPrompt, spec };
}

/**
 * Merge AI-generated scenario mocks into an existing collection.
 * The LLM should return a JSON array of mock objects (possibly grouped by folder).
 *
 * @param {object} collection   Result of specToCollection()
 * @param {object[]} stubs      Mocks extracted from LLM reply (via extractStubs)
 * @returns {object}            Updated collection
 */
export function applyScenarios(collection, stubs) {
  // Group stubs by their name prefix / folder hints
  // We'll add all stubs into a top-level "AI Scenarios" folder
  const folder = {
    type:  'folder',
    id:    uuidv4(),
    name:  'AI Scenarios',
    items: stubs.map(s => ({ type: 'mock', id: uuidv4(), ...s,
      request:  { method:'ANY', urlMatchType:'contains', url:'', queryParams:[], headers:[], bodyPatterns:[], ...(s.request||{}) },
      response: { status:200, headers:{'Content-Type':'application/json'}, body:'{}', delayMs:0, delayJitter:0, fault:'none', ...(s.response||{}) },
      stats: { matched:0, lastMatchedAt:null },
      createdAt: new Date().toISOString(), updatedAt: null,
    })),
  };
  return { ...collection, items: [...collection.items, folder] };
}

/* -------------------------------------------------------------------------- */
/*  Raw parsing                                                               */
/* -------------------------------------------------------------------------- */

function parseRaw(raw) {
  const trimmed = (raw || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    try {
      return yaml.load(trimmed);
    } catch (err) {
      throw new Error('Could not parse spec as JSON or YAML: ' + err.message);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Spec → Collection                                                         */
/* -------------------------------------------------------------------------- */

function specToCollection(spec, opts = {}) {
  const title   = opts.name || spec.info?.title || 'Imported API';
  const version = spec.info?.version ? ` (v${spec.info.version})` : '';
  const paths   = spec.paths || {};

  // Collect operations grouped by first tag
  const tagGroups = {};  // tag → [{ path, method, operation }]
  const untagged  = [];

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method)) continue;
      const tags = (operation.tags && operation.tags.length > 0)
        ? operation.tags : ['General'];
      tags.forEach(tag => {
        if (!tagGroups[tag]) tagGroups[tag] = [];
        tagGroups[tag].push({ path, method, operation });
      });
    }
  }

  // Build folders per tag
  const items = [];
  for (const [tag, ops] of Object.entries(tagGroups)) {
    const folder = {
      type:  'folder',
      id:    uuidv4(),
      name:  tag,
      items: ops.map(({ path, method, operation }) =>
        operationToMock(path, method, operation, spec)
      ),
    };
    items.push(folder);
  }

  return {
    id:          uuidv4(),
    name:        title + version,
    description: spec.info?.description || '',
    enabled:     true,
    items,
    createdAt:   new Date().toISOString(),
    updatedAt:   null,
  };
}

const HTTP_METHODS = new Set(['get','post','put','patch','delete','head','options']);

/* -------------------------------------------------------------------------- */
/*  Operation → Mock                                                          */
/* -------------------------------------------------------------------------- */

function operationToMock(path, method, operation, spec) {
  const name       = operation.summary || operation.operationId
    || `${method.toUpperCase()} ${path}`;
  const statusCode = bestStatusCode(operation.responses);
  const body       = bestResponseBody(operation.responses, statusCode, spec);

  // Build body patterns from requestBody schema if present
  const bodyPatterns = [];
  if (operation.requestBody?.content?.['application/json']?.schema) {
    const schema = resolveRef(
      operation.requestBody.content['application/json'].schema, spec
    );
    const required = schema?.required || [];
    if (required.length > 0) {
      bodyPatterns.push({ type: 'contains', value: required[0] });
    }
  }

  return {
    type:     'mock',
    id:       uuidv4(),
    name,
    priority: 0,
    enabled:  true,
    request: {
      method:       method.toUpperCase(),
      urlMatchType: path.includes('{') ? 'regex' : 'path',
      url:          path.includes('{')
        ? '^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '/?$'
        : path,
      queryParams:  [],
      headers:      [],
      bodyPatterns,
    },
    response: {
      status:      statusCode,
      headers:     { 'Content-Type': 'application/json' },
      body:        typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      delayMs:     0,
      delayJitter: 0,
      fault:       'none',
    },
    stats:     { matched: 0, lastMatchedAt: null },
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Response extraction                                                       */
/* -------------------------------------------------------------------------- */

function bestStatusCode(responses) {
  if (!responses) return 200;
  for (const code of ['200', '201', '204', '202']) {
    if (responses[code]) return parseInt(code, 10);
  }
  const numeric = Object.keys(responses)
    .filter(c => /^\d+$/.test(c))
    .sort();
  return numeric.length ? parseInt(numeric[0], 10) : 200;
}

function bestResponseBody(responses, code, spec) {
  if (!responses) return '{}';
  const resp = responses[String(code)] || responses['2XX'] || responses['default'];
  if (!resp) return '{}';

  const mediaTypes = resp.content || {};
  const jsonContent = mediaTypes['application/json'] || mediaTypes['*/*']
    || Object.values(mediaTypes)[0];
  if (!jsonContent) return resp.description ? `"${resp.description}"` : '{}';

  // Explicit example takes priority
  if (jsonContent.example !== undefined) {
    return typeof jsonContent.example === 'string'
      ? jsonContent.example
      : JSON.stringify(jsonContent.example, null, 2);
  }

  // First named example
  const examples = jsonContent.examples || {};
  const firstEx  = Object.values(examples)[0];
  if (firstEx?.value !== undefined) {
    return typeof firstEx.value === 'string'
      ? firstEx.value
      : JSON.stringify(firstEx.value, null, 2);
  }

  // Generate from schema
  if (jsonContent.schema) {
    const generated = generateFromSchema(
      resolveRef(jsonContent.schema, spec), spec, 0
    );
    return generated !== null
      ? JSON.stringify(generated, null, 2)
      : '{}';
  }

  return '{}';
}

/* -------------------------------------------------------------------------- */
/*  Schema → sample value generator                                           */
/* -------------------------------------------------------------------------- */

function resolveRef(schema, spec) {
  if (!schema?.$ref) return schema;
  const parts = schema.$ref
    .replace(/^#\//, '')
    .split('/');
  let cur = spec;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined) return schema;
  }
  return cur;
}

const DEPTH_LIMIT = 5;

function generateFromSchema(schema, spec, depth) {
  if (depth > DEPTH_LIMIT || !schema) return null;
  const s = resolveRef(schema, spec) || {};

  // allOf / anyOf / oneOf — pick first
  if (s.allOf) return generateFromSchema(s.allOf[0], spec, depth + 1);
  if (s.anyOf) return generateFromSchema(s.anyOf[0], spec, depth + 1);
  if (s.oneOf) return generateFromSchema(s.oneOf[0], spec, depth + 1);

  if (s.example !== undefined) return s.example;
  if (s.default  !== undefined) return s.default;

  switch (s.type) {
    case 'object': {
      const obj = {};
      for (const [k, v] of Object.entries(s.properties || {})) {
        const val = generateFromSchema(resolveRef(v, spec), spec, depth + 1);
        if (val !== null) obj[k] = val;
      }
      return obj;
    }
    case 'array': {
      const item = generateFromSchema(resolveRef(s.items, spec), spec, depth + 1);
      return item !== null ? [item] : [];
    }
    case 'string':
      if (s.enum)   return s.enum[0];
      switch (s.format) {
        case 'date-time': return new Date().toISOString();
        case 'date':      return new Date().toISOString().slice(0, 10);
        case 'uuid':      return uuidv4();
        case 'email':     return 'user@example.com';
        case 'uri':       return 'https://example.com';
        default:          return s.title ? s.title.toLowerCase().replace(/\s+/g, '_') : 'string';
      }
    case 'integer':
    case 'number':
      return s.minimum !== undefined ? s.minimum : 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      // No type hint — try to infer from properties
      if (s.properties) return generateFromSchema({ ...s, type: 'object' }, spec, depth);
      if (s.items)      return generateFromSchema({ ...s, type: 'array'  }, spec, depth);
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  AI scenario prompt builder                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a concise summary of operations for the LLM prompt.
 * We send only the essentials to keep token usage low.
 */
function summariseOperations(spec) {
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.has(method)) continue;
      ops.push({
        method: method.toUpperCase(),
        path,
        summary:  op.summary || op.operationId || '',
        tags:     op.tags    || [],
        params:   (op.parameters || []).map(p => ({ name: p.name, in: p.in, required: p.required })),
        requestBodySchema: op.requestBody?.content?.['application/json']?.schema
          ? '(has JSON body)' : null,
        responseCodes: Object.keys(op.responses || {}),
      });
    }
  }
  return ops;
}

export function buildScenarioPrompt(ops, apiTitle) {
  const opsSummary = ops.map(o =>
    `- ${o.method} ${o.path}${o.summary ? ' — ' + o.summary : ''}` +
    (o.responseCodes.length ? ` [${o.responseCodes.join(', ')}]` : '')
  ).join('\n');

  return `You are generating test scenario mocks for the "${apiTitle}" API.

Endpoints:
${opsSummary}

For EACH endpoint above, generate test scenario mocks:
1. **Happy Path** (200/201) — realistic response body with sample data
2. **Not Found** (404) — when the resource doesn't exist
3. **Unauthorized** (401) — missing/invalid authentication
4. **Bad Request** (400) — validation failure with error details
5. **Server Error** (500) — optional, only for write operations

Rules:
- Each mock must have a unique, descriptive name (e.g. "GET /pets - success", "GET /pets - not found")
- URL should be the exact path string
- Response body should be realistic JSON matching the endpoint's purpose
- Do NOT generate scenarios for HEAD or OPTIONS methods
- Return ONLY a JSON array, no extra text

\`\`\`json
[
  {
    "name": "GET /pets - success",
    "request": { "method": "GET", "urlMatchType": "path", "url": "/pets", "queryParams": [], "headers": [], "bodyPatterns": [] },
    "response": { "status": 200, "headers": { "Content-Type": "application/json" }, "body": "{\"pets\": [{\"id\": 1, \"name\": \"Rex\"}]}", "delayMs": 0, "delayJitter": 0, "fault": "none" }
  }
]
\`\`\``;
}
