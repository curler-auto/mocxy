# Mocxy — Complete User Guide

**Mocxy** is a powerful Chrome extension for API interception, URL routing, and response mocking designed for developers and QA engineers. It enables you to redirect requests, modify headers, inject mock responses, and capture network traffic—all without modifying application code.

---

## Table of Contents

1. [Installation](#installation)
2. [Getting Started](#getting-started)
3. [Core Concepts](#core-concepts)
4. [Features Overview](#features-overview)
5. [Creating Routing Rules](#creating-routing-rules)
6. [Response Mocking](#response-mocking)
7. [Mock Server Setup](#mock-server-setup)
8. [Request Logging](#request-logging)
9. [Import/Export](#importexport)
10. [Use Cases & Examples](#use-cases--examples)
11. [Architecture](#architecture)
12. [Troubleshooting](#troubleshooting)

---

## Installation

### Chrome Extension

1. **Download or clone** the Mocxy repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the Mocxy folder (the directory containing `manifest.json`)
6. The Mocxy icon will appear in your Chrome extensions toolbar

### Mock Server (Optional)

The mock server is a standalone Node.js application located in the `mock-server/` folder.

1. Navigate to the mock server directory:
   ```bash
   cd mock-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```
   
   The server will start on:
   - **HTTP**: `http://localhost:5000`
   - **HTTPS**: `https://localhost:5443`
   - **Admin UI**: `http://localhost:5000/mocxy/admin`

4. (Optional) Use custom port:
   ```bash
   PORT=3000 npm start
   ```

---

## Getting Started

### Quick Start (5 Minutes)

1. **Install the extension** (see Installation above)
2. **Click the Mocxy icon** in your toolbar
3. **Toggle the extension ON** (green indicator)
4. **Click "Options"** to open the full management interface
5. **Create your first rule**:
   - Click **"Add Rule"**
   - Name: `Redirect API to Localhost`
   - URL Condition: `contains` → `/api/`
   - Action: `Redirect` → Target Host: `localhost:3000`
   - Click **Save**
6. **Navigate to your application** and observe intercepted requests in the DevTools Network tab

---

## Core Concepts

### Rules

**Rules** define how Mocxy intercepts and modifies network requests. Each rule consists of:

- **Conditions**: When should this rule apply? (URL patterns, headers, HTTP methods)
- **Actions**: What should happen? (redirect, mock, modify headers, add delay)
- **Priority**: Rules are evaluated in order; higher priority = evaluated first

### Mock Collections

**Mock Collections** are groups of related mock responses that can be activated/deactivated together. Useful for:
- Testing different API scenarios (success, error, edge cases)
- Switching between different data sets
- Organizing mocks by feature or endpoint

### Inline vs Server-Backed Mocking

- **Inline Mocking**: The extension returns the mock response directly (no network call)
- **Server-Backed Mocking**: Requests are routed to the Mocxy mock server for advanced matching and dynamic responses

---

## Features Overview

### 🎯 Routing Rules

- **URL Matching**: 
  - Exact match
  - Contains substring
  - Regex patterns
  - Glob patterns (`*.example.com/api/*`)
  
- **Header Matching**: Match requests by header name and value

- **Method Filtering**: Apply rules only to specific HTTP methods (GET, POST, PUT, DELETE, etc.)

- **Actions**:
  - **Redirect**: Change the hostname while preserving path and query parameters
  - **Rewrite**: Use regex find-and-replace on the URL path
  - **Modify Headers**: Add, remove, or modify request/response headers
  - **Mock (Inline)**: Return a configured response directly
  - **Mock (Server)**: Route to the Mocxy mock server
  - **Delay**: Add artificial latency to responses

- **Rule Management**:
  - Drag-to-reorder for priority control
  - Enable/disable individual rules
  - Duplicate rules for quick variations

### 📝 Response Mocking

- **Inline Mocking**: Configure status code, headers, and body directly in the extension
- **Server-Backed Mocking**: Advanced request matching with the Mocxy mock server
- **Mock Collections**: Group and manage related mocks
- **JSON Editor**: Syntax highlighting, formatting, validation
- **File Import**: Load mock responses from JSON files

### 📊 Request Logging

- **Live Request Log**: See all intercepted requests in real-time
- **Detailed View**: Inspect request/response headers and bodies
- **Filtering**: Filter by URL, method, status code, or intercepted-only
- **Export**: Export logs as JSON for analysis or sharing

### 🔄 Import/Export

- **Full Configuration Export**: Export all rules, mocks, and settings as JSON
- **Import Modes**:
  - **Replace All**: Clear existing configuration and import new
  - **Merge**: Add imported rules to existing configuration
- **Team Sharing**: Share configuration files with team members

---

## Creating Routing Rules

### Example 1: Redirect Production API to Staging

**Use Case**: Test against staging data without changing application code.

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `Production to Staging`
   - **Enabled**: ✓
   - **URL Condition**: `contains` → `api.production.com`
   - **Action**: `Redirect`
     - **Target Host**: `api.staging.com`
3. Click **Save**

**Result**: All requests to `https://api.production.com/users` → `https://api.staging.com/users`

---

### Example 2: Redirect to Local Development Server

**Use Case**: Develop against local backend while using production frontend.

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `API to Localhost`
   - **URL Condition**: `contains` → `/api/v1/`
   - **Action**: `Redirect`
     - **Target Host**: `localhost:8080`
3. Click **Save**

**Result**: `https://app.example.com/api/v1/users` → `http://localhost:8080/api/v1/users`

---

### Example 3: Rewrite URL Path

**Use Case**: Change API version in URLs.

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `API v1 to v2`
   - **URL Condition**: `contains` → `/api/v1/`
   - **Action**: `Rewrite`
     - **Find (Regex)**: `/api/v1/`
     - **Replace**: `/api/v2/`
3. Click **Save**

**Result**: `/api/v1/users` → `/api/v2/users`

---

### Example 4: Add Custom Headers

**Use Case**: Add authentication headers for testing.

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `Add Auth Header`
   - **URL Condition**: `contains` → `/api/`
   - **Action**: `Modify Headers`
     - **Request Headers**:
       - Add: `Authorization` → `Bearer test-token-12345`
       - Add: `X-Test-Mode` → `true`
3. Click **Save**

---

### Example 5: Add Artificial Delay

**Use Case**: Test slow network conditions.

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `Slow API Response`
   - **URL Condition**: `contains` → `/api/users`
   - **Action**: `Delay`
     - **Delay (ms)**: `3000`
3. Click **Save**

**Result**: All matching requests will have a 3-second delay added.

---

## Response Mocking

### Inline Mocking

**Use Case**: Return a mock response without making a network call.

#### Example: Mock User Profile API

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `Mock User Profile`
   - **URL Condition**: `equals` → `https://api.example.com/api/users/me`
   - **Method Filter**: `GET`
   - **Action**: `Mock (Inline)`
     - **Status Code**: `200`
     - **Headers**:
       ```json
       {
         "Content-Type": "application/json",
         "X-Mock": "true"
       }
       ```
     - **Body**:
       ```json
       {
         "id": 12345,
         "username": "testuser",
         "email": "test@example.com",
         "role": "admin",
         "createdAt": "2024-01-15T10:30:00Z"
       }
       ```
3. Click **Save**

**Result**: Requests to `/api/users/me` return the mock data instantly.

---

#### Example: Mock Error Response

1. Click **"Add Rule"**
2. Configure:
   - **Name**: `Mock 500 Error`
   - **URL Condition**: `contains` → `/api/submit`
   - **Action**: `Mock (Inline)`
     - **Status Code**: `500`
     - **Body**:
       ```json
       {
         "error": "Internal Server Error",
         "message": "Database connection failed",
         "code": "DB_ERROR"
       }
       ```
3. Click **Save**

**Use Case**: Test error handling in your application.

---

### Mock Collections

**Use Case**: Group related mocks and switch between scenarios.

#### Creating a Mock Collection

1. Navigate to **"Mock Collections"** tab
2. Click **"New Collection"**
3. Configure:
   - **Name**: `User API - Happy Path`
   - **Description**: `All user endpoints return success`
4. Click **"Add Mock"**:
   - **URL Pattern**: `*/api/users`
   - **Method**: `GET`
   - **Response**:
     ```json
     {
       "users": [
         {"id": 1, "name": "Alice"},
         {"id": 2, "name": "Bob"}
       ]
     }
     ```
5. Add more mocks to the collection
6. Click **"Activate Collection"**

**Result**: All mocks in the collection are active. Deactivate to disable them all at once.

---

## Mock Server Setup

The Mocxy mock server is a standalone Node.js application with WireMock-level request matching capabilities.

### Starting the Mock Server

```bash
cd mock-server
npm install
npm start
```

Server endpoints:
- **Admin UI**: `http://localhost:5000/mocxy/admin`
- **Health Check**: `http://localhost:5000/mocxy/admin/health`
- **Mock Endpoint**: `http://localhost:5000/*` (catches all other requests)

### Using Server-Backed Mocking

1. **Start the mock server** (see above)
2. **Create a rule in Mocxy**:
   - **Name**: `Route to Mock Server`
   - **URL Condition**: `contains` → `/api/products`
   - **Action**: `Mock (Server)`
     - **Server URL**: `http://localhost:5000`
3. **Configure mocks in the mock server** via the Admin UI at `http://localhost:5000/mocxy/admin`

### Mock Server Features

- **Advanced Request Matching**: Match by URL, headers, body content, query parameters
- **Dynamic Responses**: Use templates and variables in responses
- **Request Recording**: Capture real requests and convert to mocks
- **OpenAPI Support**: Import OpenAPI specs to generate mocks
- **Collections**: Organize mocks by feature or scenario
- **AI-Powered Mock Generation**: Generate mocks from natural language descriptions
- **HTTPS Support**: Built-in self-signed certificate for HTTPS testing

### Mock Server Admin UI

Access the admin interface at `http://localhost:5000/mocxy/admin` to:
- Create and manage mock stubs
- View request logs
- Import/export mock collections
- Configure AI-powered mock generation
- Import OpenAPI specifications

---

## Request Logging

### Viewing Request Logs

1. Open Mocxy **Options** page
2. Navigate to **"Request Log"** tab
3. View all intercepted requests with:
   - URL
   - HTTP method
   - Status code
   - Duration
   - Matched rule (if any)

### Filtering Logs

Use the filter bar to narrow down requests:
- **URL Filter**: Enter text to filter by URL
- **Method**: Select specific HTTP methods
- **Status Code**: Filter by response status
- **Intercepted Only**: Show only requests modified by Mocxy

### Inspecting Request Details

Click on any request to expand and view:
- **Request Headers**
- **Request Body** (for POST/PUT/PATCH)
- **Response Headers**
- **Response Body**
- **Timing Information**

### Exporting Logs

1. Click **"Export Logs"**
2. Choose date range or export all
3. Download as JSON file

**Use Case**: Share logs with team members, analyze patterns, debug issues.

---

## Import/Export

### Exporting Configuration

1. Open Mocxy **Options** page
2. Navigate to **"Import/Export"** tab
3. Click **"Export Configuration"**
4. Save the JSON file

**Exported data includes**:
- All routing rules
- Mock collections
- Extension settings

### Importing Configuration

1. Open Mocxy **Options** page
2. Navigate to **"Import/Export"** tab
3. Click **"Import Configuration"**
4. Select import mode:
   - **Replace All**: Clears existing configuration
   - **Merge**: Adds to existing configuration
5. Choose JSON file
6. Click **Import**

**Use Case**: Share configurations with team members, backup/restore settings, switch between test scenarios.

---

## Use Cases & Examples

### Use Case 1: Frontend Development with Local Backend

**Scenario**: You're developing a React app that calls a backend API. You want to run the frontend against your local backend.

**Solution**:
1. Create a redirect rule:
   - URL: `contains` → `api.production.com`
   - Action: Redirect → `localhost:8000`
2. Run your local backend on port 8000
3. Access the production frontend—all API calls go to localhost

---

### Use Case 2: Testing Error Scenarios

**Scenario**: You need to test how your app handles various error responses.

**Solution**:
1. Create a mock collection: `Error Scenarios`
2. Add mocks for different errors:
   - 400 Bad Request
   - 401 Unauthorized
   - 403 Forbidden
   - 500 Internal Server Error
   - Network timeout
3. Activate the collection when testing error handling
4. Deactivate when done

---

### Use Case 3: API Version Migration Testing

**Scenario**: Your API is migrating from v1 to v2. You want to test the frontend with v2 endpoints.

**Solution**:
1. Create a rewrite rule:
   - URL: `contains` → `/api/v1/`
   - Action: Rewrite → Find: `/v1/`, Replace: `/v2/`
2. Test the frontend without changing code
3. Identify breaking changes

---

### Use Case 4: Performance Testing

**Scenario**: Test how your app performs under slow network conditions.

**Solution**:
1. Create delay rules for different endpoints:
   - `/api/users` → 2000ms delay
   - `/api/products` → 5000ms delay
   - `/api/images/*` → 3000ms delay
2. Test loading states, timeouts, user experience

---

### Use Case 5: Cross-Origin Testing

**Scenario**: Test CORS handling by adding/modifying CORS headers.

**Solution**:
1. Create a header modification rule:
   - URL: `contains` → `/api/`
   - Action: Modify Headers
     - Response Headers:
       - Add: `Access-Control-Allow-Origin` → `*`
       - Add: `Access-Control-Allow-Methods` → `GET, POST, PUT, DELETE`

---

### Use Case 6: Feature Flag Testing

**Scenario**: Test features behind feature flags without backend changes.

**Solution**:
1. Mock the feature flag endpoint:
   - URL: `equals` → `https://api.example.com/api/features`
   - Response:
     ```json
     {
       "newDashboard": true,
       "betaFeatures": true,
       "experimentalUI": false
     }
     ```
2. Toggle features by editing the mock response

---

## Architecture

### High-Level Overview

```
┌─────────────────┐
│  Popup UI       │  Quick toggle, status
└────────┬────────┘
         │
┌────────▼────────┐
│  Options UI     │  Full rule management, mocking, logging
└────────┬────────┘
         │
┌────────▼────────────────────────────────────────┐
│  Service Worker (sw.js)                         │
│  - Rule storage & management                    │
│  - Message routing                              │
│  - chrome.declarativeNetRequest sync            │
└────────┬────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────┐
│  Content Script (content-script.js)             │
│  - Bridge between ISOLATED and MAIN world       │
└────────┬────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────┐
│  Interceptor (interceptor-inject.js)            │
│  - Injected into MAIN world                     │
│  - Overrides fetch() and XMLHttpRequest         │
│  - Evaluates rules and applies actions          │
└────────┬────────────────────────────────────────┘
         │
         ▼
    Network Request
         │
         ├─→ Redirected to different host
         ├─→ Mocked inline (no network call)
         ├─→ Routed to Mock Server
         └─→ Modified headers/delayed
```

### Component Details

#### Service Worker (`service-worker/sw.js`)
- Manages rule storage using `chrome.storage.local` and IndexedDB
- Handles messages from popup, options page, and content scripts
- Syncs simple redirect rules to `chrome.declarativeNetRequest` for performance
- Broadcasts rule updates to all active tabs

#### Content Script (`content/content-script.js`)
- Runs in ISOLATED world (has access to Chrome APIs)
- Injects `interceptor-inject.js` into the MAIN world
- Bridges communication between MAIN world and service worker
- Receives rule updates and forwards to interceptor

#### Interceptor (`content/interceptor-inject.js`)
- Runs in MAIN world (has access to page's fetch/XHR)
- Overrides `window.fetch()` and `XMLHttpRequest`
- Evaluates rules against each request
- Applies actions (redirect, mock, modify headers, delay)
- Logs requests for the Request Log feature

#### Mock Server (`mock-server/server.js`)
- Standalone Node.js Express server
- Provides advanced request matching (WireMock-level)
- Supports dynamic responses, templates, collections
- Admin UI for mock management
- Optional HTTPS support

---

## Troubleshooting

### Extension Not Intercepting Requests

**Symptoms**: Rules are created but requests are not being intercepted.

**Solutions**:
1. **Check extension is enabled**: Click the Mocxy icon—should show green indicator
2. **Refresh the page**: After creating/modifying rules, refresh the target page
3. **Check console**: Open DevTools Console, look for `[Mocxy] Interceptor injected`
4. **Verify URL pattern**: Ensure the URL condition matches the actual request URL
5. **Check rule priority**: Higher priority rules are evaluated first

---

### Mock Server Not Responding

**Symptoms**: Server-backed mocks return errors or timeouts.

**Solutions**:
1. **Verify server is running**:
   ```bash
   curl http://localhost:5000/mocxy/admin/health
   ```
   Should return: `{"status": "ok"}`

2. **Check server logs**: Look for errors in the terminal where you ran `npm start`

3. **Verify port**: Ensure the server is running on the expected port (default: 5000)

4. **Check firewall**: Ensure localhost connections are allowed

---

### Rules Not Matching

**Symptoms**: Rule is enabled but not matching requests.

**Solutions**:
1. **Check URL pattern type**:
   - `equals`: Must match exactly
   - `contains`: Substring match
   - `regex`: Must be valid regex pattern
   - `glob`: Must be valid glob pattern

2. **Check method filter**: If set, request method must match

3. **Check header conditions**: If set, request headers must match

4. **View Request Log**: Check what URL is actually being requested

---

### CORS Errors with Mock Server

**Symptoms**: Browser shows CORS errors when using mock server.

**Solutions**:
1. Mock server has CORS enabled by default
2. Ensure you're using the correct server URL in the rule
3. Check that the mock server is running on HTTP (not HTTPS) unless configured otherwise

---

### Performance Issues

**Symptoms**: Page loads slowly with Mocxy enabled.

**Solutions**:
1. **Disable unused rules**: Only keep active rules enabled
2. **Use simple patterns**: `contains` is faster than complex regex
3. **Limit request logging**: Clear old logs periodically
4. **Use declarativeNetRequest**: Simple redirects are handled by Chrome's native API (faster)

---

### Import/Export Issues

**Symptoms**: Cannot import configuration file.

**Solutions**:
1. **Verify JSON format**: Ensure the file is valid JSON
2. **Check file version**: Older exports may not be compatible
3. **Try "Merge" mode**: If "Replace All" fails, try merging instead

---

## Advanced Tips

### Combining Multiple Actions

You can chain rules to apply multiple transformations:
1. **Rule 1** (Priority 1): Redirect `api.prod.com` → `api.staging.com`
2. **Rule 2** (Priority 2): Add auth header to `api.staging.com`
3. **Rule 3** (Priority 3): Add 1s delay to `api.staging.com`

### Using Regex for Complex Patterns

Example: Match all API endpoints except health checks:
- Pattern: `^https://api\.example\.com/(?!health).*`

### Dynamic Mocks with Mock Server

Use the mock server's template system for dynamic responses:
- Request: `GET /api/users/123`
- Response template: `{"id": {{request.pathParams.id}}, "name": "User {{request.pathParams.id}}"}`

### Keyboard Shortcuts

- **Options Page**:
  - `Ctrl/Cmd + S`: Save current rule
  - `Ctrl/Cmd + N`: New rule
  - `Ctrl/Cmd + F`: Focus search/filter

---

## File Structure

```
mocxy/
├── manifest.json                 # Chrome extension manifest
├── service-worker/
│   ├── sw.js                    # Main service worker
│   ├── rule-engine.js           # Rule matching logic
│   ├── storage-manager.js       # Storage abstraction
│   ├── dnr-manager.js           # declarativeNetRequest sync
│   └── message-router.js        # Message handling
├── content/
│   ├── content-script.js        # ISOLATED world bridge
│   └── interceptor-inject.js    # MAIN world fetch/XHR override
├── popup/
│   ├── popup.html               # Extension popup UI
│   ├── popup.css
│   └── popup.js
├── options/
│   ├── options.html             # Full management interface
│   ├── options.css
│   ├── options.js
│   └── components/
│       ├── rule-list.js         # Rule list with drag-to-reorder
│       ├── rule-form.js         # Rule creation/editing form
│       ├── mock-editor.js       # JSON mock editor
│       ├── request-log.js       # Request logging viewer
│       ├── import-export.js     # Configuration import/export
│       └── settings-panel.js    # Global settings
├── shared/
│   ├── constants.js             # Shared constants
│   ├── data-models.js           # Data structure definitions
│   └── utils.js                 # Utility functions
├── lib/
│   └── json-highlight.js        # JSON syntax highlighter
├── icons/
│   └── icon{16,32,48,128}.png  # Extension icons
├── mock-server/                 # Standalone mock server
│   ├── server.js               # Express server
│   ├── matcher.js              # Request matching engine
│   ├── store.js                # Mock storage
│   ├── collection-store.js     # Collection management
│   ├── ai.js                   # AI-powered mock generation
│   ├── openapi-parser.js       # OpenAPI spec parser
│   ├── package.json
│   └── ui/                     # Admin UI
└── README.md                    # This file
```

---

## Support & Contributing

- **Issues**: Report bugs or request features via GitHub Issues
- **Documentation**: This README is the primary documentation
- **License**: MIT

---

## Summary

Mocxy is a comprehensive solution for API interception and mocking during development and testing. Whether you need simple redirects, complex mock scenarios, or detailed request logging, Mocxy provides the tools to streamline your workflow without modifying application code.

**Key Benefits**:
- ✅ No code changes required
- ✅ Works with any web application
- ✅ Powerful rule engine with multiple matching strategies
- ✅ Inline and server-backed mocking
- ✅ Request logging and inspection
- ✅ Team collaboration via import/export
- ✅ Self-contained mock server with advanced features

Get started in minutes and take control of your API testing workflow!
