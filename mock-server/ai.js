/**
 * Mocxy Mock Server — AI Integration
 *
 * Supports OpenAI, Anthropic, and any OpenAI-compatible endpoint (Ollama, etc.).
 * Guardrails keep the assistant focused strictly on API mocking.
 * Context is compressed so only stub metadata (not full bodies) is sent.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAll } from './store.js';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH   = join(__dirname, 'ai-config.json');

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = {
  provider:    'openai',          // openai | anthropic | custom
  apiKey:      '',
  model:       'gpt-4o-mini',     // cheap + fast for stub generation
  baseUrl:     '',                // custom endpoint (OpenAI-compatible)
  maxTokens:   2048,
  temperature: 0.3,               // lower = more deterministic JSON
};

let _config = { ...DEFAULT_CONFIG };

export async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) { _config = { ...DEFAULT_CONFIG }; return _config; }
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    _config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (_) { _config = { ...DEFAULT_CONFIG }; }
  return _config;
}

export async function saveConfig(cfg) {
  _config = { ...DEFAULT_CONFIG, ...cfg };
  // Never persist the key if it's masked
  const toSave = { ..._config };
  await writeFile(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
  return _config;
}

export function getConfig() {
  // Mask key in responses
  return { ..._config, apiKey: _config.apiKey ? '••••••••' + _config.apiKey.slice(-4) : '' };
}

export function setApiKey(key) { _config.apiKey = key; }

/* -------------------------------------------------------------------------- */
/*  System prompt (guardrails + schema)                                       */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(mockSummary) {
  return `You are Mocxy AI, an expert assistant for the Mocxy API mock server.

STRICT GUARDRAILS — you ONLY answer questions about:
• Creating, editing, or deleting HTTP API mock stubs
• Request matching (URL, method, headers, query params, body/JSONPath)
• Response configuration (status codes, headers, body, delays, faults)
• Analyzing mock configurations for conflicts, duplicates, or issues
• Bulk modifications to existing mocks
• API testing strategies and best practices

If asked anything UNRELATED to API mocking or HTTP testing, respond:
"I only assist with API mock configuration. Please ask about stubs, request matching, or response setup."

MOCXY STUB SCHEMA (use this exact structure when generating stubs):
{
  "name": "string",
  "priority": 0,
  "enabled": true,
  "request": {
    "method": "ANY|GET|POST|PUT|DELETE|PATCH",
    "urlMatchType": "contains|equals|regex|path",
    "url": "string",
    "queryParams": [{"key":"","value":"","matchType":"equals|contains|regex|absent","enabled":true}],
    "headers":     [{"name":"","value":"","matchType":"equals|contains|regex|absent","enabled":true}],
    "bodyPatterns":[{"type":"contains|equals|jsonpath|regex","value":""}]
  },
  "response": {
    "status": 200,
    "headers": {"Content-Type":"application/json"},
    "body": "{}",
    "delayMs": 0,
    "delayJitter": 0,
    "fault": "none|network_error|empty_response"
  }
}

RESPONSE RULES:
1. When generating stubs, ALWAYS return valid JSON wrapped in a code block:
   \`\`\`json
   { ...stub }  or  [{ ...stub1 }, { ...stub2 }]
   \`\`\`
2. After the JSON, explain what the stub does in 1-2 sentences.
3. For analysis/insights, use plain text with bullet points.
4. Be concise — developers prefer brevity.

CURRENT SERVER STATE (${mockSummary.total} stubs):
${mockSummary.list}`;
}

/* -------------------------------------------------------------------------- */
/*  Context compression                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build a compact summary of current mocks for the system prompt.
 * Sends only name/method/url/status — NOT bodies (saves tokens).
 */
function buildMockSummary() {
  const mocks = getAll();
  if (mocks.length === 0) {
    return { total: 0, list: '(no stubs configured yet)' };
  }
  const list = mocks
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((m, i) => {
      const method = (m.request?.method || 'ANY').padEnd(7);
      const url    = (m.request?.url    || '(any)').slice(0, 50);
      const status = m.response?.status || 200;
      const hits   = m.stats?.matched   || 0;
      const dis    = m.enabled === false ? ' [DISABLED]' : '';
      return `${i + 1}. [${method}] ${url} → ${status}  "${m.name}"  hits:${hits}${dis}`;
    })
    .join('\n');
  return { total: mocks.length, list };
}

/* -------------------------------------------------------------------------- */
/*  LLM call                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send a chat message to the configured LLM.
 * @param {Array}  messages  [{role:'user'|'assistant', content:string}]
 * @returns {string}  assistant reply
 */
export async function chat(messages) {
  if (!_config.apiKey) {
    throw new Error('No API key configured. Go to Settings → AI Assistant to add one.');
  }

  const summary    = buildMockSummary();
  const systemPrompt = buildSystemPrompt(summary);

  switch (_config.provider) {
    case 'anthropic': return callAnthropic(systemPrompt, messages);
    case 'openai':
    case 'custom':
    default:           return callOpenAI(systemPrompt, messages);
  }
}

/* -------------------------------------------------------------------------- */
/*  OpenAI / compatible                                                       */
/* -------------------------------------------------------------------------- */

async function callOpenAI(systemPrompt, messages) {
  const baseUrl = _config.baseUrl || 'https://api.openai.com/v1';
  const url     = `${baseUrl}/chat/completions`;

  const body = {
    model:       _config.model || 'gpt-4o-mini',
    max_tokens:  _config.maxTokens  || 2048,
    temperature: _config.temperature ?? 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-10),               // last 10 turns = manageable context
    ],
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${_config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error ${res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '(empty response)';
}

/* -------------------------------------------------------------------------- */
/*  Anthropic                                                                 */
/* -------------------------------------------------------------------------- */

async function callAnthropic(systemPrompt, messages) {
  const url  = 'https://api.anthropic.com/v1/messages';
  const body = {
    model:      _config.model || 'claude-haiku-4-5-20251001',
    max_tokens: _config.maxTokens || 2048,
    system:     systemPrompt,
    messages:   messages.slice(-10),
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         _config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '(empty response)';
}

/* -------------------------------------------------------------------------- */
/*  Stub extraction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Parse all JSON code blocks from an AI response.
 * Returns an array of stub objects (or arrays of stubs) found.
 */
export function extractStubs(text) {
  const blocks = [];
  const regex  = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      // Accept single stub or array of stubs
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed && typeof parsed === 'object') blocks.push(parsed);
    } catch (_) {}
  }
  return blocks;
}
