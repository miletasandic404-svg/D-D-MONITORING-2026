'use strict';

/**
 * Focused tests for the temporary invitation password generation in
 * POST /api/users (invite). Verifies the temp password is generated via a
 * CSPRNG (crypto.randomBytes) and NOT Math.random(), and that the existing
 * invite flow behaviour is unchanged.
 *
 * crypto.randomBytes is spied by redefining it on the shared `crypto`
 * module object (the handler reads `crypto.randomBytes` at call time, so a
 * per-test redefine is picked up). Math.random is also spied so we can assert
 * the old insecure path is not used.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('crypto');
const realRandomBytes = crypto.randomBytes.bind(crypto);
let rbCalls = [];
let mathRandomCalls = 0;
const realMathRandom = Math.random;

function installCryptoSpy() {
  Object.defineProperty(crypto, 'randomBytes', {
    value: (len) => {
      rbCalls.push(Number(len));
      return realRandomBytes(len);
    },
    configurable: true,
    writable: true,
  });
}
function installMathSpy() {
  Object.defineProperty(Math, 'random', {
    value: () => {
      mathRandomCalls += 1;
      return realMathRandom();
    },
    configurable: true,
    writable: true,
  });
}
function restoreCrypto() {
  Object.defineProperty(crypto, 'randomBytes', { value: realRandomBytes, configurable: true, writable: true });
}
function restoreMath() {
  Object.defineProperty(Math, 'random', { value: realMathRandom, configurable: true, writable: true });
}

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let createCalls = [];

db.queryAsOrg = async (orgId, text, params) => {
  if (text.includes('SELECT status FROM organizations')) {
    return { rows: [{ status: 'active' }], rowCount: 1 };
  }
  if (text.includes('SELECT id FROM users WHERE email = $1')) {
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
authModule.requireAuth = async (req, res, { roles } = {}) => {
  if (!authResponse) return null;
  if (roles && roles.length > 0 && !roles.includes(authResponse.userType)) return null;
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

// Load the handler ONCE. Its `crypto` reference is the shared module object,
// so the per-test redefine of `crypto.randomBytes` is observed at call time.
installCryptoSpy();
const handler = require('../api/users');

// ── req/res helpers ──────────────────────────────────────────────────────
function makeReq({ method = 'POST', body = {} } = {}) {
  return { method, query: {}, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('api/users — temporary invitation password', () => {
  beforeEach(() => {
    createCalls = [];
    rbCalls = [];
    mathRandomCalls = 0;
    authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
    installCryptoSpy();
    installMathSpy();
  });
  afterEach(() => {
    restoreCrypto();
    restoreMath();
  });

  test('invites a new user and passes the temp password into createUser', async () => {
    const req = makeReq({ body: { email: 'newuser@example.com' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(createCalls.length, 1, 'createUser must be called exactly once');
    assert.ok(typeof createCalls[0].password === 'string' && createCalls[0].password.length > 0,
      'temp password must be passed to createUser');
  });

  test('temp password is generated with crypto.randomBytes(16), not Math.random', async () => {
    const req = makeReq({ body: { email: 'sa@example.com' } });
    const res = makeRes();
    await handler(req, res);

    assert.ok(rbCalls.includes(16), `expected crypto.randomBytes(16); calls: ${JSON.stringify(rbCalls)}`);
    assert.equal(mathRandomCalls, 0, 'Math.random must NOT be used for the temp password');
  });

  test('generated temp password is 32-char hex (16 CSPRNG bytes)', async () => {
    const req = makeReq({ body: { email: 'hex@example.com' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(createCalls.length, 1);
    const pw = createCalls[0].password;
    assert.match(pw, /^[0-9a-f]{32}$/, `temp password must be 32-char hex, got: ${JSON.stringify(pw)}`);
  });

  test('existing invite behaviour is unchanged: defaults user_type to operator, still succeeds', async () => {
    const req = makeReq({ body: { email: 'op@example.com' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].userType, 'operator', 'default user_type must remain "operator"');
  });
});
