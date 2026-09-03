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
    // api_reachable is set by the handler after a real round-trip to
    // GET /api/health so the Dashboard can render System Health / API
    // Status without inventing a new value.
    api_reachable: false,
    // streams.diagnostics is non-breaking: same definition for
    // streams.active, plus the raw underlying counts that explain why
    // active is 0 when cameras are enabled and a media node exists.
    streams_diagnostics: {
      enabled_with_node: 0,
      enabled_total: 0,
      fresh_nodes: 0,
      fresh_threshold_seconds: 90,
    },
  };
}

// Single source of truth for "is the API healthy?". Mirrors the
// no-auth GET /api/health diagnostics response (200/503 + body).
// Never throws — returns {reachable, status, degraded}.
// `degraded` is true when env is configured but the DB ping failed,
// which the Dashboard surfaces as "Degraded" (vs "Offline" for
// unreachable).
async function probeApiHealth(dbRef) {
  const envOk = dbRef.hasDatabase
    && Boolean(process.env.DATABASE_URL)
    && Boolean(process.env.BETTER_AUTH_SECRET);
  if (!envOk) {
    return { reachable: false, status: 'offline', degraded: false, reason: 'missing env' };
  }
  try {
    await dbRef.query('SELECT 1');
    return { reachable: true, status: 'online', degraded: false, reason: null };
  } catch (err) {
    logger.warn('probeApiHealth: SELECT 1 failed', { error: err.message });
    return { reachable: false, status: 'offline', degraded: true, reason: 'db ping failed' };
  }
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
        // Still run the API health probe so System Health / API Status
        // tiles reflect reality, even when the user has no org scope.
        const apiProbe = await probeApiHealth(db);
        const payload = emptyDashboard();
        payload.api_reachable = apiProbe.reachable;
        payload.api_status = apiProbe.status;
        payload.api_degraded = apiProbe.degraded;
        payload.api_reason = apiProbe.reason;
        return res.json(payload);
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

      // Real API health probe — same checks as GET /api/health
      // (no-auth diagnostics): DB reachable + required env vars set.
      // We do this first so the response always carries an honest
      // api_reachable / api_status flag, even if a later query throws.
      // Never throws.
      const apiProbe = await probeApiHealth(db);

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
      // Diagnostic counts — same tenant scope, same WHERE structure
      // apart from the removed predicate. These let the UI explain
      // "active = 0" without changing the definition of streams.active.
      const diagnosticCounts = await run(
        `SELECT
           count(*) FILTER (WHERE c.enabled = TRUE) AS enabled_total,
           count(*) FILTER (WHERE c.enabled = TRUE AND c.media_node_id IS NOT NULL) AS enabled_with_node,
           count(*) FILTER (WHERE c.media_node_id IS NOT NULL AND n.last_heartbeat_at > now() - interval '90 seconds') AS fresh_nodes
         FROM cameras c
         LEFT JOIN media_nodes n ON n.id = c.media_node_id
         ${isPlatformAdmin ? '' : 'WHERE c.organization_id = $1'}`,
        orgParams,
      );
      const streams = { active: parseInt(streamCounts.rows[0]?.active) || 0, audio_ready: 0, talk_ready: 0 };
      const streamsDiagnostics = {
        enabled_with_node: parseInt(diagnosticCounts.rows[0]?.enabled_with_node) || 0,
        enabled_total: parseInt(diagnosticCounts.rows[0]?.enabled_total) || 0,
        fresh_nodes: parseInt(diagnosticCounts.rows[0]?.fresh_nodes) || 0,
        fresh_threshold_seconds: 90,
      };

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
        streams,
        streams_diagnostics: streamsDiagnostics,
        media_nodes: {
          active: parseInt(media_nodes.active) || 0,
          offline: parseInt(media_nodes.offline) || 0,
          unknown: parseInt(media_nodes.unknown) || 0,
        },
        timestamp: new Date().toISOString(),
        recent_errors: recentErrors.rows.map(r => ({ name: r.name, error: r.error })),
        // api_reachable / api_status come from the real probe above
        // (same checks as GET /api/health). The Dashboard wires the
        // System Health and API Status tiles to these values — no
        // hard-coded strings, no faked "Online".
        api_reachable: apiProbe.reachable,
        api_status: apiProbe.status,
        api_degraded: apiProbe.degraded,
        api_reason: apiProbe.reason,
      });
    } catch (err) {
      logger.error('GET /api/health/dashboard error', { error: err.message });
      Sentry.captureException(err);
      const failed = emptyDashboard();
      failed.api_reachable = false;
      failed.api_status = 'degraded';
      failed.api_reason = 'dashboard query failed';
      return res.json(failed);
    }
  }

  // ── Diagnostics endpoint (no auth) ──────────────────────
  // Uses the same probeApiHealth helper as the dashboard branch so
  // both endpoints agree on the definition of "healthy".
  const apiProbe = await probeApiHealth(db);
  const healthy = apiProbe.reachable;
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: apiProbe.status,
    degraded: apiProbe.degraded,
    reason: apiProbe.reason,
    timestamp: new Date().toISOString(),
  });
};
