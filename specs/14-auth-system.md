# Feature 3.2: Complete Authentication System

## Summary

Implement full email/password and Google OAuth authentication, integrating the backend auth endpoints (from spec 13) with the Chrome extension. Includes JWT lifecycle management in the service worker, auto-refresh logic, login UI in the popup, and user profile display in the options page.

## Why

Cloud sync, team workspaces, and billing all require authenticated users. The extension must securely store and manage JWT tokens, auto-refresh before expiry, and provide a seamless login/logout experience without interrupting the user's interceptor workflow.

## Dependencies

- **Spec 13 (Backend API Server)**: Must be implemented first. This spec uses the `/auth/*` endpoints, the JWT middleware, and the user/workspace models defined there.

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Server location**: `health_check/utils/neuron-interceptor-plugin/server/`
- **Service worker**: `service-worker/sw.js` -- main entry point, imports `handleMessage` from `message-router.js`
- **Message router**: `service-worker/message-router.js` -- routes MSG_TYPES to handlers
- **Storage manager**: `service-worker/storage-manager.js` -- chrome.storage.local + IndexedDB
- **Popup**: `popup/popup.html` + `popup/popup.js` -- browser action popup with toggle, stats, recent intercepts
- **Options**: `options/options.html` + `options/options.js` -- full options page with sidebar navigation
- **Shared constants**: `shared/constants.js` -- MSG_TYPES, STORAGE_KEYS, etc.
- **Theme**: Catppuccin Mocha palette (CSS variables in `options/options.css`)

### Existing MSG_TYPES (from shared/constants.js):
```javascript
GET_RULES, SET_RULES, GET_SETTINGS, SET_SETTINGS, TOGGLE_ENABLED,
GET_STATUS, LOG_REQUEST, GET_LOGS, CLEAR_LOGS, RULES_UPDATED,
GET_MOCK_COLLECTIONS, SET_MOCK_COLLECTIONS, EXPORT_ALL, IMPORT_ALL,
UPDATE_DNR_RULES
```

### Existing STORAGE_KEYS (from shared/constants.js):
```javascript
RULES, MOCK_COLLECTIONS, SETTINGS, INTERCEPTOR_ENABLED
```

## Implementation

### Step 1: Add New Constants to `shared/constants.js`

Add these new MSG_TYPES at the end of the existing MSG_TYPES object:

```javascript
// --- Auth (spec 14) ---
LOGIN:            'LOGIN',
LOGOUT:           'LOGOUT',
GET_AUTH_STATE:    'GET_AUTH_STATE',
REFRESH_TOKEN:    'REFRESH_TOKEN',
OAUTH_GOOGLE:     'OAUTH_GOOGLE',
REGISTER:         'REGISTER',
```

Add these new STORAGE_KEYS at the end of the existing STORAGE_KEYS object:

```javascript
AUTH_STATE: 'neuron_auth_state',
```

Add a new constant for the backend API URL:

```javascript
/** Backend API base URL. Override via settings for on-prem. */
export const API_BASE_URL = 'http://localhost:3001';
```

### Step 2: Create `service-worker/auth-manager.js`

This new file manages the entire auth lifecycle in the service worker.

```javascript
/**
 * auth-manager.js
 *
 * Manages authentication state in the Neuron Interceptor service worker.
 *
 * Responsibilities:
 *  1. Store/retrieve auth tokens in chrome.storage.local
 *  2. Auto-refresh access tokens before expiry
 *  3. Handle login, logout, registration, and Google OAuth
 *  4. Provide auth state to popup, options, and content scripts via messages
 */

import { STORAGE_KEYS, API_BASE_URL } from '../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Internal state                                                            */
/* -------------------------------------------------------------------------- */

let _authState = {
  user: null,
  accessToken: null,
  refreshToken: null,
  expiresAt: null,  // Unix timestamp (ms) when accessToken expires
  isLoggedIn: false,
};

let _refreshTimer = null;

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Load auth state from chrome.storage.local on startup.
 */
export async function loadAuthState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH_STATE);
    const saved = result[STORAGE_KEYS.AUTH_STATE];
    if (saved && saved.accessToken) {
      _authState = { ...saved, isLoggedIn: true };
      _scheduleRefresh();
      console.log('[NeuronAuth] Auth state loaded from storage');
    }
  } catch (err) {
    console.warn('[NeuronAuth] Failed to load auth state:', err);
  }
}

/**
 * Persist current auth state to chrome.storage.local.
 */
async function _persistAuthState() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH_STATE]: {
        user: _authState.user,
        accessToken: _authState.accessToken,
        refreshToken: _authState.refreshToken,
        expiresAt: _authState.expiresAt,
      },
    });
  } catch (err) {
    console.warn('[NeuronAuth] Failed to persist auth state:', err);
  }
}

/**
 * Clear auth state from memory and storage.
 */
async function _clearAuthState() {
  _authState = {
    user: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    isLoggedIn: false,
  };
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.AUTH_STATE);
  } catch (err) {
    console.warn('[NeuronAuth] Failed to clear auth state:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  JWT Parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Decode a JWT payload without verification (client-side only for expiry check).
 * @param {string} token
 * @returns {Object|null}
 */
function _decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract expiry timestamp (ms) from a JWT.
 * @param {string} token
 * @returns {number|null}
 */
function _getTokenExpiry(token) {
  const payload = _decodeJWT(token);
  if (payload && payload.exp) {
    return payload.exp * 1000; // Convert seconds to ms
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Auto-Refresh                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Schedule a token refresh 2 minutes before the access token expires.
 * If the token expires in < 2 minutes, refresh immediately.
 */
function _scheduleRefresh() {
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }

  if (!_authState.accessToken || !_authState.expiresAt) return;

  const now = Date.now();
  const refreshAt = _authState.expiresAt - 2 * 60 * 1000; // 2 min before expiry
  const delay = Math.max(0, refreshAt - now);

  console.log(`[NeuronAuth] Token refresh scheduled in ${Math.round(delay / 1000)}s`);

  _refreshTimer = setTimeout(async () => {
    try {
      await refreshTokens();
      console.log('[NeuronAuth] Token auto-refreshed successfully');
    } catch (err) {
      console.warn('[NeuronAuth] Auto-refresh failed:', err);
      // Token expired and refresh failed — log out
      await _clearAuthState();
    }
  }, delay);
}

/**
 * Periodic check — runs every 5 minutes from the service worker alarm.
 * If token expires in < 2 minutes, trigger a refresh.
 */
export async function checkTokenExpiry() {
  if (!_authState.isLoggedIn || !_authState.expiresAt) return;

  const now = Date.now();
  const remaining = _authState.expiresAt - now;

  if (remaining < 2 * 60 * 1000) {
    console.log('[NeuronAuth] Token expiring soon, refreshing...');
    try {
      await refreshTokens();
    } catch (err) {
      console.warn('[NeuronAuth] Periodic refresh failed:', err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  API Helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Get the current API base URL (may be overridden via settings for on-prem).
 * @returns {string}
 */
function _getApiUrl() {
  // In future, check settings for custom API URL
  return API_BASE_URL;
}

/**
 * Make an authenticated fetch request to the backend API.
 * @param {string} path - API path (e.g., '/auth/me')
 * @param {Object} [options] - fetch options
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function apiFetch(path, options = {}) {
  const url = `${_getApiUrl()}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (_authState.accessToken) {
    headers['Authorization'] = `Bearer ${_authState.accessToken}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const err = new Error(body.error || body.message || `API error ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  return response.json();
}

/* -------------------------------------------------------------------------- */
/*  Auth Operations                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Register a new user.
 * @param {Object} data - { email, password, name }
 * @returns {Promise<Object>} { user, accessToken, refreshToken }
 */
export async function register(data) {
  const result = await apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  _authState = {
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: _getTokenExpiry(result.accessToken),
    isLoggedIn: true,
  };

  await _persistAuthState();
  _scheduleRefresh();

  return { user: result.user };
}

/**
 * Login with email and password.
 * @param {Object} data - { email, password }
 * @returns {Promise<Object>} { user }
 */
export async function login(data) {
  const result = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  _authState = {
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: _getTokenExpiry(result.accessToken),
    isLoggedIn: true,
  };

  await _persistAuthState();
  _scheduleRefresh();

  return { user: result.user };
}

/**
 * Logout — revoke refresh token on backend and clear local state.
 */
export async function logout() {
  try {
    if (_authState.refreshToken) {
      await apiFetch('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: _authState.refreshToken }),
      });
    }
  } catch (err) {
    console.warn('[NeuronAuth] Server logout failed (continuing local logout):', err);
  }

  await _clearAuthState();
}

/**
 * Refresh the JWT token pair.
 * @returns {Promise<void>}
 */
export async function refreshTokens() {
  if (!_authState.refreshToken) {
    throw new Error('No refresh token available');
  }

  const result = await apiFetch('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: _authState.refreshToken }),
  });

  _authState.accessToken = result.accessToken;
  _authState.refreshToken = result.refreshToken;
  _authState.expiresAt = _getTokenExpiry(result.accessToken);

  await _persistAuthState();
  _scheduleRefresh();
}

/**
 * Google OAuth flow.
 * Opens Google consent screen via chrome.identity.launchWebAuthFlow,
 * then exchanges the auth code with the backend.
 *
 * @returns {Promise<Object>} { user }
 */
export async function googleOAuth() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const clientId = ''; // Will be set from config or settings

  // Construct Google OAuth URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('scope', 'email profile');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  // Launch the OAuth flow in a browser tab
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (callbackUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(callbackUrl);
        }
      }
    );
  });

  // Extract the authorization code from the callback URL
  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code received from Google');
  }

  // Exchange the code with our backend
  const result = await apiFetch('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ code, redirectUri: redirectUrl }),
  });

  _authState = {
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: _getTokenExpiry(result.accessToken),
    isLoggedIn: true,
  };

  await _persistAuthState();
  _scheduleRefresh();

  return { user: result.user };
}

/**
 * Get the current auth state (safe copy, no tokens exposed to UI).
 * @returns {Object}
 */
export function getAuthState() {
  return {
    isLoggedIn: _authState.isLoggedIn,
    user: _authState.user,
    expiresAt: _authState.expiresAt,
  };
}

/**
 * Get the current access token (for sync-manager to use in API calls).
 * @returns {string|null}
 */
export function getAccessToken() {
  return _authState.accessToken;
}
```

### Step 3: Add Google OAuth Route to Backend `server/src/routes/auth.js`

Add this route inside the existing `authRoutes` function, after the `/auth/logout` route:

```javascript
  /* ---- POST /auth/google ---- */
  fastify.post('/google', {
    preHandler: [authRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['code', 'redirectUri'],
        properties: {
          code: { type: 'string' },
          redirectUri: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { code, redirectUri } = request.body;
      const db = fastify.db;

      // Exchange authorization code for Google tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const err = await tokenResponse.json().catch(() => ({}));
        return reply.code(401).send({
          error: 'Google OAuth failed',
          message: err.error_description || 'Failed to exchange authorization code',
        });
      }

      const tokens = await tokenResponse.json();

      // Get user info from Google
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userInfoResponse.ok) {
        return reply.code(401).send({ error: 'Failed to get Google user info' });
      }

      const googleUser = await userInfoResponse.json();

      // Find or create user
      let user = await UserModel.findByGoogleId(db, googleUser.id);

      if (!user) {
        // Check if email already registered (link accounts)
        user = await UserModel.findByEmail(db, googleUser.email);

        if (user) {
          // Link Google ID to existing account
          user = await UserModel.updateUser(db, user.id, {
            google_id: googleUser.id,
            avatar_url: googleUser.picture || user.avatar_url,
          });
        } else {
          // Create new user
          user = await UserModel.createUser(db, {
            email: googleUser.email.toLowerCase(),
            name: googleUser.name || googleUser.email.split('@')[0],
            google_id: googleUser.id,
            avatar_url: googleUser.picture || null,
          });

          // Create default workspace
          await WorkspaceModel.createWorkspace(db, {
            name: 'Personal',
            owner_id: user.id,
          });
        }
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
```

**Import needed**: Add `import config from '../config/index.js';` at the top of `server/src/routes/auth.js`.

### Step 4: Modify `service-worker/sw.js`

Add auth manager initialization after the existing imports:

```javascript
import { loadAuthState, checkTokenExpiry } from './auth-manager.js';
```

In the `chrome.runtime.onInstalled.addListener` callback, after the existing IndexedDB init and default settings, add:

```javascript
  // Load persisted auth state
  try {
    await loadAuthState();
    console.log('[NeuronInterceptor] Auth state loaded');
  } catch (err) {
    console.warn('[NeuronInterceptor] Auth state load failed', err);
  }
```

After the storage change listener, add an alarm for periodic token refresh:

```javascript
/* -------------------------------------------------------------------------- */
/*  Periodic token refresh alarm                                              */
/* -------------------------------------------------------------------------- */

chrome.alarms.create('neuron-token-refresh', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'neuron-token-refresh') {
    await checkTokenExpiry();
  }
});
```

Also load auth state on service worker startup (outside the onInstalled handler, since the SW may restart without triggering onInstalled):

```javascript
/* -------------------------------------------------------------------------- */
/*  Service worker startup — reload auth state                                */
/* -------------------------------------------------------------------------- */

loadAuthState().catch((err) => {
  console.warn('[NeuronInterceptor] Startup auth state load failed', err);
});
```

**manifest.json change**: Add `"alarms"` to the `permissions` array so the periodic refresh alarm works.

### Step 5: Modify `service-worker/message-router.js`

Add auth message handling. First, add the import at the top:

```javascript
import {
  login,
  logout,
  register,
  getAuthState,
  refreshTokens,
  googleOAuth,
} from './auth-manager.js';
```

Then add these cases to the `_route()` switch statement, before the `default` case:

```javascript
    /* ---- Auth ---- */
    case MSG_TYPES.LOGIN:
      return login(payload);

    case MSG_TYPES.LOGOUT:
      await logout();
      return { ok: true };

    case MSG_TYPES.REGISTER:
      return register(payload);

    case MSG_TYPES.GET_AUTH_STATE:
      return getAuthState();

    case MSG_TYPES.REFRESH_TOKEN:
      await refreshTokens();
      return { ok: true };

    case MSG_TYPES.OAUTH_GOOGLE:
      return googleOAuth();
```

### Step 6: Modify `popup/popup.html`

Add a login section and user info display. Replace the existing `<footer>` section and add auth UI elements. The changes to `popup.html`:

After the `<!-- Recent Intercepts -->` section and before the existing `<!-- Footer -->`, add:

```html
  <!-- Auth Section -->
  <div class="auth-section" id="authSection">
    <!-- Logged out state -->
    <div class="auth-logged-out" id="authLoggedOut">
      <div class="auth-divider"></div>
      <button class="auth-btn auth-btn-login" id="loginBtn">Sign In</button>
      <button class="auth-btn auth-btn-google" id="googleLoginBtn">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M15.68 8.18c0-.57-.05-1.11-.15-1.64H8v3.1h4.3a3.68 3.68 0 01-1.6 2.41v2h2.6c1.52-1.4 2.38-3.46 2.38-5.87z" fill="#4285F4"/>
          <path d="M8 16c2.16 0 3.97-.72 5.3-1.94l-2.6-2a5.03 5.03 0 01-7.48-2.63H.58v2.06A8 8 0 008 16z" fill="#34A853"/>
          <path d="M3.22 9.43a4.82 4.82 0 010-2.86V4.51H.58a8 8 0 000 6.98l2.64-2.06z" fill="#FBBC05"/>
          <path d="M8 3.18c1.22 0 2.31.42 3.17 1.24l2.37-2.37A7.96 7.96 0 008 0 8 8 0 00.58 4.51l2.64 2.06A4.77 4.77 0 018 3.18z" fill="#EA4335"/>
        </svg>
        Google
      </button>
    </div>

    <!-- Logged in state -->
    <div class="auth-logged-in hidden" id="authLoggedIn">
      <div class="auth-divider"></div>
      <div class="auth-user-row">
        <img class="auth-avatar" id="userAvatar" src="" alt="" width="24" height="24">
        <span class="auth-user-name" id="userName"></span>
        <button class="auth-logout-btn" id="logoutBtn" title="Sign Out">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>
  </div>
```

Replace the footer to include a sync indicator:

```html
  <!-- Footer -->
  <footer class="footer">
    <a href="#" id="optionsLink" class="footer-link">Options</a>
    <span class="sync-indicator" id="syncIndicator" title="Not connected">
      <span class="sync-dot sync-dot-offline"></span>
    </span>
    <a href="#" id="clearLogsLink" class="footer-link">Clear Logs</a>
  </footer>
```

### Step 7: Add Auth CSS to `popup/popup.css`

Append these styles at the end of `popup/popup.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Auth Section                                                              */
/* -------------------------------------------------------------------------- */

.auth-section {
  flex-shrink: 0;
  padding: 0 12px 4px;
}

.auth-divider {
  height: 1px;
  background: #45475a;
  margin-bottom: 8px;
}

.auth-logged-out {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.auth-btn {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid #45475a;
  border-radius: 6px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.auth-btn-login {
  background: #89b4fa;
  color: #1e1e2e;
  border-color: #89b4fa;
}

.auth-btn-login:hover {
  background: #9fc5fb;
  border-color: #9fc5fb;
}

.auth-btn-google {
  background: transparent;
  color: #cdd6f4;
}

.auth-btn-google:hover {
  background: #313244;
  border-color: #585b70;
}

/* Logged-in user row */
.auth-user-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.auth-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #313244;
  flex-shrink: 0;
}

.auth-user-name {
  flex: 1 1 0;
  font-size: 12px;
  font-weight: 600;
  color: #cdd6f4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auth-logout-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  color: #a6adc8;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.auth-logout-btn:hover {
  background: #313244;
  color: #f38ba8;
}

/* Sync indicator */
.sync-indicator {
  display: flex;
  align-items: center;
  padding: 2px 6px;
}

.sync-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background-color 0.3s ease;
}

.sync-dot-online    { background: #a6e3a1; box-shadow: 0 0 4px rgba(166, 227, 161, 0.4); }
.sync-dot-syncing   { background: #f9e2af; animation: pulse 1s infinite; }
.sync-dot-offline   { background: #585b70; }
.sync-dot-error     { background: #f38ba8; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Login modal overlay (for email/password form in popup) */
.login-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-modal {
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 20px;
  width: 320px;
  max-width: 90%;
}

.login-modal h3 {
  font-size: 15px;
  font-weight: 700;
  color: #cdd6f4;
  margin-bottom: 14px;
  text-align: center;
}

.login-modal .form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.login-modal label {
  font-size: 11px;
  font-weight: 600;
  color: #a6adc8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.login-modal input {
  padding: 8px 10px;
  border: 1px solid #45475a;
  border-radius: 4px;
  background: #181825;
  color: #cdd6f4;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease;
}

.login-modal input:focus {
  border-color: #89b4fa;
}

.login-modal .login-submit {
  width: 100%;
  padding: 9px;
  margin-top: 6px;
  border: none;
  border-radius: 6px;
  background: #89b4fa;
  color: #1e1e2e;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.login-modal .login-submit:hover {
  background: #9fc5fb;
}

.login-modal .login-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-modal .login-error {
  color: #f38ba8;
  font-size: 12px;
  margin-top: 6px;
  text-align: center;
  min-height: 16px;
}

.login-modal .login-toggle-link {
  display: block;
  text-align: center;
  margin-top: 10px;
  color: #89b4fa;
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
}

.login-modal .login-toggle-link:hover {
  text-decoration: underline;
}
```

### Step 8: Modify `popup/popup.js`

Add auth functionality to the popup. Add these MSG_TYPES to the existing constant block:

```javascript
const MSG_TYPES = {
  GET_STATUS:      'GET_STATUS',
  TOGGLE_ENABLED:  'TOGGLE_ENABLED',
  GET_LOGS:        'GET_LOGS',
  CLEAR_LOGS:      'CLEAR_LOGS',
  LOGIN:           'LOGIN',
  LOGOUT:          'LOGOUT',
  GET_AUTH_STATE:   'GET_AUTH_STATE',
  REGISTER:        'REGISTER',
  OAUTH_GOOGLE:    'OAUTH_GOOGLE',
};
```

Add new DOM references after the existing ones:

```javascript
const $authLoggedOut   = document.getElementById('authLoggedOut');
const $authLoggedIn    = document.getElementById('authLoggedIn');
const $loginBtn        = document.getElementById('loginBtn');
const $googleLoginBtn  = document.getElementById('googleLoginBtn');
const $logoutBtn       = document.getElementById('logoutBtn');
const $userName        = document.getElementById('userName');
const $userAvatar      = document.getElementById('userAvatar');
const $syncIndicator   = document.getElementById('syncIndicator');
```

Add auth rendering functions:

```javascript
/* -------------------------------------------------------------------------- */
/*  Auth rendering                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Update the popup UI to reflect the current auth state.
 * @param {Object} authState - { isLoggedIn, user }
 */
function renderAuthState(authState) {
  if (authState && authState.isLoggedIn && authState.user) {
    $authLoggedOut.classList.add('hidden');
    $authLoggedIn.classList.remove('hidden');
    $userName.textContent = authState.user.name || authState.user.email;

    if (authState.user.avatar_url) {
      $userAvatar.src = authState.user.avatar_url;
      $userAvatar.style.display = 'block';
    } else {
      // Show initials as fallback
      $userAvatar.style.display = 'none';
    }
  } else {
    $authLoggedOut.classList.remove('hidden');
    $authLoggedIn.classList.add('hidden');
  }
}

/**
 * Fetch auth state from service worker and render.
 */
async function refreshAuthState() {
  try {
    const response = await sendMsg(MSG_TYPES.GET_AUTH_STATE);
    const authState = response?.data || response;
    renderAuthState(authState);
  } catch (err) {
    console.warn('[NeuronPopup] Failed to get auth state:', err);
    renderAuthState(null);
  }
}

/**
 * Show the login/register modal inside the popup.
 * @param {'login'|'register'} mode
 */
function showLoginModal(mode = 'login') {
  // Remove any existing modal
  const existing = document.querySelector('.login-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'login-modal-overlay';

  const isRegister = mode === 'register';

  overlay.innerHTML = `
    <div class="login-modal">
      <h3>${isRegister ? 'Create Account' : 'Sign In'}</h3>
      ${isRegister ? `
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="loginName" placeholder="Your name" autocomplete="name">
        </div>
      ` : ''}
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="loginEmail" placeholder="you@example.com" autocomplete="email">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="loginPassword" placeholder="${isRegister ? 'Min 8 characters' : 'Password'}" autocomplete="${isRegister ? 'new-password' : 'current-password'}">
      </div>
      <button class="login-submit" id="loginSubmit">${isRegister ? 'Create Account' : 'Sign In'}</button>
      <div class="login-error" id="loginError"></div>
      <a class="login-toggle-link" id="loginToggle">
        ${isRegister ? 'Already have an account? Sign in' : "Don't have an account? Register"}
      </a>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close on overlay click (not modal click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Toggle between login and register
  document.getElementById('loginToggle').addEventListener('click', (e) => {
    e.preventDefault();
    overlay.remove();
    showLoginModal(isRegister ? 'login' : 'register');
  });

  // Submit handler
  document.getElementById('loginSubmit').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const submitBtn = document.getElementById('loginSubmit');

    if (!email || !password) {
      errorEl.textContent = 'Email and password are required';
      return;
    }

    if (isRegister) {
      const name = document.getElementById('loginName').value.trim();
      if (!name) {
        errorEl.textContent = 'Name is required';
        return;
      }
      if (password.length < 8) {
        errorEl.textContent = 'Password must be at least 8 characters';
        return;
      }
    }

    submitBtn.disabled = true;
    errorEl.textContent = '';

    try {
      const msgType = isRegister ? MSG_TYPES.REGISTER : MSG_TYPES.LOGIN;
      const payload = isRegister
        ? { email, password, name: document.getElementById('loginName').value.trim() }
        : { email, password };

      const response = await sendMsg(msgType, { payload });

      if (response?.success === false) {
        errorEl.textContent = response.error || 'Authentication failed';
        submitBtn.disabled = false;
        return;
      }

      // Success
      overlay.remove();
      await refreshAuthState();
    } catch (err) {
      errorEl.textContent = err.message || 'Authentication failed';
      submitBtn.disabled = false;
    }
  });

  // Focus first input
  setTimeout(() => {
    const firstInput = overlay.querySelector('input');
    if (firstInput) firstInput.focus();
  }, 50);
}
```

Add event handlers:

```javascript
/* -------------------------------------------------------------------------- */
/*  Auth event handlers                                                       */
/* -------------------------------------------------------------------------- */

$loginBtn.addEventListener('click', () => showLoginModal('login'));

$googleLoginBtn.addEventListener('click', async () => {
  try {
    const response = await sendMsg(MSG_TYPES.OAUTH_GOOGLE);
    if (response?.success === false) {
      console.warn('[NeuronPopup] Google OAuth failed:', response.error);
      return;
    }
    await refreshAuthState();
  } catch (err) {
    console.warn('[NeuronPopup] Google OAuth failed:', err);
  }
});

$logoutBtn.addEventListener('click', async () => {
  try {
    await sendMsg(MSG_TYPES.LOGOUT);
    renderAuthState(null);
  } catch (err) {
    console.warn('[NeuronPopup] Logout failed:', err);
  }
});
```

Update the `DOMContentLoaded` handler to also fetch auth state:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  refreshLogs();
  refreshAuthState();
});
```

### Step 9: Modify `options/options.html`

Add a user profile / auth section to the header bar. In the `.header-controls` div, before the status label:

```html
        <!-- Auth User (visible when logged in) -->
        <div class="header-user hidden" id="headerUser">
          <img class="header-user-avatar" id="headerUserAvatar" src="" alt="" width="28" height="28">
          <span class="header-user-name" id="headerUserName"></span>
          <button class="btn btn-ghost btn-sm" id="headerLogoutBtn" title="Sign Out">Sign Out</button>
        </div>
        <div class="header-login hidden" id="headerLogin">
          <button class="btn btn-primary btn-sm" id="headerLoginBtn">Sign In</button>
        </div>
```

### Step 10: Modify `options/options.js`

Import auth MSG_TYPES and add auth state management. Add to the existing imports:

After the DOM references section, add:

```javascript
const $headerUser       = document.getElementById('headerUser');
const $headerUserAvatar = document.getElementById('headerUserAvatar');
const $headerUserName   = document.getElementById('headerUserName');
const $headerLogoutBtn  = document.getElementById('headerLogoutBtn');
const $headerLogin      = document.getElementById('headerLogin');
const $headerLoginBtn   = document.getElementById('headerLoginBtn');
```

Add auth rendering:

```javascript
/* -------------------------------------------------------------------------- */
/*  Auth State in Options                                                     */
/* -------------------------------------------------------------------------- */

async function refreshAuthUI() {
  try {
    const response = await sendMessage(MSG_TYPES.GET_AUTH_STATE);
    const authState = response?.data || response;

    if (authState?.isLoggedIn && authState.user) {
      $headerUser.classList.remove('hidden');
      $headerLogin.classList.add('hidden');
      $headerUserName.textContent = authState.user.name || authState.user.email;
      if (authState.user.avatar_url) {
        $headerUserAvatar.src = authState.user.avatar_url;
        $headerUserAvatar.style.display = 'block';
      } else {
        $headerUserAvatar.style.display = 'none';
      }
    } else {
      $headerUser.classList.add('hidden');
      $headerLogin.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('[NeuronOptions] Failed to get auth state:', err);
  }
}

$headerLogoutBtn.addEventListener('click', async () => {
  try {
    await sendMessage(MSG_TYPES.LOGOUT);
    showToast('Signed out', 'info');
    refreshAuthUI();
  } catch (err) {
    showToast('Logout failed', 'error');
  }
});

$headerLoginBtn.addEventListener('click', () => {
  // Open the popup for login (or we can open a tab-based login page)
  openModal({
    title: 'Sign In',
    body: '<p style="color:var(--text-muted);">Use the extension popup (click the Neuron icon in the toolbar) to sign in or create an account.</p>',
  });
});
```

Add `refreshAuthUI()` to the `init()` function after the existing `setVersion()` call:

```javascript
  // Display auth state
  refreshAuthUI();
```

### Step 11: Add Auth CSS to `options/options.css`

Append these styles at the end of `options/options.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Header User Auth                                                          */
/* -------------------------------------------------------------------------- */

.header-user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-overlay);
  flex-shrink: 0;
}

.header-user-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-login {
  display: flex;
  align-items: center;
}
```

### Step 12: Update `manifest.json`

Add the `"alarms"` permission and `"identity"` permission for Google OAuth:

```json
{
  "permissions": [
    "storage",
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "tabs",
    "activeTab",
    "scripting",
    "webRequest",
    "alarms",
    "identity"
  ],
  ...
}
```

## JWT Token Structure

The access token JWT payload contains:

```json
{
  "sub": "user-uuid-here",
  "email": "user@example.com",
  "name": "User Name",
  "iat": 1704067200,
  "exp": 1704068100
}
```

- `sub`: User ID (UUID)
- `email`: User email
- `name`: User display name
- `iat`: Issued at (Unix timestamp, seconds)
- `exp`: Expires at (Unix timestamp, seconds) -- 15 minutes after iat

The refresh token is an opaque UUID stored in Redis with key `refresh_token:<uuid>` and value `<userId>`, TTL 7 days.

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `service-worker/auth-manager.js` | Auth lifecycle management in service worker |
| `server/src/routes/auth.js` (Google route) | Google OAuth backend endpoint |

### Modified Files
| File | Changes |
|------|---------|
| `shared/constants.js` | Add auth MSG_TYPES, AUTH_STATE storage key, API_BASE_URL |
| `service-worker/sw.js` | Import auth-manager, load auth state, add alarm for periodic refresh |
| `service-worker/message-router.js` | Import auth-manager functions, add auth message cases |
| `popup/popup.html` | Add auth section (login/logout/user display), sync indicator |
| `popup/popup.js` | Add auth MSG_TYPES, rendering, login modal, event handlers |
| `popup/popup.css` | Add auth section styles, sync indicator, login modal styles |
| `options/options.html` | Add header user/login elements |
| `options/options.js` | Add auth state UI rendering, logout handler |
| `options/options.css` | Add header-user styles |
| `manifest.json` | Add "alarms" and "identity" permissions |

## Verification

1. **Start backend**: `cd server && docker compose up -d && npm run dev`
2. **Load extension**: Open `chrome://extensions`, enable Developer mode, load unpacked from the plugin directory
3. **Check popup**: Click the Neuron icon in the toolbar. Verify "Sign In" and "Google" buttons appear at the bottom
4. **Register**: Click "Sign In" -> "Don't have an account? Register" -> fill in name/email/password -> "Create Account". Expect the auth section to switch to showing user name
5. **Logout**: Click the logout icon next to user name. Expect to see login buttons again
6. **Login**: Click "Sign In", enter credentials, submit. Expect user row to appear
7. **Options page auth**: Open Options, verify the header shows user name and "Sign Out" button when logged in, or "Sign In" when logged out
8. **Token refresh**: Wait 15 minutes (or reduce `accessExpiresIn` to `'1m'` for testing). Check service worker console for `[NeuronAuth] Token auto-refreshed successfully` log
9. **Persistence**: Close and reopen Chrome. Click the popup. Expect to still be logged in (auth state loaded from chrome.storage.local)
10. **Service worker restart**: Go to `chrome://extensions`, click "Service Worker" link to open devtools, then click "Update" to restart the SW. The auth state should reload
