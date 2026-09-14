const db = require('../db/index');
const { getSessionFromRequest, hashPassword } = require('../lib/auth');

// =========================================================
// Better Auth RBAC: authenticate the request via Better Auth
// session (cookie or Bearer token), sync the user profile
// into the local `users` table, and return { userId,
// organizationId, userType } for the caller.
//
// A user without an explicit organization remains unassigned until the
// onboarding or invite flow provides a tenant. The shared default
// organization is never used as an implicit tenant.
// =========================================================

async function syncUserProfile({ userId, email, userType, organizationId }) {
  console.log('[auth] syncUserProfile:', { userId, email });

  const existing = await db.queryAsPlatformAdmin(
     'SELECT id, organization_id, user_type, status FROM users WHERE id = $1',
     [userId],
   );

   if (existing.rows.length > 0) {
      const user = existing.rows[0];
      await db.queryAsPlatformAdmin('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
      return user;
    }

   // First login without an explicit tenant stays unassigned. Onboarding
   // creates the tenant and links this profile in one transaction.
   const orgId = organizationId || null;
   const inserted = await db.queryAsPlatformAdmin(
     `INSERT INTO users (id, email, organization_id, user_type, status)
      VALUES ($1, $2, $3, $4, 'active')
      ON CONFLICT (id) DO UPDATE SET last_login_at = now()
      RETURNING id, organization_id, user_type, status`,
     [userId, email, orgId, userType || 'operator'],
   );

  return inserted.rows[0];
}

/**
 * Authenticates the request and returns the caller's profile, or sends
 * an error response and returns null.
 *
 * Usage:
 *   const auth = await requireAuth(req, res);
 *   if (!auth) return; // response already sent
 */
async function requireAuth(req, res, { roles } = {}) {
  if (!db.hasDatabase) {
    res.status(503).json({ success: false, error: 'Database not configured. Set DATABASE_URL.' });
    return null;
  }

  // Get session from Better Auth (cookie or Bearer token)
  let sessionInfo;
  try {
    sessionInfo = await getSessionFromRequest(req);
  } catch (err) {
    console.error('[auth] Session check error:', err.message);
    res.status(401).json({ success: false, error: 'Invalid or expired session' });
    return null;
  }

  if (!sessionInfo) {
    res.status(401).json({ success: false, error: 'No valid session found. Please sign in.' });
    return null;
  }

  if (sessionInfo.status !== 'active') {
    res.status(403).json({ success: false, error: 'Account is not active' });
    return null;
  }

  // Sync profile to users table
  let profile;
  try {
    profile = await syncUserProfile({
      userId: sessionInfo.userId,
      email: sessionInfo.email,
      userType: sessionInfo.userType,
      organizationId: sessionInfo.organizationId,
    });
  } catch (err) {
    console.error('[auth] Profile sync error:', err.message);
    res.status(500).json({ success: false, error: 'Profile sync failed' });
    return null;
  }

  if (roles && roles.length > 0 && !roles.includes(profile.user_type)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions for this action' });
    return null;
  }

  return {
    userId: profile.id,
    organizationId: profile.organization_id,
    userType: profile.user_type,
  };
}

/**
 * Returns the set of camera ids this caller is allowed to see, or null
 * if the caller has unrestricted access to their whole organization
 * (org_admin / platform_admin).
 */
async function getAccessibleCameraIds(auth) {
  if (auth.userType === 'org_admin' || auth.userType === 'platform_admin') {
    return null;
  }

  const { rows } = await db.queryAsOrg(
    auth.organizationId,
    `SELECT c.id
     FROM cameras c
     JOIN operator_assignments oa ON oa.site_id = c.site_id AND oa.active
     WHERE oa.user_id = $1 AND c.organization_id = $2`,
    [auth.userId, auth.organizationId],
  );
  return rows.map((r) => r.id);
}

/**
 * Throws-free check: does this caller have access to a specific camera?
 */
async function canAccessCamera(auth, cameraId) {
  const { rows } = await db.queryAsOrg(
    auth.organizationId,
    'SELECT organization_id, site_id FROM cameras WHERE id = $1',
    [cameraId],
  );
  if (rows.length === 0) return false;
  const camera = rows[0];
  if (camera.organization_id !== auth.organizationId) return false;
  if (auth.userType === 'org_admin' || auth.userType === 'platform_admin') return true;

  const assignment = await db.queryAsOrg(
    auth.organizationId,
    'SELECT 1 FROM operator_assignments WHERE user_id = $1 AND site_id = $2 AND active',
    [auth.userId, camera.site_id],
  );
  return assignment.rows.length > 0;
}

module.exports = { requireAuth, getAccessibleCameraIds, canAccessCamera };
