'use strict';

/**
 * Tests for DELETE /api/users, PATCH text-ID validation, and POST invite flow.
 *
 * Verifies:
 * - DELETE handler is org-scoped and role-gated
 * - PATCH accepts non-UUID Better Auth TEXT IDs
 * - POST invite flow correctly passes organization_id
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let dbScript = null;

function resetFakes() {
  queryCalls = [];
  dbScript = null;
  authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
  mockedCreateUserCalls = [];
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth (requireAuth checks roles like the real one) ───────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };

authModule.requireAuth = async (req, res, { roles } = {}) => {
  if (!authResponse) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  if (roles && roles.length > 0 && !roles.includes(authResponse.role)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions for this action' });
    return null;
  }
  if (!authResponse.organizationId) {
    res.status(403).json({ success: false, error: 'No organization associated with this account' });
    return null;
  }
  return authResponse;
};

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── fake createUser (patch BEFORE requiring api/users.js) ─────────────────
let mockedCreateUserCalls = [];
const authLib = require('../lib/auth');
authLib.createUser = async (opts) => {
  mockedCreateUserCalls.push(opts);
  return { user: { id: opts.email.split('@')[0] + '-generated-id', email: opts.email } };
};

// ── load module under test AFTER patching ────────────────────────────────
const handler = require('../api/users');

// ── req/res test helpers ──────────────────────────────────────────────────
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

describe('api/users — DELETE handler', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('DELETE /api/users deletes user and returns success', async () => {
    dbScript = (text) => {
      if (text.startsWith('DELETE FROM users WHERE id')) {
        return { rows: [{ id: 'user-to-delete', email: 'test@example.com' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({ method: 'DELETE', query: { id: 'user-to-delete' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'User deleted successfully');

    const deleteQuery = queryCalls.find(c => c.text.startsWith('DELETE FROM users WHERE id'));
    assert.ok(deleteQuery, 'DELETE query should have run');
    assert.equal(deleteQuery.params[0], 'user-to-delete');
    assert.equal(deleteQuery.params[1], 'org-1');
  });

  test('DELETE /api/users is organization-scoped (uses queryAsOrg with org id)', async () => {
    dbScript = () => ({ rows: [{ id: 'u1', email: 'a@b.com' }], rowCount: 1 });

    const req = makeReq({ method: 'DELETE', query: { id: 'u1' } });
    const res = makeRes();
    await handler(req, res);

    const deleteQuery = queryCalls.find(c => c.text.startsWith('DELETE FROM users'));
    assert.ok(deleteQuery);
    assert.equal(deleteQuery.orgId, 'org-1');
    assert.ok(deleteQuery.text.includes('AND organization_id = $2'));
    assert.equal(deleteQuery.params[1], 'org-1');
  });

  test('DELETE /api/users returns 404 when user not found', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 });

    const req = makeReq({ method: 'DELETE', query: { id: 'nonexistent' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
  });

  test('DELETE /api/users returns 400 when id is missing', async () => {
    const req = makeReq({ method: 'DELETE', query: {} });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /id is required/i);
  });

  test('DELETE /api/users rejects operator role (403)', async () => {
    authResponse = { userId: 'op-1', organizationId: 'org-1', role: 'operator' };

    const req = makeReq({ method: 'DELETE', query: { id: 'u1' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /Insufficient permissions/i);
  });

  test('DELETE /api/users rejects when organizationId is null', async () => {
    authResponse = { userId: 'pa-1', organizationId: null, role: 'platform_admin' };

    const req = makeReq({ method: 'DELETE', query: { id: 'u1' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('DELETE /api/users handles database errors (500)', async () => {
    dbScript = () => { throw new Error('DB connection lost'); };

    const req = makeReq({ method: 'DELETE', query: { id: 'u1' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /DB connection lost/i);
  });

  test('DELETE /api/users handles non-UUID text IDs', async () => {
    dbScript = (text) => {
      if (text.startsWith('DELETE FROM users WHERE id')) {
        return { rows: [{ id: 'text-id-123', email: 'test@example.com' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({ method: 'DELETE', query: { id: 'text-id-123' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
  });
});

describe('api/users — PATCH text ID validation', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('PATCH /api/users accepts non-UUID text ID (Better Auth TEXT ID)', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 });

    const betterAuthId = 'abcdefghijklmnopqrstuvwxy';

    const req = makeReq({
      method: 'PATCH',
      body: { id: betterAuthId, user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const updateQuery = queryCalls.find(c => c.text.startsWith('UPDATE users SET'));
    assert.ok(updateQuery, 'UPDATE query should have run');
    // params = [user_type, id, organizationId]
    assert.equal(updateQuery.params[0], 'operator');
    assert.equal(updateQuery.params[1], betterAuthId);
    assert.equal(updateQuery.params[2], 'org-1');
  });

  test('PATCH /api/users accepts 32-char alphanumeric Better Auth ID', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 });

    const betterAuthId = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

    const req = makeReq({
      method: 'PATCH',
      body: { id: betterAuthId, status: 'active' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  });

  test('PATCH /api/users rejects empty id', async () => {
    const req = makeReq({
      method: 'PATCH',
      body: { id: '', status: 'active' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  });

  test('PATCH /api/users rejects missing id', async () => {
    const req = makeReq({
      method: 'PATCH',
      body: { status: 'active' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  });

  test('PATCH /api/users rejects invalid user_type', async () => {
    const req = makeReq({
      method: 'PATCH',
      body: { id: 'user-1', user_type: 'superadmin' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  });

  test('PATCH /api/users is organization-scoped', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 });

    const req = makeReq({
      method: 'PATCH',
      body: { id: 'user-1', status: 'disabled' },
    });
    const res = makeRes();
    await handler(req, res);

    const updateQuery = queryCalls.find(c => c.text.startsWith('UPDATE users SET'));
    assert.ok(updateQuery);
    assert.equal(updateQuery.orgId, 'org-1');
    assert.ok(updateQuery.text.includes('AND organization_id ='));
  });

  test('PATCH /api/users rejects operator role (403)', async () => {
    authResponse = { userId: 'op-1', organizationId: 'org-1', role: 'operator' };

    const req = makeReq({
      method: 'PATCH',
      body: { id: 'user-1', user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('PATCH /api/users returns 400 when no fields to update', async () => {
    const req = makeReq({
      method: 'PATCH',
      body: { id: 'user-1' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /No fields to update/i);
  });
});

describe('api/users — Add Operator flow (POST)', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('POST /api/users creates user with correct organization_id', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('UPDATE users')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({
      method: 'POST',
      body: { email: 'operator@example.com', user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // Verify createUser was called with organizationId from auth
    assert.equal(mockedCreateUserCalls.length, 1);
    assert.equal(mockedCreateUserCalls[0].organizationId, 'org-1');
    assert.equal(mockedCreateUserCalls[0].userType, 'operator');

    // Verify UPDATE uses the same organization_id
    const updateQuery = queryCalls.find(c => c.text.startsWith('UPDATE users'));
    assert.ok(updateQuery, 'UPDATE query should have run');
    assert.equal(updateQuery.params[0], 'org-1'); // organization_id = $1
    assert.equal(updateQuery.params[1], 'operator'); // user_type = $2
  });

  test('POST /api/users rejects operator role (403)', async () => {
    authResponse = { userId: 'op-1', organizationId: 'org-1', role: 'operator' };

    const req = makeReq({
      method: 'POST',
      body: { email: 'operator@example.com', user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('POST /api/users rejects duplicate email (409)', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [{ id: 'existing-user' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({
      method: 'POST',
      body: { email: 'existing@example.com', user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /already registered/i);
  });

  test('POST /api/users defaults user_type to operator when not specified', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('UPDATE users')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({
      method: 'POST',
      body: { email: 'newuser@example.com' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);

    const updateQuery = queryCalls.find(c => c.text.startsWith('UPDATE users'));
    assert.equal(updateQuery.params[1], 'operator'); // default user_type
  });

  test('POST /api/users returns 400 for invalid email', async () => {
    const req = makeReq({
      method: 'POST',
      body: { email: 'not-an-email', user_type: 'operator' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  });

  test('POST /api/users rejects invalid user_type in body', async () => {
    const req = makeReq({
      method: 'POST',
      body: { email: 'test@example.com', user_type: 'superadmin' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 400);
  });
});
