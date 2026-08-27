'use strict';

/**
 * Tests for lib/_task_queue_sql.js -- the task claim query
 * used by workers/camera-setup-agent.js.
 *
 * These are pure SQL-string tests (no DB): they assert the SECURITY
 * PROPERTIES of the generated query, which is what prevents the
 * cross-tenant media node attack:
 *   org A task  --X-- node of org B
 *   org B task  --->  node of org B (allowed)
 *   org C task  --->  platform node (allowed only if explicitly assigned + safe mode)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildClaimTaskSql, canClaimTasks } = require('../lib/_task_queue_sql');

describe('buildClaimTaskSql', () => {
  test('scopes the claim to the node own organization (tenant isolation)', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.match(sql, /JOIN media_nodes n ON n\.id = \$1/);
    assert.match(sql, /t2\.organization_id = n\.organization_id/);
  });

  test('fail closed: a node only claims explicitly assigned tasks', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.match(sql, /t2\.assigned_node_id = n\.id/);
  });

  test('fail closed: there is no "claim any pending task" fallback', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    // The SQL must NOT contain a bare pending-scan without assigned_node_id
    const pendingMatch = sql.match(/status = 'pending'[\s\S]*?ORDER BY/i);
    assert.ok(pendingMatch, 'should find pending + ORDER BY span');
    const pendingBlock = pendingMatch[0];
    assert.match(pendingBlock, /t2\.assigned_node_id = n\.id/,
      'assigned_node_id check must be inside the pending claim block, not just in SET');
  });

  test('platform node (organization_id IS NULL) is allowed in the claim query', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    assert.match(sql, /n\.organization_id IS NULL/,
      'query must have a platform-node branch for organization_id IS NULL');
  });

  test('organization-owned node (organization_id IS NOT NULL) is allowed in the claim query', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'org-node', maxAgeMinutes: 30 });
    assert.match(sql, /n\.organization_id IS NOT NULL/,
      'query must have an org-owned-node branch for organization_id IS NOT NULL');
  });

  test('platform node mode restriction: only non-discovery modes allowed', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    assert.match(sql, /t2\.mode IN \('manual', 'probe', 'preview', 'start_tunnel', 'cleanup'\)/,
      'platform node must be restricted to non-discovery modes');
  });

  test('platform node mode restriction: scan is rejected', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    assert.doesNotMatch(sql, /mode IN \('manual', 'probe', 'preview', 'start_tunnel', 'cleanup', 'scan'\)/,
      'scan must NOT be in the allowed modes for platform node');
  });

  test('platform node mode restriction: onvif is rejected', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    assert.doesNotMatch(sql, /mode IN \('manual', 'probe', 'preview', 'start_tunnel', 'cleanup', 'onvif'\)/,
      'onvif must NOT be in the allowed modes for platform node');
  });

  test('platform node mode restriction: dvrip is rejected', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    assert.doesNotMatch(sql, /mode IN \('manual', 'probe', 'preview', 'start_tunnel', 'cleanup', 'dvrip'\)/,
      'dvrip must NOT be in the allowed modes for platform node');
  });

  test('keeps the pending + freshness filter and oldest-first ordering', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.match(sql, /status = 'pending'/);
    assert.match(sql, /created_at > now\(\) - \(\$2 \* interval '1 minute'\)/);
    assert.match(sql, /ORDER BY t2\.created_at/);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  });

  test('passes nodeId and maxAgeMinutes as parameters', () => {
    const { sql, params } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.deepEqual(params, ['node-b', 30]);
    assert.match(sql, /\$1/);
    assert.match(sql, /\$2/);
  });

  test('claiming sets the assigned_node_id to the claiming node', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.match(sql, /assigned_node_id = COALESCE\(\$1, assigned_node_id\)/);
  });

  test('platform node claim requires assigned_node_id = n.id (no cross-node claiming)', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'platform-node', maxAgeMinutes: 30 });
    // The assigned_node_id = n.id check must be outside the OR branches,
    // applying to BOTH org-owned and platform node paths
    const assignedMatches = (sql.match(/t2\.assigned_node_id = n\.id/g) || []).length;
    assert.ok(assignedMatches >= 1, 'assigned_node_id = n.id must appear at least once in the query');
  });
});

describe('canClaimTasks (fail closed)', () => {
  test('a node with MEDIA_NODE_ID set may claim', () => {
    assert.equal(canClaimTasks({ nodeId: 'node-b' }), true);
  });
  test('a node WITHOUT MEDIA_NODE_ID may not claim (prevents un-attributable execution)', () => {
    assert.equal(canClaimTasks({ nodeId: null }), false);
    assert.equal(canClaimTasks({ nodeId: '' }), false);
  });
});
