'use strict';

/**
 * Tests for GET /api/health/storage.
 *
 * Storage Usage is the Dashboard's "Storage monitoring not configured"
 * placeholder. This endpoint is the only thing that can replace it
 * with real numbers. The contract:
 *
 *   - Auth is required (401 on missing session, same shape as the
 *     rest of the auth-gated surface).
 *   - Tenant isolation: an org user sees only their org's bytes and
 *     counts. A platform_admin sees the platform-wide sum. A non-
 *     platform user without an organizationId fails closed.
 *   - `configured` mirrors `lib/_storage.js#isConfigured` and is the
 *     single source of truth for "is storage wired up". We do not
 *     recompute it here.
 *   - The response NEVER contains bucket name, key, secret, region,
 *     endpoint, local path, or presigned URL. Only aggregate counts.
 *   - Failures do not 500 — the endpoint always returns a structured
 *     JSON body that the Dashboard can render as "Storage query
 *     failed" without breaking the rest of the page.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');
const storageModule = require('../lib/_storage');

let orgCalls = [];
let adminCalls = [];
// Single stable mock that reads the live `authResponse` variable. This
// is the proven pattern from test/health_dashboard.test.js — the
// handler destructures `requireAuth` at module load, so reassigning
// the property on `authModule` would NOT take effect. Mutating
// `authResponse` instead DOES take effect because the mock closes
// over it.
let authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
let storageConfigured = true;

authModule.requireAuth = async (req, res) => {
  if (authResponse === null) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  return authResponse;
};
rateLimitModule.rateLimit = async () => true;
storageModule.isConfigured = () => storageConfigured;

function fakeSum(text, bytes, count) {
  return { rows: [{ bytes: BigInt(bytes), count: BigInt(count) }] };
}

db.queryAsOrg = async (orgId, text, params) => {
  orgCalls.push({ orgId, text, params });
  if (text.includes('FROM snapshots')) return fakeSum(text, 1048576, 3);
  if (text.includes('FROM recordings')) return fakeSum(text, 5242880, 2);
  return { rows: [] };
};
db.queryAsPlatformAdmin = async (text, params) => {
  adminCalls.push({ text, params });
  if (text.includes('FROM snapshots')) return fakeSum(text, 2097152, 6);
  if (text.includes('FROM recordings')) return fakeSum(text, 10485700, 4);
  return { rows: [] };
};

const handler = require('../lib/handlers/health-storage');

function makeReq() {
  return { url: '/api/health-storage', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('GET /api/health/storage — auth', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
    storageConfigured = true;
  });

  test('returns 401 when there is no session', async () => {
    const prev = authResponse;
    authResponse = null;
    try {
      const r = makeRes();
      await handler(makeReq(), r);
      assert.equal(r.statusCode, 401);
      // handler must short-circuit when auth fails (no DB calls)
      assert.equal(orgCalls.length, 0);
      assert.equal(adminCalls.length, 0);
    } finally {
      authResponse = prev;
    }
  });

  test('non-platform user without organizationId fails closed (no DB queries)', async () => {
    authResponse = { userId: 'u2', organizationId: null, userType: 'org_user' };
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.error, 'no organization scope');
    assert.equal(orgCalls.length, 0);
    assert.equal(adminCalls.length, 0);
    // restore for next tests in the suite
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
  });
});

describe('GET /api/health/storage — org user (tenant-scoped)', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
    storageConfigured = true;
  });

  test('uses queryAsOrg + organization_id = $1 for both tables', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(orgCalls.length, 2, 'one query per table');
    for (const call of orgCalls) {
      assert.equal(call.orgId, 'org-1');
      assert.deepEqual(call.params, ['org-1']);
      assert.match(call.text, /WHERE organization_id = \$1/);
    }
  });

  test('returns aggregated bytes + counts for snapshots and recordings', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.source, 'db');
    assert.equal(r.body.snapshot_bytes, 1048576);
    assert.equal(r.body.recording_bytes, 5242880);
    assert.equal(r.body.used_bytes, 1048576 + 5242880);
    assert.equal(r.body.snapshot_count, 3);
    assert.equal(r.body.recording_count, 2);
    assert.equal(r.body.object_count, 5);
  });
});

describe('GET /api/health/storage — platform_admin', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'a1', organizationId: 'org-1', userType: 'platform_admin' };
    storageConfigured = true;
  });

  test('uses queryAsPlatformAdmin and no organization_id filter', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(adminCalls.length, 2);
    assert.equal(orgCalls.length, 0);
    for (const call of adminCalls) {
      assert.deepEqual(call.params, []);
      assert.doesNotMatch(call.text, /organization_id/);
    }
  });

  test('returns platform-wide totals', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.snapshot_bytes, 2097152);
    assert.equal(r.body.recording_bytes, 10485700);
    assert.equal(r.body.used_bytes, 2097152 + 10485700);
    assert.equal(r.body.snapshot_count, 6);
    assert.equal(r.body.recording_count, 4);
    assert.equal(r.body.object_count, 10);
  });
});

describe('GET /api/health/storage — unconfigured storage', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
    storageConfigured = false;
  });

  test('returns configured=false and skips DB queries entirely', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.source, 'unconfigured');
    assert.equal(r.body.used_bytes, 0);
    assert.equal(r.body.object_count, 0);
    assert.equal(orgCalls.length, 0);
    assert.equal(adminCalls.length, 0);
  });
});

describe('GET /api/health/storage — empty storage', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-empty', userType: 'org_admin' };
    storageConfigured = true;
  });

  test('returns 0 bytes and 0 counts when both tables are empty', async () => {
    db.queryAsOrg = async () => ({ rows: [{ bytes: BigInt(0), count: BigInt(0) }] });
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.used_bytes, 0);
    assert.equal(r.body.snapshot_count, 0);
    assert.equal(r.body.recording_count, 0);
    assert.equal(r.body.object_count, 0);
  });
});

describe('GET /api/health/storage — large byte values', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-big', userType: 'org_admin' };
    storageConfigured = true;
  });

  test('handles 1 PiB snapshots + 500 TiB recordings without overflow or precision loss', async () => {
    // 1 PiB = 2^50 = 1125899906842624
    // 500 TiB = 500 * 2^40 = 549755813888000
    db.queryAsOrg = async (orgId, text) => {
      orgCalls.push({ orgId, text });
      if (text.includes('FROM snapshots')) return fakeSum(text, 1125899906842624, 100000);
      if (text.includes('FROM recordings')) return fakeSum(text, 549755813888000, 5000);
      return { rows: [] };
    };
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.snapshot_bytes, 1125899906842624);
    assert.equal(r.body.recording_bytes, 549755813888000);
    assert.equal(r.body.used_bytes, 1125899906842624 + 549755813888000);
    assert.equal(r.body.snapshot_count, 100000);
    assert.equal(r.body.recording_count, 5000);
  });
});

describe('GET /api/health/storage — error handling', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
    storageConfigured = true;
  });

  test('DB throws -> configured=false, error=db query failed, body still 200', async () => {
    db.queryAsOrg = async () => { throw new Error('connection reset'); };
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.error, 'db query failed');
    assert.equal(r.body.used_bytes, 0);
    assert.equal(r.body.object_count, 0);
  });

  test('does not leak bucket/credentials/paths in any response shape', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    const serialized = JSON.stringify(r.body);
    for (const forbidden of [
      'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY',
      'STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_LOCAL_PATH',
      'STORAGE_PUBLIC_BASE_URL', 'access_key', 'secret', 'bucket',
      'presigned', 's3://', 'local://',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'), `must not leak "${forbidden}"`);
    }
  });
});
