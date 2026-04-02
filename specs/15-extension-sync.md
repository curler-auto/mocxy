# Feature 3.3: Extension-to-Backend Bidirectional Sync

## Summary

Implement real-time bidirectional synchronization between the Chrome extension and the backend server. Local rule/collection changes push to the server; remote changes (from teammates or other devices) push to the extension via WebSocket. Includes conflict resolution, offline queue, and visual sync status indicators.

## Why

Without sync, each user's rules exist only in their browser's `chrome.storage.local`. Sync enables:
- Cross-device access (same rules on laptop and desktop)
- Team collaboration (shared workspace rules update in real-time)
- Backup/restore (server is the source of truth)
- Offline resilience (queue changes, replay when reconnected)

## Dependencies

- **Spec 13 (Backend API Server)**: Provides REST endpoints and WebSocket server
- **Spec 14 (Auth System)**: Provides authentication tokens and `auth-manager.js` for `getAccessToken()` and `apiFetch()`

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Server location**: `health_check/utils/neuron-interceptor-plugin/server/`
- **Service worker**: `service-worker/sw.js` -- main entry, imports `handleMessage`
- **Storage manager**: `service-worker/storage-manager.js` -- `getRules()`, `setRules()`, `getMockCollections()`, `setMockCollections()`
- **Auth manager**: `service-worker/auth-manager.js` -- `getAccessToken()`, `apiFetch()`, `getAuthState()` (from spec 14)
- **Message router**: `service-worker/message-router.js` -- handles all MSG_TYPES
- **Shared constants**: `shared/constants.js` -- MSG_TYPES, STORAGE_KEYS, API_BASE_URL
- **Data model**: Rules have `{ id, name, enabled, priority, condition, action }`. Collections have `{ id, name, active, mocks }`.
- **Backend WebSocket**: `server/src/routes/ws.js` -- sends `{ type: 'RULES_UPDATED' | 'COLLECTION_UPDATED' | 'SETTINGS_UPDATED', workspaceId, data, timestamp }` messages
- **Backend sync service**: `server/src/services/sync-service.js` -- publishes changes to Redis `workspace:<id>:changes` channel

## Sync Protocol

### Overview

```
Extension (Local)                    Backend Server
     |                                     |
     |-- Login --------------------------->|
     |<-- Full sync (fetch all rules) -----|
     |                                     |
     |-- Rule changed (debounced PUT) ---->|
     |                                     |
     |<-- WebSocket: RULES_UPDATED --------|  (from another user/device)
     |                                     |
     |-- [Offline] queue change ---------->|  (on reconnect)
     |                                     |
```

### Conflict Resolution: Last-Write-Wins

- Every rule and collection has an `updated_at` timestamp (server-side)
- When merging, the version with the later `updated_at` wins
- The server is the ultimate source of truth after merge
- During full sync, if a local rule has been modified more recently than the server copy, the local version is pushed; otherwise, the server version overwrites local

### Sync Lifecycle

1. **On login**: Trigger full sync (fetch all server data, merge with local)
2. **On local change**: Debounce 500ms, then push changed item via REST
3. **On remote change**: WebSocket message received, update local storage
4. **On disconnect**: Queue pending changes in `_syncQueue`
5. **On reconnect**: Replay `_syncQueue`, then full sync to catch up
6. **On logout**: Disconnect WebSocket, clear sync state

## Implementation

### Step 1: Add New Constants to `shared/constants.js`

Add these new MSG_TYPES:

```javascript
// --- Sync (spec 15) ---
SYNC_START:       'SYNC_START',
SYNC_STATUS:      'SYNC_STATUS',
GET_SYNC_STATE:   'GET_SYNC_STATE',
```

Add new STORAGE_KEYS:

```javascript
SYNC_QUEUE: 'neuron_sync_queue',
LAST_SYNC:  'neuron_last_sync',
```

### Step 2: Create `service-worker/sync-manager.js`

This is the core sync module, managing WebSocket connections, the offline queue, and merge logic.

```javascript
/**
 * sync-manager.js
 *
 * Bidirectional sync between the Chrome extension and the Neuron backend.
 *
 * Responsibilities:
 *  1. Maintain a WebSocket connection to the backend for real-time updates
 *  2. Push local changes to the server via REST (debounced)
 *  3. Receive remote changes via WebSocket and update local storage
 *  4. Queue offline changes and replay on reconnect
 *  5. Full sync on login/reconnect: merge local + remote data
 *  6. Expose sync status for UI indicators
 */

import { STORAGE_KEYS, API_BASE_URL } from '../shared/constants.js';
import { getAccessToken, apiFetch, getAuthState } from './auth-manager.js';
import { getRules, setRules, getMockCollections, setMockCollections } from './storage-manager.js';

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let _ws = null;
let _reconnectAttempts = 0;
let _reconnectTimer = null;
let _syncQueue = [];
let _activeWorkspaceId = null;
let _lastSyncTimestamp = null;
let _debounceTimers = {};

/**
 * Sync status enum.
 * @type {'disconnected'|'connecting'|'connected'|'syncing'|'error'}
 */
let _syncStatus = 'disconnected';

/** Listeners for sync status changes. */
const _statusListeners = new Set();

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const DEBOUNCE_MS = 500;

/* -------------------------------------------------------------------------- */
/*  Status management                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Update the sync status and notify listeners.
 * @param {'disconnected'|'connecting'|'connected'|'syncing'|'error'} status
 */
function _setStatus(status) {
  _syncStatus = status;
  for (const listener of _statusListeners) {
    try { listener(status); } catch { /* ignore */ }
  }
}

/**
 * Get the current sync status.
 * @returns {Object}
 */
export function getSyncState() {
  return {
    status: _syncStatus,
    workspaceId: _activeWorkspaceId,
    queueLength: _syncQueue.length,
    lastSync: _lastSyncTimestamp,
    reconnectAttempts: _reconnectAttempts,
  };
}

/**
 * Register a callback for sync status changes.
 * @param {Function} callback
 */
export function onStatusChange(callback) {
  _statusListeners.add(callback);
}

/* -------------------------------------------------------------------------- */
/*  WebSocket connection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Connect to the backend WebSocket server.
 * Called on login or manual reconnect.
 *
 * @param {string} [workspaceId] - Active workspace ID
 */
export async function connect(workspaceId) {
  const authState = getAuthState();
  if (!authState.isLoggedIn) {
    console.warn('[NeuronSync] Cannot connect: not logged in');
    return;
  }

  if (workspaceId) {
    _activeWorkspaceId = workspaceId;
  }

  const token = getAccessToken();
  if (!token) {
    console.warn('[NeuronSync] Cannot connect: no access token');
    return;
  }

  // Close existing connection
  if (_ws) {
    try { _ws.close(); } catch { /* ignore */ }
    _ws = null;
  }

  _setStatus('connecting');

  const wsUrl = API_BASE_URL.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`;

  try {
    _ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('[NeuronSync] WebSocket creation failed:', err);
    _setStatus('error');
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    console.log('[NeuronSync] WebSocket connected');
    _reconnectAttempts = 0;
    _setStatus('connected');

    // Start keepalive ping
    _startPing();

    // Replay offline queue
    _replayQueue();

    // Full sync
    fullSync();
  };

  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      _handleServerMessage(msg);
    } catch (err) {
      console.warn('[NeuronSync] Failed to parse WebSocket message:', err);
    }
  };

  _ws.onclose = (event) => {
    console.log(`[NeuronSync] WebSocket closed: code=${event.code} reason=${event.reason}`);
    _ws = null;
    _stopPing();

    if (_syncStatus !== 'disconnected') {
      _setStatus('disconnected');
      _scheduleReconnect();
    }
  };

  _ws.onerror = (err) => {
    console.error('[NeuronSync] WebSocket error:', err);
    _setStatus('error');
  };
}

/**
 * Disconnect the WebSocket and stop sync.
 * Called on logout.
 */
export function disconnect() {
  _setStatus('disconnected');
  _reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect

  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  _stopPing();

  if (_ws) {
    try { _ws.close(1000, 'User disconnected'); } catch { /* ignore */ }
    _ws = null;
  }

  _syncQueue = [];
  _activeWorkspaceId = null;
  _reconnectAttempts = 0;
}

/* -------------------------------------------------------------------------- */
/*  Reconnection with exponential backoff                                     */
/* -------------------------------------------------------------------------- */

function _scheduleReconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('[NeuronSync] Max reconnect attempts reached');
    _setStatus('error');
    return;
  }

  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, _reconnectAttempts),
    MAX_RECONNECT_DELAY_MS
  );

  console.log(`[NeuronSync] Reconnecting in ${delay}ms (attempt ${_reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);

  _reconnectTimer = setTimeout(() => {
    _reconnectAttempts++;
    connect(_activeWorkspaceId);
  }, delay);
}

/* -------------------------------------------------------------------------- */
/*  Keepalive ping                                                            */
/* -------------------------------------------------------------------------- */

let _pingTimer = null;

function _startPing() {
  _stopPing();
  _pingTimer = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'PING' }));
    }
  }, 30000); // Every 30 seconds
}

function _stopPing() {
  if (_pingTimer) {
    clearInterval(_pingTimer);
    _pingTimer = null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Handle incoming WebSocket messages                                        */
/* -------------------------------------------------------------------------- */

async function _handleServerMessage(msg) {
  switch (msg.type) {
    case 'CONNECTED':
      console.log('[NeuronSync] Server confirmed connection:', msg);
      break;

    case 'PONG':
      // Keepalive response, nothing to do
      break;

    case 'RULES_UPDATED':
      console.log('[NeuronSync] Remote rules updated:', msg.data);
      await _handleRemoteRulesUpdate(msg);
      break;

    case 'COLLECTION_UPDATED':
      console.log('[NeuronSync] Remote collection updated:', msg.data);
      await _handleRemoteCollectionUpdate(msg);
      break;

    case 'SETTINGS_UPDATED':
      console.log('[NeuronSync] Remote settings updated:', msg.data);
      // Settings sync can be handled similarly
      break;

    case 'ERROR':
      console.error('[NeuronSync] Server error:', msg.message);
      break;

    default:
      console.log('[NeuronSync] Unknown message type:', msg.type);
  }
}

/**
 * Handle a remote rules update pushed via WebSocket.
 * @param {Object} msg - { type, workspaceId, data, timestamp }
 */
async function _handleRemoteRulesUpdate(msg) {
  if (msg.data?.deleted) {
    // A rule was deleted remotely — remove it locally
    const localRules = await getRules();
    const filtered = localRules.filter((r) => r.id !== msg.data.id);
    if (filtered.length !== localRules.length) {
      await setRules(filtered);
      console.log(`[NeuronSync] Removed deleted rule ${msg.data.id}`);
    }
    return;
  }

  // A rule was created or updated remotely — merge
  const serverRule = msg.data;
  if (!serverRule || !serverRule.id) return;

  const localRules = await getRules();
  const localIndex = localRules.findIndex((r) => r.id === serverRule.id);

  // Convert server rule to extension format
  const extensionRule = _serverRuleToLocal(serverRule);

  if (localIndex >= 0) {
    // Update existing — last-write-wins
    const localUpdated = localRules[localIndex]._updatedAt || 0;
    const serverUpdated = new Date(serverRule.updated_at).getTime() || 0;

    if (serverUpdated >= localUpdated) {
      localRules[localIndex] = { ...extensionRule, _updatedAt: serverUpdated };
      await setRules(localRules);
      console.log(`[NeuronSync] Updated local rule ${serverRule.id} from remote`);
    } else {
      console.log(`[NeuronSync] Skipping remote update for rule ${serverRule.id} (local is newer)`);
    }
  } else {
    // New rule from remote
    localRules.push({ ...extensionRule, _updatedAt: Date.now() });
    await setRules(localRules);
    console.log(`[NeuronSync] Added new remote rule ${serverRule.id}`);
  }
}

/**
 * Handle a remote collection update pushed via WebSocket.
 * @param {Object} msg
 */
async function _handleRemoteCollectionUpdate(msg) {
  if (msg.data?.deleted) {
    const local = await getMockCollections();
    const filtered = local.filter((c) => c.id !== msg.data.id);
    if (filtered.length !== local.length) {
      await setMockCollections(filtered);
    }
    return;
  }

  const serverCol = msg.data;
  if (!serverCol || !serverCol.id) return;

  const local = await getMockCollections();
  const idx = local.findIndex((c) => c.id === serverCol.id);
  const extensionCol = _serverCollectionToLocal(serverCol);

  if (idx >= 0) {
    local[idx] = extensionCol;
  } else {
    local.push(extensionCol);
  }

  await setMockCollections(local);
}

/* -------------------------------------------------------------------------- */
/*  Full sync (login / reconnect)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Perform a full bidirectional sync with the server.
 * Fetch all server data, merge with local, push local-only items.
 */
export async function fullSync() {
  if (!_activeWorkspaceId) {
    // Try to determine active workspace from auth state
    try {
      const meResponse = await apiFetch('/auth/me');
      if (meResponse.workspaces && meResponse.workspaces.length > 0) {
        _activeWorkspaceId = meResponse.workspaces[0].id;
      }
    } catch (err) {
      console.warn('[NeuronSync] Failed to determine workspace:', err);
      return;
    }
  }

  if (!_activeWorkspaceId) {
    console.warn('[NeuronSync] No active workspace for sync');
    return;
  }

  _setStatus('syncing');

  try {
    // Fetch server data
    const [serverRulesRes, serverCollectionsRes] = await Promise.all([
      apiFetch(`/workspaces/${_activeWorkspaceId}/rules`),
      apiFetch(`/workspaces/${_activeWorkspaceId}/collections`),
    ]);

    const serverRules = serverRulesRes.rules || [];
    const serverCollections = serverCollectionsRes.collections || [];

    // Merge rules
    await _mergeRules(serverRules);

    // Merge collections
    await _mergeCollections(serverCollections);

    _lastSyncTimestamp = Date.now();
    await _persistSyncMeta();

    _setStatus('connected');
    console.log(`[NeuronSync] Full sync complete. Rules: ${serverRules.length}, Collections: ${serverCollections.length}`);
  } catch (err) {
    console.error('[NeuronSync] Full sync failed:', err);
    _setStatus('error');
  }
}

/**
 * Merge server rules with local rules.
 * - Rules on server but not local: add to local
 * - Rules on local but not server: push to server
 * - Rules on both: last-write-wins
 *
 * @param {Array} serverRules
 */
async function _mergeRules(serverRules) {
  const localRules = await getRules();
  const merged = [];
  const serverMap = new Map(serverRules.map((r) => [r.id, r]));
  const localMap = new Map(localRules.map((r) => [r.id, r]));
  const allIds = new Set([...serverMap.keys(), ...localMap.keys()]);

  for (const id of allIds) {
    const server = serverMap.get(id);
    const local = localMap.get(id);

    if (server && !local) {
      // Server-only: add to local
      merged.push(_serverRuleToLocal(server));
    } else if (local && !server) {
      // Local-only: push to server
      try {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/rules`, {
          method: 'POST',
          body: JSON.stringify({
            name: local.name,
            enabled: local.enabled,
            priority: local.priority,
            condition: local.condition,
            action: local.action,
          }),
        });
      } catch (err) {
        console.warn(`[NeuronSync] Failed to push local rule ${id} to server:`, err);
      }
      merged.push(local);
    } else if (server && local) {
      // Both exist: last-write-wins
      const serverTs = new Date(server.updated_at).getTime() || 0;
      const localTs = local._updatedAt || 0;

      if (serverTs >= localTs) {
        merged.push(_serverRuleToLocal(server));
      } else {
        // Local is newer, push to server
        try {
          await apiFetch(`/workspaces/${_activeWorkspaceId}/rules/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: local.name,
              enabled: local.enabled,
              priority: local.priority,
              condition: local.condition,
              action: local.action,
            }),
          });
        } catch (err) {
          console.warn(`[NeuronSync] Failed to push updated rule ${id} to server:`, err);
        }
        merged.push(local);
      }
    }
  }

  await setRules(merged);
}

/**
 * Merge server collections with local collections.
 * @param {Array} serverCollections
 */
async function _mergeCollections(serverCollections) {
  const localCollections = await getMockCollections();
  const merged = [];
  const serverMap = new Map(serverCollections.map((c) => [c.id, c]));
  const localMap = new Map(localCollections.map((c) => [c.id, c]));
  const allIds = new Set([...serverMap.keys(), ...localMap.keys()]);

  for (const id of allIds) {
    const server = serverMap.get(id);
    const local = localMap.get(id);

    if (server && !local) {
      merged.push(_serverCollectionToLocal(server));
    } else if (local && !server) {
      try {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/collections`, {
          method: 'POST',
          body: JSON.stringify({
            name: local.name,
            active: local.active,
            mocks: local.mocks || [],
          }),
        });
      } catch (err) {
        console.warn(`[NeuronSync] Failed to push local collection ${id}:`, err);
      }
      merged.push(local);
    } else if (server && local) {
      const serverTs = new Date(server.updated_at).getTime() || 0;
      const localTs = local._updatedAt || 0;

      if (serverTs >= localTs) {
        merged.push(_serverCollectionToLocal(server));
      } else {
        try {
          await apiFetch(`/workspaces/${_activeWorkspaceId}/collections/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: local.name,
              active: local.active,
              mocks: local.mocks || [],
            }),
          });
        } catch (err) {
          console.warn(`[NeuronSync] Failed to push updated collection ${id}:`, err);
        }
        merged.push(local);
      }
    }
  }

  await setMockCollections(merged);
}

/* -------------------------------------------------------------------------- */
/*  Push local changes to server (debounced)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Called by storage-manager after setRules() to push changes to server.
 * Debounced to avoid flooding the API during rapid edits.
 *
 * @param {string} ruleId - ID of the changed rule
 * @param {Object} rule - The full rule object
 * @param {'create'|'update'|'delete'} operation
 */
export function pushRuleChange(ruleId, rule, operation) {
  if (!_activeWorkspaceId || _syncStatus === 'disconnected') {
    // Queue for later
    _enqueue({ type: 'rule', id: ruleId, data: rule, operation, timestamp: Date.now() });
    return;
  }

  // Debounce: cancel previous timer for same ruleId
  if (_debounceTimers[`rule:${ruleId}`]) {
    clearTimeout(_debounceTimers[`rule:${ruleId}`]);
  }

  _debounceTimers[`rule:${ruleId}`] = setTimeout(async () => {
    delete _debounceTimers[`rule:${ruleId}`];
    try {
      if (operation === 'delete') {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/rules/${ruleId}`, {
          method: 'DELETE',
        });
      } else if (operation === 'create') {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/rules`, {
          method: 'POST',
          body: JSON.stringify({
            name: rule.name,
            enabled: rule.enabled,
            priority: rule.priority,
            condition: rule.condition,
            action: rule.action,
          }),
        });
      } else {
        // update
        await apiFetch(`/workspaces/${_activeWorkspaceId}/rules/${ruleId}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: rule.name,
            enabled: rule.enabled,
            priority: rule.priority,
            condition: rule.condition,
            action: rule.action,
          }),
        });
      }
      console.log(`[NeuronSync] Pushed rule ${operation}: ${ruleId}`);
    } catch (err) {
      console.warn(`[NeuronSync] Failed to push rule ${ruleId}:`, err);
      // Queue for retry
      _enqueue({ type: 'rule', id: ruleId, data: rule, operation, timestamp: Date.now() });
    }
  }, DEBOUNCE_MS);
}

/**
 * Push a collection change to the server (debounced).
 * @param {string} colId
 * @param {Object} collection
 * @param {'create'|'update'|'delete'} operation
 */
export function pushCollectionChange(colId, collection, operation) {
  if (!_activeWorkspaceId || _syncStatus === 'disconnected') {
    _enqueue({ type: 'collection', id: colId, data: collection, operation, timestamp: Date.now() });
    return;
  }

  if (_debounceTimers[`col:${colId}`]) {
    clearTimeout(_debounceTimers[`col:${colId}`]);
  }

  _debounceTimers[`col:${colId}`] = setTimeout(async () => {
    delete _debounceTimers[`col:${colId}`];
    try {
      if (operation === 'delete') {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/collections/${colId}`, {
          method: 'DELETE',
        });
      } else if (operation === 'create') {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/collections`, {
          method: 'POST',
          body: JSON.stringify({
            name: collection.name,
            active: collection.active,
            mocks: collection.mocks || [],
          }),
        });
      } else {
        await apiFetch(`/workspaces/${_activeWorkspaceId}/collections/${colId}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: collection.name,
            active: collection.active,
            mocks: collection.mocks || [],
          }),
        });
      }
    } catch (err) {
      console.warn(`[NeuronSync] Failed to push collection ${colId}:`, err);
      _enqueue({ type: 'collection', id: colId, data: collection, operation, timestamp: Date.now() });
    }
  }, DEBOUNCE_MS);
}

/* -------------------------------------------------------------------------- */
/*  Offline queue                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Add a change to the offline queue.
 * @param {Object} entry - { type, id, data, operation, timestamp }
 */
function _enqueue(entry) {
  // Remove any existing entry for the same resource (only keep latest)
  _syncQueue = _syncQueue.filter(
    (e) => !(e.type === entry.type && e.id === entry.id)
  );
  _syncQueue.push(entry);
  _persistSyncQueue();
  console.log(`[NeuronSync] Queued ${entry.type} ${entry.operation}: ${entry.id} (queue: ${_syncQueue.length})`);
}

/**
 * Replay the offline queue (called on reconnect).
 */
async function _replayQueue() {
  if (_syncQueue.length === 0) return;

  console.log(`[NeuronSync] Replaying ${_syncQueue.length} queued changes`);
  const queue = [..._syncQueue];
  _syncQueue = [];

  for (const entry of queue) {
    try {
      if (entry.type === 'rule') {
        await _pushRuleImmediate(entry.id, entry.data, entry.operation);
      } else if (entry.type === 'collection') {
        await _pushCollectionImmediate(entry.id, entry.data, entry.operation);
      }
    } catch (err) {
      console.warn(`[NeuronSync] Queue replay failed for ${entry.type}:${entry.id}:`, err);
      // Re-enqueue failed items
      _syncQueue.push(entry);
    }
  }

  _persistSyncQueue();
}

async function _pushRuleImmediate(ruleId, rule, operation) {
  if (operation === 'delete') {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/rules/${ruleId}`, { method: 'DELETE' });
  } else if (operation === 'create') {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/rules`, {
      method: 'POST',
      body: JSON.stringify({ name: rule.name, enabled: rule.enabled, priority: rule.priority, condition: rule.condition, action: rule.action }),
    });
  } else {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: rule.name, enabled: rule.enabled, priority: rule.priority, condition: rule.condition, action: rule.action }),
    });
  }
}

async function _pushCollectionImmediate(colId, collection, operation) {
  if (operation === 'delete') {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/collections/${colId}`, { method: 'DELETE' });
  } else if (operation === 'create') {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name: collection.name, active: collection.active, mocks: collection.mocks || [] }),
    });
  } else {
    await apiFetch(`/workspaces/${_activeWorkspaceId}/collections/${colId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: collection.name, active: collection.active, mocks: collection.mocks || [] }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Data format conversion                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Convert a server rule object to the extension's local format.
 * Server stores condition/action as JSONB; locally they are plain objects.
 * @param {Object} serverRule
 * @returns {Object}
 */
function _serverRuleToLocal(serverRule) {
  return {
    id: serverRule.id,
    name: serverRule.name,
    enabled: serverRule.enabled,
    priority: serverRule.priority,
    condition: typeof serverRule.condition === 'string'
      ? JSON.parse(serverRule.condition)
      : serverRule.condition,
    action: typeof serverRule.action === 'string'
      ? JSON.parse(serverRule.action)
      : serverRule.action,
    _updatedAt: new Date(serverRule.updated_at).getTime(),
    _serverId: serverRule.id,
  };
}

/**
 * Convert a server collection to the extension's local format.
 * @param {Object} serverCol
 * @returns {Object}
 */
function _serverCollectionToLocal(serverCol) {
  return {
    id: serverCol.id,
    name: serverCol.name,
    active: serverCol.active,
    mocks: typeof serverCol.mocks === 'string'
      ? JSON.parse(serverCol.mocks)
      : serverCol.mocks || [],
    _updatedAt: new Date(serverCol.updated_at).getTime(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Persistence helpers                                                       */
/* -------------------------------------------------------------------------- */

async function _persistSyncQueue() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_QUEUE]: _syncQueue });
  } catch (err) {
    console.warn('[NeuronSync] Failed to persist sync queue:', err);
  }
}

async function _persistSyncMeta() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SYNC]: _lastSyncTimestamp });
  } catch (err) {
    console.warn('[NeuronSync] Failed to persist sync meta:', err);
  }
}

/**
 * Load persisted sync queue on startup.
 */
export async function loadSyncState() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.SYNC_QUEUE, STORAGE_KEYS.LAST_SYNC]);
    _syncQueue = result[STORAGE_KEYS.SYNC_QUEUE] || [];
    _lastSyncTimestamp = result[STORAGE_KEYS.LAST_SYNC] || null;
    console.log(`[NeuronSync] Loaded sync state: queue=${_syncQueue.length}, lastSync=${_lastSyncTimestamp}`);
  } catch (err) {
    console.warn('[NeuronSync] Failed to load sync state:', err);
  }
}
```

### Step 3: Modify `service-worker/storage-manager.js`

After calling `chrome.storage.local.set` in `setRules()`, add a sync push. Modify the `setRules()` function:

```javascript
import { pushRuleChange, getSyncState } from './sync-manager.js';
```

At the end of the `setRules()` function, after the tab notification loop, add:

```javascript
  // Push to sync (if connected)
  const syncState = getSyncState();
  if (syncState.status === 'connected' || syncState.status === 'syncing') {
    // Determine which rules changed by comparing with previous
    // For simplicity, mark all as updated (the server will handle deduplication)
    for (const rule of rules) {
      pushRuleChange(rule.id, rule, 'update');
    }
  }
```

Similarly, modify `setMockCollections()`:

```javascript
import { pushCollectionChange } from './sync-manager.js';
```

After the storage set call:

```javascript
  const syncState = getSyncState();
  if (syncState.status === 'connected' || syncState.status === 'syncing') {
    for (const col of collections) {
      pushCollectionChange(col.id, col, 'update');
    }
  }
```

### Step 4: Modify `service-worker/sw.js`

Add sync manager initialization. Add imports:

```javascript
import { connect as syncConnect, disconnect as syncDisconnect, loadSyncState } from './sync-manager.js';
```

After the auth state loading in `onInstalled`, add:

```javascript
  // Load sync queue
  try {
    await loadSyncState();
  } catch (err) {
    console.warn('[NeuronInterceptor] Sync state load failed', err);
  }
```

Also load sync state at startup:

```javascript
loadSyncState().catch((err) => {
  console.warn('[NeuronInterceptor] Startup sync state load failed', err);
});
```

### Step 5: Modify `service-worker/message-router.js`

Add sync message handling. Import:

```javascript
import { getSyncState, fullSync, connect as syncConnect } from './sync-manager.js';
```

Add cases:

```javascript
    /* ---- Sync ---- */
    case MSG_TYPES.SYNC_START:
      await syncConnect(payload?.workspaceId);
      return { ok: true };

    case MSG_TYPES.GET_SYNC_STATE:
      return getSyncState();

    case MSG_TYPES.SYNC_STATUS:
      return getSyncState();
```

### Step 6: Connect/Disconnect Sync on Auth Events

In `service-worker/auth-manager.js`, after successful login or register, trigger sync:

In the `login()` function, after `_scheduleRefresh()`:

```javascript
  // Trigger sync connection
  const { connect: syncConnect } = await import('./sync-manager.js');
  await syncConnect();
```

In the `logout()` function, before `_clearAuthState()`:

```javascript
  // Disconnect sync
  const { disconnect: syncDisconnect } = await import('./sync-manager.js');
  syncDisconnect();
```

### Step 7: Add Sync Status UI to Popup

In `popup/popup.js`, add a function to update the sync indicator:

```javascript
/**
 * Update the sync status indicator dot.
 */
async function refreshSyncStatus() {
  try {
    const response = await sendMsg(MSG_TYPES.GET_SYNC_STATE || 'GET_SYNC_STATE');
    const state = response?.data || response;
    const dot = $syncIndicator.querySelector('.sync-dot');

    if (!state || !dot) return;

    // Remove all status classes
    dot.className = 'sync-dot';

    switch (state.status) {
      case 'connected':
        dot.classList.add('sync-dot-online');
        $syncIndicator.title = 'Synced';
        break;
      case 'syncing':
        dot.classList.add('sync-dot-syncing');
        $syncIndicator.title = 'Syncing...';
        break;
      case 'connecting':
        dot.classList.add('sync-dot-syncing');
        $syncIndicator.title = 'Connecting...';
        break;
      case 'error':
        dot.classList.add('sync-dot-error');
        $syncIndicator.title = 'Sync error';
        break;
      default:
        dot.classList.add('sync-dot-offline');
        $syncIndicator.title = 'Not connected';
    }

    // Show queue length if offline
    if (state.queueLength > 0) {
      $syncIndicator.title += ` (${state.queueLength} pending)`;
    }
  } catch {
    // Ignore
  }
}
```

Add `refreshSyncStatus()` to the `DOMContentLoaded` handler and set up periodic refresh:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  refreshLogs();
  refreshAuthState();
  refreshSyncStatus();

  // Refresh sync status every 10 seconds
  setInterval(refreshSyncStatus, 10000);
});
```

Add the `GET_SYNC_STATE` MSG_TYPE to the popup's local constant:

```javascript
const MSG_TYPES = {
  // ... existing ...
  GET_SYNC_STATE: 'GET_SYNC_STATE',
};
```

### Step 8: Add Sync Status to Options Header

In `options/options.html`, add a sync indicator in the header controls, before the auth user section:

```html
        <!-- Sync Status -->
        <div class="header-sync" id="headerSync" title="Sync status">
          <span class="sync-status-dot" id="syncStatusDot"></span>
          <span class="sync-status-text" id="syncStatusText">Offline</span>
        </div>
```

In `options/options.css`, add:

```css
/* -------------------------------------------------------------------------- */
/*  Sync Status (Header)                                                      */
/* -------------------------------------------------------------------------- */

.header-sync {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.sync-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-subtle);
  transition: background-color 0.3s ease;
}

.sync-status-dot.online    { background: var(--accent-green); box-shadow: 0 0 4px rgba(166, 227, 161, 0.4); }
.sync-status-dot.syncing   { background: var(--accent-yellow); animation: syncPulse 1s infinite; }
.sync-status-dot.error     { background: var(--accent-red); }
.sync-status-dot.offline   { background: var(--text-subtle); }

.sync-status-text {
  color: var(--text-muted);
}

@keyframes syncPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

In `options/options.js`, add:

```javascript
const $syncStatusDot  = document.getElementById('syncStatusDot');
const $syncStatusText = document.getElementById('syncStatusText');

async function refreshSyncUI() {
  try {
    const response = await sendMessage(MSG_TYPES.GET_SYNC_STATE);
    const state = response?.data || response;

    if (!state) return;

    $syncStatusDot.className = 'sync-status-dot';

    switch (state.status) {
      case 'connected':
        $syncStatusDot.classList.add('online');
        $syncStatusText.textContent = 'Synced';
        $syncStatusText.style.color = 'var(--accent-green)';
        break;
      case 'syncing':
        $syncStatusDot.classList.add('syncing');
        $syncStatusText.textContent = 'Syncing';
        $syncStatusText.style.color = 'var(--accent-yellow)';
        break;
      case 'connecting':
        $syncStatusDot.classList.add('syncing');
        $syncStatusText.textContent = 'Connecting';
        $syncStatusText.style.color = 'var(--accent-yellow)';
        break;
      case 'error':
        $syncStatusDot.classList.add('error');
        $syncStatusText.textContent = 'Error';
        $syncStatusText.style.color = 'var(--accent-red)';
        break;
      default:
        $syncStatusDot.classList.add('offline');
        $syncStatusText.textContent = 'Offline';
        $syncStatusText.style.color = 'var(--text-subtle)';
    }
  } catch {
    // Ignore
  }
}

// Add to init()
// refreshSyncUI();
// setInterval(refreshSyncUI, 10000);
```

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `service-worker/sync-manager.js` | Core sync engine: WebSocket, offline queue, merge, push |

### Modified Files
| File | Changes |
|------|---------|
| `shared/constants.js` | Add sync MSG_TYPES and STORAGE_KEYS |
| `service-worker/sw.js` | Import sync-manager, load sync state on startup |
| `service-worker/storage-manager.js` | Push rule/collection changes to sync after local save |
| `service-worker/message-router.js` | Add sync message cases |
| `service-worker/auth-manager.js` | Connect sync on login, disconnect on logout |
| `popup/popup.js` | Add sync status indicator refresh |
| `popup/popup.css` | Already has sync dot styles (from spec 14) |
| `options/options.html` | Add sync status element in header |
| `options/options.js` | Add sync status UI refresh |
| `options/options.css` | Add sync status styles |

## Verification

1. **Start backend with WebSocket**: `cd server && npm run dev` (ensure WebSocket on /ws is working)
2. **Load extension, login**: Open popup, sign in. Check service worker console for `[NeuronSync] WebSocket connected` and `[NeuronSync] Full sync complete`
3. **Sync indicator**: In popup footer, verify green dot. In options header, verify "Synced" text with green dot
4. **Create a rule locally**: Add a rule via Options page. Check SW console for `[NeuronSync] Pushed rule update: <id>`. Verify the rule appears in the backend DB
5. **Remote update**: Use `curl` to create a rule via the backend API. Verify it appears in the extension within seconds (via WebSocket push)
6. **Offline queue**: Stop the backend (`Ctrl+C`). Create a rule in the extension. Observe `[NeuronSync] Queued rule update` in SW console. Restart the backend. Verify `[NeuronSync] Replaying 1 queued changes` and the rule appears on the server
7. **Conflict resolution**: Modify the same rule locally and via API simultaneously. The version with the later `updated_at` should win after the next sync
8. **Reconnect**: Stop and restart the backend. Verify the extension reconnects automatically (check for `[NeuronSync] Reconnecting in Xms`)
9. **Logout clears sync**: Click logout. Verify WebSocket disconnects and sync indicator shows "Offline"
