'use strict';

/**
 * Unit tests for the SQL query that populates streams.active in
 * GET /api/health/dashboard.
 *
 * Definition (Phase A):
 *   Active Streams = enabled cameras
 *                   + has media_node_id
 *                   + the media node has a fresh heartbeat (< 90 seconds ago)
 *
 * These tests validate the WHERE-clause structure emitted by
 * lib/handlers/health.js — they assert the SQL string and parameter
 * binding, not live DB results. No real database, MediaMTX, FFmpeg, RTSP,
 * or stream polling is used.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');

let allQueryAsOrgCalls = [];
let allQueryAsPlatformAdminCalls = [];

db.queryAsOrg = async (orgId, text, params) => {
  allQueryAsOrgCalls.push({ orgId, text, params });
  return { rows: [{ online: 0, offline: 0, degraded: 0, unknown: 0, active: 0 }] };
};
db.queryAsPlatformAdmin = async (text, params) => {
  allQueryAsPlatformAdminCalls.push({ text, params });
  return { rows: [{ online: 0, offline: 0, degraded: 0, unknown: 0, active: 0 }] };
};

function resetQueries() {
  allQueryAsOrgCalls = [];
  allQueryAsPlatformAdminCalls = [];
}

function getStreamQuery() {
  const all = [...allQueryAsOrgCalls.map(c => ({ ...c, method: 'queryAsOrg' })),
               ...allQueryAsPlatformAdminCalls.map(c => ({ ...c, method: 'queryAsPlatformAdmin' }))];
  return all.find(c => c.text.includes('JOIN media_nodes n ON n.id = c.media_node_id')) || null;
}

let authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };

authModule.requireAuth = async (req, res) => {
  if (authResponse === null) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }
  return authResponse;
};
rateLimitModule.rateLimit = async () => true;

const handler = require('../lib/handlers/health');

function makeReq() {
  return { url: '/api/health/dashboard', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('streams.active SQL shape', () => {
  test('A) enabled camera + online node — SQL JOINs media_nodes and filters enabled', async () => {
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    assert.ok(streamCall, 'stream query must exist');
    assert.ok(streamCall.text.includes('JOIN media_nodes n ON n.id = c.media_node_id'), 'must JOIN media_nodes');
    assert.ok(streamCall.text.includes('c.enabled = TRUE'), 'must filter enabled = TRUE');
    assert.ok(streamCall.text.includes('n.last_heartbeat_at > now() - interval'), 'must filter heartbeat');
    assert.deepEqual(streamCall.params, ['org-1']);
  });

  test('B) disabled camera NOT counted — c.enabled = TRUE filter present', async () => {
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    assert.ok(streamCall.text.includes('c.enabled = TRUE'),
      'disabled cameras excluded by c.enabled = TRUE filter');
  });

  test('C) stale/offline node NOT counted — 90s heartbeat threshold', async () => {
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    assert.match(streamCall.text, /n\.last_heartbeat_at > now\(\) - interval '90 seconds'/);
  });

  test('D) NULL media_node_id NOT counted — INNER JOIN excludes NULLs', async () => {
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    // INNER JOIN (not LEFT JOIN) ensures cameras with NULL media_node_id are excluded
    assert.ok(streamCall.text.includes('JOIN media_nodes n ON n.id = c.media_node_id'),
      'must use INNER JOIN so NULL media_node_id cameras are excluded');
    assert.ok(!streamCall.text.includes('LEFT JOIN'), 'must NOT be LEFT JOIN');
  });

  test('E) organization isolation — org_admin uses queryAsOrg + AND org_id', async () => {
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    assert.equal(streamCall.method, 'queryAsOrg');
    assert.equal(streamCall.orgId, 'org-1');
    assert.ok(streamCall.text.includes('AND c.organization_id = $1'),
      'org_admin query must include organization_id filter');
    assert.deepEqual(streamCall.params, ['org-1']);
  });

  test('F) platform admin scoping — queryAsPlatformAdmin, NO org filter', async () => {
    authResponse = {
      userId: 'admin-1', organizationId: 'org-1', userType: 'platform_admin',
    };
    resetQueries();
    const res = makeRes();
    await handler(makeReq(), res);

    const streamCall = getStreamQuery();
    assert.equal(streamCall.method, 'queryAsPlatformAdmin');
    assert.ok(!streamCall.text.includes('organization_id'),
      'platform_admin query must NOT include organization_id filter (no cross-tenant leakage)');
    assert.deepEqual(streamCall.params || [], []);
  });

  test('G) existing health response shape — streams has active/audio_ready/talk_ready', async () => {
    authResponse = { userId: 'u1', organizationId: 'org-1', userType: 'org_admin' };
    const res = makeRes();
    await handler(makeReq(), res);

    const keys = Object.keys(res.body.streams).sort();
    assert.deepEqual(keys, ['active', 'audio_ready', 'talk_ready']);
    assert.equal(typeof res.body.streams.active, 'number');
  });
});
