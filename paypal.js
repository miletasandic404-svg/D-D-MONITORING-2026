'use strict';

const { resolvePlanDefinition } = require('./lib/payment_catalog');

function getPayPalEnvironment() {
  return String(process.env.PAYPAL_ENVIRONMENT || 'live').toLowerCase();
}

function getPayPalApiBaseUrl() {
  if (process.env.PAYPAL_BASE_URL) {
    return process.env.PAYPAL_BASE_URL.replace(/\/$/, '');
  }

  return getPayPalEnvironment() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

function getPayPalCredentials() {
  const clientId = process.env.PAYPAL_LIVE_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_LIVE_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET || '';

  return { clientId, secret };
}

function getPayPalWebhookId() {
  return String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
}

function buildContactSummary({ district = '', contacts = {} } = {}) {
  const parts = [
    district ? `District: ${district}` : null,
    contacts.policeStation ? `Police: ${contacts.policeStation}` : null,
    contacts.fireService ? `Fire: ${contacts.fireService}` : null,
    contacts.ambulance ? `Ambulance: ${contacts.ambulance}` : null,
    contacts.localCommand ? `Command: ${contacts.localCommand}` : null,
  ].filter(Boolean);

  return parts.join(' | ');
}

async function getPayPalAccessToken() {
  const { clientId, secret } = getPayPalCredentials();
  if (!clientId || !secret) {
    throw new Error('Missing PayPal credentials');
  }

  const response = await fetch(`${getPayPalApiBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error_description || payload?.message || 'Unable to authenticate with PayPal');
  }

  return payload.access_token;
}

async function callPayPal(path, {
  method = 'GET',
  body = undefined,
  requestId = null,
} = {}) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${getPayPalApiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || payload?.details?.[0]?.issue || 'PayPal request failed');
  }

  return payload;
}

async function createPayPalOrder({
  plan,
  district,
  contacts,
  paypalRequestId,
}) {
  if (!plan) {
    throw new Error('Unsupported PayPal plan');
  }

  return callPayPal('/v2/checkout/orders', {
    method: 'POST',
    requestId: paypalRequestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: plan.id,
          custom_id: plan.id,
          description: `${plan.name} for ${district}`,
          amount: {
            currency_code: plan.currency,
            value: plan.amount,
          },
          soft_descriptor: plan.name.slice(0, 22),
        },
      ],
      application_context: {
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        brand_name: 'D&D Global AI Surveillance',
      },
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    },
  });
}

async function getPayPalOrder(orderId) {
  if (!orderId) {
    throw new Error('Missing PayPal order ID');
  }

  return callPayPal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

async function capturePayPalOrder(orderId, requestId = null) {
  if (!orderId) {
    throw new Error('Missing PayPal order ID');
  }

  return callPayPal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    requestId,
    body: {},
  });
}

async function verifyPayPalWebhookSignature({ headers, eventBody }) {
  const webhookId = getPayPalWebhookId();
  if (!webhookId) {
    throw new Error('Missing PayPal webhook id');
  }

  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const authAlgo = headers['paypal-auth-algo'];
  const certUrl = headers['paypal-cert-url'];

  if (!transmissionId || !transmissionTime || !transmissionSig || !authAlgo || !certUrl) {
    return false;
  }

  const verification = await callPayPal('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: eventBody,
    },
  });

  return String(verification?.verification_status || '').toUpperCase() === 'SUCCESS';
}

module.exports = {
  buildContactSummary,
  capturePayPalOrder,
  createPayPalOrder,
  getPayPalAccessToken,
  getPayPalApiBaseUrl,
  getPayPalCredentials,
  getPayPalEnvironment,
  getPayPalOrder,
  getPayPalWebhookId,
  resolvePlanDefinition,
  verifyPayPalWebhookSignature,
};
