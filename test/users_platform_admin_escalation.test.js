'use strict';

/**
 * Focused tests for the platform_admin privilege-escalation guard in
 * POST /api/users (invite) and PATCH /api/users (update).
 *
 * org_admin must NOT be able to grant user_type='platform_admin'
 * (a platform-level super-role that bypasses every org boundary).
 * Only platform_admin may issue it.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let updateCalls = [];
let createCalls = [];
let dbScript = null;
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };

function resetFakes() {
  queryCalls = [];
  updateCalls = [];
  createCalls = [];
  dbScript = null;
  authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
}

// queryAsOrg: org-status check returns active; everything else is
// driven by dbScript so individual tests can assert what ran.
db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ text, params });
  if (text.includes('SELECT status FROM organizations')) {
    return { rows: [{ status: 'active' }], rowCount: 1 };
  }
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// Capture UPDATE users ... so tests can assert a role write did NOT happen.
const originalQueryAsOrg = db.queryAsOrg;
db.queryAsOrg = async (orgId, text, params) => {
  const result = await originalQueryAsOrg(orgId, text, params);
  if (text.startsWith('UPDATE users SET')) updateCalls.push({ text, params });
  return result;
};

// ── fake auth ────────────────────────────────────────────────────────────
// Mirrors lib/_auth.js requireAuth: roles checked against user_type, returns
// { userId, organizationId, userType }.
const authModule = require('../lib/_auth');
authModule.requireAuth = async (req, res, { roles } = {}) => {
  if (!authResponse) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  if (roles && roles.length > 0 && !roles.includes(authResponse.userType)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions for this action' });
    return null;
  }
  if (!authResponse.organizationId) {
    res.status(403).json({ success: false, error: 'No organization associated with your account' });
    return null;
  }
  return authResponse;
};

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── fake createUser ──────────────────────────────────────────────────────
const authLib = require('../lib/auth');
authLib.createUser = async (opts) => {
  createCalls.push(opts);
  return { user: { id: opts.email.split('@')[0] + '-generated-id', email: opts.email } };
};

// ── load module under test AFTER patching ───────────────────────────────
const handler = require('../api/users');

// ── req/res helpers ──────────────────────────────────────────────────────
function makeReq({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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

function setUser(type, orgId = 'org-1') {
  authResponse = { userId: 'caller-' + type, organizationId: orgId, userType: type };
}

describe('api/users — platform_admin role grant guard', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('A: org_admin POST user_type=platform_admin -> 403, user not created', async () => {
    setUser('org_admin');
    const req = makeReq({ method: 'POST', body: { email: 'attacker@evil.com', user_type: 'platform_admin' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(createCalls.length, 0, 'no user should be created on a forbidden grant');
  });

  test('B: platform_admin POST user_type=platform_admin -> success (existing behaviour)', async () => {
    setUser('platform_admin');
    const req = makeReq({ method: 'POST', body: { email: 'sa@evil.com', user_type: 'platform_admin' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].userType, 'platform_admin');
  });

  test('C: org_admin PATCH existing user to platform_admin -> 403, role unchanged', async () => {
    setUser('org_admin');
    const req = makeReq({ method: 'PATCH', query: {}, body: { id: 'user-1', user_type: 'platform_admin' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(updateCalls.length, 0, 'no UPDATE users should run on a forbidden grant');
  });

  test('D: platform_admin PATCH to platform_admin -> success (existing behaviour)', async () => {
    setUser('platform_admin');
    dbScript = (text) => {
      if (text.startsWith('UPDATE users SET')) {
        return { rows: [{ id: 'user-1', user_type: 'platform_admin' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'PATCH', body: { id: 'user-1', user_type: 'platform_admin' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls.length, 1, 'the UPDATE should run when platform_admin does the grant');
  });

  test('E: org_admin can still create/update allowed roles (operator/org_admin)', async () => {
    setUser('org_admin');

    // POST as operator
    const req1 = makeReq({ method: 'POST', body: { email: 'op@evil.com', user_type: 'operator' } });
    const res1 = makeRes();
    await handler(req1, res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(createCalls[0].userType, 'operator');

    // PATCH to org_admin
    dbScript = (text) => {
      if (text.startsWith('UPDATE users SET')) return { rows: [{ id: 'user-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req2 = makeReq({ method: 'PATCH', body: { id: 'user-1', user_type: 'org_admin' } });
    const res2 = makeRes();
    await handler(req2, res2);
    assert.equal(res2.statusCode, 200);
  });

  test('F: org_admin cannot escalate a user in another organization', async () => {
    // Caller is org_admin of org-1; target user lives in org-2.
    // The org-scoped UPDATE wouldn't match org-2's user, but the guard must
    // reject the platform_admin grant BEFORE any write happens.
    setUser('org_admin', 'org-1');
    const req = makeReq({ method: 'PATCH', body: { id: 'user-in-org-2', user_type: 'platform_admin' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(updateCalls.length, 0, 'cross-org escalation must not reach an UPDATE');
  });
});
