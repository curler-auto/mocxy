# Feature 3.5: Stripe Billing Integration

## Summary

Implement SaaS billing using Stripe. Three plans (Free, Pro, Team) with different feature limits enforced on both the backend and extension. Includes Stripe Checkout for subscriptions, webhook handling for payment lifecycle events, a customer billing portal, and an "Upgrade" UI in the extension.

## Why

Billing monetizes the cloud features (sync, workspaces, RBAC). The free tier drives adoption; Pro and Team tiers generate revenue. Stripe handles all payment processing, PCI compliance, and subscription management.

## Dependencies

- **Spec 13 (Backend API Server)**: Database schema (users table with plan fields), server infrastructure
- **Spec 14 (Auth System)**: User authentication, JWT tokens

## Codebase Context

- **Plugin location**: `health_check/utils/neuron-interceptor-plugin/`
- **Server location**: `health_check/utils/neuron-interceptor-plugin/server/`
- **User model**: `server/src/models/user.js` -- `findById()`, `updateUser()`
- **Users table**: Has `plan` (free/pro/team), `stripe_customer_id`, `stripe_subscription_id`, `plan_expires_at` columns (from spec 13 migration)
- **Plan middleware stub**: `server/src/middleware/plan-middleware.js` -- `PLAN_LIMITS`, `enforceRuleLimit()`, `enforceWorkspaceLimit()` (stubs from spec 13)
- **Billing routes stub**: `server/src/routes/billing.js` -- returns 501 Not Implemented (stub from spec 13)
- **Billing service stub**: `server/src/services/billing-service.js` -- placeholder functions
- **Auth manager**: `service-worker/auth-manager.js` -- `getAuthState()`, `apiFetch()`, `getAccessToken()`
- **Options components**: `options/components/settings-panel.js` -- settings page
- **Popup**: `popup/popup.html` + `popup/popup.js`
- **Theme**: Catppuccin Mocha dark palette

## Plan Definitions

| Feature | Free | Pro ($12/mo) | Team ($29/seat/mo) |
|---------|------|------|------|
| Interception rules | 5 max | Unlimited | Unlimited |
| Workspaces | 1 | 3 | Unlimited |
| Cloud sync | No | Yes | Yes |
| Mock collections | 3 max | Unlimited | Unlimited |
| Request log retention | 24 hours | 7 days | 30 days |
| Team members | -- | -- | Unlimited |
| RBAC | -- | -- | Yes |
| Priority support | -- | -- | Yes |
| Export / Import | Yes | Yes | Yes |

## Stripe Setup

### Products & Prices (configure in Stripe Dashboard)

Create two Products in Stripe Dashboard:

**Product 1: Neuron Interceptor Pro**
- Price: $12.00/month (recurring)
- Price ID: will be auto-generated (e.g. `price_pro_monthly`)
- Metadata on the Price:
  - `neuron_plan`: `pro`
  - `neuron_max_rules`: `unlimited`
  - `neuron_max_workspaces`: `3`

**Product 2: Neuron Interceptor Team**
- Price: $29.00/month per seat (recurring, per-seat)
- Price ID: will be auto-generated (e.g. `price_team_monthly`)
- Metadata on the Price:
  - `neuron_plan`: `team`
  - `neuron_max_rules`: `unlimited`
  - `neuron_max_workspaces`: `unlimited`

Store the Price IDs in environment variables:

```env
STRIPE_PRICE_PRO=price_xxxxx
STRIPE_PRICE_TEAM=price_xxxxx
```

## Implementation

### Step 1: Update `server/src/config/index.js`

Add Stripe price IDs to the config:

```javascript
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      pro: process.env.STRIPE_PRICE_PRO || '',
      team: process.env.STRIPE_PRICE_TEAM || '',
    },
  },
```

### Step 2: Implement `server/src/services/billing-service.js`

Replace the stub with a complete implementation:

```javascript
/**
 * Billing service — Stripe API operations for subscription management.
 */

import Stripe from 'stripe';
import config from '../config/index.js';

/* -------------------------------------------------------------------------- */
/*  Stripe client                                                             */
/* -------------------------------------------------------------------------- */

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    if (!config.stripe.secretKey || config.stripe.secretKey === 'sk_test_placeholder') {
      throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in .env');
    }
    _stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2023-10-16' });
  }
  return _stripe;
}

/**
 * Check if Stripe is properly configured.
 * @returns {boolean}
 */
export function isConfigured() {
  return (
    config.stripe.secretKey &&
    config.stripe.secretKey !== 'sk_test_placeholder' &&
    config.stripe.prices.pro &&
    config.stripe.prices.team
  );
}

/* -------------------------------------------------------------------------- */
/*  Customer management                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Find or create a Stripe Customer for a user.
 * @param {Object} user - { id, email, name, stripe_customer_id }
 * @param {import('knex').Knex} db
 * @returns {Promise<string>} Stripe customer ID
 */
export async function findOrCreateCustomer(user, db) {
  const stripe = getStripe();

  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      neuron_user_id: user.id,
    },
  });

  // Persist customer ID
  await db('users')
    .where({ id: user.id })
    .update({ stripe_customer_id: customer.id, updated_at: db.fn.now() });

  return customer.id;
}

/* -------------------------------------------------------------------------- */
/*  Checkout                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a Stripe Checkout Session for upgrading to a paid plan.
 *
 * @param {Object} params
 * @param {Object} params.user - User object from DB
 * @param {string} params.plan - 'pro' or 'team'
 * @param {number} [params.quantity] - Number of seats (for team plan)
 * @param {string} params.successUrl - URL to redirect after successful payment
 * @param {string} params.cancelUrl - URL to redirect if user cancels
 * @param {import('knex').Knex} params.db
 * @returns {Promise<Object>} { sessionId, url }
 */
export async function createCheckoutSession({ user, plan, quantity, successUrl, cancelUrl, db }) {
  const stripe = getStripe();

  const priceId = plan === 'team' ? config.stripe.prices.team : config.stripe.prices.pro;
  if (!priceId) {
    throw new Error(`No Stripe price configured for plan "${plan}"`);
  }

  const customerId = await findOrCreateCustomer(user, db);

  const sessionParams = {
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [
      {
        price: priceId,
        quantity: plan === 'team' ? (quantity || 1) : 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: {
        neuron_user_id: user.id,
        neuron_plan: plan,
      },
    },
    metadata: {
      neuron_user_id: user.id,
      neuron_plan: plan,
    },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  return {
    sessionId: session.id,
    url: session.url,
  };
}

/* -------------------------------------------------------------------------- */
/*  Customer Portal                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create a Stripe Customer Portal session for managing subscriptions.
 *
 * @param {Object} user
 * @param {string} returnUrl - URL to redirect after leaving the portal
 * @param {import('knex').Knex} db
 * @returns {Promise<Object>} { url }
 */
export async function createCustomerPortalSession(user, returnUrl, db) {
  const stripe = getStripe();
  const customerId = await findOrCreateCustomer(user, db);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

/* -------------------------------------------------------------------------- */
/*  Webhook event handling                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verify and parse a Stripe webhook event.
 *
 * @param {string|Buffer} rawBody - The raw request body
 * @param {string} signature - The Stripe-Signature header
 * @returns {Object} The verified Stripe event
 */
export function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

/**
 * Handle a verified Stripe webhook event.
 * Updates user plan status based on subscription lifecycle events.
 *
 * @param {Object} event - Verified Stripe event
 * @param {import('knex').Knex} db
 * @returns {Promise<Object>} Processing result
 */
export async function handleWebhookEvent(event, db) {
  const { type, data } = event;

  switch (type) {
    case 'checkout.session.completed':
      return _handleCheckoutCompleted(data.object, db);

    case 'invoice.paid':
      return _handleInvoicePaid(data.object, db);

    case 'invoice.payment_failed':
      return _handlePaymentFailed(data.object, db);

    case 'customer.subscription.updated':
      return _handleSubscriptionUpdated(data.object, db);

    case 'customer.subscription.deleted':
      return _handleSubscriptionDeleted(data.object, db);

    default:
      return { handled: false, type };
  }
}

/**
 * checkout.session.completed — User completed Stripe Checkout.
 * Activate the subscription and update user plan.
 */
async function _handleCheckoutCompleted(session, db) {
  const userId = session.metadata?.neuron_user_id;
  const plan = session.metadata?.neuron_plan;

  if (!userId || !plan) {
    console.warn('[Billing] checkout.session.completed missing metadata:', session.id);
    return { handled: false };
  }

  const updates = {
    plan,
    stripe_subscription_id: session.subscription,
    updated_at: db.fn.now(),
  };

  // If we don't have the customer ID yet
  if (session.customer) {
    updates.stripe_customer_id = session.customer;
  }

  await db('users').where({ id: userId }).update(updates);

  console.log(`[Billing] User ${userId} upgraded to ${plan} plan (subscription: ${session.subscription})`);
  return { handled: true, userId, plan };
}

/**
 * invoice.paid — Recurring payment succeeded. Extend the plan.
 */
async function _handleInvoicePaid(invoice, db) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return { handled: false };

  // Find user by subscription ID
  const user = await db('users').where({ stripe_subscription_id: subscriptionId }).first();
  if (!user) {
    console.warn(`[Billing] invoice.paid: no user found for subscription ${subscriptionId}`);
    return { handled: false };
  }

  // Extend plan expiry (typically 1 month from now)
  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  const planExpiresAt = periodEnd ? new Date(periodEnd * 1000) : null;

  await db('users').where({ id: user.id }).update({
    plan_expires_at: planExpiresAt,
    updated_at: db.fn.now(),
  });

  console.log(`[Billing] Invoice paid for user ${user.id}, plan extended to ${planExpiresAt}`);
  return { handled: true, userId: user.id };
}

/**
 * invoice.payment_failed — Payment attempt failed.
 * Log warning; Stripe will retry automatically.
 */
async function _handlePaymentFailed(invoice, db) {
  const subscriptionId = invoice.subscription;
  const user = await db('users').where({ stripe_subscription_id: subscriptionId }).first();

  console.warn(`[Billing] Payment failed for user ${user?.id || 'unknown'}, subscription ${subscriptionId}`);
  return { handled: true, warning: 'payment_failed' };
}

/**
 * customer.subscription.updated — Subscription changed (upgrade/downgrade/cancel).
 */
async function _handleSubscriptionUpdated(subscription, db) {
  const user = await db('users').where({ stripe_subscription_id: subscription.id }).first();
  if (!user) return { handled: false };

  const plan = subscription.metadata?.neuron_plan || user.plan;

  const updates = { updated_at: db.fn.now() };

  // Check if subscription is active or cancelled
  if (subscription.status === 'active') {
    updates.plan = plan;
    const periodEnd = subscription.current_period_end;
    updates.plan_expires_at = periodEnd ? new Date(periodEnd * 1000) : null;
  } else if (subscription.status === 'past_due') {
    // Grace period — keep current plan
    console.warn(`[Billing] Subscription past_due for user ${user.id}`);
  }

  await db('users').where({ id: user.id }).update(updates);
  return { handled: true, userId: user.id, status: subscription.status };
}

/**
 * customer.subscription.deleted — Subscription cancelled/expired.
 * Downgrade to free plan.
 */
async function _handleSubscriptionDeleted(subscription, db) {
  const user = await db('users').where({ stripe_subscription_id: subscription.id }).first();
  if (!user) return { handled: false };

  await db('users').where({ id: user.id }).update({
    plan: 'free',
    stripe_subscription_id: null,
    plan_expires_at: null,
    updated_at: db.fn.now(),
  });

  console.log(`[Billing] User ${user.id} downgraded to free (subscription deleted)`);
  return { handled: true, userId: user.id, plan: 'free' };
}

/* -------------------------------------------------------------------------- */
/*  Plan status helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Get the effective plan for a user (check expiry).
 * @param {Object} user
 * @returns {string} 'free' | 'pro' | 'team'
 */
export function getEffectivePlan(user) {
  if (!user) return 'free';
  if (user.plan === 'free') return 'free';

  // Check if plan has expired
  if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
    return 'free'; // Expired
  }

  return user.plan;
}

/**
 * Get plan limits for a plan type.
 * @param {string} plan
 * @returns {Object}
 */
export function getPlanLimits(plan) {
  const limits = {
    free: { maxRules: 5, maxWorkspaces: 1, maxCollections: 3, syncEnabled: false, logRetentionDays: 1 },
    pro: { maxRules: Infinity, maxWorkspaces: 3, maxCollections: Infinity, syncEnabled: true, logRetentionDays: 7 },
    team: { maxRules: Infinity, maxWorkspaces: Infinity, maxCollections: Infinity, syncEnabled: true, logRetentionDays: 30 },
  };
  return limits[plan] || limits.free;
}
```

### Step 3: Implement `server/src/routes/billing.js`

Replace the stub with complete route handlers:

```javascript
/**
 * Billing routes — Stripe Checkout, Customer Portal, and Webhooks.
 */

import { authenticate } from '../middleware/auth-middleware.js';
import * as BillingService from '../services/billing-service.js';
import * as UserModel from '../models/user.js';

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function billingRoutes(fastify) {

  /* ---- POST /billing/create-checkout-session ---- */
  fastify.post('/create-checkout-session', {
    onRequest: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['plan'],
        properties: {
          plan: { type: 'string', enum: ['pro', 'team'] },
          quantity: { type: 'integer', minimum: 1 },
          successUrl: { type: 'string' },
          cancelUrl: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      if (!BillingService.isConfigured()) {
        return reply.code(503).send({
          error: 'Billing Not Configured',
          message: 'Stripe is not configured on this server. Set STRIPE_SECRET_KEY and price IDs in environment.',
        });
      }

      const user = await UserModel.findById(fastify.db, request.user.id);
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      try {
        const session = await BillingService.createCheckoutSession({
          user,
          plan: request.body.plan,
          quantity: request.body.quantity,
          successUrl: request.body.successUrl || `${request.headers.origin || 'http://localhost:3001'}/billing/success`,
          cancelUrl: request.body.cancelUrl || `${request.headers.origin || 'http://localhost:3001'}/billing/cancel`,
          db: fastify.db,
        });

        return { sessionId: session.sessionId, url: session.url };
      } catch (err) {
        fastify.log.error('Checkout session creation failed:', err);
        return reply.code(500).send({
          error: 'Checkout Failed',
          message: err.message,
        });
      }
    },
  });

  /* ---- POST /billing/customer-portal ---- */
  fastify.post('/customer-portal', {
    onRequest: [authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          returnUrl: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      if (!BillingService.isConfigured()) {
        return reply.code(503).send({
          error: 'Billing Not Configured',
          message: 'Stripe is not configured on this server.',
        });
      }

      const user = await UserModel.findById(fastify.db, request.user.id);
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      if (!user.stripe_customer_id) {
        return reply.code(400).send({
          error: 'No Subscription',
          message: 'You do not have an active subscription to manage.',
        });
      }

      try {
        const session = await BillingService.createCustomerPortalSession(
          user,
          request.body.returnUrl || `${request.headers.origin || 'http://localhost:3001'}`,
          fastify.db
        );
        return { url: session.url };
      } catch (err) {
        fastify.log.error('Customer portal session failed:', err);
        return reply.code(500).send({ error: 'Portal session failed', message: err.message });
      }
    },
  });

  /* ---- GET /billing/plan ---- */
  fastify.get('/plan', {
    onRequest: [authenticate],
    handler: async (request) => {
      const user = await UserModel.findById(fastify.db, request.user.id);
      if (!user) return { error: 'User not found' };

      const effectivePlan = BillingService.getEffectivePlan(user);
      const limits = BillingService.getPlanLimits(effectivePlan);

      return {
        plan: effectivePlan,
        planExpires: user.plan_expires_at,
        limits,
        hasSubscription: !!user.stripe_subscription_id,
      };
    },
  });

  /* ---- POST /billing/webhook ---- */
  fastify.post('/webhook', {
    config: {
      // Disable content-type parsing for webhooks (need raw body)
      rawBody: true,
    },
    handler: async (request, reply) => {
      if (!BillingService.isConfigured()) {
        return reply.code(503).send({ error: 'Billing not configured' });
      }

      const signature = request.headers['stripe-signature'];
      if (!signature) {
        return reply.code(400).send({ error: 'Missing Stripe-Signature header' });
      }

      let event;
      try {
        // Use raw body for signature verification
        const rawBody = request.rawBody || request.body;
        event = BillingService.constructWebhookEvent(rawBody, signature);
      } catch (err) {
        fastify.log.error('Webhook signature verification failed:', err.message);
        return reply.code(400).send({ error: 'Invalid webhook signature' });
      }

      try {
        const result = await BillingService.handleWebhookEvent(event, fastify.db);
        fastify.log.info(`Webhook processed: ${event.type} -> ${JSON.stringify(result)}`);
        return reply.code(200).send({ received: true, result });
      } catch (err) {
        fastify.log.error(`Webhook handler error for ${event.type}:`, err);
        return reply.code(500).send({ error: 'Webhook processing failed' });
      }
    },
  });

  /* ---- GET /billing/success ---- */
  fastify.get('/success', async (request, reply) => {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Successful</title></head>
      <body style="background:#1e1e2e;color:#cdd6f4;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;">
          <h1 style="color:#a6e3a1;">Payment Successful!</h1>
          <p>Your plan has been upgraded. You can close this tab and return to the extension.</p>
          <script>setTimeout(()=>window.close(),3000);</script>
        </div>
      </body>
      </html>
    `);
  });

  /* ---- GET /billing/cancel ---- */
  fastify.get('/cancel', async (request, reply) => {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Cancelled</title></head>
      <body style="background:#1e1e2e;color:#cdd6f4;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;">
          <h1 style="color:#f9e2af;">Payment Cancelled</h1>
          <p>No charges were made. You can close this tab.</p>
          <script>setTimeout(()=>window.close(),3000);</script>
        </div>
      </body>
      </html>
    `);
  });
}
```

### Step 4: Update `server/src/middleware/plan-middleware.js`

Replace the stub with a version that uses the billing service:

```javascript
/**
 * Plan middleware — enforces plan limits before allowing resource creation.
 */

import * as UserModel from '../models/user.js';
import * as RuleModel from '../models/rule.js';
import * as WorkspaceModel from '../models/workspace.js';
import * as BillingService from '../services/billing-service.js';

/**
 * Enforce maximum rules per workspace.
 */
export async function enforceRuleLimit(request, reply) {
  const workspaceId = request.params.id;
  const db = request.server.db;

  const workspace = await WorkspaceModel.findById(db, workspaceId);
  if (!workspace) {
    return reply.code(404).send({ error: 'Workspace not found' });
  }

  const owner = await UserModel.findById(db, workspace.owner_id);
  if (!owner) {
    return reply.code(500).send({ error: 'Workspace owner not found' });
  }

  const effectivePlan = BillingService.getEffectivePlan(owner);
  const limits = BillingService.getPlanLimits(effectivePlan);
  const currentCount = await RuleModel.countByWorkspace(db, workspaceId);

  if (currentCount >= limits.maxRules) {
    return reply.code(403).send({
      error: 'Plan Limit Reached',
      message: `Your "${effectivePlan}" plan allows a maximum of ${limits.maxRules} rules per workspace. Upgrade to add more.`,
      plan: effectivePlan,
      limit: limits.maxRules,
      current: currentCount,
      upgradeUrl: '/billing',
    });
  }
}

/**
 * Enforce maximum workspaces per user.
 */
export async function enforceWorkspaceLimit(request, reply) {
  const db = request.server.db;
  const userId = request.user.id;

  const user = await UserModel.findById(db, userId);
  if (!user) {
    return reply.code(401).send({ error: 'User not found' });
  }

  const effectivePlan = BillingService.getEffectivePlan(user);
  const limits = BillingService.getPlanLimits(effectivePlan);
  const currentCount = await WorkspaceModel.countOwnedByUser(db, userId);

  if (currentCount >= limits.maxWorkspaces) {
    return reply.code(403).send({
      error: 'Plan Limit Reached',
      message: `Your "${effectivePlan}" plan allows a maximum of ${limits.maxWorkspaces} workspaces. Upgrade to create more.`,
      plan: effectivePlan,
      limit: limits.maxWorkspaces,
      current: currentCount,
      upgradeUrl: '/billing',
    });
  }
}

/**
 * Check if sync is enabled for the user's plan.
 */
export async function enforceSyncAccess(request, reply) {
  const db = request.server.db;
  const userId = request.user.id;

  const user = await UserModel.findById(db, userId);
  if (!user) {
    return reply.code(401).send({ error: 'User not found' });
  }

  const effectivePlan = BillingService.getEffectivePlan(user);
  const limits = BillingService.getPlanLimits(effectivePlan);

  if (!limits.syncEnabled) {
    return reply.code(403).send({
      error: 'Feature Not Available',
      message: 'Cloud sync requires a Pro or Team plan. Upgrade to enable sync.',
      plan: effectivePlan,
      upgradeUrl: '/billing',
    });
  }
}
```

### Step 5: Add Billing MSG_TYPES to `shared/constants.js`

```javascript
// --- Billing (spec 17) ---
GET_PLAN:              'GET_PLAN',
CREATE_CHECKOUT:       'CREATE_CHECKOUT',
OPEN_BILLING_PORTAL:   'OPEN_BILLING_PORTAL',
```

### Step 6: Add Billing Handlers to `service-worker/message-router.js`

```javascript
    /* ---- Billing ---- */
    case MSG_TYPES.GET_PLAN: {
      const { apiFetch } = await import('./auth-manager.js');
      return apiFetch('/billing/plan');
    }

    case MSG_TYPES.CREATE_CHECKOUT: {
      const { apiFetch } = await import('./auth-manager.js');
      const result = await apiFetch('/billing/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // Open checkout URL in a new tab
      if (result.url) {
        chrome.tabs.create({ url: result.url });
      }
      return result;
    }

    case MSG_TYPES.OPEN_BILLING_PORTAL: {
      const { apiFetch } = await import('./auth-manager.js');
      const result = await apiFetch('/billing/customer-portal', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      });
      if (result.url) {
        chrome.tabs.create({ url: result.url });
      }
      return result;
    }
```

### Step 7: Add "Upgrade" UI to Settings Panel

Modify `options/components/settings-panel.js` to include a billing section. Add at the end of the component's render function:

```javascript
/**
 * Render the billing/plan section in settings.
 * @param {HTMLElement} container
 */
async function _renderBillingSection(container) {
  const section = document.createElement('div');
  section.className = 'card';
  section.style.cssText = 'margin-top:16px;';

  section.innerHTML = `
    <div class="card-header">
      <div class="card-title">Plan & Billing</div>
    </div>
    <div class="card-body" id="billingContent">
      <p style="color:var(--text-muted);">Loading plan info...</p>
    </div>
  `;

  container.appendChild(section);

  // Fetch plan info
  try {
    const response = await sendMessage(MSG_TYPES.GET_PLAN);
    const planData = response?.data || response;
    const billingContent = document.getElementById('billingContent');

    if (!planData || planData.error) {
      billingContent.innerHTML = '<p style="color:var(--text-muted);">Sign in to view plan info.</p>';
      return;
    }

    const plan = planData.plan || 'free';
    const limits = planData.limits || {};
    const hasSubscription = planData.hasSubscription;

    billingContent.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
        <span class="badge badge-${plan === 'free' ? 'disabled' : plan === 'pro' ? 'active' : 'enabled'}"
              style="font-size:12px; padding:4px 12px;">
          ${plan.toUpperCase()}
        </span>
        ${planData.planExpires ? `<span style="font-size:12px; color:var(--text-muted);">Expires: ${new Date(planData.planExpires).toLocaleDateString()}</span>` : ''}
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:16px;">
        <div style="font-size:12px; color:var(--text-muted);">Rules: <strong style="color:var(--text);">${limits.maxRules === Infinity ? 'Unlimited' : limits.maxRules}</strong></div>
        <div style="font-size:12px; color:var(--text-muted);">Workspaces: <strong style="color:var(--text);">${limits.maxWorkspaces === Infinity ? 'Unlimited' : limits.maxWorkspaces}</strong></div>
        <div style="font-size:12px; color:var(--text-muted);">Sync: <strong style="color:${limits.syncEnabled ? 'var(--accent-green)' : 'var(--accent-red)'};">${limits.syncEnabled ? 'Enabled' : 'Disabled'}</strong></div>
        <div style="font-size:12px; color:var(--text-muted);">Log retention: <strong style="color:var(--text);">${limits.logRetentionDays} days</strong></div>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap;" id="billingActions"></div>
    `;

    const actionsEl = document.getElementById('billingActions');

    if (plan === 'free') {
      // Show upgrade buttons
      const proBtn = document.createElement('button');
      proBtn.className = 'btn btn-primary';
      proBtn.textContent = 'Upgrade to Pro — $12/mo';
      proBtn.addEventListener('click', () => _startCheckout('pro'));

      const teamBtn = document.createElement('button');
      teamBtn.className = 'btn btn-secondary';
      teamBtn.textContent = 'Upgrade to Team — $29/seat/mo';
      teamBtn.addEventListener('click', () => _startCheckout('team'));

      actionsEl.appendChild(proBtn);
      actionsEl.appendChild(teamBtn);
    } else if (hasSubscription) {
      // Show manage button
      const manageBtn = document.createElement('button');
      manageBtn.className = 'btn btn-secondary';
      manageBtn.textContent = 'Manage Subscription';
      manageBtn.addEventListener('click', () => _openPortal());
      actionsEl.appendChild(manageBtn);

      if (plan === 'pro') {
        const upgradeBtn = document.createElement('button');
        upgradeBtn.className = 'btn btn-primary';
        upgradeBtn.textContent = 'Upgrade to Team';
        upgradeBtn.addEventListener('click', () => _startCheckout('team'));
        actionsEl.appendChild(upgradeBtn);
      }
    }
  } catch (err) {
    console.warn('[Settings] Failed to load plan:', err);
  }
}

async function _startCheckout(plan) {
  try {
    await sendMessage(MSG_TYPES.CREATE_CHECKOUT, {
      payload: { plan },
    });
    showToast('Opening Stripe checkout...', 'info');
  } catch (err) {
    showToast(err.message || 'Checkout failed', 'error');
  }
}

async function _openPortal() {
  try {
    await sendMessage(MSG_TYPES.OPEN_BILLING_PORTAL);
    showToast('Opening billing portal...', 'info');
  } catch (err) {
    showToast(err.message || 'Could not open billing portal', 'error');
  }
}
```

### Step 8: Add "Upgrade" Link to Popup

In `popup/popup.html`, add an upgrade banner (shown for free plan users), after the auth section:

```html
  <!-- Upgrade Banner (free plan only) -->
  <div class="upgrade-banner hidden" id="upgradeBanner">
    <span class="upgrade-text">Free plan — 5 rules max</span>
    <button class="upgrade-btn" id="upgradeBtn">Upgrade</button>
  </div>
```

In `popup/popup.css`:

```css
/* -------------------------------------------------------------------------- */
/*  Upgrade Banner                                                            */
/* -------------------------------------------------------------------------- */

.upgrade-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(249, 226, 175, 0.08);
  border-top: 1px solid rgba(249, 226, 175, 0.2);
  flex-shrink: 0;
}

.upgrade-text {
  font-size: 11px;
  color: #f9e2af;
}

.upgrade-btn {
  padding: 3px 10px;
  border: 1px solid #f9e2af;
  border-radius: 4px;
  background: transparent;
  color: #f9e2af;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.upgrade-btn:hover {
  background: rgba(249, 226, 175, 0.15);
}
```

In `popup/popup.js`:

```javascript
const $upgradeBanner = document.getElementById('upgradeBanner');
const $upgradeBtn    = document.getElementById('upgradeBtn');

// In refreshAuthState(), after rendering auth:
async function refreshPlanStatus() {
  try {
    const response = await sendMsg('GET_PLAN');
    const planData = response?.data || response;

    if (planData?.plan === 'free' && planData?.plan !== undefined) {
      $upgradeBanner.classList.remove('hidden');
    } else {
      $upgradeBanner.classList.add('hidden');
    }
  } catch {
    $upgradeBanner.classList.add('hidden');
  }
}

$upgradeBtn.addEventListener('click', async () => {
  try {
    await sendMsg('CREATE_CHECKOUT', { payload: { plan: 'pro' } });
  } catch (err) {
    console.warn('[NeuronPopup] Checkout failed:', err);
  }
});
```

### Step 9: Enable Raw Body for Stripe Webhooks

In `server/src/index.js`, register the `@fastify/raw-body` plugin (add to package.json and import):

Add to `package.json` dependencies: `"@fastify/raw-body": "^4.3.0"`

In `src/index.js`, after the `formbody` registration:

```javascript
import rawBody from '@fastify/raw-body';

await app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false, // Return Buffer
  runFirst: true,
});
```

In the webhook route, add `config: { rawBody: true }` to ensure the raw body is available.

## Files Summary

### New Files
None (all modifications to existing files and stubs).

### Modified Files
| File | Changes |
|------|---------|
| `server/src/config/index.js` | Add Stripe price IDs |
| `server/src/services/billing-service.js` | Replace stub with full Stripe implementation |
| `server/src/routes/billing.js` | Replace stub with checkout, portal, webhook, plan routes |
| `server/src/middleware/plan-middleware.js` | Replace stub with billing-service-backed enforcement |
| `server/src/index.js` | Add @fastify/raw-body plugin |
| `server/package.json` | Add @fastify/raw-body dependency |
| `shared/constants.js` | Add billing MSG_TYPES |
| `service-worker/message-router.js` | Add billing message handlers |
| `options/components/settings-panel.js` | Add billing section with plan info and upgrade buttons |
| `popup/popup.html` | Add upgrade banner |
| `popup/popup.js` | Add plan status check and upgrade button handler |
| `popup/popup.css` | Add upgrade banner styles |
| `server/.env.example` | Add STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM |

## Verification

1. **Setup Stripe Test Mode**: Create a Stripe account, get test API keys, create two Products with monthly Prices. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` in `.env`
2. **Start backend**: `cd server && npm run dev`
3. **Check plan endpoint**: `curl http://localhost:3001/billing/plan -H "Authorization: Bearer <token>"` -- expect `{"plan":"free","limits":{...}}`
4. **Free plan limits**: Create 5 rules via API. The 6th should return 403 with `Plan Limit Reached`
5. **Upgrade flow**: In the extension Settings panel, click "Upgrade to Pro". Verify a new tab opens with Stripe Checkout (test mode). Use Stripe test card `4242 4242 4242 4242`
6. **Webhook**: After payment, the webhook fires `checkout.session.completed`. Check that the user's plan is now `pro` in the database
7. **Pro limits**: After upgrade, verify rules limit is removed. Create more than 5 rules successfully
8. **Customer portal**: In Settings, click "Manage Subscription". Verify the Stripe Customer Portal opens in a new tab
9. **Cancel subscription**: In the portal, cancel the subscription. Verify the webhook fires `customer.subscription.deleted` and the user is downgraded to `free`
10. **Popup upgrade banner**: As a free-plan user, verify the yellow "Upgrade" banner appears in the popup. Clicking "Upgrade" opens Stripe checkout
11. **Stripe CLI for local webhook testing**: `stripe listen --forward-to localhost:3001/billing/webhook` + `stripe trigger checkout.session.completed`
