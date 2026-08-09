'use strict';

/**
 * Focused tests for the rate-limiting wiring added to api/payments.js.
 *
 * Not a full re-test of the payment flows (those are covered separately
 * in test/payment.test.js at the lib/payment_service.js level) -- this
 * only verifies:
 *   1. Every non-webhook route calls rateLimit() and honors a 429.
 *   2. Webhook routes (Stripe/PayPal signature-verified callbacks) are
 *      NOT subject to rate limiting, since the caller is the provider's
 *      own server and rate limiting there would risk dropping
 *      legitimate delivery retries.
 *
 * All external dependencies are faked before requiring the module under
 * test, so no real DB/session/vendor call happens.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake rate limiter (the thing under test) ──────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
let rateLimitAllowed = true;
let rateLimitCallCount = 0;
rateLimitModule.rateLimit = async (_req, res) => {
  rateLimitCallCount += 1;
  if (!rateLimitAllowed) {
    res.status(429).json({ success: false, error: 'Too many requests.' });
    return false;
  }
  return true;
};

// ── fake everything else payments.js touches, so routes don't crash ───────
const authModule = require('../lib/auth');
authModule.getSessionFromRequest = async () => null; // anonymous by default

const catalogModule = require('../lib/payment_catalog');
catalogModule.listPlanDefinitions = () => [{ id: 'starter', name: 'Standard', amount: '500', currency: 'USD' }];

const paymentServiceModule = require('../lib/payment_service');
paymentServiceModule.getSubscriptionState = async () => ({ subscription: null, plans: [] });
paymentServiceModule.retryPendingActivations = async () => 0;
paymentServiceModule.createStripeCheckout = async () => ({ id: 'pi_test', client_secret: 'secret' });
paymentServiceModule.createPayPalCheckout = async () => ({ id: 'order_test' });
paymentServiceModule.capturePayPalCheckout = async () => ({ status: 'COMPLETED' });
paymentServiceModule.reconcileStripeIntent = async () => ({ status: 'succeeded' });
paymentServiceModule.findPaymentByProviderIdentifiers = async () => null;
paymentServiceModule.upsertPaymentTransaction = async () => ({}) ;
paymentServiceModule.handleRefundedActivation = async () => ({}) ;
paymentServiceModule.mapStripeStatus = (s) => s;

const stripeModule = require('../stripe');
stripeModule.verifyStripeWebhookSignature = () => false; // signature check fails harmlessly in tests

const paypalModule = require('../paypal');
paypalModule.verifyPayPalWebhookSignature = async () => false;

// ── load module under test AFTER patching its dependencies ───────────────
const handler = require('../api/payments');

function makeReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      // Minimal stream stub for readRawBody/readEventBody in webhook routes.
      if (event === 'data') { /* no chunks */ }
      if (event === 'end') cb();
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('api/payments rate limiting', () => {
  beforeEach(() => {
    rateLimitAllowed = true;
    rateLimitCallCount = 0;
  });

  describe('non-webhook routes call rateLimit()', () => {
    const cases = [
      { name: 'GET catalog', req: { method: 'GET', query: { path: 'catalog' } } },
      { name: 'GET status', req: { method: 'GET', query: { path: 'status' } } },
      { name: 'POST retry', req: { method: 'POST', query: { path: 'retry' } } },
      { name: 'POST card intent', req: { method: 'POST', query: { provider: 'card', path: 'intent' } } },
      { name: 'POST card confirm', req: { method: 'POST', query: { provider: 'card', path: 'confirm' } } },
      { name: 'POST paypal order create', req: { method: 'POST', query: { provider: 'paypal' } } },
      { name: 'POST paypal capture', req: { method: 'POST', query: { provider: 'paypal', orderId: 'order_1' } } },
    ];

    for (const { name, req: reqOpts } of cases) {
      test(`${name} invokes rateLimit()`, async () => {
        const req = makeReq(reqOpts);
        const res = makeRes();
        await handler(req, res);
        assert.equal(rateLimitCallCount, 1, `${name} should call rateLimit() exactly once`);
      });

      test(`${name} returns 429 when rate limit is exceeded`, async () => {
        rateLimitAllowed = false;
        const req = makeReq(reqOpts);
        const res = makeRes();
        await handler(req, res);
        assert.equal(res.statusCode, 429);
      });
    }
  });

  describe('webhook routes are exempt from rate limiting', () => {
    test('Stripe webhook does not call rateLimit()', async () => {
      const req = makeReq({ method: 'POST', query: { provider: 'card', path: 'webhook' }, headers: { 'stripe-signature': 'sig' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(rateLimitCallCount, 0, 'webhook route must not be rate limited');
    });

    test('PayPal webhook does not call rateLimit()', async () => {
      const req = makeReq({ method: 'POST', query: { provider: 'paypal', path: 'webhook' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(rateLimitCallCount, 0, 'webhook route must not be rate limited');
    });

    test('a webhook request still proceeds even when rateLimitAllowed=false (limiter is bypassed, not just permissive)', async () => {
      rateLimitAllowed = false;
      const req = makeReq({ method: 'POST', query: { provider: 'card', path: 'webhook' }, headers: { 'stripe-signature': 'sig' } });
      const res = makeRes();
      await handler(req, res);
      // Signature check fails (mocked to return false) -> 400, not 429.
      // The point is it's NOT 429 from the rate limiter.
      assert.notEqual(res.statusCode, 429);
    });
  });
});
