const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');


// ─── Zod schema for operator creation ──────────────────────────
const createOperatorSchema = z.object({
  email: z.string().email('Invalid email format'),
  name: z.string().min(1, 'Name is required').max(100),
  role: z.enum(['admin', 'operator']).optional().default('operator'),
});

// ─── Zod schema for operator assignment creation ────────────────
const createAssignmentSchema = z.object({
  user_id: z.string().uuid('user_id must be a valid UUID'),
  site_id: z.string().uuid('site_id must be a valid UUID'),
});

module.exports = async (req, res) => {
  if (!rateLimit(req, res)) return;
  const { path } = req.query;

  // ===== OPERATOR ASSIGNMENTS ROUTES =====
  if (path === 'assignments') {
    if (req.method === 'GET') {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        const { user_id, site_id, active } = req.query;
        let query = `
          SELECT oa.id, oa.user_id, oa.site_id, oa.assigned_by, oa.assigned_at, oa.active,
                 u.email as user_email, u.user_type as user_type,
                 s.name as site_name, s.address as site_address
          FROM operator_assignments oa
          JOIN users u ON u.id = oa.user_id
          JOIN sites s ON s.id = oa.site_id
          WHERE oa.user_id IN (SELECT id FROM users WHERE organization_id = $1)
            AND oa.site_id IN (SELECT id FROM sites WHERE organization_id = $1)
        `;
        const params = [auth.organizationId];
        let paramIndex = 2;
        if (user_id) { query += ` AND oa.user_id = $${paramIndex++}`; params.push(user_id); }
        if (site_id) { query += ` AND oa.site_id = $${paramIndex++}`; params.push(site_id); }
        if (active !== undefined) { query += ` AND oa.active = $${paramIndex++}`; params.push(active === 'true'); }
        query += ' ORDER BY oa.assigned_at DESC';
        const result = await db.queryAsOrg(auth.organizationId, query, params);
        return sendSuccess(res, { count: result.rows.length, assignments: result.rows });
      } catch (err) {
        console.error('GET /api/operator-assignments error:', err.message);
        return sendError(res, 500, err.message);
      }
    }
    if (req.method === 'POST') {
      const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
      if (!auth) return;
      try {
        let assignmentData;
        try {
          assignmentData = createAssignmentSchema.parse(req.body || {});
        } catch (zodErr) {
          if (zodErr instanceof z.ZodError) {
            return sendError(res, 400, 'Validation failed',
              zodErr.errors.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
            );
          }
          throw zodErr;
        }
        const { user_id, site_id } = assignmentData;
        const result = await db.queryAsOrg(auth.organizationId,
          `INSERT INTO operator_assignments (user_id, site_id, assigned_by, assigned_at, active)
           VALUES ($1, $2, $3, now(), true)
           ON CONFLICT (user_id, site_id) DO UPDATE SET active = true, assigned_by = $3, assigned_at = now()
           RETURNING id, user_id, site_id, assigned_by, assigned_at, active`,
          [user_id, site_id, auth.userId]);
        return sendSuccess(res, { assignment: result.rows[0] }, 201);
      } catch (err) {
        console.error('POST /api/operator-assignments error:', err.message);
        return sendError(res, 500, err.message);
      }
    }
    if (req.method === 'PATCH') {
      const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
      if (!auth) return;
      try {
        const { id, active } = req.body || {};
        if (!id) return sendError(res, 400, 'id is required');
        const result = await db.queryAsOrg(auth.organizationId,
          `UPDATE operator_assignments SET active = $1, assigned_by = $2 WHERE id = $3 RETURNING id, user_id, site_id, active`,
          [active, auth.userId, id]);
        if (result.rows.length === 0) return sendError(res, 404, 'Assignment not found');
        return sendSuccess(res, { assignment: result.rows[0] });
      } catch (err) {
        console.error('PATCH /api/operator-assignments error:', err.message);
        return sendError(res, 500, err.message);
      }
    }
    if (req.method === 'DELETE') {
      const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
      if (!auth) return;
      try {
        const { id } = req.query;
        if (!id) return sendError(res, 400, 'id is required');
        const result = await db.queryAsOrg(auth.organizationId,
          'DELETE FROM operator_assignments WHERE id = $1 RETURNING id, user_id, site_id', [id]);
        if (result.rows.length === 0) return sendError(res, 404, 'Assignment not found');
        return sendSuccess(res, { message: 'Assignment deleted' });
      } catch (err) {
        console.error('DELETE /api/operator-assignments error:', err.message);
        return sendError(res, 500, err.message);
      }
    }
    return sendError(res, 405, 'Method Not Allowed');
  }

  // ===== OPERATORS ROUTES =====
  // Route: DELETE /api/operators/:id
  if (req.method === 'DELETE') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;
    const id = req.url.split('/').pop();
    try {
      const result = await db.query('DELETE FROM operators WHERE id = $1 RETURNING id', [id]);
      if (result.rowCount === 0) return sendError(res, 404, 'Operator not found.');
      return sendSuccess(res, { deleted: id });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // Route: GET /api/operators - list operators
  if (req.method === 'GET') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;
    try {
      const result = await db.query(
        'SELECT id, email, name, role, created_at, created_by FROM operators ORDER BY created_at DESC'
      );
      return sendSuccess(res, { operators: result.rows });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // Route: POST /api/operators - create operator
  if (req.method === 'POST') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;

    try {
      const data = createOperatorSchema.parse(req.body || {});
      const { email, name, role } = data;

      const result = await db.query(
        'INSERT INTO operators (email, name, role, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [email.toLowerCase().trim(), name.trim(), role, auth.userId]
      );
      return sendSuccess(res, { operator: result.rows[0] }, 201);
    } catch (err) {
      if (err.name === 'ZodError') {
        return sendError(res, 400, 'Validation failed',
          err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        );
      }
      if (err.code === '23505') return sendError(res, 409, 'An operator with this email already exists.');
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, 'Method not allowed.');
};
