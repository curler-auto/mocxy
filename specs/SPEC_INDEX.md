# Neuron Interceptor — Feature Specs for Autonomous Development

## How To Use This Directory

Each `.md` file in this directory is a **self-contained feature spec**. Any Claude Code session can:
1. Read `SPEC_INDEX.md` (this file) to see what needs building
2. Pick the next `NOT STARTED` feature in priority order
3. Read that feature's spec file for full implementation details
4. Implement it end-to-end
5. Update the status in this index to `DONE`

## Architecture Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Tech**: Chrome Extension MV3, vanilla JS (ES modules), no build step
- **Existing files**: manifest.json, service-worker/ (5 files), content/ (2 files), popup/ (3 files), options/ (9 files), shared/ (3 files), lib/ (1 file)
- **Theme**: Dark (Catppuccin Mocha palette), CSS variables in options.css
- **Messaging**: chrome.runtime.sendMessage with MSG_TYPES from shared/constants.js
- **Storage**: chrome.storage.local for rules/settings, IndexedDB for logs/mock bodies
- **Interception**: Dual layer — DNR (fast-path redirects) + fetch/XHR override (interceptor-inject.js)

## Feature Queue (Priority Order)

### Phase 1: Plugin Polish (Do First)
| # | Feature | Spec File | Status | Depends On |
|---|---------|-----------|--------|------------|
| 1.1 | Rule Templates | `01-rule-templates.md` | NOT STARTED | — |
| 1.2 | Keyboard Shortcuts | `02-keyboard-shortcuts.md` | NOT STARTED | — |
| 1.3 | Quick Mock from Log | `03-quick-mock-from-log.md` | NOT STARTED | — |
| 1.4 | Test Rule Dry-Run | `04-test-rule-dry-run.md` | NOT STARTED | — |
| 1.5 | GraphQL Operation Matching | `05-graphql-matching.md` | NOT STARTED | — |
| 1.6 | Request Body Matching | `06-request-body-matching.md` | NOT STARTED | — |
| 1.7 | Response Body Patching | `07-response-body-patching.md` | NOT STARTED | — |
| 1.8 | Script & CSS Injection | `08-script-css-injection.md` | NOT STARTED | — |
| 1.9 | Bandwidth Throttling | `09-bandwidth-throttling.md` | NOT STARTED | — |

### Phase 2: Test Automation (Differentiator)
| # | Feature | Spec File | Status | Depends On |
|---|---------|-----------|--------|------------|
| 2.1 | Record Session & Export | `10-record-export.md` | NOT STARTED | — |
| 2.2 | Playwright Bridge | `11-playwright-bridge.md` | NOT STARTED | 2.1 |
| 2.3 | CLI Tool | `12-cli-tool.md` | NOT STARTED | 2.1, 2.2 |

### Phase 3: Backend + SaaS
| # | Feature | Spec File | Status | Depends On |
|---|---------|-----------|--------|------------|
| 3.1 | Backend API Server | `13-backend-api.md` | NOT STARTED | — |
| 3.2 | Auth System | `14-auth-system.md` | NOT STARTED | 3.1 |
| 3.3 | Extension ↔ Backend Sync | `15-extension-sync.md` | NOT STARTED | 3.1, 3.2 |
| 3.4 | Team Workspaces | `16-team-workspaces.md` | NOT STARTED | 3.2, 3.3 |
| 3.5 | Stripe Billing | `17-stripe-billing.md` | NOT STARTED | 3.2 |
| 3.6 | Landing Page | `18-landing-page.md` | NOT STARTED | — |

### Phase 4: Enterprise
| # | Feature | Spec File | Status | Depends On |
|---|---------|-----------|--------|------------|
| 4.1 | On-Prem Docker Package | `19-onprem-docker.md` | NOT STARTED | 3.1 |
| 4.2 | License Server | `20-license-server.md` | NOT STARTED | 3.1 |
| 4.3 | SSO (LDAP/SAML) | `21-sso-adapter.md` | NOT STARTED | 3.2 |
| 4.4 | Audit Logging | `22-audit-logging.md` | NOT STARTED | 3.1 |
| 4.5 | Desktop App (Electron) | `23-desktop-app.md` | NOT STARTED | — |
| 4.6 | Session Recording | `24-session-recording.md` | NOT STARTED | — |

## Conventions

- **New files**: Create in the plugin directory structure. Never overwrite existing files without reading them first.
- **Constants**: Add new constants to `shared/constants.js`
- **Data models**: Add new factory functions to `shared/data-models.js`
- **Message types**: Add new MSG_TYPES to `shared/constants.js`, handle in `service-worker/message-router.js`
- **Options UI components**: Add to `options/components/`, import in `options/options.js`
- **CSS**: Use existing CSS variables from `options/options.css`, scope new styles with component prefix
- **Testing**: After implementing, describe manual test steps at the bottom of each spec
