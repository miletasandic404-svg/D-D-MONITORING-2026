const db = require('../../db/index');
const { requireAuth, getAccessibleCameraIds } = require('../_auth');
const { sendError, sendSuccess } = require('../_error');
const { rateLimit } = require('../_rate_limit');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-recordings');

initSentry();


module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const accessibleIds = await getAccessibleCameraIds(auth);
    if (accessibleIds !== null && accessibleIds.length === 0) {
      return sendSuccess(res, { count: 0, recordings: [] });
    }

    const baseSelect = `
      SELECT r.id, c.name AS camera_name, r.start_time AS timestamp,
             r.duration_seconds AS duration,
             ROUND(COALESCE(r.size_bytes, 0) / (1024.0 * 1024.0), 2) AS size,
             r.trigger_reason, e.event_type, e.severity
      FROM recordings r
      JOIN cameras c ON c.id = r.camera_id
      LEFT JOIN events e ON e.id = r.event_id
      WHERE r.organization_id = $1 AND r.status = 'completed'`;

    let result;
    if (accessibleIds === null) {
      result = await db.queryAsOrg(
        auth.organizationId,
        `${baseSelect} ORDER BY r.start_time DESC LIMIT 100`,
        [auth.organizationId],
      );
    } else {
      result = await db.queryAsOrg(
        auth.organizationId,
        `${baseSelect} AND c.id = ANY($2::varchar[]) ORDER BY r.start_time DESC LIMIT 100`,
        [auth.organizationId, accessibleIds],
      );
    }

    const recordings = result.rows.map((r) => {
      let type = 'Manual';
      if (r.trigger_reason === 'continuous') {
        type = 'Continuous';
      } else if (r.trigger_reason === 'event') {
        if (r.severity === 'ALERT' || (r.event_type && /alarm/i.test(r.event_type))) {
          type = 'Alarm';
        } else {
          type = 'Motion';
        }
      }

      return {
        id: r.id,
        camera_name: r.camera_name,
        type,
        duration: r.duration || 0,
        size: r.size || 0,
        timestamp: r.timestamp,
      };
    });

    return sendSuccess(res, { count: recordings.length, recordings });
  } catch (err) {
    logger.error('GET /api/recordings error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};
