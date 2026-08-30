'use strict';

/**
 * Tests for api/settings/index.js — Organization Settings API.
 *
 * Verifies:
 * - Authentication required
 * - RBAC: only org_admin/platform_admin can modify
 * - Organization isolation
 * - Validation of fields and values
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
  authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
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
const handler = require('../api/users');

// ── req/res test helpers ──────────────────────────────────────────────────
function makeReq({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query: { path: 'settings', ...query }, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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

describe('api/settings — Organization Settings', () => {
  beforeEach(() => {
    resetFakes();
    auditCalls = [];
  });

  describe('GET /api/settings', () => {
    test('unauthenticated GET → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('authenticated GET → returns defaults if no row exists', async () => {
      dbScript = (text) => {
        if (text.includes('FROM organization_settings')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.settings);
      assert.equal(res.body.settings.email_alerts, true);
      assert.deepEqual(res.body.settings.emergency_contacts, {});
    });

    test('authenticated GET → returns existing settings including emergency_contacts', async () => {
      dbScript = (text) => {
        if (text.includes('FROM organization_settings')) {
          return { rows: [{ email_alerts: false, dark_mode: true, emergency_contacts: { police: { name: 'Police', phone: '911', enabled: true } } }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.settings.emergency_contacts, { police: { name: 'Police', phone: '911', enabled: true } });
    });

    test('GET scoped to authenticated org', async () => {
      dbScript = (text) => {
        if (text.includes('FROM organization_settings')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      const queryCall = queryCalls.find((c) => c.text.includes('FROM organization_settings'));
      assert.equal(queryCall.orgId, 'org-1');
    });
  });

  describe('PUT /api/settings', () => {
    test('unauthenticated PUT → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('org_admin can PUT → success', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1', email_alerts: false }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });

    test('platform_admin can PUT → success', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'platform_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1', email_alerts: false }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });

    test('operator cannot PUT → 403', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 403);
    });

    test('invalid setting field → rejected', async () => {
      const req = makeReq({ method: 'PUT', body: { invalid_field: true } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('invalid value type → rejected', async () => {
      const req = makeReq({ method: 'PUT', body: { email_alerts: 'not-a-boolean' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('organization_id from auth context', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1', email_alerts: false }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      const insertCall = queryCalls.find((c) => c.text.includes('INSERT INTO organization_settings'));
      assert.ok(insertCall, 'INSERT query should be captured');
      assert.equal(insertCall.orgId, 'org-1');
    });

    test('organization_id in body is rejected by strict schema', async () => {
      const req = makeReq({ method: 'PUT', body: { email_alerts: false, organization_id: 'malicious-org' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400, 'strict schema should reject unknown fields');
    });

    test('audit log is created on PUT', async () => {
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', body: { email_alerts: false } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0);
      assert.equal(auditCalls[0].action, 'settings.update');
    });

    test('org_admin can PUT emergency_contacts → success', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1', emergency_contacts: { police: { name: 'Police', phone: '911', enabled: true } } }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'PUT',
        body: { emergency_contacts: { police: { name: 'Police', phone: '911', enabled: true } } },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.settings.emergency_contacts, { police: { name: 'Police', phone: '911', enabled: true } });
    });

    test('cross-org isolation — settings scoped to auth org', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO organization_settings')) {
          return { rows: [{ id: 's1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({
        method: 'PUT',
        body: { emergency_contacts: { police: { name: 'Police', phone: '111', enabled: true } } },
      });
      const res = makeRes();
      await handler(req, res);

      const insertCall = queryCalls.find((c) => c.text.includes('INSERT INTO organization_settings'));
      assert.ok(insertCall, 'INSERT query should be captured');
      assert.equal(insertCall.orgId, 'org-1');
    });
  });
});
