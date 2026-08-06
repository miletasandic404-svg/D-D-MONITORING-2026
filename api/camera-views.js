const db = require('../db/index');
const { requireAuth, canAccessCamera } = require('../lib/_auth');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const crypto = require('crypto');
const { rateLimit } = require('../lib/_rate_limit');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('api-camera-views');

initSentry();


// ─── Zod schema for camera view creation ────────────────────────
const createViewSchema = z.object({
  camera_id: z.string().min(1, 'camera_id is required').max(50),
});

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  if (req.method === 'POST') {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      let data;
      try {
        data = createViewSchema.parse(req.body || {});
      } catch (zodErr) {
        if (zodErr instanceof z.ZodError) {
          return sendError(res, 400, 'Validation failed',
            zodErr.errors.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
          );
        }
        throw zodErr;
      }
      const { camera_id } = data;

      // Authorization: verify the user has access to this camera before issuing a token
      const allowed = await canAccessCamera(auth, camera_id);
      if (!allowed) {
        return sendError(res, 403, 'You do not have access to this camera');
      }

      // Generate a short-lived stream token
      const streamToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Log at info level only (no token, no userId)
      console.log('[camera-views] Creating view session for camera:', camera_id);

      // Create stream token record
      const tokenResult = await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO camera_stream_tokens (camera_id, user_id, token, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [camera_id, auth.userId, streamToken, expiresAt],
      );

      // Create view log record
      const viewLogResult = await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO camera_view_logs (camera_id, user_id, organization_id, ip_address)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [camera_id, auth.userId, auth.organizationId, req.headers['x-forwarded-for'] || req.connection?.remoteAddress],
      );

      return sendSuccess(res, {
        streamToken: streamToken,
        viewLogId: viewLogResult.rows[0].id,
        expiresAt: expiresAt.toISOString(),
      }, 201);
    } catch (err) {
      logger.error('POST /api/camera-views error', { error: err.message });
      Sentry.captureException(err);
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'PATCH') {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const viewLogId = req.query.id;
      if (!viewLogId) {
        return sendError(res, 400, 'id is required');
      }

      await db.queryAsOrg(
        auth.organizationId,
        `UPDATE camera_view_logs SET ended_at = now() WHERE id = $1 AND user_id = $2`,
        [viewLogId, auth.userId],
      );

      return sendSuccess(res);
    } catch (err) {
      logger.error('PATCH /api/camera-views error', { error: err.message });
      Sentry.captureException(err);
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, 'Method Not Allowed');
};
