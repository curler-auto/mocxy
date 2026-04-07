/**
 * Mocxy - Shared Constants
 * Central registry of all constant values used across the extension.
 */

export const EXTENSION_NAME = 'Mocxy';

/** Keys used for chrome.storage.local persistence. */
export const STORAGE_KEYS = {
  RULES:               'mocxy_rules',
  MOCK_COLLECTIONS:    'mocxy_mock_collections',
  SETTINGS:            'mocxy_settings',
  INTERCEPTOR_ENABLED: 'mocxy_enabled',
  MOCK_SERVER_URL:     'mocxy_mock_server_url',
};

/** Default mock server URL. */
export const DEFAULT_MOCK_SERVER_URL = 'http://localhost:5000';

/** Admin API path prefix on the mock server. */
export const MOCK_SERVER_ADMIN_PATH = '/mocxy/admin';

/** IndexedDB database name. */
export const IDB_NAME = 'MocxyDB';

/** IndexedDB schema version. */
export const IDB_VERSION = 1;

/** IndexedDB object-store names. */
export const IDB_STORES = {
  LOGS: 'request_logs',
  MOCK_BODIES: 'mock_bodies',
};

/** Supported URL matching strategies. */
export const URL_MATCH_TYPES = {
  EQUALS: 'equals',
  CONTAINS: 'contains',
  REGEX: 'regex',
  GLOB: 'glob',
};

/** Supported header matching strategies. */
export const HEADER_MATCH_TYPES = {
  EQUALS: 'equals',
  CONTAINS: 'contains',
  REGEX: 'regex',
};

/** Supported payload (request body) matching strategies. */
export const PAYLOAD_MATCH_TYPES = {
  JSONPATH: 'jsonpath',
  JS:       'js',
  CONTAINS: 'contains',
  EQUALS:   'equals',
};

/** HTTP methods available for rule conditions. */
export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
];

/** Types of actions a matched rule can perform. */
export const ACTION_TYPES = {
  REDIRECT: 'redirect',
  REWRITE: 'rewrite',
  MOCK_INLINE: 'mock_inline',
  MOCK_SERVER: 'mock_server',
  MODIFY_HEADERS: 'modify_headers',
  DELAY: 'delay',
  BLOCK: 'block',
  MODIFY_BODY: 'modify_body',
  SET_USER_AGENT: 'set_user_agent',
  GRAPHQL_MOCK: 'graphql_mock',
  INJECT_SCRIPT: 'inject_script',
  INJECT_CSS:    'inject_css',
};

/** Preset user-agent strings for the Set User-Agent action. */
export const USER_AGENT_PRESETS = {
  'Chrome Windows':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Chrome Mac':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Firefox':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Safari':          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mobile Chrome':   'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mobile Safari':   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Googlebot':       'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Custom':          '',
};

/** Operating modes for the external mock-server proxy. */
export const MOCK_SERVER_MODES = {
  REQUEST_ONLY: 'REQUEST_ONLY',
  RESPONSE_ONLY: 'RESPONSE_ONLY',
  PASSTHROUGH: 'PASSTHROUGH',
};

/** Message types exchanged between popup, content-script, and service-worker. */
export const MSG_TYPES = {
  GET_RULES: 'GET_RULES',
  SET_RULES: 'SET_RULES',
  GET_SETTINGS: 'GET_SETTINGS',
  SET_SETTINGS: 'SET_SETTINGS',
  TOGGLE_ENABLED: 'TOGGLE_ENABLED',
  GET_STATUS: 'GET_STATUS',
  LOG_REQUEST: 'LOG_REQUEST',
  GET_LOGS: 'GET_LOGS',
  CLEAR_LOGS: 'CLEAR_LOGS',
  RULES_UPDATED: 'RULES_UPDATED',
  GET_MOCK_COLLECTIONS: 'GET_MOCK_COLLECTIONS',
  SET_MOCK_COLLECTIONS: 'SET_MOCK_COLLECTIONS',
  EXPORT_ALL: 'EXPORT_ALL',
  IMPORT_ALL: 'IMPORT_ALL',
  UPDATE_DNR_RULES: 'UPDATE_DNR_RULES',
};

/** Default settings applied on first install or when a key is missing. */
export const DEFAULT_SETTINGS = {
  maxLogEntries: 1000,
  logRetentionHours: 24,
  enabledDomains: [],
  enableLogging: true,
  theme: 'dark',
};

/** Prefix for all console log messages from the extension. */
export const LOG_TAG = '[Mocxy]';
