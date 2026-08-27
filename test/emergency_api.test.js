'use strict';

/**
 * Tests for api/emergency/index.js — Emergency Dispatch API.
 *
 * Verifies:
 * - Authentication required
 * - Organization isolation
 * - Audit logging
 * - Cross-org access prevention
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
const handler = require('../api/emergency');

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

describe('api/emergency — Emergency Dispatch', () => {
  beforeEach(() => {
    resetFakes();
    auditCalls = [];
  });

  describe('POST /api/emergency', () => {
    test('unauthenticated POST → 401', async () => {
      authResponse = null;
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'intrusion', priority: 'high' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('authenticated POST → success', async () => {
      dbScript = (text) => {
        if (text.includes('INSERT INTO emergency_dispatches')) {
          return { rows: [{ id: 'dispatch-1', status: 'pending' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'intrusion', priority: 'high', location: 'Building A' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
    });

    test('organization_id comes from auth context', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO emergency_dispatches')) {
          return { rows: [{ id: 'dispatch-1', status: 'pending' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'fire' },
      });
      const res = makeRes();
      await handler(req, res);

      const insertCall = queryCalls.find((c) => c.text.includes('INSERT INTO emergency_dispatches'));
      assert.ok(insertCall, 'INSERT query should be captured');
      assert.equal(insertCall.orgId, 'org-1');
    });

    test('organization_id in body is ignored — INSERT uses auth org_id', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO emergency_dispatches')) {
          return { rows: [{ id: 'dispatch-1', organization_id: 'org-1', status: 'pending' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'fire', organization_id: 'malicious-org' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201, 'request should succeed');
      const insertCall = queryCalls.find((c) => c.text.includes('INSERT INTO emergency_dispatches'));
      assert.ok(insertCall, 'INSERT query should be captured');
      assert.equal(insertCall.orgId, 'org-1', 'INSERT should use auth org_id');
      assert.equal(insertCall.params[0], 'org-1', 'organization_id param should be from auth');
    });

    test('audit log is created on POST', async () => {
      dbScript = (text) => {
        if (text.includes('INSERT INTO emergency_dispatches')) {
          return { rows: [{ id: 'dispatch-1', status: 'pending' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'medical', priority: 'critical' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0, 'audit log should be created');
      assert.equal(auditCalls[0].action, 'emergency.dispatch');
    });

    test('missing incident_type → validation error', async () => {
      const req = makeReq({
        method: 'POST',
        body: { priority: 'high' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('invalid priority → validation error', async () => {
      const req = makeReq({
        method: 'POST',
        body: { incident_type: 'intrusion', priority: 'invalid' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });
  });

  describe('GET /api/emergency', () => {
    test('unauthenticated GET → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('authenticated GET → returns dispatches for own org only', async () => {
      dbScript = (text) => {
        if (text.includes('FROM emergency_dispatches')) {
          return { rows: [{ id: 'd1', incident_type: 'fire' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      const queryCall = queryCalls.find((c) => c.text.includes('FROM emergency_dispatches'));
      assert.equal(queryCall.orgId, 'org-1');
    });

    test('cross-org access prevented — query scoped by auth org', async () => {
      dbScript = (text) => {
        if (text.includes('FROM emergency_dispatches')) {
          return { rows: [{ id: 'd1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET', query: { organization_id: 'other-org' } });
      const res = makeRes();
      await handler(req, res);

      const queryCall = queryCalls.find((c) => c.text.includes('FROM emergency_dispatches'));
      assert.equal(queryCall.orgId, 'org-1');
    });
  });
});
