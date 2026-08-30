'use strict';

/**
 * Tests for lib/_media_nodes.js's pickMediaNodeForCamera().
 *
 * Verifies that the query now allows platform-level nodes
 * (organization_id IS NULL, e.g. Fly.io) to serve as a fallback
 * for any organization, while still preferring org-specific nodes
 * when available. The query remains parameterized and claimNextTask()
 * remains strictly org-scoped as an independent SSRF protection.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/index');
let lastQuery = null;
let fakeRows = [];

db.queryAsPlatformAdmin = async (text, params) => {
  lastQuery = { text, params };
  return { rows: fakeRows };
};

const { pickMediaNodeForCamera } = require('../lib/_media_nodes');

describe('pickMediaNodeForCamera', () => {
  beforeEach(() => {
    lastQuery = null;
    fakeRows = [];
  });

  test('query includes both org-scoped match and NULL platform-node fallback in the WHERE clause', async () => {
    await pickMediaNodeForCamera({ organizationId: 'org-a' });
    assert.match(lastQuery.text, /WHERE[\s\S]*n\.organization_id\s*=\s*\$1/,
      'organization_id must be a WHERE-clause filter');
    assert.match(lastQuery.text, /WHERE[\s\S]*n\.organization_id\s+IS\s+NULL/,
      'WHERE clause must also include OR organization_id IS NULL for platform node fallback');
    assert.equal(lastQuery.params[0], 'org-a');
  });

  test('prefers organization-specific node over platform node (ORDER BY prioritizes non-NULL org_id)', async () => {
    await pickMediaNodeForCamera({ organizationId: 'org-a' });
    const orderByMatch = lastQuery.text.match(/ORDER BY\s+(.+?)(?:\n\s+LIMIT|$)/s);
    assert.ok(orderByMatch, 'should have an ORDER BY clause');
    const orderByClause = orderByMatch[1];
    assert.match(orderByClause, /n\.organization_id\s+IS\s+NOT\s+NULL/,
      'ORDER BY must prioritize org-specific nodes first (platform node as fallback)');
  });

  test('returns null when no online node exists for the caller (org or platform)', async () => {
    fakeRows = [];
    const result = await pickMediaNodeForCamera({ organizationId: 'org-b' });
    assert.equal(result, null);
  });

  test('returns the node when exactly one matches the org filter', async () => {
    fakeRows = [{ id: 'node-1', region: 'eu', public_hls_url: 'https://node1.example.com', capacity: 10, current_cameras: 2 }];
    const result = await pickMediaNodeForCamera({ organizationId: 'org-a' });
    assert.equal(result.id, 'node-1');
  });

  test('passes preferredRegion as the second parameter for ORDER BY preference, not as a filter', async () => {
    await pickMediaNodeForCamera({ organizationId: 'org-a', preferredRegion: 'eu' });
    assert.equal(lastQuery.params[1], 'eu');
    const whereClause = lastQuery.text.split(/GROUP BY/i)[0];
    assert.doesNotMatch(whereClause, /n\.region\s*=\s*\$2/);
  });

  test('returns null immediately (no DB query) when organizationId is missing', async () => {
    const result = await pickMediaNodeForCamera({});
    assert.equal(result, null);
    assert.equal(lastQuery, null, 'must not query the DB at all without an organizationId');
  });
});

describe('media-nodes API heartbeat organization scoping', () => {
  let mockReq, mockRes, mockDbQuery, mockDbQueryAsOrg, mockDbQueryAsPlatformAdmin;
  let lastQueryText, lastQueryParams, lastOrgId, lastPlatformAdminQuery;

  beforeEach(() => {
    lastQueryText = null;
    lastQueryParams = null;
    lastOrgId = null;
    lastPlatformAdminQuery = null;

    mockDbQuery = async (text, params) => {
      lastQueryText = text;
      lastQueryParams = params;
      // Simulate node lookup
      if (text.includes('SELECT') && text.includes('heartbeat_secret')) {
        return { rows: [{ id: 'node-1', heartbeat_secret: 'secret123', organization_id: 'org-a' }] };
      }
      // Simulate UPDATE
      return { rows: [] };
    };

    mockDbQueryAsOrg = async (orgId, text, params) => {
      lastOrgId = orgId;
      lastQueryText = text;
      lastQueryParams = params;
      return { rows: [] };
    };

    mockDbQueryAsPlatformAdmin = async (text, params) => {
      lastPlatformAdminQuery = { text, params };
      lastQueryText = text;
      lastQueryParams = params;
      if (text.includes('SELECT') && text.includes('heartbeat_secret')) {
        return { rows: [{ id: 'node-1', heartbeat_secret: 'secret123', organization_id: 'org-a' }] };
      }
      return { rows: [] };
    };

    mockReq = {
      method: '',
      query: {},
      body: {},
      headers: {
        'x-forwarded-for': '127.0.0.1',
      },
    };

    mockRes = {
      status: (code) => ({ json: (data) => ({ status: code, data }) }),
      setHeader: () => mockRes,
    };

    // Mock rate limit to always allow
    const rateLimitModule = require('../lib/_rate_limit');
    rateLimitModule.rateLimit = async () => true;
  });

  test('heartbeat for node bound to organization uses queryAsOrg with correct org_id', async () => {
    const db = require('../db/index');
    const originalQuery = db.query;
    const originalQueryAsOrg = db.queryAsOrg;
    const originalQueryAsPlatformAdmin = db.queryAsPlatformAdmin;

    db.query = mockDbQuery;
    db.queryAsOrg = mockDbQueryAsOrg;
    db.queryAsPlatformAdmin = mockDbQueryAsPlatformAdmin;

    // Load the API handler
    const handler = require('../api/media-nodes');

    mockReq.method = 'POST';
    mockReq.query = { nodeId: 'node-1' };
    mockReq.body = { heartbeat_secret: 'secret123', status: 'online' };

    await handler(mockReq, mockRes);

    // Restore
    db.query = originalQuery;
    db.queryAsOrg = originalQueryAsOrg;
    db.queryAsPlatformAdmin = originalQueryAsPlatformAdmin;

    assert.equal(lastOrgId, 'org-a', 'queryAsOrg should be called with node\'s organization_id');
    assert.match(lastQueryText, /WHERE id = \$6 AND organization_id = \$7/,
      'UPDATE must include organization_id in WHERE clause');
    // Parameters: [status, region, mediamtx_online, tunnel_online, healthJson, nodeId, organization_id]
    assert.equal(lastQueryParams[5], 'node-1');
    assert.equal(lastQueryParams[6], 'org-a');
  });

  test('heartbeat for unbound node uses queryAsPlatformAdmin (RLS bypass)', async () => {
    const db = require('../db/index');
    const originalQuery = db.query;
    const originalQueryAsOrg = db.queryAsOrg;
    const originalQueryAsPlatformAdmin = db.queryAsPlatformAdmin;

    lastPlatformAdminQuery = null;

    db.query = mockDbQuery;
    db.queryAsOrg = mockDbQueryAsOrg;
    db.queryAsPlatformAdmin = mockDbQueryAsPlatformAdmin;

    const handler = require('../api/media-nodes');

    mockReq.method = 'POST';
    mockReq.query = { nodeId: 'node-2' };
    mockReq.body = { heartbeat_secret: 'secret456', status: 'online' };

    await handler(mockReq, mockRes);

    // Restore
    db.query = originalQuery;
    db.queryAsOrg = originalQueryAsOrg;
    db.queryAsPlatformAdmin = originalQueryAsPlatformAdmin;

    assert.equal(lastOrgId, null, 'queryAsOrg should NOT be called for unbound nodes');
    assert.ok(lastPlatformAdminQuery, 'queryAsPlatformAdmin should be called for unbound nodes (RLS bypass)');
    assert.match(lastPlatformAdminQuery.text, /media_nodes/,
      'queryAsPlatformAdmin should access media_nodes table');
  });
});

describe('media-nodes API heartbeat secret comparison', () => {
  let mockReq, mockRes, originalDbQuery, originalDbQueryAsOrg, originalDbQueryAsPlatformAdmin;

  beforeEach(() => {
    mockReq = {
      method: 'POST',
      query: { nodeId: 'node-1' },
      body: {},
      headers: { 'x-forwarded-for': '127.0.0.1' },
    };
    mockRes = {
      statusCode: 200,
      status: (code) => { mockRes.statusCode = code; return { json: (data) => ({ status: code, data }) }; },
      setHeader: () => mockRes,
    };

    originalDbQuery = db.query;
    originalDbQueryAsOrg = db.queryAsOrg;
    originalDbQueryAsPlatformAdmin = db.queryAsPlatformAdmin;

    db.query = async () => ({ rows: [] });
    db.queryAsOrg = async () => ({ rows: [] });
    db.queryAsPlatformAdmin = async (text, params) => {
      if (text.includes('heartbeat_secret')) {
        return { rows: [{ id: 'node-1', heartbeat_secret: 'secret123', organization_id: 'org-a' }] };
      }
      return { rows: [] };
    };
  });

  afterEach(() => {
    db.query = originalDbQuery;
    db.queryAsOrg = originalDbQueryAsOrg;
    db.queryAsPlatformAdmin = originalDbQueryAsPlatformAdmin;
  });

  test('valid secret returns 200', async () => {
    const handler = require('../api/media-nodes');
    mockReq.body = { heartbeat_secret: 'secret123', status: 'online' };
    await handler(mockReq, mockRes);
    assert.equal(mockRes.statusCode, 200);
  });

  test('invalid secret returns 401', async () => {
    const handler = require('../api/media-nodes');
    mockReq.body = { heartbeat_secret: 'wrong-secret', status: 'online' };
    await handler(mockReq, mockRes);
    assert.equal(mockRes.statusCode, 401);
  });

  test('different length secrets do not throw', async () => {
    const handler = require('../api/media-nodes');
    mockReq.body = { heartbeat_secret: 'short', status: 'online' };
    let threw = false;
    try {
      await handler(mockReq, mockRes);
    } catch (err) {
      threw = true;
    }
    assert.ok(!threw, 'handler must not throw on length mismatch');
    assert.equal(mockRes.statusCode, 401);
  });
});
