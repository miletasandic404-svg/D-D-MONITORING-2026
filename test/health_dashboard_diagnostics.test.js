'use strict';

/**
 * Tests for the new diagnostic surface on /api/health/dashboard.
 *
 * Background: the Dashboard showed "Active Streams = 0" while a
 * Xiongmai test camera was actually Live. The root cause is one of:
 *   1. the camera has no media_node_id, or
 *   2. the assigned media node has not heartbeated in the last 90s.
 *
 * The definition of streams.active MUST NOT change (Phase A contract
 * is "enabled camera + node assigned + heartbeat < 90s"), but the
 * response now carries streams_diagnostics with the raw counts so
 * the UI can explain "0" without inventing a new value.
 *
 * Also: System Health / API Status must reflect a real probe
 * (api_reachable / api_status), not a hard-coded string.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');

let orgCalls = [];
let adminCalls = [];

function fakeDashboardRows(text) {
  // Order matters: "LEFT JOIN media_nodes" must be checked BEFORE the
  // plain "JOIN media_nodes" branch, because the latter substring also
  // appears in the former.
  if (text.includes('LEFT JOIN media_nodes n ON n.id = c.media_node_id')) {
    return { rows: [{ enabled_total: 5, enabled_with_node: 2, fresh_nodes: 0 }] };
  }
  if (text.includes('JOIN media_nodes n ON n.id = c.media_node_id')) {
    return { rows: [{ active: 0 }] };
  }
  if (text.includes('FROM media_nodes')) {
    return { rows: [{ active: 1, offline: 0, unknown: 0 }] };
  }
  if (text.includes('FROM cameras')) {
    return { rows: [{ online: 4, offline: 1, degraded: 0, unknown: 0 }] };
  }
  if (text.includes('audit_logs')) {
    return { rows: [] };
  }
  return { rows: [] };
}

db.queryAsOrg = async (orgId, text, params) => {
  orgCalls.push({ orgId, text, params });
  return fakeDashboardRows(text);
};
db.queryAsPlatformAdmin = async (text, params) => {
  adminCalls.push({ text, params });
  return fakeDashboardRows(text);
};

let authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
authModule.requireAuth = async () => authResponse;
rateLimitModule.rateLimit = async () => true;

const handler = require('../lib/handlers/health');

function makeReq() { return { url: '/api/health/dashboard', headers: {}, socket: { remoteAddress: '127.0.0.1' } }; }
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('streams_diagnostics + api_reachable', () => {
  beforeEach(() => {
    orgCalls = []; adminCalls = [];
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
  });

  test('response carries streams_diagnostics with all four keys', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    const d = r.body.streams_diagnostics;
    assert.ok(d, 'streams_diagnostics missing');
    assert.equal(typeof d.enabled_total, 'number');
    assert.equal(typeof d.enabled_with_node, 'number');
    assert.equal(typeof d.fresh_nodes, 'number');
    assert.equal(typeof d.fresh_threshold_seconds, 'number');
    assert.equal(d.fresh_threshold_seconds, 90);
  });

  test('diagnostic counts reflect the Active Streams = 0 / Live camera scenario', async () => {
    // Faked: 5 enabled, 2 with a node, 0 fresh → streams.active = 0
    // even though some cameras are "Live" (node assigned but stale).
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(r.body.streams.active, 0);
    assert.equal(r.body.streams_diagnostics.enabled_total, 5);
    assert.equal(r.body.streams_diagnostics.enabled_with_node, 2);
    assert.equal(r.body.streams_diagnostics.fresh_nodes, 0);
  });

  test('diagnostic query stays tenant-scoped (org_admin uses queryAsOrg + org_id filter)', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    const diag = orgCalls.find(c => c.text.includes('LEFT JOIN media_nodes n ON n.id = c.media_node_id'));
    assert.ok(diag, 'diagnostic query must run');
    assert.equal(diag.orgId, 'org-1');
    // Org filter may be WHERE … = $1 (first predicate) or AND … = $1.
    assert.match(diag.text, /(WHERE|AND) c\.organization_id = \$1/);
    assert.deepEqual(diag.params, ['org-1']);
  });

  test('diagnostic query has NO organization_id for platform_admin', async () => {
    authResponse = { userId: 'a1', organizationId: 'org-1', userType: 'platform_admin' };
    const r = makeRes();
    await handler(makeReq(), r);
    const diag = adminCalls.find(c => c.text.includes('LEFT JOIN media_nodes n ON n.id = c.media_node_id'));
    assert.ok(diag, 'diagnostic query must run');
    assert.doesNotMatch(diag.text, /organization_id/);
  });

  test('response carries api_reachable + api_status (System Health / API Status source)', async () => {
    const r = makeRes();
    await handler(makeReq(), r);
    assert.equal(typeof r.body.api_reachable, 'boolean');
    assert.ok(['online', 'offline', 'degraded'].includes(r.body.api_status));
  });

  test('api_reachable=false + api_status=offline when env is missing', async () => {
    const prevUrl = process.env.DATABASE_URL;
    const prevSecret = process.env.BETTER_AUTH_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      const r = makeRes();
      await handler(makeReq(), r);
      assert.equal(r.body.api_reachable, false);
      assert.equal(r.body.api_status, 'offline');
    } finally {
      if (prevUrl !== undefined) process.env.DATABASE_URL = prevUrl;
      if (prevSecret !== undefined) process.env.BETTER_AUTH_SECRET = prevSecret;
    }
  });

  test('api_status=degraded when db ping throws (env present, SELECT 1 fails)', async () => {
    const prevUrl = process.env.DATABASE_URL;
    const prevSecret = process.env.BETTER_AUTH_SECRET;
    process.env.DATABASE_URL = 'postgres://fake';
    process.env.BETTER_AUTH_SECRET = 'fake';
    // Make queryAsOrg succeed (so the dashboard queries run) but
    // db.query (the probe) throw.
    const origQueryAsOrg = db.queryAsOrg;
    db.queryAsOrg = async () => ({ rows: [{ online: 0, offline: 0, degraded: 0, unknown: 0 }] });
    const origQuery = db.query;
    db.query = async () => { throw new Error('boom'); };
    try {
      const r = makeRes();
      await handler(makeReq(), r);
      assert.equal(r.body.api_reachable, false);
      assert.equal(r.body.api_status, 'offline');
      assert.equal(r.body.api_degraded, true);
    } finally {
      db.queryAsOrg = origQueryAsOrg;
      db.query = origQuery;
      if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = prevSecret;
    }
  });
});
