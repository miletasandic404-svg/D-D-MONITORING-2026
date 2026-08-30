const db = require("../../db/index");
const { requireAuth } = require("../_auth");
const { sendError } = require("../_error");
const { rateLimit } = require("../_rate_limit");
const { makeLogger } = require("../_logger");
const Sentry = require("@sentry/node");
const { initSentry } = require("../_sentry");

const logger = makeLogger('handler-health');

initSentry();

// Shared zeroed payload for fail-closed / error responses on the
// dashboard endpoint (keeps the response shape stable).
function emptyDashboard() {
  return {
    cameras: { online: 0, offline: 0, degraded: 0, unknown: 0 },
    streams: { active: 0, audio_ready: 0, talk_ready: 0 },
    media_nodes: { active: 0, offline: 0, unknown: 0 },
    timestamp: new Date().toISOString(),
    recent_errors: [],
  };
}

// =========================================================
// Health API (restored in Phase A from git history @08ac51f1)
//
// GET /api/health           - Diagnostics (no auth required)
// GET /api/health/dashboard  - Dashboard widget (auth required)
// =========================================================

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  // ── Dashboard endpoint (auth-gated) ─────────────────────
  if (req.url && req.url.includes('/dashboard')) {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const isPlatformAdmin = auth.userType === 'platform_admin';

    try {
      // Fail-closed: a non-platform user without an organization id cannot
      // be tenant-scoped, so return the zeroed payload without querying.
      if (!isPlatformAdmin && !auth.organizationId) {
        return res.json(emptyDashboard());
      }

      // Platform admins see global numbers; every other authenticated user
      // is strictly scoped to their own organization (queryAsOrg enables
      // the RLS tenant_isolation policies on cameras / media_nodes /
      // audit_logs). media_nodes with NULL organization_id stay excluded.
      const run = (sql, params) =>
        isPlatformAdmin
          ? db.queryAsPlatformAdmin(sql, params)
          : db.queryAsOrg(auth.organizationId, sql, params);
      const orgParams = isPlatformAdmin ? [] : [auth.organizationId];

      const cameraCounts = await run(
        `SELECT 
          count(*) FILTER (WHERE status = 'online' OR status IS NULL) AS online,
          count(*) FILTER (WHERE status = 'offline') AS offline,
          count(*) FILTER (WHERE status = 'warning') AS degraded,
          count(*) FILTER (WHERE status IS NULL) AS unknown
        FROM cameras${isPlatformAdmin ? '' : ' WHERE organization_id = $1'}`,
        orgParams,
      );
      const cameras = cameraCounts.rows[0] || { online: 0, offline: 0, degraded: 0, unknown: 0 };

      const streamCounts = await run(
        `SELECT count(*) AS active
         FROM cameras c
         JOIN media_nodes n ON n.id = c.media_node_id
         WHERE c.enabled = TRUE
           AND n.last_heartbeat_at > now() - interval '90 seconds'
           ${isPlatformAdmin ? '' : 'AND c.organization_id = $1'}`,
        orgParams,
      );
      const streams = { active: parseInt(streamCounts.rows[0]?.active) || 0, audio_ready: 0, talk_ready: 0 };

      const nodeCounts = await run(
        `SELECT 
          count(*) FILTER (WHERE status = 'active' OR status IS NULL) AS active,
          count(*) FILTER (WHERE status = 'offline') AS offline,
          count(*) FILTER (WHERE status IS NULL) AS unknown
        FROM media_nodes${isPlatformAdmin ? '' : ' WHERE id IN (SELECT media_node_id FROM cameras WHERE organization_id = $1 AND media_node_id IS NOT NULL)'}`,
        orgParams,
      );
      const media_nodes = nodeCounts.rows[0] || { active: 0, offline: 0, unknown: 0 };

      const recentErrors = await run(
        `SELECT resource_type AS name, action AS error FROM audit_logs 
         WHERE created_at > now() - interval '24 hours'${isPlatformAdmin ? '' : ' AND organization_id = $1'} 
         ORDER BY created_at DESC LIMIT 5`,
        orgParams,
      );

      return res.json({
        cameras: {
          online: parseInt(cameras.online) || 0,
          offline: parseInt(cameras.offline) || 0,
          degraded: parseInt(cameras.degraded) || 0,
          unknown: parseInt(cameras.unknown) || 0,
        },
        streams: streams,
        media_nodes: {
          active: parseInt(media_nodes.active) || 0,
          offline: parseInt(media_nodes.offline) || 0,
          unknown: parseInt(media_nodes.unknown) || 0,
        },
        timestamp: new Date().toISOString(),
        recent_errors: recentErrors.rows.map(r => ({ name: r.name, error: r.error })),
      });
    } catch (err) {
      logger.error('GET /api/health/dashboard error', { error: err.message });
      Sentry.captureException(err);
      return res.json(emptyDashboard());
    }
  }

  // ── Diagnostics endpoint (no auth) ──────────────────────
  const healthy = db.hasDatabase
    && Boolean(process.env.DATABASE_URL)
    && Boolean(process.env.BETTER_AUTH_SECRET);

  if (db.hasDatabase) {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      healthy = false;
    }
  }

  res.status(healthy ? 200 : 503).json({ success: healthy, timestamp: new Date().toISOString() });
};
