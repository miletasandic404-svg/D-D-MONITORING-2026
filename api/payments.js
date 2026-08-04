'use strict';

const { getSessionFromRequest } = require('../lib/auth');
const { sendError, sendSuccess } = require('../lib/_error');
const { listPlanDefinitions } = require('../lib/payment_catalog');
const {
  createStripeCheckout,
  findPaymentByProviderIdentifiers,
  getSubscriptionState,
  handleRefundedActivation,
  mapStripeStatus,
  reconcileStripeIntent,
  retryPendingActivations,
  upsertPaymentTransaction,
} = require('../lib/payment_service');
const { verifyStripeWebhookSignature } = require('../stripe');

async function getOptionalSession(req) {
  try {
    return await getSessionFromRequest(req);
  } catch {
    return null;
  }
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async (req, res) => {
  const provider = String(req.query.provider || '').trim().toLowerCase();
  const path = String(req.query.path || '').trim().toLowerCase();

  try {
    if (req.method === 'GET' && path === 'catalog') {
      return sendSuccess(res, { plans: listPlanDefinitions() });
    }

    if (req.method === 'GET' && path === 'status') {
      const auth = await getOptionalSession(req);
      if (!auth) {
        return sendError(res, 401, 'Authentication required');
      }
      const state = await getSubscriptionState(auth);
      return sendSuccess(res, state);
    }

    if (req.method === 'POST' && path === 'retry') {
      const auth = await getOptionalSession(req);
      if (!auth?.organizationId) {
        return sendError(res, 401, 'Authentication required');
      }
      const retried = await retryPendingActivations({
        organizationId: auth.organizationId,
        userId: auth.userId,
        req,
      });
      return sendSuccess(res, { retried });
    }

    if (provider !== 'card') {
      return sendError(res, 404, 'Unknown payment provider');
    }

    if (path === 'webhook') {
      if (req.method !== 'POST') {
        return sendError(res, 405, 'Method Not Allowed');
      }

      const rawBody = await readRawBody(req);
      const signature = req.headers['stripe-signature'];
      if (!verifyStripeWebhookSignature(rawBody, signature)) {
        return sendError(res, 400, 'Invalid Stripe webhook signature');
      }

      const event = JSON.parse(rawBody || '{}');
      const object = event?.data?.object || {};
      const existing = await findPaymentByProviderIdentifiers(null, {
        provider: 'stripe',
        providerPaymentId: object.payment_intent || object.id || null,
        providerCaptureId: object.latest_charge || object.id || null,
      });
      const planId = String(object?.metadata?.planId || existing?.plan_id || '').trim().toLowerCase();
      const plan = listPlanDefinitions().find((item) => item.id === planId);

      if (event.type === 'payment_intent.succeeded'
        || event.type === 'payment_intent.payment_failed'
        || event.type === 'charge.refunded') {
        await upsertPaymentTransaction({
          provider: 'stripe',
          providerPaymentId: object.payment_intent || object.id || null,
          providerCaptureId: object.latest_charge || object.id || null,
          planId: plan?.id || planId || existing?.plan_id || 'pending_review',
          expectedAmount: plan ? Math.round(Number.parseFloat(plan.amount) * 100) : Number(existing?.expected_amount || object.amount || 0),
          paidAmount: Number(object.amount_received || object.amount_refunded || object.amount || 0),
          currency: String(object.currency || plan?.currency || existing?.currency || 'USD').toUpperCase(),
          status: event.type === 'charge.refunded'
            ? 'refunded'
            : mapStripeStatus(object.status || (event.type === 'payment_intent.payment_failed' ? 'requires_payment_method' : 'succeeded')),
          activationStatus: existing?.activation_status || 'pending',
          rawProviderPayload: event,
        });

        if (event.type === 'charge.refunded') {
          await handleRefundedActivation({
            provider: 'stripe',
            providerPaymentId: object.payment_intent || object.id || null,
            providerCaptureId: object.latest_charge || object.id || null,
          });
        }
      }

      return sendSuccess(res, { received: true });
    }

    if (req.method !== 'POST') {
      return sendError(res, 405, 'Method Not Allowed');
    }

    const auth = await getOptionalSession(req);

    if (path === 'intent') {
      const intent = await createStripeCheckout({ auth, body: req.body || {} });
      return sendSuccess(res, intent, 201);
    }

    if (path === 'confirm') {
      const confirmation = await reconcileStripeIntent({
        paymentIntentId: req.body?.paymentIntentId,
        auth,
        req,
      });
      return sendSuccess(res, confirmation);
    }

    return sendError(res, 404, 'Unknown payment action');
  } catch (err) {
    console.error('Payments API error:', err.message);
    return sendError(res, err.statusCode || 500, err.message);
  }
};
