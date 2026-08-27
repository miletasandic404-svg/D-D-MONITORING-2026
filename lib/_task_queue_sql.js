'use strict';

/**
 * Pure SQL builder for the camera setup task queue.
 *
 * Extracted from workers/camera-setup-agent.js so the security
 * properties of the claim query are unit-testable without a DB.
 *
 * Security-critical: the claim query MUST be scoped so that a media node
 * can only claim tasks explicitly assigned to it, and the tenant-isolation
 * boundary between organizations is never crossed.
 *
 * Two node types are supported:
 *
 * (A) Organization-owned node (organization_id IS NOT NULL):
 *     Claim allowed ONLY if assigned_node_id = node.id AND org matches.
 *
 * (B) Platform node (organization_id IS NULL):
 *     Claim allowed ONLY if assigned_node_id = node.id (explicit routing)
 *     AND task.organization_id IS NOT NULL, restricted to non-discovery
 *     modes (manual, probe, preview, start_tunnel, cleanup). Discovery
 *     modes (scan, onvif, dvrip) require LAN access the platform cannot
 *     reach and are rejected.
 */

/**
 * Build the claim-next-task UPDATE statement.
 *
 * Supports two node types (see file header):
 *  (A) org-owned node — claims tasks from its own org, explicitly routed
 *  (B) platform node (organization_id IS NULL) — claims explicitly routed
 *      tasks restricted to non-discovery modes only
 *
 * Both branches require assigned_node_id = n.id (explicit routing).
 * There is NO "claim any pending task" fallback.
 *
 * @param {{ nodeId: string|null, maxAgeMinutes: number }} opts
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildClaimTaskSql({ nodeId, maxAgeMinutes }) {
  return {
    sql: `UPDATE camera_setup_tasks t
         SET status = 'working',
             assigned_node_id = COALESCE($1, assigned_node_id),
             updated_at = now()
         WHERE id = (
           SELECT t2.id
           FROM camera_setup_tasks t2
           JOIN media_nodes n ON n.id = $1
           WHERE t2.status = 'pending'
             AND t2.created_at > now() - ($2 * interval '1 minute')
             -- (A)+(B) Explicit assignment: a node may only claim tasks
             -- routed to its own id — no "claim any pending" fallback.
             AND t2.assigned_node_id = n.id
             AND (
               -- (A) Organization-owned node: same-org tasks only
               (n.organization_id IS NOT NULL
                AND t2.organization_id = n.organization_id)
               OR
               -- (B) Platform node (organization_id IS NULL): same node,
               -- non-NULL task org, and restricted to non-discovery modes
               -- (scan/onvif/dvrip need LAN access the platform can't reach)
               (n.organization_id IS NULL
                AND t2.organization_id IS NOT NULL
                AND t2.mode IN ('manual', 'probe', 'preview', 'start_tunnel', 'cleanup'))
             )
           ORDER BY t2.created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
    params: [nodeId, maxAgeMinutes],
  };
}

/**
 * True when the node may claim tasks at all: it must have a media
 * node id (MEDIA_NODE_ID env) configured. Without an id the worker
 * cannot be attributed to an organization, so it must not execute
 * ANY tenant task (fail closed).
 */
function canClaimTasks({ nodeId }) {
  return Boolean(nodeId);
}

module.exports = { buildClaimTaskSql, canClaimTasks };
