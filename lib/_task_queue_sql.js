'use strict';

/**
 * Pure SQL builder for the camera setup task queue.
 *
 * Extracted from workers/camera-setup-agent.js so the security
 * properties of the claim query are unit-testable without a DB.
 *
 * Security-critical: the claim query MUST be scoped to the claiming
 * node's own organization (model B — media nodes are tenant-owned
 * laptops on each org's own LAN). Without this, org A could create a
 * malicious setup task that a node on org B's network would execute
 * (cross-tenant network access / SSRF via camera probing).
 *
 * A node with no organization assigned (organization_id IS NULL) can
 * never claim anything — fail closed.
 */

/**
 * Build the claim-next-task UPDATE statement.
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
             AND n.organization_id IS NOT NULL
             AND t2.organization_id = n.organization_id
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
