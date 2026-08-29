'use strict';

/**
 * Tests for GET /api/health/dashboard — org-scoping of dashboard counters.
 *
 * Regression suite: the dashboard endpoint must never return global
 * camera / media-node / audit counts to a non-platform user. Platform
 * admins keep the global view (queryAsPlatformAdmin); every other
 * authenticated user is strictly scoped to their own organization via
 * queryAsOrg + WHERE/AND organization_id = $1. A non-platform user
 * without an organization id gets the zeroed payload with no DB queries.
 *
 * All external dependencies are faked before the module under test is
 * required, so these tests never hit a real database or session store
 * (same technique as test/cameras_api.test.js).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryAsOrgCalls = [];
let queryAsPlatformAdminCalls = [];

function fakeRows(text) {
  if (text.includes('JOIN media_nodes n ON n.id = c.media_node_id')) {
    return { rows: [{ active: 2 }] };
  }
  if (text.includes('FROM media_nodes')) {
    return { rows: [{ active: 4, offline: 1, unknown: 0 }] };
  }
  if (text.includes('FROM cameras')) {
    return { rows: [{ online: 3, offline: 1, degraded: 0, unknown: 2 }] };
  }
  if (text.includes('audit_logs')) {
    return { rows: [{ name: 'camera', error: 'boom' }] };
  }
  return { rows: [], rowCount: 0 };
}

function resetFakes() {
  queryAsOrgCalls = [];
  queryAsPlatformAdminCalls = [];
}

db.queryAsOrg = async (orgId, text, params) => {
  queryAsOrgCalls.push({ orgId, text, params });
  return fakeRows(text);
};

db.queryAsPlatformAdmin = async (text, params) => {
  queryAsPlatformAdminCalls.push({ text, params });
  return fakeRows(text);
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };

authModule.requireAuth = async (req, res) => {
  if (authResponse === null) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  return authResponse;
};

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── load module under test AFTER patching its dependencies ───────────────
const handler = require('../lib/handlers/health');

// ── req/res test helpers ──────────────────────────────────────────────────
function makeReq() {
  return { url: '/api/health/dashboard', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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

describe('GET /api/health/dashboard', () => {
  beforeEach(() => {
    resetFakes();
    authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
  });

  test('org user: sva 4 query-ja idu kroz queryAsOrg sa organization filterom', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(queryAsOrgCalls.length, 4);
    assert.equal(queryAsPlatformAdminCalls.length, 0);

    for (const call of queryAsOrgCalls) {
      assert.equal(call.orgId, 'org-1');
      assert.deepEqual(call.params, ['org-1']);
    }

    const [cameras, streams, nodes, audit] = queryAsOrgCalls;
    assert.match(cameras.text, /FROM cameras WHERE organization_id = \$1/);
    assert.match(streams.text, /FROM cameras c\n\s+JOIN media_nodes n/);
    assert.match(streams.text, /c\.enabled = TRUE/);
    assert.match(streams.text, /n\.last_heartbeat_at > now\(\) - interval '90 seconds'/);
    assert.match(streams.text, /AND c\.organization_id = \$1/);
    assert.match(nodes.text, /FROM media_nodes WHERE id IN \(SELECT media_node_id FROM cameras WHERE organization_id = \$1/);
    assert.match(audit.text, /AND organization_id = \$1/);
  });

  test('org user: nijedan query ne ide kroz queryAsPlatformAdmin', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(queryAsPlatformAdminCalls.length, 0);
    assert.equal(queryAsOrgCalls.length, 4);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.streams.active, 2);
  });

   test('platform_admin: sva 4 query-ja idu kroz queryAsPlatformAdmin (globalno)', async () => {
    authResponse = { userId: 'admin-1', organizationId: 'org-1', userType: 'platform_admin' };

    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(queryAsPlatformAdminCalls.length, 4);
    assert.equal(queryAsOrgCalls.length, 0);

    // Globalni SQL: nijedan query ne sme imati organization filter.
    for (const call of queryAsPlatformAdminCalls) {
      assert.doesNotMatch(call.text, /organization_id/);
    }
    assert.equal(res.body.streams.active, 2);
  });

  test('missing/null organizationId: zeroed response + 0 DB query-ja', async () => {
    authResponse = { userId: 'user-1', organizationId: null, userType: 'org_admin' };

    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(queryAsOrgCalls.length, 0);
    assert.equal(queryAsPlatformAdminCalls.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.cameras, { online: 0, offline: 0, degraded: 0, unknown: 0 });
    assert.deepEqual(res.body.media_nodes, { active: 0, offline: 0, unknown: 0 });
    assert.deepEqual(res.body.streams, { active: 0, audio_ready: 0, talk_ready: 0 });
    assert.deepEqual(res.body.recent_errors, []);
  });

  test('requireAuth null: 401 + 0 DB query-ja', async () => {
    authResponse = null;

    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res.statusCode, 401);
    assert.ok(res.body && res.body.error);
    assert.equal(queryAsOrgCalls.length, 0);
    assert.equal(queryAsPlatformAdminCalls.length, 0);
  });

  test('validan response: postojeci JSON shape ostaje isti', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.ok(res.body);
    assert.equal(typeof res.body.timestamp, 'string');
    assert.deepEqual(Object.keys(res.body.cameras).sort(), ['degraded', 'offline', 'online', 'unknown']);
    assert.deepEqual(Object.keys(res.body.media_nodes).sort(), ['active', 'offline', 'unknown']);
    assert.deepEqual(Object.keys(res.body.streams).sort(), ['active', 'audio_ready', 'talk_ready']);
    assert.equal(res.body.cameras.online, 3);
    assert.equal(res.body.cameras.offline, 1);
    assert.equal(res.body.cameras.unknown, 2);
    assert.equal(res.body.media_nodes.active, 4);
    assert.equal(res.body.streams.active, 2);
    assert.deepEqual(res.body.recent_errors, [{ name: 'camera', error: 'boom' }]);
  });
});
