# Feature 4.5 — Desktop App (Electron)

## Summary

An Electron-based desktop application that provides system-wide HTTP/HTTPS interception beyond the browser. The app runs a local proxy server that intercepts all network traffic routed through it, applies the same rule engine used in the Chrome extension, and supports HTTPS interception via dynamically generated certificates signed by a local root CA. This enables interception of traffic from mobile devices (iOS/Android configured to use the proxy), non-browser applications, and any HTTP client on the local network.

## Why

The Chrome extension can only intercept traffic within Chrome. Enterprise teams need to debug and mock API traffic from: (1) mobile apps during development -- configure the phone's WiFi proxy to point at the desktop app, (2) backend-to-backend calls between microservices running locally, (3) Electron or native desktop applications, (4) CLI tools like curl, wget, or custom scripts, and (5) any device on the local network. A desktop proxy app with the same rule engine provides unified interception across all these scenarios.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Desktop app directory**: `health_check/utils/neuron-interceptor-plugin/desktop/`
- **Shared rule engine**: Reuses `shared/` modules from the extension (constants, data-models)
- **Tech stack**: Electron 28+, electron-builder for packaging (macOS .dmg, Windows .exe installer)
- **Proxy**: `http-mitm-proxy` for HTTP/HTTPS interception with dynamic certificate generation
- **Certificate authority**: `node-forge` for RSA key pair and X.509 certificate generation

## Directory Structure

```
desktop/
  package.json              # Dependencies and build configuration
  main.js                   # Electron main process entry point
  preload.js                # Context bridge for renderer ↔ main IPC
  src/
    proxy-server.js          # HTTP/HTTPS MITM proxy server
    cert-manager.js          # Root CA generation and certificate management
    system-proxy.js          # OS-level proxy configuration (macOS + Windows)
    tray.js                  # System tray icon and menu
    rule-engine.js           # Rule matching (shared logic adapted for Node.js)
  build/
    icon.icns                # macOS app icon
    icon.ico                 # Windows app icon
    icon.png                 # Linux app icon (256x256)
  renderer/
    index.html               # Main window (loads options page UI)
    dashboard.html           # Desktop-specific proxy dashboard
    dashboard.js             # Dashboard logic (traffic view, proxy status)
    dashboard.css            # Dashboard styles
```

## Files to Create

| File | Purpose |
|------|---------|
| `desktop/package.json` | Dependencies, scripts, and electron-builder config |
| `desktop/main.js` | Electron main process: window management, IPC, proxy lifecycle |
| `desktop/preload.js` | Secure context bridge between renderer and main process |
| `desktop/src/proxy-server.js` | HTTP/HTTPS MITM proxy with rule engine integration |
| `desktop/src/cert-manager.js` | Root CA generation, dynamic cert signing, trust store management |
| `desktop/src/system-proxy.js` | OS proxy configuration for macOS and Windows |
| `desktop/src/tray.js` | System tray icon with quick-action menu |
| `desktop/src/rule-engine.js` | Rule matching logic adapted from the extension |

## Implementation

### File 1: `desktop/package.json`

```json
{
  "name": "neuron-interceptor-desktop",
  "version": "1.0.0",
  "description": "Neuron Interceptor — System-wide HTTP/HTTPS interception and mocking",
  "author": "Neuron Interceptor Team",
  "license": "MIT",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dev": "NODE_ENV=development electron .",
    "build": "electron-builder",
    "build:mac": "electron-builder --mac",
    "build:win": "electron-builder --win",
    "build:linux": "electron-builder --linux",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "http-mitm-proxy": "^1.1.0",
    "node-forge": "^1.3.1",
    "electron-store": "^8.2.0",
    "get-port": "^5.1.1"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.0"
  },
  "build": {
    "appId": "com.neuron-interceptor.desktop",
    "productName": "Neuron Interceptor",
    "copyright": "Copyright 2026 Neuron Interceptor",
    "directories": {
      "output": "dist",
      "buildResources": "build"
    },
    "files": [
      "main.js",
      "preload.js",
      "src/**/*",
      "renderer/**/*",
      "node_modules/**/*",
      "!node_modules/**/test/**",
      "!node_modules/**/*.md"
    ],
    "extraResources": [
      {
        "from": "../shared",
        "to": "shared",
        "filter": ["**/*.js"]
      }
    ],
    "mac": {
      "category": "public.app-category.developer-tools",
      "icon": "build/icon.icns",
      "target": [
        { "target": "dmg", "arch": ["x64", "arm64"] },
        { "target": "zip", "arch": ["x64", "arm64"] }
      ],
      "hardenedRuntime": true,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist"
    },
    "win": {
      "icon": "build/icon.ico",
      "target": [
        { "target": "nsis", "arch": ["x64"] }
      ]
    },
    "linux": {
      "icon": "build/icon.png",
      "target": ["AppImage", "deb"],
      "category": "Development"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

### File 2: `desktop/main.js`

Electron main process: creates the main window, manages proxy server lifecycle, handles IPC communication, and sets up the system tray.

```javascript
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { createProxyServer, stopProxyServer, getProxyStatus } = require('./src/proxy-server');
const { initCertManager, getRootCACert, installCertificate, getCertPath } = require('./src/cert-manager');
const { setSystemProxy, clearSystemProxy, getSystemProxyStatus } = require('./src/system-proxy');
const { createTray } = require('./src/tray');

// --- App State ---------------------------------------------------------------
const store = new Store({
  defaults: {
    proxyPort: 8080,
    autoStartProxy: true,
    autoSetSystemProxy: false,
    rules: [],
    settings: {
      enableLogging: true,
      maxLogEntries: 5000,
      theme: 'dark',
    },
  },
});

let mainWindow = null;
let tray = null;
let proxyRunning = false;

// --- Single Instance Lock ----------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- App Lifecycle -----------------------------------------------------------

app.whenReady().then(async () => {
  // Initialize certificate manager (generate root CA if needed)
  await initCertManager(app.getPath('userData'));

  // Create the main window
  createMainWindow();

  // Create system tray
  tray = createTray({
    onToggleProxy: handleToggleProxy,
    onOpenDashboard: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    getStatus: () => ({
      proxyRunning,
      port: store.get('proxyPort'),
    }),
  });

  // Auto-start proxy if configured
  if (store.get('autoStartProxy')) {
    await handleStartProxy();
  }

  // Register IPC handlers
  registerIPCHandlers();
});

app.on('window-all-closed', () => {
  // On macOS, keep the app running in the tray
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Clean up: stop proxy and clear system proxy settings
  if (proxyRunning) {
    await stopProxyServer();
  }
  await clearSystemProxy().catch(() => {});
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  } else {
    mainWindow.show();
  }
});

// --- Window Management -------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Neuron Interceptor',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#1e1e2e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('renderer/dashboard.html');

  // Hide instead of close (keep running in tray)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- Proxy Management --------------------------------------------------------

async function handleStartProxy() {
  if (proxyRunning) return;

  const port = store.get('proxyPort');
  const rules = store.get('rules') || [];

  try {
    await createProxyServer({
      port,
      rules,
      certDir: path.join(app.getPath('userData'), 'certs'),
      onRequest: (entry) => {
        // Send intercepted request to renderer for live traffic view
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('proxy:request', entry);
        }
      },
      onResponse: (entry) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('proxy:response', entry);
        }
      },
    });

    proxyRunning = true;

    // Auto-set system proxy if configured
    if (store.get('autoSetSystemProxy')) {
      await setSystemProxy('127.0.0.1', port);
    }

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('proxy:status', { running: true, port });
    }
  } catch (err) {
    dialog.showErrorBox('Proxy Error', `Failed to start proxy on port ${port}: ${err.message}`);
  }
}

async function handleStopProxy() {
  if (!proxyRunning) return;

  await stopProxyServer();
  await clearSystemProxy().catch(() => {});
  proxyRunning = false;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proxy:status', { running: false, port: null });
  }
}

async function handleToggleProxy() {
  if (proxyRunning) {
    await handleStopProxy();
  } else {
    await handleStartProxy();
  }
  return proxyRunning;
}

// --- IPC Handlers ------------------------------------------------------------

function registerIPCHandlers() {
  // Proxy control
  ipcMain.handle('proxy:start', handleStartProxy);
  ipcMain.handle('proxy:stop', handleStopProxy);
  ipcMain.handle('proxy:toggle', handleToggleProxy);
  ipcMain.handle('proxy:status', () => ({
    running: proxyRunning,
    port: store.get('proxyPort'),
    ...getProxyStatus(),
  }));

  // Settings
  ipcMain.handle('settings:get', (event, key) => store.get(key));
  ipcMain.handle('settings:set', (event, key, value) => {
    store.set(key, value);
    return true;
  });
  ipcMain.handle('settings:getAll', () => store.store);

  // Rules
  ipcMain.handle('rules:get', () => store.get('rules') || []);
  ipcMain.handle('rules:set', (event, rules) => {
    store.set('rules', rules);
    // Hot-reload rules into running proxy
    if (proxyRunning) {
      const { updateRules } = require('./src/proxy-server');
      updateRules(rules);
    }
    return true;
  });

  // Certificate management
  ipcMain.handle('cert:getRootCA', () => getRootCACert());
  ipcMain.handle('cert:getPath', () => getCertPath());
  ipcMain.handle('cert:install', async () => {
    try {
      await installCertificate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // System proxy
  ipcMain.handle('system-proxy:set', async (event, host, port) => {
    try {
      await setSystemProxy(host || '127.0.0.1', port || store.get('proxyPort'));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('system-proxy:clear', async () => {
    try {
      await clearSystemProxy();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('system-proxy:status', async () => {
    return getSystemProxyStatus();
  });

  // Network info (for mobile device setup)
  ipcMain.handle('network:getLocalIP', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  });

  // Dialog helpers
  ipcMain.handle('dialog:showSave', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  });

  ipcMain.handle('dialog:showOpen', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result;
  });
}
```

### File 3: `desktop/preload.js`

Secure context bridge that exposes a controlled API to the renderer process.

```javascript
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Neuron Interceptor — Preload Script
 *
 * Exposes a safe API to the renderer process via contextBridge.
 * All communication goes through IPC channels — no direct Node.js access in renderer.
 */
contextBridge.exposeInMainWorld('neuron', {
  // --- Proxy Control ---------------------------------------------------------
  proxy: {
    start: () => ipcRenderer.invoke('proxy:start'),
    stop: () => ipcRenderer.invoke('proxy:stop'),
    toggle: () => ipcRenderer.invoke('proxy:toggle'),
    getStatus: () => ipcRenderer.invoke('proxy:status'),
    onRequest: (callback) => {
      ipcRenderer.on('proxy:request', (event, data) => callback(data));
    },
    onResponse: (callback) => {
      ipcRenderer.on('proxy:response', (event, data) => callback(data));
    },
    onStatusChange: (callback) => {
      ipcRenderer.on('proxy:status', (event, data) => callback(data));
    },
  },

  // --- Settings --------------------------------------------------------------
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // --- Rules -----------------------------------------------------------------
  rules: {
    get: () => ipcRenderer.invoke('rules:get'),
    set: (rules) => ipcRenderer.invoke('rules:set', rules),
  },

  // --- Certificate Management ------------------------------------------------
  cert: {
    getRootCA: () => ipcRenderer.invoke('cert:getRootCA'),
    getPath: () => ipcRenderer.invoke('cert:getPath'),
    install: () => ipcRenderer.invoke('cert:install'),
  },

  // --- System Proxy ----------------------------------------------------------
  systemProxy: {
    set: (host, port) => ipcRenderer.invoke('system-proxy:set', host, port),
    clear: () => ipcRenderer.invoke('system-proxy:clear'),
    getStatus: () => ipcRenderer.invoke('system-proxy:status'),
  },

  // --- Network Info ----------------------------------------------------------
  network: {
    getLocalIP: () => ipcRenderer.invoke('network:getLocalIP'),
  },

  // --- Dialogs ---------------------------------------------------------------
  dialog: {
    showSave: (options) => ipcRenderer.invoke('dialog:showSave', options),
    showOpen: (options) => ipcRenderer.invoke('dialog:showOpen', options),
  },

  // --- Platform Info ---------------------------------------------------------
  platform: process.platform,
  version: require('./package.json').version,
});
```

### File 4: `desktop/src/proxy-server.js`

HTTP/HTTPS MITM proxy server that intercepts traffic, applies rules, and supports response mocking.

```javascript
'use strict';

/**
 * Neuron Interceptor — MITM Proxy Server
 *
 * Creates an HTTP/HTTPS proxy that:
 *   1. Intercepts all HTTP requests passing through it
 *   2. For HTTPS, dynamically generates certificates signed by the local root CA
 *   3. Evaluates the request against the loaded rule set
 *   4. Applies matching rules (mock responses, header modifications, delays, redirects)
 *   5. Emits events for live traffic monitoring in the UI
 */

const http = require('http');
const httpProxy = require('http-mitm-proxy');
const { matchRule } = require('./rule-engine');
const { getOrCreateCert } = require('./cert-manager');

let _proxy = null;
let _rules = [];
let _callbacks = {};
let _stats = { totalRequests: 0, interceptedRequests: 0, startedAt: null };

/**
 * Create and start the MITM proxy server.
 *
 * @param {object} options
 * @param {number} options.port — Port to listen on (default: 8080)
 * @param {object[]} options.rules — Array of interception rules
 * @param {string} options.certDir — Directory for generated certificates
 * @param {Function} options.onRequest — Callback for each intercepted request
 * @param {Function} options.onResponse — Callback for each response
 */
async function createProxyServer(options) {
  const { port = 8080, rules = [], certDir, onRequest, onResponse } = options;

  _rules = rules;
  _callbacks = { onRequest, onResponse };

  _proxy = httpProxy();

  // Configure SSL certificate generation directory
  _proxy.sslCaDir = certDir;

  // --- Request Interception --------------------------------------------------
  _proxy.onRequest(function (ctx, callback) {
    _stats.totalRequests++;

    const requestInfo = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      method: ctx.clientToProxyRequest.method,
      url: ctx.clientToProxyRequest.url,
      host: ctx.clientToProxyRequest.headers.host || '',
      headers: { ...ctx.clientToProxyRequest.headers },
      isSSL: ctx.isSSL,
    };

    // Build full URL
    const protocol = ctx.isSSL ? 'https' : 'http';
    const fullUrl = `${protocol}://${requestInfo.host}${requestInfo.url}`;
    requestInfo.fullUrl = fullUrl;

    // Collect request body
    let requestBody = Buffer.alloc(0);
    ctx.clientToProxyRequest.on('data', (chunk) => {
      requestBody = Buffer.concat([requestBody, chunk]);
    });

    ctx.clientToProxyRequest.on('end', () => {
      requestInfo.body = requestBody.toString('utf-8');

      // Match against rules
      const matchedRule = matchRule(fullUrl, requestInfo.method, requestInfo.headers, requestInfo.body, _rules);

      if (matchedRule) {
        _stats.interceptedRequests++;
        requestInfo.matched = true;
        requestInfo.ruleName = matchedRule.name;
        requestInfo.ruleAction = matchedRule.action.type;

        // Apply rule action
        _applyRule(ctx, matchedRule, requestInfo, callback);
      } else {
        requestInfo.matched = false;
        // Emit request event
        if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
        callback();
      }
    });
  });

  // --- Response Interception -------------------------------------------------
  _proxy.onResponse(function (ctx, callback) {
    const responseInfo = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      statusCode: ctx.serverToProxyResponse.statusCode,
      headers: { ...ctx.serverToProxyResponse.headers },
      url: ctx.clientToProxyRequest.url,
      host: ctx.clientToProxyRequest.headers.host,
    };

    // Collect response body (for logging, limit to 1MB)
    let responseBody = Buffer.alloc(0);
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB

    ctx.serverToProxyResponse.on('data', (chunk) => {
      if (responseBody.length < MAX_BODY_SIZE) {
        responseBody = Buffer.concat([responseBody, chunk]);
      }
    });

    ctx.serverToProxyResponse.on('end', () => {
      responseInfo.bodySize = responseBody.length;
      // Only include body in event for text-based content types
      const contentType = responseInfo.headers['content-type'] || '';
      if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
        responseInfo.body = responseBody.toString('utf-8').substring(0, 10000); // Limit for UI
      }

      if (_callbacks.onResponse) _callbacks.onResponse(responseInfo);
    });

    callback();
  });

  // --- Error Handling --------------------------------------------------------
  _proxy.onError(function (ctx, err) {
    console.error('[Neuron Proxy] Error:', err.message);
  });

  // --- Start Listening -------------------------------------------------------
  return new Promise((resolve, reject) => {
    _proxy.listen({ port, silent: true }, (err) => {
      if (err) {
        reject(err);
      } else {
        _stats.startedAt = new Date().toISOString();
        console.log(`[Neuron Proxy] MITM proxy listening on port ${port}`);
        resolve();
      }
    });
  });
}

/**
 * Stop the proxy server.
 */
async function stopProxyServer() {
  if (_proxy) {
    _proxy.close();
    _proxy = null;
    _stats.startedAt = null;
    console.log('[Neuron Proxy] Proxy stopped.');
  }
}

/**
 * Hot-reload rules without restarting the proxy.
 *
 * @param {object[]} rules — Updated rules array
 */
function updateRules(rules) {
  _rules = rules;
  console.log(`[Neuron Proxy] Rules updated: ${rules.length} rules loaded.`);
}

/**
 * Get proxy status and statistics.
 */
function getProxyStatus() {
  return {
    running: !!_proxy,
    startedAt: _stats.startedAt,
    totalRequests: _stats.totalRequests,
    interceptedRequests: _stats.interceptedRequests,
  };
}

// =============================================================================
// Internal: Apply a matched rule to the request/response
// =============================================================================

function _applyRule(ctx, rule, requestInfo, callback) {
  const action = rule.action;

  switch (action.type) {
    case 'mock_inline': {
      // Return a mock response without forwarding to the server
      const statusCode = action.mockInline?.statusCode || 200;
      const headers = action.mockInline?.headers || { 'Content-Type': 'application/json' };
      const body = action.mockInline?.body || '{}';

      ctx.proxyToClientResponse.writeHead(statusCode, headers);
      ctx.proxyToClientResponse.end(body);

      requestInfo.mockResponse = { statusCode, body: body.substring(0, 500) };
      if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
      // Do NOT call callback() — we already sent the response
      return;
    }

    case 'redirect': {
      // Redirect to a different host
      const targetHost = action.redirect?.targetHost;
      if (targetHost) {
        ctx.proxyToServerRequestOptions.host = targetHost;
        ctx.proxyToServerRequestOptions.headers.host = targetHost;
      }
      if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
      callback();
      return;
    }

    case 'modify_headers': {
      // Add/remove request headers
      const mods = action.headerMods || {};

      if (mods.addRequest) {
        for (const { name, value } of mods.addRequest) {
          ctx.proxyToServerRequestOptions.headers[name.toLowerCase()] = value;
        }
      }
      if (mods.removeRequest) {
        for (const { name } of mods.removeRequest) {
          delete ctx.proxyToServerRequestOptions.headers[name.toLowerCase()];
        }
      }

      // Response header modifications are applied in onResponse
      if (mods.addResponse || mods.removeResponse) {
        ctx.addResponseFilter(function (ctx2, callback2) {
          if (mods.addResponse) {
            for (const { name, value } of mods.addResponse) {
              ctx2.serverToProxyResponse.headers[name.toLowerCase()] = value;
            }
          }
          if (mods.removeResponse) {
            for (const { name } of mods.removeResponse) {
              delete ctx2.serverToProxyResponse.headers[name.toLowerCase()];
            }
          }
          callback2();
        });
      }

      if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
      callback();
      return;
    }

    case 'delay': {
      // Add artificial delay
      const delayMs = action.delayMs || 0;
      if (delayMs > 0) {
        requestInfo.delayMs = delayMs;
        if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
        setTimeout(() => callback(), delayMs);
        return;
      }
      if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
      callback();
      return;
    }

    default: {
      if (_callbacks.onRequest) _callbacks.onRequest(requestInfo);
      callback();
    }
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  createProxyServer,
  stopProxyServer,
  updateRules,
  getProxyStatus,
};
```

### File 5: `desktop/src/cert-manager.js`

Root CA generation and management. On first launch, generates an RSA root CA certificate and key. For each intercepted HTTPS domain, dynamically generates a certificate signed by the root CA. Provides functions to install the root CA into the system trust store.

```javascript
'use strict';

/**
 * Neuron Interceptor — Certificate Manager
 *
 * Manages the root CA for HTTPS MITM interception:
 *   1. On first launch, generates RSA 2048-bit root CA cert + key
 *   2. Saves to app data directory
 *   3. Provides "Install Certificate" function for system trust store
 *   4. http-mitm-proxy uses the CA dir to auto-generate per-domain certs
 */

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let _certDir = null;
let _caCert = null;
let _caKey = null;

const CA_CERT_FILENAME = 'certs/ca.pem';
const CA_KEY_FILENAME = 'certs/ca-key.pem';

/**
 * Initialize the certificate manager.
 * Generates a root CA if one doesn't already exist.
 *
 * @param {string} appDataDir — Electron app data directory (app.getPath('userData'))
 */
async function initCertManager(appDataDir) {
  _certDir = path.join(appDataDir, 'certs');

  // Ensure certs directory exists
  fs.mkdirSync(_certDir, { recursive: true });

  const certPath = path.join(appDataDir, CA_CERT_FILENAME);
  const keyPath = path.join(appDataDir, CA_KEY_FILENAME);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    // Load existing CA
    const certPem = fs.readFileSync(certPath, 'utf-8');
    const keyPem = fs.readFileSync(keyPath, 'utf-8');
    _caCert = forge.pki.certificateFromPem(certPem);
    _caKey = forge.pki.privateKeyFromPem(keyPem);
    console.log('[Neuron Cert] Loaded existing root CA certificate.');
  } else {
    // Generate new CA
    console.log('[Neuron Cert] Generating new root CA certificate...');
    _generateRootCA(certPath, keyPath);
    console.log('[Neuron Cert] Root CA certificate generated.');
  }
}

/**
 * Generate a self-signed root CA certificate and private key.
 *
 * @param {string} certPath — File path to save the CA certificate PEM
 * @param {string} keyPath — File path to save the CA private key PEM
 */
function _generateRootCA(certPath, keyPath) {
  // Generate RSA 2048-bit key pair
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create a self-signed root CA certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = _generateSerialNumber();

  // Valid for 10 years
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Neuron Interceptor Root CA' },
    { name: 'organizationName', value: 'Neuron Interceptor' },
    { name: 'organizationalUnitName', value: 'Development Tools' },
    { shortName: 'C', value: 'US' },
    { shortName: 'ST', value: 'California' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed

  // CA extensions
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  // Self-sign
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Save to files
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(certPath, certPem, { mode: 0o644 });
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });

  _caCert = cert;
  _caKey = keys.privateKey;
}

/**
 * Get the root CA certificate as a PEM string.
 *
 * @returns {string|null}
 */
function getRootCACert() {
  if (!_caCert) return null;
  return forge.pki.certificateToPem(_caCert);
}

/**
 * Get the path to the root CA certificate file.
 *
 * @returns {string|null}
 */
function getCertPath() {
  if (!_certDir) return null;
  const certPath = path.join(_certDir, 'ca.pem');
  return fs.existsSync(certPath) ? certPath : null;
}

/**
 * Generate a certificate for a specific hostname, signed by the root CA.
 * Used by http-mitm-proxy for HTTPS interception.
 *
 * @param {string} hostname — The domain to generate a certificate for
 * @returns {{ cert: string, key: string }} — PEM-encoded cert and key
 */
function getOrCreateCert(hostname) {
  if (!_caCert || !_caKey) {
    throw new Error('Root CA not initialized. Call initCertManager() first.');
  }

  // Check if we already have a cached cert for this hostname
  const cachedCertPath = path.join(_certDir, `${_sanitizeHostname(hostname)}.pem`);
  const cachedKeyPath = path.join(_certDir, `${_sanitizeHostname(hostname)}-key.pem`);

  if (fs.existsSync(cachedCertPath) && fs.existsSync(cachedKeyPath)) {
    return {
      cert: fs.readFileSync(cachedCertPath, 'utf-8'),
      key: fs.readFileSync(cachedKeyPath, 'utf-8'),
    };
  }

  // Generate a new cert for this hostname
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = _generateSerialNumber();

  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(_caCert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: hostname }, // DNS
      ],
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
  ]);

  // Sign with the root CA's private key
  cert.sign(_caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Cache for future use
  fs.writeFileSync(cachedCertPath, certPem, { mode: 0o644 });
  fs.writeFileSync(cachedKeyPath, keyPem, { mode: 0o600 });

  return { cert: certPem, key: keyPem };
}

/**
 * Install the root CA certificate into the system trust store.
 * Platform-specific: macOS uses Keychain, Windows uses certutil.
 *
 * @throws {Error} if installation fails
 */
async function installCertificate() {
  const certPath = getCertPath();
  if (!certPath) {
    throw new Error('Root CA certificate not found. Initialize cert manager first.');
  }

  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: Add to system Keychain
    try {
      execSync(
        `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`,
        { stdio: 'pipe' }
      );
      console.log('[Neuron Cert] Root CA installed in macOS System Keychain.');
    } catch (err) {
      // Try user Keychain as fallback (no sudo)
      try {
        execSync(
          `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
          { stdio: 'pipe' }
        );
        console.log('[Neuron Cert] Root CA installed in macOS user Keychain.');
      } catch (err2) {
        throw new Error(`Failed to install certificate on macOS: ${err2.message}`);
      }
    }
  } else if (platform === 'win32') {
    // Windows: Use certutil to add to Trusted Root store
    try {
      execSync(`certutil -addstore -user Root "${certPath}"`, { stdio: 'pipe' });
      console.log('[Neuron Cert] Root CA installed in Windows Trusted Root store.');
    } catch (err) {
      throw new Error(`Failed to install certificate on Windows: ${err.message}`);
    }
  } else if (platform === 'linux') {
    // Linux: Copy to system CA directory and update
    try {
      const destPath = '/usr/local/share/ca-certificates/neuron-interceptor-ca.crt';
      execSync(`sudo cp "${certPath}" "${destPath}" && sudo update-ca-certificates`, { stdio: 'pipe' });
      console.log('[Neuron Cert] Root CA installed on Linux.');
    } catch (err) {
      throw new Error(`Failed to install certificate on Linux: ${err.message}`);
    }
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

// --- Helpers -----------------------------------------------------------------

function _generateSerialNumber() {
  return Date.now().toString(16) + Math.random().toString(16).substring(2, 10);
}

function _sanitizeHostname(hostname) {
  return hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  initCertManager,
  getRootCACert,
  getCertPath,
  getOrCreateCert,
  installCertificate,
};
```

### File 6: `desktop/src/system-proxy.js`

Platform-specific system proxy configuration for macOS and Windows.

```javascript
'use strict';

/**
 * Neuron Interceptor — System Proxy Configuration
 *
 * Sets and clears the OS-level HTTP/HTTPS proxy settings so that all
 * system traffic is routed through the Neuron Interceptor proxy.
 *
 * Supported platforms:
 *   - macOS: networksetup command
 *   - Windows: reg add / netsh command
 *
 * For mobile devices: users manually configure WiFi proxy settings.
 */

const { execSync, exec } = require('child_process');

/**
 * Set the system HTTP/HTTPS proxy.
 *
 * @param {string} host — Proxy host (e.g., '127.0.0.1')
 * @param {number} port — Proxy port (e.g., 8080)
 */
async function setSystemProxy(host, port) {
  const platform = process.platform;

  if (platform === 'darwin') {
    await _setMacProxy(host, port);
  } else if (platform === 'win32') {
    await _setWindowsProxy(host, port);
  } else {
    console.warn('[Neuron Proxy] System proxy configuration is not supported on this platform. Please configure manually.');
  }
}

/**
 * Clear (disable) the system HTTP/HTTPS proxy.
 */
async function clearSystemProxy() {
  const platform = process.platform;

  if (platform === 'darwin') {
    await _clearMacProxy();
  } else if (platform === 'win32') {
    await _clearWindowsProxy();
  }
}

/**
 * Get the current system proxy configuration status.
 *
 * @returns {{ enabled: boolean, host: string|null, port: number|null }}
 */
function getSystemProxyStatus() {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      return _getMacProxyStatus();
    } else if (platform === 'win32') {
      return _getWindowsProxyStatus();
    }
  } catch (err) {
    console.warn('[Neuron Proxy] Failed to get proxy status:', err.message);
  }

  return { enabled: false, host: null, port: null };
}

// =============================================================================
// macOS Implementation
// =============================================================================

/**
 * Discover the active macOS network service name.
 * Returns the first service that has a hardware port (e.g., "Wi-Fi", "Ethernet").
 */
function _getActiveNetworkService() {
  try {
    // Get the primary network interface
    const routeOutput = execSync('route get default 2>/dev/null || true', { encoding: 'utf-8' });
    const ifaceMatch = routeOutput.match(/interface:\s*(\S+)/);

    if (ifaceMatch) {
      const iface = ifaceMatch[1];
      // Map interface to service name
      const servicesOutput = execSync('networksetup -listallhardwareports', { encoding: 'utf-8' });
      const sections = servicesOutput.split('Hardware Port: ');

      for (const section of sections) {
        if (section.includes(`Device: ${iface}`)) {
          const nameMatch = section.match(/^(.+)/);
          if (nameMatch) return nameMatch[1].trim();
        }
      }
    }
  } catch (e) {
    // Fallback
  }

  // Default fallback
  return 'Wi-Fi';
}

async function _setMacProxy(host, port) {
  const service = _getActiveNetworkService();

  try {
    // Set HTTP proxy
    execSync(`networksetup -setwebproxy "${service}" ${host} ${port}`, { stdio: 'pipe' });
    // Set HTTPS proxy
    execSync(`networksetup -setsecurewebproxy "${service}" ${host} ${port}`, { stdio: 'pipe' });
    // Enable both
    execSync(`networksetup -setwebproxystate "${service}" on`, { stdio: 'pipe' });
    execSync(`networksetup -setsecurewebproxystate "${service}" on`, { stdio: 'pipe' });

    console.log(`[Neuron Proxy] macOS proxy set: ${host}:${port} on "${service}"`);
  } catch (err) {
    throw new Error(`Failed to set macOS proxy on "${service}": ${err.message}`);
  }
}

async function _clearMacProxy() {
  const service = _getActiveNetworkService();

  try {
    execSync(`networksetup -setwebproxystate "${service}" off`, { stdio: 'pipe' });
    execSync(`networksetup -setsecurewebproxystate "${service}" off`, { stdio: 'pipe' });
    console.log(`[Neuron Proxy] macOS proxy cleared on "${service}"`);
  } catch (err) {
    throw new Error(`Failed to clear macOS proxy: ${err.message}`);
  }
}

function _getMacProxyStatus() {
  const service = _getActiveNetworkService();

  try {
    const output = execSync(`networksetup -getwebproxy "${service}"`, { encoding: 'utf-8' });

    const enabledMatch = output.match(/Enabled:\s*(Yes|No)/i);
    const serverMatch = output.match(/Server:\s*(\S+)/);
    const portMatch = output.match(/Port:\s*(\d+)/);

    return {
      enabled: enabledMatch ? enabledMatch[1].toLowerCase() === 'yes' : false,
      host: serverMatch ? serverMatch[1] : null,
      port: portMatch ? parseInt(portMatch[1], 10) : null,
      service,
    };
  } catch (err) {
    return { enabled: false, host: null, port: null };
  }
}

// =============================================================================
// Windows Implementation
// =============================================================================

async function _setWindowsProxy(host, port) {
  const proxyServer = `${host}:${port}`;

  try {
    // Set proxy via registry
    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`,
      { stdio: 'pipe' }
    );
    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`,
      { stdio: 'pipe' }
    );

    // Notify the system of the change
    execSync(
      'netsh winhttp import proxy source=ie',
      { stdio: 'pipe' }
    ).toString();

    console.log(`[Neuron Proxy] Windows proxy set: ${proxyServer}`);
  } catch (err) {
    throw new Error(`Failed to set Windows proxy: ${err.message}`);
  }
}

async function _clearWindowsProxy() {
  try {
    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
      { stdio: 'pipe' }
    );

    execSync('netsh winhttp reset proxy', { stdio: 'pipe' });

    console.log('[Neuron Proxy] Windows proxy cleared.');
  } catch (err) {
    throw new Error(`Failed to clear Windows proxy: ${err.message}`);
  }
}

function _getWindowsProxyStatus() {
  try {
    const enableOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8' }
    );
    const serverOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8' }
    );

    const enableMatch = enableOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/);
    const serverMatch = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/);

    const enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false;

    if (serverMatch) {
      const parts = serverMatch[1].trim().split(':');
      return {
        enabled,
        host: parts[0],
        port: parts[1] ? parseInt(parts[1], 10) : null,
      };
    }

    return { enabled, host: null, port: null };
  } catch (err) {
    return { enabled: false, host: null, port: null };
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  setSystemProxy,
  clearSystemProxy,
  getSystemProxyStatus,
};
```

### File 7: `desktop/src/tray.js`

System tray icon with a context menu for quick proxy control.

```javascript
'use strict';

/**
 * Neuron Interceptor — System Tray
 *
 * Creates a system tray icon with a context menu:
 *   - Toggle Proxy (on/off)
 *   - Proxy status display
 *   - Open Dashboard
 *   - Quit
 */

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let _tray = null;

/**
 * Create the system tray icon and menu.
 *
 * @param {object} callbacks
 * @param {Function} callbacks.onToggleProxy — Called when "Toggle Proxy" is clicked
 * @param {Function} callbacks.onOpenDashboard — Called when "Open Dashboard" is clicked
 * @param {Function} callbacks.onQuit — Called when "Quit" is clicked
 * @param {Function} callbacks.getStatus — Returns { proxyRunning, port }
 * @returns {Tray}
 */
function createTray(callbacks) {
  // Create tray icon (use a small template image for macOS menu bar)
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath);
    // Resize for tray (16x16 on macOS, 32x32 on Windows)
    icon = icon.resize({ width: 16, height: 16 });
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
  } catch (e) {
    // Fallback: create a simple colored square
    icon = nativeImage.createEmpty();
  }

  _tray = new Tray(icon);
  _tray.setToolTip('Neuron Interceptor');

  // Build and set the context menu
  _updateMenu(callbacks);

  // Click on tray icon opens the dashboard (macOS: right-click shows menu)
  _tray.on('click', () => {
    callbacks.onOpenDashboard();
  });

  return _tray;
}

/**
 * Update the tray context menu (called when proxy status changes).
 */
function _updateMenu(callbacks) {
  const status = callbacks.getStatus();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Neuron Interceptor',
      enabled: false,
      icon: null,
    },
    { type: 'separator' },
    {
      label: status.proxyRunning
        ? `Proxy: ON (port ${status.port})`
        : 'Proxy: OFF',
      enabled: false,
    },
    {
      label: status.proxyRunning ? 'Stop Proxy' : 'Start Proxy',
      click: async () => {
        await callbacks.onToggleProxy();
        _updateMenu(callbacks);
      },
    },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: callbacks.onOpenDashboard,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: callbacks.onQuit,
    },
  ]);

  _tray.setContextMenu(contextMenu);

  // Update tooltip
  _tray.setToolTip(
    status.proxyRunning
      ? `Neuron Interceptor - Proxy ON (port ${status.port})`
      : 'Neuron Interceptor - Proxy OFF'
  );
}

module.exports = {
  createTray,
};
```

### File 8: `desktop/src/rule-engine.js`

Rule matching logic adapted from the Chrome extension's interceptor-inject.js for use in the Node.js proxy server.

```javascript
'use strict';

/**
 * Neuron Interceptor — Rule Engine (Desktop)
 *
 * Evaluates interception rules against proxied HTTP requests.
 * This is the Node.js adaptation of the rule matching logic from
 * content/interceptor-inject.js.
 */

/**
 * Find the first matching rule for a given request.
 *
 * @param {string} url — Full request URL
 * @param {string} method — HTTP method (GET, POST, etc.)
 * @param {object} headers — Request headers
 * @param {string} body — Request body (for body matching)
 * @param {object[]} rules — Array of rule objects
 * @returns {object|null} — The matched rule, or null
 */
function matchRule(url, method, headers, body, rules) {
  if (!rules || rules.length === 0) return null;

  // Sort by priority (lower number = higher priority)
  const sorted = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => (a.priority || 10) - (b.priority || 10));

  for (const rule of sorted) {
    if (_matchesRule(url, method, headers, body, rule)) {
      return rule;
    }
  }

  return null;
}

/**
 * Check if a request matches a specific rule.
 */
function _matchesRule(url, method, headers, body, rule) {
  const condition = rule.condition;
  if (!condition) return false;

  // URL matching
  if (condition.url && condition.url.value) {
    if (!_matchesURL(url, condition.url)) return false;
  }

  // Method matching
  if (condition.methods && condition.methods.length > 0) {
    if (!condition.methods.includes(method.toUpperCase())) return false;
  }

  // Header matching
  if (condition.headers && condition.headers.length > 0) {
    if (!_matchesHeaders(headers, condition.headers)) return false;
  }

  // Body matching (if present)
  if (condition.body && condition.body.length > 0) {
    if (!_matchesBody(body, condition.body)) return false;
  }

  return true;
}

/**
 * Match a URL against a URL condition.
 */
function _matchesURL(url, urlCondition) {
  const { type, value } = urlCondition;

  switch (type) {
    case 'equals':
      return url === value;

    case 'contains':
      return url.includes(value);

    case 'regex':
      try {
        return new RegExp(value).test(url);
      } catch (e) {
        return false;
      }

    case 'glob':
      return _globMatch(url, value);

    default:
      return false;
  }
}

/**
 * Match request headers against header conditions.
 */
function _matchesHeaders(headers, conditions) {
  for (const condition of conditions) {
    const headerValue = headers[condition.name.toLowerCase()];
    if (!headerValue) return false;

    switch (condition.type) {
      case 'equals':
        if (headerValue !== condition.value) return false;
        break;
      case 'contains':
        if (!headerValue.includes(condition.value)) return false;
        break;
      case 'regex':
        try {
          if (!new RegExp(condition.value).test(headerValue)) return false;
        } catch (e) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Match request body against body conditions (JSON path).
 */
function _matchesBody(body, conditions) {
  if (!body) return false;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    // For non-JSON bodies, use string matching
    for (const cond of conditions) {
      if (cond.type === 'contains' && !body.includes(cond.value)) return false;
      if (cond.type === 'regex') {
        try {
          if (!new RegExp(cond.value).test(body)) return false;
        } catch (e2) {
          return false;
        }
      }
    }
    return true;
  }

  for (const cond of conditions) {
    const actual = _resolveJsonPath(parsed, cond.path);

    switch (cond.type) {
      case 'equals':
        if (String(actual) !== String(cond.value)) return false;
        break;
      case 'contains':
        if (!String(actual).includes(cond.value)) return false;
        break;
      case 'exists':
        if (actual === undefined) return false;
        break;
      case 'regex':
        try {
          if (!new RegExp(cond.value).test(String(actual))) return false;
        } catch (e) {
          return false;
        }
        break;
      default:
        return false;
    }
  }

  return true;
}

/**
 * Resolve a simple JSON path ($.a.b.c) against an object.
 */
function _resolveJsonPath(obj, pathStr) {
  if (!pathStr) return obj;

  const parts = pathStr
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);

  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array notation: items[0]
    const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      current = current[bracketMatch[1]];
      if (Array.isArray(current)) {
        current = current[parseInt(bracketMatch[2], 10)];
      } else {
        return undefined;
      }
    } else {
      current = current[part];
    }
  }

  return current;
}

/**
 * Simple glob pattern matching.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function _globMatch(str, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*');

  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch (e) {
    return false;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  matchRule,
};
```

## Verification

### Step 1: Install Dependencies

```bash
cd desktop/
npm install
```

### Step 2: Launch the App

```bash
npm start
# Expected: Electron window opens with the Neuron Interceptor dashboard
# Expected: System tray icon appears
# Expected: Root CA certificate generated in ~/Library/Application Support/neuron-interceptor-desktop/certs/
```

### Step 3: Verify Proxy Starts

1. Click "Start Proxy" in the dashboard or system tray menu
2. Expected: status shows "Proxy: ON (port 8080)"
3. Test with curl:
   ```bash
   curl -x http://127.0.0.1:8080 http://httpbin.org/get
   # Expected: HTTP response from httpbin.org (proxied)
   ```

### Step 4: Verify HTTPS Interception

1. Click "Install Certificate" button in the dashboard
2. Enter system password when prompted (macOS Keychain / Windows cert store)
3. Test HTTPS interception:
   ```bash
   curl -x http://127.0.0.1:8080 https://httpbin.org/get
   # Expected: HTTPS response (MITM'd through local CA)
   ```

### Step 5: Verify Rule Matching

1. Add a rule in the dashboard: URL contains "httpbin.org/get", action = mock_inline, body = `{"mocked": true}`
2. Make a request through the proxy:
   ```bash
   curl -x http://127.0.0.1:8080 http://httpbin.org/get
   # Expected: {"mocked": true}
   ```

### Step 6: Verify System Proxy Configuration

1. Click "Set System Proxy" in the dashboard
2. Open System Preferences > Network > Proxies (macOS) -- should show HTTP/HTTPS proxy 127.0.0.1:8080
3. Open a regular browser tab and load a page -- traffic should appear in the dashboard
4. Click "Clear System Proxy" -- proxy settings should be removed

### Step 7: Verify Mobile Device Support

1. In the dashboard, note the "Mobile Setup" section showing: IP `192.168.x.x`, Port `8080`
2. On an iOS/Android device on the same WiFi network:
   - Go to WiFi settings > HTTP Proxy > Manual
   - Server: `192.168.x.x`, Port: `8080`
3. Browse from the phone -- requests should appear in the desktop dashboard
4. For HTTPS: open `http://192.168.x.x:8080/cert` to download and install the root CA on the device

### Step 8: Verify System Tray

1. Right-click the tray icon (macOS: click)
2. Expected menu items: "Proxy: ON (port 8080)", "Stop Proxy", "Open Dashboard", "Quit"
3. Click "Stop Proxy" -- proxy stops, menu updates to "Proxy: OFF" / "Start Proxy"
4. Click "Open Dashboard" -- main window shows
5. Click "Quit" -- app exits, system proxy is cleared

### Step 9: Build Distributable

```bash
npm run build:mac
# Expected: dist/ contains .dmg and .zip files

npm run build:win
# Expected: dist/ contains .exe installer
```
