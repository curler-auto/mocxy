# Feature 2.2: Playwright Bridge (Python Helper Class)

**Priority**: Phase 2 - Test Automation (Differentiator)
**Status**: NOT STARTED
**Depends On**: 2.1 (Record & Export -- for export_fixtures method)
**Estimated Effort**: Medium (4-6 hours)

---

## Overview

Create a Python helper class (`NeuronInterceptor`) that lets Playwright tests use the Chrome extension for interception instead of raw JS injection. This replaces the current approach where `inject_proxy_interceptor()` injects a standalone JS file and communicates with a Flask proxy server on port 5000. Instead, tests launch Chromium with the extension already loaded, push rules/mocks via `window.postMessage`, and read logs directly from IndexedDB -- all through Playwright's evaluate/evaluateHandle APIs.

---

## Architecture Context

### Current Approach (Flask Proxy)

```
Playwright test
  -> inject_proxy_interceptor(page, mode='RESPONSE_ONLY', ...)
    -> page.evaluate(interceptor_js_code)  # Injects fetch/XHR override
    -> Interceptor sends requests to Flask proxy at localhost:5000
    -> Flask proxy returns mock responses OR captures request bodies
  -> get_proxied_requests(step_tag='test')
    -> curl http://localhost:5000/proxy/captured-requests/test
```

**Problems with current approach**:
- Requires a separate Flask server process (single instance restriction).
- JS injection happens per-page and must be re-injected after navigation.
- Race conditions: proxy startup timing, multiple test workers competing for port 5000.
- No access to extension features (rules, mock collections, IndexedDB logs).

### New Approach (Extension-Native)

```
NeuronInterceptor (Python)
  -> playwright.chromium.launch_persistent_context(
       --load-extension=<path>,
       --disable-extensions-except=<path>
     )
  -> push_rules([...])
    -> page.evaluate(window.postMessage({ source: ..., type: 'RULES_UPDATED', ... }))
    -> Extension's interceptor-inject.js applies rules natively
  -> get_logs()
    -> page.evaluate(JS that reads IndexedDB directly)
  -> export_fixtures(output_dir, session_name)
    -> Generates mock JSON + YAML test definition files
```

**Benefits**:
- No external process needed (no Flask proxy, no port conflicts).
- Rules survive page navigation (extension content script re-injects automatically).
- Full access to extension features: rules, mock collections, recording, IndexedDB logs.
- Works in parallel (each test worker gets its own browser context with its own extension instance).

---

## File to Create

### `health_check/utils/neuron_playwright.py`

```python
"""
Neuron Playwright Bridge - Python helper for using the Neuron Interceptor
Chrome Extension with Playwright tests.

Provides a NeuronInterceptor class that:
  - Launches Chromium with the extension pre-loaded
  - Pushes interception rules and mock collections via postMessage
  - Reads request logs from IndexedDB
  - Exports captured traffic as test fixtures

Usage:
    from health_check.utils.neuron_playwright import NeuronInterceptor

    with NeuronInterceptor() as ni:
        ctx, page = ni.launch()
        ni.push_rules([{
            'name': 'Mock Fleet API',
            'enabled': True,
            'condition': {'url': {'type': 'contains', 'value': '/fleet-summary/'}},
            'action': {'type': 'mock_inline', 'mockInline': {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': '{"data": []}'
            }}
        }])
        page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
        logs = ni.get_logs(limit=50)
        ni.export_fixtures(Path('test_output'), 'fleet-test')
"""

import json
import logging
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Default path to the extension directory (relative to project root)
_DEFAULT_EXTENSION_PATH = Path(__file__).parent / 'neuron-interceptor-plugin'


class NeuronInterceptor:
    """
    Python bridge to the Neuron Interceptor Chrome Extension for Playwright.

    Launches a Chromium browser with the extension loaded via a persistent
    context and provides methods to push rules, read logs, and export
    fixtures -- all without needing an external proxy server.

    Supports use as a context manager:

        with NeuronInterceptor() as ni:
            ctx, page = ni.launch()
            ...
    """

    def __init__(self, extension_path: Optional[str] = None):
        """
        Initialize the NeuronInterceptor bridge.

        Args:
            extension_path: Absolute or relative path to the unpacked
                extension directory. Defaults to the neuron-interceptor-plugin
                directory adjacent to this file.
        """
        if extension_path:
            self._extension_path = Path(extension_path).resolve()
        else:
            self._extension_path = _DEFAULT_EXTENSION_PATH.resolve()

        if not self._extension_path.is_dir():
            raise FileNotFoundError(
                f'Extension directory not found: {self._extension_path}'
            )

        manifest = self._extension_path / 'manifest.json'
        if not manifest.exists():
            raise FileNotFoundError(
                f'manifest.json not found in extension directory: {self._extension_path}'
            )

        self._context = None
        self._page = None
        self._temp_dir = None
        self._playwright = None
        self._browser = None

        logger.info(f'NeuronInterceptor initialized with extension: {self._extension_path}')

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    # ------------------------------------------------------------------
    # Launch
    # ------------------------------------------------------------------

    def launch(
        self,
        headless: bool = False,
        slow_mo: float = 0,
        viewport: Optional[Dict[str, int]] = None,
        **launch_args,
    ) -> Tuple[Any, Any]:
        """
        Launch Chromium with the Neuron Interceptor extension loaded.

        Chrome extensions require a persistent context (user data directory).
        This method creates a temporary user-data-dir, launches Chromium with
        the extension, and returns the (browser_context, page) tuple.

        Note: headless=True is NOT supported for Chrome extensions in
        Chromium. The browser will always launch in headed mode. If
        headless=True is passed, a warning is logged and it is ignored.

        Args:
            headless: Ignored (extensions require headed mode). Logged as warning.
            slow_mo: Slow down Playwright operations by this amount (ms).
            viewport: Browser viewport size, e.g. {'width': 1920, 'height': 1080}.
            **launch_args: Additional keyword arguments passed to
                launch_persistent_context().

        Returns:
            Tuple of (browser_context, page).

        Raises:
            RuntimeError: If already launched.
        """
        if self._context is not None:
            raise RuntimeError('Already launched. Call close() first.')

        if headless:
            logger.warning(
                'NeuronInterceptor: headless=True is not supported for Chrome '
                'extensions. Launching in headed mode.'
            )

        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()

        # Create a temporary user-data directory
        self._temp_dir = tempfile.mkdtemp(prefix='neuron-playwright-')
        logger.info(f'Using temp user data dir: {self._temp_dir}')

        ext_path = str(self._extension_path)

        # Chrome args to load the extension
        chrome_args = [
            f'--disable-extensions-except={ext_path}',
            f'--load-extension={ext_path}',
            '--no-first-run',
            '--no-default-browser-check',
        ]

        # Merge with any extra args
        extra_args = launch_args.pop('args', [])
        if extra_args:
            chrome_args.extend(extra_args)

        # Set default viewport
        if viewport is None:
            viewport = {'width': 1920, 'height': 1080}

        self._context = self._playwright.chromium.launch_persistent_context(
            user_data_dir=self._temp_dir,
            headless=False,  # Extensions require headed mode
            slow_mo=slow_mo,
            viewport=viewport,
            args=chrome_args,
            **launch_args,
        )

        # The persistent context may open a default blank page
        if self._context.pages:
            self._page = self._context.pages[0]
        else:
            self._page = self._context.new_page()

        # Wait for the extension to initialize
        self._page.wait_for_timeout(1000)

        logger.info('NeuronInterceptor: Browser launched with extension loaded')
        return self._context, self._page

    # ------------------------------------------------------------------
    # Rule & collection management
    # ------------------------------------------------------------------

    def push_rules(self, rules: List[Dict], page: Optional[Any] = None) -> None:
        """
        Push interception rules to the extension via window.postMessage.

        The content script listens for messages with
        source='neuron-interceptor-content' and forwards them to the
        inject script running in the MAIN world.

        Args:
            rules: List of rule dicts. Each rule should have at minimum:
                - name (str)
                - enabled (bool)
                - condition.url.type ('contains'|'equals'|'regex'|'glob')
                - condition.url.value (str)
                - action.type ('mock_inline'|'redirect'|'mock_server'|...)
                - action.<type-specific config>
            page: Optional Playwright Page to use. Defaults to the page
                returned by launch().
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        rules_json = json.dumps(rules)

        target_page.evaluate(f'''() => {{
            window.postMessage({{
                source: 'neuron-interceptor-content',
                type: 'RULES_UPDATED',
                data: {{
                    rules: {rules_json},
                    mockCollections: [],
                    enabled: true
                }}
            }}, '*');
        }}''')

        logger.info(f'Pushed {len(rules)} rule(s) to extension')

    def push_mock_collections(
        self,
        collections: List[Dict],
        page: Optional[Any] = None,
    ) -> None:
        """
        Push mock collections to the extension via window.postMessage.

        Collections are groups of named mock responses that can be
        toggled on/off. They are evaluated after rules (lower priority).

        Args:
            collections: List of mock collection dicts. Each should have:
                - name (str)
                - active (bool)
                - mocks (list of mock entry dicts)
            page: Optional Playwright Page to use.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        collections_json = json.dumps(collections)

        target_page.evaluate(f'''() => {{
            window.postMessage({{
                source: 'neuron-interceptor-content',
                type: 'RULES_UPDATED',
                data: {{
                    rules: [],
                    mockCollections: {collections_json},
                    enabled: true
                }}
            }}, '*');
        }}''')

        logger.info(f'Pushed {len(collections)} mock collection(s) to extension')

    def push_rules_and_collections(
        self,
        rules: List[Dict],
        collections: List[Dict],
        enabled: bool = True,
        page: Optional[Any] = None,
    ) -> None:
        """
        Push both rules and mock collections in a single message.

        Args:
            rules: List of rule dicts.
            collections: List of mock collection dicts.
            enabled: Global interception enabled flag.
            page: Optional Playwright Page to use.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        data = {
            'rules': rules,
            'mockCollections': collections,
            'enabled': enabled,
        }
        data_json = json.dumps(data)

        target_page.evaluate(f'''() => {{
            window.postMessage({{
                source: 'neuron-interceptor-content',
                type: 'RULES_UPDATED',
                data: {data_json}
            }}, '*');
        }}''')

        logger.info(
            f'Pushed {len(rules)} rule(s) + {len(collections)} collection(s), '
            f'enabled={enabled}'
        )

    # ------------------------------------------------------------------
    # Enable / Disable
    # ------------------------------------------------------------------

    def enable(self, page: Optional[Any] = None) -> None:
        """
        Enable interception in the extension.

        Args:
            page: Optional Playwright Page to use.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        target_page.evaluate('''() => {
            window.postMessage({
                source: 'neuron-interceptor-content',
                type: 'RULES_UPDATED',
                data: { rules: undefined, mockCollections: undefined, enabled: true }
            }, '*');
        }''')

        logger.info('Interception enabled')

    def disable(self, page: Optional[Any] = None) -> None:
        """
        Disable interception in the extension.

        When disabled, the interceptor-inject.js still runs but
        findMatchingRule() and findMatchingMock() return null immediately,
        so all requests pass through unmodified.

        Args:
            page: Optional Playwright Page to use.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        target_page.evaluate('''() => {
            window.postMessage({
                source: 'neuron-interceptor-content',
                type: 'RULES_UPDATED',
                data: { rules: undefined, mockCollections: undefined, enabled: false }
            }, '*');
        }''')

        logger.info('Interception disabled')

    # ------------------------------------------------------------------
    # Log access
    # ------------------------------------------------------------------

    def get_logs(
        self,
        limit: int = 100,
        page: Optional[Any] = None,
    ) -> List[Dict]:
        """
        Read request log entries from the extension's IndexedDB.

        Evaluates JavaScript in the page context that opens the
        NeuronInterceptorDB, reads from the request_logs object store,
        and returns the entries as Python dicts.

        Note: This reads from the extension's IndexedDB in the service
        worker context. Since we cannot directly access the service
        worker's IndexedDB from a page context, we use
        chrome.runtime.sendMessage to query the service worker. However,
        from a MAIN world script we cannot call chrome.runtime APIs.
        Instead, we post a message to the content script which forwards
        it to the service worker.

        For simplicity and reliability, this method uses a synchronous
        approach: it evaluates JS that reads IndexedDB directly from the
        page's own context. Since the inject script posts log entries
        via window.postMessage -> content script -> service worker ->
        IndexedDB, we need to query through the service worker.

        Implementation: We use the page's evaluate to send a message and
        wait for the response via a Promise-based approach using
        window.__neuronGetLogs.

        Args:
            limit: Maximum number of entries to return (newest first).
            page: Optional Playwright Page to use.

        Returns:
            List of log entry dicts, sorted by timestamp descending.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        # Inject a helper that reads logs by posting to content script
        # and receiving the response via a callback
        logs = target_page.evaluate(f'''async () => {{
            return new Promise((resolve) => {{
                // Create a unique callback ID
                const callbackId = 'neuron_get_logs_' + Date.now();

                // Listen for the response
                const handler = (event) => {{
                    if (event.data?.source === 'neuron-interceptor-content'
                        && event.data?.type === 'GET_LOGS_RESPONSE'
                        && event.data?.callbackId === callbackId) {{
                        window.removeEventListener('message', handler);
                        resolve(event.data.data || []);
                    }}
                }};
                window.addEventListener('message', handler);

                // Request logs via content script bridge
                window.postMessage({{
                    source: 'neuron-interceptor-inject',
                    type: 'GET_LOGS',
                    callbackId: callbackId,
                    data: {{ limit: {limit} }}
                }}, '*');

                // Timeout fallback: if no response in 3s, try direct IDB read
                setTimeout(async () => {{
                    window.removeEventListener('message', handler);
                    try {{
                        const db = await new Promise((res, rej) => {{
                            const req = indexedDB.open('NeuronInterceptorDB', 1);
                            req.onsuccess = (e) => res(e.target.result);
                            req.onerror = (e) => rej(e.target.error);
                        }});
                        const tx = db.transaction('request_logs', 'readonly');
                        const store = tx.objectStore('request_logs');
                        const idx = store.index('timestamp');
                        const cursorReq = idx.openCursor(null, 'prev');
                        const results = [];
                        cursorReq.onsuccess = (e) => {{
                            const cursor = e.target.result;
                            if (cursor && results.length < {limit}) {{
                                results.push(cursor.value);
                                cursor.continue();
                            }} else {{
                                resolve(results);
                            }}
                        }};
                        cursorReq.onerror = () => resolve([]);
                    }} catch (err) {{
                        console.warn('[NeuronBridge] Direct IDB read failed:', err);
                        resolve([]);
                    }}
                }}, 3000);
            }});
        }}''')

        result = logs if isinstance(logs, list) else []
        logger.info(f'Retrieved {len(result)} log entries')
        return result

    def clear_logs(self, page: Optional[Any] = None) -> None:
        """
        Clear all request log entries from IndexedDB.

        Args:
            page: Optional Playwright Page to use.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        target_page.evaluate('''async () => {
            try {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('NeuronInterceptorDB', 1);
                    req.onsuccess = (e) => resolve(e.target.result);
                    req.onerror = (e) => reject(e.target.error);
                });
                const tx = db.transaction('request_logs', 'readwrite');
                const store = tx.objectStore('request_logs');
                store.clear();
                await new Promise((resolve) => { tx.oncomplete = resolve; });
            } catch (err) {
                console.warn('[NeuronBridge] Clear logs failed:', err);
            }
        }''')

        logger.info('Cleared all log entries')

    def wait_for_requests(
        self,
        count: int = 1,
        timeout_ms: int = 10000,
        poll_interval_ms: int = 500,
        url_pattern: Optional[str] = None,
        page: Optional[Any] = None,
    ) -> List[Dict]:
        """
        Wait until at least `count` log entries matching the criteria exist.

        Polls IndexedDB at regular intervals until the condition is met or
        the timeout expires.

        Args:
            count: Minimum number of matching entries to wait for.
            timeout_ms: Maximum time to wait in milliseconds.
            poll_interval_ms: Polling interval in milliseconds.
            url_pattern: Optional URL substring to filter entries.
            page: Optional Playwright Page to use.

        Returns:
            List of matching log entries.

        Raises:
            TimeoutError: If the condition is not met within timeout_ms.
        """
        target_page = page or self._page
        if target_page is None:
            raise RuntimeError('No page available. Call launch() first.')

        start = time.time()
        deadline = start + (timeout_ms / 1000)

        while time.time() < deadline:
            logs = self.get_logs(limit=500, page=target_page)

            if url_pattern:
                logs = [e for e in logs if url_pattern in (e.get('url') or '')]

            if len(logs) >= count:
                logger.info(
                    f'wait_for_requests: found {len(logs)} matching entries '
                    f'(wanted {count}) in {(time.time() - start) * 1000:.0f}ms'
                )
                return logs

            target_page.wait_for_timeout(poll_interval_ms)

        raise TimeoutError(
            f'Timed out waiting for {count} request(s) '
            f'(url_pattern={url_pattern!r}) after {timeout_ms}ms'
        )

    # ------------------------------------------------------------------
    # Export fixtures
    # ------------------------------------------------------------------

    def export_fixtures(
        self,
        output_dir: Path,
        session_name: str,
        page_url: str = '/',
        page: Optional[Any] = None,
    ) -> Dict[str, Path]:
        """
        Export captured request logs as test fixture files.

        Generates:
          1. Mock JSON files (one per unique endpoint)
          2. YAML test definition (matching test_definitions/*.yml format)

        Args:
            output_dir: Directory to write files to (created if absent).
            session_name: Name for the session (used in filenames).
            page_url: The page URL path (for YAML generation).
            page: Optional Playwright Page to use.

        Returns:
            Dict mapping format name to output file path:
            {
                'mock_dir': Path('output_dir/session_name/'),
                'yaml': Path('output_dir/session_name_test_definition.yml'),
            }
        """
        target_page = page or self._page
        logs = self.get_logs(limit=1000, page=target_page)

        if not logs:
            logger.warning('No log entries to export')
            return {}

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Group by endpoint
        endpoints = {}
        for entry in logs:
            url = entry.get('url', '')
            if not url:
                continue
            method = entry.get('method', 'GET')

            try:
                from urllib.parse import urlparse
                parsed = urlparse(url)
                key = f'{method}_{parsed.path}'
            except Exception:
                key = f'{method}_{url}'

            if key not in endpoints or (entry.get('timestamp', 0) > endpoints[key].get('timestamp', 0)):
                endpoints[key] = entry

        # --- Generate mock JSON files ---
        mock_dir = output_dir / session_name
        mock_dir.mkdir(parents=True, exist_ok=True)

        for key, entry in endpoints.items():
            filename = self._sanitize_url_to_filename(entry.get('url', ''))
            body = entry.get('responseBody', '{}')

            # Try to format JSON for readability
            try:
                parsed_body = json.loads(body) if isinstance(body, str) else body
                body_str = json.dumps(parsed_body, indent=2)
            except (json.JSONDecodeError, TypeError):
                body_str = str(body) if body else '{}'

            mock_file = mock_dir / f'{filename}.json'
            mock_file.write_text(body_str, encoding='utf-8')
            logger.info(f'Wrote mock: {mock_file}')

        # --- Generate YAML test definition ---
        page_name = session_name.replace('-', '_').replace(' ', '_').lower()

        # Determine primary API endpoint
        endpoint_counts = {}
        for entry in logs:
            url = entry.get('url', '')
            try:
                from urllib.parse import urlparse
                path = urlparse(url).path
                endpoint_counts[path] = endpoint_counts.get(path, 0) + 1
            except Exception:
                pass

        primary_endpoint = max(endpoint_counts, key=endpoint_counts.get) if endpoint_counts else '/'

        yaml_lines = [
            f'test_info:',
            f'  test_suite_name: "{session_name}"',
            f'  test_suite_type: "ui"',
            f'  page_name: "{page_name}"',
            f'  page_url: "{page_url}"',
            f'  api_endpoint: "{primary_endpoint}"',
            f'  module: "Recorded Session"',
            f'  execution: "serial"',
            f'  runner_mode: "v1"',
            f'  description: "Auto-generated from NeuronInterceptor export: {session_name}"',
            f'  tags: ["ui", "recorded", "{page_name}"]',
            f'  priority: 1',
            f'',
            f'scenarios:',
            f'  {page_name}_test: #p1, regression, recorded',
            f'    description: "Recorded data scenarios from: {session_name}"',
            f'    priority: 1',
            f'    tags: ["p1", "regression", "recorded"]',
            f'',
            f'    data_scenarios:',
        ]

        for key, entry in endpoints.items():
            filename = self._sanitize_url_to_filename(entry.get('url', ''))
            method = entry.get('method', 'GET')
            url = entry.get('url', '')
            yaml_lines.extend([
                f'      - name: "{filename}"',
                f'        description: "Recorded {method} {url}"',
                f'        response_file: "health_check/test_data/{page_name}/{filename}.json"',
                f'',
            ])

        # Determine a short API pattern for the proxy
        api_pattern = '/'.join(primary_endpoint.split('/')[-2:]) if primary_endpoint != '/' else ''

        yaml_lines.extend([
            f'    pre_test:',
            f'      - navigate_to_page: true',
            f'        per_scenario: false',
            f'',
            f'      - inject_proxy:',
            f'          mode: "RESPONSE_ONLY"',
            f'          step_tag: "{{{{scenario_name}}}}"',
            f'          api_patterns: ["{api_pattern}"]',
            f'        per_scenario: true',
            f'',
            f'      - trigger_filter_reload: true',
            f'        per_scenario: true',
            f'',
            f'      - wait_for_load: 3000',
            f'        per_scenario: true',
            f'',
            f'    validations:',
            f'      - method: "capture_step_kpis"',
            f'        params:',
            f'          step_tag: "{{{{scenario_name}}}}"',
            f'',
            f'    post_test:',
            f'      - action: stop_proxy',
        ])

        yaml_path = output_dir / f'{session_name}_test_definition.yml'
        yaml_path.write_text('\n'.join(yaml_lines), encoding='utf-8')
        logger.info(f'Wrote YAML: {yaml_path}')

        return {
            'mock_dir': mock_dir,
            'yaml': yaml_path,
        }

    # ------------------------------------------------------------------
    # Helper: build a mock_inline rule from a response dict
    # ------------------------------------------------------------------

    @staticmethod
    def make_mock_rule(
        name: str,
        url_contains: str,
        response_body: Any,
        status_code: int = 200,
        method: Optional[str] = None,
        priority: int = 10,
    ) -> Dict:
        """
        Convenience factory to build a mock_inline rule dict.

        Args:
            name: Human-readable rule name.
            url_contains: URL substring that triggers this rule.
            response_body: The response body (dict/list will be JSON-serialized,
                str used as-is).
            status_code: HTTP response status code.
            method: If set, only match this HTTP method.
            priority: Rule priority (higher = evaluated first).

        Returns:
            A complete rule dict ready for push_rules().
        """
        if isinstance(response_body, (dict, list)):
            body_str = json.dumps(response_body)
        else:
            body_str = str(response_body)

        rule = {
            'id': f'ni-{int(time.time())}-{id(name) % 10000}',
            'name': name,
            'enabled': True,
            'priority': priority,
            'condition': {
                'url': {'type': 'contains', 'value': url_contains},
                'headers': [],
                'methods': [method.upper()] if method else [],
            },
            'action': {
                'type': 'mock_inline',
                'mockInline': {
                    'statusCode': status_code,
                    'headers': {'Content-Type': 'application/json'},
                    'body': body_str,
                },
                'redirect': {'targetHost': '', 'preservePath': True},
                'rewrite': {'pattern': '', 'replacement': ''},
                'mockServer': {
                    'serverUrl': 'http://localhost:5000/proxy',
                    'mode': 'RESPONSE_ONLY',
                    'stepTag': '',
                },
                'headerMods': {
                    'addRequest': [], 'removeRequest': [],
                    'addResponse': [], 'removeResponse': [],
                },
                'delayMs': 0,
            },
        }
        return rule

    @staticmethod
    def make_redirect_rule(
        name: str,
        url_contains: str,
        target_host: str,
        preserve_path: bool = True,
        priority: int = 10,
    ) -> Dict:
        """
        Convenience factory to build a redirect rule dict.

        Args:
            name: Human-readable rule name.
            url_contains: URL substring that triggers this rule.
            target_host: Hostname to redirect to.
            preserve_path: Whether to keep the original path.
            priority: Rule priority.

        Returns:
            A complete rule dict ready for push_rules().
        """
        return {
            'id': f'ni-{int(time.time())}-{id(name) % 10000}',
            'name': name,
            'enabled': True,
            'priority': priority,
            'condition': {
                'url': {'type': 'contains', 'value': url_contains},
                'headers': [],
                'methods': [],
            },
            'action': {
                'type': 'redirect',
                'redirect': {
                    'targetHost': target_host,
                    'preservePath': preserve_path,
                },
                'rewrite': {'pattern': '', 'replacement': ''},
                'mockInline': {
                    'statusCode': 200,
                    'headers': {'Content-Type': 'application/json'},
                    'body': '{}',
                },
                'mockServer': {
                    'serverUrl': 'http://localhost:5000/proxy',
                    'mode': 'RESPONSE_ONLY',
                    'stepTag': '',
                },
                'headerMods': {
                    'addRequest': [], 'removeRequest': [],
                    'addResponse': [], 'removeResponse': [],
                },
                'delayMs': 0,
            },
        }

    @staticmethod
    def make_proxy_rule(
        name: str,
        url_contains: str,
        mode: str = 'RESPONSE_ONLY',
        step_tag: str = '',
        server_url: str = 'http://localhost:5000/proxy',
        priority: int = 10,
    ) -> Dict:
        """
        Convenience factory to build a mock_server (proxy) rule dict.

        Args:
            name: Human-readable rule name.
            url_contains: URL substring that triggers this rule.
            mode: Proxy mode ('RESPONSE_ONLY', 'REQUEST_ONLY', 'PASSTHROUGH').
            step_tag: Tag for request grouping on the proxy server.
            server_url: Proxy server base URL.
            priority: Rule priority.

        Returns:
            A complete rule dict ready for push_rules().
        """
        return {
            'id': f'ni-{int(time.time())}-{id(name) % 10000}',
            'name': name,
            'enabled': True,
            'priority': priority,
            'condition': {
                'url': {'type': 'contains', 'value': url_contains},
                'headers': [],
                'methods': [],
            },
            'action': {
                'type': 'mock_server',
                'mockServer': {
                    'serverUrl': server_url,
                    'mode': mode,
                    'stepTag': step_tag,
                },
                'redirect': {'targetHost': '', 'preservePath': True},
                'rewrite': {'pattern': '', 'replacement': ''},
                'mockInline': {
                    'statusCode': 200,
                    'headers': {'Content-Type': 'application/json'},
                    'body': '{}',
                },
                'headerMods': {
                    'addRequest': [], 'removeRequest': [],
                    'addResponse': [], 'removeResponse': [],
                },
                'delayMs': 0,
            },
        }

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        """
        Close the browser context and clean up temporary files.

        Safe to call multiple times.
        """
        if self._context:
            try:
                self._context.close()
            except Exception as e:
                logger.warning(f'Error closing context: {e}')
            self._context = None
            self._page = None

        if self._playwright:
            try:
                self._playwright.stop()
            except Exception as e:
                logger.warning(f'Error stopping playwright: {e}')
            self._playwright = None

        if self._temp_dir:
            try:
                shutil.rmtree(self._temp_dir, ignore_errors=True)
                logger.info(f'Cleaned up temp dir: {self._temp_dir}')
            except Exception as e:
                logger.warning(f'Error cleaning temp dir: {e}')
            self._temp_dir = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _sanitize_url_to_filename(url: str) -> str:
        """
        Convert a URL into a safe filename segment.

        Example:
            /neuron-api/visualization/api/fleet-summary/get-metrics/v3
            -> fleet-summary_get-metrics_v3
        """
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            path = parsed.path
        except Exception:
            path = url

        # Remove common API prefixes
        import re
        path = re.sub(r'^/(neuron-api|api|v\d+)/', '/', path, flags=re.IGNORECASE)
        path = re.sub(r'^/visualization/api/', '/', path)
        # Strip leading/trailing slashes
        path = path.strip('/')
        # Replace slashes with underscores
        path = path.replace('/', '_')
        # Remove non-alphanumeric chars except underscores and hyphens
        path = re.sub(r'[^a-zA-Z0-9_-]', '', path)
        # Collapse multiple underscores
        path = re.sub(r'_+', '_', path)

        return path or 'unknown-endpoint'
```

---

## Integration Examples

### Example 1: Replace inject_proxy_interceptor (RESPONSE_ONLY)

```python
# BEFORE (current approach using Flask proxy):
from health_check.page_validations import inject_proxy_interceptor
# Requires: python3 health_check/api_expectation_generator.py & (running on port 5000)

page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
inject_proxy_interceptor(page, mode='RESPONSE_ONLY', step_tag='test',
                          default_response=mock_data)
# ... trigger reload, validate ...

# ---

# AFTER (with NeuronInterceptor -- no external server needed):
from health_check.utils.neuron_playwright import NeuronInterceptor
import json

with NeuronInterceptor() as ni:
    ctx, page = ni.launch()

    # Load mock data
    with open('health_check/test_data/fleet_summary/no_filters_3_aircraft.json') as f:
        mock_data = json.load(f)

    # Push a mock rule (equivalent to RESPONSE_ONLY mode)
    ni.push_rules([
        ni.make_mock_rule(
            name='Mock Fleet Summary',
            url_contains='/fleet-summary/get-metrics',
            response_body=mock_data,
        )
    ])

    page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
    page.wait_for_timeout(3000)

    # Validate KPIs, tooltips, etc.
    # ...

    # Check logs
    logs = ni.get_logs(limit=50)
    intercepted = [l for l in logs if l.get('intercepted')]
    assert len(intercepted) > 0, 'Expected at least one intercepted request'
```

### Example 2: Replace inject_proxy_interceptor (REQUEST_ONLY)

```python
# BEFORE:
inject_proxy_interceptor(page, mode='REQUEST_ONLY', step_tag='validate_requests')
# ... trigger filter ...
requests = get_proxied_requests('validate_requests')

# ---

# AFTER:
with NeuronInterceptor() as ni:
    ctx, page = ni.launch()

    # Push a proxy rule that forwards to Flask proxy for REQUEST_ONLY capture
    ni.push_rules([
        ni.make_proxy_rule(
            name='Capture Fleet Requests',
            url_contains='/fleet-summary/get-metrics',
            mode='REQUEST_ONLY',
            step_tag='validate_requests',
        )
    ])

    page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
    # ... apply filters ...

    # Read logs directly (no need to query Flask proxy)
    logs = ni.get_logs(limit=50)
    fleet_requests = [l for l in logs if '/fleet-summary/' in (l.get('url') or '')]
    assert len(fleet_requests) > 0
```

### Example 3: Record and Export Fixtures

```python
with NeuronInterceptor() as ni:
    ctx, page = ni.launch()

    # Enable interception (just for logging, no rules)
    ni.enable()

    # Browse the application
    page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
    page.wait_for_timeout(5000)

    # Apply some filters
    # ...

    page.wait_for_timeout(3000)

    # Export everything as test fixtures
    result = ni.export_fixtures(
        output_dir=Path('health_check/test_data/generated'),
        session_name='fleet-monitor-baseline',
        page_url='/monitoring/fleet-monitor',
    )

    print(f"Mock files: {result['mock_dir']}")
    print(f"YAML definition: {result['yaml']}")
```

### Example 4: Use with pytest and page fixture

```python
import pytest
from health_check.utils.neuron_playwright import NeuronInterceptor

@pytest.fixture(scope='session')
def neuron():
    """Provide a NeuronInterceptor instance for the test session."""
    ni = NeuronInterceptor()
    ctx, page = ni.launch()
    yield ni, ctx, page
    ni.close()

def test_fleet_summary_mock(neuron):
    ni, ctx, page = neuron

    ni.push_rules([
        ni.make_mock_rule(
            name='Empty Fleet',
            url_contains='/fleet-summary/get-metrics',
            response_body={'averageTailList': [], 'kpiMetrics': {}},
        )
    ])

    page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
    page.wait_for_timeout(3000)

    # Assert empty state
    assert page.locator('.empty-state-message').is_visible()

    # Verify request was intercepted
    logs = ni.get_logs(limit=10)
    intercepted = [l for l in logs if l.get('intercepted')]
    assert len(intercepted) >= 1
```

---

## Content Script Modification for Log Retrieval

To support the `get_logs()` method reliably, add a `GET_LOGS` message handler in `content/content-script.js`:

```javascript
// Add inside the window.addEventListener('message', ...) handler,
// after the existing 'LOG_REQUEST' case:

case 'GET_LOGS':
  // Forward log query to service worker and relay response back
  chrome.runtime.sendMessage({
    type: 'GET_LOGS',
    data: msg.data
  }).then((response) => {
    window.postMessage({
      source: 'neuron-interceptor-content',
      type: 'GET_LOGS_RESPONSE',
      callbackId: msg.callbackId,
      data: response?.data || response || []
    }, '*');
  }).catch((err) => {
    window.postMessage({
      source: 'neuron-interceptor-content',
      type: 'GET_LOGS_RESPONSE',
      callbackId: msg.callbackId,
      data: []
    }, '*');
  });
  break;
```

---

## Verification Steps

### Manual Test Script

Save this as `health_check/utils/test_neuron_playwright.py` and run it:

```python
#!/usr/bin/env python3
"""
Manual verification script for NeuronInterceptor.

Run:
    cd /path/to/nms-visualization-ui
    python -m health_check.utils.test_neuron_playwright
"""

import json
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('test_neuron_playwright')

# Import the bridge
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from health_check.utils.neuron_playwright import NeuronInterceptor


def main():
    logger.info('=== NeuronInterceptor Verification ===')

    with NeuronInterceptor() as ni:
        # 1. Launch browser with extension
        logger.info('Step 1: Launching browser...')
        ctx, page = ni.launch()
        logger.info('  Browser launched successfully')

        # 2. Push a mock rule
        logger.info('Step 2: Pushing mock rule...')
        mock_response = {
            'averageTailList': [
                {'tail_number': 'N001AA', 'tail_status': 'GOOD'},
                {'tail_number': 'N002BB', 'tail_status': 'CRITICAL'},
            ],
            'kpiMetrics': {'totalActive': 2, 'totalInactive': 0},
        }

        ni.push_rules([
            ni.make_mock_rule(
                name='Test Mock',
                url_contains='/fleet-summary/get-metrics',
                response_body=mock_response,
            )
        ])
        logger.info('  Mock rule pushed')

        # 3. Navigate to the page
        logger.info('Step 3: Navigating to fleet monitor...')
        page.goto('https://gamma.hub.quvia.ai/monitoring/fleet-monitor')
        page.wait_for_timeout(5000)
        logger.info('  Page loaded')

        # 4. Check logs
        logger.info('Step 4: Retrieving logs...')
        logs = ni.get_logs(limit=20)
        logger.info(f'  Found {len(logs)} log entries')

        intercepted = [l for l in logs if l.get('intercepted')]
        logger.info(f'  Intercepted: {len(intercepted)}')

        for log_entry in intercepted[:5]:
            logger.info(f'    {log_entry.get("method")} {log_entry.get("url", "")[:80]} -> {log_entry.get("statusCode")}')

        # 5. Export fixtures
        logger.info('Step 5: Exporting fixtures...')
        output_dir = Path('results/neuron_playwright_test')
        result = ni.export_fixtures(
            output_dir=output_dir,
            session_name='verification-test',
            page_url='/monitoring/fleet-monitor',
        )

        for key, path in result.items():
            logger.info(f'  {key}: {path}')

        # 6. Disable and verify passthrough
        logger.info('Step 6: Disabling interception...')
        ni.disable()
        page.reload()
        page.wait_for_timeout(3000)
        logger.info('  Interception disabled, page reloaded')

        # 7. Clear logs
        logger.info('Step 7: Clearing logs...')
        ni.clear_logs()
        remaining = ni.get_logs(limit=10)
        logger.info(f'  Logs after clear: {len(remaining)}')

        logger.info('=== Verification complete ===')

        # Keep browser open for manual inspection
        input('Press Enter to close the browser...')


if __name__ == '__main__':
    main()
```

### Expected Output

```
2026-04-01 12:00:00 test_neuron_playwright INFO === NeuronInterceptor Verification ===
2026-04-01 12:00:00 test_neuron_playwright INFO Step 1: Launching browser...
2026-04-01 12:00:02 test_neuron_playwright INFO   Browser launched successfully
2026-04-01 12:00:02 test_neuron_playwright INFO Step 2: Pushing mock rule...
2026-04-01 12:00:02 test_neuron_playwright INFO   Mock rule pushed
2026-04-01 12:00:02 test_neuron_playwright INFO Step 3: Navigating to fleet monitor...
2026-04-01 12:00:08 test_neuron_playwright INFO   Page loaded
2026-04-01 12:00:08 test_neuron_playwright INFO Step 4: Retrieving logs...
2026-04-01 12:00:08 test_neuron_playwright INFO   Found 15 log entries
2026-04-01 12:00:08 test_neuron_playwright INFO   Intercepted: 3
2026-04-01 12:00:08 test_neuron_playwright INFO     POST /neuron-api/visualization/api/fleet-summary/get-metrics/v3 -> 200
2026-04-01 12:00:08 test_neuron_playwright INFO Step 5: Exporting fixtures...
2026-04-01 12:00:08 test_neuron_playwright INFO   mock_dir: results/neuron_playwright_test/verification-test
2026-04-01 12:00:08 test_neuron_playwright INFO   yaml: results/neuron_playwright_test/verification-test_test_definition.yml
2026-04-01 12:00:08 test_neuron_playwright INFO Step 6: Disabling interception...
2026-04-01 12:00:12 test_neuron_playwright INFO   Interception disabled, page reloaded
2026-04-01 12:00:12 test_neuron_playwright INFO Step 7: Clearing logs...
2026-04-01 12:00:12 test_neuron_playwright INFO   Logs after clear: 0
2026-04-01 12:00:12 test_neuron_playwright INFO === Verification complete ===
```

### Automated Assertions

The test script should verify:

1. `launch()` returns a non-None context and page.
2. `push_rules()` does not throw.
3. After navigation, `get_logs()` returns at least 1 entry.
4. At least 1 entry has `intercepted: true`.
5. `export_fixtures()` creates the mock directory and YAML file.
6. The generated YAML file contains valid YAML with `test_info` and `scenarios` keys.
7. `clear_logs()` results in 0 entries on subsequent `get_logs()` call.
8. `close()` does not throw and removes the temp directory.
