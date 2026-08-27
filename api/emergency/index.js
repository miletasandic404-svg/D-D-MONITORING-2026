const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-emergency');

initSentry();

const ALLOWED_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const ALLOWED_STATUSES = ['pending', 'dispatched', 'resolved', 'cancelled'];

const dispatchSchema = z.object({
  camera_id: z.string().max(50).optional().nullable(),
  incident_type: z.string().min(1, 'incident_type is required').max(50),
  location: z.string().max(255).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  priority: z.enum(ALLOWED_PRIORITIES).optional().default('high'),
});

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method === 'POST') {
    return handleCreate(req, res);
  }
  if (req.method === 'GET') {
    return handleList(req, res);
  }
  return sendError(res, 405, 'Method Not Allowed');
};

async function handleCreate(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let data;
  try {
    data = dispatchSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  try {
    const { camera_id, incident_type, location, description, priority } = data;

    const result = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO emergency_dispatches
         (organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id, organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by, created_at, updated_at`,
      [auth.organizationId, camera_id || null, incident_type, location || null, description || null, priority, auth.userId],
    );

    const dispatch = result.rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'emergency.dispatch',
      resourceType: 'emergency_dispatch',
      resourceId: dispatch.id,
      metadata: { incident_type, priority, camera_id: camera_id || null },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { dispatch }, 201);
  } catch (err) {
    logger.error('POST /api/emergency/dispatch error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleList(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by, created_at, updated_at
       FROM emergency_dispatches
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [auth.organizationId],
    );

    return sendSuccess(res, { count: rows.length, dispatches: rows });
  } catch (err) {
    logger.error('GET /api/emergency/dispatch error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}
