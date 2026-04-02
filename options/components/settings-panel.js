/**
 * Mocxy - Settings Panel Component
 * Global settings management with auto-save, domain filtering, logging
 * configuration, and a full reset option.
 */

import { MSG_TYPES, DEFAULT_SETTINGS } from '../../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Auto-save debounce delay in milliseconds. */
const SAVE_DEBOUNCE_MS = 500;

/** Available log-retention presets. */
const RETENTION_OPTIONS = [
  { label: '1 hour',   value: 1 },
  { label: '6 hours',  value: 6 },
  { label: '12 hours', value: 12 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '7 days',   value: 168 },
];

/** Extension metadata (mirrors manifest.json). */
const EXTENSION_VERSION = '1.0.0';
const EXTENSION_SOURCE  = 'health_check/utils/mocxy-plugin';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Send a message to the service worker and return the response.
 *
 * @param {string} type   MSG_TYPES key.
 * @param {Object} [data] Optional payload.
 * @returns {Promise<*>}
 */
function sendMessage(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

/**
 * Standard debounce wrapper.
 *
 * @param {Function} fn
 * @param {number}   ms
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* -------------------------------------------------------------------------- */
/*  UI Initialisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build and mount the Settings panel inside the given container.
 *
 * @param {HTMLElement} container  The DOM element to render into.
 */
export function initSettingsPanel(container) {
  // ---------------------------------------------------------------------- //
  //  State                                                                  //
  // ---------------------------------------------------------------------- //
  let currentSettings = { ...DEFAULT_SETTINGS };

  // ---------------------------------------------------------------------- //
  //  Markup                                                                 //
  // ---------------------------------------------------------------------- //
  container.innerHTML = `
    <!-- ============================================================= -->
    <!--  Logging Section                                               -->
    <!-- ============================================================= -->
    <div class="sp-section">
      <h3 class="sp-section-title">Logging</h3>

      <div class="sp-field">
        <label class="sp-toggle-label">
          <span class="sp-label-text">Enable Logging</span>
          <label class="toggle">
            <input type="checkbox" id="enableLoggingToggle" checked>
            <span class="toggle-slider"></span>
          </label>
        </label>
      </div>

      <div class="sp-field">
        <label class="sp-label" for="maxLogEntries">Max Log Entries</label>
        <input
          type="number"
          class="input sp-number-input"
          id="maxLogEntries"
          min="100"
          max="50000"
          step="100"
          value="${DEFAULT_SETTINGS.maxLogEntries}"
        >
      </div>

      <div class="sp-field">
        <label class="sp-label" for="logRetention">Log Retention</label>
        <select class="input sp-select" id="logRetention">
          ${RETENTION_OPTIONS.map(
            (opt) =>
              `<option value="${opt.value}"${opt.value === DEFAULT_SETTINGS.logRetentionHours ? ' selected' : ''}>${opt.label}</option>`
          ).join('\n          ')}
        </select>
      </div>
    </div>

    <!-- ============================================================= -->
    <!--  Domain Filtering Section                                      -->
    <!-- ============================================================= -->
    <div class="sp-section">
      <h3 class="sp-section-title">Domain Filtering</h3>
      <p class="sp-description">
        Restrict interception to specific domains.
        If the list is empty, all domains are intercepted.
      </p>

      <div class="sp-domain-list" id="domainList">
        <!-- Domain entries are rendered dynamically -->
      </div>

      <button class="btn btn-secondary sp-add-domain-btn" id="addDomainBtn">+ Add Domain</button>
    </div>

    <!-- ============================================================= -->
    <!--  Interception Section                                          -->
    <!-- ============================================================= -->
    <div class="sp-section">
      <h3 class="sp-section-title">Interception</h3>
      <p class="sp-description">
        When enabled, the interceptor evaluates rules against all network
        requests on matched domains.  Disable individual rules from the
        Rules panel or use domain filtering above to narrow scope.
      </p>
    </div>

    <!-- ============================================================= -->
    <!--  About Section                                                 -->
    <!-- ============================================================= -->
    <div class="sp-section">
      <h3 class="sp-section-title">About</h3>

      <div class="sp-about-row">
        <span class="sp-about-label">Version</span>
        <span class="sp-about-value" id="aboutVersion">${EXTENSION_VERSION}</span>
      </div>

      <div class="sp-about-row">
        <span class="sp-about-label">Source</span>
        <span class="sp-about-value">
          <code class="sp-source-path">${EXTENSION_SOURCE}</code>
        </span>
      </div>

      <div class="sp-reset-area">
        <button class="btn btn-danger" id="resetAllBtn">Reset All Settings</button>
      </div>
    </div>

    <!-- Save indicator (fades in/out on auto-save) -->
    <div class="sp-save-indicator hidden" id="saveIndicator">Settings saved</div>
  `;

  // ---------------------------------------------------------------------- //
  //  DOM references                                                         //
  // ---------------------------------------------------------------------- //
  const $enableLogging  = container.querySelector('#enableLoggingToggle');
  const $maxLogEntries  = container.querySelector('#maxLogEntries');
  const $logRetention   = container.querySelector('#logRetention');
  const $domainList     = container.querySelector('#domainList');
  const $addDomainBtn   = container.querySelector('#addDomainBtn');
  const $resetAllBtn    = container.querySelector('#resetAllBtn');
  const $saveIndicator  = container.querySelector('#saveIndicator');

  // ---------------------------------------------------------------------- //
  //  Domain list rendering                                                  //
  // ---------------------------------------------------------------------- //

  /**
   * Render the dynamic domain entry rows.
   */
  function renderDomains() {
    $domainList.innerHTML = '';

    if (currentSettings.enabledDomains.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sp-domain-empty';
      empty.textContent = 'No domains configured — all domains are intercepted.';
      $domainList.appendChild(empty);
      return;
    }

    currentSettings.enabledDomains.forEach((domain, index) => {
      const row = document.createElement('div');
      row.className = 'sp-domain-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input sp-domain-input';
      input.value = domain;
      input.placeholder = 'e.g. example.com';
      input.dataset.index = index;

      input.addEventListener('input', (e) => {
        currentSettings.enabledDomains[index] = e.target.value.trim();
        scheduleSave();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-icon sp-domain-remove-btn';
      removeBtn.textContent = '\u00D7';
      removeBtn.title = 'Remove domain';
      removeBtn.addEventListener('click', () => {
        currentSettings.enabledDomains.splice(index, 1);
        renderDomains();
        scheduleSave();
      });

      row.appendChild(input);
      row.appendChild(removeBtn);
      $domainList.appendChild(row);
    });
  }

  // ---------------------------------------------------------------------- //
  //  Settings persistence                                                   //
  // ---------------------------------------------------------------------- //

  /**
   * Collect current UI values into the settings object and persist.
   */
  async function saveSettings() {
    currentSettings.enableLogging = $enableLogging.checked;
    currentSettings.maxLogEntries = parseInt($maxLogEntries.value, 10) || DEFAULT_SETTINGS.maxLogEntries;
    currentSettings.logRetentionHours = parseInt($logRetention.value, 10) || DEFAULT_SETTINGS.logRetentionHours;

    // Filter out empty domain strings.
    currentSettings.enabledDomains = currentSettings.enabledDomains.filter((d) => d.length > 0);

    try {
      await sendMessage(MSG_TYPES.SET_SETTINGS, { settings: currentSettings });
      flashSaveIndicator();
    } catch (err) {
      console.error('[Mocxy] Failed to save settings:', err);
    }
  }

  /** Debounced save — called after every change event. */
  const scheduleSave = debounce(saveSettings, SAVE_DEBOUNCE_MS);

  /**
   * Briefly show the "Settings saved" indicator.
   */
  function flashSaveIndicator() {
    $saveIndicator.classList.remove('hidden');
    $saveIndicator.classList.add('sp-save-indicator--visible');

    setTimeout(() => {
      $saveIndicator.classList.remove('sp-save-indicator--visible');
      $saveIndicator.classList.add('hidden');
    }, 1500);
  }

  /**
   * Load current settings from the service worker and populate the UI.
   */
  async function loadSettings() {
    try {
      const stored = await sendMessage(MSG_TYPES.GET_SETTINGS);
      if (stored && typeof stored === 'object') {
        currentSettings = { ...DEFAULT_SETTINGS, ...stored };
      }
    } catch (err) {
      console.warn('[Mocxy] Could not load settings, using defaults:', err);
      currentSettings = { ...DEFAULT_SETTINGS };
    }

    // Populate controls.
    $enableLogging.checked = currentSettings.enableLogging;
    $maxLogEntries.value = currentSettings.maxLogEntries;
    $logRetention.value = currentSettings.logRetentionHours;

    // Ensure enabledDomains is an array.
    if (!Array.isArray(currentSettings.enabledDomains)) {
      currentSettings.enabledDomains = [];
    }

    renderDomains();
  }

  // ---------------------------------------------------------------------- //
  //  Event handlers                                                         //
  // ---------------------------------------------------------------------- //

  // Auto-save on every relevant change.
  $enableLogging.addEventListener('change', scheduleSave);
  $maxLogEntries.addEventListener('input', scheduleSave);
  $logRetention.addEventListener('change', scheduleSave);

  // Add domain.
  $addDomainBtn.addEventListener('click', () => {
    currentSettings.enabledDomains.push('');
    renderDomains();
    // Focus the newly added input.
    const inputs = $domainList.querySelectorAll('.sp-domain-input');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  });

  // Reset all settings — with confirmation.
  $resetAllBtn.addEventListener('click', () => {
    // Use the shared modal if available, otherwise fall back to a simple confirm.
    const modalOverlay = document.getElementById('modalOverlay');
    const modalTitle   = document.getElementById('modalTitle');
    const modalBody    = document.getElementById('modalBody');
    const modalFooter  = document.getElementById('modalFooter');
    const modalClose   = document.getElementById('modalClose');

    if (modalOverlay && modalTitle && modalBody && modalFooter) {
      modalTitle.textContent = 'Reset All Settings';
      modalBody.innerHTML =
        '<p>This will restore all settings to their default values. ' +
        'Rules and mock collections will <strong>not</strong> be affected.</p>' +
        '<p>Are you sure?</p>';
      modalFooter.innerHTML =
        '<button class="btn btn-secondary" id="resetCancelBtn">Cancel</button> ' +
        '<button class="btn btn-danger" id="resetConfirmBtn">Reset</button>';

      modalOverlay.classList.remove('hidden');

      const cleanup = () => modalOverlay.classList.add('hidden');

      modalFooter.querySelector('#resetCancelBtn').addEventListener('click', cleanup);
      modalClose.addEventListener('click', cleanup);
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) cleanup();
      });

      modalFooter.querySelector('#resetConfirmBtn').addEventListener('click', async () => {
        cleanup();
        currentSettings = { ...DEFAULT_SETTINGS };
        await saveSettings();
        loadSettings();
      });
    } else {
      // Fallback: native confirm dialog.
      const confirmed = confirm(
        'Reset all settings to defaults? Rules and mock collections will not be affected.'
      );
      if (confirmed) {
        currentSettings = { ...DEFAULT_SETTINGS };
        saveSettings().then(() => loadSettings());
      }
    }
  });

  // ---------------------------------------------------------------------- //
  //  Initialise                                                             //
  // ---------------------------------------------------------------------- //
  loadSettings();
}
