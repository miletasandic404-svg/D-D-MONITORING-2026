'use strict';

const { getSessionFromRequest } = require('../lib/auth');
const { sendError, sendSuccess } = require('../lib/_error');
const {
  createPayPalCheckout,
  capturePayPalCheckout,
  findPaymentByProviderIdentifiers,
  handleRefundedActivation,
  upsertPaymentTransaction,
} = require('../lib/payment_service');
const { verifyPayPalWebhookSignature } = require('../paypal');

async function getOptionalSession(req) {
  try {
    return await getSessionFromRequest(req);
  } catch {
    return null;
  }
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
  const path = String(req.query.path || '').trim().toLowerCase();

  try {
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
      return sendError(res, 405, 'Method Not Allowed. Use POST /api/paypal/orders.');
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
  } catch (err) {
    console.error('PayPal API error:', err.message);
    return sendError(res, err.statusCode || 500, err.message);
  }
};
