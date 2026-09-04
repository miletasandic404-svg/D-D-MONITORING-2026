'use strict';

/**
 * GET /api/health/storage
 *
 * Returns tenant-scoped storage usage statistics for the Dashboard's
 * "Storage Usage" tile. The source of truth is the database
 * (`snapshots.file_size_bytes` + `recordings.size_bytes`) so we never
 * need to list objects in the underlying S3-compatible bucket or scan
 * the local filesystem root — that would be O(n) on every Dashboard
 * poll and would risk rate-limiting at the storage provider.
 *
 * Auth & tenant isolation mirror `lib/handlers/health.js` exactly:
 *   - Auth-gated via `requireAuth`.
 *   - `platform_admin` -> `db.queryAsPlatformAdmin` (no WHERE clause).
 *   - Org user       -> `db.queryAsOrg(orgId, ...)` with
 *                        `organization_id = $1` filter.
 *   - Non-platform user without `organizationId` -> fail-closed,
 *     returns `configured: false` (matches the health.js behavior).
 *
 * The response NEVER contains bucket name, endpoint, region, access
 * key, secret key, local path, or any presigned URL. Only aggregate
 * byte counts and object counts. This is deliberate: storage metadata
 * could otherwise leak tenant boundaries or be used to fingerprint
 * deployment topology.
 */

const db = require('../../db/index');
const { requireAuth } = require('../_auth');
const { rateLimit } = require('../_rate_limit');
const { makeLogger } = require('../_logger');
const storage = require('../_storage');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-health-storage');

initSentry();

function emptyPayload(configured) {
  return {
    configured,
    source: configured ? 'db' : 'unconfigured',
    used_bytes: 0,
    snapshot_bytes: 0,
    recording_bytes: 0,
    snapshot_count: 0,
    recording_count: 0,
    object_count: 0,
  };
}

async function sumForOrg(run, isPlatformAdmin, table, sizeColumn, orgParams) {
  // One small SUM + COUNT query per table. The (organization_id)
  // index covers both the filtered and unfiltered variants well enough
  // for the dashboard poll cadence (20s).
  const filter = isPlatformAdmin ? '' : ' WHERE organization_id = $1';
  const sql = `SELECT COALESCE(SUM(${sizeColumn}), 0)::bigint AS bytes,
                      COUNT(*)::bigint AS count
               FROM ${table}${filter}`;
  const res = await run(sql, orgParams);
  const row = res.rows[0] || { bytes: 0, count: 0 };
  return {
    bytes: Number(row.bytes) || 0,
    count: Number(row.count) || 0,
  };
}

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const isPlatformAdmin = auth.userType === 'platform_admin';

  // Fail-closed for a non-platform user with no org scope. The health
  // endpoint follows the same pattern.
  if (!isPlatformAdmin && !auth.organizationId) {
    return res.json({
      ...emptyPayload(false),
      error: 'no organization scope',
    });
  }

  // Source-of-truth for "configured" matches `lib/_storage.js#isConfigured`
  // which already understands both the S3 and local backends. We do NOT
  // recompute it here so the two endpoints cannot drift.
  const configured = storage.isConfigured();

  if (!configured) {
    return res.json(emptyPayload(false));
  }

  try {
    const run = (sql, params) =>
      isPlatformAdmin
        ? db.queryAsPlatformAdmin(sql, params)
        : db.queryAsOrg(auth.organizationId, sql, params);
    const orgParams = isPlatformAdmin ? [] : [auth.organizationId];

    const snapshots = await sumForOrg(
      run, isPlatformAdmin, 'snapshots', 'file_size_bytes', orgParams,
    );
    const recordings = await sumForOrg(
      run, isPlatformAdmin, 'recordings', 'size_bytes', orgParams,
    );

    const usedBytes = snapshots.bytes + recordings.bytes;
    const objectCount = snapshots.count + recordings.count;

    return res.json({
      configured: true,
      // 'db' is the only legal value here today. 's3' / 'local' / etc.
      // are deliberately not exposed because that would leak which
      // storage backend the deployment uses, which is unnecessary
      // information for an operator dashboard.
      source: 'db',
      used_bytes: usedBytes,
      snapshot_bytes: snapshots.bytes,
      recording_bytes: recordings.bytes,
      snapshot_count: snapshots.count,
      recording_count: recordings.count,
      object_count: objectCount,
    });
  } catch (err) {
    logger.error('GET /api/health/storage error', { error: err.message });
    Sentry.captureException(err);
    // Do not break the Dashboard. Return a structured "unknown" state
    // that the tile can render as "—" / "Storage query failed".
    return res.json({
      ...emptyPayload(false),
      error: 'db query failed',
    });
  }
};
