/**
 * Mocxy - Import / Export Component
 * Provides UI for exporting and importing rules, mock collections, and settings
 * as JSON files.  Supports file drag-and-drop, paste, and merge/replace modes.
 */

import { MSG_TYPES } from '../../shared/constants.js';

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
 * Return today's date formatted as `YYYY-MM-DD` for use in filenames.
 *
 * @returns {string}
 */
function dateSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* -------------------------------------------------------------------------- */
/*  Core logic                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate the shape of an imported JSON object and return a human-readable
 * summary describing what it contains.
 *
 * @param {*} data  The parsed JSON value.
 * @returns {{ valid: boolean, summary: string, counts: { rules: number, mockCollections: number, hasSettings: boolean } }}
 */
function validateImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, summary: 'Invalid format: expected a JSON object at the top level.' };
  }

  const counts = {
    rules: 0,
    mockCollections: 0,
    hasSettings: false,
  };

  if (data.rules !== undefined) {
    if (!Array.isArray(data.rules)) {
      return { valid: false, summary: 'Invalid format: "rules" must be an array.' };
    }
    counts.rules = data.rules.length;
  }

  if (data.mockCollections !== undefined) {
    if (!Array.isArray(data.mockCollections)) {
      return { valid: false, summary: 'Invalid format: "mockCollections" must be an array.' };
    }
    counts.mockCollections = data.mockCollections.length;
  }

  if (data.settings !== undefined) {
    if (typeof data.settings !== 'object' || Array.isArray(data.settings)) {
      return { valid: false, summary: 'Invalid format: "settings" must be an object.' };
    }
    counts.hasSettings = true;
  }

  // At least one recognised section must be present.
  if (counts.rules === 0 && counts.mockCollections === 0 && !counts.hasSettings) {
    return {
      valid: false,
      summary: 'No recognised data found. Expected at least one of: rules, mockCollections, settings.',
    };
  }

  const parts = [];
  if (counts.rules > 0) parts.push(`${counts.rules} rule(s)`);
  if (counts.mockCollections > 0) parts.push(`${counts.mockCollections} mock collection(s)`);
  if (counts.hasSettings) parts.push('settings');

  return {
    valid: true,
    summary: `Found: ${parts.join(', ')}.`,
    counts,
  };
}

/**
 * Create a Blob from the given data, build a temporary download link, trigger
 * the download, and revoke the object URL.
 *
 * @param {*}      data     JSON-serialisable value.
 * @param {string} filename Suggested filename including extension.
 */
function downloadJson(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();

  // Cleanup
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Fetch all data from the service worker, optionally filter by type, and
 * trigger a JSON file download.
 *
 * @param {'all' | 'rules' | 'mockCollections'} type  What to export.
 * @returns {Promise<*>}  The exported data object (also used for preview).
 */
async function exportData(type) {
  const allData = await sendMessage(MSG_TYPES.EXPORT_ALL);

  let payload;
  let filename;
  const suffix = dateSuffix();

  switch (type) {
    case 'rules':
      payload = { rules: allData?.rules ?? [] };
      filename = `mocxy-rules-${suffix}.json`;
      break;

    case 'mockCollections':
      payload = { mockCollections: allData?.mockCollections ?? [] };
      filename = `mocxy-mocks-${suffix}.json`;
      break;

    case 'all':
    default:
      payload = {
        rules: allData?.rules ?? [],
        mockCollections: allData?.mockCollections ?? [],
        settings: allData?.settings ?? {},
      };
      filename = `mocxy-config-${suffix}.json`;
      break;
  }

  downloadJson(payload, filename);
  return payload;
}

/**
 * Send imported data to the service worker for persistence.
 *
 * @param {Object}             json  Validated import data.
 * @param {'replace' | 'merge'} mode  Import strategy.
 * @returns {Promise<*>}
 */
async function importData(json, mode) {
  return sendMessage(MSG_TYPES.IMPORT_ALL, { data: json, mode });
}

/* -------------------------------------------------------------------------- */
/*  UI Initialisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build and mount the Import / Export interface inside the given container.
 *
 * @param {HTMLElement} container  The DOM element to render into.
 */
export function initImportExport(container) {
  // ---------------------------------------------------------------------- //
  //  State                                                                  //
  // ---------------------------------------------------------------------- //
  let pendingJson = null;        // Parsed JSON awaiting import.
  let pendingValidation = null;  // Result of validateImport().

  // ---------------------------------------------------------------------- //
  //  Markup                                                                 //
  // ---------------------------------------------------------------------- //
  container.innerHTML = `
    <!-- ============================================================= -->
    <!--  Export Section                                                 -->
    <!-- ============================================================= -->
    <div class="ie-section">
      <h3 class="ie-section-title">Export</h3>
      <p class="ie-description">Download your configuration as JSON files for backup or sharing.</p>

      <div class="ie-btn-row">
        <button class="btn btn-primary" id="exportAllBtn">Export All</button>
        <button class="btn btn-secondary" id="exportRulesBtn">Export Rules Only</button>
        <button class="btn btn-secondary" id="exportMocksBtn">Export Mock Collections Only</button>
      </div>

      <!-- Collapsible preview -->
      <details class="ie-preview-details" id="exportPreviewDetails">
        <summary class="ie-preview-summary">Preview export data</summary>
        <pre class="ie-preview-code" id="exportPreviewCode"></pre>
      </details>
    </div>

    <!-- ============================================================= -->
    <!--  Import Section                                                -->
    <!-- ============================================================= -->
    <div class="ie-section">
      <h3 class="ie-section-title">Import</h3>
      <p class="ie-description">Load configuration from a previously exported JSON file or paste raw JSON.</p>

      <!-- Drop zone -->
      <div class="ie-drop-zone" id="dropZone">
        <div class="ie-drop-zone-content">
          <span class="ie-drop-icon">&#128193;</span>
          <span class="ie-drop-label">Drag &amp; drop a JSON file here, or <strong>click to browse</strong></span>
        </div>
        <input type="file" accept=".json,application/json" class="ie-file-input" id="fileInput">
      </div>

      <!-- Paste option -->
      <details class="ie-paste-details">
        <summary class="ie-paste-summary">Paste JSON instead</summary>
        <textarea class="ie-paste-area" id="pasteArea" rows="8" placeholder="Paste JSON here..."></textarea>
        <button class="btn btn-secondary ie-paste-load-btn" id="pasteLoadBtn">Load Pasted JSON</button>
      </details>

      <!-- Validation summary -->
      <div class="ie-validation hidden" id="validationBox">
        <span class="ie-validation-icon" id="validationIcon"></span>
        <span class="ie-validation-text" id="validationText"></span>
      </div>

      <!-- Import options -->
      <div class="ie-import-options hidden" id="importOptions">
        <label class="ie-radio-label">
          <input type="radio" name="importMode" value="replace" checked>
          Replace All <span class="ie-radio-hint">(overwrites existing data)</span>
        </label>
        <label class="ie-radio-label">
          <input type="radio" name="importMode" value="merge">
          Merge <span class="ie-radio-hint">(adds new items, skips duplicates by name)</span>
        </label>

        <button class="btn btn-primary" id="importBtn" disabled>Import</button>
      </div>

      <!-- Status messages -->
      <div class="ie-status hidden" id="statusBox">
        <span id="statusMessage"></span>
      </div>
    </div>
  `;

  // ---------------------------------------------------------------------- //
  //  DOM references                                                         //
  // ---------------------------------------------------------------------- //
  const $exportAllBtn        = container.querySelector('#exportAllBtn');
  const $exportRulesBtn      = container.querySelector('#exportRulesBtn');
  const $exportMocksBtn      = container.querySelector('#exportMocksBtn');
  const $exportPreviewDetails = container.querySelector('#exportPreviewDetails');
  const $exportPreviewCode   = container.querySelector('#exportPreviewCode');

  const $dropZone            = container.querySelector('#dropZone');
  const $fileInput           = container.querySelector('#fileInput');
  const $pasteArea           = container.querySelector('#pasteArea');
  const $pasteLoadBtn        = container.querySelector('#pasteLoadBtn');

  const $validationBox       = container.querySelector('#validationBox');
  const $validationIcon      = container.querySelector('#validationIcon');
  const $validationText      = container.querySelector('#validationText');

  const $importOptions       = container.querySelector('#importOptions');
  const $importBtn           = container.querySelector('#importBtn');

  const $statusBox           = container.querySelector('#statusBox');
  const $statusMessage       = container.querySelector('#statusMessage');

  // ---------------------------------------------------------------------- //
  //  Internal helpers                                                       //
  // ---------------------------------------------------------------------- //

  /**
   * Show the export preview with the given data.
   */
  function showExportPreview(data) {
    $exportPreviewCode.textContent = JSON.stringify(data, null, 2);
    $exportPreviewDetails.open = true;
  }

  /**
   * Process raw text as a potential import payload.
   *
   * @param {string} text  Raw JSON text.
   */
  function processImportText(text) {
    // Reset state
    pendingJson = null;
    pendingValidation = null;
    $importBtn.disabled = true;
    $importOptions.classList.add('hidden');
    hideStatus();

    // Attempt parse
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      showValidation(false, `Invalid JSON: ${err.message}`);
      return;
    }

    // Validate structure
    const result = validateImport(parsed);
    showValidation(result.valid, result.summary);

    if (result.valid) {
      pendingJson = parsed;
      pendingValidation = result;
      $importBtn.disabled = false;
      $importOptions.classList.remove('hidden');
    }
  }

  /**
   * Show validation result.
   */
  function showValidation(valid, message) {
    $validationBox.classList.remove('hidden');
    $validationIcon.textContent = valid ? '\u2705' : '\u274C';
    $validationText.textContent = message;
    $validationBox.className = `ie-validation ${valid ? 'ie-validation--success' : 'ie-validation--error'}`;
  }

  /**
   * Display a status message after import.
   */
  function showStatus(success, message) {
    $statusBox.classList.remove('hidden');
    $statusBox.className = `ie-status ${success ? 'ie-status--success' : 'ie-status--error'}`;
    $statusMessage.textContent = message;
  }

  /**
   * Hide the status message area.
   */
  function hideStatus() {
    $statusBox.classList.add('hidden');
  }

  /**
   * Read the selected import mode radio button value.
   *
   * @returns {'replace' | 'merge'}
   */
  function getImportMode() {
    const radio = container.querySelector('input[name="importMode"]:checked');
    return radio ? radio.value : 'replace';
  }

  // ---------------------------------------------------------------------- //
  //  Export event handlers                                                   //
  // ---------------------------------------------------------------------- //

  $exportAllBtn.addEventListener('click', async () => {
    try {
      const data = await exportData('all');
      showExportPreview(data);
    } catch (err) {
      console.error('[Mocxy] Export all failed:', err);
    }
  });

  $exportRulesBtn.addEventListener('click', async () => {
    try {
      const data = await exportData('rules');
      showExportPreview(data);
    } catch (err) {
      console.error('[Mocxy] Export rules failed:', err);
    }
  });

  $exportMocksBtn.addEventListener('click', async () => {
    try {
      const data = await exportData('mockCollections');
      showExportPreview(data);
    } catch (err) {
      console.error('[Mocxy] Export mocks failed:', err);
    }
  });

  // ---------------------------------------------------------------------- //
  //  Import event handlers                                                  //
  // ---------------------------------------------------------------------- //

  // --- File drop zone ---------------------------------------------------

  $dropZone.addEventListener('click', () => $fileInput.click());

  $dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    $dropZone.classList.add('ie-drop-zone--active');
  });

  $dropZone.addEventListener('dragleave', () => {
    $dropZone.classList.remove('ie-drop-zone--active');
  });

  $dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    $dropZone.classList.remove('ie-drop-zone--active');
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });

  $fileInput.addEventListener('change', () => {
    const file = $fileInput.files?.[0];
    if (file) readFile(file);
  });

  /**
   * Read a File object as text and process the content.
   *
   * @param {File} file
   */
  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => processImportText(reader.result);
    reader.onerror = () => showValidation(false, `Failed to read file: ${reader.error?.message || 'unknown error'}`);
    reader.readAsText(file);
  }

  // --- Paste area -------------------------------------------------------

  $pasteLoadBtn.addEventListener('click', () => {
    const text = $pasteArea.value.trim();
    if (!text) {
      showValidation(false, 'Paste area is empty.');
      return;
    }
    processImportText(text);
  });

  // --- Import button ----------------------------------------------------

  $importBtn.addEventListener('click', async () => {
    if (!pendingJson || !pendingValidation?.valid) return;

    const mode = getImportMode();
    $importBtn.disabled = true;
    $importBtn.textContent = 'Importing...';

    try {
      await importData(pendingJson, mode);

      const counts = pendingValidation.counts;
      const parts = [];
      if (counts.rules > 0) parts.push(`${counts.rules} rule(s)`);
      if (counts.mockCollections > 0) parts.push(`${counts.mockCollections} collection(s)`);
      if (counts.hasSettings) parts.push('settings');

      showStatus(true, `Successfully imported ${parts.join(', ')} (mode: ${mode}).`);

      // Reset import state
      pendingJson = null;
      pendingValidation = null;
      $importOptions.classList.add('hidden');
      $validationBox.classList.add('hidden');
      $pasteArea.value = '';
      $fileInput.value = '';
    } catch (err) {
      console.error('[Mocxy] Import failed:', err);
      showStatus(false, `Import failed: ${err.message || 'unknown error'}`);
      $importBtn.disabled = false;
    } finally {
      $importBtn.textContent = 'Import';
    }
  });
}
