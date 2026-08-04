'use strict';

const crypto = require('crypto');
const { getPlanAmountInMinorUnits } = require('./lib/payment_catalog');

function getStripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function getStripeWebhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
}

function getStripeApiBaseUrl() {
  return String(process.env.STRIPE_API_BASE_URL || 'https://api.stripe.com').replace(/\/$/, '');
}

async function callStripe(path, { method = 'POST', params = null, headers = {} } = {}) {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    throw new Error('Missing Stripe secret key');
  }

  const response = await fetch(`${getStripeApiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer ' + secretKey,
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: method === 'POST' && params
      ? new URLSearchParams(params).toString()
      : undefined,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Stripe request failed');
  }

  return payload;
}

async function getStripePaymentIntent(paymentIntentId) {
  if (!paymentIntentId) {
    throw new Error('Missing Stripe payment intent ID');
  }

  return callStripe(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`, {
    method: 'GET',
  });
}

async function createCardPaymentIntent({
  plan,
  district,
  contacts,
  metadata = {},
  idempotencyKey,
}) {
  if (!plan) {
    throw new Error('Missing plan definition');
  }

  const params = new URLSearchParams();
  params.set('amount', String(getPlanAmountInMinorUnits(plan)));
  params.set('currency', String(plan.currency || 'USD').toLowerCase());
  params.append('automatic_payment_methods[enabled]', 'true');
  params.set('description', `${plan.name} for ${district}`);
  params.set('metadata[planId]', plan.id);
  params.set('metadata[planName]', plan.name);
  params.set('metadata[district]', district);
  params.set('metadata[policeStation]', String(contacts.policeStation || ''));
  params.set('metadata[fireService]', String(contacts.fireService || ''));
  params.set('metadata[ambulance]', String(contacts.ambulance || ''));
  params.set('metadata[localCommand]', String(contacts.localCommand || ''));

  for (const [key, value] of Object.entries(metadata || {})) {
    if (!params.has(`metadata[${key}]`)) {
      params.set(`metadata[${key}]`, String(value || ''));
    }
  }

  return callStripe('/v1/payment_intents', {
    method: 'POST',
    params,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  });
}

// Stripe recommends rejecting events older than 5 minutes to prevent replay attacks.
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = getStripeWebhookSecret();
  if (!webhookSecret) {
    throw new Error('Missing Stripe webhook secret');
  }

  const header = String(signatureHeader || '').trim();
  if (!header) {
    return false;
  }

  // Parse all key=value pairs. Collect ALL v1= entries to support Stripe
  // key rotation, where two v1= signatures may appear in a single header.
  let timestamp = null;
  const v1Signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') v1Signatures.push(value);
  }

  if (!timestamp || v1Signatures.length === 0) {
    return false;
  }

  // Reject events outside the tolerance window to prevent replay attacks.
  const eventTime = parseInt(timestamp, 10);
  if (!Number.isFinite(eventTime)
    || Math.abs(Date.now() / 1000 - eventTime) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected);
  return v1Signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(expectedBuf, Buffer.from(sig));
    } catch {
      return false;
    }
  });
}

module.exports = {
  createCardPaymentIntent,
  getStripeApiBaseUrl,
  getStripePaymentIntent,
  getStripeSecretKey,
  verifyStripeWebhookSignature,
};
