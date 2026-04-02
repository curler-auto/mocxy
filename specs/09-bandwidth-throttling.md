# Feature 1.9 — Bandwidth Throttling

## Summary

Simulate slow network conditions by applying configurable delays to all intercepted requests. Introduces "Network Profiles" -- preset configurations that model common network conditions (Fast 3G, Slow 3G, Offline, Custom). The delay is calculated dynamically based on the profile's latency and the response's size divided by the simulated download speed. Adds a quick-access dropdown in the popup for instant profile switching, and a settings section in the Options page for custom profile configuration.

## Why

Front-end developers and QA testers need to verify how the Neuron NMS dashboard behaves under degraded network conditions:

- Loading spinners and skeleton screens during slow responses
- Timeout handling and retry logic
- User experience on mobile/satellite connections (relevant to in-flight connectivity monitoring)
- Error states when the network is completely unavailable
- Performance regression testing under realistic conditions

Chrome DevTools has built-in throttling, but it cannot be configured per-tab, persisted across sessions, or controlled programmatically. This feature provides persistent, rule-independent throttling that can be toggled from the popup without opening DevTools.

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Tech**: Chrome Extension MV3, vanilla JS (ES modules), no build step
- **Theme**: Dark (Catppuccin Mocha palette), CSS variables in `options/options.css`
- **Interception**: `content/interceptor-inject.js` overrides fetch/XHR in the MAIN world
- **Popup**: `popup/popup.html` + `popup/popup.js` + `popup/popup.css` for the browser action
- **Settings**: `options/components/settings-panel.js` manages global settings
- **Storage**: `chrome.storage.local` for settings (via `STORAGE_KEYS.SETTINGS`)
- **Existing delay**: Rules already support `action.delayMs` for per-rule static delays. This feature adds a **global** network simulation layer that operates independently of per-rule delays.

## Files to Modify

| File | Change |
|------|--------|
| `shared/constants.js` | Add `NETWORK_PROFILES` constant and `STORAGE_KEYS.NETWORK_PROFILE` |
| `shared/data-models.js` | No changes needed (profiles are stored as settings, not as rule data) |
| `content/interceptor-inject.js` | Add global throttling logic in fetch/XHR overrides using active network profile; receive profile updates via window messages |
| `content/content-script.js` | Forward network profile updates to inject script |
| `popup/popup.html` | Add network profile dropdown in the stats row area |
| `popup/popup.js` | Add profile dropdown logic, storage read/write |
| `popup/popup.css` | Add styles for the network profile selector |
| `options/components/settings-panel.js` | Add Network Profiles section with custom profile editor |
| `options/options.css` | Add styles for the network profile settings UI |

## Data Model Changes

### `shared/constants.js`

Add the `NETWORK_PROFILES` constant:

```js
/**
 * Predefined network profiles for bandwidth throttling.
 * latencyMs:     Simulated round-trip latency added to every request.
 * downloadKbps:  Simulated download speed in kilobits per second.
 * uploadKbps:    Simulated upload speed in kilobits per second.
 *
 * Delay formula:
 *   totalDelay = latencyMs + (responseBytes / (downloadKbps * 128))
 *   where 128 = 1024 / 8 (convert Kbps to bytes/sec, then to ms)
 */
export const NETWORK_PROFILES = {
  NORMAL: {
    name: 'Normal',
    latencyMs: 0,
    downloadKbps: 0,
    uploadKbps: 0,
  },
  FAST_3G: {
    name: 'Fast 3G',
    latencyMs: 100,
    downloadKbps: 1500,
    uploadKbps: 750,
  },
  SLOW_3G: {
    name: 'Slow 3G',
    latencyMs: 2000,
    downloadKbps: 400,
    uploadKbps: 400,
  },
  OFFLINE: {
    name: 'Offline',
    latencyMs: 0,
    downloadKbps: 0,
    uploadKbps: 0,
  },
  CUSTOM: {
    name: 'Custom',
    latencyMs: 0,
    downloadKbps: 0,
    uploadKbps: 0,
  },
};
```

Add to `STORAGE_KEYS`:

```js
export const STORAGE_KEYS = {
  RULES: 'neuron_rules',
  MOCK_COLLECTIONS: 'neuron_mock_collections',
  SETTINGS: 'neuron_settings',
  INTERCEPTOR_ENABLED: 'neuron_enabled',
  NETWORK_PROFILE: 'neuron_network_profile',   // <-- NEW
};
```

Add to `DEFAULT_SETTINGS`:

```js
export const DEFAULT_SETTINGS = {
  maxLogEntries: 1000,
  logRetentionHours: 24,
  enabledDomains: [],
  enableLogging: true,
  theme: 'dark',
  networkProfile: 'NORMAL',              // <-- NEW: active profile key
  customProfile: {                        // <-- NEW: user-defined custom values
    latencyMs: 500,
    downloadKbps: 1000,
    uploadKbps: 500,
  },
};
```

Add to `MSG_TYPES`:

```js
export const MSG_TYPES = {
  // ... existing types ...
  SET_NETWORK_PROFILE: 'SET_NETWORK_PROFILE',   // <-- NEW
  GET_NETWORK_PROFILE: 'GET_NETWORK_PROFILE',   // <-- NEW
};
```

## Implementation

### 1. Interceptor Throttling Logic (`content/interceptor-inject.js`)

#### Add state variables

At the top of the IIFE, after the existing state variables (`rules`, `mockCollections`, `enabled`), add:

```js
/** Active network profile for bandwidth throttling. */
let networkProfile = null;  // null = no throttling (Normal)
```

#### Add message listener for profile updates

In the existing `window.addEventListener('message', ...)` handler, add a new case:

```js
window.addEventListener('message', (event) => {
  if (event.data?.source === 'neuron-interceptor-content') {
    if (event.data.type === 'RULES_UPDATED') {
      rules = event.data.data.rules || [];
      mockCollections = event.data.data.mockCollections || [];
      enabled = event.data.data.enabled ?? false;
      console.log('[Neuron] Rules updated:', rules.length, 'rules,', mockCollections.length, 'collections,', 'enabled:', enabled);
    }
    // NEW: handle network profile updates
    if (event.data.type === 'NETWORK_PROFILE_UPDATED') {
      networkProfile = event.data.data || null;
      if (networkProfile && networkProfile.name !== 'Normal') {
        console.log('[Neuron] Network profile:', networkProfile.name,
          '| latency:', networkProfile.latencyMs + 'ms',
          '| download:', networkProfile.downloadKbps + 'Kbps');
      } else {
        console.log('[Neuron] Network profile: Normal (no throttling)');
      }
    }
  }
});
```

#### Add delay calculation helper

Add this function in the Helpers section:

```js
/**
 * Calculate the throttling delay for a response based on the active network profile.
 *
 * @param {number} responseBytes  The size of the response body in bytes.
 * @returns {number}              The delay in milliseconds (0 if no throttling).
 */
function calculateThrottleDelay(responseBytes) {
  if (!networkProfile || networkProfile.name === 'Normal') return 0;
  if (networkProfile.downloadKbps <= 0) return networkProfile.latencyMs || 0;

  // totalDelay = latencyMs + (responseBytes / (downloadKbps * 128))
  // 128 = 1024 / 8: convert kilobits/sec to bytes/sec → Kbps * 1000 / 8 = Kbps * 125
  // More precisely: Kbps * 1024 / 8 = Kbps * 128 bytes/sec
  const transferDelay = Math.round(responseBytes / (networkProfile.downloadKbps * 128) * 1000);
  return (networkProfile.latencyMs || 0) + transferDelay;
}

/**
 * Check if the current network profile is 'Offline'.
 * @returns {boolean}
 */
function isOfflineMode() {
  return networkProfile && networkProfile.name === 'Offline';
}
```

#### Apply throttling in fetch override

In the `window.fetch` override, add offline and throttling logic. Insert this check **before** the `findMatchingRule` call:

```js
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string'
    ? input
    : input instanceof Request
      ? input.url
      : String(input);
  const method = init.method || (input instanceof Request ? input.method : 'GET');
  const headers = init.headers || {};
  const startTime = performance.now();

  // --- Network profile: Offline mode ---
  if (isOfflineMode()) {
    console.log('[Neuron] Offline mode: blocking fetch to', url);
    postLog({
      url, method, statusCode: 0,
      duration: 0, intercepted: true,
      actionTaken: 'network_offline',
    });
    throw new TypeError('Failed to fetch');
  }

  // ... existing rule matching and action execution ...

  // After getting a response (whether from rule action or passthrough),
  // apply network throttling delay BEFORE returning:
```

For the **passthrough** path (no rule match, no mock match), wrap the response with throttling. Replace the passthrough section:

```js
  // No match - passthrough with optional logging and network throttling
  const resp = await originalFetch.apply(this, arguments);

  // Apply network throttle delay if profile is active
  if (networkProfile && networkProfile.name !== 'Normal' && !isOfflineMode()) {
    // Estimate response size from Content-Length header, or use arrayBuffer
    let responseBytes = 0;
    const contentLength = resp.headers.get('content-length');
    if (contentLength) {
      responseBytes = parseInt(contentLength, 10) || 0;
    } else {
      // Clone and read to get size (more accurate but slightly more expensive)
      try {
        const clone = resp.clone();
        const buffer = await clone.arrayBuffer();
        responseBytes = buffer.byteLength;
      } catch (e) {
        responseBytes = 0;
      }
    }

    const delay = calculateThrottleDelay(responseBytes);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (enabled) {
    postLog({
      url, method,
      statusCode: resp.status,
      duration: Math.round(performance.now() - startTime),
      intercepted: false,
    });
  }
  return resp;
```

For **matched rule** responses, add throttling after the action is applied but before returning. In the `if (matchedRule)` block, after `const result = await applyAction(matchedRule, url, init);`:

```js
if (matchedRule) {
  try {
    const result = await applyAction(matchedRule, url, init);
    const duration = performance.now() - startTime;

    // Apply network throttle on top of any rule-specific delay
    if (networkProfile && networkProfile.name !== 'Normal' && !isOfflineMode()) {
      let responseBytes = 0;
      try {
        const contentLength = result.response.headers.get('content-length');
        if (contentLength) {
          responseBytes = parseInt(contentLength, 10) || 0;
        }
      } catch (e) { /* headers not available */ }
      const throttleDelay = calculateThrottleDelay(responseBytes);
      if (throttleDelay > 0) {
        await new Promise((r) => setTimeout(r, throttleDelay));
      }
    }

    postLog({ ... });
    return result.response;
  } catch (err) { ... }
}
```

#### Apply throttling in XHR override

In `XMLHttpRequest.prototype.send`, add offline mode check at the top:

```js
XMLHttpRequest.prototype.send = function (body) {
  const url = this._neuronUrl;
  const method = this._neuronMethod || 'GET';
  const headers = this._neuronHeaders || {};
  const startTime = performance.now();
  const xhr = this;

  // --- Network profile: Offline mode ---
  if (isOfflineMode()) {
    console.log('[Neuron] Offline mode: blocking XHR to', url);
    setTimeout(() => {
      xhr.dispatchEvent(new ProgressEvent('error'));
      if (xhr.onerror) xhr.onerror(new ProgressEvent('error'));
      postLog({
        url, method, statusCode: 0,
        duration: 0, intercepted: true,
        actionTaken: 'network_offline',
      });
    }, 0);
    return;
  }

  // ... existing rule matching and action execution ...
```

For the XHR **passthrough** path, add throttling by wrapping the `onload` handler:

```js
  // ----- Passthrough with optional logging and network throttling -----
  if (enabled || (networkProfile && networkProfile.name !== 'Normal')) {
    const origOnLoad = xhr.onload;
    xhr.onload = function () {
      const applyThrottle = () => {
        if (enabled) {
          postLog({
            url, method,
            statusCode: xhr.status,
            duration: Math.round(performance.now() - startTime),
            intercepted: false,
          });
        }
        if (origOnLoad) origOnLoad.call(xhr);
      };

      // Calculate throttle delay based on response size
      if (networkProfile && networkProfile.name !== 'Normal' && !isOfflineMode()) {
        const responseBytes = (xhr.responseText || '').length;
        const delay = calculateThrottleDelay(responseBytes);
        if (delay > 0) {
          setTimeout(applyThrottle, delay);
          return; // Don't call origOnLoad immediately
        }
      }

      applyThrottle();
    };
  }

  return originalXHRSend.call(xhr, body);
```

### 2. Content Script Profile Forwarding (`content/content-script.js`)

Add a handler for `NETWORK_PROFILE_UPDATED` messages from the service worker. In the `chrome.runtime.onMessage.addListener` switch, add a new case:

```js
case 'NETWORK_PROFILE_UPDATED':
  window.postMessage({
    source: 'neuron-interceptor-content',
    type: 'NETWORK_PROFILE_UPDATED',
    data: message.data,
  }, '*');
  sendResponse({ ok: true });
  break;
```

Also, on initial load, request the current network profile. After the initial rules request (section 4), add:

```js
// Request current network profile
chrome.runtime.sendMessage({ type: 'GET_NETWORK_PROFILE' })
  .then((response) => {
    if (response && response.profile) {
      window.postMessage({
        source: 'neuron-interceptor-content',
        type: 'NETWORK_PROFILE_UPDATED',
        data: response.profile,
      }, '*');
      console.log('[Neuron Content] Network profile:', response.profile.name);
    }
  })
  .catch(() => {});
```

### 3. Service Worker Message Handling

Add handlers for `SET_NETWORK_PROFILE` and `GET_NETWORK_PROFILE` in `service-worker/message-router.js`. These should:

1. `GET_NETWORK_PROFILE`: Read the active profile from `chrome.storage.local` (under `STORAGE_KEYS.SETTINGS`), resolve the profile object from `NETWORK_PROFILES` or the custom profile, and return it.
2. `SET_NETWORK_PROFILE`: Save the selected profile key to settings, resolve the full profile object, broadcast `NETWORK_PROFILE_UPDATED` to all tabs via `chrome.tabs.sendMessage`.

```js
case MSG_TYPES.GET_NETWORK_PROFILE: {
  const settings = await storageManager.getSettings();
  const profileKey = settings.networkProfile || 'NORMAL';
  let profile;
  if (profileKey === 'CUSTOM') {
    profile = { name: 'Custom', ...(settings.customProfile || {}) };
  } else {
    profile = NETWORK_PROFILES[profileKey] || NETWORK_PROFILES.NORMAL;
  }
  sendResponse({ profile });
  break;
}

case MSG_TYPES.SET_NETWORK_PROFILE: {
  const { profileKey } = message;
  const settings = await storageManager.getSettings();
  settings.networkProfile = profileKey;
  await storageManager.setSettings(settings);

  // Resolve the full profile object
  let profile;
  if (profileKey === 'CUSTOM') {
    profile = { name: 'Custom', ...(settings.customProfile || {}) };
  } else {
    profile = NETWORK_PROFILES[profileKey] || NETWORK_PROFILES.NORMAL;
  }

  // Broadcast to all tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'NETWORK_PROFILE_UPDATED',
        data: profile,
      });
    } catch (e) { /* Tab may not have content script */ }
  }

  sendResponse({ ok: true, profile });
  break;
}
```

### 4. Popup UI (`popup/popup.html`)

Add the network profile dropdown between the stats row and the "Recent Intercepts" section label. Insert after the closing `</div>` of `.stats-row` and before the `.section-label`:

```html
<!-- Network Profile Selector -->
<div class="network-profile-row" id="networkProfileRow">
  <span class="network-profile-label">Network</span>
  <select class="network-profile-select" id="networkProfileSelect">
    <option value="NORMAL">Normal</option>
    <option value="FAST_3G">Fast 3G</option>
    <option value="SLOW_3G">Slow 3G</option>
    <option value="OFFLINE">Offline</option>
    <option value="CUSTOM">Custom</option>
  </select>
</div>
```

### 5. Popup JS (`popup/popup.js`)

Add DOM reference and event handler. After the existing DOM references:

```js
const $networkProfileSelect = document.getElementById('networkProfileSelect');
```

Add the event handler after the existing event handlers:

```js
/** Network profile change — apply globally. */
$networkProfileSelect.addEventListener('change', async () => {
  const profileKey = $networkProfileSelect.value;
  try {
    await sendMsg('SET_NETWORK_PROFILE', { profileKey });
    // Update visual indicator
    _updateNetworkIndicator(profileKey);
  } catch (err) {
    console.warn('[NeuronPopup] Set network profile failed:', err);
  }
});

/**
 * Update the visual state of the network profile selector.
 */
function _updateNetworkIndicator(profileKey) {
  $networkProfileSelect.className = 'network-profile-select';
  if (profileKey === 'OFFLINE') {
    $networkProfileSelect.classList.add('network-offline');
  } else if (profileKey !== 'NORMAL') {
    $networkProfileSelect.classList.add('network-throttled');
  }
}
```

Add profile loading to `refreshStatus()`. After the existing `renderStats(...)` call:

```js
// Load network profile
try {
  const profileResp = await sendMsg('GET_NETWORK_PROFILE');
  if (profileResp && profileResp.profile) {
    // Find the matching option and select it
    const profileName = profileResp.profile.name;
    for (const opt of $networkProfileSelect.options) {
      if (opt.textContent === profileName || opt.value === profileName.toUpperCase().replace(/\s+/g, '_')) {
        opt.selected = true;
        break;
      }
    }
    _updateNetworkIndicator($networkProfileSelect.value);
  }
} catch (err) {
  // Network profile not available -- leave at Normal
}
```

### 6. Popup CSS (`popup/popup.css`)

Add after the `.stats-row` section:

```css
/* -------------------------------------------------------------------------- */
/*  Network Profile Selector                                                  */
/* -------------------------------------------------------------------------- */

.network-profile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  margin: 0 12px 4px;
  background: #181825;
  border-radius: 6px;
  flex-shrink: 0;
}

.network-profile-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #a6adc8;
}

.network-profile-select {
  padding: 4px 10px;
  border: 1px solid #45475a;
  border-radius: 4px;
  background: #1e1e2e;
  color: #cdd6f4;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.network-profile-select:focus {
  border-color: #89b4fa;
  box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.2);
}

.network-profile-select:hover {
  border-color: #585b70;
}

/* Visual indicators for active throttling */
.network-profile-select.network-throttled {
  border-color: #f9e2af;
  color: #f9e2af;
  background: rgba(249, 226, 175, 0.08);
}

.network-profile-select.network-offline {
  border-color: #f38ba8;
  color: #f38ba8;
  background: rgba(243, 139, 168, 0.08);
}

/* Disabled state */
body.disabled .network-profile-row {
  opacity: 0.4;
  pointer-events: none;
}
```

### 7. Settings Panel (`options/components/settings-panel.js`)

Add a Network Profiles section to the Settings panel. Insert this HTML in the `container.innerHTML` template, after the "Logging" section and before the "Domain Filtering" section:

```html
<!-- ============================================================= -->
<!--  Network Profiles Section                                      -->
<!-- ============================================================= -->
<div class="sp-section">
  <h3 class="sp-section-title">Network Profiles</h3>
  <p class="sp-description">
    Simulate network conditions by adding latency and bandwidth limits to all requests.
    Select a preset or configure a custom profile.
  </p>

  <div class="sp-field">
    <label class="sp-label" for="activeNetworkProfile">Active Profile</label>
    <select class="input sp-select" id="activeNetworkProfile">
      <option value="NORMAL">Normal (no throttling)</option>
      <option value="FAST_3G">Fast 3G (100ms latency, 1.5 Mbps)</option>
      <option value="SLOW_3G">Slow 3G (2000ms latency, 400 Kbps)</option>
      <option value="OFFLINE">Offline (block all requests)</option>
      <option value="CUSTOM">Custom</option>
    </select>
  </div>

  <!-- Custom profile fields (shown only when Custom is selected) -->
  <div id="customProfileFields" class="sp-custom-profile hidden">
    <div class="sp-field">
      <label class="sp-label" for="customLatency">Latency (ms)</label>
      <input
        type="number"
        class="input sp-number-input"
        id="customLatency"
        min="0"
        max="30000"
        step="50"
        value="500"
      >
      <span class="sp-field-hint">Round-trip delay added to every request</span>
    </div>

    <div class="sp-field">
      <label class="sp-label" for="customDownload">Download (Kbps)</label>
      <input
        type="number"
        class="input sp-number-input"
        id="customDownload"
        min="0"
        max="100000"
        step="50"
        value="1000"
      >
      <span class="sp-field-hint">Simulated download speed in kilobits/sec (0 = no limit)</span>
    </div>

    <div class="sp-field">
      <label class="sp-label" for="customUpload">Upload (Kbps)</label>
      <input
        type="number"
        class="input sp-number-input"
        id="customUpload"
        min="0"
        max="100000"
        step="50"
        value="500"
      >
      <span class="sp-field-hint">Simulated upload speed in kilobits/sec (0 = no limit)</span>
    </div>

    <div class="sp-throttle-preview" id="throttlePreview">
      <span class="sp-throttle-preview-label">Estimated delay for a 100KB response:</span>
      <span class="sp-throttle-preview-value" id="throttlePreviewValue">—</span>
    </div>
  </div>
</div>
```

Add the JavaScript logic in the `initSettingsPanel` function body, after the existing DOM references:

```js
// Network profile DOM references
const $activeProfile    = container.querySelector('#activeNetworkProfile');
const $customFields     = container.querySelector('#customProfileFields');
const $customLatency    = container.querySelector('#customLatency');
const $customDownload   = container.querySelector('#customDownload');
const $customUpload     = container.querySelector('#customUpload');
const $throttlePreview  = container.querySelector('#throttlePreviewValue');

// Toggle custom fields visibility
$activeProfile.addEventListener('change', () => {
  const isCustom = $activeProfile.value === 'CUSTOM';
  $customFields.classList.toggle('hidden', !isCustom);
  _applyNetworkProfile();
});

// Auto-save custom profile values
$customLatency.addEventListener('input', () => { _updateThrottlePreview(); scheduleSave(); });
$customDownload.addEventListener('input', () => { _updateThrottlePreview(); scheduleSave(); });
$customUpload.addEventListener('input', () => { scheduleSave(); });

/**
 * Apply the selected network profile by sending a message to the service worker.
 */
async function _applyNetworkProfile() {
  const profileKey = $activeProfile.value;
  currentSettings.networkProfile = profileKey;

  if (profileKey === 'CUSTOM') {
    currentSettings.customProfile = {
      latencyMs: parseInt($customLatency.value, 10) || 0,
      downloadKbps: parseInt($customDownload.value, 10) || 0,
      uploadKbps: parseInt($customUpload.value, 10) || 0,
    };
  }

  try {
    await sendMessage('SET_NETWORK_PROFILE', { profileKey });
    await saveSettings();
  } catch (err) {
    console.error('[Neuron] Failed to apply network profile:', err);
  }
}

/**
 * Update the throttle preview text showing estimated delay.
 */
function _updateThrottlePreview() {
  const latency = parseInt($customLatency.value, 10) || 0;
  const downloadKbps = parseInt($customDownload.value, 10) || 0;

  if (downloadKbps <= 0) {
    $throttlePreview.textContent = latency > 0 ? latency + 'ms (latency only)' : 'No throttling';
    return;
  }

  // 100KB = 102400 bytes
  const transferDelay = Math.round(102400 / (downloadKbps * 128) * 1000);
  const total = latency + transferDelay;
  $throttlePreview.textContent = total + 'ms (' + latency + 'ms latency + ' + transferDelay + 'ms transfer)';
}
```

Update the `loadSettings()` function to populate network profile fields:

```js
// Inside loadSettings(), after populating existing controls:

// Network profile
$activeProfile.value = currentSettings.networkProfile || 'NORMAL';
$customFields.classList.toggle('hidden', $activeProfile.value !== 'CUSTOM');

if (currentSettings.customProfile) {
  $customLatency.value = currentSettings.customProfile.latencyMs ?? 500;
  $customDownload.value = currentSettings.customProfile.downloadKbps ?? 1000;
  $customUpload.value = currentSettings.customProfile.uploadKbps ?? 500;
}

_updateThrottlePreview();
```

Update the `saveSettings()` function to include network profile data:

```js
// Inside saveSettings(), before the sendMessage call:
currentSettings.networkProfile = $activeProfile.value;
if ($activeProfile.value === 'CUSTOM') {
  currentSettings.customProfile = {
    latencyMs: parseInt($customLatency.value, 10) || 0,
    downloadKbps: parseInt($customDownload.value, 10) || 0,
    uploadKbps: parseInt($customUpload.value, 10) || 0,
  };
}
```

## CSS

Add to `options/options.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Network Profiles (Settings Panel)                                         */
/* -------------------------------------------------------------------------- */

.sp-custom-profile {
  margin-top: 12px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-overlay);
}

.sp-custom-profile .sp-field {
  margin-bottom: 10px;
}

.sp-field-hint {
  display: block;
  font-size: 11px;
  color: var(--text-subtle);
  margin-top: 2px;
}

.sp-throttle-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(137, 180, 250, 0.06);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.sp-throttle-preview-label {
  color: var(--text-muted);
}

.sp-throttle-preview-value {
  color: var(--accent);
  font-weight: 600;
  font-family: var(--font-mono);
}
```

## Example Delay Calculations

| Profile | 100 KB Response | 1 MB Response | 10 MB Response |
|---------|----------------|---------------|----------------|
| Normal | 0ms | 0ms | 0ms |
| Fast 3G | 100 + 533 = 633ms | 100 + 5461 = 5561ms | 100 + 54613 = 54713ms |
| Slow 3G | 2000 + 2000 = 4000ms | 2000 + 20480 = 22480ms | 2000 + 204800 = 206800ms |
| Offline | Error thrown | Error thrown | Error thrown |

Formula: `totalDelay = latencyMs + (bytes / (downloadKbps * 128) * 1000)`

Example for Fast 3G, 100KB:
- `latencyMs = 100`
- `bytes = 102400`
- `downloadBytesPerSec = 1500 * 128 = 192000`
- `transferMs = 102400 / 192000 * 1000 = 533ms`
- `total = 100 + 533 = 633ms`

## Verification Steps

### Manual Testing

1. **Load the extension** in `chrome://extensions` (developer mode, load unpacked).

2. **Test popup dropdown**:
   - Open the popup by clicking the extension icon.
   - Verify the "Network" dropdown shows with "Normal" selected.
   - Change to "Slow 3G" -- dropdown border should turn yellow.
   - Change to "Offline" -- dropdown border should turn red.
   - Change back to "Normal" -- dropdown should return to default styling.

3. **Test Slow 3G throttling**:
   - Select "Slow 3G" in the popup.
   - Open DevTools Network tab.
   - Navigate to a page or trigger an API call.
   - Verify requests take noticeably longer (2+ seconds even for small responses).
   - Check the console for `[Neuron] Network profile: Slow 3G` log.

4. **Test Fast 3G throttling**:
   - Select "Fast 3G" in the popup.
   - Trigger API calls.
   - Verify a moderate delay (~100ms + transfer time).

5. **Test Offline mode**:
   - Select "Offline" in the popup.
   - Try to fetch any URL from the console:
     ```js
     fetch('/api/test').catch(err => console.log('Error:', err.message));
     // Expected: "Error: Failed to fetch"
     ```
   - Verify XHR also fails:
     ```js
     const xhr = new XMLHttpRequest();
     xhr.open('GET', '/api/test');
     xhr.onerror = () => console.log('XHR failed (offline)');
     xhr.send();
     ```

6. **Test Custom profile**:
   - Go to Options > Settings.
   - Select "Custom" profile.
   - Set latency to 500ms, download to 500 Kbps.
   - Verify the throttle preview shows estimated delay.
   - Navigate to a page -- verify requests are delayed.

7. **Test profile persistence**:
   - Select "Slow 3G", close the popup.
   - Reopen the popup -- should still show "Slow 3G".
   - Reload the page -- throttling should still be active.

8. **Test profile applies to all tabs**:
   - Open two tabs.
   - Set profile to "Slow 3G" from one tab's popup.
   - Trigger a request in the other tab -- should also be throttled.

9. **Test interaction with per-rule delays**:
   - Create a rule with `delayMs: 1000`.
   - Set profile to "Fast 3G" (100ms latency).
   - Trigger a matching request.
   - Total delay should be approximately 1000ms (rule) + 100ms (profile latency) + transfer delay.

10. **Test with intercepted requests**:
    - Create a mock_inline rule.
    - Set profile to "Slow 3G".
    - Trigger the mocked request.
    - Even though the response is instant (mock), the network profile delay should still apply.

11. **Verify Normal mode**:
    - Set profile back to "Normal".
    - Verify no artificial delays are added.
    - Console should show `[Neuron] Network profile: Normal (no throttling)`.

12. **Verify existing functionality** still works (rules, mocks, logging) with throttling disabled.

13. **Test the settings panel UI**:
    - Go to Options > Settings.
    - Verify the Network Profiles section appears.
    - Select "Custom" -- custom fields should appear.
    - Select "Normal" -- custom fields should hide.
    - Modify custom values -- throttle preview should update in real time.

### Edge Cases to Verify

- Very large response (>10 MB) with Slow 3G -- delay may be very long; should not cause browser tab to become unresponsive (the delay is a simple setTimeout, not blocking).
- Switching profiles while a request is in-flight -- the in-flight request should use the profile that was active when it started.
- Offline mode with WebSocket connections -- this feature only affects fetch and XHR, not WebSocket (document this limitation).
- Network profile combined with mock_inline -- mock responses have no real transfer time, but latency should still be applied.
- Network profile set to Custom with all zeros -- should behave like Normal (no throttling).
- Popup opened in a different window/profile -- each window should share the same profile (stored in chrome.storage.local).
