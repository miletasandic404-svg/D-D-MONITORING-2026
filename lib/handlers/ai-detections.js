const db = require('../../db/index');
const { requireAuth } = require('../_auth');
const { sendError, sendSuccess, tryCatch } = require('../_error');
const { rateLimit } = require('../_rate_limit');


module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  if (req.method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const result = await db.queryAsOrg(
        auth.organizationId,
        `SELECT 
          ad.id, ad.object_type, ad.confidence, ad.bounding_box,
          ad.created_at, e.camera_id, c.name as camera_name,
          e.event_type, e.severity
        FROM ai_detections ad
        JOIN events e ON ad.event_id = e.id
        LEFT JOIN cameras c ON e.camera_id = c.id
        WHERE e.organization_id = $1
        ORDER BY ad.created_at DESC
        LIMIT 100`,
        [auth.organizationId]
      );
      return sendSuccess(res, { detections: result.rows });
    } catch (err) {
      console.error('Error fetching AI detections:', err);
      return sendError(res, 500, 'Failed to fetch AI detections', [{ detail: err.message }]);
    }
  }

  return sendError(res, 405, 'Method not allowed');
};
