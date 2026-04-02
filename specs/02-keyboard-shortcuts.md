# Feature 1.2: Keyboard Shortcuts

## Summary

Add keyboard shortcuts for common actions across the popup and options page, plus global Chrome extension commands to open the popup and options page from any tab.

## Why

Power users want to navigate without touching the mouse. Keyboard shortcuts for section navigation, creating rules, searching, and closing modals make the extension faster to use.

## Codebase Context

The extension uses a Manifest V3 Chrome Extension architecture with ES modules. All source lives under `health_check/utils/neuron-interceptor-plugin/`. Key facts:

- **Manifest** (`manifest.json`): Currently has NO `commands` key. Uses `"action": { "default_popup": "popup/popup.html" }`. The service worker is at `"service_worker": "service-worker/sw.js"` with `"type": "module"`.
- **Options page** (`options/options.js`): Main controller. Imports from `../shared/constants.js`. Exports `sendMessage()`, `showToast()`, `openModal()`, `closeModal()`. Has a `navigateTo(sectionId)` function that takes a section ID string like `'rules'`, `'mocks'`, `'logs'`, `'import-export'`, `'settings'`. Navigation buttons use `data-section` attributes. There is already an Escape key listener on line 214 that calls `closeModal()` when the modal overlay (`$modalOverlay`) is not hidden.
- **Options HTML** (`options/options.html`): Sidebar has 5 `<button class="nav-item" data-section="...">` elements inside `<nav id="sidebarNav">`. Each nav-item contains `<span class="nav-icon">` and `<span class="nav-label">`. The options page loads `options.js` as `type="module"`.
- **Options CSS** (`options/options.css`): Catppuccin Mocha palette. Sidebar nav items: `.nav-item { display: flex; align-items: center; gap: 10px; }`. `.nav-label` has `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`.
- **Popup** (`popup/popup.js`): NOT an ES module (loaded via `<script src="popup.js">`). Defines its own `MSG_TYPES` locally. Has `$toggleInput` for master toggle, `$optionsLink` that calls `chrome.runtime.openOptionsPage()`. No existing keydown listeners.
- **Popup HTML** (`popup/popup.html`): Has `id="masterToggle"` (label wrapping checkbox), `id="toggleInput"` (checkbox), `id="optionsLink"` (anchor).
- **Service worker** (`service-worker/sw.js`): Imports `handleMessage` from `message-router.js`. Has `chrome.runtime.onMessage.addListener(handleMessage)` and `chrome.storage.onChanged.addListener(...)`. No existing `chrome.commands` listener.
- **Rule list** (`options/components/rule-list.js`): After spec 01-rule-templates is implemented, the Add Rule button will have class `ni-add-rule-btn`. Currently the add button has class `ni-btn ni-btn-primary` and is created dynamically in `renderToolbar()`. The search input has class `ni-rule-search`.
- **Section IDs**: The 5 content sections have IDs: `section-rules`, `section-mocks`, `section-logs`, `section-import-export`, `section-settings`. The `navigateTo()` function expects the `data-section` value (without the `section-` prefix), so e.g. `navigateTo('rules')`.

## Files to Modify

1. **`manifest.json`** -- Add `commands` key for global shortcuts.
2. **`service-worker/sw.js`** -- Add `chrome.commands.onCommand` listener.
3. **`options/options.js`** -- Add document-level `keydown` listener for page shortcuts.
4. **`options/options.html`** -- Add shortcut hint `<span>` elements to sidebar nav items.
5. **`options/options.css`** -- Add `.nav-shortcut` style.
6. **`popup/popup.js`** -- Add `keydown` listener for popup shortcuts.

## Implementation

### Step 1: Add `commands` to `manifest.json`

Add a `"commands"` key at the top level of the JSON object (e.g., after the `"icons"` block, before the closing `}`):

```json
"commands": {
  "_execute_action": {
    "suggested_key": { "default": "Ctrl+Shift+I", "mac": "Command+Shift+I" },
    "description": "Toggle Neuron Interceptor popup"
  },
  "open_options": {
    "suggested_key": { "default": "Ctrl+Shift+O", "mac": "Command+Shift+O" },
    "description": "Open Neuron Interceptor options page"
  }
}
```

Notes:
- `_execute_action` is Chrome's built-in command name that triggers the default popup. No code needed to handle it.
- `open_options` is a custom command name that requires a listener in the service worker.
- The `suggested_key` values are suggestions only -- Chrome may reject them if they conflict with existing browser shortcuts. Users can reassign via `chrome://extensions/shortcuts`.

### Step 2: Add command listener in `service-worker/sw.js`

After the existing `chrome.runtime.onMessage.addListener(handleMessage);` line (line 52), add:

```javascript
/* -------------------------------------------------------------------------- */
/*  Keyboard command listener                                                  */
/* -------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_options') {
    chrome.runtime.openOptionsPage();
  }
  // _execute_action is handled automatically by Chrome (toggles the popup)
});
```

### Step 3: Add keydown listener in `options/options.js`

The file already has an Escape key listener (lines 214-218):

```javascript
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});
```

Replace that entire block with a combined keydown handler:

```javascript
document.addEventListener('keydown', (e) => {
  // Escape: Close modal if open
  if (e.key === 'Escape' && !$modalOverlay.classList.contains('hidden')) {
    closeModal();
    return;
  }

  // Skip shortcuts when typing in an input/textarea/select
  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Ctrl/Cmd + K: Focus search input in active section
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const activeSection = document.querySelector('.content-section.active');
    if (activeSection) {
      const search = activeSection.querySelector(
        'input[type="search"], input[type="text"], .ni-rule-search, .rl-filter-input'
      );
      if (search) search.focus();
    }
    return;
  }

  // Ctrl/Cmd + N: Add new rule (only when Rules section is active)
  if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.shiftKey) {
    const rulesSection = document.getElementById('section-rules');
    if (rulesSection && rulesSection.classList.contains('active')) {
      e.preventDefault();
      const addBtn = rulesSection.querySelector('.ni-add-rule-btn, .ni-btn-primary');
      if (addBtn) addBtn.click();
    }
    return;
  }

  // Alt + 1-5: Navigate between sections
  if (e.altKey && !isTyping && e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    const sectionKeys = ['rules', 'mocks', 'logs', 'import-export', 'settings'];
    const idx = parseInt(e.key, 10) - 1;
    if (sectionKeys[idx]) {
      navigateTo(sectionKeys[idx]);
    }
    return;
  }
});
```

**Important**: The `navigateTo` function is already defined in `options.js` at line 150 as a local function. It is NOT exported. Since this keydown listener is being added in the same file, it can call `navigateTo()` directly.

### Step 4: Add shortcut hint spans to `options/options.html`

In the sidebar nav section, update each `<button class="nav-item">` to include a `<span class="nav-shortcut">` after the `<span class="nav-label">`:

Replace the existing `<nav>` content:

```html
<nav class="sidebar-nav" id="sidebarNav">
  <button class="nav-item active" data-section="rules">
    <span class="nav-icon">&zwnj;&#9889;</span>
    <span class="nav-label">Rules</span>
    <span class="nav-shortcut">Alt+1</span>
  </button>
  <button class="nav-item" data-section="mocks">
    <span class="nav-icon">&#128230;</span>
    <span class="nav-label">Mock Collections</span>
    <span class="nav-shortcut">Alt+2</span>
  </button>
  <button class="nav-item" data-section="logs">
    <span class="nav-icon">&#128203;</span>
    <span class="nav-label">Request Log</span>
    <span class="nav-shortcut">Alt+3</span>
  </button>
  <button class="nav-item" data-section="import-export">
    <span class="nav-icon">&#128190;</span>
    <span class="nav-label">Import / Export</span>
    <span class="nav-shortcut">Alt+4</span>
  </button>
  <button class="nav-item" data-section="settings">
    <span class="nav-icon">&#9881;&#65039;</span>
    <span class="nav-label">Settings</span>
    <span class="nav-shortcut">Alt+5</span>
  </button>
</nav>
```

### Step 5: Add `.nav-shortcut` CSS to `options/options.css`

After the `.nav-label` rule (around line 179), add:

```css
.nav-shortcut {
  font-size: 10px;
  color: var(--text-subtle);
  opacity: 0.6;
  margin-left: auto;
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
```

This works because `.nav-item` already has `display: flex; align-items: center; gap: 10px;`. The `margin-left: auto` pushes the shortcut hint to the far right of the nav item.

### Step 6: Add keydown listener in `popup/popup.js`

After the `DOMContentLoaded` listener (at the end of the file, after line 254), add:

```javascript
/* -------------------------------------------------------------------------- */
/*  Keyboard shortcuts                                                        */
/* -------------------------------------------------------------------------- */

document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in an input
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // E: Toggle enable/disable
  if (e.key === 'e' || e.key === 'E') {
    $toggleInput.click();
    return;
  }

  // O: Open options page
  if (e.key === 'o' || e.key === 'O') {
    chrome.runtime.openOptionsPage();
    return;
  }
});
```

Note: The popup uses plain JS (not ES modules). `$toggleInput` is already declared at line 24 as `document.getElementById('toggleInput')`.

## Shortcut Reference (complete list)

| Shortcut | Where | Action |
|---|---|---|
| Ctrl+Shift+I (Cmd+Shift+I on Mac) | Global | Open popup |
| Ctrl+Shift+O (Cmd+Shift+O on Mac) | Global | Open options page |
| Alt+1 through Alt+5 | Options page | Switch sidebar section |
| Ctrl+K (Cmd+K on Mac) | Options page | Focus search input |
| Ctrl+N (Cmd+N on Mac) | Options page (Rules tab) | Open new rule form |
| Escape | Options page | Close modal/form |
| E | Popup | Toggle enable/disable |
| O | Popup | Open options page |

## Verification

1. **Global shortcuts**: Navigate to any web page. Press Ctrl+Shift+I -- the popup opens. Press Ctrl+Shift+O -- the options page opens in a new tab.
2. **Section navigation**: On the options page, press Alt+1 -- Rules section shown. Alt+2 -- Mock Collections. Alt+3 -- Request Log. Alt+4 -- Import/Export. Alt+5 -- Settings. Confirm the sidebar highlights the correct nav item.
3. **Shortcut hints visible**: Sidebar shows "Alt+1" through "Alt+5" right-aligned in muted monospace text.
4. **Search focus**: On Rules tab, press Ctrl+K -- the rule search input is focused. Navigate to Request Log (Alt+3), press Ctrl+K -- the URL filter input is focused.
5. **New rule**: On Rules tab, press Ctrl+N -- the rule form modal opens for a new rule.
6. **Escape**: With the rule form open, press Escape -- the modal closes.
7. **Popup shortcuts**: Open the popup. Press E -- the master toggle flips. Press O -- the options page opens.
8. **No interference with typing**: Click into a search input, type text -- Alt+1 does NOT switch sections while input is focused. Ctrl+K still re-focuses (since it explicitly prevents default).
