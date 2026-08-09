const crypto = require('crypto');
const db = require('../db/index');

// A node is considered online only if it has heartbeated recently.
// This is computed at query time rather than trusted from a `status`
// column a heartbeat script might forget to flip back on crash/restart.
const HEARTBEAT_FRESHNESS_SECONDS = parseInt(process.env.MEDIA_NODE_HEARTBEAT_FRESHNESS_SECONDS || '90', 10);

/**
 * Picks the least-loaded online media node, optionally preferring a
 * specific region AND the caller's own organization (model B: media
 * nodes are tenant-owned hardware on each org's own LAN).
 *
 * Ordering: a node of the caller's own organization first, then the
 * preferred region, then least-loaded. Falls back to any online node
 * so single-node / not-yet-assigned deployments keep working, but the
 * camera-setup-agent's claim query is strictly org-scoped regardless
 * (a task is only ever executed by a node of the same organization).
 * Returns null if no online node exists at all.
 */
async function pickMediaNodeForCamera({ preferredRegion, organizationId } = {}) {
  // queryAsPlatformAdmin (RLS bypass): capacity math needs the TRUE
  // camera count per node across every organization sharing it, not
  // just one tenant's cameras -- a tenant-scoped query would
  // undercount and could overload a node that looks falsely empty.
  //
  // WHERE clause: only nodes that have heartbeated recently count as
  // "online" -- without this, a crashed/never-started node was being
  // returned as a valid candidate (contradicts the documented
  // behavior in media-server/README.md).
  // HAVING clause: exclude nodes already at/over their configured
  // capacity -- without this, "capacity-aware" assignment wasn't
  // actually checking capacity at all.
  const { rows } = await db.queryAsPlatformAdmin(
    `SELECT
       n.id, n.region, n.public_hls_url, n.capacity,
       count(c.id)::int AS current_cameras
     FROM media_nodes n
     LEFT JOIN cameras c ON c.media_node_id = n.id
     WHERE n.last_heartbeat_at > now() - interval '${HEARTBEAT_FRESHNESS_SECONDS} seconds'
     GROUP BY n.id, n.region, n.public_hls_url, n.capacity, n.organization_id
     HAVING count(c.id) < n.capacity
     ORDER BY (n.organization_id = $2) DESC, (n.region = $1) DESC, count(c.id) ASC
     LIMIT 1`,
    [preferredRegion || null, organizationId || null],
  );
  return rows[0] || null;
}

function generateHeartbeatSecret() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { pickMediaNodeForCamera, generateHeartbeatSecret, HEARTBEAT_FRESHNESS_SECONDS };
