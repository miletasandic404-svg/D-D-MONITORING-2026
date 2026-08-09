const db = require('../../db/index');
const { requireAuth } = require('../_auth');
const { getIp } = require('../_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../_error');
const { rateLimit } = require('../_rate_limit');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-snapshots');

initSentry();


// ─── Zod schema for snapshot creation ───────────────────────────
const createSnapshotSchema = z.object({
  camera_id: z.string().min(1, 'camera_id is required').max(50),
  image_base64: z.string().min(1, 'image_base64 is required').max(50 * 1024 * 1024, 'image_base64 too large (max 50MB)'),
});

// Takes a snapshot from a camera and stores it.
// Expects: { camera_id, image_base64 } (base64-encoded JPEG)
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

    // Store snapshot reference in database
    const storageUrl = `data:image/jpeg;base64,${image_base64.substring(0, 50)}...`; // truncated for storage
    const result = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO snapshots (camera_id, organization_id, taken_by_user_id, storage_url, trigger)
       VALUES ($1, $2, $3, $4, 'manual') RETURNING id, taken_at`,
      [camera_id, auth.organizationId, auth.userId, storageUrl],
    );

    return sendSuccess(res, { snapshot: result.rows[0] }, 201);
  } catch (err) {
    logger.error('POST /api/snapshots error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};
