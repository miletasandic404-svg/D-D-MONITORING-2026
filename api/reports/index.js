const db = require('../../db/index');
const { requireAuth } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-reports');

initSentry();

const VALID_TYPES = ['daily', 'weekly', 'monthly'];

const querySchema = z.object({
  type: z.enum(VALID_TYPES).optional().default('daily'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, expected YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, expected YYYY-MM-DD').optional(),
}).strict();

function computeDateRange(type, from, to) {
  if (from && to) {
    return { from, to };
  }

  const now = new Date();
  let startDate;

  switch (type) {
    case 'weekly':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case 'monthly':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 30);
      break;
    case 'daily':
    default:
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 1);
      break;
  }

  return {
    from: startDate.toISOString().split('T')[0],
    to: now.toISOString().split('T')[0],
  };
}

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  let query;
  try {
    query = querySchema.parse(req.query || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  const { from, to } = computeDateRange(query.type, query.from, query.to);

  try {
    const { rows: statusRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT status, COUNT(*) as count
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date
       GROUP BY status`,
      [auth.organizationId, from, to],
    );

    const { rows: severityRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT severity, COUNT(*) as count
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date
       GROUP BY severity`,
      [auth.organizationId, from, to],
    );

    const { rows: cameraRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT c.name as camera_name, c.id as camera_id, COUNT(*) as count
       FROM incidents i
       JOIN cameras c ON c.id = i.camera_id
       WHERE i.organization_id = $1
         AND i.created_at::date >= $2::date
         AND i.created_at::date <= $3::date
       GROUP BY c.id, c.name
       ORDER BY count DESC
       LIMIT 10`,
      [auth.organizationId, from, to],
    );

    const { rows: totalRow } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT COUNT(*) as total,
              AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) as avg_resolution_minutes
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date`,
      [auth.organizationId, from, to],
    );

    const { rows: incidentRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT i.id, i.status, i.severity, i.created_at, i.resolved_at,
              e.description, c.name as camera_name
       FROM incidents i
       JOIN events e ON e.id = i.event_id
       LEFT JOIN cameras c ON c.id = i.camera_id
       WHERE i.organization_id = $1
         AND i.created_at::date >= $2::date
         AND i.created_at::date <= $3::date
       ORDER BY i.created_at DESC
       LIMIT 50`,
      [auth.organizationId, from, to],
    );

    const byStatus = {};
    for (const row of statusRows) {
      byStatus[row.status] = parseInt(row.count, 10);
    }

    const bySeverity = {};
    for (const row of severityRows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
    }

    const byCamera = cameraRows.map(r => ({
      camera_id: r.camera_id,
      camera_name: r.camera_name,
      count: parseInt(r.count, 10),
    }));

    const total = totalRow[0]?.total ? parseInt(totalRow[0].total, 10) : 0;
    const avgResolutionMinutes = totalRow[0]?.avg_resolution_minutes
      ? Math.round(parseFloat(totalRow[0].avg_resolution_minutes))
      : null;

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'report.view',
      resourceType: 'report',
      resourceId: null,
      metadata: { report_type: query.type, date_range: { from, to } },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, {
      generated_at: new Date().toISOString(),
      report_type: query.type,
      date_range: { from, to },
      summary: {
        total_incidents: total,
        by_status: byStatus,
        by_severity: bySeverity,
        by_camera: byCamera,
        avg_resolution_time_minutes: avgResolutionMinutes,
      },
      incidents: incidentRows,
    });
  } catch (err) {
    logger.error('GET /api/reports/summary error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};
