/**
 * options.js
 *
 * Main controller for the Mocxy options page.
 * Manages sidebar navigation, master toggle state, and bootstraps
 * all section components by passing them their container elements.
 */

import { MSG_TYPES, STORAGE_KEYS, EXTENSION_NAME } from '../shared/constants.js';

// Component imports — each receives a container element and the sendMessage helper
import { initRuleList }      from './components/rule-list.js';
import { initRuleForm }      from './components/rule-form.js';
import { initMockEditor }    from './components/mock-editor.js';
import { initRequestLog }    from './components/request-log.js';
import { initImportExport }  from './components/import-export.js';
import { initSettingsPanel }  from './components/settings-panel.js';

/* -------------------------------------------------------------------------- */
/*  DOM References                                                            */
/* -------------------------------------------------------------------------- */

const $sidebar        = document.getElementById('sidebar');
const $sidebarNav     = document.getElementById('sidebarNav');
const $navItems       = $sidebarNav.querySelectorAll('.nav-item');
const $contentArea    = document.getElementById('contentArea');
const $sections       = $contentArea.querySelectorAll('.content-section');
const $toggleInput    = document.getElementById('toggleInput');
const $statusLabel    = document.getElementById('statusLabel');
const $headerVersion  = document.getElementById('headerVersion');
const $versionLabel   = document.getElementById('versionLabel');
const $modalOverlay   = document.getElementById('modalOverlay');
const $modalClose     = document.getElementById('modalClose');

/* -------------------------------------------------------------------------- */
/*  Message Helper                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Send a message to the service worker and return the response.
 * Wraps chrome.runtime.sendMessage in a Promise for clean async/await usage.
 *
 * @param {string} type   One of MSG_TYPES values.
 * @param {Object} [data] Optional payload merged into the message.
 * @returns {Promise<*>}  The response from the service worker.
 */
export function sendMessage(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Toast Notification System                                                 */
/* -------------------------------------------------------------------------- */

let $toastContainer = document.querySelector('.toast-container');

/**
 * Show a brief toast notification.
 *
 * @param {string} message  The message to display.
 * @param {'success'|'error'|'warning'|'info'} [variant='info'] Toast type.
 * @param {number} [durationMs=3000] How long to show the toast.
 */
export function showToast(message, variant = 'info', durationMs = 3000) {
  if (!$toastContainer) {
    $toastContainer = document.createElement('div');
    $toastContainer.className = 'toast-container';
    document.body.appendChild($toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  $toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, durationMs);
}

/* -------------------------------------------------------------------------- */
/*  Modal Helpers (shared across components)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Open the shared modal with a title, body content, and optional footer buttons.
 *
 * @param {Object} options
 * @param {string}      options.title       Modal title text.
 * @param {string|Node} options.body        HTML string or DOM node for the body.
 * @param {string|Node} [options.footer]    HTML string or DOM node for the footer.
 */
export function openModal({ title, body, footer }) {
  const $modalTitle  = document.getElementById('modalTitle');
  const $modalBody   = document.getElementById('modalBody');
  const $modalFooter = document.getElementById('modalFooter');

  $modalTitle.textContent = title || '';

  if (typeof body === 'string') {
    $modalBody.innerHTML = body;
  } else if (body instanceof Node) {
    $modalBody.innerHTML = '';
    $modalBody.appendChild(body);
  }

  if (footer) {
    if (typeof footer === 'string') {
      $modalFooter.innerHTML = footer;
    } else if (footer instanceof Node) {
      $modalFooter.innerHTML = '';
      $modalFooter.appendChild(footer);
    }
    $modalFooter.classList.remove('hidden');
  } else {
    $modalFooter.innerHTML = '';
    $modalFooter.classList.add('hidden');
  }

  $modalOverlay.classList.remove('hidden');
}

/**
 * Close the shared modal.
 */
export function closeModal() {
  $modalOverlay.classList.add('hidden');
}

/* -------------------------------------------------------------------------- */
/*  Navigation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Switch the visible content section and update the active nav item.
 *
 * @param {string} sectionId  The data-section value (e.g. 'rules', 'mocks').
 */
function navigateTo(sectionId) {
  // Update nav items
  $navItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });

  // Update sections
  $sections.forEach((section) => {
    const id = section.id.replace('section-', '');
    section.classList.toggle('active', id === sectionId);
  });
}

// Sidebar nav click handlers
$navItems.forEach((item) => {
  item.addEventListener('click', () => {
    if (item.dataset.section) navigateTo(item.dataset.section);
  });
});


/* -------------------------------------------------------------------------- */
/*  Master Toggle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Update the UI to reflect the enabled/disabled state.
 *
 * @param {boolean} enabled
 */
function renderEnabledState(enabled) {
  $toggleInput.checked = enabled;
  $statusLabel.textContent = enabled ? 'Enabled' : 'Disabled';
  $statusLabel.classList.toggle('disabled', !enabled);
  document.body.classList.toggle('disabled', !enabled);
}

$toggleInput.addEventListener('change', async () => {
  const enabled = $toggleInput.checked;
  try {
    await sendMessage(MSG_TYPES.TOGGLE_ENABLED, { enabled });
    renderEnabledState(enabled);
    showToast(
      enabled ? 'Interceptor enabled' : 'Interceptor disabled',
      enabled ? 'success' : 'warning'
    );
  } catch (err) {
    console.warn('[Mocxy Options] Toggle failed:', err);
    $toggleInput.checked = !enabled;
    showToast('Failed to toggle interceptor', 'error');
  }
});

/* -------------------------------------------------------------------------- */
/*  Modal Close Handlers                                                      */
/* -------------------------------------------------------------------------- */

$modalClose.addEventListener('click', closeModal);

$modalOverlay.addEventListener('click', (e) => {
  if (e.target === $modalOverlay) {
    closeModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

/* -------------------------------------------------------------------------- */
/*  Theme Toggle                                                              */
/* -------------------------------------------------------------------------- */

const THEME_KEY = 'mocxy_theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  if (icon) {
    if (theme === 'light') {
      // Moon icon for switching to dark
      icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    } else {
      // Sun icon for switching to light
      icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    }
  }
}

function initTheme() {
  chrome.storage.local.get(THEME_KEY, (result) => {
    const theme = result[THEME_KEY] || 'dark';
    applyTheme(theme);
  });
}

const $themeToggleBtn = document.getElementById('themeToggleBtn');
if ($themeToggleBtn) {
  $themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.local.set({ [THEME_KEY]: next });
  });
}

/* -------------------------------------------------------------------------- */
/*  Storage Change Listener                                                   */
/* -------------------------------------------------------------------------- */

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // Sync master toggle if changed externally (e.g. from popup)
  if (changes[STORAGE_KEYS.INTERCEPTOR_ENABLED]) {
    renderEnabledState(changes[STORAGE_KEYS.INTERCEPTOR_ENABLED].newValue !== false);
  }
});

/* -------------------------------------------------------------------------- */
/*  Version Display                                                           */
/* -------------------------------------------------------------------------- */

function setVersion() {
  const manifest = chrome.runtime.getManifest();
  const version = `v${manifest.version}`;
  $headerVersion.textContent = version;
  $versionLabel.textContent  = version;
}

/* -------------------------------------------------------------------------- */
/*  Initialisation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetch initial state from the service worker and bootstrap all components.
 */
async function init() {
  // Apply saved theme
  initTheme();

  // Display version
  setVersion();

  // Fetch current enabled state
  try {
    const status = await sendMessage(MSG_TYPES.GET_STATUS);
    if (status) {
      renderEnabledState(status.enabled !== false);
    }
  } catch (err) {
    console.warn('[Mocxy Options] Failed to get initial status:', err);
  }

  // Collect container elements for each component
  const containers = {
    ruleList:      document.getElementById('ruleListContainer'),
    ruleForm:      document.getElementById('ruleFormContainer'),
    mockEditor:    document.getElementById('mockEditorContainer'),
    requestLog:    document.getElementById('requestLogContainer'),

    importExport:  document.getElementById('importExportContainer'),
    settingsPanel: document.getElementById('settingsPanelContainer'),
  };

  // Bootstrap components — wire rule-list ↔ rule-form callbacks,
  // then initialise the rest with their containers.

  const ruleForm = initRuleForm(containers.ruleForm, {
    onSave: async (rule) => {
      // Persist the rule, refresh the list, close the form
      try {
        const res = await sendMessage(MSG_TYPES.GET_RULES);
        let rules = (res && res.rules) || res || [];
        if (!Array.isArray(rules)) rules = [];
        const idx = rules.findIndex((r) => r.id === rule.id);
        if (idx >= 0) {
          rules[idx] = rule;
        } else {
          rules.push(rule);
        }
        await sendMessage(MSG_TYPES.SET_RULES, { rules });
        ruleList.refresh();
        ruleForm.close();
        showToast('Rule saved', 'success');
      } catch (err) {
        console.error('[Mocxy Options] Save rule failed:', err);
        showToast('Failed to save rule', 'error');
      }
    },
    onCancel: () => {
      ruleForm.close();
    },
  });

  const ruleList = initRuleList(containers.ruleList, {
    onEdit: (rule) => ruleForm.open(rule),
    onRefresh: () => {},
  });

  // Wire the section-header "Add Rule" button
  const $addRuleBtn = document.getElementById('addRuleBtn');
  if ($addRuleBtn) {
    $addRuleBtn.addEventListener('click', () => ruleForm.open(null));
  }

  initMockEditor(containers.mockEditor);
  initRequestLog(containers.requestLog);
  initImportExport(containers.importExport);
  initSettingsPanel(containers.settingsPanel);
}

document.addEventListener('DOMContentLoaded', init);
