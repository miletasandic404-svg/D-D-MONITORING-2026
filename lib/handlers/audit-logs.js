const db = require('../../db/index');
const { requireAuth } = require('../_auth');
const { sendError, sendSuccess } = require('../_error');
const { rateLimit } = require('../_rate_limit');
const { z } = require('zod');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-audit-logs');

initSentry();

// =========================================================
// GET /api/audit-logs
//
// Lists rows from audit_logs for the Operator Audit Trail tile
// on the Dashboard. Source of truth is the audit_logs table; this
// endpoint is read-only and never exposes another tenant's rows.
//
// Tenant isolation:
//   - org users:    queryAsOrg(orgId, …) AND organization_id = $1
//   - platform_admin: queryAsPlatformAdmin(…) (sees every org, plus
//     platform-level rows with organization_id = NULL)
//
// Returns only the fields the Dashboard needs (no metadata, no IP).
// =========================================================

// Zod schema for query parameters. Coerces strings to numbers and
// clamps pagination so a malicious caller can't ask for -1 limit or
// a million-row page.
const querySchema = z.object({
  action: z.string().min(1).max(100).optional(),
  resource_type: z.string().min(1).max(50).optional(),
  from: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'from must be ISO date').optional()),
  to: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'to must be ISO date').optional()),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  let params;
  try {
    params = querySchema.parse(req.query || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message })));
    }
    throw zodErr;
  }

  const isPlatformAdmin = auth.userType === 'platform_admin';
  // Fail-closed for non-platform users without an org: they have no
  // scope to query against, and there's no platform-level fallthrough
  // for them.
  if (!isPlatformAdmin && !auth.organizationId) {
    return sendSuccess(res, { count: 0, total: 0, limit: params.limit, offset: params.offset, entries: [] });
  }

  // Build the WHERE clause + params. For org users, organization_id
  // is bound to the caller's org; for platform_admin it is left
  // open (so they see every org + NULL-org platform-level rows).
  const where = [];
  const values = [];
  let p = 1;

  if (!isPlatformAdmin) {
    where.push(`al.organization_id = $${p++}`);
    values.push(auth.organizationId);
  }
  if (params.action) {
    where.push(`action = $${p++}`);
    values.push(params.action);
  }
  if (params.resource_type) {
    where.push(`resource_type = $${p++}`);
    values.push(params.resource_type);
  }
  if (params.from) {
    where.push(`created_at >= $${p++}`);
    values.push(params.from);
  }
  if (params.to) {
    where.push(`created_at <= $${p++}`);
    values.push(params.to);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = params.limit;
  const offset = params.offset;
  // The + 0 / 0 are noise to make the SQL string stable for tests.
  // For platform_admin, JOIN users to surface the operator email
  // (a NULL user_id is still allowed — those are system rows).
  const joinSql = isPlatformAdmin
    ? 'LEFT JOIN users u ON u.id = al.user_id'
    : 'LEFT JOIN users u ON u.id = al.user_id AND u.organization_id = $1';
  const selectFields = isPlatformAdmin
    ? `al.id, al.user_id, al.action, al.resource_type, al.resource_id,
       al.organization_id, al.created_at, u.email AS user_email`
    : `al.id, al.user_id, al.action, al.resource_type, al.resource_id,
       al.organization_id, al.created_at, u.email AS user_email`;

  const run = (sql, args) =>
    isPlatformAdmin ? db.queryAsPlatformAdmin(sql, args) : db.queryAsOrg(auth.organizationId, sql, args);

  try {
    const dataSql = `
      SELECT ${selectFields}
      FROM audit_logs al
      ${joinSql}
      ${whereSql}
      ORDER BY al.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `;
    const countSql = `SELECT count(*)::int AS total FROM audit_logs al ${whereSql}`;
    const dataValues = [...values, limit, offset];
    const [dataResult, countResult] = await Promise.all([
      run(dataSql, dataValues),
      run(countSql, values),
    ]);
    return sendSuccess(res, {
      count: dataResult.rows.length,
      total: countResult.rows[0]?.total || 0,
      limit,
      offset,
      entries: dataResult.rows.map((r) => ({
        id: r.id,
        ts: r.created_at,
        user_id: r.user_id,
        user_email: r.user_email || null,
        action: r.action,
        resource_type: r.resource_type,
        resource_id: r.resource_id,
        organization_id: r.organization_id,
      })),
    });
  } catch (err) {
    logger.error('GET /api/audit-logs error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, 'Failed to load audit log');
  }
};
