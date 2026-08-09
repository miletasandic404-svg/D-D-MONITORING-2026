// =========================================================
// Cloud Camera Accounts API
//
// Lets an org connect a camera-vendor cloud account (Tuya IoT Platform,
// Hikvision ISC/Ezviz Cloud, Reolink Cloud) so cameras that already push
// to the vendor's own cloud can be onboarded WITHOUT any local hardware
// (laptop/media node) at the customer's site.
//
// This is deliberately a separate flow from the existing ONVIF/RTSP
// camera-setup wizard (workers/camera-setup-agent.js): that flow needs a
// media node physically on the customer's LAN because private IPs
// (192.168.x.x) aren't reachable from the cloud. Vendor-cloud cameras
// solved that problem themselves -- we just talk to their API instead.
//
// Routes (all require an authenticated session):
//   POST /api/camera-cloud?path=connect   { provider, label, credentials }
//        -> validates credentials against the vendor API, stores them
//           encrypted, returns the saved account (never the secrets).
//   GET  /api/camera-cloud?path=accounts
//        -> lists this org's connected cloud accounts (no secrets).
//   DELETE /api/camera-cloud?path=accounts&id=<uuid>
//        -> removes a cloud account. Cameras already imported from it
//           are left as-is (cloud_account_id is set NULL via FK).
//   GET  /api/camera-cloud?path=discover&accountId=<uuid>
//        -> lists cameras visible on that vendor account, with an
//           `already_imported` flag per camera.
//   POST /api/camera-cloud?path=import    { accountId, deviceId, name, siteId }
//        -> creates a `cameras` row using the vendor-provided RTSP URL,
//           tagged with cloud_account_id/cloud_device_id so re-import
//           is idempotent.
//
// IMPORTANT CAVEAT (read before enabling for real customers):
// The vendor-specific request signing / endpoint paths in
// lib/_global_camera_discovery.js were written from vendor API docs but
// have NOT been exercised against a live Tuya/Hikvision/Reolink account.
// Vendor cloud APIs change frequently and some (e.g. Tuya) may require a
// different device-to-stream flow than a plain `rtsp_url` device
// property. Test each provider against a real trial account before
// relying on this for customers, and expect to adjust
// lib/_global_camera_discovery.js per-provider once you do.
// =========================================================

const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const { encrypt, decrypt } = require('../lib/_crypto');
const { logAudit, getIp } = require('../lib/_audit');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');
const {
  TuyaCloudDiscovery,
  HikvisionCloudDiscovery,
  ReolinkCloudDiscovery,
} = require('../lib/_global_camera_discovery');

const logger = makeLogger('api-camera-cloud');

initSentry();

const PROVIDERS = ['tuya', 'hikvision', 'reolink'];

// ─── Zod schemas ────────────────────────────────────────────────────────
const credentialsSchemaByProvider = {
  tuya: z.object({
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(200),
    region: z.enum(['eu', 'us', 'cn', 'ind']).default('eu'),
  }),
  hikvision: z.object({
    accessToken: z.string().min(1).max(500),
    region: z.string().min(1).max(50).default('eu'),
  }),
  reolink: z.object({
    accessToken: z.string().min(1).max(500),
  }),
};

const connectSchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().trim().max(100).default(''),
  credentials: z.record(z.string(), z.any()),
});

const importSchema = z.object({
  accountId: z.string().uuid(),
  deviceId: z.string().min(1).max(200),
  id: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'id must be alphanumeric (underscore/dash allowed)'),
  name: z.string().min(1).max(100),
  siteId: z.string().uuid().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────

/** Builds the vendor discovery client from decrypted stored credentials. */
function buildClient(provider, credentials) {
  if (provider === 'tuya') {
    return new TuyaCloudDiscovery(credentials.clientId, credentials.clientSecret, credentials.region);
  }
  if (provider === 'hikvision') {
    return new HikvisionCloudDiscovery(credentials.accessToken, credentials.region);
  }
  if (provider === 'reolink') {
    return new ReolinkCloudDiscovery(credentials.accessToken);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function sanitizeAccountRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
  if (!auth) return;

  const path = req.query.path;

  try {
    // ── POST ?path=connect ────────────────────────────────────────────
    if (path === 'connect' && req.method === 'POST') {
      const parsed = connectSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendError(res, 400, parsed.error.issues[0]?.message || 'Invalid request body');
      }
      const { provider, label, credentials } = parsed.data;

      const credSchema = credentialsSchemaByProvider[provider];
      const credParsed = credSchema.safeParse(credentials);
      if (!credParsed.success) {
        return sendError(res, 400, `Invalid credentials for ${provider}: ${credParsed.error.issues[0]?.message}`);
      }

      // Validate against the real vendor API before saving anything --
      // a stored-but-broken account is worse than no account, since the
      // UI would show it as present without it actually working.
      let status = 'connected';
      let lastError = null;
      try {
        const client = buildClient(provider, credParsed.data);
        // discoverCameras() is used purely as a connectivity check here;
        // an empty result is still success (the account may just have
        // no cameras yet), errors/exceptions are what indicate failure.
        await client.discoverCameras();
      } catch (err) {
        status = 'error';
        lastError = err.message || 'Connection check failed';
        logger.warn('camera_cloud.connect_check_failed', { provider, error: lastError });
      }

      const encryptedCredentials = encrypt(JSON.stringify(credParsed.data));

      const { rows } = await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO camera_cloud_accounts
           (organization_id, provider, label, encrypted_credentials, status, last_checked_at, last_error, created_by)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7)
         RETURNING id, provider, label, status, last_checked_at, last_error, created_at`,
        [auth.organizationId, provider, label, encryptedCredentials, status, lastError, auth.userId],
      );

      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'camera_cloud.account_connected',
        resourceType: 'camera_cloud_account',
        resourceId: rows[0].id,
        ipAddress: getIp(req),
        metadata: { provider, status },
      });

      return sendSuccess(res, { account: sanitizeAccountRow(rows[0]) }, status === 'connected' ? 201 : 200);
    }

    // ── GET ?path=accounts ────────────────────────────────────────────
    if (path === 'accounts' && req.method === 'GET') {
      const { rows } = await db.queryAsOrg(
        auth.organizationId,
        `SELECT id, provider, label, status, last_checked_at, last_error, created_at
         FROM camera_cloud_accounts
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [auth.organizationId],
      );
      return sendSuccess(res, { accounts: rows.map(sanitizeAccountRow) });
    }

    // ── DELETE ?path=accounts&id=<uuid> ───────────────────────────────
    if (path === 'accounts' && req.method === 'DELETE') {
      const id = z.string().uuid().safeParse(req.query.id);
      if (!id.success) return sendError(res, 400, 'id must be a valid UUID');

      const { rowCount } = await db.queryAsOrg(
        auth.organizationId,
        `DELETE FROM camera_cloud_accounts WHERE id = $1 AND organization_id = $2`,
        [id.data, auth.organizationId],
      );
      if (rowCount === 0) return sendError(res, 404, 'Cloud account not found');

      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'camera_cloud.account_removed',
        resourceType: 'camera_cloud_account',
        resourceId: id.data,
        ipAddress: getIp(req),
      });

      return sendSuccess(res, { deleted: true });
    }

    // ── GET ?path=discover&accountId=<uuid> ───────────────────────────
    if (path === 'discover' && req.method === 'GET') {
      const accountId = z.string().uuid().safeParse(req.query.accountId);
      if (!accountId.success) return sendError(res, 400, 'accountId must be a valid UUID');

      const { rows } = await db.queryAsOrg(
        auth.organizationId,
        `SELECT id, provider, encrypted_credentials FROM camera_cloud_accounts
         WHERE id = $1 AND organization_id = $2`,
        [accountId.data, auth.organizationId],
      );
      if (rows.length === 0) return sendError(res, 404, 'Cloud account not found');

      const account = rows[0];
      const credentials = JSON.parse(decrypt(account.encrypted_credentials) || '{}');
      const client = buildClient(account.provider, credentials);

      let cameras;
      try {
        cameras = await client.discoverCameras();
      } catch (err) {
        logger.error('camera_cloud.discover_failed', { accountId: accountId.data, error: err.message });
        Sentry.captureException(err);
        return sendError(res, 502, `Failed to reach ${account.provider} cloud: ${err.message}`);
      }

      const { rows: imported } = await db.queryAsOrg(
        auth.organizationId,
        `SELECT cloud_device_id FROM cameras WHERE cloud_account_id = $1`,
        [accountId.data],
      );
      const importedIds = new Set(imported.map((r) => r.cloud_device_id));

      return sendSuccess(res, {
        cameras: cameras.map((c) => ({
          device_id: c.device_id || c.id,
          name: c.name,
          model: c.model || null,
          status: c.status || null,
          ip: c.ip || null,
          already_imported: importedIds.has(c.device_id || c.id),
        })),
      });
    }

    // ── POST ?path=import ─────────────────────────────────────────────
    if (path === 'import' && req.method === 'POST') {
      const parsed = importSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return sendError(res, 400, parsed.error.issues[0]?.message || 'Invalid request body');
      }
      const { accountId, deviceId, id, name, siteId } = parsed.data;

      const { rows } = await db.queryAsOrg(
        auth.organizationId,
        `SELECT id, provider, encrypted_credentials FROM camera_cloud_accounts
         WHERE id = $1 AND organization_id = $2`,
        [accountId, auth.organizationId],
      );
      if (rows.length === 0) return sendError(res, 404, 'Cloud account not found');

      const account = rows[0];
      const credentials = JSON.parse(decrypt(account.encrypted_credentials) || '{}');
      const client = buildClient(account.provider, credentials);

      let rtspUrl;
      try {
        rtspUrl = await client.getRtspUrl(deviceId);
      } catch (err) {
        logger.error('camera_cloud.import_rtsp_lookup_failed', { accountId, deviceId, error: err.message });
        Sentry.captureException(err);
        return sendError(res, 502, `Failed to get stream URL from ${account.provider}: ${err.message}`);
      }
      if (!rtspUrl) {
        return sendError(res, 502, `${account.provider} did not return a stream URL for this camera. It may not support cloud-relayed streaming.`);
      }

      const siteRow = siteId
        ? { id: siteId }
        : (await db.queryAsOrg(auth.organizationId, `SELECT id FROM sites WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`, [auth.organizationId])).rows[0];
      if (!siteRow) return sendError(res, 400, 'No site found for this organization; create a site first');

      const { rows: cam } = await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO cameras (id, name, rtsp_url, organization_id, site_id, enabled, cloud_account_id, cloud_device_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           rtsp_url = EXCLUDED.rtsp_url,
           cloud_account_id = EXCLUDED.cloud_account_id,
           cloud_device_id = EXCLUDED.cloud_device_id,
           updated_at = now()
         RETURNING id, name, cloud_account_id, cloud_device_id`,
        [id, name, rtspUrl, auth.organizationId, siteRow.id, accountId, deviceId],
      );

      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'camera_cloud.camera_imported',
        resourceType: 'camera',
        resourceId: id,
        ipAddress: getIp(req),
        metadata: { provider: account.provider, deviceId },
      });

      return sendSuccess(res, { camera: cam[0] }, 201);
    }

    return sendError(res, 404, 'Unknown path. Valid paths: connect, accounts, discover, import');
  } catch (err) {
    logger.error('camera_cloud.unexpected_error', { error: err.message, path });
    Sentry.captureException(err);
    return sendError(res, 500, 'Internal server error');
  }
};
