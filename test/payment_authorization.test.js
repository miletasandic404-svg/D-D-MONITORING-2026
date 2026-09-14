'use strict';

/**
 * Focused regression tests for provider-confirmation ownership checks.
 * Provider calls are mocked; no real payment credentials or provider requests
 * are used.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/index');
const stripe = require('../stripe');
const paypal = require('../paypal');

const originalQueryAsPlatformAdmin = db.queryAsPlatformAdmin;
const originalStripeFetch = stripe.getStripePaymentIntent;
const originalPayPalFetch = paypal.getPayPalOrder;
const originalPayPalCapture = paypal.capturePayPalOrder;

let paymentRow = null;
let stripeFetchCalls = 0;
let paypalFetchCalls = 0;

db.queryAsPlatformAdmin = async (_text, params) => {
  if (params?.includes('pi-owned') || params?.includes('ORDER-owned')) {
    return { rows: paymentRow ? [paymentRow] : [] };
  }
  return { rows: [] };
};

stripe.getStripePaymentIntent = async () => {
  stripeFetchCalls += 1;
  return { id: 'pi-owned', status: 'succeeded', amount: 50000, amount_received: 50000, currency: 'USD', metadata: { planId: 'starter' } };
};
paypal.getPayPalOrder = async () => {
  paypalFetchCalls += 1;
  return { id: 'ORDER-owned', status: 'APPROVED', purchase_units: [{ custom_id: 'starter', amount: { value: '500', currency_code: 'USD' } }] };
};
paypal.capturePayPalOrder = async () => ({ status: 'COMPLETED', purchase_units: [{ custom_id: 'starter', payments: { captures: [{ id: 'CAP-1', amount: { value: '500', currency_code: 'USD' } }] } }] });

const service = require('../lib/payment_service');

function makePayment(overrides = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    user_id: 'user-a',
    organization_id: 'org-a',
    provider: 'stripe',
    provider_payment_id: 'pi-owned',
    provider_order_id: 'ORDER-owned',
    provider_capture_id: null,
    plan_id: 'starter',
    ...overrides,
  };
}

describe('payment provider confirmation ownership', () => {
  beforeEach(() => {
    paymentRow = makePayment();
    stripeFetchCalls = 0;
    paypalFetchCalls = 0;
  });

  test('Stripe confirmation denies a different organization before provider lookup', async () => {
    await assert.rejects(
      service.reconcileStripeIntent({
        paymentIntentId: 'pi-owned',
        auth: { userId: 'user-b', organizationId: 'org-b' },
      }),
      (err) => err.statusCode === 403,
    );
    assert.equal(stripeFetchCalls, 0);
  });

  test('PayPal capture denies a different organization before capture', async () => {
    await assert.rejects(
      service.capturePayPalCheckout({
        orderId: 'ORDER-owned',
        auth: { userId: 'user-b', organizationId: 'org-b' },
      }),
      (err) => err.statusCode === 403,
    );
    assert.equal(paypalFetchCalls, 0);
  });

  test('provider identifier without a local checkout record is denied', async () => {
    paymentRow = null;
    await assert.rejects(
      service.reconcileStripeIntent({
        paymentIntentId: 'pi-owned',
        auth: { userId: 'user-a', organizationId: 'org-a' },
      }),
      (err) => err.statusCode === 409,
    );
    assert.equal(stripeFetchCalls, 0);
  });
});

process.on('exit', () => {
  db.queryAsPlatformAdmin = originalQueryAsPlatformAdmin;
  stripe.getStripePaymentIntent = originalStripeFetch;
  paypal.getPayPalOrder = originalPayPalFetch;
  paypal.capturePayPalOrder = originalPayPalCapture;
});
