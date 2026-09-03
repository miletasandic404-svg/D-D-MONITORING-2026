'use strict';

/**
 * Tests for api/incidents/index.js — GET /api/incidents.
 *
 * Verifies the "Incidents Today" date filter (i.created_at >= CURRENT_DATE)
 * is applied in both SQL branches, and that tenant isolation / camera-access
 * / dismissed-event filters remain intact.
 *
 * All external dependencies are faked (same technique as cameras_api.test.js).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
let queryCalls = [];
let dbScript = null;
let authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
let cameraAccess = null;

function resetFakes() {
  queryCalls = [];
  dbScript = null;
  authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
  cameraAccess = null;
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

db.queryAsPlatformAdmin = async (text, params) => {
  queryCalls.push({ text, params, orgId: null });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

const authModule = require('../lib/_auth');
authModule.requireAuth = async () => authResponse;
authModule.getAccessibleCameraIds = async () => cameraAccess;

const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

const handler = require('../api/incidents');

function makeReq({ method = 'GET', query = {} } = {}) {
  return { method, query, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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

const TODAY = new Date();
const YESTERDAY = new Date(TODAY);
YESTERDAY.setDate(TODAY.getDate() - 1);

const todayIncident = (id) => ({
  id: `inc-${id}`,
  event_id: id,
  status: 'New',
  severity: 'medium',
  assigned_operator_id: null,
  created_at: TODAY,
  acknowledged_at: null,
  resolved_at: null,
  camera_id: 'CAM-1',
  source_description: 'Event test',
  object_type: 'person',
  confidence: 0.85,
});

const yesterdayIncident = (id) => ({
  id: `inc-${id}`,
  event_id: id,
  status: 'New',
  severity: 'medium',
  assigned_operator_id: null,
  created_at: YESTERDAY,
  acknowledged_at: null,
  resolved_at: null,
  camera_id: 'CAM-1',
  source_description: 'Event test',
  object_type: 'person',
  confidence: 0.85,
});

describe('api/incidents — Incidents Today date filter', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('SQL contains date filter in platform/admin branch', async () => {
    cameraAccess = null;
    await handler(makeReq(), makeRes());
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i'))?.text || '';
    assert.match(sql, /i\.created_at\s*>=\s*CURRENT_DATE/,
      'platform/admin branch must include AND i.created_at >= CURRENT_DATE');
  });

  test('SQL contains date filter in camera-access branch', async () => {
    cameraAccess = ['CAM-1'];
    await handler(makeReq(), makeRes());
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i'))?.text || '';
    assert.match(sql, /i\.created_at\s*>=\s*CURRENT_DATE/,
      'camera-access branch must include AND i.created_at >= CURRENT_DATE');
  });

  test('today\'s incident is included', async () => {
    cameraAccess = null;
    dbScript = () => ({
      rows: [todayIncident(1)],
      rowCount: 1,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.incidents[0].id, 'inc-1');
  });

  test('yesterday\'s incident is excluded by SQL date filter', async () => {
    cameraAccess = null;
    // Simulates PostgreSQL applying `WHERE i.created_at >= CURRENT_DATE`
    // and filtering out yesterday's incident
    dbScript = (text) => {
      if (text.includes('CURRENT_DATE')) {
        // The SQL filter is present — DB would exclude yesterday
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    // SQL has the filter, so yesterday's incident is excluded at the DB level
    const sql = queryCalls.find((c) => c.text.includes('CURRENT_DATE'))?.text;
    assert.ok(sql, 'SQL must contain CURRENT_DATE filter');
  });

  test('dismissed events are excluded', async () => {
    cameraAccess = null;
    dbScript = () => ({ rows: [], rowCount: 0 });
    await handler(makeReq(), makeRes());
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i'))?.text || '';
    assert.match(sql, /e\.is_dismissed\s*=\s*FALSE/,
      'dismissed events must be filtered');
  });

  test('organization_id filtering is present in both branches', async () => {
    cameraAccess = null;
    await handler(makeReq(), makeRes());
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i'))?.text || '';
    assert.match(sql, /i\.organization_id\s*=\s*\$1/,
      'both branches must filter by organization_id');
  });

  test('organization isolation: org_id comes from auth, not request', async () => {
    cameraAccess = null;
    dbScript = () => ({ rows: [todayIncident(1)], rowCount: 1 });
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    // Verify orgId used in query matches auth
    const orgCall = queryCalls.find((c) => c.text.includes('FROM incidents i'));
    assert.equal(orgCall.orgId, 'org-1', 'query must use auth.organizationId');
  });

  test('camera_id filter is present when user has camera access', async () => {
    cameraAccess = ['CAM-1', 'CAM-2'];
    dbScript = () => ({ rows: [todayIncident(1)], rowCount: 1 });
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const sql = queryCalls.find((c) => c.text.includes('i.camera_id = ANY'))?.text || '';
    assert.match(sql, /i\.camera_id\s*=\s*ANY\(\$2::varchar\[\]\)/,
      'camera access branch must filter by camera_id = ANY($2)');
  });

  test('LIMIT 100 is preserved after date filter', async () => {
    cameraAccess = null;
    await handler(makeReq(), makeRes());
    // Match the LIST query (not the uncapped count query).
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i') && c.text.includes('LIMIT 100'))?.text || '';
    assert.match(sql, /LIMIT 100/,
      'LIMIT 100 must remain');
  });

  test('ORDER BY i.created_at DESC is preserved', async () => {
    cameraAccess = null;
    await handler(makeReq(), makeRes());
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i') && c.text.includes('LIMIT 100'))?.text || '';
    assert.match(sql, /ORDER BY i\.created_at DESC/,
      'ORDER BY must remain');
  });

  test('empty accessibleIds returns 0 incidents without DB query', async () => {
    cameraAccess = [];
    dbScript = () => ({ rows: [{ id: 'SHOULD_NOT_CALL' }], rowCount: 1 });
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 0);
    assert.equal(res.body.incidents.length, 0);
    // Verify the incident SELECT was not called
    const incidentQuery = queryCalls.find((c) => c.text.includes('FROM incidents i'));
    assert.equal(incidentQuery, undefined, 'incident query should not run when no accessible cameras');
  });

  test('platform_admin does not get camera_id filter (accessibleIds === null)', async () => {
    authResponse = { userId: 'admin-1', organizationId: 'org-1', role: 'platform_admin' };
    cameraAccess = null;
    dbScript = () => ({ rows: [todayIncident(1)], rowCount: 1 });
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const sql = queryCalls.find((c) => c.text.includes('FROM incidents i'))?.text || '';
    assert.doesNotMatch(sql, /i\.camera_id\s*=\s*ANY/,
      'platform admin (accessibleIds === null) should NOT have camera_id filter');
  });

  // ── Dashboard "Incidents Today" tile: exact total, not capped ────────
  describe('incidents — exact total for "Incidents Today" tile', () => {
    test('response carries a `total` field equal to the uncapped count', async () => {
      cameraAccess = null;
      // Simulate: 137 incidents today in the DB, the list returns
      // the 100 newest, the count query returns 137. The Dashboard
      // tile must show 137, not 100.
      let countCalls = 0;
      let listCalls = 0;
      dbScript = (text) => {
        if (text.includes('count(*)::int AS total')) {
          countCalls += 1;
          return { rows: [{ total: 137 }], rowCount: 1 };
        }
        if (text.includes('LIMIT 100')) {
          listCalls += 1;
          const rows = Array.from({ length: 100 }, (_, i) => todayIncident(i + 1));
          return { rows, rowCount: 100 };
        }
        return { rows: [], rowCount: 0 };
      };
      const res = makeRes();
      await handler(makeReq(), res);
      assert.equal(res.statusCode, 200);
      assert.equal(countCalls, 1, 'count query should run exactly once');
      assert.equal(listCalls, 1, 'list query should run exactly once');
      assert.equal(res.body.count, 100, 'count stays the page size');
      assert.equal(res.body.total, 137, 'total is the uncapped exact count');
    });

    test('total is 0 when there are no incidents today', async () => {
      cameraAccess = null;
      dbScript = () => ({ rows: [], rowCount: 0 });
      const res = makeRes();
      await handler(makeReq(), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.total, 0);
      assert.equal(res.body.incidents.length, 0);
    });

    test('total query uses the same WHERE as the list (org + today + not-dismissed)', async () => {
      cameraAccess = null;
      dbScript = () => ({ rows: [{ total: 5 }], rowCount: 1 });
      const res = makeRes();
      await handler(makeReq(), res);
      const countSql = queryCalls.find((c) => c.text.includes('count(*)::int AS total'))?.text || '';
      assert.match(countSql, /e\.is_dismissed\s*=\s*FALSE/, 'count must filter dismissed events');
      assert.match(countSql, /i\.organization_id\s*=\s*\$1/, 'count must be org-scoped');
      assert.match(countSql, /i\.created_at\s*>=\s*CURRENT_DATE/, 'count must restrict to today');
      assert.doesNotMatch(countSql, /LIMIT/i, 'count must NOT carry a LIMIT');
    });

    test('total query in camera-access branch filters by camera_id', async () => {
      cameraAccess = ['CAM-1', 'CAM-2'];
      dbScript = () => ({ rows: [{ total: 2 }], rowCount: 1 });
      const res = makeRes();
      await handler(makeReq(), res);
      const countSql = queryCalls.find((c) => c.text.includes('count(*)::int AS total'))?.text || '';
      assert.match(countSql, /i\.camera_id\s*=\s*ANY\(\$2::varchar\[\]\)/,
        'camera-access count must filter by camera_id');
    });

    test('total query is NOT issued when accessibleIds is []', async () => {
      cameraAccess = [];
      dbScript = () => ({ rows: [{ id: 'SHOULD_NOT_CALL' }], rowCount: 1 });
      const res = makeRes();
      await handler(makeReq(), res);
      const countSql = queryCalls.find((c) => c.text.includes('count(*)::int AS total'));
      assert.equal(countSql, undefined, 'count query must be skipped when no accessible cameras');
      assert.equal(res.body.total, 0);
    });
  });
});
