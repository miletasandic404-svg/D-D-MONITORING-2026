const crypto = require('crypto');
const db = require('../db/index');

// A node is considered online only if it has heartbeated recently.
// This is computed at query time rather than trusted from a `status`
// column a heartbeat script might forget to flip back on crash/restart.
const HEARTBEAT_FRESHNESS_SECONDS = parseInt(process.env.MEDIA_NODE_HEARTBEAT_FRESHNESS_SECONDS || '90', 10);

/**
 * Picks the least-loaded online media node belonging to the caller's
 * own organization (model B: media nodes are tenant-owned hardware on
 * each org's own LAN), optionally preferring a specific region among
 * that org's own nodes.
 *
 * Strictly org-scoped -- returns null if the calling organization has
 * no online node of its own, even if other organizations' nodes are
 * online. This matches camera-setup-agent's claimNextTask(), which is
 * also strictly org-scoped (fail closed): a node from another
 * organization would never be allowed to claim a task created here
 * anyway, so returning one used to just mean the task looked "accepted"
 * to the caller but silently expired ~30 minutes later with no clear
 * explanation. Filtering here means the caller finds out immediately,
 * with an actionable error, instead of after a silent timeout.
 */
async function pickMediaNodeForCamera({ preferredRegion, organizationId } = {}) {
  // Fail fast: no organization to scope to means there's nothing this
  // org could legitimately be assigned, so skip the DB round-trip
  // entirely rather than running a query that WHERE-filters to zero
  // rows anyway.
  if (!organizationId) return null;

  // queryAsPlatformAdmin (RLS bypass): capacity math needs the TRUE
  // camera count per node across every organization sharing it, not
  // just one tenant's cameras -- a tenant-scoped query would
  // undercount and could overload a node that looks falsely empty.
  //
  // WHERE clause: only nodes that have heartbeated recently count as
  // "online" -- without this, a crashed/never-started node was being
  // returned as a valid candidate (contradicts the documented
  // behavior in media-server/README.md). organization_id = $1 is a
  // strict filter, not just an ordering preference -- see docstring.
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
       AND n.organization_id = $1
     GROUP BY n.id, n.region, n.public_hls_url, n.capacity, n.organization_id
     HAVING count(c.id) < n.capacity
     ORDER BY (n.region = $2) DESC, count(c.id) ASC
     LIMIT 1`,
    [organizationId, preferredRegion || null],
  );
  return rows[0] || null;
}

function generateHeartbeatSecret() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { pickMediaNodeForCamera, generateHeartbeatSecret, HEARTBEAT_FRESHNESS_SECONDS };
