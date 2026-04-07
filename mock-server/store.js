/**
 * Mocxy Mock Server — Store
 *
 * WireMock-style persistence: each stub lives in its own JSON file
 * inside the  stubs/  directory (one file per mock, git-friendly).
 *
 * stubs/
 *   ├── 3f2a1b.json          ← Fleet Summary mock
 *   ├── 9c4d2e.json          ← Auth Token mock
 *   └── ...
 *
 * Advantages over a single mocks.json:
 *   • One corrupt file doesn't wipe everything
 *   • Each stub is individually version-controllable
 *   • Drop a .json file into stubs/ and it's live on next restart
 *   • Human-readable file names (derived from mock name)
 */

import {
  readFile, writeFile, readdir, unlink, mkdir, rename,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const STUBS_DIR  = join(__dirname, 'stubs');
const LEGACY_FILE = join(__dirname, 'mocks.json'); // migrated on first boot

let _mocks = [];   // in-memory index

/* -------------------------------------------------------------------------- */
/*  Boot: load all stubs from the stubs/ directory                           */
/* -------------------------------------------------------------------------- */

export async function load() {
  // Ensure stubs directory exists
  await mkdir(STUBS_DIR, { recursive: true });

  // Migrate legacy mocks.json → individual files (one-time)
  if (existsSync(LEGACY_FILE)) {
    await migrateLegacy();
  }

  // Load every .json file in stubs/
  let files;
  try {
    files = (await readdir(STUBS_DIR)).filter(f => f.endsWith('.json'));
  } catch (_) {
    files = [];
  }

  _mocks = [];
  let loaded = 0;
  for (const file of files) {
    try {
      const raw  = await readFile(join(STUBS_DIR, file), 'utf8');
      const mock = JSON.parse(raw);
      if (mock && mock.id) {
        _mocks.push(mock);
        loaded++;
      } else {
        console.warn(`  [store] Skipped ${file} — missing id field`);
      }
    } catch (err) {
      console.warn(`  [store] Could not parse ${file}: ${err.message}`);
    }
  }

  console.log(`  Loaded ${loaded} stub${loaded !== 1 ? 's' : ''} from stubs/`);
}

/* -------------------------------------------------------------------------- */
/*  Migrate legacy mocks.json → per-stub files (runs once)                  */
/* -------------------------------------------------------------------------- */

async function migrateLegacy() {
  try {
    const raw   = await readFile(LEGACY_FILE, 'utf8');
    const mocks = JSON.parse(raw);
    if (!Array.isArray(mocks) || mocks.length === 0) {
      await unlink(LEGACY_FILE).catch(() => {});
      return;
    }
    console.log(`  Migrating ${mocks.length} mock(s) from mocks.json → stubs/`);
    for (const mock of mocks) {
      if (!mock.id) mock.id = uuidv4();
      await writeStubFile(mock);
    }
    // Rename legacy file so it won't be re-migrated
    await rename(LEGACY_FILE, LEGACY_FILE + '.migrated');
    console.log(`  Migration complete — mocks.json renamed to mocks.json.migrated`);
  } catch (err) {
    console.warn(`  Migration failed: ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  File I/O helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Derive a safe filename from a mock's name + id.
 * e.g.  "Fleet Summary Mock"  →  "fleet-summary-mock-3f2a1b.json"
 */
function stubFilename(mock) {
  const slug = (mock.name || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mock';
  return `${slug}-${mock.id.slice(0, 6)}.json`;
}

/**
 * Write a single stub to its file atomically (write temp → rename).
 * Atomic rename prevents partial writes corrupting the file.
 */
async function writeStubFile(mock) {
  const filename = stubFilename(mock);
  const filePath = join(STUBS_DIR, filename);
  const tmpPath  = filePath + '.tmp';

  await writeFile(tmpPath, JSON.stringify(mock, null, 2), 'utf8');
  await rename(tmpPath, filePath);          // atomic on POSIX / best-effort on Windows

  return filePath;
}

/**
 * Delete the stub file for the given mock id.
 * Scans the directory to find the file (filename may have changed if
 * the mock was renamed before the old file was cleaned up).
 */
async function deleteStubFile(id) {
  const files = await readdir(STUBS_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw  = await readFile(join(STUBS_DIR, file), 'utf8');
      const mock = JSON.parse(raw);
      if (mock.id === id) {
        await unlink(join(STUBS_DIR, file));
        return;
      }
    } catch (_) {}
  }
}

/* -------------------------------------------------------------------------- */
/*  CRUD — all mutations write through to disk immediately                   */
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
    id:        uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    stats:     { matched: 0, lastMatchedAt: null },
  };
  // Deep-merge nested objects
  mock.request  = { ...defaultMock().request,  ...(data.request  || {}) };
  mock.response = { ...defaultMock().response, ...(data.response || {}) };

  _mocks.push(mock);
  await writeStubFile(mock);
  return mock;
}

export async function update(id, data) {
  const idx = _mocks.findIndex((m) => m.id === id);
  if (idx === -1) return null;

  const oldName = _mocks[idx].name;

  _mocks[idx] = {
    ..._mocks[idx],
    ...data,
    id,
    updatedAt: new Date().toISOString(),
  };
  if (data.request) {
    _mocks[idx].request  = { ...(_mocks[idx].request  || {}), ...data.request };
  }
  if (data.response) {
    _mocks[idx].response = { ...(_mocks[idx].response || {}), ...data.response };
  }

  // If the mock was renamed, delete the old file first so stubs/ stays clean
  const newName = _mocks[idx].name;
  if (oldName !== newName) {
    await deleteStubFile(id);
  }

  await writeStubFile(_mocks[idx]);
  return _mocks[idx];
}

export async function remove(id) {
  const idx = _mocks.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  _mocks.splice(idx, 1);
  await deleteStubFile(id);
  return true;
}

export async function removeAll() {
  const files = await readdir(STUBS_DIR).catch(() => []);
  await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(f => unlink(join(STUBS_DIR, f)).catch(() => {}))
  );
  _mocks = [];
}

export async function importAll(mocks) {
  // Clear existing stubs
  await removeAll();
  _mocks = mocks.map((m) => ({
    ...defaultMock(),
    ...m,
    id:       m.id || uuidv4(),
    request:  { ...defaultMock().request,  ...(m.request  || {}) },
    response: { ...defaultMock().response, ...(m.response || {}) },
    stats:    m.stats || { matched: 0, lastMatchedAt: null },
  }));
  // Write all files in parallel
  await Promise.all(_mocks.map(writeStubFile));
  return _mocks;
}

/* -------------------------------------------------------------------------- */
/*  Hot-reload: re-scan stubs/ directory without restart                     */
/* -------------------------------------------------------------------------- */

export async function reload() {
  const files = (await readdir(STUBS_DIR).catch(() => [])).filter(f => f.endsWith('.json'));
  const fresh = [];
  for (const file of files) {
    try {
      const raw  = await readFile(join(STUBS_DIR, file), 'utf8');
      const mock = JSON.parse(raw);
      if (mock && mock.id) fresh.push(mock);
    } catch (_) {}
  }
  _mocks = fresh;
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
    request: {
      method:       'ANY',
      urlMatchType: 'contains',
      url:          '',
      queryParams:  [],
      headers:      [],
      bodyPatterns: [],
    },
    response: {
      status:      200,
      headers:     { 'Content-Type': 'application/json' },
      body:        '{}',
      delayMs:     0,
      delayJitter: 0,
      fault:       'none',
    },
    stats:     { matched: 0, lastMatchedAt: null },
    createdAt: null,
    updatedAt: null,
  };
}
