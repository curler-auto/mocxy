# Feature 4.3 — SSO Adapter (LDAP + SAML)

## Summary

Enterprise SSO authentication supporting both LDAP (Active Directory) and SAML 2.0 identity providers. Customers configure their existing corporate identity provider once, and all users authenticate through their organization's centralized login system. On first SSO login, users are automatically provisioned into the Neuron Interceptor platform with appropriate roles.

## Why

Enterprise customers universally require SSO integration for security, compliance, and operational reasons: (1) centralized user lifecycle management -- when an employee leaves, disabling their LDAP/AD account immediately revokes access to all connected systems, (2) password policy enforcement through the corporate IdP, (3) compliance mandates (SOC 2, ISO 27001, HIPAA) that require centralized authentication, and (4) reduced friction -- users sign in with the same credentials they use for every other corporate tool.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Backend**: Fastify API server (from spec 13-backend-api.md)
- **Auth system**: JWT-based (from spec 14-auth-system.md)
- **Database**: PostgreSQL (users table with `sso_provider` and `sso_external_id` columns)
- **Dependencies**: `ldapjs` for LDAP, `@node-saml/node-saml` for SAML 2.0

## SSO Modes

The platform supports three authentication modes, configured via the `SSO_TYPE` environment variable:

| Mode | Value | Behavior |
|------|-------|----------|
| None (default) | `none` | Standard email/password login only |
| LDAP | `ldap` | LDAP bind authentication + optional local fallback |
| SAML | `saml` | SAML 2.0 redirect flow + optional local fallback |

When SSO is enabled, the login page shows an "SSO Login" button. Local email/password login can optionally be disabled for non-admin users via the `SSO_ALLOW_LOCAL_LOGIN` setting.

## Configuration

All SSO configuration is set via environment variables (in `.env` for Docker deployments) or workspace settings API.

### LDAP Configuration

```bash
# --- SSO: LDAP ----------------------------------------------------------------
SSO_TYPE=ldap

# LDAP server connection
LDAP_URL=ldap://ldap.acme.com:389
# Use ldaps:// for TLS: ldaps://ldap.acme.com:636
LDAP_TLS_REJECT_UNAUTHORIZED=true

# Service account for LDAP searches (bind DN)
LDAP_BIND_DN=cn=neuron-svc,ou=service-accounts,dc=acme,dc=com
LDAP_BIND_PASSWORD=service-account-password

# Where to search for users
LDAP_SEARCH_BASE=ou=people,dc=acme,dc=com

# Search filter — {{username}} is replaced with the login email/username
LDAP_SEARCH_FILTER=(uid={{username}})
# For Active Directory: (sAMAccountName={{username}})
# For email-based: (mail={{username}})

# Attribute mapping — which LDAP attributes map to user profile fields
LDAP_ATTR_EMAIL=mail
LDAP_ATTR_DISPLAY_NAME=displayName
LDAP_ATTR_FIRST_NAME=givenName
LDAP_ATTR_LAST_NAME=sn
LDAP_ATTR_GROUPS=memberOf

# Optional: restrict login to members of specific LDAP groups
LDAP_REQUIRED_GROUP=cn=neuron-users,ou=groups,dc=acme,dc=com

# Allow local (email/password) login as fallback for admin accounts
SSO_ALLOW_LOCAL_LOGIN=true
```

### SAML Configuration

```bash
# --- SSO: SAML 2.0 -----------------------------------------------------------
SSO_TYPE=saml

# Identity Provider (IdP) settings
SAML_ENTRY_POINT=https://idp.acme.com/sso/saml
SAML_ISSUER=neuron-interceptor
SAML_CERT=MIICpDCCAYwCCQD...base64-encoded-idp-x509-certificate...

# Service Provider (SP) settings
SAML_CALLBACK_URL=https://neuron.acme.com/api/auth/saml/callback
SAML_LOGOUT_URL=https://idp.acme.com/sso/logout

# Attribute mapping — which SAML assertion attributes map to user profile fields
SAML_ATTR_EMAIL=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress
SAML_ATTR_DISPLAY_NAME=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name
SAML_ATTR_FIRST_NAME=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname
SAML_ATTR_LAST_NAME=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname
SAML_ATTR_GROUPS=http://schemas.xmlsoap.org/claims/Group

# Optional: sign SAML requests
SAML_SIGN_REQUESTS=false
SAML_SP_CERT=
SAML_SP_KEY=

# Allow local login as fallback
SSO_ALLOW_LOCAL_LOGIN=true
```

## Files to Create

| File | Purpose |
|------|---------|
| `server/src/routes/auth-sso.js` | Fastify route plugin with LDAP + SAML endpoints |
| `server/src/services/ldap-service.js` | LDAP connection, bind, search, group check |
| `server/src/services/saml-service.js` | SAML request generation, assertion parsing, validation |

## Files to Modify

| File | Change |
|------|--------|
| `server/src/index.js` | Register `auth-sso.js` routes |
| `server/src/routes/auth.js` | Add SSO type check, redirect non-SSO login when SSO is enforced |
| `server/package.json` | Add `ldapjs` and `@node-saml/node-saml` dependencies |

## Database Changes

Add columns to the `users` table (Knex migration):

```javascript
// migrations/YYYYMMDD_add_sso_fields.js
exports.up = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.string('sso_provider').nullable().defaultTo(null);
    // 'ldap' | 'saml' | null (local)
    table.string('sso_external_id').nullable().defaultTo(null);
    // LDAP DN or SAML NameID
    table.jsonb('sso_attributes').nullable().defaultTo(null);
    // Raw attributes from last SSO login (for debugging)
    table.timestamp('last_sso_login_at').nullable().defaultTo(null);

    table.index(['sso_provider', 'sso_external_id'], 'idx_users_sso');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.dropIndex(null, 'idx_users_sso');
    table.dropColumn('sso_provider');
    table.dropColumn('sso_external_id');
    table.dropColumn('sso_attributes');
    table.dropColumn('last_sso_login_at');
  });
};
```

## Implementation

### File 1: `server/src/services/ldap-service.js`

Complete LDAP service with connection management, user search, password verification, and group membership checking.

```javascript
'use strict';

/**
 * Neuron Interceptor — LDAP Authentication Service
 *
 * Flow:
 *   1. Bind to LDAP server with service account credentials
 *   2. Search for the user by email/username using the configured filter
 *   3. If found, attempt to bind as the user with their password
 *   4. If bind succeeds, extract user attributes (email, name, groups)
 *   5. Optionally check group membership
 *   6. Return user profile for local account creation/update
 */

const ldap = require('ldapjs');

// =============================================================================
// Configuration (from environment variables)
// =============================================================================

function _getConfig() {
  return {
    url: process.env.LDAP_URL || 'ldap://localhost:389',
    tlsRejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
    bindDN: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    searchBase: process.env.LDAP_SEARCH_BASE || '',
    searchFilter: process.env.LDAP_SEARCH_FILTER || '(uid={{username}})',
    attrEmail: process.env.LDAP_ATTR_EMAIL || 'mail',
    attrDisplayName: process.env.LDAP_ATTR_DISPLAY_NAME || 'displayName',
    attrFirstName: process.env.LDAP_ATTR_FIRST_NAME || 'givenName',
    attrLastName: process.env.LDAP_ATTR_LAST_NAME || 'sn',
    attrGroups: process.env.LDAP_ATTR_GROUPS || 'memberOf',
    requiredGroup: process.env.LDAP_REQUIRED_GROUP || '',
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Authenticate a user via LDAP.
 *
 * @param {string} username — The username or email entered by the user
 * @param {string} password — The user's password
 * @returns {Promise<{ success: boolean, user?: object, error?: string }>}
 *
 * On success, returns:
 *   {
 *     success: true,
 *     user: {
 *       externalId: 'cn=jdoe,ou=people,dc=acme,dc=com',
 *       email: 'jdoe@acme.com',
 *       displayName: 'John Doe',
 *       firstName: 'John',
 *       lastName: 'Doe',
 *       groups: ['cn=developers,ou=groups,dc=acme,dc=com'],
 *       rawAttributes: { ... }
 *     }
 *   }
 */
async function authenticateLDAP(username, password) {
  const config = _getConfig();

  if (!config.url || !config.bindDN || !config.searchBase) {
    return { success: false, error: 'LDAP is not configured. Set LDAP_URL, LDAP_BIND_DN, and LDAP_SEARCH_BASE.' };
  }

  let serviceClient = null;
  let userClient = null;

  try {
    // --- Step 1: Bind with service account -----------------------------------
    serviceClient = _createClient(config);
    await _bind(serviceClient, config.bindDN, config.bindPassword);

    // --- Step 2: Search for the user -----------------------------------------
    const filter = config.searchFilter.replace(/\{\{username\}\}/g, _escapeLDAP(username));
    const searchResult = await _search(serviceClient, config.searchBase, {
      filter,
      scope: 'sub',
      attributes: [
        'dn',
        config.attrEmail,
        config.attrDisplayName,
        config.attrFirstName,
        config.attrLastName,
        config.attrGroups,
      ],
      sizeLimit: 1,
    });

    if (searchResult.length === 0) {
      return { success: false, error: 'User not found in directory.' };
    }

    const entry = searchResult[0];
    const userDN = entry.dn || entry.objectName;

    // --- Step 3: Verify password by binding as the user ----------------------
    userClient = _createClient(config);
    try {
      await _bind(userClient, userDN, password);
    } catch (bindErr) {
      return { success: false, error: 'Invalid credentials.' };
    }

    // --- Step 4: Extract user attributes -------------------------------------
    const attrs = entry.attributes || entry;
    const user = {
      externalId: userDN,
      email: _getAttr(attrs, config.attrEmail) || username,
      displayName: _getAttr(attrs, config.attrDisplayName) || '',
      firstName: _getAttr(attrs, config.attrFirstName) || '',
      lastName: _getAttr(attrs, config.attrLastName) || '',
      groups: _getAttrArray(attrs, config.attrGroups),
      rawAttributes: _serializeAttributes(attrs),
    };

    // --- Step 5: Check group membership (if required) ------------------------
    if (config.requiredGroup) {
      const isMember = user.groups.some(
        g => g.toLowerCase() === config.requiredGroup.toLowerCase()
      );
      if (!isMember) {
        return {
          success: false,
          error: `User is not a member of the required group: ${config.requiredGroup}`,
        };
      }
    }

    return { success: true, user };

  } catch (err) {
    console.error('[Neuron LDAP] Authentication error:', err.message);
    return { success: false, error: `LDAP error: ${err.message}` };
  } finally {
    if (serviceClient) _unbind(serviceClient);
    if (userClient) _unbind(userClient);
  }
}

/**
 * Test the LDAP connection with the service account.
 * Used by the admin SSO configuration UI to verify settings.
 *
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function testLDAPConnection() {
  const config = _getConfig();
  let client = null;

  try {
    client = _createClient(config);
    await _bind(client, config.bindDN, config.bindPassword);

    // Attempt a basic search to verify searchBase is correct
    const results = await _search(client, config.searchBase, {
      filter: '(objectClass=*)',
      scope: 'base',
      sizeLimit: 1,
    });

    return { success: true, message: `Connected. Search base "${config.searchBase}" is accessible.` };
  } catch (err) {
    return { success: false, error: `LDAP connection test failed: ${err.message}` };
  } finally {
    if (client) _unbind(client);
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Create an LDAP client instance.
 */
function _createClient(config) {
  const opts = {
    url: config.url,
    connectTimeout: 10000,
    timeout: 10000,
  };

  if (config.url.startsWith('ldaps://')) {
    opts.tlsOptions = {
      rejectUnauthorized: config.tlsRejectUnauthorized,
    };
  }

  return ldap.createClient(opts);
}

/**
 * Bind (authenticate) to the LDAP server.
 *
 * @param {object} client — ldapjs client
 * @param {string} dn — Distinguished Name to bind as
 * @param {string} password — Password for the DN
 * @returns {Promise<void>}
 */
function _bind(client, dn, password) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) {
        reject(new Error(`LDAP bind failed for ${dn}: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Unbind (disconnect) from the LDAP server.
 */
function _unbind(client) {
  try {
    client.unbind();
  } catch (e) {
    // Ignore unbind errors
  }
}

/**
 * Search the LDAP directory.
 *
 * @param {object} client — ldapjs client
 * @param {string} base — Search base DN
 * @param {object} options — Search options (filter, scope, attributes, sizeLimit)
 * @returns {Promise<object[]>}
 */
function _search(client, base, options) {
  return new Promise((resolve, reject) => {
    const entries = [];

    client.search(base, options, (err, res) => {
      if (err) {
        return reject(new Error(`LDAP search failed: ${err.message}`));
      }

      res.on('searchEntry', (entry) => {
        entries.push(entry.pojo || entry.object || entry);
      });

      res.on('error', (err) => {
        reject(new Error(`LDAP search error: ${err.message}`));
      });

      res.on('end', (result) => {
        if (result.status !== 0) {
          reject(new Error(`LDAP search ended with status ${result.status}`));
        } else {
          resolve(entries);
        }
      });
    });
  });
}

/**
 * Extract a single attribute value from an LDAP entry.
 */
function _getAttr(attrs, name) {
  if (Array.isArray(attrs)) {
    const attr = attrs.find(a => a.type === name);
    return attr && attr.values ? attr.values[0] : null;
  }
  if (attrs[name]) {
    return Array.isArray(attrs[name]) ? attrs[name][0] : attrs[name];
  }
  return null;
}

/**
 * Extract a multi-valued attribute as an array.
 */
function _getAttrArray(attrs, name) {
  if (Array.isArray(attrs)) {
    const attr = attrs.find(a => a.type === name);
    return attr && attr.values ? attr.values : [];
  }
  if (attrs[name]) {
    return Array.isArray(attrs[name]) ? attrs[name] : [attrs[name]];
  }
  return [];
}

/**
 * Serialize LDAP attributes to a plain JSON object (for storage).
 */
function _serializeAttributes(attrs) {
  if (Array.isArray(attrs)) {
    const obj = {};
    for (const attr of attrs) {
      obj[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
    }
    return obj;
  }
  return attrs;
}

/**
 * Escape special characters in LDAP filter values to prevent injection.
 */
function _escapeLDAP(str) {
  return str
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  authenticateLDAP,
  testLDAPConnection,
};
```

### File 2: `server/src/services/saml-service.js`

Complete SAML 2.0 service with AuthnRequest generation, assertion parsing and validation, and attribute extraction.

```javascript
'use strict';

/**
 * Neuron Interceptor — SAML 2.0 Authentication Service
 *
 * Flow:
 *   1. User clicks "SSO Login" → GET /api/auth/saml/login
 *   2. Server generates SAML AuthnRequest → redirect user to IdP entry point
 *   3. IdP authenticates the user → POST assertion to /api/auth/saml/callback
 *   4. Server validates assertion (signature, conditions, audience)
 *   5. Extracts user attributes (email, name, groups) from assertion
 *   6. Creates/updates local user account → issues JWT → redirect to app
 */

const { SAML } = require('@node-saml/node-saml');

// =============================================================================
// Module state
// =============================================================================

let _saml = null;

// =============================================================================
// Configuration
// =============================================================================

function _getConfig() {
  return {
    entryPoint: process.env.SAML_ENTRY_POINT || '',
    issuer: process.env.SAML_ISSUER || 'neuron-interceptor',
    cert: process.env.SAML_CERT || '',
    callbackUrl: process.env.SAML_CALLBACK_URL || '',
    logoutUrl: process.env.SAML_LOGOUT_URL || '',
    signRequests: process.env.SAML_SIGN_REQUESTS === 'true',
    spCert: process.env.SAML_SP_CERT || '',
    spKey: process.env.SAML_SP_KEY || '',
    attrEmail: process.env.SAML_ATTR_EMAIL || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    attrDisplayName: process.env.SAML_ATTR_DISPLAY_NAME || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    attrFirstName: process.env.SAML_ATTR_FIRST_NAME || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    attrLastName: process.env.SAML_ATTR_LAST_NAME || 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    attrGroups: process.env.SAML_ATTR_GROUPS || 'http://schemas.xmlsoap.org/claims/Group',
  };
}

/**
 * Get or create the node-saml SAML instance.
 * Lazy-initialized on first use.
 *
 * @returns {SAML}
 */
function _getSAML() {
  if (_saml) return _saml;

  const config = _getConfig();

  const samlOptions = {
    entryPoint: config.entryPoint,
    issuer: config.issuer,
    callbackUrl: config.callbackUrl,
    cert: config.cert,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: false,
    validateInResponseTo: 'never',
    // Allow 5 minutes of clock skew between server and IdP
    acceptedClockSkewMs: 5 * 60 * 1000,
  };

  // Optional: sign outgoing SAML requests
  if (config.signRequests && config.spKey) {
    samlOptions.privateKey = config.spKey;
    samlOptions.signatureAlgorithm = 'sha256';
  }

  _saml = new SAML(samlOptions);
  return _saml;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate the SAML AuthnRequest URL.
 * The user's browser should be redirected to this URL.
 *
 * @param {string} [relayState] — Optional state to pass through the IdP (e.g., original URL)
 * @returns {Promise<string>} — The full redirect URL with the AuthnRequest
 */
async function generateLoginUrl(relayState) {
  const config = _getConfig();

  if (!config.entryPoint || !config.cert) {
    throw new Error('SAML is not configured. Set SAML_ENTRY_POINT and SAML_CERT.');
  }

  const saml = _getSAML();

  // getAuthorizeUrlAsync returns the full URL with the SAMLRequest query parameter
  const url = await saml.getAuthorizeUrlAsync(
    relayState || '',
    {},  // request host info (not needed for redirect binding)
    {}   // additional query params
  );

  return url;
}

/**
 * Validate the SAML assertion POSTed by the IdP and extract user profile.
 *
 * @param {object} body — The POST body from the IdP callback (contains SAMLResponse)
 * @returns {Promise<{ success: boolean, user?: object, error?: string }>}
 *
 * On success, returns:
 *   {
 *     success: true,
 *     user: {
 *       externalId: 'user@acme.com',  // SAML NameID
 *       email: 'user@acme.com',
 *       displayName: 'John Doe',
 *       firstName: 'John',
 *       lastName: 'Doe',
 *       groups: ['Developers', 'Engineering'],
 *       rawAttributes: { ... }
 *     }
 *   }
 */
async function validateCallback(body) {
  const config = _getConfig();
  const saml = _getSAML();

  try {
    // validatePostResponseAsync validates the signature, conditions, audience, etc.
    const { profile } = await saml.validatePostResponseAsync(body);

    if (!profile) {
      return { success: false, error: 'SAML assertion validation returned no profile.' };
    }

    // Extract user attributes from the SAML profile
    const user = {
      externalId: profile.nameID || '',
      nameIDFormat: profile.nameIDFormat || '',
      sessionIndex: profile.sessionIndex || '',
      email: _extractAttribute(profile, config.attrEmail) || profile.nameID || '',
      displayName: _extractAttribute(profile, config.attrDisplayName) || '',
      firstName: _extractAttribute(profile, config.attrFirstName) || '',
      lastName: _extractAttribute(profile, config.attrLastName) || '',
      groups: _extractAttributeArray(profile, config.attrGroups),
      rawAttributes: profile.attributes || {},
    };

    // Build display name from first + last if not provided
    if (!user.displayName && (user.firstName || user.lastName)) {
      user.displayName = [user.firstName, user.lastName].filter(Boolean).join(' ');
    }

    return { success: true, user };

  } catch (err) {
    console.error('[Neuron SAML] Assertion validation failed:', err.message);
    return { success: false, error: `SAML validation failed: ${err.message}` };
  }
}

/**
 * Generate the SAML logout URL (Single Logout / SLO).
 *
 * @param {string} nameID — The user's SAML NameID
 * @param {string} sessionIndex — The SAML session index
 * @returns {Promise<string>} — The full SLO redirect URL
 */
async function generateLogoutUrl(nameID, sessionIndex) {
  const config = _getConfig();
  const saml = _getSAML();

  if (!config.logoutUrl) {
    return null; // SLO not configured
  }

  try {
    const url = await saml.getLogoutUrlAsync(
      { nameID, sessionIndex, nameIDFormat: undefined },
      '',  // relayState
      {}   // additional params
    );
    return url;
  } catch (err) {
    console.error('[Neuron SAML] Failed to generate logout URL:', err.message);
    return null;
  }
}

/**
 * Get the SP metadata XML for configuring the IdP.
 *
 * @returns {string} — SAML SP metadata XML
 */
function getMetadata() {
  const config = _getConfig();
  const saml = _getSAML();

  let cert = '';
  if (config.signRequests && config.spCert) {
    cert = config.spCert;
  }

  return saml.generateServiceProviderMetadata(cert || null, cert || null);
}

/**
 * Test SAML configuration by generating a login URL.
 * Used by admin UI to verify settings.
 *
 * @returns {Promise<{ success: boolean, loginUrl?: string, error?: string }>}
 */
async function testSAMLConfiguration() {
  try {
    const url = await generateLoginUrl('test');
    return { success: true, loginUrl: url };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Extract a single attribute value from the SAML profile.
 * Handles both direct profile properties and the attributes object.
 */
function _extractAttribute(profile, attrName) {
  // Check direct profile properties first
  if (profile[attrName]) {
    return Array.isArray(profile[attrName]) ? profile[attrName][0] : profile[attrName];
  }

  // Check in the attributes object
  if (profile.attributes && profile.attributes[attrName]) {
    const val = profile.attributes[attrName];
    return Array.isArray(val) ? val[0] : val;
  }

  // Try short attribute name (some IdPs use short names)
  const shortName = attrName.split('/').pop();
  if (profile[shortName]) {
    return Array.isArray(profile[shortName]) ? profile[shortName][0] : profile[shortName];
  }
  if (profile.attributes && profile.attributes[shortName]) {
    const val = profile.attributes[shortName];
    return Array.isArray(val) ? val[0] : val;
  }

  return null;
}

/**
 * Extract a multi-valued attribute as an array.
 */
function _extractAttributeArray(profile, attrName) {
  const sources = [
    profile[attrName],
    profile.attributes?.[attrName],
    profile[attrName.split('/').pop()],
    profile.attributes?.[attrName.split('/').pop()],
  ];

  for (const val of sources) {
    if (val) {
      return Array.isArray(val) ? val : [val];
    }
  }

  return [];
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  generateLoginUrl,
  validateCallback,
  generateLogoutUrl,
  getMetadata,
  testSAMLConfiguration,
};
```

### File 3: `server/src/routes/auth-sso.js`

Fastify route plugin that registers all SSO endpoints: LDAP login, SAML login/callback, SSO configuration management, and user auto-provisioning.

```javascript
'use strict';

/**
 * Neuron Interceptor — SSO Authentication Routes
 *
 * Routes:
 *   POST /api/auth/sso/ldap          — LDAP username/password login
 *   GET  /api/auth/saml/login        — Redirect to SAML IdP
 *   POST /api/auth/saml/callback     — SAML assertion consumer service (ACS)
 *   GET  /api/auth/saml/metadata     — SP metadata XML for IdP configuration
 *   GET  /api/auth/sso/config        — Get SSO configuration (public, for login UI)
 *   POST /api/auth/sso/test-ldap     — Test LDAP connection (admin only)
 *   POST /api/auth/sso/test-saml     — Test SAML configuration (admin only)
 */

const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { authenticateLDAP, testLDAPConnection } = require('../services/ldap-service');
const {
  generateLoginUrl,
  validateCallback,
  getMetadata,
  testSAMLConfiguration,
} = require('../services/saml-service');

async function ssoRoutes(fastify) {
  const knex = fastify.knex;
  const JWT_SECRET = process.env.JWT_SECRET;
  const SSO_TYPE = (process.env.SSO_TYPE || 'none').toLowerCase();
  const SSO_ALLOW_LOCAL_LOGIN = process.env.SSO_ALLOW_LOCAL_LOGIN !== 'false';
  const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || null;

  // =========================================================================
  // GET /api/auth/sso/config — Public SSO configuration for login UI
  // =========================================================================
  fastify.get('/api/auth/sso/config', async (request, reply) => {
    return reply.send({
      ssoType: SSO_TYPE,
      allowLocalLogin: SSO_ALLOW_LOCAL_LOGIN,
      samlLoginUrl: SSO_TYPE === 'saml' ? '/api/auth/saml/login' : null,
      ldapLoginUrl: SSO_TYPE === 'ldap' ? '/api/auth/sso/ldap' : null,
    });
  });

  // =========================================================================
  // POST /api/auth/sso/ldap — LDAP Login
  // =========================================================================
  fastify.post('/api/auth/sso/ldap', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    if (SSO_TYPE !== 'ldap') {
      return reply.code(400).send({ error: 'LDAP authentication is not enabled.' });
    }

    const { username, password } = request.body;

    // Authenticate against LDAP
    const result = await authenticateLDAP(username, password);

    if (!result.success) {
      return reply.code(401).send({ error: result.error });
    }

    // Auto-provision or update local user
    const user = await _provisionUser(knex, {
      provider: 'ldap',
      externalId: result.user.externalId,
      email: result.user.email,
      displayName: result.user.displayName,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      groups: result.user.groups,
      rawAttributes: result.user.rawAttributes,
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        ssoProvider: 'ldap',
      },
    });
  });

  // =========================================================================
  // GET /api/auth/saml/login — Redirect to SAML IdP
  // =========================================================================
  fastify.get('/api/auth/saml/login', async (request, reply) => {
    if (SSO_TYPE !== 'saml') {
      return reply.code(400).send({ error: 'SAML authentication is not enabled.' });
    }

    try {
      // The relayState can carry the original URL the user was trying to access
      const relayState = request.query.returnTo || '/';
      const loginUrl = await generateLoginUrl(relayState);

      return reply.redirect(302, loginUrl);
    } catch (err) {
      fastify.log.error('SAML login URL generation failed:', err);
      return reply.code(500).send({ error: 'Failed to generate SAML login request.' });
    }
  });

  // =========================================================================
  // POST /api/auth/saml/callback — SAML Assertion Consumer Service (ACS)
  // =========================================================================
  fastify.post('/api/auth/saml/callback', {
    // Do not parse body as JSON — SAML callback is URL-encoded form data
    config: { rawBody: true },
  }, async (request, reply) => {
    if (SSO_TYPE !== 'saml') {
      return reply.code(400).send({ error: 'SAML authentication is not enabled.' });
    }

    try {
      const result = await validateCallback(request.body);

      if (!result.success) {
        fastify.log.error('SAML assertion validation failed:', result.error);
        return reply.code(401).send({ error: result.error });
      }

      // Auto-provision or update local user
      const user = await _provisionUser(knex, {
        provider: 'saml',
        externalId: result.user.externalId,
        email: result.user.email,
        displayName: result.user.displayName,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        groups: result.user.groups,
        rawAttributes: result.user.rawAttributes,
      });

      // Generate JWT
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // Redirect back to the app with the token
      // The extension/app will read the token from the URL fragment
      const relayState = request.body.RelayState || '/';
      const redirectUrl = `${relayState}#token=${token}`;

      return reply.redirect(302, redirectUrl);
    } catch (err) {
      fastify.log.error('SAML callback error:', err);
      return reply.code(500).send({ error: 'SAML authentication failed.' });
    }
  });

  // =========================================================================
  // GET /api/auth/saml/metadata — SP Metadata XML
  // =========================================================================
  fastify.get('/api/auth/saml/metadata', async (request, reply) => {
    if (SSO_TYPE !== 'saml') {
      return reply.code(400).send({ error: 'SAML is not enabled.' });
    }

    const metadata = getMetadata();
    return reply.type('application/xml').send(metadata);
  });

  // =========================================================================
  // POST /api/auth/sso/test-ldap — Test LDAP Connection (admin only)
  // =========================================================================
  fastify.post('/api/auth/sso/test-ldap', {
    preHandler: [requireAdmin],
  }, async (request, reply) => {
    const result = await testLDAPConnection();
    return reply.send(result);
  });

  // =========================================================================
  // POST /api/auth/sso/test-saml — Test SAML Configuration (admin only)
  // =========================================================================
  fastify.post('/api/auth/sso/test-saml', {
    preHandler: [requireAdmin],
  }, async (request, reply) => {
    const result = await testSAMLConfiguration();
    return reply.send(result);
  });

  // =========================================================================
  // Internal: Auto-provision or update a user from SSO attributes
  // =========================================================================

  /**
   * Find or create a local user from SSO attributes.
   * If the user already exists (matched by sso_provider + sso_external_id, or by email),
   * update their profile. Otherwise create a new account.
   *
   * @param {object} knex — Database connection
   * @param {object} ssoUser — User attributes from SSO provider
   * @returns {Promise<object>} — The local user record
   */
  async function _provisionUser(knex, ssoUser) {
    const now = new Date();

    // Try to find by SSO external ID first (most reliable)
    let user = await knex('users')
      .where({ sso_provider: ssoUser.provider, sso_external_id: ssoUser.externalId })
      .first();

    if (user) {
      // Update existing SSO user
      await knex('users').where({ id: user.id }).update({
        display_name: ssoUser.displayName || user.display_name,
        sso_attributes: JSON.stringify(ssoUser.rawAttributes),
        last_sso_login_at: now,
        updated_at: now,
      });
      user.display_name = ssoUser.displayName || user.display_name;
      return user;
    }

    // Try to find by email (for linking existing local accounts to SSO)
    user = await knex('users').where({ email: ssoUser.email }).first();

    if (user) {
      // Link existing account to SSO
      await knex('users').where({ id: user.id }).update({
        sso_provider: ssoUser.provider,
        sso_external_id: ssoUser.externalId,
        sso_attributes: JSON.stringify(ssoUser.rawAttributes),
        last_sso_login_at: now,
        display_name: ssoUser.displayName || user.display_name,
        updated_at: now,
      });
      user.sso_provider = ssoUser.provider;
      return user;
    }

    // Create new user
    const userId = uuidv4();
    const newUser = {
      id: userId,
      email: ssoUser.email,
      display_name: ssoUser.displayName || ssoUser.email.split('@')[0],
      password_hash: null,  // SSO users don't have a local password
      role: 'member',
      is_active: true,
      sso_provider: ssoUser.provider,
      sso_external_id: ssoUser.externalId,
      sso_attributes: JSON.stringify(ssoUser.rawAttributes),
      last_sso_login_at: now,
      created_at: now,
      updated_at: now,
    };

    await knex('users').insert(newUser);

    // Add to default workspace (if configured)
    if (DEFAULT_WORKSPACE_ID) {
      await knex('workspace_members').insert({
        id: uuidv4(),
        workspace_id: DEFAULT_WORKSPACE_ID,
        user_id: userId,
        role: 'member',
        created_at: now,
      }).onConflict(['workspace_id', 'user_id']).ignore();
    }

    return newUser;
  }

  /**
   * Middleware: require admin role.
   */
  async function requireAdmin(request, reply) {
    // This assumes an auth middleware has already set request.user
    if (!request.user || request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin access required.' });
    }
  }
}

module.exports = ssoRoutes;
```

### Admin SSO Configuration UI

In the extension options page settings section, add SSO configuration controls. This UI is shown to workspace admins connected to an on-prem backend.

Add to `options/components/settings.js`:

```javascript
/**
 * Render the SSO configuration section in the admin settings panel.
 *
 * @param {HTMLElement} container — Parent element
 * @param {string} backendUrl — The on-prem backend URL
 */
async function renderSSOConfig(container, backendUrl) {
  const card = document.createElement('div');
  card.className = 'ni-sso-config-card';
  card.style.cssText = `
    background: var(--bg-overlay, #181825);
    border: 1px solid var(--border, #45475a);
    border-radius: 12px;
    padding: 20px;
    margin-top: 16px;
  `;

  // Header
  const header = document.createElement('h3');
  header.textContent = 'Single Sign-On (SSO)';
  header.style.cssText = 'margin: 0 0 16px 0; color: var(--text, #cdd6f4); font-size: 16px; font-weight: 600;';
  card.appendChild(header);

  // SSO Type selector
  const typeRow = _createConfigRow('SSO Type', 'select', 'sso-type', [
    { value: 'none', label: 'Disabled (email/password only)' },
    { value: 'ldap', label: 'LDAP / Active Directory' },
    { value: 'saml', label: 'SAML 2.0' },
  ]);
  card.appendChild(typeRow.row);

  // LDAP fields container
  const ldapFields = document.createElement('div');
  ldapFields.className = 'ni-sso-ldap-fields';
  ldapFields.style.display = 'none';
  ldapFields.innerHTML = `
    <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border, #45475a);">
      <h4 style="margin: 0 0 12px 0; color: var(--text, #cdd6f4); font-size: 14px;">LDAP Configuration</h4>
    </div>
  `;

  const ldapConfigs = [
    { label: 'LDAP URL', key: 'ldap-url', placeholder: 'ldap://ldap.acme.com:389' },
    { label: 'Bind DN', key: 'ldap-bind-dn', placeholder: 'cn=admin,dc=acme,dc=com' },
    { label: 'Bind Password', key: 'ldap-bind-password', placeholder: 'service-account-password', type: 'password' },
    { label: 'Search Base', key: 'ldap-search-base', placeholder: 'ou=people,dc=acme,dc=com' },
    { label: 'Search Filter', key: 'ldap-search-filter', placeholder: '(uid={{username}})' },
    { label: 'Required Group (optional)', key: 'ldap-required-group', placeholder: 'cn=neuron-users,ou=groups,dc=acme,dc=com' },
  ];

  for (const cfg of ldapConfigs) {
    const row = _createConfigRow(cfg.label, cfg.type || 'text', cfg.key, null, cfg.placeholder);
    ldapFields.appendChild(row.row);
  }

  // Test LDAP button
  const testLdapBtn = document.createElement('button');
  testLdapBtn.textContent = 'Test LDAP Connection';
  testLdapBtn.className = 'ni-btn ni-btn-secondary';
  testLdapBtn.style.cssText = 'margin-top: 12px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; font-size: 13px;';
  testLdapBtn.addEventListener('click', async () => {
    testLdapBtn.textContent = 'Testing...';
    try {
      const token = localStorage.getItem('neuron_auth_token');
      const res = await fetch(`${backendUrl}/api/auth/sso/test-ldap`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      testLdapBtn.textContent = data.success ? 'Connection OK' : `Failed: ${data.error}`;
      testLdapBtn.style.color = data.success ? '#a6e3a1' : '#f38ba8';
    } catch (err) {
      testLdapBtn.textContent = `Error: ${err.message}`;
      testLdapBtn.style.color = '#f38ba8';
    }
    setTimeout(() => {
      testLdapBtn.textContent = 'Test LDAP Connection';
      testLdapBtn.style.color = 'var(--text)';
    }, 5000);
  });
  ldapFields.appendChild(testLdapBtn);
  card.appendChild(ldapFields);

  // SAML fields container
  const samlFields = document.createElement('div');
  samlFields.className = 'ni-sso-saml-fields';
  samlFields.style.display = 'none';
  samlFields.innerHTML = `
    <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border, #45475a);">
      <h4 style="margin: 0 0 12px 0; color: var(--text, #cdd6f4); font-size: 14px;">SAML 2.0 Configuration</h4>
    </div>
  `;

  const samlConfigs = [
    { label: 'IdP Entry Point (SSO URL)', key: 'saml-entry-point', placeholder: 'https://idp.acme.com/sso/saml' },
    { label: 'Issuer / Entity ID', key: 'saml-issuer', placeholder: 'neuron-interceptor' },
    { label: 'IdP Certificate (Base64)', key: 'saml-cert', placeholder: 'MIICpDCCAYwCCQD...' },
    { label: 'Callback URL', key: 'saml-callback-url', placeholder: 'https://neuron.acme.com/api/auth/saml/callback' },
    { label: 'Logout URL (optional)', key: 'saml-logout-url', placeholder: 'https://idp.acme.com/sso/logout' },
  ];

  for (const cfg of samlConfigs) {
    const row = _createConfigRow(cfg.label, 'text', cfg.key, null, cfg.placeholder);
    samlFields.appendChild(row.row);
  }

  // Metadata download link
  const metadataLink = document.createElement('a');
  metadataLink.textContent = 'Download SP Metadata XML';
  metadataLink.href = `${backendUrl}/api/auth/saml/metadata`;
  metadataLink.target = '_blank';
  metadataLink.style.cssText = 'display: inline-block; margin-top: 12px; color: var(--accent, #89b4fa); font-size: 13px; text-decoration: underline; cursor: pointer;';
  samlFields.appendChild(metadataLink);

  // Test SAML button
  const testSamlBtn = document.createElement('button');
  testSamlBtn.textContent = 'Test SAML Configuration';
  testSamlBtn.className = 'ni-btn ni-btn-secondary';
  testSamlBtn.style.cssText = 'margin-top: 12px; margin-left: 16px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; font-size: 13px;';
  testSamlBtn.addEventListener('click', async () => {
    testSamlBtn.textContent = 'Testing...';
    try {
      const token = localStorage.getItem('neuron_auth_token');
      const res = await fetch(`${backendUrl}/api/auth/sso/test-saml`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      testSamlBtn.textContent = data.success ? 'Configuration OK' : `Failed: ${data.error}`;
      testSamlBtn.style.color = data.success ? '#a6e3a1' : '#f38ba8';
    } catch (err) {
      testSamlBtn.textContent = `Error: ${err.message}`;
      testSamlBtn.style.color = '#f38ba8';
    }
    setTimeout(() => {
      testSamlBtn.textContent = 'Test SAML Configuration';
      testSamlBtn.style.color = 'var(--text)';
    }, 5000);
  });
  samlFields.appendChild(testSamlBtn);
  card.appendChild(samlFields);

  // Toggle visibility based on SSO type
  const typeSelect = typeRow.row.querySelector('select');
  typeSelect.addEventListener('change', () => {
    ldapFields.style.display = typeSelect.value === 'ldap' ? 'block' : 'none';
    samlFields.style.display = typeSelect.value === 'saml' ? 'block' : 'none';
  });

  container.appendChild(card);
}

/**
 * Helper: create a labeled configuration row with an input or select.
 */
function _createConfigRow(label, type, key, options, placeholder) {
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 10px;';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  labelEl.style.cssText = 'min-width: 180px; color: var(--text-muted, #a6adc8); font-size: 13px;';
  row.appendChild(labelEl);

  let input;
  if (type === 'select' && options) {
    input = document.createElement('select');
    input.style.cssText = 'flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-overlay); color: var(--text); font-size: 13px;';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      input.appendChild(o);
    }
  } else {
    input = document.createElement('input');
    input.type = type || 'text';
    input.placeholder = placeholder || '';
    input.style.cssText = 'flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-overlay); color: var(--text); font-size: 13px;';
  }

  input.id = `ni-sso-${key}`;
  row.appendChild(input);

  return { row, input };
}
```

## Verification

### LDAP Verification

1. **Set up test LDAP server** (using Docker for testing):
   ```bash
   docker run -d --name test-ldap -p 389:389 \
     -e LDAP_ORGANISATION="Test Corp" \
     -e LDAP_DOMAIN="test.com" \
     -e LDAP_ADMIN_PASSWORD="admin" \
     osixia/openldap:1.5.0
   ```

2. **Add a test user**:
   ```bash
   docker exec test-ldap ldapadd -x -D "cn=admin,dc=test,dc=com" -w admin <<EOF
   dn: uid=jdoe,dc=test,dc=com
   objectClass: inetOrgPerson
   cn: John Doe
   sn: Doe
   givenName: John
   uid: jdoe
   mail: jdoe@test.com
   userPassword: password123
   EOF
   ```

3. **Configure the server**:
   ```bash
   SSO_TYPE=ldap
   LDAP_URL=ldap://localhost:389
   LDAP_BIND_DN=cn=admin,dc=test,dc=com
   LDAP_BIND_PASSWORD=admin
   LDAP_SEARCH_BASE=dc=test,dc=com
   LDAP_SEARCH_FILTER=(uid={{username}})
   ```

4. **Test LDAP login**:
   ```bash
   curl -X POST http://localhost:3001/api/auth/sso/ldap \
     -H "Content-Type: application/json" \
     -d '{"username":"jdoe","password":"password123"}'
   # Expected: {"token":"eyJ...","user":{"email":"jdoe@test.com","displayName":"John Doe","ssoProvider":"ldap"}}
   ```

5. **Test invalid credentials**:
   ```bash
   curl -X POST http://localhost:3001/api/auth/sso/ldap \
     -H "Content-Type: application/json" \
     -d '{"username":"jdoe","password":"wrongpassword"}'
   # Expected: 401 {"error":"Invalid credentials."}
   ```

6. **Verify user auto-provisioned in database**:
   ```sql
   SELECT id, email, display_name, sso_provider, sso_external_id FROM users WHERE sso_provider = 'ldap';
   -- Expected: jdoe@test.com | John Doe | ldap | uid=jdoe,dc=test,dc=com
   ```

### SAML Verification

1. **Set up test SAML IdP** (using saml-idp for testing):
   ```bash
   npx saml-idp \
     --port 7000 \
     --issuer "test-idp" \
     --audience "neuron-interceptor" \
     --acsUrl "http://localhost:3001/api/auth/saml/callback"
   ```

2. **Configure the server**:
   ```bash
   SSO_TYPE=saml
   SAML_ENTRY_POINT=http://localhost:7000/saml/sso
   SAML_ISSUER=neuron-interceptor
   SAML_CERT=<copy from test IdP output>
   SAML_CALLBACK_URL=http://localhost:3001/api/auth/saml/callback
   ```

3. **Test SAML login flow**:
   ```
   Open: http://localhost:3001/api/auth/saml/login
   Expected: Redirect to test IdP login page (http://localhost:7000/saml/sso?SAMLRequest=...)
   Enter test credentials → IdP posts assertion to callback URL
   Expected: Redirect to /#token=eyJ... with valid JWT
   ```

4. **Verify SP metadata**:
   ```bash
   curl http://localhost:3001/api/auth/saml/metadata
   # Expected: XML with AssertionConsumerService location, issuer, etc.
   ```

5. **Verify user auto-provisioned**:
   ```sql
   SELECT id, email, sso_provider, sso_external_id FROM users WHERE sso_provider = 'saml';
   ```

### Admin UI Verification

1. Open extension Options page, navigate to Settings
2. Confirm "Single Sign-On (SSO)" section is visible
3. Select "LDAP" from SSO Type dropdown -- LDAP configuration fields appear
4. Select "SAML 2.0" -- SAML configuration fields appear, LDAP fields hide
5. Click "Test LDAP Connection" -- shows success/failure message
6. Click "Test SAML Configuration" -- shows success/failure message
7. Click "Download SP Metadata XML" -- opens XML in new tab

### SSO Login Page Verification

1. With `SSO_TYPE=ldap`, the login page shows:
   - "SSO Login" button that shows username + password fields
   - Optional "Use email/password instead" link (if `SSO_ALLOW_LOCAL_LOGIN=true`)

2. With `SSO_TYPE=saml`, the login page shows:
   - "Sign in with SSO" button that redirects to the IdP
   - Optional "Use email/password instead" link

3. With `SSO_TYPE=none`, the login page shows only the standard email/password form
