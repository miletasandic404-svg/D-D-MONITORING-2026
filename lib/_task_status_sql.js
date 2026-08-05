/**
 * Pure SQL-building helper for camera_setup_tasks status updates.
 *
 * Extracted out of workers/camera-setup-agent.js so it can be unit
 * tested without a live DB connection (that file runs its worker loop
 * immediately on require, with no require.main guard).
 *
 * Bug history: an earlier version built placeholders as `${vals.length}`
 * instead of `$${vals.length}`, producing invalid SQL like
 * "SET result = 2 WHERE id = 3" (a literal integer, not a $2/$3
 * placeholder) -- which crashed on every call that passed an `extra`
 * field (i.e. every real task completion, success or failure), since
 * result/error are jsonb/text columns and id is uuid. Never caught by
 * tests because there were none for this path; only surfaces once a
 * real task actually runs to completion.
 */

const ALLOWED_EXTRA_COLUMNS = new Set([
  'result', 'error', 'camera_id', 'assigned_node_id',
  'ip', 'rtsp_url', 'camera_name', 'updated_at',
]);

/**
 * Build the parameterized UPDATE statement for a camera_setup_tasks
 * status change. Returns { sql, vals } ready to pass to pool.query().
 * Unknown keys in `extra` are silently dropped (matches prior behavior)
 * so a bad key can't be smuggled into the SET clause.
 */
function buildTaskStatusQuery(taskId, status, extra = {}, allowedColumns = ALLOWED_EXTRA_COLUMNS) {
  const sets = ['status = $1', 'updated_at = now()'];
  const vals = [status];
  const rejected = [];
  for (const [k, v] of Object.entries(extra)) {
    if (!allowedColumns.has(k)) {
      rejected.push(k);
      continue;
    }
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  vals.push(taskId);
  const sql = `UPDATE camera_setup_tasks SET ${sets.join(', ')} WHERE id = $${vals.length}`;
  return { sql, vals, rejected };
}

module.exports = { buildTaskStatusQuery, ALLOWED_EXTRA_COLUMNS };
