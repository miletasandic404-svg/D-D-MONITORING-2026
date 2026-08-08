'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db/index');
const { logAudit, logPlatformAudit, getIp } = require('./_audit');
const { makeLogger } = require('./_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('./_sentry');
const {
  getPlanAmountInMinorUnits,
  listPlanDefinitions,
  resolvePlanDefinition,
} = require('./payment_catalog');
const {
  createCardPaymentIntent,
  getStripePaymentIntent,
} = require('../stripe');
const {
  capturePayPalOrder,
  createPayPalOrder,
  getPayPalOrder,
} = require('../paypal');

const logger = makeLogger('payment-service');

initSentry();

const PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'cancelled', 'refunded', 'chargeback']);
const ACTIVATION_STATUSES = new Set(['pending', 'active', 'failed']);

const checkoutSchema = z.object({
  planId: z.string().trim().min(1).max(64),
  district: z.string().trim().min(1).max(120),
  contacts: z.object({
    policeStation: z.string().trim().min(1).max(120),
    fireService: z.string().trim().min(1).max(120),
    ambulance: z.string().trim().min(1).max(120),
    localCommand: z.string().trim().min(1).max(120),
  }),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const confirmStripeSchema = z.object({
  paymentIntentId: z.string().trim().min(1).max(200),
});

const capturePayPalSchema = z.object({
  orderId: z.string().trim().min(1).max(200),
});

const onboardingPaymentSchema = z.object({
  paymentId: z.string().uuid().optional(),
  planId: z.string().trim().min(1).max(64).optional(),
});

function buildCheckoutMetadata({ plan, district, contacts }) {
  return {
    planId: plan.id,
    planName: plan.name,
    district,
    policeStation: contacts.policeStation,
    fireService: contacts.fireService,
    ambulance: contacts.ambulance,
    localCommand: contacts.localCommand,
  };
}

function normalizeCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

function mapStripeStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'succeeded':
      return 'paid';
    case 'canceled':
      return 'cancelled';
    case 'requires_payment_method':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapPayPalStatus(status) {
  switch (String(status || '').toUpperCase()) {
    case 'COMPLETED':
      return 'paid';
    case 'VOIDED':
      return 'cancelled';
    case 'REFUNDED':
      return 'refunded';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

function computeNextRetryDate(attempts) {
  const delayMinutes = Math.min(60, Math.max(1, Math.pow(2, Math.max(0, attempts - 1))));
  return new Date(Date.now() + (delayMinutes * 60 * 1000));
}

function getRequestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function findPaymentByProviderIdentifiers(clientOrDb, {
  provider,
  providerPaymentId = null,
  providerOrderId = null,
  providerCaptureId = null,
}) {
  const queryable = clientOrDb || db;
  const { rows } = await queryable.query(
    `SELECT *
     FROM payment_transactions
     WHERE provider = $1
       AND (
         ($2::text IS NOT NULL AND provider_payment_id = $2)
         OR ($3::text IS NOT NULL AND provider_order_id = $3)
         OR ($4::text IS NOT NULL AND provider_capture_id = $4)
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [provider, providerPaymentId, providerOrderId, providerCaptureId],
  );
  return rows[0] || null;
}

async function upsertPaymentTransaction({
  provider,
  userId = null,
  organizationId = null,
  providerPaymentId = null,
  providerOrderId = null,
  providerCaptureId = null,
  planId,
  expectedAmount,
  paidAmount = null,
  currency,
  status = 'pending',
  activationStatus = 'pending',
  rawProviderPayload,
}) {
  if (!PAYMENT_STATUSES.has(status)) throw new Error(`Unsupported payment status: ${status}`);
  if (!ACTIVATION_STATUSES.has(activationStatus)) throw new Error(`Unsupported activation status: ${activationStatus}`);

  return db.transaction(async (client) => {
    const existing = await findPaymentByProviderIdentifiers(client, {
      provider,
      providerPaymentId,
      providerOrderId,
      providerCaptureId,
    });

    if (existing) {
      const { rows } = await client.query(
        `UPDATE payment_transactions
         SET user_id = COALESCE($2, user_id),
             organization_id = COALESCE($3, organization_id),
             provider_payment_id = COALESCE($4, provider_payment_id),
             provider_order_id = COALESCE($5, provider_order_id),
             provider_capture_id = COALESCE($6, provider_capture_id),
             plan_id = COALESCE($7, plan_id),
             expected_amount = COALESCE($8, expected_amount),
             paid_amount = COALESCE($9, paid_amount),
             currency = COALESCE($10, currency),
             status = CASE
               WHEN status IN ('refunded', 'chargeback', 'cancelled') THEN status
               ELSE $11
             END,
             activation_status = $12,
             -- Merge rather than overwrite: later calls (capture/reconcile)
             -- only carry the provider's response for that step, and would
             -- otherwise wipe out fields recorded on an earlier step (e.g.
             -- the checkout-time contacts/district snapshot).
             raw_provider_payload = COALESCE(raw_provider_payload, '{}'::jsonb) || $13::jsonb,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          existing.id,
          userId,
          organizationId,
          providerPaymentId,
          providerOrderId,
          providerCaptureId,
          planId,
          expectedAmount,
          paidAmount,
          currency,
          status,
          activationStatus,
          JSON.stringify(rawProviderPayload || {}),
        ],
      );
      return rows[0];
    }

    const { rows } = await client.query(
      `INSERT INTO payment_transactions (
         user_id,
         organization_id,
         provider,
         provider_payment_id,
         provider_order_id,
         provider_capture_id,
         plan_id,
         expected_amount,
         paid_amount,
         currency,
         status,
         activation_status,
         raw_provider_payload
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING *`,
      [
        userId,
        organizationId,
        provider,
        providerPaymentId,
        providerOrderId,
        providerCaptureId,
        planId,
        expectedAmount,
        paidAmount,
        currency,
        status,
        activationStatus,
        JSON.stringify(rawProviderPayload || {}),
      ],
    );
    return rows[0];
  });
}

async function getPaymentById(paymentId) {
  const { rows } = await db.query(
    `SELECT *
     FROM payment_transactions
     WHERE id = $1
     LIMIT 1`,
    [paymentId],
  );
  return rows[0] || null;
}

async function markActivationFailure({ paymentId, organizationId = null, errorMessage, userId = null, ipAddress = null }) {
  const payment = await getPaymentById(paymentId);
  if (!payment) return null;

  const attempts = Number(payment.activation_attempts || 0) + 1;
  const nextRetryAt = computeNextRetryDate(attempts);
  const { rows } = await db.query(
    `UPDATE payment_transactions
     SET organization_id = COALESCE($2, organization_id),
         activation_status = 'failed',
         activation_attempts = $3,
         next_activation_retry_at = $4,
         last_activation_error = $5,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [paymentId, organizationId, attempts, nextRetryAt.toISOString(), String(errorMessage || 'Activation failed')],
  );

  const metadata = {
    paymentId,
    attempt: attempts,
    error: String(errorMessage || 'Activation failed'),
    nextRetryAt: nextRetryAt.toISOString(),
  };

  if (organizationId) {
    await logAudit({
      organizationId,
      userId,
      action: 'org.plan_activation_failed',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata,
      ipAddress,
    });
  } else {
    await logPlatformAudit({
      userId,
      action: 'org.plan_activation_failed',
      resourceType: 'payment',
      resourceId: paymentId,
      metadata,
      ipAddress,
    });
  }

  return rows[0] || null;
}

async function activatePaymentForOrganization({
  paymentId,
  organizationId,
  userId = null,
  req = null,
}) {
  const payment = await getPaymentById(paymentId);
  if (!payment) {
    const err = new Error('Payment record not found');
    err.statusCode = 404;
    throw err;
  }

  if (payment.status !== 'paid') {
    const err = new Error('Payment is not completed');
    err.statusCode = 409;
    throw err;
  }

  if (payment.activated_organization_id && payment.activated_organization_id !== organizationId) {
    const err = new Error('This payment already activated another organization');
    err.statusCode = 409;
    throw err;
  }

  if (payment.activation_status === 'active' && payment.activated_organization_id === organizationId) {
    return payment;
  }

  const plan = resolvePlanDefinition(payment.plan_id);
  if (!plan) {
    await markActivationFailure({
      paymentId,
      organizationId,
      errorMessage: `Unsupported plan for activation: ${payment.plan_id}`,
      userId,
      ipAddress: req ? getIp(req) : null,
    });
    throw new Error('Unsupported plan for activation');
  }

  try {
    const updatedPayment = await db.transaction(async (client) => {
      const { rows: lockRows } = await client.query(
        `SELECT *
         FROM payment_transactions
         WHERE id = $1
         FOR UPDATE`,
        [paymentId],
      );
      const locked = lockRows[0];
      if (!locked) throw new Error('Payment record not found');

      if (locked.activated_organization_id && locked.activated_organization_id !== organizationId) {
        const err = new Error('This payment already activated another organization');
        err.statusCode = 409;
        throw err;
      }

      if (locked.activation_status === 'active' && locked.activated_organization_id === organizationId) {
        return locked;
      }

      await client.query(
        `UPDATE organizations
         SET plan_tier = $2,
             status = 'active',
             camera_limit = $3,
             site_limit = $4,
             updated_at = now()
         WHERE id = $1`,
        [organizationId, plan.id, plan.limits.camera_limit, plan.limits.site_limit],
      );

      const attempts = Number(locked.activation_attempts || 0) + 1;
      const { rows } = await client.query(
        `UPDATE payment_transactions
         SET organization_id = $2,
             activated_organization_id = $2,
             activation_status = 'active',
             activation_attempts = $3,
             next_activation_retry_at = NULL,
             last_activation_error = NULL,
             activated_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [paymentId, organizationId, attempts],
      );
      return rows[0];
    });

    if (userId) {
      await logAudit({
        organizationId,
        userId,
        action: 'org.plan_activated',
        resourceType: 'organization',
        resourceId: organizationId,
        metadata: {
          paymentId,
          provider: updatedPayment.provider,
          provider_payment_id: updatedPayment.provider_payment_id,
          provider_order_id: updatedPayment.provider_order_id,
          planId: updatedPayment.plan_id,
        },
        ipAddress: req ? getIp(req) : null,
      });
    }

    return updatedPayment;
  } catch (err) {
    await markActivationFailure({
      paymentId,
      organizationId,
      errorMessage: err.message,
      userId,
      ipAddress: req ? getIp(req) : null,
    });
    throw err;
  }
}

async function createStripeCheckout({ auth = null, body = {} }) {
  const checkout = checkoutSchema.parse(body || {});
  const plan = resolvePlanDefinition(checkout.planId);
  if (!plan) {
    const err = new Error('Unsupported card payment plan');
    err.statusCode = 400;
    throw err;
  }

  const idempotencyKey = checkout.idempotencyKey || getRequestId(`stripe-${plan.id}`);
  const metadata = buildCheckoutMetadata({ plan, district: checkout.district, contacts: checkout.contacts });
  const payload = await createCardPaymentIntent({
    plan,
    district: checkout.district,
    contacts: checkout.contacts,
    metadata,
    idempotencyKey,
  });

  const payment = await upsertPaymentTransaction({
    provider: 'stripe',
    userId: auth?.userId || null,
    organizationId: auth?.organizationId || null,
    providerPaymentId: payload.id,
    providerCaptureId: payload.latest_charge || null,
    planId: plan.id,
    expectedAmount: getPlanAmountInMinorUnits(plan),
    paidAmount: payload.amount_received || null,
    currency: normalizeCurrency(payload.currency || plan.currency),
    status: mapStripeStatus(payload.status),
    activationStatus: 'pending',
    // Stripe echoes `metadata` back on the payment intent, but we don't
    // want provider payload shape to be the only place this lives (see
    // the equivalent PayPal path below) -- store it explicitly too.
    rawProviderPayload: { ...payload, _checkout_contacts: checkout.contacts, _checkout_district: checkout.district },
  });

  return {
    paymentId: payment.id,
    id: payload.id,
    client_secret: payload.client_secret,
    status: payload.status,
    amount: payload.amount,
    currency: payload.currency,
    planId: plan.id,
    idempotencyKey,
  };
}

async function reconcileStripeIntent({
  paymentIntentId,
  auth = null,
  req = null,
}) {
  const parsed = confirmStripeSchema.parse({ paymentIntentId });
  const paymentIntent = await getStripePaymentIntent(parsed.paymentIntentId);
  const planId = String(paymentIntent.metadata?.planId || '').trim().toLowerCase();
  const plan = resolvePlanDefinition(planId);

  if (!plan) {
    const err = new Error('Stripe payment intent metadata is missing a supported plan');
    err.statusCode = 409;
    throw err;
  }

  const expectedAmount = getPlanAmountInMinorUnits(plan);
  const actualAmount = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const actualCurrency = normalizeCurrency(paymentIntent.currency);
  if (actualAmount !== expectedAmount || actualCurrency !== normalizeCurrency(plan.currency)) {
    const err = new Error('Stripe payment intent amount or currency does not match the server catalog');
    err.statusCode = 409;
    throw err;
  }

  const payment = await upsertPaymentTransaction({
    provider: 'stripe',
    userId: auth?.userId || null,
    organizationId: auth?.organizationId || null,
    providerPaymentId: paymentIntent.id,
    providerCaptureId: paymentIntent.latest_charge || null,
    planId: plan.id,
    expectedAmount,
    paidAmount: actualAmount,
    currency: actualCurrency,
    status: mapStripeStatus(paymentIntent.status),
    activationStatus: 'pending',
    rawProviderPayload: paymentIntent,
  });

  if (paymentIntent.status !== 'succeeded') {
    const err = new Error(`Stripe payment is ${paymentIntent.status || 'not completed'}`);
    err.statusCode = 409;
    throw err;
  }

  let activationStatus = payment.activation_status;
  if (auth?.organizationId) {
    const activated = await activatePaymentForOrganization({
      paymentId: payment.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      req,
    });
    activationStatus = activated.activation_status;
  }

  return {
    paymentId: payment.id,
    id: paymentIntent.id,
    status: paymentIntent.status,
    activationStatus,
    planId: plan.id,
  };
}

function extractApprovedPayPalUnit(orderLikePayload) {
  const unit = orderLikePayload?.purchase_units?.[0] || {};
  const captures = unit?.payments?.captures || [];
  const firstCapture = captures[0] || null;
  return {
    unit,
    capture: firstCapture,
    customId: String(unit.custom_id || unit.reference_id || '').trim().toLowerCase(),
    amountValue: String(firstCapture?.amount?.value || unit?.amount?.value || '').trim(),
    currency: normalizeCurrency(firstCapture?.amount?.currency_code || unit?.amount?.currency_code),
  };
}

async function createPayPalCheckout({ auth = null, body = {} }) {
  const checkout = checkoutSchema.parse(body || {});
  const plan = resolvePlanDefinition(checkout.planId);
  if (!plan) {
    const err = new Error('Unsupported PayPal plan');
    err.statusCode = 400;
    throw err;
  }

  const paypalRequestId = checkout.idempotencyKey || getRequestId(`paypal-${plan.id}`);
  const payload = await createPayPalOrder({
    plan,
    district: checkout.district,
    contacts: checkout.contacts,
    paypalRequestId,
  });

  const payment = await upsertPaymentTransaction({
    provider: 'paypal',
    userId: auth?.userId || null,
    organizationId: auth?.organizationId || null,
    providerOrderId: payload.id,
    planId: plan.id,
    expectedAmount: getPlanAmountInMinorUnits(plan),
    currency: normalizeCurrency(plan.currency),
    status: mapPayPalStatus(payload.status),
    activationStatus: 'pending',
    // PayPal doesn't echo back arbitrary metadata the way Stripe does,
    // so the full contact record has to be attached explicitly here --
    // otherwise it's only ever visible as a truncated, 127-char summary
    // inside the PayPal order description (see paypal.js).
    rawProviderPayload: { ...payload, _checkout_contacts: checkout.contacts, _checkout_district: checkout.district },
  });

  return {
    paymentId: payment.id,
    id: payload.id,
    status: payload.status,
    planId: plan.id,
    paypalRequestId,
    links: payload.links || [],
  };
}

async function capturePayPalCheckout({
  auth = null,
  orderId,
  req = null,
}) {
  const parsed = capturePayPalSchema.parse({ orderId });
  const order = await getPayPalOrder(parsed.orderId);
  const planId = String(order?.purchase_units?.[0]?.custom_id || order?.purchase_units?.[0]?.reference_id || '').trim().toLowerCase();
  const plan = resolvePlanDefinition(planId);
  if (!plan) {
    const err = new Error('PayPal order does not reference a supported plan');
    err.statusCode = 409;
    throw err;
  }

  const orderAmount = Math.round(Number.parseFloat(order?.purchase_units?.[0]?.amount?.value || plan.amount) * 100);
  const orderCurrency = normalizeCurrency(order?.purchase_units?.[0]?.amount?.currency_code || plan.currency);
  if (orderAmount !== getPlanAmountInMinorUnits(plan) || orderCurrency !== normalizeCurrency(plan.currency)) {
    const err = new Error('PayPal order does not match the server-side plan pricing');
    err.statusCode = 409;
    throw err;
  }

  const capture = await capturePayPalOrder(parsed.orderId, getRequestId(`paypal-capture-${plan.id}`));
  const approved = extractApprovedPayPalUnit(capture);
  const expectedAmount = getPlanAmountInMinorUnits(plan);
  const paidAmount = Math.round(Number.parseFloat(approved.amountValue || plan.amount) * 100);
  if (approved.customId !== plan.id || paidAmount !== expectedAmount || approved.currency !== normalizeCurrency(plan.currency)) {
    const err = new Error('PayPal capture does not match the server-side order catalog');
    err.statusCode = 409;
    throw err;
  }

  const payment = await upsertPaymentTransaction({
    provider: 'paypal',
    userId: auth?.userId || null,
    organizationId: auth?.organizationId || null,
    providerOrderId: parsed.orderId,
    providerCaptureId: approved.capture?.id || null,
    planId: plan.id,
    expectedAmount,
    paidAmount,
    currency: approved.currency,
    status: mapPayPalStatus(capture.status),
    activationStatus: 'pending',
    rawProviderPayload: capture,
  });

  if (capture.status !== 'COMPLETED') {
    const err = new Error(`PayPal order is ${capture.status || 'not completed'}`);
    err.statusCode = 409;
    throw err;
  }

  let activationStatus = payment.activation_status;
  if (auth?.organizationId) {
    const activated = await activatePaymentForOrganization({
      paymentId: payment.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
      req,
    });
    activationStatus = activated.activation_status;
  }

  return {
    paymentId: payment.id,
    id: approved.capture?.id || parsed.orderId,
    orderId: parsed.orderId,
    status: capture.status,
    activationStatus,
    planId: plan.id,
  };
}

async function ensureValidOnboardingPayment({
  paymentId = null,
  planId = null,
  organizationId = null,
  userId = null,
  req = null,
}) {
  const parsed = onboardingPaymentSchema.parse({
    paymentId: paymentId || undefined,
    planId: planId || undefined,
  });

  if (!parsed.paymentId) {
    if (parsed.planId && resolvePlanDefinition(parsed.planId)?.free) {
      return {
        planId: parsed.planId,
        payment: null,
      };
    }

    const err = new Error('Paid plans require a valid payment record');
    err.statusCode = 400;
    throw err;
  }

  const payment = await getPaymentById(parsed.paymentId);
  if (!payment) {
    const err = new Error('Payment record not found');
    err.statusCode = 404;
    throw err;
  }

  const plan = resolvePlanDefinition(payment.plan_id);
  if (!plan) {
    const err = new Error('Payment record references an unsupported plan');
    err.statusCode = 409;
    throw err;
  }

  if (payment.status !== 'paid') {
    const err = new Error('Payment record is not completed');
    err.statusCode = 409;
    throw err;
  }

  if (parsed.planId && parsed.planId !== payment.plan_id) {
    const err = new Error('Requested plan does not match the payment record');
    err.statusCode = 409;
    throw err;
  }

  if (organizationId) {
    const activated = await activatePaymentForOrganization({
      paymentId: payment.id,
      organizationId,
      userId,
      req,
    });
    return {
      planId: activated.plan_id,
      payment: activated,
    };
  }

  return {
    planId: payment.plan_id,
    payment,
  };
}

async function retryPendingActivations({ organizationId, userId = null, req = null, limit = 10 }) {
  const { rows } = await db.query(
    `SELECT id
     FROM payment_transactions
     WHERE status = 'paid'
       AND organization_id = $1
       AND activation_status IN ('pending', 'failed')
       AND (next_activation_retry_at IS NULL OR next_activation_retry_at <= now())
     ORDER BY updated_at ASC
     LIMIT $2`,
    [organizationId, limit],
  );

  const results = [];
  for (const row of rows) {
    try {
      const payment = await activatePaymentForOrganization({
        paymentId: row.id,
        organizationId,
        userId,
        req,
      });
      results.push({ paymentId: row.id, activationStatus: payment.activation_status });
    } catch (err) {
      results.push({ paymentId: row.id, activationStatus: 'failed', error: err.message });
    }
  }
  return results;
}

/**
 * Called when a provider reports a payment has been refunded.
 * If the payment was already used to activate an organisation, the
 * organisation is suspended and its plan limits zeroed so that no new
 * cameras or sites can be added until the account is manually reviewed.
 * Access is revoked immediately (one-time purchase model – no grace period).
 */
async function handleRefundedActivation({
  provider,
  providerPaymentId = null,
  providerOrderId = null,
  providerCaptureId = null,
}) {
  const payment = await findPaymentByProviderIdentifiers(null, {
    provider,
    providerPaymentId,
    providerOrderId,
    providerCaptureId,
  });

  if (!payment) return null;
  if (payment.activation_status !== 'active') return null;

  const orgId = payment.activated_organization_id;
  if (!orgId) return null;

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE organizations
       SET plan_tier = 'free',
           status = 'suspended',
           camera_limit = 0,
           site_limit = 0,
           updated_at = now()
       WHERE id = $1`,
      [orgId],
    );
  });

  await logAudit({
    organizationId: orgId,
    userId: null,
    action: 'org.plan_suspended_refund',
    resourceType: 'organization',
    resourceId: orgId,
    metadata: {
      paymentId: payment.id,
      provider: payment.provider,
      planId: payment.plan_id,
    },
    ipAddress: null,
  });

  return payment;
}

async function getSubscriptionState(auth) {
  if (!auth?.organizationId) {
    return {
      plans: listPlanDefinitions(),
      subscription: null,
      payments: [],
    };
  }

  await retryPendingActivations({
    organizationId: auth.organizationId,
    userId: auth.userId,
  });

  const [{ rows: orgRows }, { rows: paymentRows }] = await Promise.all([
    db.query(
      `SELECT id, name, plan_tier, status, camera_limit, site_limit, onboarding_completed
       FROM organizations
       WHERE id = $1
       LIMIT 1`,
      [auth.organizationId],
    ),
    db.query(
      `SELECT id, provider, provider_payment_id, provider_order_id, provider_capture_id,
              plan_id, expected_amount, paid_amount, currency, status, activation_status,
              activated_organization_id, created_at, updated_at
       FROM payment_transactions
       WHERE organization_id = $1 OR activated_organization_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [auth.organizationId],
    ),
  ]);

  const organization = orgRows[0] || null;
  const currentPlan = organization ? resolvePlanDefinition(organization.plan_tier) : null;
  return {
    plans: listPlanDefinitions(),
    subscription: organization ? {
      organizationId: organization.id,
      organizationName: organization.name,
      planId: organization.plan_tier,
      planName: currentPlan?.name || organization.plan_tier,
      status: organization.status,
      onboardingCompleted: organization.onboarding_completed,
      limits: currentPlan?.limits || null,
      features: currentPlan?.features || null,
    } : null,
    payments: paymentRows,
  };
}


/**
 * Platform-wide version of retryPendingActivations.  Scans ALL
 * organisations for paid-but-unactivated payment records whose
 * next_activation_retry_at has elapsed and attempts to activate each
 * one.  Designed for use by the pending-activation background worker
 * which runs on a schedule and covers organisations whose users never
 * returned to trigger the per-org retry on status/onboarding routes.
 *
 * Uses queryAsPlatformAdmin to bypass RLS.
 */
async function retryAllPendingActivations({ userId = null, req = null, limit = 100 } = {}) {
  const { rows } = await db.queryAsPlatformAdmin(
    `SELECT id, organization_id
     FROM payment_transactions
     WHERE status = 'paid'
       AND activation_status IN ('pending', 'failed')
       AND (next_activation_retry_at IS NULL OR next_activation_retry_at <= now())
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit],
  );

  const results = [];
  for (const row of rows) {
    try {
      const payment = await activatePaymentForOrganization({
        paymentId: row.id,
        organizationId: row.organization_id,
        userId,
        req,
      });
      results.push({ paymentId: row.id, organizationId: row.organization_id, activationStatus: payment.activation_status });
    } catch (err) {
      logger.error('Failed to activate payment in retry loop', { payment_id: row.id, organization_id: row.organization_id, error: err.message });
      Sentry.captureException(err);
      results.push({ paymentId: row.id, organizationId: row.organization_id, activationStatus: 'failed', error: err.message });
    }
  }
  return results;
}

module.exports = {
  activatePaymentForOrganization,
  capturePayPalCheckout,
  createPayPalCheckout,
  createStripeCheckout,
  ensureValidOnboardingPayment,
  findPaymentByProviderIdentifiers,
  getPaymentById,
  getRequestId,
  getSubscriptionState,
  handleRefundedActivation,
  mapPayPalStatus,
  mapStripeStatus,
  reconcileStripeIntent,
  retryAllPendingActivations,
  retryPendingActivations,
  upsertPaymentTransaction,
};
