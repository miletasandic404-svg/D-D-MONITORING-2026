'use strict';

/**
 * Tests for lib/_task_queue_sql.js -- the org-scoped task claim query
 * used by workers/camera-setup-agent.js.
 *
 * These are pure SQL-string tests (no DB): they assert the SECURITY
 * PROPERTIES of the generated query, which is what prevents the
 * cross-tenant media node attack:
 *   org A task  --X-- node of org B
 *   org B task  --->  node of org B (allowed)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildClaimTaskSql, canClaimTasks } = require('../lib/_task_queue_sql');

describe('buildClaimTaskSql', () => {
  test('scopes the claim to the node own organization (tenant isolation)', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    // The inner SELECT joins media_nodes (the claiming node) and requires
    // the task's organization to equal the node's organization.
    assert.match(sql, /JOIN media_nodes n ON n\.id = \$1/);
    assert.match(sql, /t2\.organization_id = n\.organization_id/);
  });

  test('fail closed: a node without an organization claims nothing', () => {
    const { sql } = buildClaimTaskSql({ nodeId: 'node-b', maxAgeMinutes: 30 });
    assert.match(sql, /n\.organization_id IS NOT NULL/);
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
