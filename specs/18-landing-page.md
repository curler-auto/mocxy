# Feature 3.6: Marketing Landing Page

## Summary

Build a single-page marketing site for the Neuron Interceptor Chrome Extension. No framework, no build step -- just `index.html`, `style.css`, and `script.js`. Dark theme using the same Catppuccin Mocha palette as the extension. Responsive, modern, and designed to drive installs and paid conversions.

## Why

A landing page is essential for:
- Chrome Web Store listing link destination
- SEO for organic discovery
- Communicating the value proposition to developers
- Driving free installs and paid plan conversions
- Establishing credibility as a professional tool

## Dependencies

None. This is a standalone static site that can be built and deployed independently.

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Landing page location**: `health_check/utils/neuron-interceptor-plugin/landing/`
- **Theme**: Catppuccin Mocha palette:
  - `--bg-base: #1e1e2e` (page background)
  - `--bg-surface: #313244` (card backgrounds)
  - `--bg-overlay: #181825` (darker sections)
  - `--text: #cdd6f4` (primary text)
  - `--text-muted: #a6adc8` (secondary text)
  - `--text-subtle: #6c7086` (subtle text)
  - `--accent: #89b4fa` (blue, primary CTA)
  - `--accent-green: #a6e3a1` (green, positive)
  - `--accent-red: #f38ba8` (red, danger)
  - `--accent-yellow: #f9e2af` (yellow, warning)
  - `--accent-peach: #fab387` (peach, highlight)
  - `--accent-lavender: #b4befe` (lavender, secondary)
  - `--border: #45475a` (borders)
  - `--surface-hover: #3b3f58` (hover state)

## Directory Structure

```
landing/
  index.html
  style.css
  script.js
```

## Implementation

### `landing/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Neuron Interceptor - API Interception, Mocking & Testing for Developers</title>
  <meta name="description" content="Chrome extension for API interception, response mocking, request routing, and test automation. Free and open source.">
  <meta name="keywords" content="API interceptor, Chrome extension, response mocking, request proxy, developer tools, test automation">
  <meta property="og:title" content="Neuron Interceptor">
  <meta property="og:description" content="Intercept. Mock. Test. Ship faster with the developer-first API interception tool.">
  <meta property="og:type" content="website">
  <link rel="stylesheet" href="style.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body>

  <!-- ===================================================================== -->
  <!--  Navigation                                                            -->
  <!-- ===================================================================== -->

  <nav class="nav" id="nav">
    <div class="nav-inner container">
      <a href="#" class="nav-brand">
        <span class="nav-logo">N</span>
        <span class="nav-brand-text">Neuron Interceptor</span>
      </a>
      <div class="nav-links" id="navLinks">
        <a href="#features" class="nav-link">Features</a>
        <a href="#compare" class="nav-link">Compare</a>
        <a href="#how-it-works" class="nav-link">How It Works</a>
        <a href="#pricing" class="nav-link">Pricing</a>
      </div>
      <div class="nav-actions">
        <a href="#pricing" class="nav-cta-link">Pricing</a>
        <a href="#" class="btn btn-primary btn-sm" id="navInstallBtn">Install Free</a>
      </div>
      <button class="nav-hamburger" id="navHamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>

  <!-- ===================================================================== -->
  <!--  Hero Section                                                          -->
  <!-- ===================================================================== -->

  <section class="hero" id="hero">
    <div class="container">
      <div class="hero-content">
        <div class="hero-badge">Open Source Chrome Extension</div>
        <h1 class="hero-title">
          Intercept.<br>
          <span class="hero-title-accent">Mock.</span><br>
          Test. Ship.
        </h1>
        <p class="hero-subtitle">
          The developer-first Chrome extension for API interception, response mocking,
          URL routing, and test automation. No proxy setup. No config files.
          Just install and go.
        </p>
        <div class="hero-cta-row">
          <a href="#" class="btn btn-primary btn-lg" id="heroInstallBtn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>
            Install Free
          </a>
          <a href="#" class="btn btn-secondary btn-lg" id="heroGithubBtn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .321.216.694.825.576C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z"/></svg>
            View on GitHub
          </a>
        </div>
        <div class="hero-stats">
          <div class="hero-stat">
            <span class="hero-stat-value">6</span>
            <span class="hero-stat-label">Action Types</span>
          </div>
          <div class="hero-stat-divider"></div>
          <div class="hero-stat">
            <span class="hero-stat-value">MV3</span>
            <span class="hero-stat-label">Manifest V3</span>
          </div>
          <div class="hero-stat-divider"></div>
          <div class="hero-stat">
            <span class="hero-stat-value">0</span>
            <span class="hero-stat-label">Dependencies</span>
          </div>
        </div>
      </div>
      <div class="hero-visual">
        <div class="hero-mockup">
          <div class="mockup-toolbar">
            <span class="mockup-dot red"></span>
            <span class="mockup-dot yellow"></span>
            <span class="mockup-dot green"></span>
            <span class="mockup-title">Neuron Interceptor</span>
          </div>
          <div class="mockup-body">
            <div class="mockup-rule">
              <span class="mockup-badge mockup-badge-redirect">redirect</span>
              <span class="mockup-rule-name">API to Staging</span>
              <span class="mockup-rule-url">/api/* -> staging.app.com</span>
            </div>
            <div class="mockup-rule">
              <span class="mockup-badge mockup-badge-mock">mock</span>
              <span class="mockup-rule-name">Mock User Profile</span>
              <span class="mockup-rule-url">/api/user/profile -> 200 JSON</span>
            </div>
            <div class="mockup-rule">
              <span class="mockup-badge mockup-badge-delay">delay</span>
              <span class="mockup-rule-name">Slow Network</span>
              <span class="mockup-rule-url">/api/* -> +2000ms</span>
            </div>
            <div class="mockup-rule">
              <span class="mockup-badge mockup-badge-headers">headers</span>
              <span class="mockup-rule-name">Add Auth Token</span>
              <span class="mockup-rule-url">Authorization: Bearer xxx</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  Features Section                                                      -->
  <!-- ===================================================================== -->

  <section class="features" id="features">
    <div class="container">
      <div class="section-header">
        <h2 class="section-title">Everything You Need to Control the Network</h2>
        <p class="section-subtitle">Six powerful capabilities in one lightweight extension</p>
      </div>
      <div class="features-grid">

        <div class="feature-card" data-reveal>
          <div class="feature-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </div>
          <h3 class="feature-title">Routing Rules</h3>
          <p class="feature-desc">Redirect API calls between environments. Route production traffic to staging, localhost, or any custom host. Supports URL patterns, regex, and glob matching.</p>
        </div>

        <div class="feature-card" data-reveal>
          <div class="feature-icon feature-icon-yellow">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <h3 class="feature-title">Response Mocking</h3>
          <p class="feature-desc">Return custom JSON responses without touching your backend. Mock inline with status codes and headers, or use a mock server proxy for complex scenarios.</p>
        </div>

        <div class="feature-card" data-reveal>
          <div class="feature-icon feature-icon-green">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          </div>
          <h3 class="feature-title">Request Logging</h3>
          <p class="feature-desc">Live request/response log with full headers, body, timing, and matched-rule tagging. Filter by URL, method, status code, or interception status.</p>
        </div>

        <div class="feature-card" data-reveal>
          <div class="feature-icon feature-icon-peach">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <h3 class="feature-title">Test Automation</h3>
          <p class="feature-desc">Record API sessions, export as Playwright or Cypress fixtures, and replay with the CLI. Bridge extension rules directly into your E2E test harness.</p>
        </div>

        <div class="feature-card" data-reveal>
          <div class="feature-icon feature-icon-lavender">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <h3 class="feature-title">Team Collaboration</h3>
          <p class="feature-desc">Share rules and mock collections across your team with real-time sync. RBAC with owner, admin, editor, and viewer roles. Everything stays in sync via WebSocket.</p>
        </div>

        <div class="feature-card" data-reveal>
          <div class="feature-icon feature-icon-red">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </div>
          <h3 class="feature-title">On-Prem Deploy</h3>
          <p class="feature-desc">Air-gapped Docker package for enterprises that cannot use cloud services. Self-hosted backend, perpetual license, LDAP/SAML SSO, and audit logging.</p>
        </div>

      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  Comparison Section                                                    -->
  <!-- ===================================================================== -->

  <section class="compare" id="compare">
    <div class="container">
      <div class="section-header">
        <h2 class="section-title">How Neuron Compares</h2>
        <p class="section-subtitle">Purpose-built for browser-based API development</p>
      </div>
      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th class="compare-highlight">Neuron Interceptor</th>
              <th>Charles Proxy</th>
              <th>Requestly</th>
              <th>Fiddler</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Chrome Extension (no proxy)</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
            </tr>
            <tr>
              <td>Manifest V3 native</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td>N/A</td>
              <td><span class="check">&#10003;</span></td>
              <td>N/A</td>
            </tr>
            <tr>
              <td>Response mocking (inline)</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
            </tr>
            <tr>
              <td>URL redirect + rewrite</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
            </tr>
            <tr>
              <td>Header modification</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
            </tr>
            <tr>
              <td>Network throttling</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td><span class="check">&#10003;</span></td>
            </tr>
            <tr>
              <td>Test automation bridge</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td><span class="cross">&#10007;</span></td>
            </tr>
            <tr>
              <td>Team sync + RBAC</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
            </tr>
            <tr>
              <td>Self-hosted / on-prem</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td>N/A</td>
              <td><span class="cross">&#10007;</span></td>
              <td>Desktop</td>
            </tr>
            <tr>
              <td>Open source</td>
              <td class="compare-highlight"><span class="check">&#10003;</span></td>
              <td><span class="cross">&#10007;</span></td>
              <td>Partial</td>
              <td><span class="cross">&#10007;</span></td>
            </tr>
            <tr>
              <td>Price</td>
              <td class="compare-highlight"><strong>Free</strong></td>
              <td>$50</td>
              <td>Free / $10+</td>
              <td>Free / $12+</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  How It Works                                                          -->
  <!-- ===================================================================== -->

  <section class="how-it-works" id="how-it-works">
    <div class="container">
      <div class="section-header">
        <h2 class="section-title">Three Steps to Control Your Network</h2>
      </div>
      <div class="steps-grid">
        <div class="step-card" data-reveal>
          <div class="step-number">1</div>
          <h3 class="step-title">Install</h3>
          <p class="step-desc">Add the extension from the Chrome Web Store. No proxy setup, no certificates, no config files. Works immediately.</p>
        </div>
        <div class="step-arrow" data-reveal>
          <svg width="40" height="20" viewBox="0 0 40 20" fill="none" stroke="#45475a" stroke-width="2"><line x1="0" y1="10" x2="36" y2="10"/><polyline points="30,4 36,10 30,16"/></svg>
        </div>
        <div class="step-card" data-reveal>
          <div class="step-number">2</div>
          <h3 class="step-title">Configure Rules</h3>
          <p class="step-desc">Create interception rules: redirect URLs, mock responses, modify headers, add delays. Use templates or build from scratch.</p>
        </div>
        <div class="step-arrow" data-reveal>
          <svg width="40" height="20" viewBox="0 0 40 20" fill="none" stroke="#45475a" stroke-width="2"><line x1="0" y1="10" x2="36" y2="10"/><polyline points="30,4 36,10 30,16"/></svg>
        </div>
        <div class="step-card" data-reveal>
          <div class="step-number">3</div>
          <h3 class="step-title">Intercept</h3>
          <p class="step-desc">Browse normally. Matching requests are intercepted, modified, and logged in real-time. Toggle rules on/off instantly.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  Pricing Section                                                       -->
  <!-- ===================================================================== -->

  <section class="pricing" id="pricing">
    <div class="container">
      <div class="section-header">
        <h2 class="section-title">Simple, Developer-Friendly Pricing</h2>
        <p class="section-subtitle">Start free. Upgrade when your team needs cloud features.</p>
      </div>
      <div class="pricing-grid">

        <div class="pricing-card" data-reveal>
          <div class="pricing-header">
            <h3 class="pricing-plan-name">Free</h3>
            <div class="pricing-price">
              <span class="pricing-amount">$0</span>
              <span class="pricing-period">forever</span>
            </div>
          </div>
          <ul class="pricing-features">
            <li><span class="check">&#10003;</span> 5 interception rules</li>
            <li><span class="check">&#10003;</span> 3 mock collections</li>
            <li><span class="check">&#10003;</span> 1 workspace (personal)</li>
            <li><span class="check">&#10003;</span> Request logging (24h)</li>
            <li><span class="check">&#10003;</span> Import / Export</li>
            <li><span class="check">&#10003;</span> All 6 action types</li>
            <li class="pricing-feature-disabled"><span class="cross">&#10007;</span> Cloud sync</li>
            <li class="pricing-feature-disabled"><span class="cross">&#10007;</span> Team members</li>
          </ul>
          <a href="#" class="btn btn-secondary btn-block">Install Free</a>
        </div>

        <div class="pricing-card pricing-card-popular" data-reveal>
          <div class="pricing-popular-badge">Most Popular</div>
          <div class="pricing-header">
            <h3 class="pricing-plan-name">Pro</h3>
            <div class="pricing-price">
              <span class="pricing-amount">$12</span>
              <span class="pricing-period">/ month</span>
            </div>
          </div>
          <ul class="pricing-features">
            <li><span class="check">&#10003;</span> Unlimited rules</li>
            <li><span class="check">&#10003;</span> Unlimited mock collections</li>
            <li><span class="check">&#10003;</span> 3 workspaces</li>
            <li><span class="check">&#10003;</span> Cloud sync across devices</li>
            <li><span class="check">&#10003;</span> Request logging (7 days)</li>
            <li><span class="check">&#10003;</span> Import / Export</li>
            <li><span class="check">&#10003;</span> All 6 action types</li>
            <li class="pricing-feature-disabled"><span class="cross">&#10007;</span> Team RBAC</li>
          </ul>
          <a href="#" class="btn btn-primary btn-block">Start Pro</a>
        </div>

        <div class="pricing-card" data-reveal>
          <div class="pricing-header">
            <h3 class="pricing-plan-name">Team</h3>
            <div class="pricing-price">
              <span class="pricing-amount">$29</span>
              <span class="pricing-period">/ seat / month</span>
            </div>
          </div>
          <ul class="pricing-features">
            <li><span class="check">&#10003;</span> Everything in Pro</li>
            <li><span class="check">&#10003;</span> Unlimited workspaces</li>
            <li><span class="check">&#10003;</span> Unlimited team members</li>
            <li><span class="check">&#10003;</span> RBAC (owner/admin/editor/viewer)</li>
            <li><span class="check">&#10003;</span> Request logging (30 days)</li>
            <li><span class="check">&#10003;</span> Priority support</li>
            <li><span class="check">&#10003;</span> SSO (SAML/LDAP) available</li>
            <li><span class="check">&#10003;</span> Audit logging</li>
          </ul>
          <a href="#" class="btn btn-secondary btn-block">Start Team</a>
        </div>

      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  Enterprise Section                                                    -->
  <!-- ===================================================================== -->

  <section class="enterprise" id="enterprise">
    <div class="container">
      <div class="enterprise-content">
        <h2 class="enterprise-title">Built for Enterprise</h2>
        <p class="enterprise-subtitle">Air-gapped. Self-hosted. Perpetual license.</p>
        <p class="enterprise-desc">
          Deploy the Neuron backend on your own infrastructure with Docker.
          No data ever leaves your network. LDAP/SAML SSO, audit logging,
          and dedicated support included.
        </p>
        <a href="mailto:sales@neuron-interceptor.dev" class="btn btn-primary btn-lg">Contact Sales</a>
      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!--  Footer                                                                -->
  <!-- ===================================================================== -->

  <footer class="footer" id="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <span class="nav-logo">N</span>
          <span class="footer-brand-text">Neuron Interceptor</span>
          <p class="footer-tagline">API interception for developers who ship fast.</p>
        </div>
        <div class="footer-col">
          <h4 class="footer-col-title">Product</h4>
          <a href="#features" class="footer-link">Features</a>
          <a href="#pricing" class="footer-link">Pricing</a>
          <a href="#" class="footer-link">Documentation</a>
          <a href="#" class="footer-link">Changelog</a>
        </div>
        <div class="footer-col">
          <h4 class="footer-col-title">Resources</h4>
          <a href="#" class="footer-link">GitHub</a>
          <a href="#" class="footer-link">Chrome Web Store</a>
          <a href="#" class="footer-link">API Reference</a>
          <a href="#" class="footer-link">Blog</a>
        </div>
        <div class="footer-col">
          <h4 class="footer-col-title">Company</h4>
          <a href="#" class="footer-link">About</a>
          <a href="#" class="footer-link">Contact</a>
          <a href="#" class="footer-link">Privacy Policy</a>
          <a href="#" class="footer-link">Terms of Service</a>
        </div>
      </div>
      <div class="footer-bottom">
        <p class="footer-copyright">Built with care for developers everywhere.</p>
      </div>
    </div>
  </footer>

  <script src="script.js"></script>
</body>
</html>
```

### `landing/style.css`

```css
/* ==========================================================================
   Neuron Interceptor — Landing Page
   Catppuccin Mocha Dark Theme
   ========================================================================== */

/* -------------------------------------------------------------------------- */
/*  Variables                                                                 */
/* -------------------------------------------------------------------------- */

:root {
  --bg-base:      #1e1e2e;
  --bg-surface:   #313244;
  --bg-overlay:   #181825;
  --text:         #cdd6f4;
  --text-muted:   #a6adc8;
  --text-subtle:  #6c7086;
  --accent:       #89b4fa;
  --accent-green: #a6e3a1;
  --accent-red:   #f38ba8;
  --accent-yellow:#f9e2af;
  --accent-peach: #fab387;
  --accent-lavender:#b4befe;
  --border:       #45475a;
  --surface-hover:#3b3f58;
  --font-sans:    'Inter', system-ui, -apple-system, sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
  --max-width:    1200px;
  --radius:       12px;
  --radius-sm:    6px;
}

/* -------------------------------------------------------------------------- */
/*  Reset                                                                     */
/* -------------------------------------------------------------------------- */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; scroll-padding-top: 80px; }

body {
  background: var(--bg-base);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

img { max-width: 100%; display: block; }

/* -------------------------------------------------------------------------- */
/*  Container                                                                 */
/* -------------------------------------------------------------------------- */

.container {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px;
}

/* -------------------------------------------------------------------------- */
/*  Navigation                                                                */
/* -------------------------------------------------------------------------- */

.nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: rgba(30, 30, 46, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
  transition: border-color 0.3s ease, background-color 0.3s ease;
}

.nav.scrolled {
  border-bottom-color: var(--border);
  background: rgba(30, 30, 46, 0.95);
}

.nav-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
}

.nav-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--bg-overlay);
  font-weight: 800;
  font-size: 18px;
}

.nav-brand-text {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.nav-links {
  display: flex;
  gap: 32px;
}

.nav-link {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s ease;
}

.nav-link:hover { color: var(--text); text-decoration: none; }

.nav-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.nav-cta-link {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
}

.nav-hamburger {
  display: none;
  flex-direction: column;
  gap: 5px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
}

.nav-hamburger span {
  width: 24px;
  height: 2px;
  background: var(--text-muted);
  border-radius: 1px;
  transition: transform 0.2s ease;
}

/* -------------------------------------------------------------------------- */
/*  Buttons                                                                   */
/* -------------------------------------------------------------------------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn-primary {
  background: var(--accent);
  color: var(--bg-overlay);
  border-color: var(--accent);
}
.btn-primary:hover {
  background: #9fc5fb;
  border-color: #9fc5fb;
  box-shadow: 0 0 20px rgba(137, 180, 250, 0.3);
  text-decoration: none;
}

.btn-secondary {
  background: transparent;
  color: var(--text);
  border-color: var(--border);
}
.btn-secondary:hover {
  background: var(--surface-hover);
  border-color: var(--text-subtle);
  text-decoration: none;
}

.btn-sm { padding: 7px 14px; font-size: 13px; }
.btn-lg { padding: 14px 28px; font-size: 16px; border-radius: var(--radius); }
.btn-block { width: 100%; }

/* -------------------------------------------------------------------------- */
/*  Hero                                                                      */
/* -------------------------------------------------------------------------- */

.hero {
  padding: 140px 0 80px;
  overflow: hidden;
}

.hero .container {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  align-items: center;
}

.hero-badge {
  display: inline-block;
  padding: 4px 14px;
  background: rgba(137, 180, 250, 0.1);
  border: 1px solid rgba(137, 180, 250, 0.2);
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 24px;
}

.hero-title {
  font-size: 56px;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.03em;
  color: var(--text);
  margin-bottom: 20px;
}

.hero-title-accent { color: var(--accent); }

.hero-subtitle {
  font-size: 18px;
  line-height: 1.7;
  color: var(--text-muted);
  margin-bottom: 32px;
  max-width: 520px;
}

.hero-cta-row {
  display: flex;
  gap: 16px;
  margin-bottom: 48px;
  flex-wrap: wrap;
}

.hero-stats {
  display: flex;
  align-items: center;
  gap: 24px;
}

.hero-stat { text-align: center; }
.hero-stat-value { display: block; font-size: 24px; font-weight: 800; color: var(--accent); font-variant-numeric: tabular-nums; }
.hero-stat-label { font-size: 12px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; }
.hero-stat-divider { width: 1px; height: 36px; background: var(--border); }

/* Hero Mockup */
.hero-mockup {
  background: var(--bg-overlay);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}

.mockup-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}

.mockup-dot { width: 12px; height: 12px; border-radius: 50%; }
.mockup-dot.red { background: #f38ba8; }
.mockup-dot.yellow { background: #f9e2af; }
.mockup-dot.green { background: #a6e3a1; }
.mockup-title { margin-left: 12px; font-size: 13px; font-weight: 600; color: var(--text-muted); }

.mockup-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; }

.mockup-rule {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.15s ease;
}
.mockup-rule:hover { border-color: var(--surface-hover); }

.mockup-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 10px;
  letter-spacing: 0.03em;
  flex-shrink: 0;
}
.mockup-badge-redirect { background: rgba(137,180,250,0.15); color: var(--accent); }
.mockup-badge-mock     { background: rgba(249,226,175,0.15); color: var(--accent-yellow); }
.mockup-badge-delay    { background: rgba(108,112,134,0.2);  color: var(--text-muted); }
.mockup-badge-headers  { background: rgba(166,227,161,0.15); color: var(--accent-green); }

.mockup-rule-name { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; }
.mockup-rule-url  { font-size: 12px; font-family: var(--font-mono); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* -------------------------------------------------------------------------- */
/*  Section Headers                                                           */
/* -------------------------------------------------------------------------- */

.section-header { text-align: center; margin-bottom: 56px; }
.section-title { font-size: 36px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 12px; }
.section-subtitle { font-size: 18px; color: var(--text-muted); }

/* -------------------------------------------------------------------------- */
/*  Features Grid                                                             */
/* -------------------------------------------------------------------------- */

.features { padding: 100px 0; }

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.feature-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.feature-card:hover { border-color: var(--accent); transform: translateY(-4px); }

.feature-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: rgba(137, 180, 250, 0.1);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.feature-icon-yellow { background: rgba(249,226,175,0.1); color: var(--accent-yellow); }
.feature-icon-green  { background: rgba(166,227,161,0.1); color: var(--accent-green); }
.feature-icon-peach  { background: rgba(250,179,135,0.1); color: var(--accent-peach); }
.feature-icon-lavender { background: rgba(180,190,254,0.1); color: var(--accent-lavender); }
.feature-icon-red    { background: rgba(243,139,168,0.1); color: var(--accent-red); }

.feature-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.feature-desc { font-size: 14px; color: var(--text-muted); line-height: 1.6; }

/* -------------------------------------------------------------------------- */
/*  Comparison Table                                                          */
/* -------------------------------------------------------------------------- */

.compare { padding: 100px 0; background: var(--bg-overlay); }

.compare-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }

.compare-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.compare-table th, .compare-table td { padding: 14px 20px; text-align: left; border-bottom: 1px solid var(--border); }
.compare-table th { background: var(--bg-surface); color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
.compare-table tbody tr:hover { background: var(--surface-hover); }
.compare-table td:first-child { font-weight: 500; color: var(--text); white-space: nowrap; }

.compare-highlight { background: rgba(137, 180, 250, 0.05) !important; }
th.compare-highlight { color: var(--accent) !important; }

.check { color: var(--accent-green); font-weight: 700; }
.cross { color: var(--text-subtle); }

/* -------------------------------------------------------------------------- */
/*  How It Works                                                              */
/* -------------------------------------------------------------------------- */

.how-it-works { padding: 100px 0; }

.steps-grid {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
}

.step-card {
  flex: 0 1 280px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
  text-align: center;
}

.step-number {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(137, 180, 250, 0.1);
  color: var(--accent);
  font-size: 20px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}

.step-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.step-desc { font-size: 14px; color: var(--text-muted); }

.step-arrow {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                   */
/* -------------------------------------------------------------------------- */

.pricing { padding: 100px 0; background: var(--bg-overlay); }

.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
  align-items: start;
}

.pricing-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 32px;
  position: relative;
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.pricing-card:hover { transform: translateY(-4px); }

.pricing-card-popular {
  border-color: var(--accent);
  box-shadow: 0 0 40px rgba(137, 180, 250, 0.15);
}

.pricing-popular-badge {
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent);
  color: var(--bg-overlay);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 16px;
  border-radius: 20px;
}

.pricing-header { text-align: center; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.pricing-plan-name { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
.pricing-price { display: flex; align-items: baseline; justify-content: center; gap: 4px; }
.pricing-amount { font-size: 40px; font-weight: 800; color: var(--text); }
.pricing-period { font-size: 14px; color: var(--text-muted); }

.pricing-features { list-style: none; margin-bottom: 28px; display: flex; flex-direction: column; gap: 10px; }
.pricing-features li { font-size: 14px; color: var(--text-muted); display: flex; align-items: center; gap: 10px; }
.pricing-features li .check { flex-shrink: 0; }
.pricing-feature-disabled { opacity: 0.5; }

/* -------------------------------------------------------------------------- */
/*  Enterprise                                                                */
/* -------------------------------------------------------------------------- */

.enterprise {
  padding: 100px 0;
  background: linear-gradient(135deg, var(--bg-base) 0%, #1a1b2e 50%, var(--bg-overlay) 100%);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.enterprise-content {
  text-align: center;
  max-width: 640px;
  margin: 0 auto;
}

.enterprise-title { font-size: 36px; font-weight: 800; margin-bottom: 12px; }
.enterprise-subtitle { font-size: 20px; color: var(--accent); font-weight: 600; margin-bottom: 16px; }
.enterprise-desc { font-size: 16px; color: var(--text-muted); margin-bottom: 32px; line-height: 1.7; }

/* -------------------------------------------------------------------------- */
/*  Footer                                                                    */
/* -------------------------------------------------------------------------- */

.footer { padding: 64px 0 32px; background: var(--bg-overlay); }

.footer-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 48px;
  margin-bottom: 48px;
}

.footer-brand { display: flex; flex-direction: column; gap: 12px; }
.footer-brand-text { font-size: 16px; font-weight: 700; color: var(--text); }
.footer-tagline { font-size: 14px; color: var(--text-muted); }

.footer-col { display: flex; flex-direction: column; gap: 10px; }
.footer-col-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text); margin-bottom: 4px; }
.footer-link { font-size: 14px; color: var(--text-muted); text-decoration: none; transition: color 0.15s ease; }
.footer-link:hover { color: var(--text); text-decoration: none; }

.footer-bottom { border-top: 1px solid var(--border); padding-top: 24px; }
.footer-copyright { font-size: 13px; color: var(--text-subtle); text-align: center; }

/* -------------------------------------------------------------------------- */
/*  Reveal animation                                                          */
/* -------------------------------------------------------------------------- */

[data-reveal] {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}

[data-reveal].revealed {
  opacity: 1;
  transform: translateY(0);
}

/* -------------------------------------------------------------------------- */
/*  Responsive                                                                */
/* -------------------------------------------------------------------------- */

@media (max-width: 960px) {
  .hero .container { grid-template-columns: 1fr; }
  .hero-visual { display: none; }
  .hero-title { font-size: 42px; }
  .features-grid { grid-template-columns: repeat(2, 1fr); }
  .pricing-grid { grid-template-columns: 1fr; max-width: 400px; margin: 0 auto; }
  .footer-grid { grid-template-columns: 1fr 1fr; }
  .steps-grid { flex-direction: column; }
  .step-arrow { transform: rotate(90deg); }
}

@media (max-width: 640px) {
  .nav-links { display: none; }
  .nav-cta-link { display: none; }
  .nav-hamburger { display: flex; }
  .nav-links.open { display: flex; flex-direction: column; position: absolute; top: 64px; left: 0; right: 0; background: var(--bg-overlay); border-bottom: 1px solid var(--border); padding: 16px 24px; gap: 16px; }
  .hero { padding: 100px 0 60px; }
  .hero-title { font-size: 32px; }
  .hero-subtitle { font-size: 16px; }
  .hero-cta-row { flex-direction: column; }
  .hero-cta-row .btn { width: 100%; }
  .features-grid { grid-template-columns: 1fr; }
  .section-title { font-size: 28px; }
  .footer-grid { grid-template-columns: 1fr; }
  .compare-table { font-size: 12px; }
  .compare-table th, .compare-table td { padding: 10px 12px; }
}
```

### `landing/script.js`

```javascript
/**
 * Neuron Interceptor Landing Page — Minimal JavaScript
 *
 * Features:
 *  1. Smooth scroll for anchor links
 *  2. Sticky nav scroll effect
 *  3. Intersection Observer for reveal animations
 *  4. Mobile hamburger menu toggle
 */

/* -------------------------------------------------------------------------- */
/*  Sticky Nav                                                                */
/* -------------------------------------------------------------------------- */

const nav = document.getElementById('nav');

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

/* -------------------------------------------------------------------------- */
/*  Smooth Scroll                                                             */
/* -------------------------------------------------------------------------- */

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (e) => {
    const targetId = anchor.getAttribute('href');
    if (targetId === '#') return;

    const target = document.querySelector(targetId);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });

      // Close mobile menu if open
      document.getElementById('navLinks').classList.remove('open');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Reveal on Scroll (Intersection Observer)                                  */
/* -------------------------------------------------------------------------- */

const revealElements = document.querySelectorAll('[data-reveal]');

if ('IntersectionObserver' in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.1,
      rootMargin: '0px 0px -40px 0px',
    }
  );

  revealElements.forEach((el) => revealObserver.observe(el));
} else {
  // Fallback: show all elements immediately
  revealElements.forEach((el) => el.classList.add('revealed'));
}

/* -------------------------------------------------------------------------- */
/*  Mobile Hamburger Menu                                                     */
/* -------------------------------------------------------------------------- */

const hamburger = document.getElementById('navHamburger');
const navLinks = document.getElementById('navLinks');

hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  if (!nav.contains(e.target)) {
    navLinks.classList.remove('open');
  }
});

/* -------------------------------------------------------------------------- */
/*  Stagger reveal for grid items                                             */
/* -------------------------------------------------------------------------- */

document.querySelectorAll('.features-grid, .pricing-grid').forEach((grid) => {
  const cards = grid.querySelectorAll('[data-reveal]');
  cards.forEach((card, index) => {
    card.style.transitionDelay = `${index * 0.1}s`;
  });
});
```

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `landing/index.html` | Complete HTML structure with all 7 sections |
| `landing/style.css` | Responsive CSS with Catppuccin dark theme |
| `landing/script.js` | Smooth scroll, reveal animations, mobile menu |

### No Modified Files
This feature is entirely standalone. No existing files are changed.

## Verification

1. **Open locally**: Open `landing/index.html` in a browser (no server needed since it is pure static HTML/CSS/JS)
2. **Visual check**: Verify the dark Catppuccin theme, readable text, proper contrast
3. **Navigation**: Click nav links ("Features", "Compare", etc.) -- verify smooth scroll to each section
4. **Sticky nav**: Scroll down -- verify the nav gets a subtle border and more opaque background
5. **Reveal animations**: Scroll through the page -- feature cards and pricing cards should fade in as they enter the viewport
6. **Comparison table**: Verify all rows render correctly with checkmarks/crosses. Neuron column is subtly highlighted
7. **Pricing cards**: Verify 3 cards (Free/Pro/Team). Pro card has "Most Popular" badge and blue border
8. **Enterprise section**: Dark gradient background, "Contact Sales" CTA button
9. **Footer**: 4-column grid with brand, Product, Resources, Company links
10. **Mobile responsive**: Resize browser to < 640px width:
    - Hamburger menu appears and works (click to toggle nav links)
    - Hero stacks vertically, mockup hidden
    - Feature grid becomes 1 column
    - Pricing cards stack vertically
    - Footer stacks to 1 column
11. **Tablet responsive**: Resize to 640-960px:
    - Features become 2 columns
    - Hero visual hidden
    - Steps stack vertically
12. **Performance**: No external JS frameworks loaded. Only Google Fonts (Inter + JetBrains Mono). Page should load in < 1s on fast connection
