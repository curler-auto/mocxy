# Feature 3.4: Team Workspaces with Member Management and RBAC

## Summary

Implement team workspace support in the extension UI: a workspace switcher in both the popup and options page, member management panel, invite flow, and role-based access control that mirrors the backend RBAC middleware.

## Why

Team workspaces allow multiple engineers to share interception rules and mock collections within a team, rather than each person maintaining their own. This is the key differentiator that justifies the SaaS pricing model, and a core feature for enterprise adoption.

## Dependencies

- **Spec 13 (Backend API Server)**: Workspace CRUD, member management, RBAC middleware
- **Spec 14 (Auth System)**: User authentication, auth state management
- **Spec 15 (Extension Sync)**: Bidirectional sync tied to the active workspace

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Server location**: `health_check/utils/neuron-interceptor-plugin/server/`
- **Options page**: `options/options.html` + `options/options.js` -- sidebar navigation, content sections, component init
- **Options components**: `options/components/` -- `rule-list.js`, `rule-form.js`, `mock-editor.js`, `request-log.js`, `import-export.js`, `settings-panel.js`
- **Popup**: `popup/popup.html` + `popup/popup.js`
- **Auth manager**: `service-worker/auth-manager.js` -- `getAuthState()`, `apiFetch()` (from spec 14)
- **Sync manager**: `service-worker/sync-manager.js` -- `connect(workspaceId)`, `fullSync()` (from spec 15)
- **Message router**: `service-worker/message-router.js`
- **Theme**: Catppuccin Mocha palette (CSS variables in `options/options.css`)

### Backend Routes (from spec 13):
- `GET /workspaces` -- list user's workspaces (with role)
- `POST /workspaces` -- create workspace
- `GET /workspaces/:id` -- workspace details + members
- `PUT /workspaces/:id` -- update workspace name
- `DELETE /workspaces/:id` -- delete workspace (owner only)
- `POST /workspaces/:id/invite` -- invite member by email
- `DELETE /workspaces/:id/members/:userId` -- remove member

### Permission Matrix

| Action | Owner | Admin | Editor | Viewer |
|--------|-------|-------|--------|--------|
| View rules | Y | Y | Y | Y |
| Create rules | Y | Y | Y | N |
| Edit rules (any) | Y | Y | N | N |
| Edit rules (own) | Y | Y | Y | N |
| Delete rules | Y | Y | N | N |
| Manage members | Y | Y | N | N |
| Delete workspace | Y | N | N | N |
| Export data | Y | Y | Y | Y |
| Import data | Y | Y | N | N |
| Edit settings | Y | Y | N | N |
| View settings | Y | Y | Y | Y |

## Implementation

### Step 1: Add New Constants to `shared/constants.js`

Add these new MSG_TYPES:

```javascript
// --- Workspaces (spec 16) ---
GET_WORKSPACES:         'GET_WORKSPACES',
CREATE_WORKSPACE:       'CREATE_WORKSPACE',
SWITCH_WORKSPACE:       'SWITCH_WORKSPACE',
GET_WORKSPACE_MEMBERS:  'GET_WORKSPACE_MEMBERS',
INVITE_MEMBER:          'INVITE_MEMBER',
REMOVE_MEMBER:          'REMOVE_MEMBER',
GET_ACTIVE_WORKSPACE:   'GET_ACTIVE_WORKSPACE',
DELETE_WORKSPACE:        'DELETE_WORKSPACE',
UPDATE_WORKSPACE:        'UPDATE_WORKSPACE',
```

Add new STORAGE_KEYS:

```javascript
ACTIVE_WORKSPACE: 'neuron_active_workspace',
```

### Step 2: Add Workspace Management to `service-worker/auth-manager.js`

Add workspace state tracking. Add these to the internal state section:

```javascript
let _activeWorkspace = null;   // { id, name, role }
let _workspaces = [];          // Array of { id, name, role }
```

Add workspace functions:

```javascript
/* -------------------------------------------------------------------------- */
/*  Workspace Management                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the user's workspaces from the backend and cache them.
 * @returns {Promise<Array>}
 */
export async function fetchWorkspaces() {
  const result = await apiFetch('/workspaces');
  _workspaces = result.workspaces || [];

  // If no active workspace is set, default to the first one
  if (!_activeWorkspace && _workspaces.length > 0) {
    await switchWorkspace(_workspaces[0].id);
  }

  return _workspaces;
}

/**
 * Get cached workspaces.
 * @returns {Array}
 */
export function getWorkspaces() {
  return _workspaces;
}

/**
 * Get the current active workspace.
 * @returns {Object|null} { id, name, role }
 */
export function getActiveWorkspace() {
  return _activeWorkspace;
}

/**
 * Switch to a different workspace.
 * Triggers a full sync with the new workspace.
 *
 * @param {string} workspaceId
 * @returns {Promise<Object>} The workspace object
 */
export async function switchWorkspace(workspaceId) {
  const workspace = _workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found in user's workspace list`);
  }

  _activeWorkspace = {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role,
  };

  // Persist active workspace ID
  await chrome.storage.local.set({
    [STORAGE_KEYS.ACTIVE_WORKSPACE]: _activeWorkspace,
  });

  // Trigger sync with the new workspace
  try {
    const { connect } = await import('./sync-manager.js');
    await connect(workspaceId);
  } catch (err) {
    console.warn('[NeuronAuth] Failed to sync after workspace switch:', err);
  }

  return _activeWorkspace;
}

/**
 * Create a new workspace via the backend.
 * @param {string} name
 * @returns {Promise<Object>} The created workspace
 */
export async function createWorkspace(name) {
  const result = await apiFetch('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

  // Refresh workspace list
  await fetchWorkspaces();

  return result.workspace;
}

/**
 * Delete a workspace (owner only).
 * @param {string} workspaceId
 */
export async function deleteWorkspace(workspaceId) {
  await apiFetch(`/workspaces/${workspaceId}`, { method: 'DELETE' });

  // Refresh and switch to another workspace
  await fetchWorkspaces();
  if (_activeWorkspace?.id === workspaceId && _workspaces.length > 0) {
    await switchWorkspace(_workspaces[0].id);
  }
}

/**
 * Update workspace name.
 * @param {string} workspaceId
 * @param {string} name
 */
export async function updateWorkspace(workspaceId, name) {
  await apiFetch(`/workspaces/${workspaceId}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
  await fetchWorkspaces();
}

/**
 * Get workspace members.
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
export async function getWorkspaceMembers(workspaceId) {
  const result = await apiFetch(`/workspaces/${workspaceId}`);
  return result.members || [];
}

/**
 * Invite a member to a workspace.
 * @param {string} workspaceId
 * @param {string} email
 * @param {string} role
 * @returns {Promise<Object>}
 */
export async function inviteMember(workspaceId, email, role) {
  return apiFetch(`/workspaces/${workspaceId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

/**
 * Remove a member from a workspace.
 * @param {string} workspaceId
 * @param {string} userId
 */
export async function removeMember(workspaceId, userId) {
  await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, {
    method: 'DELETE',
  });
}

/**
 * Load active workspace from storage on startup.
 */
export async function loadWorkspaceState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_WORKSPACE);
    if (result[STORAGE_KEYS.ACTIVE_WORKSPACE]) {
      _activeWorkspace = result[STORAGE_KEYS.ACTIVE_WORKSPACE];
    }
  } catch (err) {
    console.warn('[NeuronAuth] Failed to load workspace state:', err);
  }
}
```

Update `loadAuthState()` to also load workspace state:

```javascript
export async function loadAuthState() {
  // ... existing code ...
  await loadWorkspaceState();
}
```

Update `login()` and `register()` to fetch workspaces after successful auth:

```javascript
// At the end of login(), after _scheduleRefresh():
  await fetchWorkspaces();
  return { user: result.user, workspaces: _workspaces };

// At the end of register(), after _scheduleRefresh():
  await fetchWorkspaces();
  return { user: result.user, workspaces: _workspaces };
```

Update `getAuthState()` to include workspace info:

```javascript
export function getAuthState() {
  return {
    isLoggedIn: _authState.isLoggedIn,
    user: _authState.user,
    expiresAt: _authState.expiresAt,
    activeWorkspace: _activeWorkspace,
    workspaces: _workspaces,
  };
}
```

### Step 3: Add Workspace Message Handlers to `service-worker/message-router.js`

Import new functions:

```javascript
import {
  login,
  logout,
  register,
  getAuthState,
  refreshTokens,
  googleOAuth,
  fetchWorkspaces,
  getWorkspaces,
  getActiveWorkspace,
  switchWorkspace,
  createWorkspace,
  deleteWorkspace,
  updateWorkspace,
  getWorkspaceMembers,
  inviteMember,
  removeMember,
} from './auth-manager.js';
```

Add cases to `_route()`:

```javascript
    /* ---- Workspaces ---- */
    case MSG_TYPES.GET_WORKSPACES:
      return fetchWorkspaces();

    case MSG_TYPES.CREATE_WORKSPACE:
      return createWorkspace(payload.name);

    case MSG_TYPES.SWITCH_WORKSPACE:
      return switchWorkspace(payload.workspaceId);

    case MSG_TYPES.GET_ACTIVE_WORKSPACE:
      return getActiveWorkspace();

    case MSG_TYPES.GET_WORKSPACE_MEMBERS:
      return getWorkspaceMembers(payload.workspaceId);

    case MSG_TYPES.INVITE_MEMBER:
      return inviteMember(payload.workspaceId, payload.email, payload.role);

    case MSG_TYPES.REMOVE_MEMBER:
      return removeMember(payload.workspaceId, payload.userId);

    case MSG_TYPES.DELETE_WORKSPACE:
      return deleteWorkspace(payload.workspaceId);

    case MSG_TYPES.UPDATE_WORKSPACE:
      return updateWorkspace(payload.workspaceId, payload.name);
```

### Step 4: Create `options/components/workspace-switcher.js`

This new component renders a workspace dropdown and management panel.

```javascript
/**
 * workspace-switcher.js
 *
 * Workspace selector dropdown + member management panel.
 * Shows in the options page header (and can be reused in popup).
 */

import { MSG_TYPES } from '../../shared/constants.js';
import { sendMessage, showToast, openModal, closeModal } from '../options.js';

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let _container = null;
let _workspaces = [];
let _activeWorkspace = null;
let _members = [];
let _userRole = 'viewer';

/* -------------------------------------------------------------------------- */
/*  Init                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Initialize the workspace switcher component.
 * @param {HTMLElement} container - DOM element to mount into
 * @returns {{ refresh: Function }}
 */
export function initWorkspaceSwitcher(container) {
  _container = container;
  refresh();
  return { refresh };
}

/* -------------------------------------------------------------------------- */
/*  Data fetch                                                                */
/* -------------------------------------------------------------------------- */

async function refresh() {
  try {
    const authResponse = await sendMessage(MSG_TYPES.GET_AUTH_STATE);
    const authState = authResponse?.data || authResponse;

    if (!authState?.isLoggedIn) {
      _container.innerHTML = '';
      return;
    }

    _workspaces = authState.workspaces || [];
    _activeWorkspace = authState.activeWorkspace;
    _userRole = _activeWorkspace?.role || 'viewer';

    render();
  } catch (err) {
    console.warn('[WorkspaceSwitcher] Refresh failed:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Render                                                                    */
/* -------------------------------------------------------------------------- */

function render() {
  _container.innerHTML = '';

  if (_workspaces.length === 0) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'ws-switcher';
  wrapper.style.cssText = 'display:flex; align-items:center; gap:8px;';

  // Dropdown select
  const select = document.createElement('select');
  select.className = 'ws-switcher-select select';
  select.style.cssText = 'min-width:160px; font-size:13px;';

  for (const ws of _workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = ws.name;
    opt.selected = _activeWorkspace?.id === ws.id;
    select.appendChild(opt);
  }

  select.addEventListener('change', async () => {
    try {
      const response = await sendMessage(MSG_TYPES.SWITCH_WORKSPACE, {
        payload: { workspaceId: select.value },
      });
      if (response?.success !== false) {
        showToast('Workspace switched', 'success');
        await refresh();
        // Trigger a page-wide refresh so rule list reloads
        window.dispatchEvent(new CustomEvent('workspace-changed'));
      }
    } catch (err) {
      showToast('Failed to switch workspace', 'error');
    }
  });

  // Role badge
  const roleBadge = document.createElement('span');
  roleBadge.className = `badge badge-${_getRoleBadgeClass(_userRole)}`;
  roleBadge.textContent = _userRole;
  roleBadge.style.cssText = 'font-size:10px; text-transform:uppercase;';

  // Manage button (admin+ only)
  const manageBtn = document.createElement('button');
  manageBtn.className = 'btn btn-ghost btn-sm';
  manageBtn.textContent = 'Manage';
  manageBtn.title = 'Manage workspace members';

  if (_userRole === 'owner' || _userRole === 'admin') {
    manageBtn.addEventListener('click', () => _showManageModal());
  } else {
    manageBtn.disabled = true;
    manageBtn.title = 'You need admin or owner role to manage members';
  }

  // New workspace button
  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-ghost btn-sm';
  newBtn.textContent = '+ New';
  newBtn.title = 'Create a new workspace';
  newBtn.addEventListener('click', () => _showCreateModal());

  wrapper.appendChild(select);
  wrapper.appendChild(roleBadge);
  wrapper.appendChild(manageBtn);
  wrapper.appendChild(newBtn);
  _container.appendChild(wrapper);
}

function _getRoleBadgeClass(role) {
  switch (role) {
    case 'owner': return 'active';    // blue
    case 'admin': return 'enabled';   // green
    case 'editor': return 'mock-inline'; // yellow
    case 'viewer': return 'disabled';  // grey
    default: return 'disabled';
  }
}

/* -------------------------------------------------------------------------- */
/*  Create Workspace Modal                                                    */
/* -------------------------------------------------------------------------- */

function _showCreateModal() {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="form-group">
      <label class="form-label">Workspace Name</label>
      <input type="text" class="input" id="newWsName" placeholder="e.g. My Team" maxlength="255" style="width:100%;">
    </div>
  `;

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);

  const createBtn = document.createElement('button');
  createBtn.className = 'btn btn-primary';
  createBtn.textContent = 'Create';
  createBtn.addEventListener('click', async () => {
    const name = document.getElementById('newWsName').value.trim();
    if (!name) {
      showToast('Name is required', 'warning');
      return;
    }

    createBtn.disabled = true;
    try {
      const response = await sendMessage(MSG_TYPES.CREATE_WORKSPACE, {
        payload: { name },
      });
      if (response?.success === false) {
        showToast(response.error || 'Failed to create workspace', 'error');
      } else {
        showToast('Workspace created', 'success');
        closeModal();
        await refresh();
      }
    } catch (err) {
      showToast(err.message || 'Failed to create workspace', 'error');
    }
    createBtn.disabled = false;
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(createBtn);

  openModal({ title: 'Create Workspace', body: form, footer });

  setTimeout(() => document.getElementById('newWsName')?.focus(), 50);
}

/* -------------------------------------------------------------------------- */
/*  Manage Workspace Modal (Members)                                          */
/* -------------------------------------------------------------------------- */

async function _showManageModal() {
  if (!_activeWorkspace) return;

  // Fetch members
  try {
    const response = await sendMessage(MSG_TYPES.GET_WORKSPACE_MEMBERS, {
      payload: { workspaceId: _activeWorkspace.id },
    });
    _members = (response?.data || response) || [];
  } catch (err) {
    showToast('Failed to load members', 'error');
    return;
  }

  const body = document.createElement('div');

  // Workspace name edit
  const nameSection = document.createElement('div');
  nameSection.style.cssText = 'margin-bottom:20px;';
  nameSection.innerHTML = `
    <div class="form-group">
      <label class="form-label">Workspace Name</label>
      <div style="display:flex; gap:8px;">
        <input type="text" class="input" id="editWsName" value="${_escapeHtml(_activeWorkspace.name)}" style="flex:1;">
        <button class="btn btn-secondary btn-sm" id="renameWsBtn">Rename</button>
      </div>
    </div>
  `;
  body.appendChild(nameSection);

  // Invite section
  const inviteSection = document.createElement('div');
  inviteSection.style.cssText = 'margin-bottom:20px; border-top:1px solid var(--border); padding-top:16px;';
  inviteSection.innerHTML = `
    <h4 style="font-size:13px; font-weight:700; color:var(--text); margin-bottom:10px;">Invite Member</h4>
    <div style="display:flex; gap:8px; align-items:flex-end;">
      <div class="form-group" style="flex:2;">
        <label class="form-label">Email</label>
        <input type="email" class="input" id="inviteEmail" placeholder="colleague@example.com" style="width:100%;">
      </div>
      <div class="form-group" style="flex:1;">
        <label class="form-label">Role</label>
        <select class="select" id="inviteRole" style="width:100%;">
          <option value="viewer">Viewer</option>
          <option value="editor" selected>Editor</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button class="btn btn-primary btn-sm" id="inviteBtn" style="margin-bottom:6px;">Invite</button>
    </div>
    <div id="inviteError" style="color:var(--accent-red); font-size:12px; margin-top:4px; min-height:16px;"></div>
  `;
  body.appendChild(inviteSection);

  // Members list
  const membersSection = document.createElement('div');
  membersSection.style.cssText = 'border-top:1px solid var(--border); padding-top:16px;';

  const membersTitle = document.createElement('h4');
  membersTitle.style.cssText = 'font-size:13px; font-weight:700; color:var(--text); margin-bottom:10px;';
  membersTitle.textContent = `Members (${_members.length})`;
  membersSection.appendChild(membersTitle);

  const membersList = document.createElement('div');
  membersList.id = 'membersList';
  membersList.style.cssText = 'display:flex; flex-direction:column; gap:6px; max-height:250px; overflow-y:auto;';
  _renderMembersList(membersList);
  membersSection.appendChild(membersList);

  body.appendChild(membersSection);

  // Danger zone (owner only)
  if (_userRole === 'owner') {
    const dangerSection = document.createElement('div');
    dangerSection.style.cssText = 'margin-top:20px; border-top:1px solid var(--accent-red); padding-top:16px;';
    dangerSection.innerHTML = `
      <h4 style="font-size:13px; font-weight:700; color:var(--accent-red); margin-bottom:10px;">Danger Zone</h4>
      <button class="btn btn-danger btn-sm" id="deleteWsBtn">Delete Workspace</button>
      <p style="font-size:11px; color:var(--text-subtle); margin-top:6px;">This permanently deletes the workspace, all rules, collections, and removes all members.</p>
    `;
    body.appendChild(dangerSection);
  }

  openModal({ title: `Manage: ${_activeWorkspace.name}`, body });

  // Wire up handlers after modal is in DOM
  setTimeout(() => {
    // Rename
    document.getElementById('renameWsBtn')?.addEventListener('click', async () => {
      const name = document.getElementById('editWsName')?.value.trim();
      if (!name) return;
      try {
        await sendMessage(MSG_TYPES.UPDATE_WORKSPACE, {
          payload: { workspaceId: _activeWorkspace.id, name },
        });
        showToast('Workspace renamed', 'success');
        await refresh();
      } catch (err) {
        showToast('Rename failed', 'error');
      }
    });

    // Invite
    document.getElementById('inviteBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('inviteEmail')?.value.trim();
      const role = document.getElementById('inviteRole')?.value;
      const errorEl = document.getElementById('inviteError');

      if (!email) {
        errorEl.textContent = 'Email is required';
        return;
      }

      errorEl.textContent = '';
      try {
        const response = await sendMessage(MSG_TYPES.INVITE_MEMBER, {
          payload: { workspaceId: _activeWorkspace.id, email, role },
        });
        if (response?.success === false) {
          errorEl.textContent = response.error || 'Invite failed';
        } else {
          showToast(`Invited ${email} as ${role}`, 'success');
          document.getElementById('inviteEmail').value = '';
          // Refresh members
          const membersRes = await sendMessage(MSG_TYPES.GET_WORKSPACE_MEMBERS, {
            payload: { workspaceId: _activeWorkspace.id },
          });
          _members = (membersRes?.data || membersRes) || [];
          const membersList = document.getElementById('membersList');
          if (membersList) _renderMembersList(membersList);
        }
      } catch (err) {
        errorEl.textContent = err.message || 'Invite failed';
      }
    });

    // Delete workspace
    document.getElementById('deleteWsBtn')?.addEventListener('click', async () => {
      const confirmed = confirm(
        `Are you sure you want to delete "${_activeWorkspace.name}"? This action cannot be undone.`
      );
      if (!confirmed) return;

      try {
        await sendMessage(MSG_TYPES.DELETE_WORKSPACE, {
          payload: { workspaceId: _activeWorkspace.id },
        });
        showToast('Workspace deleted', 'info');
        closeModal();
        await refresh();
      } catch (err) {
        showToast(err.message || 'Delete failed', 'error');
      }
    });
  }, 50);
}

function _renderMembersList(container) {
  container.innerHTML = '';

  for (const member of _members) {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex; align-items:center; gap:10px;
      padding:8px 12px; background:var(--bg-overlay);
      border:1px solid var(--border); border-radius:var(--radius-sm);
    `;

    // Avatar
    const avatar = document.createElement('div');
    avatar.style.cssText = `
      width:28px; height:28px; border-radius:50%; flex-shrink:0;
      background:var(--bg-surface); display:flex; align-items:center;
      justify-content:center; font-size:12px; font-weight:700;
      color:var(--text-muted);
    `;
    avatar.textContent = (member.name || member.email || '?')[0].toUpperCase();
    if (member.avatar_url) {
      const img = document.createElement('img');
      img.src = member.avatar_url;
      img.style.cssText = 'width:28px; height:28px; border-radius:50%;';
      avatar.innerHTML = '';
      avatar.appendChild(img);
    }

    // Info
    const info = document.createElement('div');
    info.style.cssText = 'flex:1 1 0; min-width:0;';
    info.innerHTML = `
      <div style="font-size:13px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        ${_escapeHtml(member.name || 'Unknown')}
      </div>
      <div style="font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        ${_escapeHtml(member.email)}
      </div>
    `;

    // Role badge
    const roleBadge = document.createElement('span');
    roleBadge.className = `badge badge-${_getRoleBadgeClass(member.role)}`;
    roleBadge.textContent = member.role;
    roleBadge.style.cssText = 'font-size:10px; flex-shrink:0;';

    // Remove button (only for admin/owner, cannot remove owner)
    const actions = document.createElement('div');
    actions.style.cssText = 'flex-shrink:0;';

    if (
      member.role !== 'owner' &&
      (_userRole === 'owner' || _userRole === 'admin')
    ) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-ghost btn-sm';
      removeBtn.style.cssText = 'color:var(--accent-red); font-size:11px;';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        const confirmed = confirm(`Remove ${member.name || member.email} from this workspace?`);
        if (!confirmed) return;

        try {
          await sendMessage(MSG_TYPES.REMOVE_MEMBER, {
            payload: { workspaceId: _activeWorkspace.id, userId: member.id },
          });
          showToast('Member removed', 'info');
          // Refresh
          const res = await sendMessage(MSG_TYPES.GET_WORKSPACE_MEMBERS, {
            payload: { workspaceId: _activeWorkspace.id },
          });
          _members = (res?.data || res) || [];
          _renderMembersList(container);
        } catch (err) {
          showToast('Remove failed', 'error');
        }
      });
      actions.appendChild(removeBtn);
    }

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(roleBadge);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
```

### Step 5: Mount Workspace Switcher in Options Page

In `options/options.html`, add a container for the workspace switcher in the header bar, inside `.header-controls`, before the sync status div:

```html
        <!-- Workspace Switcher -->
        <div id="workspaceSwitcherContainer"></div>
```

In `options/options.js`, import and initialize the workspace switcher:

```javascript
import { initWorkspaceSwitcher } from './components/workspace-switcher.js';
```

In the `init()` function, after the component initializations:

```javascript
  const workspaceSwitcher = initWorkspaceSwitcher(
    document.getElementById('workspaceSwitcherContainer')
  );

  // Refresh workspace switcher when auth state changes
  window.addEventListener('workspace-changed', () => {
    ruleList.refresh();
    // Refresh other components too
  });
```

### Step 6: Add Workspace Switcher to Popup

In `popup/popup.html`, add a workspace selector after the stats row:

```html
  <!-- Workspace Selector (visible when logged in) -->
  <div class="workspace-selector hidden" id="workspaceSelector">
    <select class="workspace-select" id="workspaceSelect">
    </select>
    <span class="workspace-role" id="workspaceRole"></span>
  </div>
```

In `popup/popup.css`, add:

```css
/* -------------------------------------------------------------------------- */
/*  Workspace Selector                                                        */
/* -------------------------------------------------------------------------- */

.workspace-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 6px;
  flex-shrink: 0;
}

.workspace-select {
  flex: 1 1 0;
  padding: 5px 28px 5px 10px;
  border: 1px solid #45475a;
  border-radius: 4px;
  background: #181825;
  color: #cdd6f4;
  font-size: 12px;
  font-family: inherit;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%23a6adc8' d='M1 3l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  cursor: pointer;
  outline: none;
}

.workspace-select:focus {
  border-color: #89b4fa;
}

.workspace-role {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

.workspace-role-owner   { background: rgba(137,180,250,0.15); color: #89b4fa; }
.workspace-role-admin   { background: rgba(166,227,161,0.15); color: #a6e3a1; }
.workspace-role-editor  { background: rgba(249,226,175,0.15); color: #f9e2af; }
.workspace-role-viewer  { background: rgba(108,112,134,0.2);  color: #a6adc8; }
```

In `popup/popup.js`, add workspace management:

```javascript
const $workspaceSelector = document.getElementById('workspaceSelector');
const $workspaceSelect   = document.getElementById('workspaceSelect');
const $workspaceRole     = document.getElementById('workspaceRole');

const MSG_TYPES = {
  // ... existing entries ...
  GET_WORKSPACES:     'GET_WORKSPACES',
  SWITCH_WORKSPACE:   'SWITCH_WORKSPACE',
  GET_ACTIVE_WORKSPACE: 'GET_ACTIVE_WORKSPACE',
};

/**
 * Render the workspace selector dropdown.
 * @param {Object} authState - { isLoggedIn, workspaces, activeWorkspace }
 */
function renderWorkspaces(authState) {
  if (!authState?.isLoggedIn || !authState.workspaces?.length) {
    $workspaceSelector.classList.add('hidden');
    return;
  }

  $workspaceSelector.classList.remove('hidden');
  $workspaceSelect.innerHTML = '';

  for (const ws of authState.workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = ws.name;
    opt.selected = authState.activeWorkspace?.id === ws.id;
    $workspaceSelect.appendChild(opt);
  }

  // Show role badge
  const role = authState.activeWorkspace?.role || 'viewer';
  $workspaceRole.textContent = role;
  $workspaceRole.className = `workspace-role workspace-role-${role}`;
}

$workspaceSelect.addEventListener('change', async () => {
  try {
    await sendMsg(MSG_TYPES.SWITCH_WORKSPACE, {
      payload: { workspaceId: $workspaceSelect.value },
    });
  } catch (err) {
    console.warn('[NeuronPopup] Workspace switch failed:', err);
  }
});
```

Update `refreshAuthState()` to also render workspaces:

```javascript
async function refreshAuthState() {
  try {
    const response = await sendMsg(MSG_TYPES.GET_AUTH_STATE);
    const authState = response?.data || response;
    renderAuthState(authState);
    renderWorkspaces(authState);
  } catch (err) {
    console.warn('[NeuronPopup] Failed to get auth state:', err);
    renderAuthState(null);
    renderWorkspaces(null);
  }
}
```

### Step 7: RBAC Enforcement in the Extension UI

The extension UI should disable editing controls for viewers. In `options/components/rule-list.js`, when rendering each rule row, check the workspace role:

```javascript
/**
 * Check if the current user can edit rules.
 * Called during render to enable/disable UI controls.
 * @returns {boolean}
 */
async function _canEditRules() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    const authState = response?.data || response;
    const role = authState?.activeWorkspace?.role;

    // If not logged in (local-only mode), allow everything
    if (!authState?.isLoggedIn) return true;

    return role === 'owner' || role === 'admin' || role === 'editor';
  } catch {
    return true; // Default to allowing edits in offline/error state
  }
}

/**
 * Check if the current user can delete rules.
 * @returns {boolean}
 */
async function _canDeleteRules() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    const authState = response?.data || response;
    const role = authState?.activeWorkspace?.role;

    if (!authState?.isLoggedIn) return true;

    return role === 'owner' || role === 'admin';
  } catch {
    return true;
  }
}
```

Use these in `renderList()` to conditionally hide/disable edit/delete buttons. When `_canEditRules()` returns false, hide the "Add Rule", "Templates", and edit button on each rule row. When `_canDeleteRules()` returns false, hide the delete button.

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `options/components/workspace-switcher.js` | Workspace dropdown, member management, invite flow |

### Modified Files
| File | Changes |
|------|---------|
| `shared/constants.js` | Add workspace MSG_TYPES and STORAGE_KEYS |
| `service-worker/auth-manager.js` | Add workspace CRUD, switch, member management functions |
| `service-worker/message-router.js` | Add workspace message cases |
| `options/options.html` | Add workspace switcher container in header |
| `options/options.js` | Import and init workspace switcher, listen for workspace-changed events |
| `popup/popup.html` | Add workspace selector dropdown |
| `popup/popup.js` | Add workspace rendering and switching |
| `popup/popup.css` | Add workspace selector styles |
| `options/components/rule-list.js` | Add RBAC permission checks for edit/delete buttons |

## Verification

1. **Prerequisites**: Backend running with specs 13-15 implemented. Extension loaded.
2. **Personal workspace**: Login. The workspace switcher should show "Personal" as the only workspace. Role badge shows "owner".
3. **Create workspace**: In Options, click "+ New" in the workspace switcher. Enter "Engineering Team". The new workspace appears in the dropdown.
4. **Switch workspace**: Select "Engineering Team" from the dropdown. Rules list should refresh (empty initially). Create a rule in this workspace.
5. **Switch back**: Select "Personal". The rule list shows your personal rules (not the Engineering Team ones).
6. **Invite member**: Click "Manage" next to the workspace switcher (in "Engineering Team"). Enter a colleague's email and select "editor" role. Click "Invite". The member should appear in the list.
7. **Member view**: Log in as the invited user. They should see "Engineering Team" in their workspace list with "editor" role badge.
8. **RBAC - viewer**: Invite a user as "viewer". They should see rules but cannot create, edit, or delete them (buttons disabled/hidden).
9. **RBAC - editor**: An editor can create rules and edit their own rules, but cannot delete rules or manage members.
10. **Delete workspace**: As workspace owner, click "Manage" -> "Delete Workspace". Confirm. The workspace is removed and the switcher moves to another workspace.
11. **Popup workspace switching**: In the popup, verify the workspace dropdown appears when logged in and switching works.
