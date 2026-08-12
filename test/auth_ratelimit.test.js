"use strict";

/**
 * Regression tests for authentication rate limiting (CRITICAL #1).
 *
 * Verifies:
 *   1. Auth endpoints are routed through the rate limiter.
 *   2. Allowed requests pass through to the Better Auth handler.
 *   3. Exceeding the strict auth limit returns 429 and blocks the request.
 *   4. The sensitive-path classifier covers sign-in / sign-up / password
 *      reset/change, and leaves other auth paths on the standard limiter.
 *   5. IP + account keying: one account attacked from many IPs is still
 *      throttled via the account bucket; different emails/IPs are
 *      independent.
 *   6. Existing auth behavior is preserved when requests are allowed
 *      (delegate handler receives (req, res), no credential leakage).
 *
 * The limiter runs on its in-memory fallback (no Upstash env in tests).
 * Every test uses unique IPs/emails so buckets never bleed into each
 * other within the shared in-memory store.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── real limiter under test ─────────────────────────────────────────────
const { rateLimit, authRateLimit, isSensitiveAuthPath } = require('../lib/_rate_limit');

function makeReq({ method = 'POST', url = '/api/auth/sign-in/email', body = {}, headers = {}, ip = '192.0.2.10' } = {}) {
  return {
    method,
    url,
    body,
    headers,
    socket: { remoteAddress: ip },
    on() {},
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

// ── unit: classifier ────────────────────────────────────────────────────
describe('lib/_rate_limit — isSensitiveAuthPath', () => {
  const sensitive = [
    '/api/auth/sign-in/email',
    '/api/auth/sign-up/email',
    '/api/auth/forget-password/email',
    '/api/auth/reset-password/email',
    '/api/auth/change-password/email',
    '/api/auth/sign-in/email?x=1',
  ];
  const notSensitive = [
    '/api/auth/get-session',
    '/api/auth/sign-out',
    '/api/auth/update-user',
    '/api/cameras',
    '',
    null,
    undefined,
  ];

  for (const p of sensitive) {
    test(`${p} -> strict auth limiter`, () => assert.equal(isSensitiveAuthPath(p), true));
  }
  for (const p of notSensitive) {
    test(`${String(p)} -> standard limiter`, () => assert.equal(isSensitiveAuthPath(p), false));
  }
});

// ── unit: authRateLimit ─────────────────────────────────────────────────
describe('lib/_rate_limit — authRateLimit', () => {
  test('allowed request passes (returns true, no 429)', async () => {
    const req = makeReq({ ip: '192.0.2.101', body: { email: 'ok@example.com' } });
    const res = makeRes();
    assert.equal(await authRateLimit(req, res), true);
    assert.notEqual(res.statusCode, 429);
  });

  test('exceeding the strict limit returns 429', async () => {
    const ip = '192.0.2.102';
    const email = 'target@example.com';
    for (let i = 0; i < 10; i++) {
      const ok = await authRateLimit(makeReq({ ip, body: { email } }), makeRes());
      assert.equal(ok, true, `attempt ${i + 1} should be allowed`);
    }
    const res = makeRes();
    const blocked = await authRateLimit(makeReq({ ip, body: { email } }), res);
    assert.equal(blocked, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.success, false);
  });

  test('same account attacked from many IPs is still throttled (account bucket)', async () => {
    const email = 'victim@example.com';
    for (let i = 0; i < 10; i++) {
      const ok = await authRateLimit(makeReq({ ip: `192.0.2.11${i}`, body: { email } }), makeRes());
      assert.equal(ok, true, `attempt ${i + 1} from a fresh IP should pass the IP+account bucket`);
    }
    const res = makeRes();
    const blocked = await authRateLimit(makeReq({ ip: '192.0.2.200', body: { email } }), res);
    assert.equal(blocked, false, 'a fresh IP must still be blocked by the account bucket');
    assert.equal(res.statusCode, 429);
  });

  test('different emails/IPs are independent', async () => {
    assert.equal(await authRateLimit(makeReq({ ip: '192.0.2.31', body: { email: 'x1@example.com' } }), makeRes()), true);
    assert.equal(await authRateLimit(makeReq({ ip: '192.0.2.32', body: { email: 'x2@example.com' } }), makeRes()), true);
    assert.equal(await authRateLimit(makeReq({ ip: '192.0.2.33', body: { email: 'x1@example.com' } }), makeRes()), true);
  });

  test('missing email falls back to IP-only keying (e.g. reset-password)', async () => {
    const ip = '192.0.2.41';
    for (let i = 0; i < 10; i++) {
      assert.equal(await authRateLimit(makeReq({ ip, body: { newPassword: 'x' } }), makeRes()), true);
    }
    const res = makeRes();
    assert.equal(await authRateLimit(makeReq({ ip, body: { newPassword: 'x' } }), res), false);
    assert.equal(res.statusCode, 429);
  });

  test('email normalization: same account with different casing shares a bucket', async () => {
    const ip = '192.0.2.42';
    for (let i = 0; i < 10; i++) {
      const email = i % 2 === 0 ? 'Case@Test.com' : 'case@test.com';
      assert.equal(await authRateLimit(makeReq({ ip, body: { email } }), makeRes()), true);
    }
    const res = makeRes();
    assert.equal(await authRateLimit(makeReq({ ip, body: { email: 'CASE@test.com' } }), res), false);
    assert.equal(res.statusCode, 429);
  });
});

// ── unit: standard rateLimit stays backwards compatible ─────────────────
describe('lib/_rate_limit — rateLimit (standard)', () => {
  test('allowed request passes and sets the standard limit headers', async () => {
    const req = makeReq({ ip: '192.0.2.51' });
    const res = makeRes();
    assert.equal(await rateLimit(req, res), true);
    assert.equal(res.headers['X-RateLimit-Limit'], '100');
    assert.notEqual(res.statusCode, 429);
  });

  test('uses a separate bucket from authRateLimit', async () => {
    const ip = '192.0.2.52';
    assert.equal(await rateLimit(makeReq({ ip }), makeRes()), true);
    // The same IP doing auth requests must not consume the standard bucket.
    assert.equal(await authRateLimit(makeReq({ ip, body: { email: 'sep@example.com' } }), makeRes()), true);
    assert.equal(await rateLimit(makeReq({ ip }), makeRes()), true);
  });
});

// ── integration: api/auth-all wiring ────────────────────────────────────
describe('api/auth-all wiring', () => {
  // Mock the Better Auth delegate BEFORE requiring the route.
  const authModule = require('../lib/auth');
  let delegateCalls = 0;
  authModule.getNodeHandler = () => async (req, res) => {
    delegateCalls += 1;
    res.status(200).json({ ok: true, method: req.method, url: req.url });
  };

  const authAllHandler = require('../api/auth-all');

  beforeEach(() => {
    delegateCalls = 0;
  });

  test('sensitive auth endpoint passes through to the handler when under the limit', async () => {
    const req = makeReq({ url: '/api/auth/sign-in/email', ip: '192.0.2.201', body: { email: 'flow@example.com', password: 'pw' } });
    const res = makeRes();
    await authAllHandler(req, res);
    assert.equal(delegateCalls, 1);
    assert.equal(res.statusCode, 200);
  });

  test('sensitive auth endpoint is blocked with 429 over the limit and never reaches the handler', async () => {
    const ip = '192.0.2.202';
    const email = 'blocked@example.com';
    for (let i = 0; i < 10; i++) {
      await authAllHandler(makeReq({ url: '/api/auth/sign-in/email', ip, body: { email } }), makeRes());
    }
    assert.equal(delegateCalls, 10, 'the 10 allowed attempts should have reached the handler');
    const res = makeRes();
    await authAllHandler(makeReq({ url: '/api/auth/sign-in/email', ip, body: { email } }), res);
    assert.equal(res.statusCode, 429);
    assert.equal(delegateCalls, 10, 'the 11th request must be blocked before the handler');
  });

  test('sign-up endpoint is protected the same way', async () => {
    const ip = '192.0.2.203';
    const email = 'signup@example.com';
    for (let i = 0; i < 10; i++) {
      await authAllHandler(makeReq({ url: '/api/auth/sign-up/email', ip, body: { email } }), makeRes());
    }
    const res = makeRes();
    await authAllHandler(makeReq({ url: '/api/auth/sign-up/email', ip, body: { email } }), res);
    assert.equal(res.statusCode, 429);
  });

  test('password-reset endpoint is protected (IP-only keying without email)', async () => {
    const ip = '192.0.2.204';
    for (let i = 0; i < 10; i++) {
      await authAllHandler(makeReq({ url: '/api/auth/reset-password/email', ip, body: { token: 't', newPassword: 'x' } }), makeRes());
    }
    const res = makeRes();
    await authAllHandler(makeReq({ url: '/api/auth/reset-password/email', ip, body: { token: 't', newPassword: 'x' } }), res);
    assert.equal(res.statusCode, 429);
  });

  test('non-sensitive auth path is served by the standard limiter and reaches the handler', async () => {
    const req = makeReq({ method: 'GET', url: '/api/auth/get-session', ip: '192.0.2.205', body: {} });
    const res = makeRes();
    await authAllHandler(req, res);
    assert.equal(delegateCalls, 1);
    assert.equal(res.statusCode, 200);
  });

  test('no credential values leak into rate-limit responses or headers', async () => {
    const req = makeReq({ url: '/api/auth/sign-in/email', ip: '192.0.2.206', body: { email: 'pw@example.com', password: 'super-secret-value' } });
    const res = makeRes();
    await authAllHandler(req, res);
    assert.equal(delegateCalls, 1);
    const serialized = JSON.stringify({ body: res.body, headers: res.headers });
    assert.equal(serialized.includes('super-secret-value'), false, 'password must never appear in the response');
    assert.equal(serialized.includes('pw@example.com'), false, 'raw email must never appear in the response');
  });
});
