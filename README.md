# Mocxy

Chrome extension for API interception, URL routing, and response mocking — no code changes required.

---

## Installation

### Chrome Extension

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** → select the Mocxy folder (contains `manifest.json`)
3. The Mocxy icon appears in your toolbar

### Mock Server (Optional)

```bash
cd mock-server
npm install
npm start
```

- **HTTP**: `http://localhost:5000`
- **HTTPS**: `https://localhost:5443`
- **Admin UI**: `http://localhost:5000/mocxy-ui/`

Use `PORT=3000 npm start` for a custom port.

---

## Quick Start

1. Click the Mocxy icon → toggle **ON**
2. Click **Options** → **Add Rule**
3. Set a URL condition, choose an action, save
4. Refresh the target page — rules apply immediately

---

## Core Concepts

**Rules** — define when to intercept (URL pattern, method, headers) and what to do (redirect, mock, modify headers, delay). Evaluated in priority order.

**Mock Collections** — groups of mocks that can be activated/deactivated together. Useful for switching between scenarios (happy path, error states, edge cases).

**Inline vs Server-Backed mocking:**
- **Inline** — extension returns the response directly, no network call
- **Server** — request is routed to the Mocxy mock server for advanced matching

---

## Rule Actions

| Action | Description |
|--------|-------------|
| **Redirect** | Change hostname, preserve path & query params |
| **Rewrite** | Regex find-and-replace on the URL |
| **Modify Headers** | Add, remove, or change request/response headers |
| **Mock (Inline)** | Return a configured status, headers, and body |
| **Mock (Server)** | Route to the Mocxy mock server |
| **Delay** | Add artificial latency (ms) |

**URL matching modes**: `equals`, `contains`, `regex`, `glob`

---

## Examples

### Redirect prod → staging
- URL: `contains` → `api.production.com`
- Action: Redirect → `api.staging.com`

### Redirect to localhost
- URL: `contains` → `/api/v1/`
- Action: Redirect → `localhost:8080`

### Rewrite API version
- URL: `contains` → `/api/v1/`
- Action: Rewrite → Find: `/v1/`, Replace: `/v2/`

### Mock a 404
- URL: `equals` → `https://api.example.com/api/users/me`
- Method: `GET`
- Action: Mock (Inline) → Status `404`, body `{"error": "Not found"}`

### Add auth header
- URL: `contains` → `/api/`
- Action: Modify Headers → Add `Authorization: Bearer test-token`

### Simulate slow network
- URL: `contains` → `/api/users`
- Action: Delay → `3000` ms

---

## Mock Collections

1. Go to **Mock Collections** tab → **New Collection**
2. Add mocks (URL pattern, method, response body/status)
3. **Activate** to enable all mocks in the collection at once

---

## Mock Server

Start with `npm start` in `mock-server/`. Then create a rule with action **Mock (Server)** pointing to `http://localhost:5000`.

Manage stubs via Admin UI at `http://localhost:5000/mocxy-ui/`:
- Create/edit mock stubs with advanced request matching
- View request logs
- Import OpenAPI specs to generate mocks
- AI-powered mock generation
- Import/export collections

Health check: `GET http://localhost:5000/mocxy-ui/health` → `{"status":"ok"}`

---

## Request Log

Options → **Request Log** tab. Shows all intercepted requests with URL, method, status, duration, and matched rule.

Click any request to inspect request/response headers and body. Export as JSON.

---

## Import / Export

Options → **Import/Export** tab.

- **Export**: saves all rules, mock collections, and settings as JSON
- **Import**: choose **Replace All** (clears existing) or **Merge** (adds to existing)

---

## Troubleshooting

**Extension not intercepting?**
- Check the Mocxy icon shows green (enabled)
- Refresh the page after creating rules
- Open DevTools Console — look for `[Mocxy] Interceptor injected`
- Verify the URL condition matches the actual request

**Mock server not responding?**
- Check `curl http://localhost:5000/mocxy-ui/health`
- Check terminal logs where `npm start` is running

**Rule not matching?**
- `equals` is exact, `contains` is substring — verify the correct mode is set
- Check method filter and header conditions if configured
- Use Request Log to see what URL is actually being sent

---

## Architecture

```
Popup / Options UI
        │
  Service Worker          ← rule storage, declarativeNetRequest sync
        │
  Content Script          ← bridge between ISOLATED and MAIN world
        │
  Interceptor             ← overrides fetch() and XHR in MAIN world
        │
  Network Request         → redirect / mock inline / route to mock server / modify headers
```

---

## License

MIT
