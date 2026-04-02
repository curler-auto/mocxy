# Feature 2.3: CLI Tool (neuron-cli)

**Priority**: Phase 2 - Test Automation (Differentiator)
**Status**: NOT STARTED
**Depends On**: 2.1 (Record & Export), 2.2 (Playwright Bridge)
**Estimated Effort**: Large (8-12 hours)

---

## Overview

Create a Node.js CLI tool for running tests, serving mocks, recording sessions, and converting export formats from the command line or CI/CD pipelines. The tool wraps the Neuron Interceptor Chrome Extension's capabilities into four commands:

1. `neuron test run` -- Execute YAML-defined test scenarios with extension-native interception
2. `neuron mock serve` -- Serve mock responses via a local HTTP server (no browser needed)
3. `neuron record` -- Launch a headed browser and record API traffic interactively
4. `neuron export` -- Convert captured request logs between formats offline

---

## Architecture Context

### Relationship to Other Components

```
                                CLI (this feature)
                               /         |         \
                              /          |          \
   neuron test run     neuron mock serve  |   neuron export
          |                    |          |          |
   Playwright + Extension  Express HTTP   |   Pure transforms
   (launch browser,        (no browser,   |   (JSON -> YAML,
    push rules from YAML,   match rules)  |    JSON -> HAR,
    navigate, validate)                   |    JSON -> rules)
                                          |
                                   neuron record
                                          |
                                   Playwright + Extension
                                   (headed browser,
                                    recording mode,
                                    export on close)
```

### Directory Structure

```
health_check/utils/neuron-interceptor-plugin/
  cli/
    neuron-cli.js              # Entry point with #!/usr/bin/env node
    package.json               # Dependencies and bin config
    commands/
      test.js                  # neuron test run
      mock-serve.js            # neuron mock serve
      record.js                # neuron record
      export.js                # neuron export
    lib/
      playwright-bridge.js     # Launch browser with extension loaded
      yaml-parser.js           # Parse test YAML definitions
      rule-matcher.js          # Match requests against rules (for mock server)
      fixture-generator.js     # Generate export files (JSON, YAML, HAR, rules)
      reporter.js              # Test result formatting
```

---

## File Specifications

### 1. `cli/package.json`

```json
{
  "name": "neuron-interceptor-cli",
  "version": "1.0.0",
  "description": "CLI tool for Neuron Interceptor - run tests, serve mocks, record sessions, export fixtures",
  "license": "MIT",
  "bin": {
    "neuron": "./neuron-cli.js"
  },
  "type": "module",
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "start": "node neuron-cli.js",
    "test:run": "node neuron-cli.js test run",
    "mock:serve": "node neuron-cli.js mock serve",
    "lint": "echo 'No linter configured'"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "js-yaml": "^4.1.0",
    "chalk": "^5.3.0"
  },
  "peerDependencies": {
    "playwright": "^1.40.0"
  },
  "peerDependenciesMeta": {
    "playwright": {
      "optional": true
    }
  },
  "keywords": [
    "neuron",
    "interceptor",
    "api",
    "mock",
    "test",
    "playwright",
    "chrome-extension"
  ]
}
```

### 2. `cli/neuron-cli.js`

```javascript
#!/usr/bin/env node

/**
 * neuron-cli.js
 *
 * Entry point for the Neuron Interceptor CLI tool.
 * Routes commands to their respective handlers using Commander.js.
 *
 * Commands:
 *   neuron test run <yaml-file>   Run test scenarios from a YAML definition
 *   neuron mock serve             Start a local mock server
 *   neuron record                 Record API traffic in a headed browser
 *   neuron export                 Convert captured logs between formats
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('neuron')
  .description('Neuron Interceptor CLI - Test automation, mock serving, and traffic recording')
  .version(pkg.version);

// -------------------------------------------------------------------------
// neuron test run
// -------------------------------------------------------------------------

const testCmd = program
  .command('test')
  .description('Test execution commands');

testCmd
  .command('run <yaml-file>')
  .description('Run test scenarios defined in a YAML file')
  .option('-t, --tag <tags>', 'Include scenarios matching these tags (comma-separated)', 'all')
  .option('--exclude-tags <tags>', 'Exclude scenarios matching these tags', 'disabled,in_progress')
  .option('--headed', 'Run browser in headed mode (default for extension tests)', true)
  .option('--base-url <url>', 'Override the base URL for navigation', '')
  .option('-o, --output <dir>', 'Output directory for results', 'results')
  .option('--timeout <ms>', 'Scenario timeout in milliseconds', '60000')
  .option('--slow-mo <ms>', 'Slow down Playwright actions by this many milliseconds', '0')
  .action(async (yamlFile, options) => {
    const { runTests } = await import('./commands/test.js');
    await runTests(yamlFile, options);
  });

// -------------------------------------------------------------------------
// neuron mock serve
// -------------------------------------------------------------------------

program
  .command('mock')
  .description('Start a mock server that serves responses based on rule definitions')
  .command('serve')
  .description('Start a local HTTP mock server')
  .option('-r, --rules <file>', 'Path to rules JSON file (exported from extension or generated)')
  .option('-d, --data-dir <dir>', 'Directory containing mock JSON response files')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--cors', 'Enable CORS headers', true)
  .option('--verbose', 'Log every incoming request', false)
  .action(async (options) => {
    const { serveMocks } = await import('./commands/mock-serve.js');
    await serveMocks(options);
  });

// -------------------------------------------------------------------------
// neuron record
// -------------------------------------------------------------------------

program
  .command('record')
  .description('Launch a headed browser and record all API traffic')
  .option('-u, --url <url>', 'URL to navigate to on launch')
  .option('-o, --output <dir>', 'Output directory for exported fixtures', 'recorded')
  .option('-n, --name <name>', 'Session name for exports', '')
  .option('-d, --duration <seconds>', 'Auto-stop recording after this many seconds (0 = manual)', '0')
  .option('--formats <formats>', 'Export formats (comma-separated: json,yaml,rules,har)', 'json,yaml,rules')
  .option('--slow-mo <ms>', 'Slow down Playwright actions', '0')
  .action(async (options) => {
    const { recordSession } = await import('./commands/record.js');
    await recordSession(options);
  });

// -------------------------------------------------------------------------
// neuron export
// -------------------------------------------------------------------------

program
  .command('export')
  .description('Convert captured request logs to various export formats')
  .requiredOption('-i, --input <file>', 'Input file (JSON array of log entries)')
  .requiredOption('-f, --format <format>', 'Output format: har, yaml, json, rules')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-n, --name <name>', 'Session/test name', 'exported')
  .option('--page-url <url>', 'Page URL (for YAML generation)', '/')
  .action(async (options) => {
    const { exportLogs } = await import('./commands/export.js');
    await exportLogs(options);
  });

// -------------------------------------------------------------------------
// Parse and run
// -------------------------------------------------------------------------

program.parse();
```

### 3. `cli/lib/playwright-bridge.js`

```javascript
/**
 * playwright-bridge.js
 *
 * Launch Chromium with the Neuron Interceptor extension loaded.
 * Provides helpers to push rules and read logs via page.evaluate().
 */

import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default extension path: two levels up from cli/lib/ -> plugin root
const DEFAULT_EXTENSION_PATH = resolve(__dirname, '..', '..');

/**
 * Launch a Chromium browser with the Neuron Interceptor extension.
 *
 * @param {Object} [options]
 * @param {string}  [options.extensionPath] - Path to the unpacked extension directory.
 * @param {number}  [options.slowMo=0]      - Slow down actions (ms).
 * @param {Object}  [options.viewport]      - { width, height }
 * @returns {Promise<{ context, page, cleanup }>}
 */
export async function launchWithExtension(options = {}) {
  // Playwright is a peer dependency -- import dynamically
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch (err) {
    throw new Error(
      'Playwright is required but not installed.\n' +
      'Install it with: npm install playwright\n' +
      'Then run: npx playwright install chromium'
    );
  }

  const extensionPath = resolve(options.extensionPath || DEFAULT_EXTENSION_PATH);
  const slowMo = parseInt(options.slowMo, 10) || 0;
  const viewport = options.viewport || { width: 1920, height: 1080 };

  // Create a temp user data directory
  const userDataDir = mkdtempSync(join(tmpdir(), 'neuron-cli-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    slowMo,
    viewport,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = context.pages()[0] || await context.newPage();

  // Wait for extension to initialize
  await page.waitForTimeout(1000);

  const cleanup = async () => {
    try { await context.close(); } catch (_) {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  };

  return { context, page, cleanup };
}

/**
 * Push interception rules to the extension on the given page.
 *
 * @param {import('playwright').Page} page
 * @param {Array} rules
 * @param {Array} [mockCollections=[]]
 * @param {boolean} [enabled=true]
 */
export async function pushRules(page, rules, mockCollections = [], enabled = true) {
  await page.evaluate(({ rules, mockCollections, enabled }) => {
    window.postMessage({
      source: 'neuron-interceptor-content',
      type: 'RULES_UPDATED',
      data: { rules, mockCollections, enabled }
    }, '*');
  }, { rules, mockCollections, enabled });
}

/**
 * Read request logs from IndexedDB via the page context.
 *
 * @param {import('playwright').Page} page
 * @param {number} [limit=200]
 * @returns {Promise<Array>}
 */
export async function getLogs(page, limit = 200) {
  return page.evaluate(async (limit) => {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('NeuronInterceptorDB', 1);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });

      return new Promise((resolve) => {
        const tx = db.transaction('request_logs', 'readonly');
        const store = tx.objectStore('request_logs');
        const idx = store.index('timestamp');
        const cursorReq = idx.openCursor(null, 'prev');
        const results = [];

        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        cursorReq.onerror = () => resolve([]);
      });
    } catch (err) {
      console.warn('Failed to read logs from IndexedDB:', err);
      return [];
    }
  }, limit);
}

/**
 * Clear all request logs from IndexedDB.
 *
 * @param {import('playwright').Page} page
 */
export async function clearLogs(page) {
  await page.evaluate(async () => {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('NeuronInterceptorDB', 1);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
      const tx = db.transaction('request_logs', 'readwrite');
      tx.objectStore('request_logs').clear();
      await new Promise((resolve) => { tx.oncomplete = resolve; });
    } catch (err) {
      console.warn('Failed to clear logs:', err);
    }
  });
}
```

### 4. `cli/lib/yaml-parser.js`

```javascript
/**
 * yaml-parser.js
 *
 * Parse YAML test definition files in the same format used by
 * health_check/test_declarative_runner.py.
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';

/**
 * Load and parse a YAML test definition file.
 *
 * @param {string} filePath - Path to the YAML file.
 * @returns {Object} Parsed test definition with test_info and scenarios.
 * @throws {Error} If the file cannot be read or parsed.
 */
export function loadTestDefinition(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML: expected an object at top level in ${filePath}`);
  }

  if (!parsed.test_info) {
    throw new Error(`Missing 'test_info' section in ${filePath}`);
  }

  if (!parsed.scenarios || typeof parsed.scenarios !== 'object') {
    throw new Error(`Missing or invalid 'scenarios' section in ${filePath}`);
  }

  return parsed;
}

/**
 * Extract inline tags from YAML scenario keys.
 *
 * Parses comment-style tags: `scenario_name: #tag1, tag2, tag3`
 *
 * @param {string} filePath - Path to the YAML file.
 * @param {Object} scenarios - The scenarios dict from the parsed YAML.
 * @returns {Object} Map of scenario_name -> [tags]
 */
export function extractScenarioTags(filePath, scenarios) {
  const content = readFileSync(filePath, 'utf-8');
  const tagMap = {};

  for (const line of content.split('\n')) {
    const match = line.match(/^\s{0,4}([\w-]+):\s*#(.*)/);
    if (match) {
      const name = match[1].trim();
      const tagStr = match[2].trim();
      const tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);

      if (!tags.includes(name)) {
        tags.push(name);
      }

      if (name in scenarios) {
        tagMap[name] = tags;
      }
    }
  }

  return tagMap;
}

/**
 * Filter scenarios based on include/exclude tags.
 *
 * @param {Object} scenarios - All scenarios from YAML.
 * @param {Object} tagMap - Scenario name -> tags mapping.
 * @param {string[]} includeTags - Tags to include ('all' matches everything).
 * @param {string[]} excludeTags - Tags to exclude.
 * @returns {Object} Filtered scenarios.
 */
export function filterScenariosByTags(scenarios, tagMap, includeTags, excludeTags) {
  const filtered = {};

  for (const [name, def] of Object.entries(scenarios)) {
    const tags = tagMap[name] || [name];

    const includeMatch = includeTags.includes('all') || tags.some(t => includeTags.includes(t));
    const excludeMatch = tags.some(t => excludeTags.includes(t));

    if (includeMatch && !excludeMatch) {
      filtered[name] = def;
    }
  }

  return filtered;
}

/**
 * Replace template variables (e.g. {{scenario_name}}) in a value.
 *
 * @param {*} obj - Value to process (string, object, array, or primitive).
 * @param {Object} context - Key-value pairs for substitution.
 * @returns {*} Value with all {{key}} patterns replaced.
 */
export function replaceTemplateVars(obj, context) {
  if (typeof obj === 'string') {
    let result = obj;
    for (const [key, value] of Object.entries(context)) {
      result = result.replaceAll(`{{${key}}}`, String(value));
    }
    return result;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => replaceTemplateVars(item, context));
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceTemplateVars(value, context);
    }
    return result;
  }

  return obj;
}

/**
 * Resolve the mock response file path for a data scenario.
 *
 * If response_file is specified, uses it directly.
 * Otherwise, auto-generates: health_check/test_data/{page_name}/{scenario_name}.json
 *
 * @param {Object} dataScenario - The data scenario definition.
 * @param {string} pageName - The page_name from test_info.
 * @returns {string} Path to the response file.
 */
export function resolveResponseFile(dataScenario, pageName) {
  if (dataScenario.response_file) {
    return dataScenario.response_file;
  }

  const name = dataScenario.name || 'default';
  return `health_check/test_data/${pageName}/${name}.json`;
}
```

### 5. `cli/lib/rule-matcher.js`

```javascript
/**
 * rule-matcher.js
 *
 * Match incoming HTTP requests against Neuron Interceptor rule definitions.
 * Used by the mock server command to serve appropriate responses.
 */

/**
 * Match a URL against a condition value using the specified match type.
 *
 * @param {string} url - Full request URL.
 * @param {string} type - Match type: 'equals', 'contains', 'regex', 'glob'.
 * @param {string} value - The pattern to match against.
 * @returns {boolean}
 */
export function matchUrl(url, type, value) {
  if (!value) return false;

  switch (type) {
    case 'equals':
      return url === value;
    case 'contains':
      return url.includes(value);
    case 'regex':
      try { return new RegExp(value).test(url); } catch (_) { return false; }
    case 'glob':
      return new RegExp(globToRegex(value)).test(url);
    default:
      return false;
  }
}

/**
 * Convert a glob pattern to a regex string.
 *
 * @param {string} glob
 * @returns {string}
 */
function globToRegex(glob) {
  return (
    '^' +
    glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*') +
    '$'
  );
}

/**
 * Find the first matching rule for an incoming request.
 *
 * @param {string} url - Request URL.
 * @param {string} method - HTTP method (uppercase).
 * @param {Object} headers - Request headers (lowercase keys).
 * @param {Array} rules - Array of rule definitions.
 * @returns {Object|null} The matched rule, or null.
 */
export function findMatchingRule(url, method, headers, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  // Sort by priority descending
  const sorted = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of sorted) {
    if (rule.enabled === false) continue;

    const cond = rule.condition || {};

    // URL match
    if (cond.url && cond.url.value) {
      if (!matchUrl(url, cond.url.type || 'contains', cond.url.value)) continue;
    }

    // Method match
    if (cond.methods && cond.methods.length > 0) {
      if (!cond.methods.includes(method.toUpperCase())) continue;
    }

    // Header match (AND logic)
    if (cond.headers && cond.headers.length > 0) {
      let headersMatch = true;
      for (const hc of cond.headers) {
        const headerVal = headers?.[hc.name] || headers?.[hc.name?.toLowerCase()] || '';
        if (!matchUrl(headerVal, hc.type || 'contains', hc.value)) {
          headersMatch = false;
          break;
        }
      }
      if (!headersMatch) continue;
    }

    return rule;
  }

  return null;
}

/**
 * Extract the mock response from a matched rule's action.
 *
 * @param {Object} rule - The matched rule.
 * @returns {{ statusCode: number, headers: Object, body: string }|null}
 */
export function extractMockResponse(rule) {
  if (!rule || !rule.action) return null;

  switch (rule.action.type) {
    case 'mock_inline': {
      const mock = rule.action.mockInline || {};
      return {
        statusCode: mock.statusCode || 200,
        headers: mock.headers || { 'Content-Type': 'application/json' },
        body: mock.body || '{}',
      };
    }

    default:
      return null;
  }
}
```

### 6. `cli/lib/fixture-generator.js`

```javascript
/**
 * fixture-generator.js
 *
 * Generate export files from captured request log entries.
 * Supports: Mock JSON, YAML test definition, Rule set, HAR archive.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Sanitize a URL path into a safe filename segment.
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrlToFilename(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    path = path.replace(/^\/(neuron-api|api|v\d+)\//i, '/');
    path = path.replace(/^\/visualization\/api\//, '/');
    path = path.replace(/^\/+|\/+$/g, '');
    path = path.replace(/\//g, '_');
    path = path.replace(/[^a-zA-Z0-9_-]/g, '');
    path = path.replace(/_+/g, '_');
    return path || 'unknown-endpoint';
  } catch (_) {
    return 'unknown-endpoint';
  }
}

/**
 * Group log entries by unique API endpoint.
 * Keeps the most recent response for each endpoint.
 *
 * @param {Array} entries
 * @returns {Map<string, Object>}
 */
export function groupByEndpoint(entries) {
  const groups = new Map();

  for (const entry of entries) {
    if (!entry.url) continue;

    let key;
    try {
      const u = new URL(entry.url);
      key = `${entry.method || 'GET'}_${u.pathname}`;
    } catch (_) {
      key = `${entry.method || 'GET'}_${entry.url}`;
    }

    const existing = groups.get(key);
    if (!existing || (entry.timestamp || 0) > (existing.entry.timestamp || 0)) {
      groups.set(key, {
        url: entry.url,
        method: entry.method || 'GET',
        entry,
        filename: sanitizeUrlToFilename(entry.url),
      });
    }
  }

  return groups;
}

/**
 * Generate and write Mock JSON files to disk.
 *
 * @param {Array} entries - Log entries.
 * @param {string} outputDir - Base output directory.
 * @param {string} sessionName - Session identifier.
 * @returns {string[]} Array of written file paths.
 */
export function generateMockJsonFiles(entries, outputDir, sessionName) {
  const groups = groupByEndpoint(entries);
  const mockDir = join(outputDir, sessionName);
  mkdirSync(mockDir, { recursive: true });

  const written = [];

  for (const [key, group] of groups) {
    let body = '{}';
    if (group.entry.responseBody) {
      try {
        const parsed = JSON.parse(group.entry.responseBody);
        body = JSON.stringify(parsed, null, 2);
      } catch (_) {
        body = group.entry.responseBody;
      }
    }

    const filePath = join(mockDir, `${group.filename}.json`);
    writeFileSync(filePath, body, 'utf-8');
    written.push(filePath);
  }

  return written;
}

/**
 * Generate a YAML test definition string.
 *
 * @param {Array} entries - Log entries.
 * @param {string} sessionName - Session identifier.
 * @param {string} pageUrl - The page URL path.
 * @returns {string} YAML content.
 */
export function generateYamlDefinition(entries, sessionName, pageUrl) {
  const groups = groupByEndpoint(entries);
  const pageName = sessionName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

  // Find primary endpoint
  const counts = {};
  for (const entry of entries) {
    try {
      const path = new URL(entry.url).pathname;
      counts[path] = (counts[path] || 0) + 1;
    } catch (_) {}
  }

  let primaryEndpoint = '/';
  let maxCount = 0;
  for (const [path, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      primaryEndpoint = path;
    }
  }

  let yaml = '';
  yaml += 'test_info:\n';
  yaml += `  test_suite_name: "${sessionName}"\n`;
  yaml += '  test_suite_type: "ui"\n';
  yaml += `  page_name: "${pageName}"\n`;
  yaml += `  page_url: "${pageUrl}"\n`;
  yaml += `  api_endpoint: "${primaryEndpoint}"\n`;
  yaml += '  module: "Recorded Session"\n';
  yaml += '  execution: "serial"\n';
  yaml += '  runner_mode: "v1"\n';
  yaml += `  description: "Auto-generated test definition from CLI recording: ${sessionName}"\n`;
  yaml += `  tags: ["ui", "recorded", "${pageName}"]\n`;
  yaml += '  priority: 1\n';
  yaml += '\n';
  yaml += 'scenarios:\n';
  yaml += `  ${pageName}_test: #p1, regression, recorded\n`;
  yaml += `    description: "Recorded scenarios from: ${sessionName}"\n`;
  yaml += '    priority: 1\n';
  yaml += '    tags: ["p1", "regression", "recorded"]\n';
  yaml += '\n';
  yaml += '    data_scenarios:\n';

  for (const [key, group] of groups) {
    yaml += `      - name: "${group.filename}"\n`;
    yaml += `        description: "Recorded ${group.method} ${group.url}"\n`;
    yaml += `        response_file: "health_check/test_data/${pageName}/${group.filename}.json"\n`;
    yaml += '\n';
  }

  const apiPattern = primaryEndpoint.split('/').slice(-2).join('/');

  yaml += '    pre_test:\n';
  yaml += '      - navigate_to_page: true\n';
  yaml += '        per_scenario: false\n';
  yaml += '\n';
  yaml += '      - inject_proxy:\n';
  yaml += '          mode: "RESPONSE_ONLY"\n';
  yaml += '          step_tag: "{{scenario_name}}"\n';
  yaml += `          api_patterns: ["${apiPattern}"]\n`;
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '      - trigger_filter_reload: true\n';
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '      - wait_for_load: 3000\n';
  yaml += '        per_scenario: true\n';
  yaml += '\n';
  yaml += '    validations:\n';
  yaml += '      - method: "capture_step_kpis"\n';
  yaml += '        params:\n';
  yaml += '          step_tag: "{{scenario_name}}"\n';
  yaml += '\n';
  yaml += '    post_test:\n';
  yaml += '      - action: stop_proxy\n';

  return yaml;
}

/**
 * Generate a Rule set JSON string.
 *
 * @param {Array} entries - Log entries.
 * @param {string} sessionName - Session identifier.
 * @returns {string} JSON string.
 */
export function generateRuleSet(entries, sessionName) {
  const groups = groupByEndpoint(entries);
  const rules = [];
  let priority = groups.size;

  for (const [key, group] of groups) {
    let urlPattern;
    try { urlPattern = new URL(group.url).pathname; } catch (_) { urlPattern = group.url; }

    rules.push({
      id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `[${sessionName}] Mock ${group.method} ${group.filename}`,
      enabled: true,
      priority: priority--,
      condition: {
        url: { type: 'contains', value: urlPattern },
        headers: [],
        methods: [group.method],
      },
      action: {
        type: 'mock_inline',
        mockInline: {
          statusCode: group.entry.statusCode || 200,
          headers: { 'Content-Type': group.entry.contentType || 'application/json' },
          body: group.entry.responseBody || '{}',
        },
        redirect: { targetHost: '', preservePath: true },
        rewrite: { pattern: '', replacement: '' },
        mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
        headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
        delayMs: 0,
      },
    });
  }

  return JSON.stringify({ rules }, null, 2);
}

/**
 * Generate a HAR archive JSON string.
 *
 * @param {Array} entries - Log entries.
 * @param {string} sessionName - Session identifier.
 * @returns {string} JSON string in HAR 1.2 format.
 */
export function generateHar(entries, sessionName) {
  const harEntries = entries.map((entry) => {
    const reqHeaders = entry.requestHeaders && typeof entry.requestHeaders === 'object'
      ? Object.entries(entry.requestHeaders).map(([name, value]) => ({ name, value: String(value) }))
      : [];

    const resHeaders = entry.responseHeaders && typeof entry.responseHeaders === 'object'
      ? Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value: String(value) }))
      : [];

    let queryString = [];
    try {
      const u = new URL(entry.url);
      queryString = [...u.searchParams].map(([name, value]) => ({ name, value }));
    } catch (_) {}

    return {
      startedDateTime: new Date(entry.timestamp || Date.now()).toISOString(),
      time: entry.duration || 0,
      request: {
        method: entry.method || 'GET',
        url: entry.url || '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: reqHeaders,
        queryString,
        postData: entry.requestBody
          ? { mimeType: 'application/json', text: entry.requestBody }
          : undefined,
        headersSize: -1,
        bodySize: entry.requestBody ? entry.requestBody.length : 0,
      },
      response: {
        status: entry.statusCode || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: resHeaders,
        content: {
          size: entry.size || (entry.responseBody || '').length,
          mimeType: entry.contentType || 'application/json',
          text: entry.responseBody || '',
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: entry.size || (entry.responseBody || '').length,
      },
      cache: {},
      timings: { send: 0, wait: entry.duration || 0, receive: 0 },
    };
  });

  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'Neuron Interceptor CLI', version: '1.0.0' },
      pages: [{
        startedDateTime: entries.length > 0
          ? new Date(entries[0].timestamp).toISOString()
          : new Date().toISOString(),
        id: sessionName,
        title: `Neuron Recording: ${sessionName}`,
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries: harEntries,
    },
  }, null, 2);
}
```

### 7. `cli/lib/reporter.js`

```javascript
/**
 * reporter.js
 *
 * Test result formatting and output for the CLI.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} ScenarioResult
 * @property {string} name - Scenario name.
 * @property {string} status - 'passed' | 'failed' | 'skipped' | 'error'.
 * @property {number} duration - Execution time in ms.
 * @property {string[]} [errors] - Error messages if failed.
 * @property {Object[]} [validations] - Validation results.
 */

/**
 * @typedef {Object} TestRunResult
 * @property {string} yamlFile - Path to the YAML file.
 * @property {string} suiteName - Test suite name.
 * @property {number} startedAt - Unix timestamp.
 * @property {number} completedAt - Unix timestamp.
 * @property {number} total - Total scenarios.
 * @property {number} passed - Passed count.
 * @property {number} failed - Failed count.
 * @property {number} skipped - Skipped count.
 * @property {ScenarioResult[]} scenarios - Individual results.
 */

/**
 * Create a new test run result object.
 *
 * @param {string} yamlFile
 * @param {string} suiteName
 * @returns {TestRunResult}
 */
export function createTestRun(yamlFile, suiteName) {
  return {
    yamlFile,
    suiteName,
    startedAt: Date.now(),
    completedAt: 0,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    scenarios: [],
  };
}

/**
 * Add a scenario result to the test run.
 *
 * @param {TestRunResult} run
 * @param {ScenarioResult} result
 */
export function addScenarioResult(run, result) {
  run.scenarios.push(result);
  run.total++;
  if (result.status === 'passed') run.passed++;
  else if (result.status === 'failed') run.failed++;
  else if (result.status === 'skipped') run.skipped++;
}

/**
 * Finalize the test run (set completion time).
 *
 * @param {TestRunResult} run
 */
export function finalizeRun(run) {
  run.completedAt = Date.now();
}

/**
 * Format the test run result as a console summary string.
 *
 * @param {TestRunResult} run
 * @returns {string}
 */
export function formatConsoleSummary(run) {
  const duration = ((run.completedAt - run.startedAt) / 1000).toFixed(1);
  const lines = [];

  lines.push('');
  lines.push('='.repeat(72));
  lines.push(`  TEST RESULTS: ${run.suiteName}`);
  lines.push('='.repeat(72));
  lines.push('');

  for (const scenario of run.scenarios) {
    const icon = scenario.status === 'passed' ? 'PASS' : scenario.status === 'failed' ? 'FAIL' : 'SKIP';
    const dur = `${(scenario.duration / 1000).toFixed(1)}s`;
    lines.push(`  [${icon}]  ${scenario.name}  (${dur})`);

    if (scenario.errors && scenario.errors.length > 0) {
      for (const err of scenario.errors) {
        lines.push(`         Error: ${err}`);
      }
    }
  }

  lines.push('');
  lines.push('-'.repeat(72));
  lines.push(`  Total: ${run.total}  |  Passed: ${run.passed}  |  Failed: ${run.failed}  |  Skipped: ${run.skipped}`);
  lines.push(`  Duration: ${duration}s`);
  lines.push('-'.repeat(72));
  lines.push('');

  return lines.join('\n');
}

/**
 * Write the test run result to a JSON file.
 *
 * @param {TestRunResult} run
 * @param {string} outputDir
 * @returns {string} Path to the written file.
 */
export function writeJsonReport(run, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `neuron-test-results-${timestamp}.json`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
  return filePath;
}
```

### 8. `cli/commands/test.js`

```javascript
/**
 * commands/test.js
 *
 * neuron test run <yaml-file> [--tag <tags>] [--headed] [--base-url <url>]
 *
 * Reads a YAML test definition, launches Playwright with the extension,
 * executes each scenario (push mock rules, navigate, wait, capture),
 * and reports results.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadTestDefinition, extractScenarioTags, filterScenariosByTags, replaceTemplateVars, resolveResponseFile } from '../lib/yaml-parser.js';
import { launchWithExtension, pushRules, getLogs, clearLogs } from '../lib/playwright-bridge.js';
import { createTestRun, addScenarioResult, finalizeRun, formatConsoleSummary, writeJsonReport } from '../lib/reporter.js';

/**
 * Run tests from a YAML definition file.
 *
 * @param {string} yamlFile - Path to the YAML file.
 * @param {Object} options - CLI options.
 */
export async function runTests(yamlFile, options) {
  const yamlPath = resolve(yamlFile);

  if (!existsSync(yamlPath)) {
    console.error(`Error: YAML file not found: ${yamlPath}`);
    process.exit(1);
  }

  console.log(`Loading test definition: ${yamlPath}`);
  const testDef = loadTestDefinition(yamlPath);
  const testInfo = testDef.test_info;
  const scenarios = testDef.scenarios;

  console.log(`Suite: ${testInfo.test_suite_name}`);
  console.log(`Page: ${testInfo.page_url}`);
  console.log(`Scenarios: ${Object.keys(scenarios).length}`);

  // Filter by tags
  const includeTags = options.tag.split(',').map(t => t.trim());
  const excludeTags = options.excludeTags.split(',').map(t => t.trim());
  const tagMap = extractScenarioTags(yamlPath, scenarios);
  const filtered = filterScenariosByTags(scenarios, tagMap, includeTags, excludeTags);

  const filteredNames = Object.keys(filtered);
  console.log(`Selected ${filteredNames.length} scenario(s) after tag filtering`);

  if (filteredNames.length === 0) {
    console.log('No scenarios to run. Exiting.');
    process.exit(0);
  }

  // Create test run
  const run = createTestRun(yamlFile, testInfo.test_suite_name);
  const baseUrl = options.baseUrl || 'https://gamma.hub.quvia.ai';
  const timeout = parseInt(options.timeout, 10) || 60000;
  const outputDir = resolve(options.output);

  // Launch browser with extension
  console.log('\nLaunching browser with Neuron Interceptor...');
  const { context, page, cleanup } = await launchWithExtension({
    slowMo: parseInt(options.slowMo, 10) || 0,
  });

  try {
    // Execute each scenario
    for (const [scenarioName, scenarioDef] of Object.entries(filtered)) {
      const startTime = Date.now();
      console.log(`\n${'='.repeat(60)}`);
      console.log(`SCENARIO: ${scenarioName}`);
      console.log(`Description: ${scenarioDef.description || 'N/A'}`);
      console.log(`${'='.repeat(60)}`);

      const result = {
        name: scenarioName,
        status: 'passed',
        duration: 0,
        errors: [],
        validations: [],
      };

      try {
        // Get data scenarios
        const dataScenarios = scenarioDef.data_scenarios || [];
        if (dataScenarios.length === 0) {
          result.status = 'skipped';
          result.errors.push('No data scenarios defined');
          addScenarioResult(run, result);
          continue;
        }

        const preTestActions = scenarioDef.pre_test || [];
        const validations = scenarioDef.validations || [];
        const postTest = scenarioDef.post_test || [];

        // Separate one-time vs per-scenario actions
        const oneTimeActions = preTestActions.filter(a => a.per_scenario === false);
        const perScenarioActions = preTestActions.filter(a => a.per_scenario !== false);

        // Execute one-time actions
        for (const action of oneTimeActions) {
          await executeAction(page, action, { scenario_name: scenarioName, base_url: baseUrl }, testInfo, baseUrl);
        }

        // Execute each data scenario
        for (const dataScenario of dataScenarios) {
          const dsName = dataScenario.name || scenarioName;
          console.log(`\n  DATA SCENARIO: ${dsName}`);

          // Load mock response file
          const responseFile = resolveResponseFile(dataScenario, testInfo.page_name);
          let mockResponse = null;

          if (existsSync(responseFile)) {
            mockResponse = JSON.parse(readFileSync(responseFile, 'utf-8'));
            console.log(`    Loaded response: ${responseFile} (${JSON.stringify(mockResponse).length} bytes)`);
          } else {
            console.log(`    Warning: Response file not found: ${responseFile}`);
          }

          const context = {
            scenario_name: dsName,
            test_name: scenarioName,
            base_url: baseUrl,
            scenario_response: mockResponse,
          };

          // Execute per-scenario actions
          for (const action of perScenarioActions) {
            await executeAction(page, replaceTemplateVars(action, context), context, testInfo, baseUrl);
          }

          // Execute validations
          for (const validation of validations) {
            const resolvedValidation = replaceTemplateVars(validation, context);
            console.log(`    Validation: ${resolvedValidation.method}`);
            result.validations.push({
              dataScenario: dsName,
              method: resolvedValidation.method,
              passed: true, // CLI validations are capture-only for now
            });
          }
        }

        // Execute post-test
        for (const item of postTest) {
          await executeAction(page, item, { scenario_name: scenarioName, base_url: baseUrl }, testInfo, baseUrl);
        }

      } catch (err) {
        result.status = 'failed';
        result.errors.push(err.message || String(err));
        console.error(`  ERROR: ${err.message}`);
      }

      result.duration = Date.now() - startTime;
      addScenarioResult(run, result);
      console.log(`  Result: ${result.status.toUpperCase()} (${(result.duration / 1000).toFixed(1)}s)`);
    }

  } finally {
    await cleanup();
  }

  // Report
  finalizeRun(run);
  console.log(formatConsoleSummary(run));

  const reportPath = writeJsonReport(run, outputDir);
  console.log(`Results written to: ${reportPath}`);

  // Exit code
  process.exit(run.failed > 0 ? 1 : 0);
}

/**
 * Execute a single action from the YAML definition.
 */
async function executeAction(page, action, context, testInfo, baseUrl) {
  // Navigate
  if (action.navigate_to_page) {
    const url = `${baseUrl}${testInfo.page_url || '/'}`;
    console.log(`    Action: Navigate to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    return;
  }

  // Inject proxy (push rules)
  if (action.inject_proxy) {
    const cfg = action.inject_proxy;
    console.log(`    Action: Inject proxy (mode=${cfg.mode}, tag=${cfg.step_tag})`);

    if (cfg.mode === 'RESPONSE_ONLY' && context.scenario_response) {
      const rules = [{
        id: `cli-${Date.now()}`,
        name: `CLI Mock: ${cfg.step_tag}`,
        enabled: true,
        priority: 100,
        condition: {
          url: { type: 'contains', value: (cfg.api_patterns || [])[0] || '' },
          headers: [],
          methods: [],
        },
        action: {
          type: 'mock_inline',
          mockInline: {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(context.scenario_response),
          },
          redirect: { targetHost: '', preservePath: true },
          rewrite: { pattern: '', replacement: '' },
          mockServer: { serverUrl: 'http://localhost:5000/proxy', mode: 'RESPONSE_ONLY', stepTag: '' },
          headerMods: { addRequest: [], removeRequest: [], addResponse: [], removeResponse: [] },
          delayMs: 0,
        },
      }];
      await pushRules(page, rules);
    }
    return;
  }

  // Wait
  if (action.wait_for_load !== undefined) {
    const ms = typeof action.wait_for_load === 'number' ? action.wait_for_load : 3000;
    console.log(`    Action: Wait ${ms}ms`);
    await page.waitForTimeout(ms);
    return;
  }

  // Trigger filter reload
  if (action.trigger_filter_reload) {
    console.log('    Action: Trigger filter reload');
    await page.reload({ waitUntil: 'networkidle' });
    return;
  }

  // Reload page
  if (action.reload_page) {
    console.log('    Action: Reload page');
    await page.reload({ waitUntil: 'networkidle' });
    return;
  }

  // Stop proxy (clear rules)
  if (action.action === 'stop_proxy') {
    console.log('    Action: Stop proxy (clear rules)');
    await pushRules(page, [], [], false);
    return;
  }

  console.log(`    Action: Unknown action, skipping: ${JSON.stringify(action).slice(0, 100)}`);
}
```

### 9. `cli/commands/mock-serve.js`

```javascript
/**
 * commands/mock-serve.js
 *
 * neuron mock serve --rules <rules.json> [--port 3000]
 *
 * Starts a local HTTP server that serves mock responses based on rule
 * definitions. Useful for testing without a browser (curl, mobile apps,
 * backend-to-backend).
 */

import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, extname } from 'path';
import { findMatchingRule, extractMockResponse } from '../lib/rule-matcher.js';

/**
 * Start a mock server.
 *
 * @param {Object} options
 * @param {string} [options.rules] - Path to rules JSON file.
 * @param {string} [options.dataDir] - Directory with mock JSON files.
 * @param {string} [options.port] - Port to listen on.
 * @param {boolean} [options.cors] - Enable CORS.
 * @param {boolean} [options.verbose] - Log every request.
 */
export async function serveMocks(options) {
  const port = parseInt(options.port, 10) || 3000;
  let rules = [];

  // Load rules from file
  if (options.rules) {
    const rulesPath = resolve(options.rules);
    if (!existsSync(rulesPath)) {
      console.error(`Error: Rules file not found: ${rulesPath}`);
      process.exit(1);
    }

    const data = JSON.parse(readFileSync(rulesPath, 'utf-8'));
    rules = data.rules || data || [];
    console.log(`Loaded ${rules.length} rule(s) from ${rulesPath}`);
  }

  // Load mock files from data directory (create simple contains rules)
  if (options.dataDir) {
    const dataDir = resolve(options.dataDir);
    if (!existsSync(dataDir)) {
      console.error(`Error: Data directory not found: ${dataDir}`);
      process.exit(1);
    }

    const files = readdirSync(dataDir).filter(f => extname(f) === '.json');
    console.log(`Loading ${files.length} mock file(s) from ${dataDir}`);

    for (const file of files) {
      const filePath = join(dataDir, file);
      const body = readFileSync(filePath, 'utf-8');
      const urlPattern = file.replace('.json', '').replace(/_/g, '/');

      rules.push({
        id: `file-${file}`,
        name: `File: ${file}`,
        enabled: true,
        priority: 0,
        condition: {
          url: { type: 'contains', value: urlPattern },
          headers: [],
          methods: [],
        },
        action: {
          type: 'mock_inline',
          mockInline: {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body,
          },
        },
      });
    }
  }

  if (rules.length === 0) {
    console.error('Error: No rules loaded. Specify --rules or --data-dir.');
    process.exit(1);
  }

  // Create HTTP server
  const server = createServer((req, res) => {
    const url = `http://localhost:${port}${req.url}`;
    const method = req.method || 'GET';

    // Collect request headers
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = value;
    }

    if (options.verbose) {
      console.log(`  ${method} ${req.url}`);
    }

    // CORS preflight
    if (options.cors !== false && method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Find matching rule
    const matchedRule = findMatchingRule(url, method, headers, rules);

    if (matchedRule) {
      const mock = extractMockResponse(matchedRule);

      if (mock) {
        const responseHeaders = { ...mock.headers };
        if (options.cors !== false) {
          responseHeaders['Access-Control-Allow-Origin'] = '*';
        }

        if (options.verbose) {
          console.log(`    -> Matched rule: ${matchedRule.name} (${mock.statusCode})`);
        }

        res.writeHead(mock.statusCode, responseHeaders);
        res.end(mock.body);
        return;
      }
    }

    // No match
    if (options.verbose) {
      console.log(`    -> No matching rule found`);
    }

    const notFoundHeaders = { 'Content-Type': 'application/json' };
    if (options.cors !== false) {
      notFoundHeaders['Access-Control-Allow-Origin'] = '*';
    }

    res.writeHead(404, notFoundHeaders);
    res.end(JSON.stringify({
      error: 'No matching rule found',
      url: req.url,
      method,
      availableRules: rules.length,
    }));
  });

  server.listen(port, () => {
    console.log('');
    console.log(`  Neuron Mock Server running on http://localhost:${port}`);
    console.log(`  Rules loaded: ${rules.length}`);
    console.log('');
    console.log('  Try:');
    console.log(`    curl http://localhost:${port}/your-api-endpoint`);
    console.log('');
    console.log('  Press Ctrl+C to stop');
    console.log('');
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down mock server...');
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}
```

### 10. `cli/commands/record.js`

```javascript
/**
 * commands/record.js
 *
 * neuron record --url <url> [--output <dir>] [--duration <seconds>]
 *
 * Launches a headed browser with the Neuron Interceptor extension in
 * recording mode. The user browses manually while all API traffic is
 * captured. On close (or after the specified duration), fixtures are
 * exported to the output directory.
 */

import { resolve } from 'path';
import { launchWithExtension, pushRules, getLogs, clearLogs } from '../lib/playwright-bridge.js';
import { generateMockJsonFiles, generateYamlDefinition, generateRuleSet, generateHar } from '../lib/fixture-generator.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Record a browsing session.
 *
 * @param {Object} options
 * @param {string} [options.url] - URL to navigate to on launch.
 * @param {string} [options.output] - Output directory.
 * @param {string} [options.name] - Session name.
 * @param {string} [options.duration] - Auto-stop duration in seconds (0 = manual).
 * @param {string} [options.formats] - Export formats.
 * @param {string} [options.slowMo] - Slow down actions.
 */
export async function recordSession(options) {
  const outputDir = resolve(options.output || 'recorded');
  const sessionName = options.name || `recording-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}`;
  const duration = parseInt(options.duration, 10) || 0;
  const formats = (options.formats || 'json,yaml,rules').split(',').map(f => f.trim());

  console.log('');
  console.log('  Neuron Interceptor - Recording Mode');
  console.log('  ===================================');
  console.log('');
  console.log(`  Session: ${sessionName}`);
  console.log(`  Output:  ${outputDir}`);
  console.log(`  Formats: ${formats.join(', ')}`);
  if (duration > 0) {
    console.log(`  Duration: ${duration}s (auto-stop)`);
  } else {
    console.log('  Duration: Manual (close browser to stop)');
  }
  console.log('');

  // Launch browser
  console.log('Launching browser with Neuron Interceptor...');
  const { context, page, cleanup } = await launchWithExtension({
    slowMo: parseInt(options.slowMo, 10) || 0,
  });

  try {
    // Enable interception for logging (no rules = passthrough with logging)
    await pushRules(page, [], [], true);

    // Navigate to URL if specified
    if (options.url) {
      console.log(`Navigating to ${options.url}`);
      await page.goto(options.url, { waitUntil: 'networkidle', timeout: 60000 });
    }

    console.log('');
    console.log('Recording in progress...');
    console.log('Browse the application. All API traffic is being captured.');
    if (duration > 0) {
      console.log(`Recording will stop automatically in ${duration} seconds.`);
    } else {
      console.log('Close the browser window to stop recording and export.');
    }
    console.log('');

    if (duration > 0) {
      // Auto-stop after duration
      await page.waitForTimeout(duration * 1000);
      console.log(`\nDuration reached (${duration}s). Stopping recording...`);
    } else {
      // Wait for browser to close
      await new Promise((resolve) => {
        context.on('close', resolve);
        // Also handle page close
        page.on('close', () => {
          // Give a moment for any final logs
          setTimeout(resolve, 500);
        });
      });
      console.log('\nBrowser closed. Exporting captured data...');
    }

    // Collect logs before cleanup
    let logs;
    try {
      logs = await getLogs(page, 5000);
    } catch (_) {
      // Page might be closed already
      logs = [];
    }

    if (logs.length === 0) {
      console.log('No requests were captured during the recording session.');
      return;
    }

    console.log(`\nCaptured ${logs.length} request(s). Exporting...`);

    // Determine page URL from first entry
    let pageUrl = '/';
    if (options.url) {
      try { pageUrl = new URL(options.url).pathname; } catch (_) {}
    }

    // Export in requested formats
    mkdirSync(outputDir, { recursive: true });

    if (formats.includes('json')) {
      const files = generateMockJsonFiles(logs, outputDir, sessionName);
      console.log(`  Mock JSON: ${files.length} file(s) written to ${join(outputDir, sessionName)}/`);
    }

    if (formats.includes('yaml')) {
      const yamlContent = generateYamlDefinition(logs, sessionName, pageUrl);
      const yamlPath = join(outputDir, `${sessionName}_test_definition.yml`);
      writeFileSync(yamlPath, yamlContent, 'utf-8');
      console.log(`  YAML:      ${yamlPath}`);
    }

    if (formats.includes('rules')) {
      const rulesContent = generateRuleSet(logs, sessionName);
      const rulesPath = join(outputDir, `${sessionName}_rules.json`);
      writeFileSync(rulesPath, rulesContent, 'utf-8');
      console.log(`  Rules:     ${rulesPath}`);
    }

    if (formats.includes('har')) {
      const harContent = generateHar(logs, sessionName);
      const harPath = join(outputDir, `${sessionName}.har`);
      writeFileSync(harPath, harContent, 'utf-8');
      console.log(`  HAR:       ${harPath}`);
    }

    console.log('\nExport complete.');

  } finally {
    try { await cleanup(); } catch (_) {}
  }
}
```

### 11. `cli/commands/export.js`

```javascript
/**
 * commands/export.js
 *
 * neuron export --input <logs.json> --format <har|yaml|json|rules> --output <dir>
 *
 * Offline conversion of captured request logs to various export formats.
 * No browser needed -- pure file transformation.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { generateMockJsonFiles, generateYamlDefinition, generateRuleSet, generateHar } from '../lib/fixture-generator.js';

/**
 * Export logs to the specified format.
 *
 * @param {Object} options
 * @param {string} options.input - Path to input JSON file (array of log entries).
 * @param {string} options.format - Output format: 'har', 'yaml', 'json', 'rules'.
 * @param {string} [options.output] - Output directory.
 * @param {string} [options.name] - Session/test name.
 * @param {string} [options.pageUrl] - Page URL (for YAML).
 */
export async function exportLogs(options) {
  const inputPath = resolve(options.input);

  if (!existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Parse input
  let entries;
  try {
    const raw = JSON.parse(readFileSync(inputPath, 'utf-8'));
    // Support both raw array and { entries: [...] } format
    entries = Array.isArray(raw) ? raw : (raw.entries || raw.logs || []);
  } catch (err) {
    console.error(`Error: Failed to parse input file: ${err.message}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.error('Error: Input file contains no log entries.');
    process.exit(1);
  }

  const format = options.format.toLowerCase();
  const outputDir = resolve(options.output || '.');
  const sessionName = options.name || 'exported';
  const pageUrl = options.pageUrl || '/';

  mkdirSync(outputDir, { recursive: true });

  console.log(`Converting ${entries.length} log entries to ${format} format...`);

  switch (format) {
    case 'json': {
      const files = generateMockJsonFiles(entries, outputDir, sessionName);
      console.log(`Written ${files.length} mock JSON file(s) to ${join(outputDir, sessionName)}/`);
      break;
    }

    case 'yaml': {
      const content = generateYamlDefinition(entries, sessionName, pageUrl);
      const outPath = join(outputDir, `${sessionName}_test_definition.yml`);
      writeFileSync(outPath, content, 'utf-8');
      console.log(`Written YAML: ${outPath}`);
      break;
    }

    case 'rules': {
      const content = generateRuleSet(entries, sessionName);
      const outPath = join(outputDir, `${sessionName}_rules.json`);
      writeFileSync(outPath, content, 'utf-8');
      console.log(`Written rules: ${outPath}`);
      break;
    }

    case 'har': {
      const content = generateHar(entries, sessionName);
      const outPath = join(outputDir, `${sessionName}.har`);
      writeFileSync(outPath, content, 'utf-8');
      console.log(`Written HAR: ${outPath}`);
      break;
    }

    default:
      console.error(`Error: Unknown format '${format}'. Supported: json, yaml, rules, har`);
      process.exit(1);
  }

  console.log('Export complete.');
}
```

---

## Usage Examples

### Install and Link

```bash
cd health_check/utils/neuron-interceptor-plugin/cli
npm install
npm link  # Makes 'neuron' command available globally
```

### Run Tests from YAML

```bash
# Run all scenarios from a test definition
neuron test run health_check/test_definitions/fleet_summary.yml

# Run only specific tags
neuron test run health_check/test_definitions/fleet_summary.yml \
  --tag p1,regression

# Run with custom base URL
neuron test run health_check/test_definitions/fleet_summary.yml \
  --base-url https://staging.hub.quvia.ai

# Run with slow motion for debugging
neuron test run health_check/test_definitions/fleet_summary.yml \
  --slow-mo 500 --output results/cli

# Expected output:
#
# Loading test definition: health_check/test_definitions/fleet_summary.yml
# Suite: Fleet Summary
# Page: /monitoring/fleet-monitor
# Scenarios: 4
# Selected 2 scenario(s) after tag filtering
#
# Launching browser with Neuron Interceptor...
#
# ============================================================
# SCENARIO: no_filters_test
# Description: Default page state with no filters
# ============================================================
#   Action: Navigate to https://gamma.hub.quvia.ai/monitoring/fleet-monitor
#
#   DATA SCENARIO: no_filters_3_aircraft
#     Loaded response: health_check/test_data/fleet_summary/no_filters_3_aircraft.json
#     Action: Inject proxy (mode=RESPONSE_ONLY, tag=no_filters_3_aircraft)
#     Validation: capture_step_kpis
#     Validation: capture_step_tooltips
#   Result: PASSED (8.2s)
#
# ========================================================================
#   TEST RESULTS: Fleet Summary
# ========================================================================
#
#   [PASS]  no_filters_test  (8.2s)
#   [PASS]  status_filters_test  (12.1s)
#
# ------------------------------------------------------------------------
#   Total: 2  |  Passed: 2  |  Failed: 0  |  Skipped: 0
#   Duration: 20.3s
# ------------------------------------------------------------------------
#
# Results written to: results/cli/neuron-test-results-2026-04-01T12-00-00.json
```

### Serve Mocks

```bash
# Serve mocks from an exported rules file
neuron mock serve --rules recorded/fleet-test_rules.json --port 3000

# Serve mocks from a directory of JSON files
neuron mock serve --data-dir health_check/test_data/fleet_summary --port 3001

# With verbose logging
neuron mock serve --rules rules.json --port 3000 --verbose

# Expected output:
#
#   Neuron Mock Server running on http://localhost:3000
#   Rules loaded: 5
#
#   Try:
#     curl http://localhost:3000/your-api-endpoint
#
#   Press Ctrl+C to stop
#
# Then from another terminal:
# $ curl http://localhost:3000/fleet-summary/get-metrics/v3
# {"averageTailList": [...], "kpiMetrics": {...}}
```

### Record a Session

```bash
# Record with a starting URL
neuron record --url https://gamma.hub.quvia.ai/monitoring/fleet-monitor \
  --output recorded --name fleet-monitor-baseline

# Record with auto-stop after 60 seconds
neuron record --url https://gamma.hub.quvia.ai/monitoring/fleet-monitor \
  --duration 60 --formats json,yaml,rules,har

# Record with all formats
neuron record --output test-fixtures --name smoke-test \
  --formats json,yaml,rules,har

# Expected output:
#
#   Neuron Interceptor - Recording Mode
#   ===================================
#
#   Session: fleet-monitor-baseline
#   Output:  recorded
#   Formats: json, yaml, rules
#   Duration: Manual (close browser to stop)
#
# Launching browser with Neuron Interceptor...
# Navigating to https://gamma.hub.quvia.ai/monitoring/fleet-monitor
#
# Recording in progress...
# Browse the application. All API traffic is being captured.
# Close the browser window to stop recording and export.
#
# Browser closed. Exporting captured data...
#
# Captured 47 request(s). Exporting...
#   Mock JSON: 12 file(s) written to recorded/fleet-monitor-baseline/
#   YAML:      recorded/fleet-monitor-baseline_test_definition.yml
#   Rules:     recorded/fleet-monitor-baseline_rules.json
#
# Export complete.
```

### Export (Offline Conversion)

```bash
# Convert captured logs to HAR format
neuron export --input captured-logs.json --format har \
  --output exports --name my-session

# Convert to YAML test definition
neuron export --input captured-logs.json --format yaml \
  --output exports --name fleet-test --page-url /monitoring/fleet-monitor

# Convert to rules
neuron export --input captured-logs.json --format rules \
  --output exports --name fleet-mocks

# Convert to mock JSON files
neuron export --input captured-logs.json --format json \
  --output exports --name fleet-mocks

# Expected output:
#
# Converting 47 log entries to har format...
# Written HAR: exports/my-session.har
# Export complete.
```

### CI/CD Pipeline Example

```bash
#!/bin/bash
# ci-test.sh - Run in CI pipeline

cd health_check/utils/neuron-interceptor-plugin/cli
npm ci

# Run tests and capture exit code
npx neuron test run \
  ../../test_definitions/fleet_summary.yml \
  --tag p1,regression \
  --output ../../results/ci \
  --timeout 120000

TEST_EXIT=$?

# Archive results
tar czf test-results.tar.gz ../../results/ci/

exit $TEST_EXIT
```

---

## Verification Steps

### Setup

```bash
cd health_check/utils/neuron-interceptor-plugin/cli
npm install
```

### 1. Verify CLI Help

```bash
node neuron-cli.js --help
node neuron-cli.js test run --help
node neuron-cli.js mock --help
node neuron-cli.js record --help
node neuron-cli.js export --help
```

Expected: Each command displays its help text with options.

### 2. Verify Mock Server

```bash
# Create a test rules file
echo '{"rules": [{"id": "test-1", "name": "Test Rule", "enabled": true, "priority": 1, "condition": {"url": {"type": "contains", "value": "/api/test"}}, "action": {"type": "mock_inline", "mockInline": {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": "{\"hello\": \"world\"}"}}}]}' > /tmp/test-rules.json

# Start mock server
node neuron-cli.js mock serve --rules /tmp/test-rules.json --port 3333 --verbose &
SERVER_PID=$!

sleep 1

# Test the mock
curl -s http://localhost:3333/api/test
# Expected: {"hello": "world"}

curl -s http://localhost:3333/nonexistent
# Expected: {"error": "No matching rule found", ...}

kill $SERVER_PID
```

### 3. Verify Export Command

```bash
# Create a test input file
echo '[{"url": "https://example.com/api/users", "method": "GET", "statusCode": 200, "timestamp": 1711929600000, "duration": 150, "responseBody": "{\"users\": []}"}]' > /tmp/test-logs.json

# Export to all formats
node neuron-cli.js export --input /tmp/test-logs.json --format json --output /tmp/export-test --name test-export
node neuron-cli.js export --input /tmp/test-logs.json --format yaml --output /tmp/export-test --name test-export --page-url /app/users
node neuron-cli.js export --input /tmp/test-logs.json --format rules --output /tmp/export-test --name test-export
node neuron-cli.js export --input /tmp/test-logs.json --format har --output /tmp/export-test --name test-export

# Verify outputs exist
ls -la /tmp/export-test/
# Expected: test-export/ directory, test-export_test_definition.yml, test-export_rules.json, test-export.har
```

### 4. Verify Test Run (requires Playwright installed)

```bash
# Install Playwright if not present
npm install playwright
npx playwright install chromium

# Run a test (requires YAML and mock data files to exist)
node neuron-cli.js test run \
  ../../../../test_definitions/fleet_summary.yml \
  --tag no_filters_test \
  --output /tmp/test-results

# Expected: Browser opens, navigates, applies mocks, reports results
```

### 5. Verify Record (requires Playwright installed)

```bash
node neuron-cli.js record \
  --url https://gamma.hub.quvia.ai/monitoring/fleet-monitor \
  --output /tmp/recorded \
  --name manual-test \
  --duration 30

# Expected: Browser opens, navigates to URL, records for 30s, exports
```
