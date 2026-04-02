# Feature 3.1: Backend API Server

## Summary

Build the Node.js backend that powers cloud sync, team workspaces, authentication, and billing for the Neuron Interceptor Chrome Extension. Uses Fastify for HTTP, PostgreSQL for persistence, Redis for caching/pub-sub, and Knex for query building and migrations.

## Why

The extension currently stores everything in `chrome.storage.local` on each user's machine. A backend is required for:
- Cross-device sync of rules and mock collections
- Team workspaces with shared rules and RBAC
- User authentication (email/password + OAuth)
- SaaS billing via Stripe
- Real-time push notifications when rules change (WebSocket)

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Server location**: `health_check/utils/neuron-interceptor-plugin/server/`
- **Extension architecture**: Chrome MV3, vanilla JS ES modules, no build step
- **Existing shared constants**: `shared/constants.js` defines `MSG_TYPES`, `STORAGE_KEYS`, `ACTION_TYPES`, `MOCK_SERVER_MODES`
- **Existing data models**: `shared/data-models.js` defines `createRule()`, `createMockCollection()`, `createMock()`, `createLogEntry()`
- **Rule shape**: `{ id (uuid), name, enabled, priority, condition: { url: { type, value }, headers: [], methods: [] }, action: { type, redirect, rewrite, mockInline, mockServer, headerMods, delayMs } }`
- **Mock collection shape**: `{ id (uuid), name, active, mocks: [] }`
- **Theme**: Catppuccin Mocha dark palette (CSS variables in `options/options.css`)

## Directory Structure

Create the following directory tree inside `health_check/utils/neuron-interceptor-plugin/server/`:

```
server/
  docker-compose.yml
  Dockerfile
  package.json
  .env.example
  knexfile.js
  src/
    index.js                    # Fastify app entry point
    config/
      index.js                  # Loads .env, exports config object
    routes/
      auth.js                   # POST /auth/register, /login, /refresh, GET /me
      workspaces.js             # CRUD + invite for workspaces
      rules.js                  # CRUD for rules within a workspace
      collections.js            # CRUD for mock collections within a workspace
      settings.js               # GET/PUT workspace settings
      data-transfer.js          # POST export, POST import
      billing.js                # Stripe checkout, portal, webhooks (stub)
      ws.js                     # WebSocket handler for real-time sync
    models/
      user.js                   # User queries (find, create, update)
      workspace.js              # Workspace + membership queries
      rule.js                   # Rule queries
      collection.js             # Mock collection queries
      setting.js                # Setting queries
    services/
      auth-service.js           # Password hashing, JWT generation/verification
      sync-service.js           # Redis pub/sub for real-time sync
      billing-service.js        # Stripe API wrapper (stub for now)
    middleware/
      auth-middleware.js         # JWT bearer token verification
      rbac-middleware.js         # Workspace role check
      plan-middleware.js         # Plan limit enforcement (stub)
      rate-limit-middleware.js   # Request rate limiting via Redis
    config/
      index.js                  # Environment config loader
  migrations/
    20240101000001_create_users.js
    20240101000002_create_workspaces.js
    20240101000003_create_workspace_members.js
    20240101000004_create_rules.js
    20240101000005_create_mock_collections.js
    20240101000006_create_settings.js
```

## package.json

Create `server/package.json`:

```json
{
  "name": "neuron-interceptor-server",
  "version": "1.0.0",
  "description": "Backend API for Neuron Interceptor Chrome Extension",
  "main": "src/index.js",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "migrate": "knex migrate:latest --knexfile knexfile.js",
    "migrate:rollback": "knex migrate:rollback --knexfile knexfile.js",
    "migrate:make": "knex migrate:make --knexfile knexfile.js",
    "seed": "knex seed:run --knexfile knexfile.js",
    "docker:up": "docker compose up -d",
    "docker:down": "docker compose down",
    "docker:logs": "docker compose logs -f api"
  },
  "dependencies": {
    "fastify": "^4.26.0",
    "@fastify/cors": "^9.0.1",
    "@fastify/jwt": "^8.0.0",
    "@fastify/websocket": "^10.0.1",
    "@fastify/rate-limit": "^9.1.0",
    "@fastify/formbody": "^7.4.0",
    "pg": "^8.11.3",
    "knex": "^3.1.0",
    "ioredis": "^5.3.2",
    "bcrypt": "^5.1.1",
    "dotenv": "^16.4.1",
    "uuid": "^9.0.0",
    "stripe": "^14.14.0"
  },
  "devDependencies": {
    "pino-pretty": "^10.3.1"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

## docker-compose.yml

Create `server/docker-compose.yml`:

```yaml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    container_name: neuron-postgres
    environment:
      POSTGRES_USER: neuron
      POSTGRES_PASSWORD: neuron_secret
      POSTGRES_DB: neuron_interceptor
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - neuron-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U neuron -d neuron_interceptor"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: neuron-redis
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
    networks:
      - neuron-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: neuron-api
    ports:
      - "3001:3001"
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://neuron:neuron_secret@postgres:5432/neuron_interceptor
      REDIS_URL: redis://redis:6379
      JWT_SECRET: change-me-in-production-use-64-chars-minimum-random-string
      JWT_REFRESH_SECRET: change-me-too-different-from-access-secret-64-chars
      STRIPE_SECRET_KEY: sk_test_placeholder
      STRIPE_WEBHOOK_SECRET: whsec_placeholder
      GOOGLE_CLIENT_ID: placeholder.apps.googleusercontent.com
      GOOGLE_CLIENT_SECRET: placeholder
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - neuron-net

volumes:
  pgdata:
  redisdata:

networks:
  neuron-net:
    driver: bridge
```

## Dockerfile

Create `server/Dockerfile`:

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Run migrations then start
CMD ["sh", "-c", "npx knex migrate:latest --knexfile knexfile.js && node src/index.js"]

EXPOSE 3001
```

## .env.example

Create `server/.env.example`:

```env
# Server
NODE_ENV=development
PORT=3001

# PostgreSQL
DATABASE_URL=postgres://neuron:neuron_secret@localhost:5432/neuron_interceptor

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=dev-secret-change-in-production-must-be-at-least-64-characters-long-random
JWT_REFRESH_SECRET=dev-refresh-secret-change-in-production-different-from-access-secret

# Stripe (optional, leave placeholder for dev)
STRIPE_SECRET_KEY=sk_test_placeholder
STRIPE_WEBHOOK_SECRET=whsec_placeholder

# Google OAuth (optional)
GOOGLE_CLIENT_ID=placeholder.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=placeholder

# Rate limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
```

## knexfile.js

Create `server/knexfile.js`:

```javascript
import 'dotenv/config';

/**
 * Knex configuration for Neuron Interceptor backend.
 * Uses PostgreSQL for all environments.
 */
export default {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgres://neuron:neuron_secret@localhost:5432/neuron_interceptor',
    migrations: {
      directory: './migrations',
    },
    seeds: {
      directory: './seeds',
    },
    pool: {
      min: 2,
      max: 10,
    },
  },

  production: {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    },
    migrations: {
      directory: './migrations',
    },
    pool: {
      min: 2,
      max: 20,
    },
  },
};
```

## Database Migrations

### Migration 1: `migrations/20240101000001_create_users.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // Enable uuid-ossp extension for uuid_generate_v4()
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('email', 255).notNullable().unique();
    table.string('password_hash', 255).nullable(); // nullable for OAuth-only users
    table.string('name', 255).notNullable();
    table.string('avatar_url', 1024).nullable();
    table.string('google_id', 255).nullable().unique();
    table.enu('plan', ['free', 'pro', 'team']).notNullable().defaultTo('free');
    table.string('stripe_customer_id', 255).nullable().unique();
    table.string('stripe_subscription_id', 255).nullable();
    table.timestamp('plan_expires_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('users');
}
```

### Migration 2: `migrations/20240101000002_create_workspaces.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('workspaces', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name', 255).notNullable();
    table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('workspaces');
}
```

### Migration 3: `migrations/20240101000003_create_workspace_members.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('workspace_members', (table) => {
    table.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.enu('role', ['owner', 'admin', 'editor', 'viewer']).notNullable().defaultTo('viewer');
    table.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());

    table.primary(['workspace_id', 'user_id']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('workspace_members');
}
```

### Migration 4: `migrations/20240101000004_create_rules.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('priority').notNullable().defaultTo(0);
    table.jsonb('condition').notNullable().defaultTo('{}');
    table.jsonb('action').notNullable().defaultTo('{}');
    table.uuid('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('workspace_id');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('rules');
}
```

### Migration 5: `migrations/20240101000005_create_mock_collections.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('mock_collections', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.boolean('active').notNullable().defaultTo(false);
    table.jsonb('mocks').notNullable().defaultTo('[]');
    table.uuid('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('workspace_id');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('mock_collections');
}
```

### Migration 6: `migrations/20240101000006_create_settings.js`

```javascript
/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('settings', (table) => {
    table.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    table.string('key', 255).notNullable();
    table.jsonb('value').notNullable().defaultTo('{}');

    table.primary(['workspace_id', 'key']);
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('settings');
}
```

## Config Module

### `src/config/index.js`

```javascript
import 'dotenv/config';

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3001,
  host: process.env.HOST || '0.0.0.0',

  database: {
    url: process.env.DATABASE_URL || 'postgres://neuron:neuron_secret@localhost:5432/neuron_interceptor',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },

  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  },
};

export default config;
```

## Application Entry Point

### `src/index.js`

```javascript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import knex from 'knex';
import Redis from 'ioredis';

import config from './config/index.js';
import knexConfig from '../knexfile.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { ruleRoutes } from './routes/rules.js';
import { collectionRoutes } from './routes/collections.js';
import { settingsRoutes } from './routes/settings.js';
import { dataTransferRoutes } from './routes/data-transfer.js';
import { billingRoutes } from './routes/billing.js';
import { wsRoutes } from './routes/ws.js';

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                 */
/* -------------------------------------------------------------------------- */

const app = Fastify({
  logger: {
    level: config.env === 'production' ? 'info' : 'debug',
    transport: config.env !== 'production' ? { target: 'pino-pretty' } : undefined,
  },
});

/* -------------------------------------------------------------------------- */
/*  Database & Redis                                                          */
/* -------------------------------------------------------------------------- */

const db = knex(knexConfig[config.env] || knexConfig.development);
const redis = new Redis(config.redis.url);
const redisSub = new Redis(config.redis.url); // Dedicated subscriber connection

// Decorate Fastify instance so routes can access db and redis
app.decorate('db', db);
app.decorate('redis', redis);
app.decorate('redisSub', redisSub);

// Graceful shutdown
app.addHook('onClose', async () => {
  await db.destroy();
  redis.disconnect();
  redisSub.disconnect();
});

/* -------------------------------------------------------------------------- */
/*  Plugins                                                                   */
/* -------------------------------------------------------------------------- */

await app.register(cors, {
  origin: true, // Allow all origins (extension sends from chrome-extension:// scheme)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
});

await app.register(formbody);

await app.register(jwt, {
  secret: config.jwt.secret,
  sign: { expiresIn: config.jwt.accessExpiresIn },
});

await app.register(websocket, {
  options: { maxPayload: 1048576 }, // 1MB max WebSocket message
});

await app.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
  redis: redis,
});

/* -------------------------------------------------------------------------- */
/*  Health Check                                                              */
/* -------------------------------------------------------------------------- */

app.get('/health', async () => {
  const dbOk = await db.raw('SELECT 1').then(() => true).catch(() => false);
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  return {
    status: dbOk && redisOk ? 'healthy' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    redis: redisOk ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
});

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

await app.register(authRoutes, { prefix: '/auth' });
await app.register(workspaceRoutes, { prefix: '/workspaces' });
await app.register(ruleRoutes, { prefix: '/workspaces' });
await app.register(collectionRoutes, { prefix: '/workspaces' });
await app.register(settingsRoutes, { prefix: '/workspaces' });
await app.register(dataTransferRoutes, { prefix: '/workspaces' });
await app.register(billingRoutes, { prefix: '/billing' });
await app.register(wsRoutes, { prefix: '/ws' });

/* -------------------------------------------------------------------------- */
/*  Start                                                                     */
/* -------------------------------------------------------------------------- */

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Neuron Interceptor API listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

## Models

### `src/models/user.js`

```javascript
/**
 * User model — database queries for the users table.
 */

/**
 * Find a user by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function findById(db, id) {
  return db('users').where({ id }).first();
}

/**
 * Find a user by email (case-insensitive).
 * @param {import('knex').Knex} db
 * @param {string} email
 * @returns {Promise<Object|null>}
 */
export async function findByEmail(db, email) {
  return db('users').whereRaw('LOWER(email) = LOWER(?)', [email]).first();
}

/**
 * Find a user by Google ID.
 * @param {import('knex').Knex} db
 * @param {string} googleId
 * @returns {Promise<Object|null>}
 */
export async function findByGoogleId(db, googleId) {
  return db('users').where({ google_id: googleId }).first();
}

/**
 * Create a new user. Returns the inserted row.
 * @param {import('knex').Knex} db
 * @param {Object} data - { email, password_hash, name, avatar_url?, google_id? }
 * @returns {Promise<Object>}
 */
export async function createUser(db, data) {
  const [user] = await db('users').insert(data).returning('*');
  return user;
}

/**
 * Update a user by ID. Returns the updated row.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateUser(db, id, updates) {
  const [user] = await db('users')
    .where({ id })
    .update({ ...updates, updated_at: db.fn.now() })
    .returning('*');
  return user;
}

/**
 * Return a safe user object (no password_hash).
 * @param {Object} user
 * @returns {Object}
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}
```

### `src/models/workspace.js`

```javascript
/**
 * Workspace model — database queries for workspaces and workspace_members tables.
 */

/**
 * Find a workspace by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function findById(db, id) {
  return db('workspaces').where({ id }).first();
}

/**
 * List all workspaces the user belongs to (with role).
 * @param {import('knex').Knex} db
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function listByUser(db, userId) {
  return db('workspaces')
    .join('workspace_members', 'workspaces.id', 'workspace_members.workspace_id')
    .where('workspace_members.user_id', userId)
    .select('workspaces.*', 'workspace_members.role');
}

/**
 * Create a workspace and add the owner as a member.
 * @param {import('knex').Knex} db
 * @param {Object} data - { name, owner_id }
 * @returns {Promise<Object>} The created workspace
 */
export async function createWorkspace(db, data) {
  return db.transaction(async (trx) => {
    const [workspace] = await trx('workspaces').insert(data).returning('*');

    await trx('workspace_members').insert({
      workspace_id: workspace.id,
      user_id: data.owner_id,
      role: 'owner',
    });

    return workspace;
  });
}

/**
 * Update a workspace by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @param {Object} updates - { name? }
 * @returns {Promise<Object>}
 */
export async function updateWorkspace(db, id, updates) {
  const [workspace] = await db('workspaces')
    .where({ id })
    .update({ ...updates, updated_at: db.fn.now() })
    .returning('*');
  return workspace;
}

/**
 * Delete a workspace by ID. Cascades to members, rules, collections, settings.
 * @param {import('knex').Knex} db
 * @param {string} id
 */
export async function deleteWorkspace(db, id) {
  await db('workspaces').where({ id }).del();
}

/**
 * Get the membership record for a user in a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<Object|null>} { workspace_id, user_id, role, joined_at }
 */
export async function getMembership(db, workspaceId, userId) {
  return db('workspace_members')
    .where({ workspace_id: workspaceId, user_id: userId })
    .first();
}

/**
 * List all members of a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
export async function listMembers(db, workspaceId) {
  return db('workspace_members')
    .join('users', 'workspace_members.user_id', 'users.id')
    .where('workspace_members.workspace_id', workspaceId)
    .select(
      'users.id',
      'users.email',
      'users.name',
      'users.avatar_url',
      'workspace_members.role',
      'workspace_members.joined_at'
    );
}

/**
 * Add a member to a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} role - 'admin' | 'editor' | 'viewer'
 */
export async function addMember(db, workspaceId, userId, role = 'viewer') {
  await db('workspace_members')
    .insert({ workspace_id: workspaceId, user_id: userId, role })
    .onConflict(['workspace_id', 'user_id'])
    .merge({ role });
}

/**
 * Remove a member from a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @param {string} userId
 */
export async function removeMember(db, workspaceId, userId) {
  await db('workspace_members')
    .where({ workspace_id: workspaceId, user_id: userId })
    .del();
}

/**
 * Count workspaces owned by a user.
 * @param {import('knex').Knex} db
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function countOwnedByUser(db, userId) {
  const [{ count }] = await db('workspaces').where({ owner_id: userId }).count('* as count');
  return parseInt(count, 10);
}
```

### `src/models/rule.js`

```javascript
/**
 * Rule model — database queries for the rules table.
 */

/**
 * List all rules in a workspace, ordered by priority descending.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
export async function listByWorkspace(db, workspaceId) {
  return db('rules')
    .where({ workspace_id: workspaceId })
    .orderBy('priority', 'desc')
    .orderBy('created_at', 'asc');
}

/**
 * Find a rule by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function findById(db, id) {
  return db('rules').where({ id }).first();
}

/**
 * Create a new rule. Returns the inserted row.
 * @param {import('knex').Knex} db
 * @param {Object} data - { workspace_id, name, enabled, priority, condition, action, created_by }
 * @returns {Promise<Object>}
 */
export async function createRule(db, data) {
  const [rule] = await db('rules').insert(data).returning('*');
  return rule;
}

/**
 * Update a rule by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateRule(db, id, updates) {
  const [rule] = await db('rules')
    .where({ id })
    .update({ ...updates, updated_at: db.fn.now() })
    .returning('*');
  return rule;
}

/**
 * Delete a rule by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 */
export async function deleteRule(db, id) {
  await db('rules').where({ id }).del();
}

/**
 * Count rules in a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @returns {Promise<number>}
 */
export async function countByWorkspace(db, workspaceId) {
  const [{ count }] = await db('rules').where({ workspace_id: workspaceId }).count('* as count');
  return parseInt(count, 10);
}
```

### `src/models/collection.js`

```javascript
/**
 * Collection model — database queries for the mock_collections table.
 */

/**
 * List all mock collections in a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
export async function listByWorkspace(db, workspaceId) {
  return db('mock_collections')
    .where({ workspace_id: workspaceId })
    .orderBy('created_at', 'asc');
}

/**
 * Find a mock collection by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function findById(db, id) {
  return db('mock_collections').where({ id }).first();
}

/**
 * Create a mock collection. Returns the inserted row.
 * @param {import('knex').Knex} db
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function createCollection(db, data) {
  const [col] = await db('mock_collections').insert(data).returning('*');
  return col;
}

/**
 * Update a mock collection by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateCollection(db, id, updates) {
  const [col] = await db('mock_collections')
    .where({ id })
    .update({ ...updates, updated_at: db.fn.now() })
    .returning('*');
  return col;
}

/**
 * Delete a mock collection by ID.
 * @param {import('knex').Knex} db
 * @param {string} id
 */
export async function deleteCollection(db, id) {
  await db('mock_collections').where({ id }).del();
}
```

### `src/models/setting.js`

```javascript
/**
 * Setting model — database queries for the settings table.
 */

/**
 * Get all settings for a workspace.
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @returns {Promise<Object>} key-value object
 */
export async function getAll(db, workspaceId) {
  const rows = await db('settings').where({ workspace_id: workspaceId });
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Set a single setting for a workspace (upsert).
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @param {string} key
 * @param {*} value - JSON-serialisable value
 */
export async function set(db, workspaceId, key, value) {
  await db('settings')
    .insert({ workspace_id: workspaceId, key, value: JSON.stringify(value) })
    .onConflict(['workspace_id', 'key'])
    .merge({ value: JSON.stringify(value) });
}

/**
 * Set multiple settings at once (upsert each).
 * @param {import('knex').Knex} db
 * @param {string} workspaceId
 * @param {Object} settingsObj - { key: value, ... }
 */
export async function setMany(db, workspaceId, settingsObj) {
  await db.transaction(async (trx) => {
    for (const [key, value] of Object.entries(settingsObj)) {
      await trx('settings')
        .insert({ workspace_id: workspaceId, key, value: JSON.stringify(value) })
        .onConflict(['workspace_id', 'key'])
        .merge({ value: JSON.stringify(value) });
    }
  });
}
```

## Middleware

### `src/middleware/auth-middleware.js`

```javascript
/**
 * Auth middleware — verifies JWT bearer tokens on protected routes.
 *
 * Usage in route:
 *   fastify.addHook('onRequest', authenticate);
 */

/**
 * Fastify onRequest hook that verifies the JWT in the Authorization header.
 * On success, decorates request with `request.user = { id, email, name }`.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function authenticate(request, reply) {
  try {
    const decoded = await request.jwtVerify();
    request.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
    };
  } catch (err) {
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired access token',
    });
  }
}
```

### `src/middleware/rbac-middleware.js`

```javascript
/**
 * RBAC middleware — checks that the authenticated user has the required role
 * within the target workspace.
 *
 * The workspace ID is read from `request.params.id` (the :id in the route path).
 * The user must already be authenticated (request.user set by auth-middleware).
 */

import * as WorkspaceModel from '../models/workspace.js';

/**
 * Role hierarchy: owner > admin > editor > viewer.
 * Higher index = more permissions.
 */
const ROLE_HIERARCHY = ['viewer', 'editor', 'admin', 'owner'];

/**
 * Create a Fastify onRequest hook that enforces a minimum role.
 *
 * @param {string} minRole - Minimum required role ('viewer' | 'editor' | 'admin' | 'owner')
 * @returns {Function} Fastify hook
 */
export function requireRole(minRole) {
  const minLevel = ROLE_HIERARCHY.indexOf(minRole);

  return async function (request, reply) {
    const workspaceId = request.params.id;
    const userId = request.user?.id;

    if (!workspaceId || !userId) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Workspace ID and authenticated user are required',
      });
    }

    const membership = await WorkspaceModel.getMembership(
      request.server.db,
      workspaceId,
      userId
    );

    if (!membership) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'You are not a member of this workspace',
      });
    }

    const userLevel = ROLE_HIERARCHY.indexOf(membership.role);
    if (userLevel < minLevel) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `This action requires at least "${minRole}" role. Your role: "${membership.role}"`,
      });
    }

    // Attach membership info to request for downstream handlers
    request.workspace = { id: workspaceId, role: membership.role };
  };
}
```

### `src/middleware/rate-limit-middleware.js`

```javascript
/**
 * Rate limit middleware — additional per-route rate limiting beyond the global limit.
 * Uses Redis for distributed counting.
 *
 * The global rate limit is already registered via @fastify/rate-limit in src/index.js.
 * This module provides helper functions for applying stricter limits to specific
 * routes (e.g., auth endpoints).
 */

/**
 * Create a Fastify preHandler hook that enforces a per-IP rate limit.
 *
 * @param {Object} opts
 * @param {number} opts.max - Maximum requests allowed in the window
 * @param {number} opts.windowSec - Window duration in seconds
 * @param {string} opts.prefix - Redis key prefix (e.g., 'rl:auth')
 * @returns {Function} Fastify preHandler hook
 */
export function perRouteRateLimit({ max, windowSec, prefix }) {
  return async function (request, reply) {
    const redis = request.server.redis;
    const ip = request.ip;
    const key = `${prefix}:${ip}`;

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    reply.header('X-RateLimit-Limit', max);
    reply.header('X-RateLimit-Remaining', Math.max(0, max - current));

    if (current > max) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${windowSec} seconds.`,
      });
    }
  };
}
```

### `src/middleware/plan-middleware.js`

```javascript
/**
 * Plan middleware — enforces plan limits before allowing resource creation.
 * Stub for now; will be fully implemented in the Stripe Billing spec (17-stripe-billing.md).
 */

import * as UserModel from '../models/user.js';
import * as RuleModel from '../models/rule.js';
import * as WorkspaceModel from '../models/workspace.js';

/**
 * Plan limits configuration.
 */
const PLAN_LIMITS = {
  free: { maxRules: 5, maxWorkspaces: 1, syncEnabled: false },
  pro: { maxRules: Infinity, maxWorkspaces: 3, syncEnabled: true },
  team: { maxRules: Infinity, maxWorkspaces: Infinity, syncEnabled: true },
};

/**
 * Enforce maximum rules per workspace based on the workspace owner's plan.
 * Attach as a preHandler hook on POST routes that create rules.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function enforceRuleLimit(request, reply) {
  const workspaceId = request.params.id;
  const db = request.server.db;

  // Find workspace owner
  const workspace = await WorkspaceModel.findById(db, workspaceId);
  if (!workspace) {
    return reply.code(404).send({ error: 'Workspace not found' });
  }

  const owner = await UserModel.findById(db, workspace.owner_id);
  if (!owner) {
    return reply.code(500).send({ error: 'Workspace owner not found' });
  }

  const limits = PLAN_LIMITS[owner.plan] || PLAN_LIMITS.free;
  const currentCount = await RuleModel.countByWorkspace(db, workspaceId);

  if (currentCount >= limits.maxRules) {
    return reply.code(403).send({
      error: 'Plan Limit Reached',
      message: `Your "${owner.plan}" plan allows a maximum of ${limits.maxRules} rules per workspace. Upgrade to add more.`,
      plan: owner.plan,
      limit: limits.maxRules,
      current: currentCount,
    });
  }
}

/**
 * Enforce maximum workspaces per user.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function enforceWorkspaceLimit(request, reply) {
  const db = request.server.db;
  const userId = request.user.id;

  const user = await UserModel.findById(db, userId);
  if (!user) {
    return reply.code(401).send({ error: 'User not found' });
  }

  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
  const currentCount = await WorkspaceModel.countOwnedByUser(db, userId);

  if (currentCount >= limits.maxWorkspaces) {
    return reply.code(403).send({
      error: 'Plan Limit Reached',
      message: `Your "${user.plan}" plan allows a maximum of ${limits.maxWorkspaces} workspaces. Upgrade to create more.`,
      plan: user.plan,
      limit: limits.maxWorkspaces,
      current: currentCount,
    });
  }
}
```

## Routes

### `src/routes/auth.js`

```javascript
/**
 * Auth routes — registration, login, token refresh, current user.
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { perRouteRateLimit } from '../middleware/rate-limit-middleware.js';
import * as AuthService from '../services/auth-service.js';
import * as UserModel from '../models/user.js';
import * as WorkspaceModel from '../models/workspace.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function authRoutes(fastify) {
  const authRateLimit = perRouteRateLimit({ max: 10, windowSec: 60, prefix: 'rl:auth' });

  /* ---- POST /auth/register ---- */
  fastify.post('/register', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string', minLength: 1, maxLength: 255 },
        },
      },
    },
    handler: async (request, reply) => {
      const { email, password, name } = request.body;
      const db = fastify.db;

      // Check if user already exists
      const existing = await UserModel.findByEmail(db, email);
      if (existing) {
        return reply.code(409).send({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await AuthService.hashPassword(password);

      // Create user
      const user = await UserModel.createUser(db, {
        email: email.toLowerCase().trim(),
        password_hash: passwordHash,
        name: name.trim(),
      });

      // Create default "Personal" workspace
      await WorkspaceModel.createWorkspace(db, {
        name: 'Personal',
        owner_id: user.id,
      });

      // Generate tokens
      const accessToken = AuthService.generateAccessToken(fastify, user);
      const refreshToken = await AuthService.generateRefreshToken(fastify.redis, user);

      return reply.code(201).send({
        user: UserModel.sanitizeUser(user),
        accessToken,
        refreshToken,
      });
    },
  });

  /* ---- POST /auth/login ---- */
  fastify.post('/login', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body;
      const db = fastify.db;

      const user = await UserModel.findByEmail(db, email);
      if (!user || !user.password_hash) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const valid = await AuthService.comparePassword(password, user.password_hash);
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const accessToken = AuthService.generateAccessToken(fastify, user);
      const refreshToken = await AuthService.generateRefreshToken(fastify.redis, user);

      return {
        user: UserModel.sanitizeUser(user),
        accessToken,
        refreshToken,
      };
    },
  });

  /* ---- POST /auth/refresh ---- */
  fastify.post('/refresh', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { refreshToken } = request.body;
      const db = fastify.db;

      // Validate refresh token via Redis
      const userId = await AuthService.validateRefreshToken(fastify.redis, refreshToken);
      if (!userId) {
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      const user = await UserModel.findById(db, userId);
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      // Rotate: invalidate old refresh token, issue new pair
      await AuthService.revokeRefreshToken(fastify.redis, refreshToken);
      const newAccessToken = AuthService.generateAccessToken(fastify, user);
      const newRefreshToken = await AuthService.generateRefreshToken(fastify.redis, user);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    },
  });

  /* ---- GET /auth/me ---- */
  fastify.get('/me', {
    onRequest: [authenticate],
    handler: async (request) => {
      const user = await UserModel.findById(fastify.db, request.user.id);
      if (!user) {
        return { error: 'User not found' };
      }

      // Include workspaces
      const workspaces = await WorkspaceModel.listByUser(fastify.db, user.id);

      return {
        user: UserModel.sanitizeUser(user),
        workspaces,
      };
    },
  });

  /* ---- POST /auth/logout ---- */
  fastify.post('/logout', {
    onRequest: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' },
        },
      },
    },
    handler: async (request) => {
      await AuthService.revokeRefreshToken(fastify.redis, request.body.refreshToken);
      return { ok: true };
    },
  });
}
```

### `src/routes/workspaces.js`

```javascript
/**
 * Workspace routes — CRUD + invite.
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { requireRole } from '../middleware/rbac-middleware.js';
import { enforceWorkspaceLimit } from '../middleware/plan-middleware.js';
import * as WorkspaceModel from '../models/workspace.js';
import * as UserModel from '../models/user.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function workspaceRoutes(fastify) {
  // All workspace routes require authentication
  fastify.addHook('onRequest', authenticate);

  /* ---- GET /workspaces ---- */
  fastify.get('/', async (request) => {
    const workspaces = await WorkspaceModel.listByUser(fastify.db, request.user.id);
    return { workspaces };
  });

  /* ---- POST /workspaces ---- */
  fastify.post('/', {
    preHandler: [enforceWorkspaceLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
        },
      },
    },
    handler: async (request, reply) => {
      const workspace = await WorkspaceModel.createWorkspace(fastify.db, {
        name: request.body.name.trim(),
        owner_id: request.user.id,
      });
      return reply.code(201).send({ workspace });
    },
  });

  /* ---- GET /workspaces/:id ---- */
  fastify.get('/:id', {
    onRequest: [authenticate],
    preHandler: [requireRole('viewer')],
    handler: async (request) => {
      const workspace = await WorkspaceModel.findById(fastify.db, request.params.id);
      if (!workspace) {
        return { error: 'Workspace not found' };
      }
      const members = await WorkspaceModel.listMembers(fastify.db, workspace.id);
      return { workspace, members };
    },
  });

  /* ---- PUT /workspaces/:id ---- */
  fastify.put('/:id', {
    preHandler: [requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
        },
      },
    },
    handler: async (request) => {
      const workspace = await WorkspaceModel.updateWorkspace(
        fastify.db,
        request.params.id,
        { name: request.body.name?.trim() }
      );
      return { workspace };
    },
  });

  /* ---- DELETE /workspaces/:id ---- */
  fastify.delete('/:id', {
    preHandler: [requireRole('owner')],
    handler: async (request) => {
      await WorkspaceModel.deleteWorkspace(fastify.db, request.params.id);
      return { ok: true };
    },
  });

  /* ---- POST /workspaces/:id/invite ---- */
  fastify.post('/:id/invite', {
    preHandler: [requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'role'],
        properties: {
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
        },
      },
    },
    handler: async (request, reply) => {
      const { email, role } = request.body;
      const db = fastify.db;

      // Find the user by email
      const invitee = await UserModel.findByEmail(db, email);
      if (!invitee) {
        return reply.code(404).send({
          error: 'User not found',
          message: 'No account found with that email. They must register first.',
        });
      }

      // Check if already a member
      const existing = await WorkspaceModel.getMembership(db, request.params.id, invitee.id);
      if (existing) {
        return reply.code(409).send({
          error: 'Already a member',
          message: `User is already a ${existing.role} of this workspace`,
        });
      }

      await WorkspaceModel.addMember(db, request.params.id, invitee.id, role);

      return reply.code(201).send({
        ok: true,
        member: { id: invitee.id, email: invitee.email, name: invitee.name, role },
      });
    },
  });

  /* ---- DELETE /workspaces/:id/members/:userId ---- */
  fastify.delete('/:id/members/:userId', {
    preHandler: [requireRole('admin')],
    handler: async (request, reply) => {
      const { id: workspaceId, userId } = request.params;

      // Cannot remove the owner
      const workspace = await WorkspaceModel.findById(fastify.db, workspaceId);
      if (workspace.owner_id === userId) {
        return reply.code(400).send({
          error: 'Cannot remove owner',
          message: 'Transfer ownership before removing the owner from the workspace',
        });
      }

      await WorkspaceModel.removeMember(fastify.db, workspaceId, userId);
      return { ok: true };
    },
  });
}
```

### `src/routes/rules.js`

```javascript
/**
 * Rule routes — CRUD for rules within a workspace.
 * Mounted at /workspaces so paths are /workspaces/:id/rules/...
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { requireRole } from '../middleware/rbac-middleware.js';
import { enforceRuleLimit } from '../middleware/plan-middleware.js';
import * as RuleModel from '../models/rule.js';
import * as SyncService from '../services/sync-service.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function ruleRoutes(fastify) {
  fastify.addHook('onRequest', authenticate);

  /* ---- GET /workspaces/:id/rules ---- */
  fastify.get('/:id/rules', {
    preHandler: [requireRole('viewer')],
    handler: async (request) => {
      const rules = await RuleModel.listByWorkspace(fastify.db, request.params.id);
      return { rules };
    },
  });

  /* ---- POST /workspaces/:id/rules ---- */
  fastify.post('/:id/rules', {
    preHandler: [requireRole('editor'), enforceRuleLimit],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'condition', 'action'],
        properties: {
          name: { type: 'string', minLength: 1 },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          condition: { type: 'object' },
          action: { type: 'object' },
        },
      },
    },
    handler: async (request, reply) => {
      const rule = await RuleModel.createRule(fastify.db, {
        workspace_id: request.params.id,
        name: request.body.name,
        enabled: request.body.enabled ?? true,
        priority: request.body.priority ?? 0,
        condition: request.body.condition,
        action: request.body.action,
        created_by: request.user.id,
      });

      // Publish change for real-time sync
      await SyncService.publishChange(fastify.redis, request.params.id, 'RULES_UPDATED', rule);

      return reply.code(201).send({ rule });
    },
  });

  /* ---- PUT /workspaces/:id/rules/:ruleId ---- */
  fastify.put('/:id/rules/:ruleId', {
    preHandler: [requireRole('editor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          condition: { type: 'object' },
          action: { type: 'object' },
        },
      },
    },
    handler: async (request, reply) => {
      const existing = await RuleModel.findById(fastify.db, request.params.ruleId);
      if (!existing || existing.workspace_id !== request.params.id) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      // Editors can only edit their own rules; admins/owners can edit any
      if (
        request.workspace.role === 'editor' &&
        existing.created_by !== request.user.id
      ) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Editors can only edit rules they created',
        });
      }

      const updates = {};
      if (request.body.name !== undefined) updates.name = request.body.name;
      if (request.body.enabled !== undefined) updates.enabled = request.body.enabled;
      if (request.body.priority !== undefined) updates.priority = request.body.priority;
      if (request.body.condition !== undefined) updates.condition = request.body.condition;
      if (request.body.action !== undefined) updates.action = request.body.action;

      const rule = await RuleModel.updateRule(fastify.db, request.params.ruleId, updates);

      await SyncService.publishChange(fastify.redis, request.params.id, 'RULES_UPDATED', rule);

      return { rule };
    },
  });

  /* ---- DELETE /workspaces/:id/rules/:ruleId ---- */
  fastify.delete('/:id/rules/:ruleId', {
    preHandler: [requireRole('admin')],
    handler: async (request, reply) => {
      const existing = await RuleModel.findById(fastify.db, request.params.ruleId);
      if (!existing || existing.workspace_id !== request.params.id) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      await RuleModel.deleteRule(fastify.db, request.params.ruleId);

      await SyncService.publishChange(fastify.redis, request.params.id, 'RULES_UPDATED', {
        deleted: true,
        id: request.params.ruleId,
      });

      return { ok: true };
    },
  });
}
```

### `src/routes/collections.js`

```javascript
/**
 * Collection routes — CRUD for mock collections within a workspace.
 * Mounted at /workspaces so paths are /workspaces/:id/collections/...
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { requireRole } from '../middleware/rbac-middleware.js';
import * as CollectionModel from '../models/collection.js';
import * as SyncService from '../services/sync-service.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function collectionRoutes(fastify) {
  fastify.addHook('onRequest', authenticate);

  /* ---- GET /workspaces/:id/collections ---- */
  fastify.get('/:id/collections', {
    preHandler: [requireRole('viewer')],
    handler: async (request) => {
      const collections = await CollectionModel.listByWorkspace(fastify.db, request.params.id);
      return { collections };
    },
  });

  /* ---- POST /workspaces/:id/collections ---- */
  fastify.post('/:id/collections', {
    preHandler: [requireRole('editor')],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          active: { type: 'boolean' },
          mocks: { type: 'array' },
        },
      },
    },
    handler: async (request, reply) => {
      const collection = await CollectionModel.createCollection(fastify.db, {
        workspace_id: request.params.id,
        name: request.body.name,
        active: request.body.active ?? false,
        mocks: JSON.stringify(request.body.mocks || []),
        created_by: request.user.id,
      });

      await SyncService.publishChange(fastify.redis, request.params.id, 'COLLECTION_UPDATED', collection);

      return reply.code(201).send({ collection });
    },
  });

  /* ---- PUT /workspaces/:id/collections/:colId ---- */
  fastify.put('/:id/collections/:colId', {
    preHandler: [requireRole('editor')],
    handler: async (request, reply) => {
      const existing = await CollectionModel.findById(fastify.db, request.params.colId);
      if (!existing || existing.workspace_id !== request.params.id) {
        return reply.code(404).send({ error: 'Collection not found' });
      }

      const updates = {};
      if (request.body.name !== undefined) updates.name = request.body.name;
      if (request.body.active !== undefined) updates.active = request.body.active;
      if (request.body.mocks !== undefined) updates.mocks = JSON.stringify(request.body.mocks);

      const collection = await CollectionModel.updateCollection(fastify.db, request.params.colId, updates);

      await SyncService.publishChange(fastify.redis, request.params.id, 'COLLECTION_UPDATED', collection);

      return { collection };
    },
  });

  /* ---- DELETE /workspaces/:id/collections/:colId ---- */
  fastify.delete('/:id/collections/:colId', {
    preHandler: [requireRole('admin')],
    handler: async (request, reply) => {
      const existing = await CollectionModel.findById(fastify.db, request.params.colId);
      if (!existing || existing.workspace_id !== request.params.id) {
        return reply.code(404).send({ error: 'Collection not found' });
      }

      await CollectionModel.deleteCollection(fastify.db, request.params.colId);

      await SyncService.publishChange(fastify.redis, request.params.id, 'COLLECTION_UPDATED', {
        deleted: true,
        id: request.params.colId,
      });

      return { ok: true };
    },
  });
}
```

### `src/routes/settings.js`

```javascript
/**
 * Settings routes — GET/PUT workspace settings.
 * Mounted at /workspaces so paths are /workspaces/:id/settings
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { requireRole } from '../middleware/rbac-middleware.js';
import * as SettingModel from '../models/setting.js';
import * as SyncService from '../services/sync-service.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function settingsRoutes(fastify) {
  fastify.addHook('onRequest', authenticate);

  /* ---- GET /workspaces/:id/settings ---- */
  fastify.get('/:id/settings', {
    preHandler: [requireRole('viewer')],
    handler: async (request) => {
      const settings = await SettingModel.getAll(fastify.db, request.params.id);
      return { settings };
    },
  });

  /* ---- PUT /workspaces/:id/settings ---- */
  fastify.put('/:id/settings', {
    preHandler: [requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        additionalProperties: true,
      },
    },
    handler: async (request) => {
      await SettingModel.setMany(fastify.db, request.params.id, request.body);

      await SyncService.publishChange(fastify.redis, request.params.id, 'SETTINGS_UPDATED', request.body);

      const settings = await SettingModel.getAll(fastify.db, request.params.id);
      return { settings };
    },
  });
}
```

### `src/routes/data-transfer.js`

```javascript
/**
 * Data transfer routes — export and import workspace data.
 * Mounted at /workspaces so paths are /workspaces/:id/export, /workspaces/:id/import
 */

import { authenticate } from '../middleware/auth-middleware.js';
import { requireRole } from '../middleware/rbac-middleware.js';
import * as RuleModel from '../models/rule.js';
import * as CollectionModel from '../models/collection.js';
import * as SettingModel from '../models/setting.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function dataTransferRoutes(fastify) {
  fastify.addHook('onRequest', authenticate);

  /* ---- POST /workspaces/:id/export ---- */
  fastify.post('/:id/export', {
    preHandler: [requireRole('viewer')],
    handler: async (request) => {
      const db = fastify.db;
      const workspaceId = request.params.id;

      const [rules, collections, settings] = await Promise.all([
        RuleModel.listByWorkspace(db, workspaceId),
        CollectionModel.listByWorkspace(db, workspaceId),
        SettingModel.getAll(db, workspaceId),
      ]);

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        workspaceId,
        rules,
        collections,
        settings,
      };
    },
  });

  /* ---- POST /workspaces/:id/import ---- */
  fastify.post('/:id/import', {
    preHandler: [requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          rules: { type: 'array' },
          collections: { type: 'array' },
          settings: { type: 'object' },
          replaceExisting: { type: 'boolean' },
        },
      },
    },
    handler: async (request, reply) => {
      const db = fastify.db;
      const workspaceId = request.params.id;
      const { rules, collections, settings, replaceExisting } = request.body;
      const imported = { rules: 0, collections: 0, settings: 0 };

      await db.transaction(async (trx) => {
        // Import rules
        if (Array.isArray(rules) && rules.length > 0) {
          if (replaceExisting) {
            await trx('rules').where({ workspace_id: workspaceId }).del();
          }
          for (const rule of rules) {
            await trx('rules').insert({
              workspace_id: workspaceId,
              name: rule.name,
              enabled: rule.enabled ?? true,
              priority: rule.priority ?? 0,
              condition: JSON.stringify(rule.condition || {}),
              action: JSON.stringify(rule.action || {}),
              created_by: request.user.id,
            });
            imported.rules++;
          }
        }

        // Import collections
        if (Array.isArray(collections) && collections.length > 0) {
          if (replaceExisting) {
            await trx('mock_collections').where({ workspace_id: workspaceId }).del();
          }
          for (const col of collections) {
            await trx('mock_collections').insert({
              workspace_id: workspaceId,
              name: col.name,
              active: col.active ?? false,
              mocks: JSON.stringify(col.mocks || []),
              created_by: request.user.id,
            });
            imported.collections++;
          }
        }

        // Import settings
        if (settings && typeof settings === 'object') {
          for (const [key, value] of Object.entries(settings)) {
            await trx('settings')
              .insert({ workspace_id: workspaceId, key, value: JSON.stringify(value) })
              .onConflict(['workspace_id', 'key'])
              .merge({ value: JSON.stringify(value) });
            imported.settings++;
          }
        }
      });

      return reply.code(200).send({ ok: true, imported });
    },
  });
}
```

### `src/routes/billing.js`

```javascript
/**
 * Billing routes — stub for Stripe integration.
 * Full implementation in spec 17-stripe-billing.md.
 */

import { authenticate } from '../middleware/auth-middleware.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function billingRoutes(fastify) {
  /* ---- POST /billing/create-checkout-session ---- */
  fastify.post('/create-checkout-session', {
    onRequest: [authenticate],
    handler: async (request, reply) => {
      return reply.code(501).send({
        error: 'Not Implemented',
        message: 'Billing is not yet configured. See spec 17-stripe-billing.md.',
      });
    },
  });

  /* ---- POST /billing/customer-portal ---- */
  fastify.post('/customer-portal', {
    onRequest: [authenticate],
    handler: async (request, reply) => {
      return reply.code(501).send({
        error: 'Not Implemented',
        message: 'Billing is not yet configured.',
      });
    },
  });

  /* ---- POST /billing/webhook ---- */
  fastify.post('/webhook', {
    handler: async (request, reply) => {
      return reply.code(501).send({
        error: 'Not Implemented',
        message: 'Stripe webhooks not yet configured.',
      });
    },
  });
}
```

### `src/routes/ws.js`

```javascript
/**
 * WebSocket route — real-time sync for workspace changes.
 * Clients connect to /ws with a JWT token as query parameter.
 */

import * as AuthService from '../services/auth-service.js';
import * as WorkspaceModel from '../models/workspace.js';

/** Map<workspaceId, Set<WebSocket>> */
const workspaceConnections = new Map();

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function wsRoutes(fastify) {
  fastify.get('/', { websocket: true }, async (socket, request) => {
    const token = request.query.token;

    // Authenticate via JWT
    let user;
    try {
      const decoded = fastify.jwt.verify(token);
      user = { id: decoded.sub, email: decoded.email };
    } catch {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Authentication failed' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    // Get user's workspaces
    const workspaces = await WorkspaceModel.listByUser(fastify.db, user.id);
    const workspaceIds = workspaces.map((w) => w.id);

    // Subscribe this socket to all user's workspaces
    for (const wsId of workspaceIds) {
      if (!workspaceConnections.has(wsId)) {
        workspaceConnections.set(wsId, new Set());
      }
      workspaceConnections.get(wsId).add(socket);
    }

    // Subscribe to Redis pub/sub channels for each workspace
    for (const wsId of workspaceIds) {
      const channel = `workspace:${wsId}:changes`;
      fastify.redisSub.subscribe(channel);
    }

    // Send welcome message
    socket.send(JSON.stringify({
      type: 'CONNECTED',
      userId: user.id,
      workspaces: workspaceIds,
    }));

    // Handle incoming messages from client (e.g., ping)
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Cleanup on disconnect
    socket.on('close', () => {
      for (const wsId of workspaceIds) {
        const connections = workspaceConnections.get(wsId);
        if (connections) {
          connections.delete(socket);
          if (connections.size === 0) {
            workspaceConnections.delete(wsId);
            fastify.redisSub.unsubscribe(`workspace:${wsId}:changes`);
          }
        }
      }
    });
  });

  // Redis message handler — forward published messages to connected WebSocket clients
  fastify.redisSub.on('message', (channel, message) => {
    // channel format: workspace:<id>:changes
    const match = channel.match(/^workspace:(.+):changes$/);
    if (!match) return;

    const workspaceId = match[1];
    const connections = workspaceConnections.get(workspaceId);
    if (!connections || connections.size === 0) return;

    for (const socket of connections) {
      if (socket.readyState === 1) { // WebSocket.OPEN
        socket.send(message);
      }
    }
  });
}
```

## Services

### `src/services/auth-service.js`

```javascript
/**
 * Auth service — password hashing, JWT generation, refresh token management.
 */

import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';

const SALT_ROUNDS = 12;
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Hash a plaintext password using bcrypt.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a short-lived JWT access token.
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} user - { id, email, name }
 * @returns {string}
 */
export function generateAccessToken(fastify, user) {
  return fastify.jwt.sign({
    sub: user.id,
    email: user.email,
    name: user.name,
  });
}

/**
 * Generate a long-lived refresh token stored in Redis.
 * @param {import('ioredis').Redis} redis
 * @param {Object} user - { id }
 * @returns {Promise<string>} The refresh token string
 */
export async function generateRefreshToken(redis, user) {
  const token = uuidv4();
  const key = `refresh_token:${token}`;
  await redis.set(key, user.id, 'EX', REFRESH_TOKEN_TTL);
  return token;
}

/**
 * Validate a refresh token. Returns the userId if valid, null otherwise.
 * @param {import('ioredis').Redis} redis
 * @param {string} token
 * @returns {Promise<string|null>}
 */
export async function validateRefreshToken(redis, token) {
  const key = `refresh_token:${token}`;
  return redis.get(key);
}

/**
 * Revoke (delete) a refresh token.
 * @param {import('ioredis').Redis} redis
 * @param {string} token
 */
export async function revokeRefreshToken(redis, token) {
  const key = `refresh_token:${token}`;
  await redis.del(key);
}
```

### `src/services/sync-service.js`

```javascript
/**
 * Sync service — publishes workspace changes to Redis pub/sub
 * so that connected WebSocket clients receive real-time updates.
 */

/**
 * Publish a change event to a workspace's Redis channel.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} workspaceId
 * @param {string} type - 'RULES_UPDATED' | 'COLLECTION_UPDATED' | 'SETTINGS_UPDATED'
 * @param {Object} data - The changed data
 */
export async function publishChange(redis, workspaceId, type, data) {
  const channel = `workspace:${workspaceId}:changes`;
  const message = JSON.stringify({
    type,
    workspaceId,
    data,
    timestamp: Date.now(),
  });

  await redis.publish(channel, message);
}
```

### `src/services/billing-service.js`

```javascript
/**
 * Billing service — Stripe API wrapper.
 * Stub for now; full implementation in spec 17-stripe-billing.md.
 */

import config from '../config/index.js';

/**
 * Check if Stripe is configured.
 * @returns {boolean}
 */
export function isConfigured() {
  return (
    config.stripe.secretKey &&
    config.stripe.secretKey !== 'sk_test_placeholder'
  );
}

// Placeholder exports for the billing spec to implement
export async function createCheckoutSession() {
  throw new Error('Billing not yet configured');
}

export async function createCustomerPortalSession() {
  throw new Error('Billing not yet configured');
}

export async function handleWebhookEvent() {
  throw new Error('Billing not yet configured');
}
```

## API Reference Summary

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| POST | /auth/register | No | - | Create account |
| POST | /auth/login | No | - | Login, get JWT pair |
| POST | /auth/refresh | No | - | Refresh JWT pair |
| GET | /auth/me | Yes | - | Current user + workspaces |
| POST | /auth/logout | Yes | - | Revoke refresh token |
| GET | /workspaces | Yes | - | List user's workspaces |
| POST | /workspaces | Yes | - | Create workspace |
| GET | /workspaces/:id | Yes | viewer | Workspace details + members |
| PUT | /workspaces/:id | Yes | admin | Update workspace |
| DELETE | /workspaces/:id | Yes | owner | Delete workspace |
| POST | /workspaces/:id/invite | Yes | admin | Invite member |
| DELETE | /workspaces/:id/members/:userId | Yes | admin | Remove member |
| GET | /workspaces/:id/rules | Yes | viewer | List rules |
| POST | /workspaces/:id/rules | Yes | editor | Create rule |
| PUT | /workspaces/:id/rules/:ruleId | Yes | editor | Update rule |
| DELETE | /workspaces/:id/rules/:ruleId | Yes | admin | Delete rule |
| GET | /workspaces/:id/collections | Yes | viewer | List collections |
| POST | /workspaces/:id/collections | Yes | editor | Create collection |
| PUT | /workspaces/:id/collections/:colId | Yes | editor | Update collection |
| DELETE | /workspaces/:id/collections/:colId | Yes | admin | Delete collection |
| GET | /workspaces/:id/settings | Yes | viewer | Get settings |
| PUT | /workspaces/:id/settings | Yes | admin | Update settings |
| POST | /workspaces/:id/export | Yes | viewer | Export workspace data |
| POST | /workspaces/:id/import | Yes | admin | Import workspace data |
| POST | /billing/create-checkout-session | Yes | - | Stripe checkout (stub) |
| POST | /billing/customer-portal | Yes | - | Stripe portal (stub) |
| POST | /billing/webhook | No | - | Stripe webhook (stub) |
| GET | /ws?token=JWT | WS | - | Real-time sync WebSocket |
| GET | /health | No | - | Health check |

## Verification

1. **Start infrastructure**: `cd server && docker compose up -d postgres redis`
2. **Install dependencies**: `npm install`
3. **Copy env**: `cp .env.example .env`
4. **Run migrations**: `npm run migrate`
5. **Start dev server**: `npm run dev`
6. **Health check**: `curl http://localhost:3001/health` -- expect `{"status":"healthy", ...}`
7. **Register**: `curl -X POST http://localhost:3001/auth/register -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123","name":"Test User"}'` -- expect 201 with user + tokens
8. **Login**: `curl -X POST http://localhost:3001/auth/login -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123"}'` -- expect 200 with tokens
9. **Get me**: `curl http://localhost:3001/auth/me -H "Authorization: Bearer <accessToken>"` -- expect user + "Personal" workspace
10. **List workspaces**: `curl http://localhost:3001/workspaces -H "Authorization: Bearer <accessToken>"` -- expect array with "Personal"
11. **Create rule**: `curl -X POST http://localhost:3001/workspaces/<workspaceId>/rules -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{"name":"Test Rule","condition":{"url":{"type":"contains","value":"/api/"}},"action":{"type":"redirect"}}'` -- expect 201
12. **List rules**: `curl http://localhost:3001/workspaces/<workspaceId>/rules -H "Authorization: Bearer <accessToken>"` -- expect array with the created rule
13. **WebSocket**: Open a WebSocket connection to `ws://localhost:3001/ws?token=<accessToken>` -- expect `{"type":"CONNECTED",...}` message
14. **Stop**: `docker compose down`
