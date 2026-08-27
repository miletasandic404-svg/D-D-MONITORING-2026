const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-license-plates');

initSentry();

const VALID_STATUSES = ['allowed', 'blocked', 'unknown'];

const enrollSchema = z.object({
  plate_number: z.string().trim().min(1, 'Plate number is required').max(50),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  vehicle_color: z.string().trim().max(50).optional().nullable(),
  status: z.enum(VALID_STATUSES).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
}).strict();

const updateSchema = z.object({
  plate_number: z.string().trim().min(1).max(50).optional(),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  vehicle_color: z.string().trim().max(50).optional().nullable(),
  status: z.enum(VALID_STATUSES).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
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

async function handleEnroll(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to enroll plates');
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

async function handleUpdate(req, res) {
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

async function handleDelete(req, res) {
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
