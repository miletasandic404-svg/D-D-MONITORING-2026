const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { createUser } = require('../lib/auth');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');


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
  if (!rateLimit(req, res)) return;
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
      console.error('Database query failed:', dbErr);
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
        console.error('Error checking existing user:', checkErr);
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
        message: `User ${email} invited successfully!`,
        tempPassword,
      });
    } catch (err) {
      console.error('Error inviting user:', err.message);
      if (err.name === 'ZodError') {
        return sendError(res, 400, 'Validation failed',
          err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
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
          err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        );
      }
      console.error('Error updating user:', err);
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, 'Method not allowed');
};
