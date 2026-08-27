const crypto = require('crypto');
const db = require('../db/index');

// A node is considered online only if it has heartbeated recently.
// This is computed at query time rather than trusted from a `status`
// column a heartbeat script might forget to flip back on crash/restart.
const HEARTBEAT_FRESHNESS_SECONDS = parseInt(process.env.MEDIA_NODE_HEARTBEAT_FRESHNESS_SECONDS || '90', 10);

/**
 * Picks the least-loaded online media node available to the caller's
 * organization. Prefers organization-owned nodes (tenant-specific media
 * servers, e.g. DND-DESKTOP laptops) but falls back to a platform-level
 * node (organization_id IS NULL, e.g. Fly.io) when no org-owned node is
 * online. This allows platform-level infrastructure to serve any org.
 *
 * Note: claimNextTask() in workers/camera-setup-agent.js remains
 * strictly org-scoped (fail closed). If a platform node is picked here,
 * the task created for it will not be claimed by the desktop agent on
 * the Fly.io server (camera-setup-agent.js); it is intended to be
 * claimed by the Fly-deployed agent instead.
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
  // behavior in media-server/README.md). organization_id match OR
  // IS NULL (platform-level node) allows platform nodes to serve
  // any org as a fallback when no org-specific node is online.
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
        AND (n.organization_id = $1 OR n.organization_id IS NULL)
     GROUP BY n.id, n.region, n.public_hls_url, n.capacity, n.organization_id
     HAVING count(c.id) < n.capacity
      ORDER BY (n.organization_id IS NOT NULL) DESC, (n.region = $2) DESC, count(c.id) ASC
     LIMIT 1`,
    [organizationId, preferredRegion || null],
  );
  return rows[0] || null;
}

function generateHeartbeatSecret() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { pickMediaNodeForCamera, generateHeartbeatSecret, HEARTBEAT_FRESHNESS_SECONDS };
