/**
 * sw.js
 *
 * Main service worker entry point for the Mocxy Chrome Extension
 * (Manifest V3).
 *
 * Responsibilities:
 *  1. Initialise IndexedDB on first install.
 *  2. Persist default settings when the extension is installed.
 *  3. Route all runtime messages to the message router.
 *  4. Keep DNR rules in sync whenever the application rules change in storage.
 */

import { handleMessage } from './message-router.js';
import { initDB, getSettings, setSettings, isEnabled, getRules } from './storage-manager.js';
import { syncDNRRules } from './dnr-manager.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants.js';

/* -------------------------------------------------------------------------- */
/*  Extension install / update                                                */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(
    `[Mocxy] Extension ${details.reason} (v${chrome.runtime.getManifest().version})`
  );

  // Initialise IndexedDB stores
  try {
    await initDB();
    console.log('[Mocxy] IndexedDB initialised');
  } catch (err) {
    console.error('[Mocxy] IndexedDB init failed', err);
  }

  // Persist default settings if none exist yet
  try {
    const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (!existing[STORAGE_KEYS.SETTINGS]) {
      await setSettings({ ...DEFAULT_SETTINGS });
      console.log('[Mocxy] Default settings written');
    }
  } catch (err) {
    console.error('[Mocxy] Failed to write default settings', err);
  }
});

/* -------------------------------------------------------------------------- */
/*  Message listener                                                          */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(handleMessage);

/* -------------------------------------------------------------------------- */
/*  Storage change listener — keep DNR rules in sync                          */
/* -------------------------------------------------------------------------- */

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes[STORAGE_KEYS.RULES]) {
    const newRules = changes[STORAGE_KEYS.RULES].newValue || [];
    console.log(
      `[Mocxy] Rules changed (${newRules.length} rules) — syncing DNR`
    );
    try {
      await syncDNRRules(newRules);
    } catch (err) {
      console.error('[Mocxy] DNR sync on storage change failed', err);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Inject JS/CSS into pages when URL matches an inject rule                 */
/* -------------------------------------------------------------------------- */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  const url = changeInfo.url || tab.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  try {
    const [enabled, rules] = await Promise.all([isEnabled(), getRules()]);
    if (!enabled) return;

    const injectRules = rules.filter((r) =>
      r.enabled &&
      (r.action.type === 'inject_script' || r.action.type === 'inject_css')
    );

    for (const rule of injectRules) {
      const cond = rule.condition?.url;
      if (!cond || !cond.value) continue;

      let matches = false;
      try {
        switch (cond.type) {
          case 'equals':   matches = url === cond.value; break;
          case 'contains': matches = url.includes(cond.value); break;
          case 'regex':    matches = new RegExp(cond.value).test(url); break;
          case 'glob': {
            const pat = '^' + cond.value
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$';
            matches = new RegExp(pat).test(url);
            break;
          }
        }
      } catch (_) {}

      if (!matches) continue;

      if (rule.action.type === 'inject_script') {
        const code = rule.action.injectScript?.code;
        if (!code) continue;
        const when = rule.action.injectScript?.runAt === 'document_start';
        // Use eval() in MAIN world — avoids creating an inline <script> tag
        // which would be blocked by strict page CSPs (script-src 'self').
        // eslint-disable-next-line no-eval
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          injectImmediately: when,
          func: (src) => { (0, eval)(src); },
          args: [code],
        }).catch((err) => console.warn('[Mocxy SW] Script inject failed:', err.message));
      }

      if (rule.action.type === 'inject_css') {
        const code = rule.action.injectCss?.code;
        if (!code) continue;
        chrome.scripting.insertCSS({
          target: { tabId },
          css: code,
        }).catch((err) => console.warn('[Mocxy SW] CSS inject failed:', err.message));
      }
    }
  } catch (err) {
    console.warn('[Mocxy SW] Inject check failed:', err.message);
  }
});

/* -------------------------------------------------------------------------- */
/*  Startup log                                                               */
/* -------------------------------------------------------------------------- */

console.log('[Mocxy] Service worker started');
