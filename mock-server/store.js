/**
 * Mocxy Mock Server — Store
 * File-based mock persistence using mocks.json
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'mocks.json');

let _mocks = [];

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

export async function load() {
  if (!existsSync(STORE_PATH)) { _mocks = []; return; }
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    _mocks = JSON.parse(raw);
    console.log(`  Loaded ${_mocks.length} mock(s) from ${STORE_PATH}`);
  } catch (_) {
    console.warn('  Could not parse mocks.json — starting with empty store');
    _mocks = [];
  }
}

async function save() {
  await writeFile(STORE_PATH, JSON.stringify(_mocks, null, 2), 'utf8');
}

/* -------------------------------------------------------------------------- */
/*  CRUD                                                                      */
/* -------------------------------------------------------------------------- */

export function getAll() {
  return [..._mocks];
}

export function getById(id) {
  return _mocks.find((m) => m.id === id) || null;
}

export async function create(data) {
  const mock = {
    ...defaultMock(),
    ...data,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  // Ensure nested defaults
  mock.request = { ...defaultMock().request, ...(data.request || {}) };
  mock.response = { ...defaultMock().response, ...(data.response || {}) };
  mock.stats    = { matched: 0, lastMatchedAt: null };
  _mocks.push(mock);
  await save();
  return mock;
}

export async function update(id, data) {
  const idx = _mocks.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  _mocks[idx] = {
    ..._mocks[idx],
    ...data,
    id,
    updatedAt: new Date().toISOString(),
  };
  // Preserve nested structure
  if (data.request) {
    _mocks[idx].request = { ...(_mocks[idx].request || {}), ...data.request };
  }
  if (data.response) {
    _mocks[idx].response = { ...(_mocks[idx].response || {}), ...data.response };
  }
  await save();
  return _mocks[idx];
}

export async function remove(id) {
  const idx = _mocks.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  _mocks.splice(idx, 1);
  await save();
  return true;
}

export async function removeAll() {
  _mocks = [];
  await save();
}

export async function importAll(mocks) {
  _mocks = mocks.map((m) => ({
    ...defaultMock(),
    ...m,
    id: m.id || uuidv4(),
    request:  { ...defaultMock().request,  ...(m.request  || {}) },
    response: { ...defaultMock().response, ...(m.response || {}) },
    stats:    m.stats || { matched: 0, lastMatchedAt: null },
  }));
  await save();
  return _mocks;
}

/* -------------------------------------------------------------------------- */
/*  Default mock shape                                                        */
/* -------------------------------------------------------------------------- */

export function defaultMock() {
  return {
    id:       null,
    name:     'Untitled Mock',
    priority: 0,
    enabled:  true,

    // ── Request matching ────────────────────────────────────────────────────
    request: {
      method:       'ANY',        // ANY | GET | POST | PUT | DELETE | PATCH | ...
      urlMatchType: 'contains',   // contains | equals | regex | path
      url:          '',
      queryParams:  [],           // [{key, value, matchType, enabled}]
      headers:      [],           // [{name, value, matchType, enabled}]
      bodyPatterns: [],           // [{type: contains|equals|jsonpath|regex, value}]
    },

    // ── Response ────────────────────────────────────────────────────────────
    response: {
      status:      200,
      headers:     { 'Content-Type': 'application/json' },
      body:        '{}',
      delayMs:     0,
      delayJitter: 0,             // random 0-N ms added on top of delayMs
      fault:       'none',        // none | network_error | empty_response
    },

    stats:     { matched: 0, lastMatchedAt: null },
    createdAt: null,
    updatedAt: null,
  };
}
