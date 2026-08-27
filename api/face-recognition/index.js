const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-face-recognition');

initSentry();

const VALID_STATUSES = ['active', 'suspicious', 'blocked'];

const enrollSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  image_url: z.string().url().optional().nullable(),
  status: z.enum(VALID_STATUSES).optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  image_url: z.string().url().optional().nullable(),
  status: z.enum(VALID_STATUSES).optional(),
}).strict();

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  if (req.method === 'POST') {
    return handleEnroll(req, res);
  }
  if (req.method === 'PUT') {
    return handleUpdate(req, res);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res);
  }
  return sendError(res, 405, 'Method Not Allowed');
};

async function handleGet(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, name, image_url, status, created_by, created_at, updated_at
       FROM known_faces
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [auth.organizationId],
    );

    return sendSuccess(res, { known_faces: rows });
  } catch (err) {
    logger.error('GET /api/face-recognition error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleEnroll(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to enroll faces');
  }

  let data;
  try {
    data = enrollSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO known_faces (organization_id, name, image_url, status, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, image_url, status, created_by, created_at, updated_at`,
      [auth.organizationId, data.name, data.image_url || null, data.status || 'active', auth.userId],
    );

    const face = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'face.enroll',
      resourceType: 'known_faces',
      resourceId: face.id,
      metadata: { name: face.name, status: face.status },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { face }, 201);
  } catch (err) {
    logger.error('POST /api/face-recognition/enroll error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleUpdate(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to update faces');
  }

  const faceId = req.query.id;
  if (!faceId) {
    return sendError(res, 400, 'Face ID is required');
  }

  let data;
  try {
    data = updateSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  const fields = Object.keys(data);
  if (fields.length === 0) {
    return sendError(res, 400, 'No valid fields to update');
  }

  try {
    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`);
    setClauses.push('updated_at = now()');

    const values = [auth.organizationId, faceId, ...fields.map(f => data[f])];

    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `UPDATE known_faces
       SET ${setClauses.join(', ')}
       WHERE organization_id = $1 AND id = $2
       RETURNING id, name, image_url, status, created_by, created_at, updated_at`,
      values,
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Face not found');
    }

    const face = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'face.update',
      resourceType: 'known_faces',
      resourceId: face.id,
      metadata: { updated_fields: fields },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { face });
  } catch (err) {
    logger.error('PUT /api/face-recognition/:id error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleDelete(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to delete faces');
  }

  const faceId = req.query.id;
  if (!faceId) {
    return sendError(res, 400, 'Face ID is required');
  }

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `DELETE FROM known_faces
       WHERE organization_id = $1 AND id = $2
       RETURNING id, name`,
      [auth.organizationId, faceId],
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Face not found');
    }

    const face = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'face.delete',
      resourceType: 'known_faces',
      resourceId: faceId,
      metadata: { name: face.name },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { deleted: true, id: faceId });
  } catch (err) {
    logger.error('DELETE /api/face-recognition/:id error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}
