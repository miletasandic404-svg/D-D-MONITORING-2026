'use strict';

/**
 * Payment-system unit tests.
 *
 * These tests do NOT require a database connection — the `db` module is
 * replaced with a lightweight in-process fake before any payment_service
 * code executes.
 *
 * What is covered:
 *   1. Webhook replay / idempotency
 *      - Processing the same Stripe / PayPal event twice must update the
 *        existing record rather than inserting a second row.
 *      - Calling activatePaymentForOrganization for an already-active
 *        payment returns immediately without touching the database again.
 *   2. Race condition guard
 *      - activatePaymentForOrganization detects an already-active locked
 *        record (simulating the winner of a concurrent request pair) and
 *        returns it without a second org update.
 *   3. Refund downgrade
 *      - handleRefundedActivation suspends the org when the payment was
 *        previously active.
 *      - It is a no-op when the payment was never activated.
 *      - It is a no-op when the payment record does not exist.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── minimal fake DB ──────────────────────────────────────────────────────────
// We capture every SQL call so tests can assert on the sequence/count.

const db = require('../db/index');

let queryCalls = [];
let transactionCalls = [];
let fakeQueryFn = null;

function resetFakes() {
  queryCalls = [];
  transactionCalls = [];
  fakeQueryFn = null;
}

// Patch db before the payment_service module is loaded.
const originalQuery = db.query;
const originalQueryAsOrg = db.queryAsOrg;
const originalTransaction = db.transaction;

db.query = async (text, params) => {
  queryCalls.push({ text, params });
  if (fakeQueryFn) return fakeQueryFn(text, params);
  return { rows: [] };
};

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ text, params, orgId });
  if (fakeQueryFn) return fakeQueryFn(text, params);
  return { rows: [] };
};

db.transaction = async (fn) => {
  transactionCalls.push({ fn });
  // Build a fake client that also routes through fakeQueryFn.
  const fakeClient = {
    query: async (text, params) => {
      queryCalls.push({ text, params, inTransaction: true });
      if (fakeQueryFn) return fakeQueryFn(text, params);
      return { rows: [] };
    },
  };
  return fn(fakeClient);
};

// ── load service after patching db ──────────────────────────────────────────
const {
  upsertPaymentTransaction,
  activatePaymentForOrganization,
  handleRefundedActivation,
} = require('../lib/payment_service');

// ── helpers ──────────────────────────────────────────────────────────────────

function makePayment(overrides = {}) {
  return {
    id: 'pay-1',
    user_id: null,
    organization_id: 'org-1',
    provider: 'stripe',
    provider_payment_id: 'pi_test_123',
    provider_order_id: null,
    provider_capture_id: 'ch_test_456',
    plan_id: 'starter',
    expected_amount: 50000,
    paid_amount: 50000,
    currency: 'USD',
    status: 'paid',
    activation_status: 'pending',
    activation_attempts: 0,
    next_activation_retry_at: null,
    last_activation_error: null,
    activated_organization_id: null,
    activated_at: null,
    raw_provider_payload: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── 1. Webhook replay / idempotency ─────────────────────────────────────────

describe('upsertPaymentTransaction — webhook replay idempotency', () => {
  beforeEach(() => resetFakes());

  test('first event for a new provider_payment_id inserts a row', async () => {
    // No existing record → SELECT returns empty, then INSERT is called.
    let selectCount = 0;
    let insertCount = 0;
    fakeQueryFn = async (text) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        selectCount++;
        return { rows: [] }; // no existing record
      }
      if (t.startsWith('INSERT')) {
        insertCount++;
        return { rows: [makePayment()] };
      }
      return { rows: [] };
    };

    await upsertPaymentTransaction({
      provider: 'stripe',
      providerPaymentId: 'pi_test_123',
      providerCaptureId: 'ch_test_456',
      planId: 'starter',
      expectedAmount: 50000,
      paidAmount: 50000,
      currency: 'USD',
      status: 'paid',
      activationStatus: 'pending',
      rawProviderPayload: { type: 'payment_intent.succeeded' },
    });

    assert.strictEqual(insertCount, 1, 'expected exactly one INSERT for new payment');
    assert.strictEqual(selectCount, 1, 'expected one SELECT to check for existing record');
  });

  test('replaying the same Stripe event updates rather than inserts', async () => {
    const existing = makePayment();
    let insertCount = 0;
    let updateCount = 0;

    fakeQueryFn = async (text) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        return { rows: [existing] }; // record already exists
      }
      if (t.startsWith('INSERT')) {
        insertCount++;
        return { rows: [existing] };
      }
      if (t.startsWith('UPDATE')) {
        updateCount++;
        return { rows: [existing] };
      }
      return { rows: [] };
    };

    // Second invocation for the same provider identifiers.
    await upsertPaymentTransaction({
      provider: 'stripe',
      providerPaymentId: 'pi_test_123',
      providerCaptureId: 'ch_test_456',
      planId: 'starter',
      expectedAmount: 50000,
      paidAmount: 50000,
      currency: 'USD',
      status: 'paid',
      activationStatus: 'pending',
      rawProviderPayload: { type: 'payment_intent.succeeded' },
    });

    assert.strictEqual(insertCount, 0, 'must NOT insert a duplicate row on replay');
    assert.strictEqual(updateCount, 1, 'must UPDATE the existing row on replay');
  });

  test('replaying the same PayPal event updates rather than inserts', async () => {
    const existing = makePayment({ provider: 'paypal', provider_payment_id: null, provider_order_id: 'ORDER-1', provider_capture_id: 'CAP-1' });
    let insertCount = 0;
    let updateCount = 0;

    fakeQueryFn = async (text) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) return { rows: [existing] };
      if (t.startsWith('INSERT')) { insertCount++; return { rows: [existing] }; }
      if (t.startsWith('UPDATE')) { updateCount++; return { rows: [existing] }; }
      return { rows: [] };
    };

    await upsertPaymentTransaction({
      provider: 'paypal',
      providerOrderId: 'ORDER-1',
      providerCaptureId: 'CAP-1',
      planId: 'starter',
      expectedAmount: 50000,
      paidAmount: 50000,
      currency: 'USD',
      status: 'paid',
      activationStatus: 'pending',
      rawProviderPayload: { event_type: 'PAYMENT.CAPTURE.COMPLETED' },
    });

    assert.strictEqual(insertCount, 0, 'must NOT insert duplicate row for PayPal replay');
    assert.strictEqual(updateCount, 1, 'must UPDATE existing PayPal row on replay');
  });
});

describe('activatePaymentForOrganization — idempotency', () => {
  beforeEach(() => resetFakes());

  test('already-active payment with same org returns immediately without DB writes', async () => {
    const orgId = 'org-1';
    const payment = makePayment({
      status: 'paid',
      activation_status: 'active',
      activated_organization_id: orgId,
      activated_at: new Date().toISOString(),
    });

    // getPaymentById returns the active payment.
    fakeQueryFn = async () => ({ rows: [payment] });

    const result = await activatePaymentForOrganization({
      paymentId: payment.id,
      organizationId: orgId,
    });

    assert.strictEqual(result.activation_status, 'active');
    // The transaction function must NOT have been invoked — early return before DB lock.
    assert.strictEqual(transactionCalls.length, 0, 'transaction must not be entered for already-active payment');
  });

  test('attempting to activate for a different org throws 409', async () => {
    const payment = makePayment({
      status: 'paid',
      activation_status: 'active',
      activated_organization_id: 'org-A',
      activated_at: new Date().toISOString(),
    });

    fakeQueryFn = async () => ({ rows: [payment] });

    await assert.rejects(
      () => activatePaymentForOrganization({ paymentId: payment.id, organizationId: 'org-B' }),
      (err) => {
        assert.strictEqual(err.statusCode, 409);
        assert.ok(/already activated another organization/i.test(err.message));
        return true;
      },
    );
  });
});

// ── 2. Race condition guard ───────────────────────────────────────────────────

describe('activatePaymentForOrganization — race condition guard (FOR UPDATE)', () => {
  beforeEach(() => resetFakes());

  test('second concurrent caller that finds locked record already active returns without extra writes', async () => {
    const orgId = 'org-1';
    // Pre-activation state from getPaymentById (outer check).
    const pendingPayment = makePayment({ status: 'paid', activation_status: 'pending' });
    // Locked state returned inside the transaction (simulates winner already committed).
    const activePayment = makePayment({
      status: 'paid',
      activation_status: 'active',
      activated_organization_id: orgId,
      activated_at: new Date().toISOString(),
    });

    let orgUpdateCount = 0;
    let paymentUpdateCount = 0;
    let selectCallCount = 0;

    fakeQueryFn = async (text) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        selectCallCount++;
        // First SELECT (getPaymentById, outside transaction) → pending.
        // Second SELECT (FOR UPDATE inside transaction) → already active.
        return { rows: [selectCallCount === 1 ? pendingPayment : activePayment] };
      }
      if (t.includes('UPDATE ORGANIZATIONS')) {
        orgUpdateCount++;
        return { rows: [] };
      }
      if (t.startsWith('UPDATE')) {
        paymentUpdateCount++;
        return { rows: [activePayment] };
      }
      return { rows: [] };
    };

    const result = await activatePaymentForOrganization({
      paymentId: pendingPayment.id,
      organizationId: orgId,
    });

    assert.strictEqual(result.activation_status, 'active', 'should return the already-active record');
    assert.strictEqual(orgUpdateCount, 0, 'organization must NOT be updated a second time');
    assert.strictEqual(paymentUpdateCount, 0, 'payment_transactions must NOT be updated a second time');
  });
});

// ── 3. Refund downgrade ───────────────────────────────────────────────────────

describe('handleRefundedActivation', () => {
  beforeEach(() => resetFakes());

  test('suspends org when payment was active', async () => {
    const orgId = 'org-1';
    const payment = makePayment({
      status: 'paid',
      activation_status: 'active',
      activated_organization_id: orgId,
      activated_at: new Date().toISOString(),
    });

    let orgSuspended = false;

    fakeQueryFn = async (text) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) return { rows: [payment] };
      if (t.includes('UPDATE ORGANIZATIONS')) {
        assert.ok(
          /status\s*=\s*'suspended'/i.test(text),
          "organization status must be set to 'suspended' on refund",
        );
        assert.ok(
          /camera_limit\s*=\s*0/i.test(text),
          'camera_limit must be zeroed on refund',
        );
        orgSuspended = true;
        return { rows: [] };
      }
      if (t.startsWith('INSERT') && t.includes('AUDIT_LOGS')) return { rows: [] };
      return { rows: [] };
    };

    const result = await handleRefundedActivation({
      provider: 'stripe',
      providerPaymentId: 'pi_test_123',
    });

    assert.ok(result, 'should return the payment record');
    assert.ok(orgSuspended, 'organization must be suspended after refund');
    assert.strictEqual(transactionCalls.length, 1, 'exactly one transaction for org downgrade');
  });

  test('is a no-op when payment was never activated (activation_status = pending)', async () => {
    const payment = makePayment({ status: 'refunded', activation_status: 'pending' });

    fakeQueryFn = async () => ({ rows: [payment] });

    const result = await handleRefundedActivation({
      provider: 'stripe',
      providerPaymentId: 'pi_test_123',
    });

    assert.strictEqual(result, null, 'should return null for non-active payment');
    assert.strictEqual(transactionCalls.length, 0, 'no DB writes for non-active payment');
  });

  test('is a no-op when payment record does not exist', async () => {
    fakeQueryFn = async () => ({ rows: [] });

    const result = await handleRefundedActivation({
      provider: 'stripe',
      providerPaymentId: 'pi_unknown',
    });

    assert.strictEqual(result, null, 'should return null for unknown payment');
    assert.strictEqual(transactionCalls.length, 0, 'no DB writes for unknown payment');
  });

  test('is a no-op when activated_organization_id is missing (edge case)', async () => {
    const payment = makePayment({
      activation_status: 'active',
      activated_organization_id: null, // data inconsistency — guard against crash
    });

    fakeQueryFn = async () => ({ rows: [payment] });

    const result = await handleRefundedActivation({
      provider: 'stripe',
      providerPaymentId: 'pi_test_123',
    });

    assert.strictEqual(result, null, 'should return null when no org to suspend');
    assert.strictEqual(transactionCalls.length, 0, 'no DB writes when org id is missing');
  });
});

// ── 4. Failed activation audit events ────────────────────────────────────────

describe('activatePaymentForOrganization — failed activation audit event', () => {
  beforeEach(() => resetFakes());

  test('emits org.plan_activation_failed audit event when the activation transaction fails', async () => {
    const orgId = 'org-1';
    const payment = makePayment({ status: 'paid', activation_status: 'pending' });

    let auditInserted = false;
    let auditAction = null;

    fakeQueryFn = async (text, params) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        return { rows: [payment] };
      }
      if (t.includes('UPDATE ORGANIZATIONS')) {
        // Simulate a transient DB error inside the activation transaction.
        throw new Error('simulated DB error');
      }
      if (t.startsWith('UPDATE')) {
        // markActivationFailure's UPDATE payment_transactions — succeeds.
        return { rows: [{ ...payment, activation_status: 'failed', activation_attempts: 1 }] };
      }
      if (t.includes('AUDIT_LOGS')) {
        auditInserted = true;
        auditAction = params[2]; // [orgId, userId, action, ...]
        return { rows: [] };
      }
      return { rows: [] };
    };

    await assert.rejects(
      () => activatePaymentForOrganization({ paymentId: payment.id, organizationId: orgId }),
      (err) => {
        assert.ok(/simulated DB error/i.test(err.message));
        return true;
      },
    );

    assert.ok(auditInserted, 'audit_logs INSERT must be emitted after activation failure');
    assert.strictEqual(auditAction, 'org.plan_activation_failed', 'audit action must be org.plan_activation_failed');
  });

  test('emits org.plan_activation_failed when plan is unsupported', async () => {
    const orgId = 'org-1';
    const payment = makePayment({ status: 'paid', activation_status: 'pending', plan_id: 'unknown_plan' });

    let auditInserted = false;
    let auditAction = null;

    fakeQueryFn = async (text, params) => {
      const t = text.trim().toUpperCase();
      if (t.startsWith('SELECT')) return { rows: [payment] };
      if (t.startsWith('UPDATE')) {
        return { rows: [{ ...payment, activation_status: 'failed', activation_attempts: 1 }] };
      }
      if (t.includes('AUDIT_LOGS')) {
        auditInserted = true;
        auditAction = params[2];
        return { rows: [] };
      }
      return { rows: [] };
    };

    await assert.rejects(
      () => activatePaymentForOrganization({ paymentId: payment.id, organizationId: orgId }),
      (err) => {
        assert.ok(/unsupported plan/i.test(err.message));
        return true;
      },
    );

    assert.ok(auditInserted, 'audit_logs INSERT must be emitted for unsupported plan failure');
    assert.strictEqual(auditAction, 'org.plan_activation_failed');
  });
});

// ── restore original db methods (best-effort, for use outside this file) ─────
process.on('exit', () => {
  db.query = originalQuery;
  db.queryAsOrg = originalQueryAsOrg;
  db.transaction = originalTransaction;
});
