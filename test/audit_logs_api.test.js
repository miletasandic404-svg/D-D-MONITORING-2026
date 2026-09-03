'use strict';

/**
 * Tests for GET /api/audit-logs (lib/handlers/audit-logs.js).
 *
 * Contract:
 *   - Tenant-scoped: every non-platform user is restricted to their
 *     own organization via queryAsOrg + WHERE organization_id = $1.
 *   - platform_admin: uses queryAsPlatformAdmin, no org filter.
 *   - Optional filters: action, resource_type, from, to.
 *   - Pagination: limit (1..200) and offset (0..100000).
 *   - Returned fields: id, ts, user_id, user_email, action,
 *     resource_type, resource_id, organization_id.
 *   - 401 if no auth, 200 with empty result for missing-org org users.
 *   - Never returns metadata or ip_address (PII).
 *   - SQL only ever joins `audit_logs` and `users` (no other tables).
 *
 * All DB calls are faked — no real network/DB is hit.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');

// IMPORTANT: the handler destructures `requireAuth` from authModule at
// require-time, so the patched `requireAuth` on the module must be set
// BEFORE the handler is required, otherwise reassignment would not
// affect the handler's local binding.
const authState = { value: { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' } };
authModule.requireAuth = async (_req, res) => {
  if (authState.value === null) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  return authState.value;
};
rateLimitModule.rateLimit = async () => true;

let orgCalls = [];
let adminCalls = [];

function fakeRows(text) {
  if (text.includes('count(*)::int AS total')) {
    return { rows: [{ total: 7 }] };
  }
  if (text.includes('FROM audit_logs al')) {
    return { rows: [
      { id: 'a1', user_id: 'u1', user_email: 'op@x.com', action: 'snapshot.create',
        resource_type: 'snapshot', resource_id: 's1', organization_id: 'org-1',
        created_at: new Date('2026-01-01T00:00:00Z') },
    ] };
  }
  return { rows: [] };
}

db.queryAsOrg = async (orgId, text, params) => {
  orgCalls.push({ orgId, text, params });
  return fakeRows(text);
};
db.queryAsPlatformAdmin = async (text, params) => {
  adminCalls.push({ text, params });
  return fakeRows(text);
};

const handler = require('../lib/handlers/audit-logs');

function makeReq(qs = {}) {
  return { method: 'GET', url: '/api/audit-logs', query: qs, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('GET /api/audit-logs', () => {
  beforeEach(() => {
    orgCalls = [];
    adminCalls = [];
    authState.value = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
  });

  test('org user: SQL binds organization_id=$1 and uses queryAsOrg', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(orgCalls.length, 2); // data + count
    assert.equal(adminCalls.length, 0);
    for (const c of orgCalls) {
      assert.equal(c.orgId, 'org-1');
      assert.match(c.text, /organization_id = \$1/);
    }
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.total, 7);
    assert.equal(r.body.count, 1);
    assert.equal(r.body.entries[0].action, 'snapshot.create');
    assert.equal(r.body.entries[0].user_email, 'op@x.com');
  });

  test('platform_admin: queryAsPlatformAdmin, no org_id filter', async () => {
    authState.value = { userId: 'a1', organizationId: 'org-1', userType: 'platform_admin' };
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(orgCalls.length, 0);
    assert.equal(adminCalls.length, 2);
    for (const c of adminCalls) {
      assert.doesNotMatch(c.text, /organization_id = \$1/);
    }
  });

  test('missing-org org user: 200 empty, no DB query', async () => {
    authState.value = { userId: 'u1', organizationId: null, userType: 'org_admin' };
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(orgCalls.length, 0);
    assert.equal(adminCalls.length, 0);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.count, 0);
    assert.equal(r.body.total, 0);
    assert.deepEqual(r.body.entries, []);
  });

  test('unauthorized (requireAuth returns null): 401, no DB query', async () => {
    authState.value = null;
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.statusCode, 401);
    assert.equal(orgCalls.length, 0);
    assert.equal(adminCalls.length, 0);
  });

  test('action + resource_type filters: appended to WHERE with $N params', async () => {
    const r = makeRes();
    await handler(makeReq({ action: 'snapshot.create', resource_type: 'snapshot' }), r);
    const dataCall = orgCalls.find(c => c.text.includes('LIMIT'));
    assert.ok(dataCall);
    assert.match(dataCall.text, /action = \$/);
    assert.match(dataCall.text, /resource_type = \$/);
    assert.ok(dataCall.params.includes('snapshot.create'));
    assert.ok(dataCall.params.includes('snapshot'));
  });

  test('date range filters: from/to appended with $N params', async () => {
    const r = makeRes();
    await handler(makeReq({ from: '2026-01-01T00:00:00Z', to: '2026-01-31T23:59:59Z' }), r);
    const dataCall = orgCalls.find(c => c.text.includes('LIMIT'));
    assert.match(dataCall.text, /created_at >= \$/);
    assert.match(dataCall.text, /created_at <= \$/);
    assert.ok(dataCall.params.includes('2026-01-01T00:00:00Z'));
    assert.ok(dataCall.params.includes('2026-01-31T23:59:59Z'));
  });

  test('pagination: limit/offset bound correctly in SQL', async () => {
    const r = makeRes();
    await handler(makeReq({ limit: '25', offset: '50' }), r);
    const dataCall = orgCalls.find(c => c.text.includes('LIMIT'));
    assert.match(dataCall.text, /LIMIT \$/);
    assert.match(dataCall.text, /OFFSET \$/);
    const tail = dataCall.params.slice(-2);
    assert.deepEqual(tail, [25, 50]);
    assert.equal(r.body.limit, 25);
    assert.equal(r.body.offset, 50);
  });

  test('pagination limit clamped (>200 rejected)', async () => {
    const r = makeRes();
    await handler(makeReq({ limit: '10000' }), r);
    assert.equal(r.statusCode, 400);
  });

  test('pagination offset clamped (negative rejected)', async () => {
    const r = makeRes();
    await handler(makeReq({ offset: '-1' }), r);
    assert.equal(r.statusCode, 400);
  });

  test('empty result: 200 with zeroed totals', async () => {
    const orig = db.queryAsOrg;
    db.queryAsOrg = async (orgId, text) => {
      orgCalls.push({ orgId, text });
      if (text.includes('count(*)::int AS total')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    };
    try {
      const r = makeRes();
      await handler(makeReq(), r);
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.total, 0);
      assert.equal(r.body.count, 0);
      assert.deepEqual(r.body.entries, []);
    } finally {
      db.queryAsOrg = orig;
    }
  });

  test('returned rows do NOT include metadata or ip_address (PII safety)', async () => {
    const orig = db.queryAsOrg;
    db.queryAsOrg = async () => ({ rows: [
      { id: 'a1', user_id: 'u1', user_email: 'op@x.com', action: 'snapshot.create',
        resource_type: 'snapshot', resource_id: 's1', organization_id: 'org-1',
        created_at: new Date(), metadata: { secret: true }, ip_address: '1.2.3.4' },
    ] });
    try {
      const r = makeRes();
      await handler(makeReq(), r);
      const entry = r.body.entries[0];
      assert.equal(entry.metadata, undefined);
      assert.equal(entry.ip_address, undefined);
    } finally {
      db.queryAsOrg = orig;
    }
  });

  test('only joins audit_logs and users (no other tables)', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    // The data SELECT (the one with LIMIT) carries the JOIN clause.
    const dataCall = orgCalls.find(c => c.text.includes('LIMIT'));
    assert.ok(dataCall, 'expected a data query with LIMIT');
    assert.match(dataCall.text, /FROM audit_logs al/);
    assert.match(dataCall.text, /JOIN users u/);
    assert.doesNotMatch(dataCall.text, /JOIN\s+(cameras|incidents|media_nodes|recordings|snapshots)\b/i);
  });

  test('non-GET method: 405', async () => {
    const req = makeReq();
    req.method = 'POST';
    const r = makeRes();
    await handler(req, r);
    assert.equal(r.statusCode, 405);
    assert.equal(orgCalls.length, 0);
  });
});
