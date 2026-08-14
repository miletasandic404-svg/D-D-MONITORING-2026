'use strict';

/**
 * Tests for lib/_media_nodes.js's pickMediaNodeForCamera().
 *
 * Regression coverage for a bug found right after the SSRF/org-scoping
 * hardening commit: claimNextTask() (workers/camera-setup-agent.js)
 * became strictly organization-scoped (a node only claims tasks from
 * its own org), but pickMediaNodeForCamera() was left as a *preference*
 * rather than a strict filter -- so an org with no online node of its
 * own could be handed a DIFFERENT org's node, get a false "node
 * available" response, and then have the resulting task silently sit
 * pending until it expired ~30 minutes later.
 *
 * These tests verify the query is now a strict organization filter
 * (WHERE n.organization_id = $1), not just an ORDER BY preference.
 */

const { test, describe, beforeEach } = require('node:test');
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

  test('filters strictly by organization_id in the SQL WHERE clause, not just ORDER BY', async () => {
    await pickMediaNodeForCamera({ organizationId: 'org-a' });
    assert.match(lastQuery.text, /WHERE[\s\S]*n\.organization_id\s*=\s*\$1/,
      'organization_id must be a WHERE-clause filter');
    assert.equal(lastQuery.params[0], 'org-a');
  });

  test('returns null when the calling org has no online node, even if fakeRows would represent another org\'s node', async () => {
    // Simulates: org-b has no node of its own. The fake DB layer here
    // stands in for Postgres -- in the real query, org-b's WHERE filter
    // would itself produce zero rows, which is what we assert on.
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
    // Region is a preference (ORDER BY), never a WHERE-clause hard filter,
    // so a node in a different region for the SAME org can still be picked.
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
  let mockReq, mockRes, mockDbQuery, mockDbQueryAsOrg;
  let lastQueryText, lastQueryParams, lastOrgId;

  beforeEach(() => {
    lastQueryText = null;
    lastQueryParams = null;
    lastOrgId = null;

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

    db.query = mockDbQuery;
    db.queryAsOrg = mockDbQueryAsOrg;

    // Load the API handler
    const handler = require('../api/media-nodes');

    mockReq.method = 'POST';
    mockReq.query = { nodeId: 'node-1' };
    mockReq.body = { heartbeat_secret: 'secret123', status: 'online' };

    await handler(mockReq, mockRes);

    // Restore
    db.query = originalQuery;
    db.queryAsOrg = originalQueryAsOrg;

    assert.equal(lastOrgId, 'org-a', 'queryAsOrg should be called with node\'s organization_id');
    assert.match(lastQueryText, /WHERE id = \$6 AND organization_id = \$7/,
      'UPDATE must include organization_id in WHERE clause');
    // Parameters: [status, region, mediamtx_online, tunnel_online, healthJson, nodeId, organization_id]
    assert.equal(lastQueryParams[5], 'node-1');
    assert.equal(lastQueryParams[6], 'org-a');
  });

  test('heartbeat for unbound node uses regular query (legacy compatibility)', async () => {
    const db = require('../db/index');
    const originalQuery = db.query;
    const originalQueryAsOrg = db.queryAsOrg;

    // Mock node without organization_id
    mockDbQuery = async (text, params) => {
      lastQueryText = text;
      lastQueryParams = params;
      if (text.includes('SELECT') && text.includes('heartbeat_secret')) {
        return { rows: [{ id: 'node-2', heartbeat_secret: 'secret456', organization_id: null }] };
      }
      return { rows: [] };
    };

    db.query = mockDbQuery;
    db.queryAsOrg = mockDbQueryAsOrg;

    const handler = require('../api/media-nodes');

    mockReq.method = 'POST';
    mockReq.query = { nodeId: 'node-2' };
    mockReq.body = { heartbeat_secret: 'secret456', status: 'online' };

    await handler(mockReq, mockRes);

    // Restore
    db.query = originalQuery;
    db.queryAsOrg = originalQueryAsOrg;

    assert.equal(lastOrgId, null, 'queryAsOrg should NOT be called for unbound nodes');
    assert.match(lastQueryText, /WHERE id = \$3/,
      'UPDATE for unbound node uses regular query without organization_id filter');
  });
});
