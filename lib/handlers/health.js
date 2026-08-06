const db = require("../../db/index");
const { requireAuth } = require("../_auth");
const { sendError } = require("../_error");
const { rateLimit } = require("../_rate_limit");


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

    try {
      const cameraCounts = await db.queryAsPlatformAdmin(
        `SELECT 
          count(*) FILTER (WHERE status = 'online' OR status IS NULL) AS online,
          count(*) FILTER (WHERE status = 'offline') AS offline,
          count(*) FILTER (WHERE status = 'warning') AS degraded,
          count(*) FILTER (WHERE status IS NULL) AS unknown
        FROM cameras`
      );
      const cameras = cameraCounts.rows[0] || { online: 0, offline: 0, degraded: 0, unknown: 0 };

      const nodeCounts = await db.queryAsPlatformAdmin(
        `SELECT 
          count(*) FILTER (WHERE status = 'active' OR status IS NULL) AS active,
          count(*) FILTER (WHERE status = 'offline') AS offline,
          count(*) FILTER (WHERE status IS NULL) AS unknown
        FROM media_nodes`
      );
      const media_nodes = nodeCounts.rows[0] || { active: 0, offline: 0, unknown: 0 };

      const recentErrors = await db.queryAsPlatformAdmin(
        `SELECT resource_type AS name, description AS error FROM audit_logs 
         WHERE created_at > now() - interval '24 hours' 
         ORDER BY created_at DESC LIMIT 5`
      );

      return res.json({
        cameras: {
          online: parseInt(cameras.online) || 0,
          offline: parseInt(cameras.offline) || 0,
          degraded: parseInt(cameras.degraded) || 0,
          unknown: parseInt(cameras.unknown) || 0,
        },
        streams: { active: 0, audio_ready: 0, talk_ready: 0 },
        media_nodes: {
          active: parseInt(media_nodes.active) || 0,
          offline: parseInt(media_nodes.offline) || 0,
          unknown: parseInt(media_nodes.unknown) || 0,
        },
        timestamp: new Date().toISOString(),
        recent_errors: recentErrors.rows.map(r => ({ name: r.name, error: r.error })),
      });
    } catch (err) {
      console.error('GET /api/health/dashboard error:', err.message);
      return res.json({
        cameras: { online: 0, offline: 0, degraded: 0, unknown: 0 },
        streams: { active: 0, audio_ready: 0, talk_ready: 0 },
        media_nodes: { active: 0, offline: 0, unknown: 0 },
        timestamp: new Date().toISOString(),
        recent_errors: [],
      });
    }
  }

  // ── Diagnostics endpoint (no auth) ──────────────────────
  const checks = {
    node_version: process.version,
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      BETTER_AUTH_SECRET: Boolean(process.env.BETTER_AUTH_SECRET),
      STORAGE_BUCKET: Boolean(process.env.STORAGE_BUCKET),
      STORAGE_ACCESS_KEY_ID: Boolean(process.env.STORAGE_ACCESS_KEY_ID),
      STORAGE_SECRET_ACCESS_KEY: Boolean(process.env.STORAGE_SECRET_ACCESS_KEY),
    },
    pg_module_loaded: db.hasDatabase !== undefined,
    database: { configured: db.hasDatabase, connected: null, has_default_organization: null },
  };

  if (db.hasDatabase) {
    try {
      await db.query('SELECT 1');
      checks.database.connected = true;
    } catch (err) {
      checks.database.connected = false;
      checks.database.error = err.message;
      console.error("[health] DB connectivity check failed:", err.message);
    }

    if (checks.database.connected) {
      try {
        const { rows } = await db.query(
          "SELECT count(*)::int AS count FROM organizations WHERE name = 'Default Organization'"
        );
        checks.database.has_default_organization = rows[0].count > 0;
      } catch (err) {
        checks.database.has_default_organization = false;
        checks.database.migration_error = err.message;
        console.error("[health] organizations table check failed (migrations not run?):", err.message);
      }
    }
  }

  const healthy = checks.env.DATABASE_URL
    && checks.env.BETTER_AUTH_SECRET
    && checks.database.connected === true
    && checks.database.has_default_organization === true;

  const storageReady = checks.env.STORAGE_BUCKET && checks.env.STORAGE_ACCESS_KEY_ID && checks.env.STORAGE_SECRET_ACCESS_KEY;

  res.status(healthy ? 200 : 503).json({ success: healthy, checks, storage_ready: storageReady });
};
