'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const betterAuthModule = require('../lib/auth');
betterAuthModule.getSessionFromRequest = async () => sessionInfo;
const authModule = require('../lib/_auth');

let sessionInfo;
let profileRows;
let calls;

db.queryAsPlatformAdmin = async (text, params) => {
  calls.push({ text, params });
  if (text.startsWith('SELECT id, organization_id')) return { rows: profileRows };
  if (text.startsWith('INSERT INTO users')) {
    return {
      rows: [{
        id: params[0],
        organization_id: params[2],
        user_type: params[3],
        status: 'active',
      }],
    };
  }
  return { rows: [] };
};
db.hasDatabase = true;

const res = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('auth tenant provisioning', () => {
  beforeEach(() => {
    calls = [];
    sessionInfo = {
      userId: 'user-a',
      email: 'a@example.test',
      userType: undefined,
      organizationId: undefined,
      status: 'active',
    };
    profileRows = [];
  });

  test('normal user without organization stays unassigned and is not org_admin', async () => {
    const response = res();
    const auth = await authModule.requireAuth({}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(auth.organizationId, null);
    assert.equal(auth.userType, 'operator');
    const insert = calls.find(call => call.text.startsWith('INSERT INTO users'));
    assert.equal(insert.params[2], null);
    assert.equal(insert.params[3], 'operator');
  });

  test('explicit tenant context is preserved exactly', async () => {
    sessionInfo.organizationId = 'org-a';
    sessionInfo.userType = 'operator';
    const response = res();
    const auth = await authModule.requireAuth({}, response);
    assert.equal(auth.organizationId, 'org-a');
    const insert = calls.find(call => call.text.startsWith('INSERT INTO users'));
    assert.equal(insert.params[2], 'org-a');
  });

  test('existing unassigned user is not moved to a default organization', async () => {
    profileRows = [{ id: 'user-a', organization_id: null, user_type: 'operator', status: 'active' }];
    const response = res();
    const auth = await authModule.requireAuth({}, response);
    assert.equal(auth.organizationId, null);
    assert.equal(calls.filter(call => call.text.includes('UPDATE users SET organization_id')).length, 0);
  });

  test('existing Org A user remains in Org A despite an Org B session context', async () => {
    profileRows = [{ id: 'user-a', organization_id: 'org-a', user_type: 'operator', status: 'active' }];
    sessionInfo.organizationId = 'org-b';
    const response = res();
    const auth = await authModule.requireAuth({}, response);
    assert.equal(auth.organizationId, 'org-a');
    assert.equal(calls.filter(call => call.text.startsWith('INSERT INTO users')).length, 0);
  });
});
