# Feature 4.2 — Offline License Server

## Summary

Offline license validation for on-premises deployments using RSA-signed license files. The vendor (Neuron Interceptor team) generates digitally signed `.lic` files containing customer entitlements. The server validates these licenses on startup using an embedded public key -- no internet connection or phone-home is ever required. The license controls seat limits, feature access, and expiration enforcement.

## Why

Enterprise on-premises customers operate in air-gapped or restricted networks where cloud-based license validation is impossible. An offline RSA-signed license provides cryptographic proof of entitlement without any external dependency. This model is trusted by enterprises because: (1) no data leaves their network, (2) the license cannot be forged without the vendor's private key, and (3) the validation logic is fully auditable.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Backend**: Fastify API server (from spec 13-backend-api.md)
- **Deployment**: On-prem Docker (from spec 19-onprem-docker.md)
- **Crypto**: Node.js built-in `crypto` module -- no external dependencies for signing/verification
- **License file location**: Mounted into the API container via `LICENSE_FILE_PATH` environment variable

## License File Format

A `.lic` file is a two-part text file: Base64-encoded JSON payload, followed by a separator line, followed by the Base64-encoded RSA signature.

```
eyJsaWNlbnNlSWQiOiI1NTBl...base64-encoded-json-payload...
-----BEGIN SIGNATURE-----
Q2xpZW50IExpY2Vuc2Ug...base64-encoded-rsa-sha256-signature...
-----END SIGNATURE-----
```

### License Payload Schema

The JSON payload (before Base64 encoding) contains:

```json
{
  "licenseId": "550e8400-e29b-41d4-a716-446655440000",
  "customerName": "Acme Corp",
  "customerEmail": "admin@acme.com",
  "plan": "enterprise",
  "seats": 50,
  "features": ["rules", "mocks", "sync", "sso", "audit", "recording"],
  "issuedAt": "2026-04-01T00:00:00Z",
  "expiresAt": "2027-04-01T00:00:00Z",
  "maintenanceExpiresAt": "2027-04-01T00:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `licenseId` | UUID | Unique identifier for this license |
| `customerName` | string | Display name of the licensed organization |
| `customerEmail` | string | Primary contact email |
| `plan` | enum | `"starter"`, `"team"`, `"enterprise"` |
| `seats` | number | Maximum number of active users allowed |
| `features` | string[] | List of enabled feature flags |
| `issuedAt` | ISO8601 | When the license was generated |
| `expiresAt` | ISO8601 | When the license expires |
| `maintenanceExpiresAt` | ISO8601 | When maintenance/update entitlement expires |

### Feature Flags

The `features` array controls which API routes and capabilities are available:

| Feature | Controls |
|---------|----------|
| `rules` | Rule creation, editing, import/export |
| `mocks` | Mock response bodies (inline and server) |
| `sync` | Extension-to-backend rule synchronization |
| `sso` | LDAP/SAML SSO authentication |
| `audit` | Audit log viewing and export |
| `recording` | Session recording and playback |
| `graphql` | GraphQL operation matching |
| `body-matching` | Request body condition matching |
| `scripting` | Script and CSS injection |

## Files to Create

| File | Purpose |
|------|---------|
| `cli/generate-keypair.js` | Generate RSA 2048-bit key pair for license signing |
| `cli/generate-license.js` | Sign a license payload with the private key, output `.lic` file |
| `server/src/services/license-service.js` | Validate license on startup, cache result, provide license info |
| `server/src/middleware/license-middleware.js` | Enforce license on every API request (expiry, seats, features) |

## Files to Modify

| File | Change |
|------|--------|
| `server/src/index.js` | Register license middleware globally |
| `server/src/routes/settings.js` | Add `GET /settings/license` endpoint for admin UI |

## Implementation

### File 1: `cli/generate-keypair.js`

Generates an RSA 2048-bit key pair. The private key is kept by the vendor (never shipped). The public key is embedded in the server binary.

```javascript
#!/usr/bin/env node
'use strict';

/**
 * Neuron Interceptor — RSA Key Pair Generator
 *
 * Generates a 2048-bit RSA key pair for license signing.
 * The PRIVATE key stays with the vendor. The PUBLIC key is embedded in the server.
 *
 * Usage:
 *   node cli/generate-keypair.js [--out-dir ./keys]
 *
 * Output:
 *   ./keys/license-private.pem  — KEEP SECRET. Used to sign .lic files.
 *   ./keys/license-public.pem   — Embed in server. Used to verify .lic files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Parse arguments ---------------------------------------------------------
const args = process.argv.slice(2);
let outDir = path.resolve(__dirname, '..', 'keys');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir' && args[i + 1]) {
    outDir = path.resolve(args[i + 1]);
    i++;
  }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node cli/generate-keypair.js [--out-dir ./keys]');
    console.log('');
    console.log('Generates RSA 2048-bit key pair for license signing.');
    console.log('');
    console.log('Options:');
    console.log('  --out-dir <dir>  Output directory (default: ./keys)');
    process.exit(0);
  }
}

// --- Generate key pair -------------------------------------------------------
console.log('Generating RSA 2048-bit key pair...');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

// --- Write to files ----------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });

const privatePath = path.join(outDir, 'license-private.pem');
const publicPath = path.join(outDir, 'license-public.pem');

fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

console.log('');
console.log('Key pair generated:');
console.log(`  Private key: ${privatePath}`);
console.log(`  Public key:  ${publicPath}`);
console.log('');
console.log('IMPORTANT:');
console.log('  - The PRIVATE key must be kept secret by the vendor.');
console.log('  - The PUBLIC key should be embedded in the server source code.');
console.log('  - Copy the public key contents into server/src/services/license-service.js');
console.log('');

// Print public key for easy copy-paste
console.log('--- Public key (copy this into license-service.js) ---');
console.log(publicKey);
```

### File 2: `cli/generate-license.js`

Takes customer details as arguments, signs the license payload with the vendor's private key, and outputs a `.lic` file.

```javascript
#!/usr/bin/env node
'use strict';

/**
 * Neuron Interceptor — License Generator
 *
 * Signs a license payload with the vendor's RSA private key and outputs a .lic file.
 *
 * Usage:
 *   node cli/generate-license.js \
 *     --private-key ./keys/license-private.pem \
 *     --customer "Acme Corp" \
 *     --email "admin@acme.com" \
 *     --plan enterprise \
 *     --seats 50 \
 *     --features rules,mocks,sync,sso,audit,recording \
 *     --expires 2027-04-01 \
 *     --maintenance-expires 2027-04-01 \
 *     --out ./acme-corp.lic
 *
 * All flags:
 *   --private-key <path>        Path to RSA private key PEM (required)
 *   --customer <name>           Customer organization name (required)
 *   --email <email>             Customer contact email (required)
 *   --plan <plan>               Plan: starter|team|enterprise (default: enterprise)
 *   --seats <n>                 Max active users (default: 50)
 *   --features <csv>            Comma-separated feature list (default: all)
 *   --expires <YYYY-MM-DD>      License expiry date (default: 1 year from now)
 *   --maintenance-expires <date> Maintenance expiry (default: same as --expires)
 *   --out <path>                Output .lic file path (default: ./<customer>.lic)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- Default features --------------------------------------------------------
const ALL_FEATURES = [
  'rules', 'mocks', 'sync', 'sso', 'audit', 'recording',
  'graphql', 'body-matching', 'scripting',
];

// --- Parse arguments ---------------------------------------------------------
const args = process.argv.slice(2);
const opts = {
  privateKey: null,
  customer: null,
  email: null,
  plan: 'enterprise',
  seats: 50,
  features: ALL_FEATURES,
  expires: null,
  maintenanceExpires: null,
  out: null,
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--private-key':     opts.privateKey = args[++i]; break;
    case '--customer':        opts.customer = args[++i]; break;
    case '--email':           opts.email = args[++i]; break;
    case '--plan':            opts.plan = args[++i]; break;
    case '--seats':           opts.seats = parseInt(args[++i], 10); break;
    case '--features':        opts.features = args[++i].split(',').map(f => f.trim()); break;
    case '--expires':         opts.expires = args[++i]; break;
    case '--maintenance-expires': opts.maintenanceExpires = args[++i]; break;
    case '--out':             opts.out = args[++i]; break;
    case '--help': case '-h':
      console.log('Usage: node cli/generate-license.js --private-key <pem> --customer <name> --email <email> [options]');
      console.log('Run with --help for full usage.');
      process.exit(0);
  }
}

// --- Validate required arguments ---------------------------------------------
if (!opts.privateKey) {
  console.error('ERROR: --private-key is required.');
  process.exit(1);
}
if (!opts.customer) {
  console.error('ERROR: --customer is required.');
  process.exit(1);
}
if (!opts.email) {
  console.error('ERROR: --email is required.');
  process.exit(1);
}

if (!fs.existsSync(opts.privateKey)) {
  console.error(`ERROR: Private key not found: ${opts.privateKey}`);
  process.exit(1);
}

// --- Build license payload ---------------------------------------------------
const now = new Date();
const oneYearFromNow = new Date(now);
oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

const expiresAt = opts.expires
  ? new Date(opts.expires + 'T00:00:00Z')
  : oneYearFromNow;

const maintenanceExpiresAt = opts.maintenanceExpires
  ? new Date(opts.maintenanceExpires + 'T00:00:00Z')
  : expiresAt;

const payload = {
  licenseId: uuidv4(),
  customerName: opts.customer,
  customerEmail: opts.email,
  plan: opts.plan,
  seats: opts.seats,
  features: opts.features,
  issuedAt: now.toISOString(),
  expiresAt: expiresAt.toISOString(),
  maintenanceExpiresAt: maintenanceExpiresAt.toISOString(),
};

console.log('License payload:');
console.log(JSON.stringify(payload, null, 2));
console.log('');

// --- Sign the payload --------------------------------------------------------
const payloadJson = JSON.stringify(payload);
const payloadBase64 = Buffer.from(payloadJson, 'utf-8').toString('base64');

const privateKeyPem = fs.readFileSync(opts.privateKey, 'utf-8');

const sign = crypto.createSign('RSA-SHA256');
sign.update(payloadBase64);
sign.end();

const signature = sign.sign(privateKeyPem, 'base64');

// --- Build the .lic file content ---------------------------------------------
const licContent = [
  payloadBase64,
  '-----BEGIN SIGNATURE-----',
  // Wrap signature at 76 characters per line for readability
  ...signature.match(/.{1,76}/g),
  '-----END SIGNATURE-----',
  '', // trailing newline
].join('\n');

// --- Write output file -------------------------------------------------------
const outPath = opts.out || path.resolve(
  __dirname,
  '..',
  opts.customer.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.lic'
);

fs.writeFileSync(outPath, licContent, 'utf-8');

console.log(`License file written: ${outPath}`);
console.log('');
console.log('License details:');
console.log(`  ID:          ${payload.licenseId}`);
console.log(`  Customer:    ${payload.customerName}`);
console.log(`  Email:       ${payload.customerEmail}`);
console.log(`  Plan:        ${payload.plan}`);
console.log(`  Seats:       ${payload.seats}`);
console.log(`  Features:    ${payload.features.join(', ')}`);
console.log(`  Issued:      ${payload.issuedAt}`);
console.log(`  Expires:     ${payload.expiresAt}`);
console.log(`  Maintenance: ${payload.maintenanceExpiresAt}`);
console.log('');
console.log('Deploy this file to the customer\'s server as LICENSE_FILE_PATH.');
```

### File 3: `server/src/services/license-service.js`

The core license validation service. On startup, reads the license file, verifies the RSA signature against the embedded public key, checks expiry, and caches the result. Provides helper functions for seat counting, feature gating, and grace period logic.

```javascript
'use strict';

/**
 * Neuron Interceptor — License Service
 *
 * Validates RSA-signed license files offline. No phone-home.
 *
 * Lifecycle:
 *   1. On server startup, call initLicense(knex) — reads LICENSE_FILE_PATH,
 *      verifies RSA-SHA256 signature, parses payload, checks expiry.
 *   2. Cached result is available via getLicense().
 *   3. Middleware calls isLicenseValid(), checkSeats(), isFeatureEnabled()
 *      on every request.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// =============================================================================
// EMBEDDED PUBLIC KEY — Replace with the output of cli/generate-keypair.js
// This is the ONLY key that can verify license signatures.
// =============================================================================
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0PLACEHOLDER0KEY0
REPLACE0WITH0ACTUAL0PUBLIC0KEY0FROM0GENERATE0KEYPAIR0SCRIPT000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
000000000000000000000000000000000000000000000000000000000000AQAB
-----END PUBLIC KEY-----`;

// Grace period: 14 days after expiry, license enters read-only mode
const GRACE_PERIOD_DAYS = 14;

// =============================================================================
// Module state
// =============================================================================
let _license = null;       // Parsed license payload (or null)
let _status = 'missing';   // 'valid' | 'expired' | 'grace' | 'invalid' | 'missing'
let _error = null;         // Error message if validation failed
let _knex = null;          // Database connection for seat counting

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize the license service. Call once on server startup.
 *
 * @param {object} knex — Knex database instance for seat counting
 * @returns {{ license: object|null, status: string, error: string|null }}
 */
function initLicense(knex) {
  _knex = knex;

  const filePath = process.env.LICENSE_FILE_PATH;
  if (!filePath) {
    _status = 'missing';
    _error = 'LICENSE_FILE_PATH environment variable is not set.';
    _log('warn', _error);
    return { license: null, status: _status, error: _error };
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    _status = 'missing';
    _error = `License file not found: ${resolvedPath}`;
    _log('warn', _error);
    return { license: null, status: _status, error: _error };
  }

  try {
    const fileContent = fs.readFileSync(resolvedPath, 'utf-8').trim();
    const parsed = _parseLicenseFile(fileContent);

    // Verify RSA signature
    const isSignatureValid = _verifySignature(parsed.payloadBase64, parsed.signature);
    if (!isSignatureValid) {
      _status = 'invalid';
      _error = 'License signature verification failed. The license file may be tampered with.';
      _log('error', _error);
      return { license: null, status: _status, error: _error };
    }

    // Decode and parse payload
    const payloadJson = Buffer.from(parsed.payloadBase64, 'base64').toString('utf-8');
    _license = JSON.parse(payloadJson);

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(_license.expiresAt);
    const graceEnd = new Date(expiresAt);
    graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS);

    if (now < expiresAt) {
      _status = 'valid';
      _error = null;
    } else if (now < graceEnd) {
      _status = 'grace';
      _error = null;
      const daysLeft = Math.ceil((graceEnd - now) / (1000 * 60 * 60 * 24));
      _log('warn', `License expired. Grace period active: ${daysLeft} days remaining. Read-only mode.`);
    } else {
      _status = 'expired';
      _error = `License expired on ${_license.expiresAt}. Grace period ended on ${graceEnd.toISOString()}.`;
      _log('error', _error);
    }

    _log('info', `License loaded: ${_license.customerName} (${_license.plan}), ${_license.seats} seats, status=${_status}`);
    return { license: _license, status: _status, error: _error };

  } catch (err) {
    _status = 'invalid';
    _error = `Failed to parse license file: ${err.message}`;
    _log('error', _error);
    return { license: null, status: _status, error: _error };
  }
}

/**
 * Get the cached license object and status.
 *
 * @returns {{ license: object|null, status: string, error: string|null }}
 */
function getLicense() {
  return { license: _license, status: _status, error: _error };
}

/**
 * Check if the license is currently valid (or in grace period).
 * Returns true if the server should allow operations.
 *
 * @returns {boolean}
 */
function isLicenseValid() {
  return _status === 'valid' || _status === 'grace';
}

/**
 * Check if the license is in grace period (read-only mode).
 *
 * @returns {boolean}
 */
function isGracePeriod() {
  return _status === 'grace';
}

/**
 * Check if a specific feature is enabled in the license.
 *
 * @param {string} featureName — Feature flag from the license
 * @returns {boolean}
 */
function isFeatureEnabled(featureName) {
  if (!_license || !_license.features) return false;
  return _license.features.includes(featureName);
}

/**
 * Count current active users in a workspace and check against seat limit.
 *
 * @param {string} [workspaceId] — If provided, count seats in this workspace. Otherwise count all active users.
 * @returns {Promise<{ current: number, limit: number, available: boolean }>}
 */
async function checkSeats(workspaceId) {
  if (!_license) {
    return { current: 0, limit: 0, available: false };
  }

  let query = _knex('users').where({ is_active: true });
  if (workspaceId) {
    query = _knex('workspace_members')
      .join('users', 'users.id', 'workspace_members.user_id')
      .where({
        'workspace_members.workspace_id': workspaceId,
        'users.is_active': true,
      });
  }

  const result = await query.count('* as count').first();
  const current = parseInt(result.count, 10);
  const limit = _license.seats;

  return {
    current,
    limit,
    available: current < limit,
  };
}

/**
 * Get a sanitized license info object suitable for the admin UI.
 * Excludes sensitive internals.
 *
 * @returns {object}
 */
function getLicenseInfo() {
  if (!_license) {
    return {
      status: _status,
      error: _error,
      customer: null,
      plan: null,
      seats: null,
      features: [],
      expiresAt: null,
      maintenanceExpiresAt: null,
      daysUntilExpiry: null,
    };
  }

  const now = new Date();
  const expiresAt = new Date(_license.expiresAt);
  const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

  return {
    status: _status,
    error: _error,
    licenseId: _license.licenseId,
    customer: _license.customerName,
    email: _license.customerEmail,
    plan: _license.plan,
    seats: _license.seats,
    features: _license.features,
    issuedAt: _license.issuedAt,
    expiresAt: _license.expiresAt,
    maintenanceExpiresAt: _license.maintenanceExpiresAt,
    daysUntilExpiry,
    gracePeriodDays: GRACE_PERIOD_DAYS,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Parse the .lic file into payload and signature parts.
 *
 * @param {string} content — Raw file content
 * @returns {{ payloadBase64: string, signature: string }}
 */
function _parseLicenseFile(content) {
  const signatureStart = '-----BEGIN SIGNATURE-----';
  const signatureEnd = '-----END SIGNATURE-----';

  const sigStartIdx = content.indexOf(signatureStart);
  if (sigStartIdx === -1) {
    throw new Error('License file missing -----BEGIN SIGNATURE----- marker.');
  }

  const sigEndIdx = content.indexOf(signatureEnd);
  if (sigEndIdx === -1) {
    throw new Error('License file missing -----END SIGNATURE----- marker.');
  }

  const payloadBase64 = content.substring(0, sigStartIdx).trim();
  const signatureBlock = content
    .substring(sigStartIdx + signatureStart.length, sigEndIdx)
    .trim();

  // Remove line breaks from signature (may be wrapped at 76 chars)
  const signature = signatureBlock.replace(/\s+/g, '');

  if (!payloadBase64) {
    throw new Error('License file has empty payload.');
  }
  if (!signature) {
    throw new Error('License file has empty signature.');
  }

  return { payloadBase64, signature };
}

/**
 * Verify the RSA-SHA256 signature of the payload using the embedded public key.
 *
 * @param {string} payloadBase64 — The Base64-encoded payload string
 * @param {string} signatureBase64 — The Base64-encoded RSA signature
 * @returns {boolean}
 */
function _verifySignature(payloadBase64, signatureBase64) {
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(payloadBase64);
    verify.end();
    return verify.verify(EMBEDDED_PUBLIC_KEY, signatureBase64, 'base64');
  } catch (err) {
    _log('error', `Signature verification error: ${err.message}`);
    return false;
  }
}

/**
 * Internal structured logger.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 */
function _log(level, message) {
  const prefix = '[Neuron License]';
  switch (level) {
    case 'error': console.error(`${prefix} ${message}`); break;
    case 'warn':  console.warn(`${prefix} ${message}`); break;
    default:      console.log(`${prefix} ${message}`); break;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  initLicense,
  getLicense,
  isLicenseValid,
  isGracePeriod,
  isFeatureEnabled,
  checkSeats,
  getLicenseInfo,
  GRACE_PERIOD_DAYS,
};
```

### File 4: `server/src/middleware/license-middleware.js`

Express/Fastify middleware that enforces the license on every API request. Returns HTTP 402 if expired (past grace), HTTP 403 if over seat limit, and HTTP 403 if a feature-gated route is accessed without the corresponding feature flag.

```javascript
'use strict';

/**
 * Neuron Interceptor — License Enforcement Middleware
 *
 * Registered globally on the Fastify server. Runs before every API route.
 *
 * Enforcement rules:
 *   1. If license is missing or invalid → 402 Payment Required
 *   2. If license is expired (past grace period) → 402 Payment Required
 *   3. If license is in grace period → allow GET requests only (read-only mode)
 *   4. If seat limit exceeded → 403 Forbidden (on user creation only)
 *   5. If feature not licensed → 403 Forbidden
 *
 * Excluded routes (no license check):
 *   - GET /health
 *   - POST /api/auth/login
 *   - GET /api/settings/license (so admins can see license status)
 */

const {
  isLicenseValid,
  isGracePeriod,
  isFeatureEnabled,
  checkSeats,
  getLicense,
} = require('../services/license-service');

// Routes that are always accessible, even without a valid license
const EXCLUDED_ROUTES = [
  { method: 'GET',  path: '/health' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET',  path: '/api/settings/license' },
];

// Map of route prefixes to required feature flags
const FEATURE_ROUTE_MAP = {
  '/api/rules':           'rules',
  '/api/mocks':           'mocks',
  '/api/collections':     'mocks',
  '/api/sync':            'sync',
  '/api/auth/sso':        'sso',
  '/api/audit':           'audit',
  '/api/recordings':      'recording',
};

/**
 * Fastify onRequest hook for license enforcement.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
async function licenseMiddleware(request, reply) {
  const method = request.method;
  const url = request.url;

  // --- Skip excluded routes --------------------------------------------------
  for (const excluded of EXCLUDED_ROUTES) {
    if (method === excluded.method && url.startsWith(excluded.path)) {
      return; // allow through
    }
  }

  // --- Check 1: License must exist and be valid (or in grace) ----------------
  if (!isLicenseValid()) {
    const { status, error } = getLicense();
    return reply.code(402).send({
      error: 'License Required',
      message: status === 'expired'
        ? 'Your license has expired and the grace period has ended. Please contact support to renew.'
        : status === 'invalid'
          ? 'The license file is invalid or has been tampered with. Please contact support.'
          : 'No valid license file found. Please install a license to use this platform.',
      licenseStatus: status,
      details: error,
    });
  }

  // --- Check 2: Grace period → read-only mode --------------------------------
  if (isGracePeriod()) {
    const readOnlyMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (!readOnlyMethods.includes(method)) {
      return reply.code(402).send({
        error: 'License Expired — Read-Only Mode',
        message: 'Your license has expired. During the 14-day grace period, the platform is in read-only mode. Please renew your license to restore full access.',
        licenseStatus: 'grace',
      });
    }
  }

  // --- Check 3: Feature gating -----------------------------------------------
  for (const [prefix, feature] of Object.entries(FEATURE_ROUTE_MAP)) {
    if (url.startsWith(prefix)) {
      if (!isFeatureEnabled(feature)) {
        return reply.code(403).send({
          error: 'Feature Not Licensed',
          message: `The "${feature}" feature is not included in your license plan. Please upgrade to access this functionality.`,
          feature,
        });
      }
      break;
    }
  }

  // --- Check 4: Seat limit (only on user creation) ---------------------------
  if (method === 'POST' && (url === '/api/users' || url.match(/^\/api\/workspaces\/[^/]+\/members$/))) {
    const workspaceId = request.params?.workspaceId || null;
    const seats = await checkSeats(workspaceId);
    if (!seats.available) {
      return reply.code(403).send({
        error: 'Seat Limit Reached',
        message: `Your license allows ${seats.limit} active users. Currently ${seats.current} seats are in use. Please deactivate an existing user or upgrade your license.`,
        seatsUsed: seats.current,
        seatsLimit: seats.limit,
      });
    }
  }

  // --- All checks passed → proceed -------------------------------------------
}

module.exports = { licenseMiddleware };
```

### Registration in Server Startup

In `server/src/index.js`, register the license service and middleware:

```javascript
// In server/src/index.js — add to the startup sequence

const { initLicense } = require('./services/license-service');
const { licenseMiddleware } = require('./middleware/license-middleware');

// After database connection is established:
const licenseResult = initLicense(knex);
fastify.log.info(`License status: ${licenseResult.status}`);

// Register as global onRequest hook (before route handlers):
fastify.addHook('onRequest', licenseMiddleware);
```

### License Info API Endpoint

Add to `server/src/routes/settings.js`:

```javascript
// GET /api/settings/license — returns license info for admin UI

const { getLicenseInfo, checkSeats } = require('../services/license-service');

fastify.get('/api/settings/license', {
  preHandler: [requireAuth],  // Must be logged in, any role
}, async (request, reply) => {
  const licenseInfo = getLicenseInfo();

  // Add current seat usage
  const seats = await checkSeats();
  licenseInfo.seatsUsed = seats.current;

  return reply.send(licenseInfo);
});
```

### Extension Admin UI: License Status Display

Add a license status section to the extension options page. This is shown in the Settings tab when connected to an on-prem backend.

In `options/components/settings.js`, add a section that fetches and displays license info:

```javascript
/**
 * Render the license status card in the settings panel.
 * Only shown when connected to an on-prem backend with a license.
 *
 * @param {HTMLElement} container — Parent element to append the card to
 * @param {string} backendUrl — The on-prem backend URL
 */
async function renderLicenseStatus(container, backendUrl) {
  const card = document.createElement('div');
  card.className = 'ni-license-card';
  card.style.cssText = `
    background: var(--bg-overlay, #181825);
    border: 1px solid var(--border, #45475a);
    border-radius: 12px;
    padding: 20px;
    margin-top: 16px;
  `;

  card.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Loading license info...</div>';
  container.appendChild(card);

  try {
    const token = localStorage.getItem('neuron_auth_token');
    const res = await fetch(`${backendUrl}/api/settings/license`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await res.json();

    const statusColor = {
      valid: '#a6e3a1',     // green
      grace: '#f9e2af',     // yellow
      expired: '#f38ba8',   // red
      invalid: '#f38ba8',   // red
      missing: '#a6adc8',   // muted
    }[info.status] || '#a6adc8';

    const statusLabel = {
      valid: 'Active',
      grace: 'Grace Period (Read-Only)',
      expired: 'Expired',
      invalid: 'Invalid',
      missing: 'Not Installed',
    }[info.status] || 'Unknown';

    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
        <h3 style="margin: 0; color: var(--text, #cdd6f4); font-size: 16px; font-weight: 600;">License</h3>
        <span style="
          display: inline-block;
          padding: 4px 12px;
          border-radius: 12px;
          background: ${statusColor}22;
          color: ${statusColor};
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        ">${statusLabel}</span>
      </div>

      ${info.customer ? `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <div style="color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Customer</div>
            <div style="color: var(--text); font-size: 14px; font-weight: 500;">${info.customer}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Plan</div>
            <div style="color: var(--text); font-size: 14px; font-weight: 500; text-transform: capitalize;">${info.plan}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Seats</div>
            <div style="color: var(--text); font-size: 14px; font-weight: 500;">${info.seatsUsed ?? '?'} / ${info.seats}</div>
          </div>
          <div>
            <div style="color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Expires</div>
            <div style="color: ${info.daysUntilExpiry <= 30 ? '#f9e2af' : 'var(--text)'}; font-size: 14px; font-weight: 500;">
              ${new Date(info.expiresAt).toLocaleDateString()}
              ${info.daysUntilExpiry > 0 ? `(${info.daysUntilExpiry} days)` : '(expired)'}
            </div>
          </div>
        </div>

        <div style="margin-top: 16px;">
          <div style="color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Licensed Features</div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${info.features.map(f => `
              <span style="
                display: inline-block;
                padding: 3px 10px;
                border-radius: 6px;
                background: var(--surface-hover, #3b3f58);
                color: var(--text, #cdd6f4);
                font-size: 12px;
              ">${f}</span>
            `).join('')}
          </div>
        </div>
      ` : `
        <div style="color: var(--text-muted); font-size: 13px;">
          ${info.error || 'No license file installed. Contact your administrator.'}
        </div>
      `}
    `;
  } catch (err) {
    card.innerHTML = `
      <div style="color: #f38ba8; font-size: 13px;">
        Failed to load license info: ${err.message}
      </div>
    `;
  }
}
```

## Verification

### Step 1: Generate Key Pair

```bash
cd health_check/utils/neuron-interceptor-plugin/
node cli/generate-keypair.js --out-dir ./keys

# Expected output:
# Generating RSA 2048-bit key pair...
# Key pair generated:
#   Private key: /path/to/keys/license-private.pem
#   Public key:  /path/to/keys/license-public.pem
```

### Step 2: Copy Public Key into Server

Open `keys/license-public.pem` and copy its contents into the `EMBEDDED_PUBLIC_KEY` constant in `server/src/services/license-service.js`.

### Step 3: Generate a License

```bash
node cli/generate-license.js \
  --private-key ./keys/license-private.pem \
  --customer "Test Corp" \
  --email "admin@test.com" \
  --plan enterprise \
  --seats 10 \
  --features rules,mocks,sync,sso,audit,recording \
  --expires 2027-04-01 \
  --out ./test-license.lic

# Expected: test-license.lic created with Base64 payload + RSA signature
```

### Step 4: Verify License Loads on Server Startup

```bash
LICENSE_FILE_PATH=./test-license.lic node server/src/index.js

# Expected log: [Neuron License] License loaded: Test Corp (enterprise), 10 seats, status=valid
```

### Step 5: Test Expired License

```bash
# Generate a license that already expired
node cli/generate-license.js \
  --private-key ./keys/license-private.pem \
  --customer "Expired Corp" \
  --email "admin@expired.com" \
  --expires 2025-01-01 \
  --out ./expired.lic

# Start server with expired license
LICENSE_FILE_PATH=./expired.lic node server/src/index.js

# Make API request
curl http://localhost:3001/api/rules
# Expected: 402 {"error":"License Required","message":"Your license has expired..."}
```

### Step 6: Test Grace Period

```bash
# Generate a license that expired 7 days ago (within 14-day grace)
node cli/generate-license.js \
  --private-key ./keys/license-private.pem \
  --customer "Grace Corp" \
  --email "admin@grace.com" \
  --expires 2026-03-25 \
  --out ./grace.lic

# Start server
LICENSE_FILE_PATH=./grace.lic node server/src/index.js

# GET should work (read-only)
curl http://localhost:3001/api/rules
# Expected: 200 (rules list)

# POST should be blocked
curl -X POST http://localhost:3001/api/rules -H "Content-Type: application/json" -d '{}'
# Expected: 402 {"error":"License Expired — Read-Only Mode",...}
```

### Step 7: Test Seat Limit

```bash
# Generate a license with 2 seats
node cli/generate-license.js \
  --private-key ./keys/license-private.pem \
  --customer "Small Corp" \
  --email "admin@small.com" \
  --seats 2 \
  --out ./small.lic

# With 2 active users already in the database:
curl -X POST http://localhost:3001/api/users -H "Content-Type: application/json" \
  -d '{"email":"new@small.com","password":"test123"}'
# Expected: 403 {"error":"Seat Limit Reached","seatsUsed":2,"seatsLimit":2}
```

### Step 8: Test Feature Gating

```bash
# Generate a license without the "audit" feature
node cli/generate-license.js \
  --private-key ./keys/license-private.pem \
  --customer "Basic Corp" \
  --email "admin@basic.com" \
  --features rules,mocks \
  --out ./basic.lic

# Try to access audit logs
curl http://localhost:3001/api/audit
# Expected: 403 {"error":"Feature Not Licensed","feature":"audit"}
```

### Step 9: Test Tampered License

```bash
# Edit the .lic file — change a character in the Base64 payload
# Then restart the server
# Expected log: [Neuron License] License signature verification failed.
# Expected API: 402 {"error":"License Required","message":"The license file is invalid..."}
```

### Step 10: Verify Admin UI

1. Open the extension Options page
2. Navigate to Settings
3. Confirm the "License" card shows: customer name, plan, seats used/total, expiry date, feature badges, status indicator
4. With an expired license: status badge shows red "Expired"
5. With a grace period license: status badge shows yellow "Grace Period (Read-Only)"
