# Mocxy — Chrome Extension

API interception, URL routing, and response mocking for developer testing.

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select this folder (`health_check/utils/mocxy-plugin/`)
5. The Mocxy icon will appear in your extensions toolbar

## Features

### Routing Rules
- **URL matching**: equals, contains, regex, glob patterns
- **Header matching**: match request headers by name and value
- **Method filtering**: restrict rules to specific HTTP methods
- **Actions**:
  - **Redirect**: Swap hostnames (e.g., prod → staging), preserve path/query
  - **Rewrite**: Regex find & replace on URL path
  - **Modify Headers**: Add/remove request and response headers
  - **Mock (inline)**: Return a configured response directly — zero network calls
  - **Mock (server-backed)**: Route to Flask proxy (`api_expectation_generator.py`) for capture + mock
  - **Delay**: Add latency before response
- Rules support priority ordering, enable/disable toggle, drag-to-reorder

### Response Mocking
- **Inline mocking**: Return a `new Response()` with configured body, status, and headers
- **Server-backed mocking**: Integrates with the existing Flask proxy on port 5000
- **Mock Collections**: Group related mocks, activate/deactivate as a set
- **JSON editor** with syntax highlighting, format, validate, load-from-file

### Request Capture & Logging
- Live log of all intercepted requests: URL, method, status, duration, matched rule
- Filter by URL pattern, method, status code, intercepted-only
- Expandable detail view with request/response headers and bodies
- Export as JSON

### Import / Export
- Full JSON export of rules + mock collections + settings
- Import with "Replace All" or "Merge" modes
- Share configuration files with team members

## Architecture

```
Popup/Options UI  <->  Service Worker  <->  Content Script (ISOLATED)
                      (rule storage,        |
                       orchestration)       v
                                        interceptor-inject.js (MAIN world)
                                        (overrides fetch/XHR, evaluates rules)
                                            |
                                            v (optional)
                                        External Mock Server (Flask on :5000)
```

- **Content Script** injects `interceptor-inject.js` into the page's MAIN world
- **Service Worker** manages rules, storage, and broadcasts updates to tabs
- **Popup** for quick toggle/status; **Options Page** for full management
- **`chrome.declarativeNetRequest`** used as fast-path for simple hostname redirects

## File Structure

```
mocxy-plugin/
├── manifest.json
├── service-worker/
│   ├── sw.js                    # Main service worker
│   ├── rule-engine.js           # Rule condition matching
│   ├── storage-manager.js       # chrome.storage.local + IndexedDB
│   ├── dnr-manager.js           # declarativeNetRequest sync
│   └── message-router.js        # Message handling
├── content/
│   ├── content-script.js        # Bridge (ISOLATED <-> MAIN world)
│   └── interceptor-inject.js    # MAIN world fetch/XHR override
├── popup/
│   ├── popup.html / .css / .js
├── options/
│   ├── options.html / .css / .js
│   └── components/
│       ├── rule-list.js         # Drag-to-reorder rule list
│       ├── rule-form.js         # Condition builder + action editor
│       ├── mock-editor.js       # JSON editor with syntax highlighting
│       ├── request-log.js       # Live request/response log viewer
│       ├── import-export.js     # JSON import/export
│       └── settings-panel.js    # Global settings
├── shared/
│   ├── constants.js
│   ├── data-models.js
│   └── utils.js
├── lib/
│   └── json-highlight.js        # JSON syntax highlighter
├── icons/
│   └── icon{16,32,48,128}.png
└── README.md
```

## Integration with Existing Test Suite

This extension reuses patterns from the automated test infrastructure:

- **`configurable_interceptor.js`** evolved into `interceptor-inject.js`
- **`api_expectation_generator.py`** Flask proxy API contract used by server-backed mock mode
- **`page_validations.py:inject_proxy_interceptor()`** PROXY_CONFIG schema replicated

### Server-Backed Mocking

To use server-backed mocking, start the Flask proxy:

```bash
cd health_check
python3 api_expectation_generator.py &
```

Then create a rule with action type "Mock (Server)" pointing to `http://localhost:5000/proxy`.

## Quick Start

1. Install the extension (see Installation above)
2. Click the extension icon -> toggle ON
3. Click "Options" to open the full management page
4. Create your first rule:
   - Click "Add Rule"
   - Name: "Redirect to Staging"
   - URL condition: contains `/neuron-api/`
   - Action: Redirect -> Target Host: `staging.hub.quvia.ai`
   - Save
5. Navigate to the target site — matching requests will be redirected

## Verification

1. Load as unpacked extension in `chrome://extensions`
2. Navigate to target domain -> check console for `[Mocxy] Interceptor injected`
3. Create a redirect rule -> verify in DevTools Network tab
4. Create an inline mock -> verify mock response in DevTools
5. Check request log in Options page for intercepted traffic

## Notes

- No build step required — vanilla HTML/CSS/JS
- No external dependencies
- Distributed as unpacked extension (load via `chrome://extensions` > "Load unpacked")
- Icons are placeholder solid-color PNGs — replace with custom icons as needed
