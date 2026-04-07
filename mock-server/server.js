/**
 * Mocxy Mock Server
 * WireMock-level standalone HTTP mock server.
 *
 * Usage:
 *   npm install && npm start
 *   PORT=3000 npm start
 *
 * Admin API: http://localhost:5000/mocxy/admin
 * Health:    http://localhost:5000/mocxy/admin/health
 */

import express from 'express';
import cors from 'cors';
import {
  load, getAll, getById, create, update, remove, removeAll, importAll,
} from './store.js';
import { findMatch } from './matcher.js';

const app     = express();
const PORT    = parseInt(process.env.PORT || '5000', 10);
const VERSION = '1.0.0';
const START   = Date.now();

/* -------------------------------------------------------------------------- */
/*  Middleware                                                                */
/* -------------------------------------------------------------------------- */

// Wide-open CORS — extension runs from chrome-extension:// origin
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: '*',
  exposedHeaders: ['X-Mocxy-Matched', 'X-Mocxy-Mock-Id', 'X-Mocxy-Mock-Name'],
}));

// Raw body capture for matching, with JSON parse attempt
app.use((req, res, next) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk.toString(); });
  req.on('end', () => {
    req._rawBody = raw;
    if (raw) {
      try { req.body = JSON.parse(raw); }
      catch (_) { req.body = raw; }
    } else {
      req.body = {};
    }
    next();
  });
});

/* -------------------------------------------------------------------------- */
/*  Admin API  — /mocxy/admin/*                                               */
/* -------------------------------------------------------------------------- */

const admin = express.Router();

// ── Health ─────────────────────────────────────────────────────────────────

admin.get('/health', (_req, res) => {
  const mocks = getAll();
  res.json({
    status:  'up',
    version: VERSION,
    mocks:   mocks.length,
    enabled: mocks.filter((m) => m.enabled !== false).length,
    uptime:  Math.floor((Date.now() - START) / 1000),
  });
});

// ── List mocks ──────────────────────────────────────────────────────────────

admin.get('/mocks', (req, res) => {
  let mocks = getAll();

  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    mocks = mocks.filter((m) =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.request?.url || '').toLowerCase().includes(q)
    );
  }
  if (req.query.method) {
    const method = req.query.method.toUpperCase();
    mocks = mocks.filter((m) => (m.request?.method || 'ANY') === method);
  }
  if (req.query.enabled !== undefined) {
    const enabled = req.query.enabled !== 'false';
    mocks = mocks.filter((m) => m.enabled !== false === enabled);
  }

  res.json(mocks);
});

// ── Export all ──────────────────────────────────────────────────────────────

admin.get('/mocks/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="mocxy-mocks.json"');
  res.json(getAll());
});

// ── Get single ──────────────────────────────────────────────────────────────

admin.get('/mocks/:id', (req, res) => {
  const mock = getById(req.params.id);
  if (!mock) return res.status(404).json({ error: 'Mock not found' });
  res.json(mock);
});

// ── Create ──────────────────────────────────────────────────────────────────

admin.post('/mocks', async (req, res) => {
  try {
    const mock = await create(req.body);
    res.status(201).json(mock);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Bulk import ─────────────────────────────────────────────────────────────

admin.post('/mocks/import', async (req, res) => {
  try {
    const list  = Array.isArray(req.body) ? req.body : (req.body.mocks || []);
    const mocks = await importAll(list);
    res.json({ imported: mocks.length, mocks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────

admin.put('/mocks/:id', async (req, res) => {
  try {
    const mock = await update(req.params.id, req.body);
    if (!mock) return res.status(404).json({ error: 'Mock not found' });
    res.json(mock);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Toggle enabled ──────────────────────────────────────────────────────────

admin.patch('/mocks/:id/toggle', async (req, res) => {
  const mock = getById(req.params.id);
  if (!mock) return res.status(404).json({ error: 'Mock not found' });
  const updated = await update(req.params.id, { enabled: !mock.enabled });
  res.json(updated);
});

// ── Reset stats ─────────────────────────────────────────────────────────────

admin.post('/mocks/:id/reset-stats', async (req, res) => {
  const mock = getById(req.params.id);
  if (!mock) return res.status(404).json({ error: 'Mock not found' });
  const updated = await update(req.params.id, { stats: { matched: 0, lastMatchedAt: null } });
  res.json(updated);
});

// ── Delete single ───────────────────────────────────────────────────────────

admin.delete('/mocks/:id', async (req, res) => {
  const ok = await remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Mock not found' });
  res.json({ deleted: true, id: req.params.id });
});

// ── Delete all ──────────────────────────────────────────────────────────────

admin.delete('/mocks', async (_req, res) => {
  await removeAll();
  res.json({ deleted: true });
});

app.use('/mocxy/admin', admin);

/* -------------------------------------------------------------------------- */
/*  Request matching — everything else                                        */
/* -------------------------------------------------------------------------- */

app.all('*', async (req, res) => {
  // Skip favicon
  if (req.path === '/favicon.ico') return res.status(204).end();

  const mocks   = getAll();
  const matched = findMatch(req, mocks);

  if (!matched) {
    return res.status(404).json({
      error: 'No matching mock',
      hint:  'Create a mock via the Mocxy extension or POST /mocxy/admin/mocks',
      request: {
        method:  req.method,
        url:     req.originalUrl,
        headers: req.headers,
      },
    });
  }

  // Update hit stats (fire-and-forget, don't block response)
  update(matched.id, {
    stats: {
      matched:       (matched.stats?.matched || 0) + 1,
      lastMatchedAt: new Date().toISOString(),
    },
  }).catch(() => {});

  const resp = matched.response || {};

  // Fault simulation
  if (resp.fault === 'network_error') {
    console.log(`  [${req.method}] ${req.path} → FAULT:network_error  (${matched.name})`);
    req.socket.destroy();
    return;
  }
  if (resp.fault === 'empty_response') {
    console.log(`  [${req.method}] ${req.path} → FAULT:empty_response  (${matched.name})`);
    return res.status(200).end();
  }

  // Delay + jitter
  const delay = (resp.delayMs || 0) + Math.floor(Math.random() * ((resp.delayJitter || 0) + 1));
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  // Response headers
  const headers = resp.headers || { 'Content-Type': 'application/json' };
  Object.entries(headers).forEach(([k, v]) => {
    try { res.setHeader(k, v); } catch (_) {}
  });

  // Mocxy metadata headers
  res.setHeader('X-Mocxy-Matched',   'true');
  res.setHeader('X-Mocxy-Mock-Id',   matched.id);
  res.setHeader('X-Mocxy-Mock-Name', encodeURIComponent(matched.name || ''));

  const status = resp.status || 200;
  console.log(`  [${req.method}] ${req.path} → ${status}  (${matched.name})${delay ? `  +${delay}ms` : ''}`);

  res.status(status).send(resp.body || '{}');
});

/* -------------------------------------------------------------------------- */
/*  Start                                                                     */
/* -------------------------------------------------------------------------- */

await load();

app.listen(PORT, () => {
  console.log(`
  ██████████████████████████████████████████
  ██                                      ██
  ██   Mocxy Mock Server  v${VERSION}         ██
  ██                                      ██
  ██████████████████████████████████████████

  Listening  →  http://localhost:${PORT}
  Admin API  →  http://localhost:${PORT}/mocxy/admin
  Health     →  http://localhost:${PORT}/mocxy/admin/health

  Press Ctrl+C to stop
`);
});
