'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');

let authState;
let operationResult;
let calls;

authModule.requireAuth = async (_req, res) => {
  if (!authState) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  const allowedRoles = ['org_admin', 'platform_admin'];
  if (!allowedRoles.includes(authState.userType)) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return null;
  }
  return authState;
};
rateLimitModule.rateLimit = async () => true;

db.queryAsOrg = async (orgId, text, params) => {
  calls.push({ orgId, text, params });
  if (text.includes('SELECT status FROM organizations')) {
    return { rows: [{ status: 'active' }] };
  }
  return operationResult;
};

const handler = require('../api/users');

function makeReq(method, body = {}, query = {}) {
  return { method, body, query, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('operator assignment authorization', () => {
  beforeEach(() => {
    authState = { userId: 'admin-a', organizationId: 'org-a', userType: 'org_admin' };
    operationResult = {
      rows: [{
        id: 'assignment-a',
        user_id: 'operator-a',
        site_id: 'site-a',
        active: true,
      }],
    };
    calls = [];
  });

  test('Org A admin can assign Org A operator to Org A site', async () => {
    const res = makeRes();
    await handler(makeReq('POST', { user_id: 'operator-a', site_id: 'site-a' }, { path: 'assignments' }), res);
    assert.equal(res.statusCode, 201);
    const query = calls.find(call => call.text.includes('INSERT INTO operator_assignments'));
    assert.ok(query);
    assert.match(query.text, /u\.user_type = 'operator'/);
    assert.match(query.text, /u\.organization_id = \$4/);
    assert.deepEqual(query.params, ['operator-a', 'site-a', 'admin-a', 'org-a']);
  });

  test('Org A admin cannot assign Org B operator', async () => {
    operationResult = { rows: [] };
    const res = makeRes();
    await handler(makeReq('POST', { user_id: 'operator-b', site_id: 'site-a' }, { path: 'assignments' }), res);
    assert.equal(res.statusCode, 403);
  });

  test('Org A admin cannot assign Org B site', async () => {
    operationResult = { rows: [] };
    const res = makeRes();
    await handler(makeReq('POST', { user_id: 'operator-a', site_id: 'site-b' }, { path: 'assignments' }), res);
    assert.equal(res.statusCode, 403);
  });

  test('Org A admin cannot update an assignment from Org B', async () => {
    operationResult = { rows: [] };
    const res = makeRes();
    await handler(makeReq('PATCH', { id: 'assignment-b', active: false }, { path: 'assignments' }), res);
    assert.equal(res.statusCode, 404);
    const query = calls.find(call => call.text.includes('UPDATE operator_assignments'));
    assert.match(query.text, /u\.organization_id = \$4/);
  });

  test('ordinary operator cannot create or update assignments', async () => {
    authState = { userId: 'operator-a', organizationId: 'org-a', userType: 'operator' };
    const createRes = makeRes();
    await handler(makeReq('POST', { user_id: 'operator-a', site_id: 'site-a' }, { path: 'assignments' }), createRes);
    assert.equal(createRes.statusCode, 403);

    const updateRes = makeRes();
    await handler(makeReq('PATCH', { id: 'assignment-a', active: false }, { path: 'assignments' }), updateRes);
    assert.equal(updateRes.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  test('missing assignment returns 404 without assignment data', async () => {
    operationResult = { rows: [] };
    const res = makeRes();
    await handler(makeReq('DELETE', {}, { path: 'assignments', id: 'missing-assignment' }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { success: false, error: 'Assignment not found' });
  });
});
