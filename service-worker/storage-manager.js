/**
 * storage-manager.js
 *
 * Manages chrome.storage.local for rules/settings and IndexedDB for
 * logs and large mock response bodies.
 *
 * chrome.storage.local keys:
 *   mocxy_rules            — Array of interception rules
 *   mocxy_settings         — Extension settings (merged with defaults)
 *   mocxy_enabled          — Global on/off toggle
 *   mocxy_mock_collections — Saved mock-response collections
 *
 * IndexedDB  "MocxyDB"  v1:
 *   request_logs  — captured request/response log entries
 *   mock_bodies   — large mock response payloads stored outside chrome.storage
 */

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  MSG_TYPES,
  IDB_NAME,
  IDB_VERSION,
  IDB_STORES,
} from '../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let _db = null;

/* -------------------------------------------------------------------------- */
/*  IndexedDB helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Open (or return cached handle for) the MocxyDB.
 * Creates object stores on first run / version upgrade.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  return new Promise((resolve, reject) => {
    if (_db) {
      resolve(_db);
      return;
    }

    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // request_logs store
      if (!db.objectStoreNames.contains(IDB_STORES.LOGS)) {
        const logsStore = db.createObjectStore(IDB_STORES.LOGS, {
          keyPath: 'id',
        });
        logsStore.createIndex('timestamp', 'timestamp', { unique: false });
        logsStore.createIndex('url', 'url', { unique: false });
        logsStore.createIndex('matchedRuleId', 'matchedRuleId', {
          unique: false,
        });
      }

      // mock_bodies store
      if (!db.objectStoreNames.contains(IDB_STORES.MOCK_BODIES)) {
        db.createObjectStore(IDB_STORES.MOCK_BODIES, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;

      // Reset cached handle when the database is unexpectedly closed
      _db.onclose = () => {
        _db = null;
      };

      resolve(_db);
    };

    request.onerror = (event) => {
      console.error('[Mocxy] IndexedDB open failed', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Return a ready-to-use IDB handle, initialising lazily when needed.
 * @returns {Promise<IDBDatabase>}
 */
async function _getDB() {
  if (!_db) {
    await initDB();
  }
  return _db;
}

/* -------------------------------------------------------------------------- */
/*  chrome.storage.local — Rules                                              */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve all interception rules.
 * @returns {Promise<Array>}
 */
export async function getRules() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RULES);
  return result[STORAGE_KEYS.RULES] || [];
}

/**
 * Persist rules and broadcast RULES_UPDATED to every tab.
 * @param {Array} rules
 */
export async function setRules(rules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RULES]: rules });

  // Notify all tabs so content scripts / popups can react
  const tabs = await chrome.tabs.query({});
  const currentEnabled = await isEnabled();
  const collections = await getMockCollections();
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: MSG_TYPES.RULES_UPDATED,
        data: { rules, mockCollections: collections, enabled: currentEnabled },
      });
    } catch (_) {
      // Tab may not have a content script — ignore
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  chrome.storage.local — Settings                                           */
/* -------------------------------------------------------------------------- */

/**
 * Return current settings merged with defaults so callers always get a
 * complete object even when individual keys have never been persisted.
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
}

/**
 * Persist settings (partial updates are fine — merged on read).
 * Broadcasts SETTINGS_UPDATED to all tabs so inject scripts can react.
 * @param {Object} settings
 */
export async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });

  // Broadcast updated settings to all tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        data: { enableLogging: settings.enableLogging },
      });
    } catch (_) {}
  }
}

/* -------------------------------------------------------------------------- */
/*  chrome.storage.local — Enabled toggle                                     */
/* -------------------------------------------------------------------------- */

/**
 * Check whether the interceptor is globally enabled.
 * @returns {Promise<boolean>}
 */
export async function isEnabled() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.INTERCEPTOR_ENABLED);
  // Default to true when the key has never been set
  return result[STORAGE_KEYS.INTERCEPTOR_ENABLED] !== undefined
    ? result[STORAGE_KEYS.INTERCEPTOR_ENABLED]
    : true;
}

/**
 * Set the global enabled state.
 * @param {boolean} val
 */
export async function setEnabled(val) {
  await chrome.storage.local.set({ [STORAGE_KEYS.INTERCEPTOR_ENABLED]: !!val });
}

/* -------------------------------------------------------------------------- */
/*  chrome.storage.local — Mock collections                                   */
/* -------------------------------------------------------------------------- */

/**
 * Retrieve saved mock collections.
 * @returns {Promise<Array>}
 */
export async function getMockCollections() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MOCK_COLLECTIONS);
  return result[STORAGE_KEYS.MOCK_COLLECTIONS] || [];
}

/**
 * Persist mock collections.
 * @param {Array} collections
 */
export async function setMockCollections(collections) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.MOCK_COLLECTIONS]: collections,
  });
}

/* -------------------------------------------------------------------------- */
/*  IndexedDB — Request logs                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Insert a log entry and auto-prune the store when it exceeds maxLogEntries.
 * @param {Object} entry — must include at least { url, method, timestamp }
 */
export async function addLogEntry(entry) {
  const db = await _getDB();
  const settings = await getSettings();
  const maxEntries = settings.maxLogEntries || DEFAULT_SETTINGS.maxLogEntries;

  // Ensure the entry has an id and timestamp
  if (!entry.id) {
    entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  if (!entry.timestamp) {
    entry.timestamp = Date.now();
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.LOGS, 'readwrite');
    const store = tx.objectStore(IDB_STORES.LOGS);

    store.add(entry);

    tx.oncomplete = async () => {
      // Auto-prune: count entries, remove oldest if over limit
      try {
        await _pruneLogEntries(maxEntries);
      } catch (err) {
        console.warn('[Mocxy] Log prune failed', err);
      }
      resolve();
    };

    tx.onerror = (event) => {
      console.error('[Mocxy] addLogEntry failed', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Remove oldest log entries when the store exceeds `max` records.
 * @param {number} max
 */
async function _pruneLogEntries(max) {
  const db = await _getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.LOGS, 'readwrite');
    const store = tx.objectStore(IDB_STORES.LOGS);
    const countReq = store.count();

    countReq.onsuccess = () => {
      const total = countReq.result;
      if (total <= max) {
        resolve();
        return;
      }

      const excess = total - max;
      const idx = store.index('timestamp');
      const cursorReq = idx.openCursor(); // ascending — oldest first
      let deleted = 0;

      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && deleted < excess) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    };

    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Query log entries with optional filters.
 *
 * @param {Object} [filter]
 * @param {string}  [filter.urlPattern]   — substring match on url
 * @param {string}  [filter.method]       — exact HTTP method match
 * @param {number}  [filter.statusMin]    — minimum status code (inclusive)
 * @param {number}  [filter.statusMax]    — maximum status code (inclusive)
 * @param {boolean} [filter.intercepted]  — filter by intercepted flag
 * @param {number}  [filter.limit]        — max entries to return (default 200)
 * @param {number}  [filter.offset]       — entries to skip (default 0)
 * @returns {Promise<Array>} entries sorted by timestamp descending
 */
export async function getLogs(filter = {}) {
  const db = await _getDB();
  const limit = filter.limit || 200;
  const offset = filter.offset || 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.LOGS, 'readonly');
    const store = tx.objectStore(IDB_STORES.LOGS);
    const idx = store.index('timestamp');
    const cursorReq = idx.openCursor(null, 'prev'); // newest first

    const results = [];
    let skipped = 0;

    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }

      const entry = cursor.value;

      // Apply filters
      if (filter.urlPattern && !entry.url.includes(filter.urlPattern)) {
        cursor.continue();
        return;
      }
      if (filter.method && entry.method !== filter.method.toUpperCase()) {
        cursor.continue();
        return;
      }
      if (filter.statusMin != null && (entry.statusCode || 0) < filter.statusMin) {
        cursor.continue();
        return;
      }
      if (filter.statusMax != null && (entry.statusCode || 0) > filter.statusMax) {
        cursor.continue();
        return;
      }
      if (filter.intercepted !== undefined && entry.intercepted !== filter.intercepted) {
        cursor.continue();
        return;
      }

      // Offset / pagination
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }

      results.push(entry);
      cursor.continue();
    };

    cursorReq.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * Delete every entry in the request_logs store.
 */
export async function clearLogs() {
  const db = await _getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.LOGS, 'readwrite');
    const store = tx.objectStore(IDB_STORES.LOGS);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = (event) => reject(event.target.error);
  });
}

/* -------------------------------------------------------------------------- */
/*  IndexedDB — Mock bodies                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Store a (potentially large) mock response body in IndexedDB.
 * @param {string} id
 * @param {*} body — JSON-serialisable value
 */
export async function storeMockBody(id, body) {
  const db = await _getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.MOCK_BODIES, 'readwrite');
    const store = tx.objectStore(IDB_STORES.MOCK_BODIES);
    store.put({ id, body });
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Retrieve a mock body by id.
 * @param {string} id
 * @returns {Promise<*>} the body value, or undefined if not found
 */
export async function getMockBody(id) {
  const db = await _getDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.MOCK_BODIES, 'readonly');
    const store = tx.objectStore(IDB_STORES.MOCK_BODIES);
    const req = store.get(id);

    req.onsuccess = () => {
      resolve(req.result ? req.result.body : undefined);
    };

    req.onerror = (event) => reject(event.target.error);
  });
}

/* -------------------------------------------------------------------------- */
/*  Export / Import                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Gather rules, settings, and mock collections into a single JSON-safe object
 * suitable for file export.
 * @returns {Promise<Object>}
 */
export async function exportAll() {
  const [rules, settings, mockCollections] = await Promise.all([
    getRules(),
    getSettings(),
    getMockCollections(),
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    rules,
    settings,
    mockCollections,
  };
}

/**
 * Validate and import previously exported data.
 * @param {Object} data — object with optional keys: rules, settings, mockCollections
 */
export async function importAll(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Import data must be a non-null object');
  }

  const writes = {};

  if (Array.isArray(data.rules)) {
    writes[STORAGE_KEYS.RULES] = data.rules;
  }

  if (data.settings && typeof data.settings === 'object') {
    writes[STORAGE_KEYS.SETTINGS] = data.settings;
  }

  if (Array.isArray(data.mockCollections)) {
    writes[STORAGE_KEYS.MOCK_COLLECTIONS] = data.mockCollections;
  }

  if (Object.keys(writes).length === 0) {
    throw new Error('Import data contains no recognised keys (rules, settings, mockCollections)');
  }

  await chrome.storage.local.set(writes);
}
