/**
 * message-router.js
 *
 * Centralised chrome.runtime.onMessage handler.  Routes every incoming message
 * (identified by message.type) to the appropriate storage-manager or
 * dnr-manager function and sends back the result asynchronously.
 */

import { MSG_TYPES } from '../shared/constants.js';
import {
  getRules,
  setRules,
  getSettings,
  setSettings,
  isEnabled,
  setEnabled,
  getMockCollections,
  setMockCollections,
  addLogEntry,
  getLogs,
  clearLogs,
  getInterceptedLogCount,
  exportAll,
  importAll,
} from './storage-manager.js';
import { syncDNRRules } from './dnr-manager.js';

/* -------------------------------------------------------------------------- */
/*  Message handler                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Handle a single message from a content script, popup, or options page.
 *
 * Must return `true` to signal that sendResponse will be called asynchronously.
 *
 * @param {Object}   message      — { type, payload?, ... }
 * @param {Object}   sender       — chrome.runtime.MessageSender
 * @param {Function} sendResponse — callback to return a result to the caller
 * @returns {boolean} always true (async response)
 */
export function handleMessage(message, sender, sendResponse) {
  if (!message || !message.type) {
    sendResponse({ error: 'Message must include a "type" field' });
    return true;
  }

  _route(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error(`[Mocxy] Message handler error (${message.type}):`, err);
      sendResponse({ error: err.message || String(err) });
    });

  // Return true to keep the message channel open for the async response
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Internal router                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Route a message to the correct handler based on its type.
 *
 * @param {Object} message
 * @param {Object} sender
 * @returns {Promise<*>}
 */
async function _route(message, _sender) {
  const { type } = message;

  switch (type) {
    /* ---- Rules ---- */
    case MSG_TYPES.GET_RULES:
      return getRules();

    case MSG_TYPES.SET_RULES:
      await setRules(message.rules);
      return { ok: true };

    /* ---- Settings ---- */
    case MSG_TYPES.GET_SETTINGS:
      return getSettings();

    case MSG_TYPES.SET_SETTINGS:
      await setSettings(message.settings);
      return { ok: true };

    /* ---- Enabled toggle ---- */
    case MSG_TYPES.TOGGLE_ENABLED: {
      const newState =
        message.enabled !== undefined ? !!message.enabled : !(await isEnabled());
      await setEnabled(newState);
      return { enabled: newState };
    }

    /* ---- Status snapshot ---- */
    case MSG_TYPES.GET_STATUS: {
      const [statusEnabled, statusRules, statusCollections, interceptedCount] = await Promise.all([
        isEnabled(),
        getRules(),
        getMockCollections(),
        getInterceptedLogCount(),
      ]);

      const activeRules = statusRules.filter((r) => r.enabled !== false);
      const mockActionTypes = ['mock_inline', 'mock_server', 'graphql_mock'];
      // Count rules with mock action types + active local mock collections
      const activeMockRules = activeRules.filter((r) => mockActionTypes.includes(r.action?.type)).length;
      const activeColls     = statusCollections.filter((c) => c.active !== false && (c.mocks || []).length > 0).length;
      const activeMocks     = activeMockRules + activeColls;

      return {
        enabled: statusEnabled,
        ruleCount: statusRules.length,
        activeRules: activeRules.length,
        activeMocks: activeMocks,
        interceptedCount: interceptedCount,
        activeCollections: statusCollections.filter((c) => c.enabled !== false).length,
      };
    }

    /* ---- Logging ---- */
    case MSG_TYPES.LOG_REQUEST:
      await addLogEntry(message.data || message);
      return { ok: true };

    case MSG_TYPES.GET_LOGS:
      return getLogs(message);

    case MSG_TYPES.CLEAR_LOGS:
      await clearLogs();
      return { ok: true };

    /* ---- Mock collections ---- */
    case MSG_TYPES.GET_MOCK_COLLECTIONS:
      return getMockCollections();

    case MSG_TYPES.SET_MOCK_COLLECTIONS:
      await setMockCollections(message.mockCollections);
      return { ok: true };

    /* ---- Export / Import ---- */
    case MSG_TYPES.EXPORT_ALL:
      return exportAll();

    case MSG_TYPES.IMPORT_ALL:
      await importAll(message.data);
      return { ok: true };

    /* ---- DNR ---- */
    case MSG_TYPES.UPDATE_DNR_RULES: {
      const dnrRules = message.rules || (await getRules());
      await syncDNRRules(dnrRules);
      return { ok: true };
    }

    /* ---- Unknown ---- */
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
