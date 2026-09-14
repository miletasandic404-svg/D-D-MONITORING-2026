'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
const authModule = require('../lib/_auth');
const rateLimitModule = require('../lib/_rate_limit');
const paymentActivation = require('../lib/_payment_activation');
const auditModule = require('../lib/_audit');

let authState;
let transactionQueries;
let organizationId;
let userOrganization;

authModule.requireAuth = async (_req, res) => {
  if (!authState) {
    res.status(401).json({ success: false, error: 'No valid session found' });
    return null;
  }
  return authState;
};
rateLimitModule.rateLimit = async () => true;
paymentActivation.validateRegistrationPayment = async ({ planId }) => ({
  planId,
  payment: null,
});
paymentActivation.getPlanLimits = () => ({
  camera_limit: 5,
  site_limit: 3,
});
auditModule.logAudit = async () => {};

db.query = async (text) => {
  if (text.includes('SELECT name FROM organizations')) {
    return { rows: [] };
  }
  return { rows: [] };
};

db.transaction = async (callback) => {
  const client = {
    async query(text, params) {
      transactionQueries.push({ text, params });
      if (text.includes('INSERT INTO organizations')) {
        return { rows: [{ id: organizationId }] };
      }
      if (text.includes('SELECT u.organization_id')) {
        return {
          rows: userOrganization === null
            ? []
            : [{ organization_id: userOrganization, organization_name: userOrganization === 'default-org' ? 'Default Organization' : 'Customer Org' }],
        };
      }
      if (text.includes('INSERT INTO sites')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      return { rows: [] };
    },
  };
  return callback(client);
};

const handler = require('../api/onboarding');

function makeReq(body = {}) {
  return {
    method: 'POST',
    body,
    query: { path: 'register' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('onboarding tenant context', () => {
  beforeEach(() => {
    authState = { userId: 'user-a', organizationId: null, userType: 'operator' };
    organizationId = '11111111-1111-4111-8111-111111111111';
    userOrganization = 'default-org';
    transactionQueries = [];
  });

  test('Org A onboarding creates its site and links the authenticated user', async () => {
    const res = makeRes();
    await handler(makeReq({ orgName: 'Org A' }), res);
    assert.equal(res.statusCode, 201);
    const contextQuery = transactionQueries.find(query => query.text.includes("set_config('app.current_org_id'"));
    assert.deepEqual(contextQuery.params, [organizationId]);
    const siteQuery = transactionQueries.find(query => query.text.includes('INSERT INTO sites'));
    assert.deepEqual(siteQuery.params.slice(0, 1), [organizationId]);
    const userQuery = transactionQueries.find(query => query.text.includes('UPDATE users'));
    assert.match(userQuery.text, /organization_id IS NULL/);
    assert.match(userQuery.text, /Default Organization/);
  });

  test('user already linked to another organization is rejected before site creation', async () => {
    userOrganization = 'org-b';
    const res = makeRes();
    await handler(makeReq({ orgName: 'Org A' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(transactionQueries.some(query => query.text.includes('INSERT INTO sites')), false);
  });

  test('missing authenticated user profile is rejected', async () => {
    userOrganization = null;
    const res = makeRes();
    await handler(makeReq({ orgName: 'Org A' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(transactionQueries.some(query => query.text.includes('INSERT INTO sites')), false);
  });

  test('unauthenticated onboarding is rejected without a transaction', async () => {
    authState = null;
    const res = makeRes();
    await handler(makeReq({ orgName: 'Org A' }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(transactionQueries.length, 0);
  });
});
