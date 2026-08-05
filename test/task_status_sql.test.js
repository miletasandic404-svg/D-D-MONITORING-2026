'use strict';
/**
 * Regression tests for lib/_task_status_sql.js.
 *
 * Guards against a real bug: an earlier version built SET clause
 * placeholders as `${vals.length}` (a bare number) instead of
 * `$${vals.length}` (a $N placeholder), producing invalid SQL that
 * crashed on every call with a non-empty `extra` -- i.e. every real
 * task completion. Never caught by tests because there were none.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildTaskStatusQuery } = require('../lib/_task_status_sql');

test('buildTaskStatusQuery: every SET value and the WHERE id use $N placeholders, never bare numbers', () => {
  const { sql, vals } = buildTaskStatusQuery('task-abc', 'done', {
    result: '{"cameras":[]}',
    error: null,
  });

  assert.match(sql, /^UPDATE camera_setup_tasks SET status = \$1, updated_at = now\(\), result = \$2, error = \$3 WHERE id = \$4$/);
  assert.deepStrictEqual(vals, ['done', '{"cameras":[]}', null, 'task-abc']);
});

test('buildTaskStatusQuery: with no extra fields, only status/updated_at/id are set', () => {
  const { sql, vals } = buildTaskStatusQuery('task-xyz', 'working', {});
  assert.strictEqual(sql, 'UPDATE camera_setup_tasks SET status = $1, updated_at = now() WHERE id = $2');
  assert.deepStrictEqual(vals, ['working', 'task-xyz']);
});

test('buildTaskStatusQuery: unknown columns are silently dropped from the query, not injected', () => {
  const { sql, vals, rejected } = buildTaskStatusQuery('task-1', 'failed', {
    error: 'boom',
    organization_id: 'should-not-be-settable', // not in the allow-list
  });
  assert.ok(!sql.includes('organization_id'), 'disallowed column must not appear in SQL');
  assert.deepStrictEqual(vals, ['failed', 'boom', 'task-1']);
  assert.deepStrictEqual(rejected, ['organization_id']);
});

test('buildTaskStatusQuery: placeholder numbers stay sequential and unique across many fields', () => {
  const { sql, vals } = buildTaskStatusQuery('task-many', 'done', {
    result: 'r', error: 'e', camera_id: 'c', assigned_node_id: 'n',
    ip: '1.2.3.4', rtsp_url: 'rtsp://x', camera_name: 'Cam',
  });
  // status=$1, updated_at=now(), then 7 extra fields => $2..$8, id => $9
  for (let i = 2; i <= 9; i++) {
    assert.ok(sql.includes(`$${i}`), `expected placeholder $${i} in: ${sql}`);
  }
  assert.strictEqual(vals.length, 9);
});
