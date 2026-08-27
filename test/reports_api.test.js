'use strict';

/**
 * Tests for api/reports/index.js — Reports Summary API.
 *
 * Verifies:
 * - Authentication required
 * - Date range calculation for daily/weekly/monthly
 * - Explicit from/to respected
 * - Validation of type and date format
 * - Organization isolation
 * - Aggregation fields present
 * - Audit logging
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
  authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
authModule.requireAuth = async (req, res, opts) => {
  if (authResponse === null) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  return authResponse;
};

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── fake audit ───────────────────────────────────────────────────────────
const auditModule = require('../lib/_audit');
let auditCalls = [];
auditModule.logAudit = async (entry) => { auditCalls.push(entry); };
auditModule.getIp = () => '127.0.0.1';

// ── load module under test AFTER patching its dependencies ───────────────
const handler = require('../api/reports');

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

describe('api/reports — Reports Summary', () => {
  beforeEach(() => {
    resetFakes();
    auditCalls = [];
  });

  describe('GET /api/reports/summary', () => {
    test('unauthenticated GET → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'GET', query: { type: 'daily' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('authenticated GET daily → success with correct date range', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [{ status: 'New', count: '5' }] };
        if (text.includes('GROUP BY severity')) return { rows: [{ severity: 'high', count: '3' }] };
        if (text.includes('GROUP BY c.id')) return { rows: [{ camera_id: 'cam-1', camera_name: 'Cam 1', count: '10' }] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '25', avg_resolution_minutes: '45.5' }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'daily' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.report_type, 'daily');
      assert.ok(res.body.date_range);
      assert.ok(res.body.summary);
      assert.equal(res.body.summary.total_incidents, 25);
    });

    test('authenticated GET weekly → success', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [] };
        if (text.includes('GROUP BY severity')) return { rows: [] };
        if (text.includes('GROUP BY c.id')) return { rows: [] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '100', avg_resolution_minutes: '60' }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'weekly' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.report_type, 'weekly');
    });

    test('authenticated GET monthly → success', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [] };
        if (text.includes('GROUP BY severity')) return { rows: [] };
        if (text.includes('GROUP BY c.id')) return { rows: [] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '500', avg_resolution_minutes: '120' }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'monthly' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.report_type, 'monthly');
    });

    test('explicit from/to → respected', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [] };
        if (text.includes('GROUP BY severity')) return { rows: [] };
        if (text.includes('GROUP BY c.id')) return { rows: [] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '10', avg_resolution_minutes: '30' }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'daily', from: '2026-01-01', to: '2026-01-31' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.date_range.from, '2026-01-01');
      assert.equal(res.body.date_range.to, '2026-01-31');
    });

    test('invalid type → validation error', async () => {
      const req = makeReq({ method: 'GET', query: { type: 'invalid' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('invalid date format → validation error', async () => {
      const req = makeReq({ method: 'GET', query: { type: 'daily', from: '01-01-2026' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('organization isolation — queries scoped by auth org', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [] };
        if (text.includes('GROUP BY severity')) return { rows: [] };
        if (text.includes('GROUP BY c.id')) return { rows: [] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '0', avg_resolution_minutes: null }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'daily' } });
      const res = makeRes();
      await handler(req, res);

      const statusQuery = queryCalls.find((c) => c.text.includes('GROUP BY status'));
      assert.equal(statusQuery.orgId, 'org-1');
    });

    test('organization_id in query is rejected by strict schema', async () => {
      const req = makeReq({ method: 'GET', query: { type: 'daily', organization_id: 'other-org' } });
      const res = makeRes();
      await handler(req, res);

      // Strict schema should reject unknown query params
      assert.equal(res.statusCode, 400, 'strict schema should reject unknown query params');
    });

    test('aggregation fields present in response', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [{ status: 'New', count: '5' }, { status: 'Resolved', count: '20' }] };
        if (text.includes('GROUP BY severity')) return { rows: [{ severity: 'high', count: '10' }] };
        if (text.includes('GROUP BY c.id')) return { rows: [{ camera_id: 'cam-1', camera_name: 'Cam 1', count: '15' }] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '25', avg_resolution_minutes: '45.5' }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'daily' } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(res.body.summary.total_incidents !== undefined);
      assert.ok(res.body.summary.by_status !== undefined);
      assert.ok(res.body.summary.by_severity !== undefined);
      assert.ok(res.body.summary.by_camera !== undefined);
      assert.ok(res.body.summary.avg_resolution_time_minutes !== undefined);
      assert.equal(res.body.summary.by_status.New, 5);
      assert.equal(res.body.summary.by_status.Resolved, 20);
      assert.equal(res.body.summary.by_camera.length, 1);
      assert.equal(res.body.summary.avg_resolution_time_minutes, 46);
    });

    test('audit log is created on GET', async () => {
      dbScript = (text) => {
        if (text.includes('GROUP BY status')) return { rows: [] };
        if (text.includes('GROUP BY severity')) return { rows: [] };
        if (text.includes('GROUP BY c.id')) return { rows: [] };
        if (text.includes('COUNT(*) as total')) return { rows: [{ total: '0', avg_resolution_minutes: null }] };
        if (text.includes('FROM incidents i')) return { rows: [] };
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { type: 'daily' } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0);
      assert.equal(auditCalls[0].action, 'report.view');
    });
  });
});
