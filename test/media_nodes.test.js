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
