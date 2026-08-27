const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-known-entities');

initSentry();

const FACE_STATUSES = ['active', 'suspicious', 'blocked'];
const PLATE_STATUSES = ['allowed', 'blocked', 'unknown'];

const faceEnrollSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  image_url: z.string().url().optional().nullable(),
  status: z.enum(FACE_STATUSES).optional(),
}).strict();

const faceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  image_url: z.string().url().optional().nullable(),
  status: z.enum(FACE_STATUSES).optional(),
}).strict();

const plateEnrollSchema = z.object({
  plate_number: z.string().trim().min(1, 'Plate number is required').max(50),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  vehicle_color: z.string().trim().max(50).optional().nullable(),
  status: z.enum(PLATE_STATUSES).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
}).strict();

const plateUpdateSchema = z.object({
  plate_number: z.string().trim().min(1).max(50).optional(),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  vehicle_color: z.string().trim().max(50).optional().nullable(),
  status: z.enum(PLATE_STATUSES).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
}).strict();

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  const entity = req.query.entity || 'face';

  if (req.method === 'GET') {
    return entity === 'plate' ? handlePlateGet(req, res) : handleFaceGet(req, res);
  }
  if (req.method === 'POST') {
    return entity === 'plate' ? handlePlateEnroll(req, res) : handleFaceEnroll(req, res);
  }
  if (req.method === 'PUT') {
    return entity === 'plate' ? handlePlateUpdate(req, res) : handleFaceUpdate(req, res);
  }
  if (req.method === 'DELETE') {
    return entity === 'plate' ? handlePlateDelete(req, res) : handleFaceDelete(req, res);
  }
  return sendError(res, 405, 'Method Not Allowed');
};

// ═══════════════════════════════════════════════════════════════════
// FACE HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleFaceGet(req, res) {
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

async function handleFaceEnroll(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to enroll faces');
  }

  let data;
  try {
    data = faceEnrollSchema.parse(req.body || {});
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

async function handleFaceUpdate(req, res) {
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
    data = faceUpdateSchema.parse(req.body || {});
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

async function handleFaceDelete(req, res) {
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

// ═══════════════════════════════════════════════════════════════════
// PLATE HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handlePlateGet(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, plate_number, vehicle_make, vehicle_model, vehicle_color, status, notes, created_by, created_at, updated_at
       FROM known_plates
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [auth.organizationId],
    );

    return sendSuccess(res, { known_plates: rows });
  } catch (err) {
    logger.error('GET /api/license-plates error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handlePlateEnroll(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to enroll plates');
  }

  let data;
  try {
    data = plateEnrollSchema.parse(req.body || {});
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
      `INSERT INTO known_plates (organization_id, plate_number, vehicle_make, vehicle_model, vehicle_color, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, plate_number) DO UPDATE SET
         vehicle_make = EXCLUDED.vehicle_make,
         vehicle_model = EXCLUDED.vehicle_model,
         vehicle_color = EXCLUDED.vehicle_color,
         status = EXCLUDED.status,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING id, plate_number, vehicle_make, vehicle_model, vehicle_color, status, notes, created_by, created_at, updated_at`,
      [auth.organizationId, data.plate_number, data.vehicle_make || null, data.vehicle_model || null, data.vehicle_color || null, data.status || 'unknown', data.notes || null, auth.userId],
    );

    const plate = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'plate.enroll',
      resourceType: 'known_plates',
      resourceId: plate.id,
      metadata: { plate_number: plate.plate_number, status: plate.status },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { plate }, 201);
  } catch (err) {
    logger.error('POST /api/license-plates/enroll error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handlePlateUpdate(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to update plates');
  }

  const plateId = req.query.id;
  if (!plateId) {
    return sendError(res, 400, 'Plate ID is required');
  }

  let data;
  try {
    data = plateUpdateSchema.parse(req.body || {});
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

    const values = [auth.organizationId, plateId, ...fields.map(f => data[f])];

    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `UPDATE known_plates
       SET ${setClauses.join(', ')}
       WHERE organization_id = $1 AND id = $2
       RETURNING id, plate_number, vehicle_make, vehicle_model, vehicle_color, status, notes, created_by, created_at, updated_at`,
      values,
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Plate not found');
    }

    const plate = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'plate.update',
      resourceType: 'known_plates',
      resourceId: plate.id,
      metadata: { updated_fields: fields },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { plate });
  } catch (err) {
    logger.error('PUT /api/license-plates/:id error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handlePlateDelete(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to delete plates');
  }

  const plateId = req.query.id;
  if (!plateId) {
    return sendError(res, 400, 'Plate ID is required');
  }

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `DELETE FROM known_plates
       WHERE organization_id = $1 AND id = $2
       RETURNING id, plate_number`,
      [auth.organizationId, plateId],
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Plate not found');
    }

    const plate = rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'plate.delete',
      resourceType: 'known_plates',
      resourceId: plateId,
      metadata: { plate_number: plate.plate_number },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { deleted: true, id: plateId });
  } catch (err) {
    logger.error('DELETE /api/license-plates/:id error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}
