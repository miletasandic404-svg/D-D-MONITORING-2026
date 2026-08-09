'use strict';

const { getSessionFromRequest } = require('../lib/auth');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const { listPlanDefinitions } = require('../lib/payment_catalog');
const {
  createStripeCheckout,
  createPayPalCheckout,
  capturePayPalCheckout,
  findPaymentByProviderIdentifiers,
  getSubscriptionState,
  handleRefundedActivation,
  mapStripeStatus,
  reconcileStripeIntent,
  retryPendingActivations,
  upsertPaymentTransaction,
} = require('../lib/payment_service');
const { verifyStripeWebhookSignature } = require('../stripe');
const { verifyPayPalWebhookSignature } = require('../paypal');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('api-payments');

initSentry();

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

async function readEventBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return JSON.parse(req.body || '{}');
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  const provider = String(req.query.provider || '').trim().toLowerCase();
  const path = String(req.query.path || '').trim().toLowerCase();

  // Webhook deliveries come from Stripe/PayPal's own servers and are
  // authenticated via signature verification below, not by IP -- rate
  // limiting them would risk dropping legitimate provider retries (and
  // an attacker can't forge a valid signature anyway, so it adds no
  // protection). Every other route, including the anonymous
  // checkout/intent/confirm endpoints (auth is intentionally optional
  // there, to support paying before signing up), gets IP-based limiting.
  if (path !== 'webhook') {
    if (!(await rateLimit(req, res))) return;
  }

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

    if (provider === 'paypal') {
      // PayPal endpoints
      if (path === 'webhook') {
        if (req.method !== 'POST') {
          return sendError(res, 405, 'Method Not Allowed');
        }

        const eventBody = await readEventBody(req);
        const verified = await verifyPayPalWebhookSignature({
          headers: req.headers,
          eventBody,
        });
        if (!verified) {
          return sendError(res, 400, 'Invalid PayPal webhook signature');
        }

        const resource = eventBody.resource || {};
        const existing = await findPaymentByProviderIdentifiers(null, {
          provider: 'paypal',
          providerOrderId: resource.supplementary_data?.related_ids?.order_id || resource.id || null,
          providerCaptureId: resource.id || null,
        });
        const unit = resource.purchase_units?.[0] || resource.supplementary_data?.related_ids || {};
        const planId = String(resource.custom_id || unit.custom_id || unit.reference_id || existing?.plan_id || '').trim().toLowerCase() || null;
        const amountValue = String(
          resource.amount?.value
            || resource.seller_receivable_breakdown?.gross_amount?.value
            || resource.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value
            || '',
        ).trim();
        const currency = String(
          resource.amount?.currency_code
            || resource.seller_receivable_breakdown?.gross_amount?.currency_code
            || resource.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code
            || 'USD',
        ).toUpperCase();

        if (eventBody.event_type === 'PAYMENT.CAPTURE.COMPLETED'
          || eventBody.event_type === 'PAYMENT.CAPTURE.REFUNDED'
          || eventBody.event_type === 'CHECKOUT.ORDER.APPROVED') {
          await upsertPaymentTransaction({
            provider: 'paypal',
            providerOrderId: resource.supplementary_data?.related_ids?.order_id || resource.id || null,
            providerCaptureId: resource.id || null,
            planId: planId || 'pending_review',
            expectedAmount: amountValue ? Math.round(Number.parseFloat(amountValue) * 100) : Number(existing?.expected_amount || 0),
            paidAmount: amountValue ? Math.round(Number.parseFloat(amountValue) * 100) : 0,
            currency: currency || existing?.currency || 'USD',
            status: eventBody.event_type === 'PAYMENT.CAPTURE.REFUNDED'
              ? 'refunded'
              : eventBody.event_type === 'CHECKOUT.ORDER.APPROVED'
                ? 'pending'
                : 'paid',
            activationStatus: existing?.activation_status || 'pending',
            rawProviderPayload: eventBody,
          });

          if (eventBody.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
            await handleRefundedActivation({
              provider: 'paypal',
              providerOrderId: resource.supplementary_data?.related_ids?.order_id || resource.id || null,
              providerCaptureId: resource.id || null,
            });
          }
        }

        return sendSuccess(res, { received: true });
      }

      if (req.method !== 'POST') {
        return sendError(res, 405, 'Method Not Allowed. Use POST /api/payments?provider=paypal');
      }

      const auth = await getOptionalSession(req);

      if (req.query.orderId) {
        const capture = await capturePayPalCheckout({
          auth,
          orderId: String(req.query.orderId || '').trim(),
          req,
        });
        return sendSuccess(res, capture);
      }

      const order = await createPayPalCheckout({ auth, body: req.body || {} });
      return sendSuccess(res, order, 201);
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
    logger.error('Payments API error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, err.statusCode || 500, err.message);
  }
};
