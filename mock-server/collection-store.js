/**
 * Mocxy — Collection Store
 *
 * Postman-style collection organisation.
 * Each collection is one JSON file in  collections/
 * Mocks and folders are embedded in the collection tree.
 *
 * Tree schema:
 *   Collection  { id, name, description, enabled, items: Item[] }
 *   Item        = MockItem | FolderItem
 *   FolderItem  { type:'folder', id, name, items: Item[] }
 *   MockItem    { type:'mock', id, name, priority, enabled, request, response, stats, ... }
 */

import {
  readFile, writeFile, readdir, unlink, mkdir, rename,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const COLLECTIONS_DIR = join(__dirname, 'collections');
const STUBS_DIR      = join(__dirname, 'stubs');      // legacy migration source

let _collections = [];   // in-memory

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

export async function load() {
  await mkdir(COLLECTIONS_DIR, { recursive: true });

  // One-time: migrate any existing stubs/ files into a "Default" collection
  await migrateLegacyStubs();

  const files = (await readdir(COLLECTIONS_DIR).catch(() => []))
    .filter(f => f.endsWith('.json'));

  _collections = [];
  let total = 0;
  for (const file of files) {
    try {
      const raw = await readFile(join(COLLECTIONS_DIR, file), 'utf8');
      const col = JSON.parse(raw);
      if (col && col.id) { _collections.push(col); total += countMocks(col.items || []); }
      else console.warn(`  [collections] Skipped ${file} — missing id`);
    } catch (err) {
      console.warn(`  [collections] Could not parse ${file}: ${err.message}`);
    }
  }
  console.log(`  Loaded ${_collections.length} collection(s) · ${total} mock(s)`);
}

async function migrateLegacyStubs() {
  if (!existsSync(STUBS_DIR)) return;
  const files = (await readdir(STUBS_DIR).catch(() => [])).filter(f => f.endsWith('.json'));
  if (files.length === 0) return;

  // Only migrate if no collections exist yet
  const existing = (await readdir(COLLECTIONS_DIR).catch(() => [])).filter(f => f.endsWith('.json'));
  if (existing.length > 0) return;

  console.log(`  Migrating ${files.length} stub(s) from stubs/ → "Default" collection`);
  const items = [];
  for (const file of files) {
    try {
      const raw  = await readFile(join(STUBS_DIR, file), 'utf8');
      const mock = JSON.parse(raw);
      if (mock && mock.id) items.push({ type: 'mock', ...mock });
    } catch (_) {}
  }

  if (items.length === 0) return;
  const col = defaultCollection({ name: 'Default', items });
  await saveCollection(col);
  _collections.push(col);

  // Rename stubs/ to stubs.migrated/
  await rename(STUBS_DIR, STUBS_DIR + '.migrated').catch(() => {});
  console.log(`  Migration complete`);
}

/* -------------------------------------------------------------------------- */
/*  File I/O                                                                  */
/* -------------------------------------------------------------------------- */

function collectionFilename(col) {
  const slug = (col.name || 'collection')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'collection';
  return `${slug}-${col.id.slice(0, 6)}.json`;
}

async function saveCollection(col) {
  const filename = collectionFilename(col);
  const path     = join(COLLECTIONS_DIR, filename);
  const tmp      = path + '.tmp';
  await writeFile(tmp, JSON.stringify(col, null, 2), 'utf8');
  await rename(tmp, path);
}

async function deleteCollectionFile(id) {
  const files = await readdir(COLLECTIONS_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(COLLECTIONS_DIR, file), 'utf8');
      const col = JSON.parse(raw);
      if (col.id === id) { await unlink(join(COLLECTIONS_DIR, file)); return; }
    } catch (_) {}
  }
}

/* -------------------------------------------------------------------------- */
/*  Tree helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Count all mocks (recursive). */
function countMocks(items) {
  let n = 0;
  for (const item of items) {
    if (item.type === 'mock') n++;
    else if (item.type === 'folder') n += countMocks(item.items || []);
  }
  return n;
}

/** Flatten all mocks from an item tree (for request matching). */
export function flattenMocks(items) {
  const mocks = [];
  for (const item of items) {
    if (item.type === 'mock') mocks.push(item);
    else if (item.type === 'folder') mocks.push(...flattenMocks(item.items || []));
  }
  return mocks;
}

/** Find an item by id anywhere in a tree. Returns { item, parentArray } or null. */
function findInTree(items, id) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) return { item: items[i], parentArray: items, index: i };
    if (items[i].type === 'folder') {
      const found = findInTree(items[i].items || [], id);
      if (found) return found;
    }
  }
  return null;
}

/** Remove an item by id from a tree (mutates). Returns true if found. */
function removeFromTree(items, id) {
  const idx = items.findIndex(i => i.id === id);
  if (idx !== -1) { items.splice(idx, 1); return true; }
  for (const item of items) {
    if (item.type === 'folder' && removeFromTree(item.items || [], id)) return true;
  }
  return false;
}

/** Deep-clone an object via JSON round-trip. */
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

/* -------------------------------------------------------------------------- */
/*  Default shapes                                                            */
/* -------------------------------------------------------------------------- */

function defaultCollection(data = {}) {
  return {
    id:          uuidv4(),
    name:        'New Collection',
    description: '',
    enabled:     true,
    items:       [],
    createdAt:   new Date().toISOString(),
    updatedAt:   null,
    ...data,
  };
}

export function defaultMock(data = {}) {
  return {
    type:     'mock',
    id:       uuidv4(),
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
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...data,
  };
}

function defaultFolder(data = {}) {
  return {
    type:  'folder',
    id:    uuidv4(),
    name:  'New Folder',
    items: [],
    ...data,
  };
}

/* -------------------------------------------------------------------------- */
/*  Public — Collections CRUD                                                 */
/* -------------------------------------------------------------------------- */

/** Summary list (no items tree — fast). */
export function getAll() {
  return _collections.map(c => ({
    id:          c.id,
    name:        c.name,
    description: c.description || '',
    enabled:     c.enabled !== false,
    mockCount:   countMocks(c.items || []),
    createdAt:   c.createdAt,
    updatedAt:   c.updatedAt,
  }));
}

/** Full collection (with items tree). */
export function getById(id) {
  return _collections.find(c => c.id === id) || null;
}

/** All mocks across all collections (for request matching). */
export function getAllMocks() {
  const all = [];
  for (const col of _collections) {
    if (col.enabled === false) continue;
    all.push(...flattenMocks(col.items || []));
  }
  return all;
}

export async function createCollection(data) {
  const col = defaultCollection(data);
  _collections.push(col);
  await saveCollection(col);
  return col;
}

export async function updateCollection(id, data) {
  const col = _collections.find(c => c.id === id);
  if (!col) return null;
  const oldName = col.name;
  Object.assign(col, {
    name:        data.name        ?? col.name,
    description: data.description ?? col.description,
    enabled:     data.enabled     ?? col.enabled,
    updatedAt:   new Date().toISOString(),
  });
  // If renamed, delete old file first
  if (oldName !== col.name) await deleteCollectionFile(id);
  await saveCollection(col);
  return col;
}

export async function removeCollection(id) {
  const idx = _collections.findIndex(c => c.id === id);
  if (idx === -1) return false;
  _collections.splice(idx, 1);
  await deleteCollectionFile(id);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Public — Folders CRUD                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Add a folder.
 * @param {string} colId        Collection id
 * @param {string|null} parentFolderId  Parent folder id (null = collection root)
 * @param {object} data         { name }
 */
export async function addFolder(colId, parentFolderId, data) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return null;

  const folder = defaultFolder({ name: data.name || 'New Folder' });
  if (!parentFolderId) {
    col.items.push(folder);
  } else {
    const parent = findInTree(col.items, parentFolderId);
    if (!parent || parent.item.type !== 'folder') return null;
    parent.item.items.push(folder);
  }
  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return folder;
}

export async function updateFolder(colId, folderId, data) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return null;
  const found = findInTree(col.items, folderId);
  if (!found || found.item.type !== 'folder') return null;
  found.item.name      = data.name ?? found.item.name;
  col.updatedAt        = new Date().toISOString();
  await saveCollection(col);
  return found.item;
}

export async function removeFolder(colId, folderId) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return false;
  const removed = removeFromTree(col.items, folderId);
  if (!removed) return false;
  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Public — Mocks CRUD                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Add a mock to a collection (at root or inside a folder).
 * @param {string} colId
 * @param {string|null} folderId   null = collection root
 * @param {object} data            mock fields
 */
export async function addMock(colId, folderId, data) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return null;

  const mock = defaultMock(data);
  mock.type  = 'mock';

  if (!folderId) {
    col.items.push(mock);
  } else {
    const folder = findInTree(col.items, folderId);
    if (!folder || folder.item.type !== 'folder') return null;
    folder.item.items.push(mock);
  }
  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return mock;
}

export async function updateMock(colId, mockId, data) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return null;
  const found = findInTree(col.items, mockId);
  if (!found || found.item.type !== 'mock') return null;

  const mock = found.item;
  Object.assign(mock, {
    ...data,
    id:        mockId,
    type:      'mock',
    updatedAt: new Date().toISOString(),
  });
  if (data.request)  mock.request  = { ...mock.request,  ...data.request  };
  if (data.response) mock.response = { ...mock.response, ...data.response };

  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return mock;
}

export async function removeMock(colId, mockId) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return false;
  const removed = removeFromTree(col.items, mockId);
  if (!removed) return false;
  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return true;
}

/**
 * Move a mock to a different folder (or collection root).
 * @param {string} colId
 * @param {string} mockId
 * @param {string|null} targetFolderId  null = move to collection root
 */
export async function moveMock(colId, mockId, targetFolderId) {
  const col = _collections.find(c => c.id === colId);
  if (!col) return null;

  const found = findInTree(col.items, mockId);
  if (!found || found.item.type !== 'mock') return null;

  const mock = clone(found.item);
  removeFromTree(col.items, mockId);

  if (!targetFolderId) {
    col.items.push(mock);
  } else {
    const target = findInTree(col.items, targetFolderId);
    if (!target || target.item.type !== 'folder') return null;
    target.item.items.push(mock);
  }
  col.updatedAt = new Date().toISOString();
  await saveCollection(col);
  return mock;
}

/* -------------------------------------------------------------------------- */
/*  Public — Stats update (called by server on each matched request)         */
/* -------------------------------------------------------------------------- */

export async function recordHit(mockId) {
  for (const col of _collections) {
    const found = findInTree(col.items, mockId);
    if (found && found.item.type === 'mock') {
      found.item.stats = found.item.stats || { matched: 0, lastMatchedAt: null };
      found.item.stats.matched++;
      found.item.stats.lastMatchedAt = new Date().toISOString();
      await saveCollection(col);
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Public — Import / Export                                                  */
/* -------------------------------------------------------------------------- */

/** Export a single collection as a clean JSON object. */
export function exportCollection(id) {
  const col = _collections.find(c => c.id === id);
  if (!col) return null;
  return clone(col);
}

/**
 * Import a collection from JSON.
 * If a collection with the same name exists, a new one is created.
 */
export async function importCollection(data) {
  const col = {
    ...defaultCollection(),
    ...data,
    id:        uuidv4(),           // always assign a new id
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  // Re-assign IDs to all embedded items to avoid clashes
  reassignIds(col.items || []);
  _collections.push(col);
  await saveCollection(col);
  return col;
}

function reassignIds(items) {
  for (const item of items) {
    item.id = uuidv4();
    if (item.type === 'folder') reassignIds(item.items || []);
  }
}
