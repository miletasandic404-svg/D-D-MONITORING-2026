'use strict';

/**
 * Tests for api/camera-views.js.
 *
 * Validates:
 *   - IP extraction prefers x-vercel-forwarded-for, then x-forwarded-for, then remoteAddress
 *   - Malformed/missing headers are handled safely
 *   - View log closure includes organization_id in WHERE clause
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('assert/strict');

describe('getClientIp', () => {
  let getClientIp;

  beforeEach(() => {
    delete require.cache[require.resolve('../api/camera-views')];
    const mod = require('../api/camera-views');
    getClientIp = mod.getClientIp;
  });

  test('prefers x-vercel-forwarded-for when available', () => {
    const req = {
      headers: {
        'x-vercel-forwarded-for': '203.0.113.10',
        'x-forwarded-for': '198.51.100.5, 198.51.100.6',
      },
      connection: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(req), '203.0.113.10');
  });

  test('falls back to x-forwarded-for when x-vercel-forwarded-for missing', () => {
    const req = {
      headers: {
        'x-forwarded-for': '203.0.113.10, 198.51.100.5',
      },
      connection: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(req), '203.0.113.10');
  });

  test('falls back to remoteAddress when forwarded headers missing', () => {
    const req = {
      headers: {},
      connection: { remoteAddress: '10.0.0.1' },
    };
    assert.equal(getClientIp(req), '10.0.0.1');
  });

  test('returns null when all sources missing', () => {
    const req = {
      headers: {},
      connection: {},
    };
    assert.equal(getClientIp(req), null);
  });

  test('handles malformed x-forwarded-for safely', () => {
    const req = {
      headers: {
        'x-forwarded-for': '  ,  , ',
      },
      connection: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(req), '127.0.0.1');
  });

  test('handles empty x-vercel-forwarded-for safely', () => {
    const req = {
      headers: {
        'x-vercel-forwarded-for': '   ',
        'x-forwarded-for': '203.0.113.10',
      },
      connection: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(req), '203.0.113.10');
  });

  test('handles non-string header values safely', () => {
    const req = {
      headers: {
        'x-forwarded-for': null,
        'x-vercel-forwarded-for': undefined,
      },
      connection: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(getClientIp(req), '127.0.0.1');
  });
});

describe('camera-views API', () => {
  let mockReq, mockRes;
  let queryCalls = [];
  let handler;

  beforeEach(() => {
    queryCalls = [];

    const db = require('../db/index');
    db.hasDatabase = true;
    db.queryAsOrg = async (orgId, text, params) => {
      queryCalls.push({ orgId, text, params });
      if (text.includes('INSERT INTO camera_view_logs')) {
        return { rows: [{ id: 'log-1' }] };
      }
      if (text.includes('INSERT INTO camera_stream_tokens')) {
        return { rows: [{ id: 'token-1' }] };
      }
      if (text.includes('UPDATE camera_view_logs')) {
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    };

    const authModule = require('../lib/_auth');
    authModule.requireAuth = async () => ({
      userId: 'user-1',
      organizationId: 'org-1',
      userType: 'org_admin',
    });
    authModule.canAccessCamera = async () => true;

    const rateLimitModule = require('../lib/_rate_limit');
    rateLimitModule.rateLimit = async () => true;

    delete require.cache[require.resolve('../api/camera-views')];
    const mod = require('../api/camera-views');
    handler = mod.handler;

    mockReq = {
      method: 'POST',
      headers: {},
      body: { camera_id: 'cam-1' },
      connection: { remoteAddress: '127.0.0.1' },
    };

    mockRes = {
      statusCode: 200,
      status: (code) => { mockRes.statusCode = code; return mockRes; },
      json: (data) => { mockRes.body = data; return mockRes; },
      setHeader: () => mockRes,
    };
  });

  test('POST creates view log with extracted client IP', async () => {
    mockReq.headers = {
      'x-forwarded-for': '203.0.113.10, 198.51.100.5',
    };

    await handler(mockReq, mockRes);

    assert.equal(mockRes.statusCode, 201);
    const insertLog = queryCalls.find(c => c.text.includes('INSERT INTO camera_view_logs'));
    assert.ok(insertLog, 'INSERT INTO camera_view_logs should be called');
    assert.equal(insertLog.params[3], '203.0.113.10', 'IP should be first x-forwarded-for value');
  });

  test('PATCH closes view log within authenticated organization', async () => {
    mockReq.method = 'PATCH';
    mockReq.query = { id: 'log-1' };
    mockReq.headers = {};
    mockReq.body = {};

    await handler(mockReq, mockRes);

    assert.equal(mockRes.statusCode, 200);
    const updateQuery = queryCalls.find(c => c.text.includes('UPDATE camera_view_logs'));
    assert.ok(updateQuery, 'UPDATE camera_view_logs should be called');
    assert.ok(updateQuery.text.includes('organization_id = $3'), 'UPDATE must include organization_id');
    assert.equal(updateQuery.params[2], 'org-1', 'organization_id param must be present');
  });
});
