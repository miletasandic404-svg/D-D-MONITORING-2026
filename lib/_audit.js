const db = require('../db/index');

/**
 * Records a sensitive action to the append-only audit_logs table
 * (Phase 6). Failures here are logged but never thrown -- an audit
 * write failing must not fail the actual request it's describing.
 */
async function logAudit({ organizationId, userId, action, resourceType, resourceId, metadata, ipAddress }) {
  try {
    await db.queryAsOrg(
      organizationId,
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [organizationId, userId, action, resourceType || null, resourceId != null ? String(resourceId) : null, metadata ? JSON.stringify(metadata) : null, ipAddress || null],
    );
  } catch (err) {
    console.error('[audit] failed to record action', action, err.message);
  }
}

/**
 * Same as logAudit, but for platform-level actions with no
 * organization_id (e.g. platform_admin creating a media node) --
 * bypasses RLS via queryAsPlatformAdmin instead of requiring a tenant.
 */
async function logPlatformAudit({ userId, action, resourceType, resourceId, metadata, ipAddress }) {
  try {
    await db.queryAsPlatformAdmin(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata, ip_address)
       VALUES (NULL, $1, $2, $3, $4, $5, $6)`,
      [userId, action, resourceType || null, resourceId != null ? String(resourceId) : null, metadata ? JSON.stringify(metadata) : null, ipAddress || null],
    );
  } catch (err) {
    console.error('[audit] failed to record platform action', action, err.message);
  }
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null;
}

module.exports = { logAudit, logPlatformAudit, getIp };
