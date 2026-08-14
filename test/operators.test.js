'use strict';

/**
 * Tests for /api/operators endpoint in api/users.js
 *
 * Regression test to ensure operators endpoint uses production-correct column names:
 * - name (not display_name)
 * - "createdAt" (not created_at)
 *
 * Production database schema (verified):
 * - id text
 * - name text
 * - email text
 * - emailVerified boolean
 * - image text
 * - createdAt timestamp
 * - updatedAt timestamp
 * - organization_id uuid
 * - user_type varchar
 * - status varchar
 * - last_login_at timestamptz
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let dbScript = null;

function resetFakes() {
  queryCalls = [];
  dbScript = null;
  authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
authModule.requireAuth = async () => authResponse;

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── load module under test AFTER patching its dependencies ───────────────
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

describe('api/users — /api/operators endpoint', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('GET /api/operators uses production-correct column names (name, "createdAt")', async () => {
    dbScript = (text) => {
      if (text.includes('FROM users') && text.includes('user_type = \'operator\'')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'operator@example.com',
              name: 'John Operator',
              role: 'operator',
              status: 'active',
              created_at: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    const req = makeReq({ method: 'GET', query: { path: 'operators' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.operators.length, 1);

    const operatorsQuery = queryCalls.find((c) => 
      c.text.includes('FROM users') && c.text.includes('user_type = \'operator\'')
    );
    assert.ok(operatorsQuery, 'operators query ran');

    // Verify production-correct column names
    assert.ok(operatorsQuery.text.includes('name'), 'query must use "name" column');
    assert.ok(operatorsQuery.text.includes('"createdAt"'), 'query must use "createdAt" column (with quotes)');
    assert.ok(!operatorsQuery.text.includes('display_name'), 'query must NOT use "display_name"');
    // Note: "created_at" is allowed as an alias (AS created_at) but not as a source column
    assert.ok(operatorsQuery.text.includes('"createdAt" AS created_at'), 'query must alias "createdAt" to created_at');
  });

  test('GET /api/operators is organization-scoped via queryAsOrg', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 });

    const req = makeReq({ method: 'GET', query: { path: 'operators' } });
    const res = makeRes();
    await handler(req, res);

    const operatorsQuery = queryCalls.find((c) => 
      c.text.includes('FROM users') && c.text.includes('user_type = \'operator\'')
    );
    assert.ok(operatorsQuery, 'operators query ran');
    assert.equal(operatorsQuery.orgId, 'org-1');
    assert.ok(operatorsQuery.text.includes('organization_id = $1'));
    assert.equal(operatorsQuery.params[0], 'org-1');
  });

  test('GET /api/operators returns 403 when organizationId is missing', async () => {
    authResponse = { userId: 'user-1', organizationId: null, role: 'org_admin' };

    const req = makeReq({ method: 'GET', query: { path: 'operators' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /No organization associated/i);
  });

  test('POST /api/operators returns 405 Method not allowed', async () => {
    const req = makeReq({ method: 'POST', query: { path: 'operators' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method not allowed/i);
  });

  test('DELETE /api/operators returns 405 Method not allowed', async () => {
    const req = makeReq({ method: 'DELETE', query: { path: 'operators' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 405);
    assert.match(res.body.error, /Method not allowed/i);
  });
});
