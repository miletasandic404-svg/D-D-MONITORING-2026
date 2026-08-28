const crypto = require('crypto');
const db = require('../../db/index');
const { requireAuth } = require('../_auth');
const { logAudit, getIp } = require('../_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../_error');
const { rateLimit } = require('../_rate_limit');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');
const { isConfigured, getBackend, uploadObject } = require('../_storage');

const logger = makeLogger('handler-snapshots');

initSentry();


// ─── Zod schema for snapshot creation ───────────────────────────
const createSnapshotSchema = z.object({
  camera_id: z.string().min(1, 'camera_id is required').max(50),
  image_base64: z.string().min(1, 'image_base64 is required').max(50 * 1024 * 1024, 'image_base64 too large (max 50MB)'),
});

// Takes a snapshot from a camera and stores it.
// Expects: { camera_id, image_base64 } (base64-encoded JPEG, no data-URL prefix)
module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    let data;
    try {
      data = createSnapshotSchema.parse(req.body || {});
    } catch (zodErr) {
      if (zodErr instanceof z.ZodError) {
        return sendError(res, 400, 'Validation failed',
          zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
        );
      }
      throw zodErr;
    }
    const { camera_id, image_base64 } = data;

    // Verify camera belongs to this organization
    const cam = await db.queryAsOrg(
      auth.organizationId,
      'SELECT id FROM cameras WHERE id = $1 AND organization_id = $2',
      [camera_id, auth.organizationId],
    );
    if (cam.rows.length === 0) {
      return sendError(res, 404, 'Camera not found in your organization');
    }

    // Decode the base64 image into a Buffer
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(image_base64, 'base64');
    } catch {
      return sendError(res, 400, 'Invalid base64 image data');
    }
    if (imageBuffer.length === 0) {
      return sendError(res, 400, 'Decoded image is empty');
    }

    // Storage must be configured — fail with a clear error instead of
    // inventing a fake storage_url.
    if (!isConfigured()) {
      return sendError(res, 503, 'Object storage is not configured. Contact your administrator.');
    }

    // Upload the image to object storage and obtain a real public URL
    const key = `snapshots/${auth.organizationId}/${camera_id}/${crypto.randomUUID()}.jpg`;
    const storageUrl = await uploadObject({ key, body: imageBuffer, contentType: 'image/jpeg' });

    // Store the real storage_url in the database
    const result = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO snapshots (camera_id, organization_id, taken_by_user_id, storage_url, trigger)
       VALUES ($1, $2, $3, $4, 'manual') RETURNING id, taken_at, storage_url`,
      [camera_id, auth.organizationId, auth.userId, storageUrl],
    );

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'snapshot.create',
      resourceType: 'snapshot',
      resourceId: result.rows[0].id,
      ipAddress: getIp(req),
      metadata: { camera_id, size_bytes: imageBuffer.length },
    });

    return sendSuccess(res, { snapshot: result.rows[0] }, 201);
  } catch (err) {
    // Log full error details for server-side debugging (never expose internals to client)
    logger.error('POST /api/snapshots failed', {
      error: err.message,
      code: err.code,
      name: err.name,
      stack: err.stack,
      camera_id: req.body?.camera_id,
      orgId: auth?.organizationId,
    });
    Sentry.captureException(err);

    // Return safe, actionable error to client without exposing secrets
    let clientMessage = 'Snapshot capture failed. Please try again.';
    if (err.message && err.message.includes('Object storage is not configured')) {
      clientMessage = 'Object storage is not configured. Contact your administrator.';
    } else if (err.message && err.message.includes('Local storage is not configured')) {
      clientMessage = 'Local storage is not configured. Contact your administrator.';
    } else if (err.message && err.message.includes('Path traversal detected')) {
      clientMessage = 'Invalid storage path. Contact your administrator.';
    } else if (err.code === 'AccessDenied' || err.name === 'AccessDenied') {
      clientMessage = 'Storage access denied. Please contact your administrator.';
    } else if (err.code === 'NoSuchBucket' || err.name === 'NoSuchBucket') {
      clientMessage = 'Storage bucket not found. Please contact your administrator.';
    } else if (err.message && err.message.includes('ECONNREFUSED')) {
      clientMessage = 'Storage service unreachable. Please try again later.';
    } else if (err.message && err.message.includes('ENOSPC')) {
      clientMessage = 'Storage is full. Contact your administrator.';
    }

    return sendError(res, 500, clientMessage);
  }
};
