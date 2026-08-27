const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-settings');

initSentry();

const ALLOWED_SETTINGS = [
  'email_alerts',
  'push_notifications',
  'auto_reports',
  'weekly_summary',
  'map_overlays',
  'dark_mode',
];

const settingsSchema = z.object({
  email_alerts: z.boolean().optional(),
  push_notifications: z.boolean().optional(),
  auto_reports: z.boolean().optional(),
  weekly_summary: z.boolean().optional(),
  map_overlays: z.boolean().optional(),
  dark_mode: z.boolean().optional(),
}).strict();

const DEFAULT_SETTINGS = {
  email_alerts: true,
  push_notifications: true,
  auto_reports: false,
  weekly_summary: false,
  map_overlays: true,
  dark_mode: true,
};

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  if (req.method === 'PUT') {
    return handleUpdate(req, res);
  }
  return sendError(res, 405, 'Method Not Allowed');
};

async function handleGet(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT email_alerts, push_notifications, auto_reports, weekly_summary, map_overlays, dark_mode, updated_at, updated_by
       FROM organization_settings
       WHERE organization_id = $1`,
      [auth.organizationId],
    );

    if (rows.length === 0) {
      return sendSuccess(res, { settings: DEFAULT_SETTINGS });
    }

    return sendSuccess(res, { settings: rows[0] });
  } catch (err) {
    logger.error('GET /api/settings error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleUpdate(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userType = auth.userType;
  if (userType !== 'platform_admin' && userType !== 'org_admin') {
    return sendError(res, 403, 'Insufficient permissions to modify settings');
  }

  let data;
  try {
    data = settingsSchema.parse(req.body || {});
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
    return sendError(res, 400, 'No valid settings provided');
  }

  try {
    const setClauses = fields.map((f, i) => `${f} = $${i + 3}`);
    setClauses.push('updated_at = now()');
    setClauses.push(`updated_by = $${fields.length + 3}`);

    const values = [
      auth.organizationId,
      auth.userId,
      ...fields.map(f => data[f]),
      auth.userId,
    ];

    const result = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO organization_settings (organization_id, ${fields.join(', ')}, updated_at, updated_by)
       VALUES ($1, ${fields.map((_, i) => `$${i + 3}`).join(', ')}, now(), $${fields.length + 3})
       ON CONFLICT (organization_id)
       DO UPDATE SET ${setClauses.join(', ')}
       RETURNING email_alerts, push_notifications, auto_reports, weekly_summary, map_overlays, dark_mode, updated_at, updated_by`,
      values,
    );

    const settings = result.rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'settings.update',
      resourceType: 'organization_settings',
      resourceId: auth.organizationId,
      metadata: { updated_fields: fields },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { settings });
  } catch (err) {
    logger.error('PUT /api/settings error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}
