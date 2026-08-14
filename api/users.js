const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { createUser } = require('../lib/auth');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('api-users');

initSentry();


// ─── Zod schema for user invite ────────────────────────────────
const inviteSchema = z.object({
  email: z.string().email('Invalid email format'),
  user_type: z.enum(['operator', 'org_admin', 'platform_admin']).optional().default('operator'),
});

// ─── Zod schema for user update ────────────────────────────────
const updateSchema = z.object({
  id: z.string().uuid('User ID must be a valid UUID'),
  user_type: z.enum(['operator', 'org_admin', 'platform_admin']).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
});

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
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
        logger.error('GET /api/operator-assignments error', { error: err.message });
        Sentry.captureException(err);
        return sendError(res, 500, err.message);
      }
    }
    if (req.method === 'POST') {
      const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
      if (!auth) return;
      try {
        const { user_id, site_id } = req.body || {};
        if (!user_id || !site_id) return sendError(res, 400, 'user_id and site_id are required');
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
        logger.error('DELETE /api/operator-assignments error', { error: err.message });
        Sentry.captureException(err);
        return sendError(res, 500, err.message);
      }
    }
    return sendError(res, 405, 'Method Not Allowed');
  }

  // ===== OPERATORS ROUTES =====
  //
  // Security fix: the legacy `operators` table does not exist anywhere in
  // the schema (no migration ever created it), so every request against it
  // failed with HTTP 500 (`relation "operators" does not exist`). Had the
  // table existed, the old unscoped SELECT would also have leaked operator
  // records from every organization. The operator role actually lives on
  // the `users` table (user_type = 'operator'), so this endpoint is now an
  // org-scoped read over `users`: only operators of the caller's own
  // organization are ever returned. Operator creation/deletion is handled
  // by the org-scoped /api/users invite and update routes.
  if (path === 'operators') {
    if (req.method === 'GET') {
      const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
      if (!auth) return;

      if (!auth.organizationId) {
        return sendError(res, 403, 'No organization associated with your account');
      }

      try {
        const result = await db.queryAsOrg(
          auth.organizationId,
          `SELECT id, email, name, user_type AS role, status, "createdAt" AS created_at
           FROM users
           WHERE organization_id = $1
             AND user_type = 'operator'
           ORDER BY "createdAt" DESC`,
          [auth.organizationId],
        );

        return sendSuccess(res, { operators: result.rows });
      } catch (err) {
        logger.error('GET /api/operators error', { error: err.message });
        Sentry.captureException(err);
        return sendError(res, 500, err.message);
      }
    }

    return sendError(res, 405, 'Method not allowed.');
  }
  // GET - List all users
  if (req.method === 'GET') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;

    try {
      const result = await db.queryAsOrg(
        auth.organizationId,
        `SELECT id, email, name, user_type, status,
                "createdAt" AS created_at, last_login_at
         FROM users
         WHERE organization_id = $1
         ORDER BY "createdAt" DESC`,
        [auth.organizationId],
      );
      return res.json({ users: result.rows });
    } catch (dbErr) {
      logger.error('Database query failed', { error: dbErr.message });
      Sentry.captureException(dbErr);
      return sendError(res, 500, 'Failed to fetch users');
    }
  }

  // POST - Invite a new user
  if (req.method === 'POST') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;

    try {
      const data = inviteSchema.parse(req.body || {});
      const { email, user_type } = data;

      // Check if email already exists
      try {
        const existingUser = await db.query(
          'SELECT id FROM users WHERE email = $1',
          [email.toLowerCase()],
        );
        if (existingUser.rows.length > 0) {
          return sendError(res, 409, 'This email is already registered. User already exists.');
        }
      } catch (checkErr) {
        logger.error('Error checking existing user', { error: checkErr.message });
        Sentry.captureException(checkErr);
      }

      // Generate a temporary password
      const tempPassword = Array.from({ length: 16 }, () =>
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'.charAt(
          Math.floor(Math.random() * 72),
        ),
      ).join('');

      const created = await createUser({
        email,
        password: tempPassword,
        name: email.split('@')[0],
        organizationId: auth.organizationId,
        userType: user_type,
      });

      await db.queryAsOrg(
        auth.organizationId,
        `UPDATE users
         SET organization_id = $1, user_type = $2, status = 'invited'
         WHERE id = $3`,
        [auth.organizationId, user_type, created.user.id],
      );

      return sendSuccess(res, {
        user: { id: created.user.id, email: created.user.email, user_type, status: 'invited' },
        message: `User ${email} invited successfully! Password reset link sent to email.`,
      });
    } catch (err) {
      logger.error('Error inviting user', { error: err.message });
      Sentry.captureException(err);
      if (err.name === 'ZodError') {
        return sendError(res, 400, 'Validation failed',
          err.issues.map(e => ({ field: e.path.join('.'), message: e.message }))
        );
      }
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        return sendError(res, 409, 'This email is already registered.');
      }
      return sendError(res, 500, err.message);
    }
  }

  // PATCH - Update a user
  if (req.method === 'PATCH') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;

    try {
      const data = updateSchema.parse(req.body || {});

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (data.user_type) {
        updates.push('user_type = $' + paramIndex++);
        params.push(data.user_type);
      }
      if (data.status) {
        updates.push('status = $' + paramIndex++);
        params.push(data.status);
      }

      if (updates.length === 0) {
        return sendError(res, 400, 'No fields to update');
      }

      params.push(data.id);
      params.push(auth.organizationId);

      await db.queryAsOrg(
        auth.organizationId,
        'UPDATE users SET ' + updates.join(', ') + ' WHERE id = $' + (paramIndex++) + ' AND organization_id = $' + paramIndex,
        params,
      );

      return sendSuccess(res, { message: 'User updated successfully' });
    } catch (err) {
      if (err.name === 'ZodError') {
        return sendError(res, 400, 'Validation failed',
          err.issues.map(e => ({ field: e.path.join('.'), message: e.message }))
        );
      }
      logger.error('Error updating user', { error: err.message });
      Sentry.captureException(err);
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, 'Method not allowed');
};
