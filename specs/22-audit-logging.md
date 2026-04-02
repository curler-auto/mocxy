# Feature 4.4 — Audit Logging

## Summary

Comprehensive audit logging system that records every significant action performed on the Neuron Interceptor platform -- user logins, rule changes, workspace modifications, member management, data exports, and configuration changes. Logs are stored in PostgreSQL with indexes for efficient querying, exposed via a filterable API, and viewable in a dedicated admin UI component with before/after diffs and CSV/JSON export for compliance audits.

## Why

Enterprise customers require audit trails for: (1) compliance frameworks (SOC 2 Type II, ISO 27001, HIPAA, GDPR Article 30) that mandate logging of all data access and configuration changes, (2) security incident investigation -- determining exactly what changed, when, and by whom, (3) troubleshooting -- understanding why a rule stopped working by reviewing its change history, and (4) governance -- workspace owners need visibility into member activity. Without audit logging, the platform cannot be deployed in regulated industries.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Backend**: Fastify API server (from spec 13-backend-api.md)
- **Database**: PostgreSQL (from spec 19-onprem-docker.md)
- **Cache**: Redis for buffered async writes (from spec 19)
- **License feature flag**: `audit` (from spec 20-license-server.md)
- **Options UI**: Components in `options/components/`, registered in `options/options.js`

## Audit Event Types

Every auditable action is categorized by an event type string:

| Event Type | Resource | Trigger |
|------------|----------|---------|
| `user_login` | user | Successful login (local or SSO) |
| `user_logout` | user | Explicit logout |
| `user_login_failed` | user | Failed login attempt (wrong password, locked, etc.) |
| `rule_created` | rule | New rule saved |
| `rule_updated` | rule | Existing rule modified |
| `rule_deleted` | rule | Rule deleted |
| `rule_toggled` | rule | Rule enabled/disabled toggle |
| `collection_created` | collection | New mock collection created |
| `collection_updated` | collection | Collection modified |
| `collection_deleted` | collection | Collection deleted |
| `workspace_created` | workspace | New workspace created |
| `workspace_updated` | workspace | Workspace settings changed |
| `workspace_deleted` | workspace | Workspace deleted |
| `member_invited` | member | User invited to workspace |
| `member_removed` | member | User removed from workspace |
| `role_changed` | member | Member role updated |
| `settings_changed` | settings | Workspace or global settings modified |
| `export_performed` | data | Rules or data exported |
| `import_performed` | data | Rules or data imported |
| `license_validated` | license | License file loaded and validated |

## Audit Log Entry Schema

Each audit log entry is a single row in the `audit_logs` table:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-04-01T14:23:45.123Z",
  "workspaceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userId": "f0e1d2c3-b4a5-6789-0abc-def123456789",
  "userEmail": "jdoe@acme.com",
  "action": "rule_updated",
  "resourceType": "rule",
  "resourceId": "12345678-abcd-ef01-2345-6789abcdef00",
  "details": {
    "before": {
      "name": "Block Ads",
      "enabled": true,
      "condition": { "url": { "type": "contains", "value": "/ads/" } }
    },
    "after": {
      "name": "Block Ads v2",
      "enabled": true,
      "condition": { "url": { "type": "regex", "value": "/ads/|/tracking/" } }
    },
    "changedFields": ["name", "condition.url.type", "condition.url.value"]
  },
  "ipAddress": "10.0.1.42",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)..."
}
```

### Details Field Structure

The `details` JSONB field contains context-specific information depending on the action type:

| Action Type | Details Content |
|-------------|-----------------|
| `rule_created` | `{ after: { full rule object } }` |
| `rule_updated` | `{ before: { old values }, after: { new values }, changedFields: [...] }` |
| `rule_deleted` | `{ before: { full rule object at time of deletion } }` |
| `user_login` | `{ method: 'local' \| 'ldap' \| 'saml', userAgent: '...' }` |
| `user_login_failed` | `{ method: '...', reason: 'invalid_password' \| 'account_locked' \| ... }` |
| `member_invited` | `{ invitedEmail: '...', role: 'member' }` |
| `role_changed` | `{ before: { role: 'member' }, after: { role: 'admin' } }` |
| `settings_changed` | `{ before: { key: oldValue }, after: { key: newValue } }` |
| `export_performed` | `{ format: 'json', itemCount: 42 }` |
| `import_performed` | `{ format: 'json', itemCount: 15, conflicts: 2 }` |

## Files to Create

| File | Purpose |
|------|---------|
| `server/migrations/YYYYMMDD_create_audit_logs.js` | Database migration for audit_logs table |
| `server/src/services/audit-service.js` | Core audit logging service with async buffered writes |
| `server/src/routes/audit.js` | API routes for querying and exporting audit logs |
| `options/components/audit-log.js` | Options page component for viewing audit logs |

## Files to Modify

| File | Change |
|------|--------|
| `server/src/routes/auth.js` | Call `auditLog` on login/logout |
| `server/src/routes/rules.js` | Call `auditLog` on rule CRUD |
| `server/src/routes/collections.js` | Call `auditLog` on collection CRUD |
| `server/src/routes/workspaces.js` | Call `auditLog` on workspace/member changes |
| `server/src/routes/settings.js` | Call `auditLog` on settings changes |
| `options/options.js` | Import and register the audit-log component |
| `options/options.html` | Add navigation tab for "Audit Log" |

## Implementation

### File 1: Database Migration

`server/migrations/20260401_create_audit_logs.js`

```javascript
'use strict';

/**
 * Migration: Create the audit_logs table for compliance-grade event logging.
 */
exports.up = function (knex) {
  return knex.schema.createTable('audit_logs', (table) => {
    // Primary key
    table.uuid('id').primary().defaultTo(knex.fn.uuid());

    // Timestamp with millisecond precision
    table.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Context
    table.uuid('workspace_id').nullable();
    table.uuid('user_id').nullable();
    table.string('user_email', 255).nullable();

    // Event classification
    table.string('action', 50).notNullable();
    table.string('resource_type', 50).notNullable();
    table.uuid('resource_id').nullable();

    // Event details (before/after diff, metadata)
    table.jsonb('details').nullable();

    // Client information
    table.string('ip_address', 45).nullable();  // IPv4 or IPv6
    table.text('user_agent').nullable();

    // --- Indexes for common query patterns ---

    // Most common: filter by workspace + time range
    table.index(['workspace_id', 'timestamp'], 'idx_audit_workspace_time');

    // Filter by user
    table.index(['user_id', 'timestamp'], 'idx_audit_user_time');

    // Filter by action type
    table.index(['action', 'timestamp'], 'idx_audit_action_time');

    // Filter by resource
    table.index(['resource_type', 'resource_id'], 'idx_audit_resource');

    // Cleanup: purge old entries by timestamp
    table.index(['timestamp'], 'idx_audit_timestamp');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('audit_logs');
};
```

### File 2: `server/src/services/audit-service.js`

The core audit logging service. Provides a `logEvent()` function that is called from route handlers. Uses Redis as a write buffer to avoid blocking API responses -- events are queued and flushed in batches every 2 seconds.

```javascript
'use strict';

/**
 * Neuron Interceptor — Audit Logging Service
 *
 * Provides async, non-blocking audit event logging with Redis-buffered batch writes.
 *
 * Usage in route handlers:
 *   const { logEvent } = require('../services/audit-service');
 *   await logEvent({
 *     workspaceId: '...',
 *     userId: request.user.id,
 *     userEmail: request.user.email,
 *     action: 'rule_created',
 *     resourceType: 'rule',
 *     resourceId: newRule.id,
 *     details: { after: newRule },
 *     ipAddress: request.ip,
 *     userAgent: request.headers['user-agent'],
 *   });
 */

const { v4: uuidv4 } = require('uuid');

// Module state
let _knex = null;
let _redis = null;
let _flushInterval = null;
let _buffer = [];

const REDIS_QUEUE_KEY = 'neuron:audit:queue';
const FLUSH_INTERVAL_MS = 2000;
const BATCH_SIZE = 100;
const DEFAULT_RETENTION_DAYS = 90;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the audit service.
 * Call once during server startup after database and Redis connections are established.
 *
 * @param {object} knex — Knex database instance
 * @param {object} redis — ioredis client instance
 */
function initAuditService(knex, redis) {
  _knex = knex;
  _redis = redis;

  // Start the background flush loop
  _flushInterval = setInterval(_flushBuffer, FLUSH_INTERVAL_MS);

  // Flush remaining events on process exit
  process.on('beforeExit', async () => {
    await _flushBuffer();
  });

  console.log('[Neuron Audit] Audit service initialized. Flush interval:', FLUSH_INTERVAL_MS, 'ms');
}

/**
 * Shut down the audit service gracefully.
 * Flushes any remaining buffered events.
 */
async function shutdownAuditService() {
  if (_flushInterval) {
    clearInterval(_flushInterval);
    _flushInterval = null;
  }
  await _flushBuffer();
  console.log('[Neuron Audit] Audit service shut down.');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Log an audit event. Non-blocking — the event is queued for batch insert.
 *
 * @param {object} event — Audit event data
 * @param {string} [event.workspaceId] — Workspace context (nullable for global events)
 * @param {string} [event.userId] — Acting user ID
 * @param {string} [event.userEmail] — Acting user email
 * @param {string} event.action — Event type (from AUDIT_ACTIONS enum)
 * @param {string} event.resourceType — Resource category
 * @param {string} [event.resourceId] — ID of the affected resource
 * @param {object} [event.details] — Before/after diff, metadata
 * @param {string} [event.ipAddress] — Client IP address
 * @param {string} [event.userAgent] — Client user agent string
 */
async function logEvent(event) {
  const entry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    workspace_id: event.workspaceId || null,
    user_id: event.userId || null,
    user_email: event.userEmail || null,
    action: event.action,
    resource_type: event.resourceType,
    resource_id: event.resourceId || null,
    details: event.details ? JSON.stringify(event.details) : null,
    ip_address: event.ipAddress || null,
    user_agent: event.userAgent || null,
  };

  // Try Redis queue first (distributed, survives process restart)
  if (_redis) {
    try {
      await _redis.lpush(REDIS_QUEUE_KEY, JSON.stringify(entry));
      return;
    } catch (err) {
      console.warn('[Neuron Audit] Redis queue failed, falling back to in-memory buffer:', err.message);
    }
  }

  // Fallback: in-memory buffer
  _buffer.push(entry);
}

/**
 * Compute the diff between two objects for the audit details field.
 * Returns { before, after, changedFields } with only the differing fields.
 *
 * @param {object} before — The object before the change
 * @param {object} after — The object after the change
 * @returns {{ before: object, after: object, changedFields: string[] }}
 */
function computeDiff(before, after) {
  const changedFields = [];
  const diffBefore = {};
  const diffAfter = {};

  const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of allKeys) {
    // Skip internal/meta fields
    if (key === 'updated_at' || key === 'created_at') continue;

    const oldVal = before?.[key];
    const newVal = after?.[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changedFields.push(key);
      diffBefore[key] = oldVal;
      diffAfter[key] = newVal;
    }
  }

  return { before: diffBefore, after: diffAfter, changedFields };
}

// =============================================================================
// Query API (used by the audit route)
// =============================================================================

/**
 * Query audit logs with filtering and pagination.
 *
 * @param {object} filters
 * @param {string} [filters.workspaceId] — Filter by workspace
 * @param {string} [filters.userId] — Filter by user
 * @param {string} [filters.action] — Filter by action type
 * @param {string} [filters.resourceType] — Filter by resource type
 * @param {string} [filters.resourceId] — Filter by specific resource
 * @param {string} [filters.from] — Start timestamp (ISO8601)
 * @param {string} [filters.to] — End timestamp (ISO8601)
 * @param {string} [filters.search] — Full-text search in user_email and details
 * @param {number} [filters.limit=50] — Page size
 * @param {number} [filters.offset=0] — Page offset
 * @returns {Promise<{ data: object[], total: number }>}
 */
async function queryLogs(filters) {
  let query = _knex('audit_logs');
  let countQuery = _knex('audit_logs');

  // Apply filters
  if (filters.workspaceId) {
    query = query.where('workspace_id', filters.workspaceId);
    countQuery = countQuery.where('workspace_id', filters.workspaceId);
  }
  if (filters.userId) {
    query = query.where('user_id', filters.userId);
    countQuery = countQuery.where('user_id', filters.userId);
  }
  if (filters.action) {
    query = query.where('action', filters.action);
    countQuery = countQuery.where('action', filters.action);
  }
  if (filters.resourceType) {
    query = query.where('resource_type', filters.resourceType);
    countQuery = countQuery.where('resource_type', filters.resourceType);
  }
  if (filters.resourceId) {
    query = query.where('resource_id', filters.resourceId);
    countQuery = countQuery.where('resource_id', filters.resourceId);
  }
  if (filters.from) {
    query = query.where('timestamp', '>=', new Date(filters.from));
    countQuery = countQuery.where('timestamp', '>=', new Date(filters.from));
  }
  if (filters.to) {
    query = query.where('timestamp', '<=', new Date(filters.to));
    countQuery = countQuery.where('timestamp', '<=', new Date(filters.to));
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    query = query.where(function () {
      this.where('user_email', 'ilike', pattern)
        .orWhereRaw("details::text ILIKE ?", [pattern]);
    });
    countQuery = countQuery.where(function () {
      this.where('user_email', 'ilike', pattern)
        .orWhereRaw("details::text ILIKE ?", [pattern]);
    });
  }

  // Get total count
  const totalResult = await countQuery.count('* as count').first();
  const total = parseInt(totalResult.count, 10);

  // Get paginated results
  const limit = Math.min(filters.limit || 50, 500);
  const offset = filters.offset || 0;

  const data = await query
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .offset(offset);

  // Parse JSON details field
  for (const row of data) {
    if (typeof row.details === 'string') {
      try { row.details = JSON.parse(row.details); } catch (e) { /* keep as string */ }
    }
  }

  return { data, total };
}

/**
 * Export audit logs as CSV or JSON.
 *
 * @param {object} filters — Same filters as queryLogs (no pagination)
 * @param {'csv'|'json'} format — Export format
 * @returns {Promise<string>}
 */
async function exportLogs(filters, format) {
  // Remove pagination for exports
  const exportFilters = { ...filters, limit: 100000, offset: 0 };
  const { data } = await queryLogs(exportFilters);

  if (format === 'csv') {
    const headers = [
      'id', 'timestamp', 'workspace_id', 'user_id', 'user_email',
      'action', 'resource_type', 'resource_id', 'details', 'ip_address', 'user_agent',
    ];

    const rows = data.map(row =>
      headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val).replace(/"/g, '""');
        return String(val).replace(/"/g, '""');
      }).map(v => `"${v}"`).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  // JSON format
  return JSON.stringify(data, null, 2);
}

/**
 * Purge audit logs older than the specified retention period.
 * Called by a cron job.
 *
 * @param {number} [retentionDays] — Days to retain (default: 90)
 * @returns {Promise<number>} — Number of deleted rows
 */
async function purgeOldLogs(retentionDays) {
  const days = retentionDays || parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const result = await _knex('audit_logs')
    .where('timestamp', '<', cutoff)
    .del();

  if (result > 0) {
    console.log(`[Neuron Audit] Purged ${result} audit log entries older than ${days} days.`);
  }

  return result;
}

// =============================================================================
// Background flush — batch-insert buffered events into PostgreSQL
// =============================================================================

async function _flushBuffer() {
  if (!_knex) return;

  const entries = [];

  // Drain from Redis queue first
  if (_redis) {
    try {
      const batch = await _redis.lrange(REDIS_QUEUE_KEY, 0, BATCH_SIZE - 1);
      if (batch.length > 0) {
        await _redis.ltrim(REDIS_QUEUE_KEY, batch.length, -1);
        for (const raw of batch) {
          try {
            entries.push(JSON.parse(raw));
          } catch (e) {
            console.warn('[Neuron Audit] Skipping malformed queue entry.');
          }
        }
      }
    } catch (err) {
      console.warn('[Neuron Audit] Redis drain failed:', err.message);
    }
  }

  // Drain from in-memory buffer
  if (_buffer.length > 0) {
    entries.push(..._buffer.splice(0, BATCH_SIZE));
  }

  if (entries.length === 0) return;

  // Batch insert into PostgreSQL
  try {
    await _knex.batchInsert('audit_logs', entries, BATCH_SIZE);
  } catch (err) {
    console.error('[Neuron Audit] Batch insert failed:', err.message);
    // Put failed entries back into in-memory buffer for retry
    _buffer.unshift(...entries);
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  initAuditService,
  shutdownAuditService,
  logEvent,
  computeDiff,
  queryLogs,
  exportLogs,
  purgeOldLogs,
};
```

### File 3: `server/src/routes/audit.js`

Fastify route plugin for querying and exporting audit logs.

```javascript
'use strict';

/**
 * Neuron Interceptor — Audit Log API Routes
 *
 * Routes:
 *   GET  /api/workspaces/:workspaceId/audit-logs          — Query audit logs
 *   GET  /api/workspaces/:workspaceId/audit-logs/export   — Export as CSV/JSON
 *   POST /api/admin/audit-logs/purge                      — Manual purge (admin only)
 */

const { queryLogs, exportLogs, purgeOldLogs } = require('../services/audit-service');

async function auditRoutes(fastify) {

  // =========================================================================
  // GET /api/workspaces/:workspaceId/audit-logs — Query with filters
  // =========================================================================
  fastify.get('/api/workspaces/:workspaceId/audit-logs', {
    preHandler: [requireAuth, requireWorkspaceRole(['admin', 'owner'])],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          userId: { type: 'string', format: 'uuid' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string', format: 'uuid' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          search: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { workspaceId } = request.params;
    const filters = {
      workspaceId,
      ...request.query,
    };

    const result = await queryLogs(filters);

    return reply.send({
      data: result.data,
      total: result.total,
      limit: filters.limit || 50,
      offset: filters.offset || 0,
    });
  });

  // =========================================================================
  // GET /api/workspaces/:workspaceId/audit-logs/export — Export for compliance
  // =========================================================================
  fastify.get('/api/workspaces/:workspaceId/audit-logs/export', {
    preHandler: [requireAuth, requireWorkspaceRole(['admin', 'owner'])],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
          action: { type: 'string' },
          userId: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          search: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { workspaceId } = request.params;
    const { format = 'csv', ...queryFilters } = request.query;

    const filters = { workspaceId, ...queryFilters };
    const exported = await exportLogs(filters, format);

    const filename = `audit-logs-${workspaceId}-${new Date().toISOString().split('T')[0]}.${format}`;
    const contentType = format === 'csv' ? 'text/csv' : 'application/json';

    return reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(exported);
  });

  // =========================================================================
  // POST /api/admin/audit-logs/purge — Manual purge (admin only)
  // =========================================================================
  fastify.post('/api/admin/audit-logs/purge', {
    preHandler: [requireAuth, requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          retentionDays: { type: 'integer', minimum: 1, maximum: 3650 },
        },
      },
    },
  }, async (request, reply) => {
    const { retentionDays } = request.body || {};
    const deleted = await purgeOldLogs(retentionDays);

    return reply.send({
      message: `Purged ${deleted} audit log entries.`,
      deleted,
      retentionDays: retentionDays || 90,
    });
  });

  // =========================================================================
  // Auth middleware helpers (these would be imported from auth module)
  // =========================================================================

  function requireAuth(request, reply, done) {
    // Assumes auth plugin has already decoded JWT and set request.user
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }
    done();
  }

  function requireRole(role) {
    return function (request, reply, done) {
      if (!request.user || request.user.role !== role) {
        return reply.code(403).send({ error: `${role} access required.` });
      }
      done();
    };
  }

  function requireWorkspaceRole(roles) {
    return async function (request, reply) {
      const { workspaceId } = request.params;
      const userId = request.user?.id;

      if (!userId) {
        return reply.code(401).send({ error: 'Authentication required.' });
      }

      // Global admins can access all workspaces
      if (request.user.role === 'admin') return;

      const membership = await fastify.knex('workspace_members')
        .where({ workspace_id: workspaceId, user_id: userId })
        .first();

      if (!membership || !roles.includes(membership.role)) {
        return reply.code(403).send({ error: 'Insufficient workspace permissions.' });
      }
    };
  }
}

module.exports = auditRoutes;
```

### Integrating Audit Calls in Route Handlers

Here is the pattern for adding audit logging to existing route handlers. Each route handler calls `logEvent()` after the successful operation:

```javascript
// Example: In server/src/routes/rules.js

const { logEvent, computeDiff } = require('../services/audit-service');

// --- Rule Created ---
fastify.post('/api/workspaces/:workspaceId/rules', async (request, reply) => {
  const rule = request.body;
  // ... save rule to database ...
  const savedRule = await knex('rules').insert(rule).returning('*');

  // Audit log (non-blocking)
  logEvent({
    workspaceId: request.params.workspaceId,
    userId: request.user.id,
    userEmail: request.user.email,
    action: 'rule_created',
    resourceType: 'rule',
    resourceId: savedRule[0].id,
    details: { after: savedRule[0] },
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return reply.code(201).send(savedRule[0]);
});

// --- Rule Updated ---
fastify.put('/api/workspaces/:workspaceId/rules/:ruleId', async (request, reply) => {
  const { ruleId } = request.params;
  const updates = request.body;

  // Fetch the current state for diff
  const before = await knex('rules').where({ id: ruleId }).first();
  // ... update rule in database ...
  const after = await knex('rules').where({ id: ruleId }).update(updates).returning('*');

  // Audit log with diff
  const diff = computeDiff(before, after[0]);
  logEvent({
    workspaceId: request.params.workspaceId,
    userId: request.user.id,
    userEmail: request.user.email,
    action: 'rule_updated',
    resourceType: 'rule',
    resourceId: ruleId,
    details: diff,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return reply.send(after[0]);
});

// --- Rule Deleted ---
fastify.delete('/api/workspaces/:workspaceId/rules/:ruleId', async (request, reply) => {
  const { ruleId } = request.params;

  // Capture state before deletion
  const before = await knex('rules').where({ id: ruleId }).first();
  // ... delete from database ...
  await knex('rules').where({ id: ruleId }).del();

  logEvent({
    workspaceId: request.params.workspaceId,
    userId: request.user.id,
    userEmail: request.user.email,
    action: 'rule_deleted',
    resourceType: 'rule',
    resourceId: ruleId,
    details: { before },
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  return reply.code(204).send();
});
```

### File 4: `options/components/audit-log.js`

Options page component that displays audit logs in a filterable, paginated table with expandable detail rows showing before/after diffs.

```javascript
/**
 * Neuron Interceptor — Audit Log Component
 *
 * Displays a table of audit log entries with:
 *   - Filter controls: date range, action type, user
 *   - Paginated table with sortable timestamp column
 *   - Expandable detail rows showing before/after diffs
 *   - Export button (CSV / JSON)
 *
 * Usage in options.js:
 *   import { initAuditLog } from './components/audit-log.js';
 *   const auditLog = initAuditLog(document.getElementById('audit-log-container'), {
 *     backendUrl: 'https://neuron.acme.com',
 *     workspaceId: 'uuid',
 *     authToken: 'jwt',
 *   });
 */

const PAGE_SIZE = 50;

// All possible action types for the filter dropdown
const ACTION_TYPES = [
  'user_login', 'user_logout', 'user_login_failed',
  'rule_created', 'rule_updated', 'rule_deleted', 'rule_toggled',
  'collection_created', 'collection_updated', 'collection_deleted',
  'workspace_created', 'workspace_updated', 'workspace_deleted',
  'member_invited', 'member_removed', 'role_changed',
  'settings_changed', 'export_performed', 'import_performed',
  'license_validated',
];

// Color coding for action types
const ACTION_COLORS = {
  created: '#a6e3a1',    // green
  updated: '#89b4fa',    // blue
  deleted: '#f38ba8',    // red
  toggled: '#f9e2af',    // yellow
  login: '#a6e3a1',      // green
  logout: '#a6adc8',     // muted
  failed: '#f38ba8',     // red
  invited: '#a6e3a1',    // green
  removed: '#f38ba8',    // red
  changed: '#89b4fa',    // blue
  performed: '#cba6f7',  // purple
  validated: '#a6e3a1',  // green
};

/**
 * Initialize the audit log component.
 *
 * @param {HTMLElement} container — Parent element
 * @param {object} config
 * @param {string} config.backendUrl — Backend API base URL
 * @param {string} config.workspaceId — Current workspace ID
 * @param {string} config.authToken — JWT auth token
 * @returns {{ refresh: Function }}
 */
export function initAuditLog(container, config) {
  let _offset = 0;
  let _total = 0;
  let _data = [];
  let _expandedRows = new Set();
  let _filters = {
    action: '',
    from: '',
    to: '',
    search: '',
  };

  // Inject component styles
  _injectStyles();

  // Build the component
  const wrapper = document.createElement('div');
  wrapper.className = 'ni-audit-log';

  const filterBar = _buildFilterBar();
  const tableContainer = document.createElement('div');
  tableContainer.className = 'ni-audit-table-container';

  const pagination = _buildPagination();

  wrapper.appendChild(filterBar);
  wrapper.appendChild(tableContainer);
  wrapper.appendChild(pagination);
  container.appendChild(wrapper);

  // Initial load
  _fetchAndRender();

  // --- Filter Bar -----------------------------------------------------------

  function _buildFilterBar() {
    const bar = document.createElement('div');
    bar.className = 'ni-audit-filter-bar';
    bar.style.cssText = `
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
      margin-bottom: 16px; padding: 12px 16px;
      background: var(--bg-overlay, #181825);
      border: 1px solid var(--border, #45475a);
      border-radius: 8px;
    `;

    // Action type filter
    const actionSelect = document.createElement('select');
    actionSelect.className = 'ni-audit-filter-action';
    actionSelect.style.cssText = _inputStyle();
    actionSelect.innerHTML = '<option value="">All actions</option>' +
      ACTION_TYPES.map(a => `<option value="${a}">${a.replace(/_/g, ' ')}</option>`).join('');
    actionSelect.addEventListener('change', (e) => {
      _filters.action = e.target.value;
      _offset = 0;
      _fetchAndRender();
    });
    bar.appendChild(actionSelect);

    // Date from
    const fromInput = document.createElement('input');
    fromInput.type = 'date';
    fromInput.className = 'ni-audit-filter-from';
    fromInput.style.cssText = _inputStyle();
    fromInput.title = 'From date';
    fromInput.addEventListener('change', (e) => {
      _filters.from = e.target.value ? new Date(e.target.value).toISOString() : '';
      _offset = 0;
      _fetchAndRender();
    });
    bar.appendChild(fromInput);

    // Date to
    const toInput = document.createElement('input');
    toInput.type = 'date';
    toInput.className = 'ni-audit-filter-to';
    toInput.style.cssText = _inputStyle();
    toInput.title = 'To date';
    toInput.addEventListener('change', (e) => {
      _filters.to = e.target.value ? new Date(e.target.value + 'T23:59:59Z').toISOString() : '';
      _offset = 0;
      _fetchAndRender();
    });
    bar.appendChild(toInput);

    // Search
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search user or details...';
    searchInput.style.cssText = _inputStyle() + 'flex: 1; min-width: 180px;';
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        _filters.search = e.target.value;
        _offset = 0;
        _fetchAndRender();
      }, 400);
    });
    bar.appendChild(searchInput);

    // Export buttons
    const exportCsv = document.createElement('button');
    exportCsv.textContent = 'Export CSV';
    exportCsv.className = 'ni-btn ni-btn-secondary';
    exportCsv.style.cssText = 'padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 12px; white-space: nowrap;';
    exportCsv.addEventListener('click', () => _export('csv'));
    bar.appendChild(exportCsv);

    const exportJson = document.createElement('button');
    exportJson.textContent = 'Export JSON';
    exportJson.className = 'ni-btn ni-btn-secondary';
    exportJson.style.cssText = exportCsv.style.cssText;
    exportJson.addEventListener('click', () => _export('json'));
    bar.appendChild(exportJson);

    return bar;
  }

  // --- Table Rendering -------------------------------------------------------

  function _renderTable() {
    tableContainer.innerHTML = '';

    if (_data.length === 0) {
      tableContainer.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted, #a6adc8); font-size: 14px;">
          No audit log entries found.
        </div>
      `;
      return;
    }

    const table = document.createElement('table');
    table.className = 'ni-audit-table';
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 13px;';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr style="border-bottom: 2px solid var(--border, #45475a);">
        <th style="${_thStyle()}"></th>
        <th style="${_thStyle()}">Timestamp</th>
        <th style="${_thStyle()}">Action</th>
        <th style="${_thStyle()}">User</th>
        <th style="${_thStyle()}">Resource</th>
        <th style="${_thStyle()}">IP Address</th>
      </tr>
    `;
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const entry of _data) {
      // Main row
      const tr = document.createElement('tr');
      tr.className = 'ni-audit-row';
      tr.style.cssText = `border-bottom: 1px solid var(--border, #313244); cursor: pointer; transition: background 0.1s;`;
      tr.addEventListener('mouseenter', () => { tr.style.background = 'var(--surface-hover, #3b3f58)'; });
      tr.addEventListener('mouseleave', () => { tr.style.background = 'transparent'; });

      const isExpanded = _expandedRows.has(entry.id);

      // Determine action color
      const actionSuffix = entry.action.split('_').pop();
      const actionColor = ACTION_COLORS[actionSuffix] || 'var(--text-muted)';

      tr.innerHTML = `
        <td style="${_tdStyle()} width: 30px; text-align: center;">${isExpanded ? '&#9660;' : '&#9654;'}</td>
        <td style="${_tdStyle()} white-space: nowrap; color: var(--text-muted);">${_formatTimestamp(entry.timestamp)}</td>
        <td style="${_tdStyle()}">
          <span style="
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            background: ${actionColor}18;
            color: ${actionColor};
            font-size: 12px;
            font-weight: 500;
          ">${entry.action.replace(/_/g, ' ')}</span>
        </td>
        <td style="${_tdStyle()} color: var(--text);">${entry.user_email || '<system>'}</td>
        <td style="${_tdStyle()} color: var(--text-muted);">${entry.resource_type}${entry.resource_id ? ' / ' + entry.resource_id.substring(0, 8) + '...' : ''}</td>
        <td style="${_tdStyle()} color: var(--text-muted); font-family: monospace; font-size: 12px;">${entry.ip_address || '-'}</td>
      `;

      tr.addEventListener('click', () => {
        if (_expandedRows.has(entry.id)) {
          _expandedRows.delete(entry.id);
        } else {
          _expandedRows.add(entry.id);
        }
        _renderTable();
      });

      tbody.appendChild(tr);

      // Expanded detail row
      if (isExpanded && entry.details) {
        const detailRow = document.createElement('tr');
        detailRow.className = 'ni-audit-detail-row';
        detailRow.innerHTML = `
          <td colspan="6" style="padding: 12px 16px 16px 46px; background: var(--bg-overlay, #11111b); border-bottom: 1px solid var(--border);">
            ${_renderDetails(entry)}
          </td>
        `;
        tbody.appendChild(detailRow);
      }
    }

    table.appendChild(tbody);
    tableContainer.appendChild(table);
  }

  // --- Detail Rendering (before/after diff) ----------------------------------

  function _renderDetails(entry) {
    const details = entry.details;
    if (!details) return '<span style="color: var(--text-muted);">No details available.</span>';

    let html = '';

    // Changed fields summary
    if (details.changedFields && details.changedFields.length > 0) {
      html += `<div style="margin-bottom: 12px; color: var(--text-muted); font-size: 12px;">
        Changed fields: <strong style="color: var(--text);">${details.changedFields.join(', ')}</strong>
      </div>`;
    }

    // Before/After comparison
    if (details.before || details.after) {
      html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">';

      if (details.before) {
        html += `
          <div>
            <div style="color: #f38ba8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600;">Before</div>
            <pre style="margin: 0; padding: 10px; background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #f38ba8; line-height: 1.5;">${_formatJSON(details.before)}</pre>
          </div>
        `;
      }

      if (details.after) {
        html += `
          <div>
            <div style="color: #a6e3a1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 600;">After</div>
            <pre style="margin: 0; padding: 10px; background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px; overflow-x: auto; font-size: 12px; color: #a6e3a1; line-height: 1.5;">${_formatJSON(details.after)}</pre>
          </div>
        `;
      }

      html += '</div>';
    } else {
      // Generic details display
      html += `<pre style="margin: 0; padding: 10px; background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px; overflow-x: auto; font-size: 12px; color: var(--text); line-height: 1.5;">${_formatJSON(details)}</pre>`;
    }

    // User agent
    if (entry.user_agent) {
      html += `<div style="margin-top: 8px; font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${_escapeHTML(entry.user_agent)}">User Agent: ${_escapeHTML(entry.user_agent)}</div>`;
    }

    return html;
  }

  // --- Pagination ------------------------------------------------------------

  function _buildPagination() {
    const bar = document.createElement('div');
    bar.className = 'ni-audit-pagination';
    bar.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 12px; font-size: 13px; color: var(--text-muted);';
    return bar;
  }

  function _renderPagination() {
    const totalPages = Math.ceil(_total / PAGE_SIZE);
    const currentPage = Math.floor(_offset / PAGE_SIZE) + 1;

    pagination.innerHTML = `
      <span>Showing ${_offset + 1}-${Math.min(_offset + PAGE_SIZE, _total)} of ${_total} entries</span>
      <div style="display: flex; gap: 8px;">
        <button class="ni-audit-prev" style="${_paginationBtnStyle()}" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span style="padding: 6px 12px; color: var(--text);">Page ${currentPage} of ${totalPages}</span>
        <button class="ni-audit-next" style="${_paginationBtnStyle()}" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;

    const prevBtn = pagination.querySelector('.ni-audit-prev');
    const nextBtn = pagination.querySelector('.ni-audit-next');

    prevBtn?.addEventListener('click', () => {
      if (_offset >= PAGE_SIZE) {
        _offset -= PAGE_SIZE;
        _fetchAndRender();
      }
    });

    nextBtn?.addEventListener('click', () => {
      if (_offset + PAGE_SIZE < _total) {
        _offset += PAGE_SIZE;
        _fetchAndRender();
      }
    });
  }

  // --- Data Fetching ---------------------------------------------------------

  async function _fetchAndRender() {
    const params = new URLSearchParams();
    params.set('limit', PAGE_SIZE);
    params.set('offset', _offset);
    if (_filters.action) params.set('action', _filters.action);
    if (_filters.from) params.set('from', _filters.from);
    if (_filters.to) params.set('to', _filters.to);
    if (_filters.search) params.set('search', _filters.search);

    try {
      const res = await fetch(
        `${config.backendUrl}/api/workspaces/${config.workspaceId}/audit-logs?${params}`,
        { headers: { Authorization: `Bearer ${config.authToken}` } }
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const result = await res.json();
      _data = result.data;
      _total = result.total;

      _renderTable();
      _renderPagination();
    } catch (err) {
      tableContainer.innerHTML = `<div style="color: #f38ba8; padding: 20px; text-align: center;">Failed to load audit logs: ${_escapeHTML(err.message)}</div>`;
    }
  }

  // --- Export ----------------------------------------------------------------

  async function _export(format) {
    const params = new URLSearchParams();
    params.set('format', format);
    if (_filters.action) params.set('action', _filters.action);
    if (_filters.from) params.set('from', _filters.from);
    if (_filters.to) params.set('to', _filters.to);
    if (_filters.search) params.set('search', _filters.search);

    try {
      const res = await fetch(
        `${config.backendUrl}/api/workspaces/${config.workspaceId}/audit-logs/export?${params}`,
        { headers: { Authorization: `Bearer ${config.authToken}` } }
      );

      if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
  }

  // --- Helpers ---------------------------------------------------------------

  function _formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function _formatJSON(obj) {
    return _escapeHTML(JSON.stringify(obj, null, 2));
  }

  function _escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _inputStyle() {
    return 'padding: 6px 10px; border: 1px solid var(--border, #45475a); border-radius: 6px; background: var(--bg-overlay, #1e1e2e); color: var(--text, #cdd6f4); font-size: 13px; outline: none;';
  }

  function _thStyle() {
    return 'text-align: left; padding: 8px 12px; color: var(--text-muted, #a6adc8); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;';
  }

  function _tdStyle() {
    return 'padding: 10px 12px; vertical-align: middle;';
  }

  function _paginationBtnStyle() {
    return 'padding: 6px 14px; border: 1px solid var(--border, #45475a); border-radius: 6px; background: transparent; color: var(--text, #cdd6f4); cursor: pointer; font-size: 13px;';
  }

  // --- Inject Styles ---------------------------------------------------------

  function _injectStyles() {
    if (document.getElementById('ni-audit-log-styles')) return;

    const style = document.createElement('style');
    style.id = 'ni-audit-log-styles';
    style.textContent = `
      .ni-audit-table-container {
        border: 1px solid var(--border, #45475a);
        border-radius: 8px;
        overflow: hidden;
        background: var(--bg-overlay, #181825);
      }
      .ni-audit-table-container::-webkit-scrollbar {
        width: 6px; height: 6px;
      }
      .ni-audit-table-container::-webkit-scrollbar-thumb {
        background: #45475a; border-radius: 3px;
      }
      .ni-audit-row:hover {
        background: var(--surface-hover, #3b3f58);
      }
      .ni-audit-pagination button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .ni-audit-pagination button:not(:disabled):hover {
        background: var(--surface-hover, #3b3f58);
      }
    `;
    document.head.appendChild(style);
  }

  // --- Public API ------------------------------------------------------------

  return {
    refresh: _fetchAndRender,
  };
}
```

### Registration in Options Page

In `options/options.js`, import and initialize the audit log component:

```javascript
// In options/options.js — add after other component imports

import { initAuditLog } from './components/audit-log.js';

// In the tab initialization section:
const auditLogContainer = document.getElementById('audit-log-container');
if (auditLogContainer && backendConfig) {
  const auditLog = initAuditLog(auditLogContainer, {
    backendUrl: backendConfig.url,
    workspaceId: backendConfig.workspaceId,
    authToken: backendConfig.authToken,
  });
}
```

In `options/options.html`, add the tab and container:

```html
<!-- Add to the tab navigation -->
<button class="ni-tab" data-tab="audit-log">Audit Log</button>

<!-- Add the container -->
<div id="audit-log-container" class="ni-tab-content" data-tab="audit-log" style="display: none;"></div>
```

### Retention Cron Job

Add a scheduled job to purge old audit logs. In `server/src/index.js`:

```javascript
const { purgeOldLogs } = require('./services/audit-service');

// Run daily at 2:00 AM
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function schedulePurge() {
  // Initial purge on startup (delayed 60 seconds)
  setTimeout(async () => {
    try {
      await purgeOldLogs();
    } catch (err) {
      fastify.log.error('Audit purge failed:', err);
    }
  }, 60000);

  // Schedule daily purge
  setInterval(async () => {
    try {
      await purgeOldLogs();
    } catch (err) {
      fastify.log.error('Audit purge failed:', err);
    }
  }, PURGE_INTERVAL_MS);
}

// Call after server startup
schedulePurge();
```

## Verification

### Step 1: Run Database Migration

```bash
cd server/
npx knex migrate:latest

# Verify table exists:
npx knex migrate:status
# Expected: 20260401_create_audit_logs: completed
```

### Step 2: Verify Audit Logging on Rule Operations

```bash
# Create a rule
curl -X POST http://localhost:3001/api/workspaces/$WS_ID/rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Rule","condition":{"url":{"type":"contains","value":"/api"}}}'

# Check audit log
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?action=rule_created" \
  -H "Authorization: Bearer $TOKEN"
# Expected: entry with action=rule_created, details.after containing the rule

# Update the rule
curl -X PUT http://localhost:3001/api/workspaces/$WS_ID/rules/$RULE_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Updated Rule"}'

# Check audit log for update with diff
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?action=rule_updated" \
  -H "Authorization: Bearer $TOKEN"
# Expected: entry with details.before.name="Test Rule", details.after.name="Updated Rule", changedFields=["name"]
```

### Step 3: Verify Login Audit

```bash
# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"test"}'

# Check audit log
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?action=user_login" \
  -H "Authorization: Bearer $TOKEN"
# Expected: entry with action=user_login, details.method="local"
```

### Step 4: Verify Filtering and Pagination

```bash
# Filter by action type
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?action=rule_created&limit=10&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# Filter by date range
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"

# Search
curl "http://localhost:3001/api/workspaces/$WS_ID/audit-logs?search=admin" \
  -H "Authorization: Bearer $TOKEN"
```

### Step 5: Verify Export

```bash
# CSV export
curl -o audit.csv "http://localhost:3001/api/workspaces/$WS_ID/audit-logs/export?format=csv" \
  -H "Authorization: Bearer $TOKEN"
cat audit.csv
# Expected: CSV with headers and data rows

# JSON export
curl -o audit.json "http://localhost:3001/api/workspaces/$WS_ID/audit-logs/export?format=json" \
  -H "Authorization: Bearer $TOKEN"
```

### Step 6: Verify Purge

```bash
# Manual purge (admin only)
curl -X POST http://localhost:3001/api/admin/audit-logs/purge \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"retentionDays": 1}'
# Expected: {"message":"Purged N audit log entries.","deleted":N,"retentionDays":1}
```

### Step 7: Verify Options UI

1. Open the extension Options page
2. Click the "Audit Log" tab
3. Confirm the filter bar shows: action dropdown, date from/to, search input, Export CSV/JSON buttons
4. Confirm the table shows audit log entries with: timestamp, action badge, user email, resource, IP
5. Click a row to expand -- confirm before/after diff is shown with color coding
6. Change the action filter to "rule_created" -- confirm only matching entries appear
7. Set a date range -- confirm entries are filtered
8. Click "Export CSV" -- confirm a CSV file downloads
9. Click "Export JSON" -- confirm a JSON file downloads
10. Navigate between pages using Previous/Next buttons
