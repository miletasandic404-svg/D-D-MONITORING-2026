'use strict';

/**
 * Tests for api/face-recognition/index.js — Face Recognition API.
 *
 * Verifies:
 * - Authentication required
 * - RBAC: only org_admin/platform_admin can mutate
 * - Organization isolation
 * - Validation
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
const handler = require('../api/known-entities');

// ── req/res test helpers ──────────────────────────────────────────────────
function makeReq({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query: { entity: 'face', ...query }, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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

describe('api/face-recognition — Face Recognition', () => {
  beforeEach(() => {
    resetFakes();
    auditCalls = [];
  });

  describe('GET /api/face-recognition', () => {
    test('unauthenticated GET → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('authenticated GET → returns own-org faces', async () => {
      dbScript = (text) => {
        if (text.includes('FROM known_faces')) {
          return { rows: [{ id: 'f1', name: 'John' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.known_faces.length, 1);
    });

    test('GET scoped to authenticated org', async () => {
      dbScript = (text) => {
        if (text.includes('FROM known_faces')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await handler(req, res);

      const queryCall = queryCalls.find((c) => c.text.includes('FROM known_faces'));
      assert.equal(queryCall.orgId, 'org-1');
    });
  });

  describe('POST /api/face-recognition/enroll', () => {
    test('unauthenticated POST → 401', async () => {
      authResponse = null;
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 401);
    });

    test('org_admin can enroll → success', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO known_faces')) {
          return { rows: [{ id: 'f1', name: 'Test' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.face.name, 'Test');
    });

    test('platform_admin can enroll → success', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'platform_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO known_faces')) {
          return { rows: [{ id: 'f1', name: 'Test' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201);
    });

    test('operator cannot enroll → 403', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 403);
    });

    test('missing name → validation error', async () => {
      const req = makeReq({ method: 'POST', body: {} });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('invalid status → validation error', async () => {
      const req = makeReq({ method: 'POST', body: { name: 'Test', status: 'invalid' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    test('organization_id from auth context', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
      dbScript = (text) => {
        if (text.includes('INSERT INTO known_faces')) {
          return { rows: [{ id: 'f1', name: 'Test' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      const insertCall = queryCalls.find((c) => c.text.includes('INSERT INTO known_faces'));
      assert.ok(insertCall, 'INSERT query should be captured');
      assert.equal(insertCall.orgId, 'org-1');
    });

    test('organization_id in body is rejected by strict schema', async () => {
      const req = makeReq({ method: 'POST', body: { name: 'Test', organization_id: 'malicious-org' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 400, 'strict schema should reject unknown fields');
    });

    test('audit log is created on enroll', async () => {
      dbScript = (text) => {
        if (text.includes('INSERT INTO known_faces')) {
          return { rows: [{ id: 'f1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'POST', body: { name: 'Test' } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0);
      assert.equal(auditCalls[0].action, 'face.enroll');
    });
  });

  describe('PUT /api/face-recognition/:id', () => {
    test('admin can update own-org face → success', async () => {
      dbScript = (text) => {
        if (text.includes('UPDATE known_faces')) {
          return { rows: [{ id: 'f1', name: 'Updated' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', query: { id: 'f1' }, body: { name: 'Updated' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
    });

    test('operator cannot update → 403', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      const req = makeReq({ method: 'PUT', query: { id: 'f1' }, body: { name: 'Updated' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 403);
    });

    test('cross-org ID → 404', async () => {
      dbScript = (text) => {
        if (text.includes('UPDATE known_faces')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', query: { id: 'other-org-face' }, body: { name: 'Updated' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 404);
    });

    test('audit log is created on update', async () => {
      dbScript = (text) => {
        if (text.includes('UPDATE known_faces')) {
          return { rows: [{ id: 'f1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'PUT', query: { id: 'f1' }, body: { name: 'Updated' } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0);
      assert.equal(auditCalls[0].action, 'face.update');
    });
  });

  describe('DELETE /api/face-recognition/:id', () => {
    test('admin can delete own-org face → success', async () => {
      dbScript = (text) => {
        if (text.includes('DELETE FROM known_faces')) {
          return { rows: [{ id: 'f1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'DELETE', query: { id: 'f1' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.deleted, true);
    });

    test('operator cannot delete → 403', async () => {
      authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'operator' };
      const req = makeReq({ method: 'DELETE', query: { id: 'f1' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 403);
    });

    test('cross-org ID → 404', async () => {
      dbScript = (text) => {
        if (text.includes('DELETE FROM known_faces')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'DELETE', query: { id: 'other-org-face' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 404);
    });

    test('audit log is created on delete', async () => {
      dbScript = (text) => {
        if (text.includes('DELETE FROM known_faces')) {
          return { rows: [{ id: 'f1' }] };
        }
        return { rows: [], rowCount: 0 };
      };
      const req = makeReq({ method: 'DELETE', query: { id: 'f1' } });
      const res = makeRes();
      await handler(req, res);

      assert.ok(auditCalls.length > 0);
      assert.equal(auditCalls[0].action, 'face.delete');
    });
  });
});
