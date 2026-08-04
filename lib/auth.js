/**
 * Better Auth — Central authentication configuration.
 *
 * This module is loaded dynamically (via import()) from the Vercel
 * serverless API routes.  It wraps better-auth so that the rest of
 * the backend never has to import it directly in CJS context.
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// We export a factory so that every cold-start gets a fresh `auth`
// server instance wired to the live DATABASE_URL.
//
// Because better-auth is ESM-first, we return a Promise that resolves
// to the `auth` object.  Callers in CJS files use:
//
//   const { auth } = await require('./lib/auth').getAuth();
//

let _authPromise = null;

/** Hash a password (sync) — used when creating users outside of BA. */
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

/** Verify a password against a hash. */
function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/**
 * Returns a Better Auth server instance.
 *
 * On first call it creates the server; subsequent calls within
 * the same warm invocation reuse it.
 */
async function getAuth() {
  if (_authPromise) return _authPromise;

  _authPromise = (async () => {
    // Dynamic ESM import for better-auth (CJS-safe in Node 18+)
    const { betterAuth } = await import('better-auth');
    const { bearer } = await import('better-auth/plugins/bearer');

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    const auth = betterAuth({
      appName: 'D&D Security Dashboard',
      // better-auth v1.x accepts a pg Pool directly — no separate adapter import needed
      database: pool,
      plugins: [bearer()],
      emailAndPassword: {
        enabled: true,
        // KLJUCNA ISPRAVKA: Better Auth po defaultu koristi scrypt za
        // hash/verify lozinki. Postojeci account.password redovi su
        // heshirani sa bcrypt (bcryptjs), pa je default scrypt parser
        // pucao sa "Invalid password hash". Ovde ga eksplicitno
        // usmeravamo na vec postojece hashPassword/verifyPassword
        // helper funkcije (bcrypt), tako da i stari i novi (buduci)
        // heshevi ostanu konzistentni.
        password: {
          hash: (password) => hashPassword(password),
          verify: ({ hash, password }) => verifyPassword(password, hash),
        },
      },
      user: {
        // KLJUCNA ISPRAVKA: modelName mora biti ovde (top-level), ne
        // unutar databaseHooks - "databaseHooks" nema modelName opciju
        // i Better Auth ga je tiho ignorisao, pa je i dalje gadjao
        // nepostojecu tabelu "user" (jednina) umesto "users".
        modelName: 'users',
        /**
         * Additional fields the app's `users` table carries beyond
         * the Better Auth defaults (id, email, emailVerified, createdAt,
         * updatedAt, name).
         */
        additionalFields: {
          organization_id: {
            type: 'string',
            required: false,
            input: false,
          },
          user_type: {
            type: 'string',
            required: false,
            input: false,
            defaultValue: 'operator',
          },
          status: {
            type: 'string',
            required: false,
            input: false,
            defaultValue: 'active',
          },
          display_name: {
            type: 'string',
            required: false,
            input: true,
          },
          last_login_at: {
            type: 'string',
            required: false,
            input: false,
          },
        },
      },
      session: {
        modelName: 'session',
      },
      account: {
        modelName: 'account',
      },
      verification: {
        modelName: 'verification',
      },
      // KLJUCNA ISPRAVKA: "signUp" hook unutar emailAndPassword NIJE
      // dokumentovana/podrzana Better Auth opcija -- tiho se ignorisao,
      // pa organization_id/user_type/status nikad nisu upisivani pri
      // registraciji. Ispravan nacin je databaseHooks.user.create.before,
      // koji vraca { data: {...} } da zameni payload pre upisa u bazu.
      databaseHooks: {
        user: {
          create: {
            before: async (user) => {
              return {
                data: {
                  ...user,
                  organization_id: user.organization_id || null,
                  user_type: user.user_type || 'org_admin',
                  status: 'active',
                },
              };
            },
          },
        },
      },
    });

    return auth;
  })();

  return _authPromise;
}

/**
 * Wraps better-auth's `toNodeHandler` so that a CJS route can mount it.
 *
 * Usage in /api/auth/[...all]/index.js:
 *
 *   const { getNodeHandler } = require('../../../lib/auth');
 *   module.exports = getNodeHandler();
 */
function getNodeHandler() {
  return async (req, res) => {
    const { toNodeHandler } = await import('better-auth/node');
    const auth = await getAuth();
    const handler = toNodeHandler(auth);
    return handler(req, res);
  };
}

/**
 * Server-side session validation — used by _auth.js instead of
 * the old Supabase JWT call.
 *
 * Accepts a Bearer token OR a cookie-based session.
 *
 * Returns `null` on failure; otherwise `{ userId, email, session }`.
 */
async function getSessionFromRequest(req) {
  const auth = await getAuth();

  // 1. Try Bearer token first (for API clients)
  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    try {
      const session = await auth.api.getSession({ headers: { authorization: `Bearer ${token}` } });
      if (session?.user) {
        return {
          userId: session.user.id,
          email: session.user.email,
          userType: session.user.user_type,
          organizationId: session.user.organization_id,
          status: session.user.status,
          session,
        };
      }
    } catch {
      // Fall through to cookie-based check
    }
  }

  // 2. Try cookie-based session (browser uses this)
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (session?.user) {
      return {
        userId: session.user.id,
        email: session.user.email,
        userType: session.user.user_type,
        organizationId: session.user.organization_id,
        status: session.user.status,
        session,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Server-side user creation (used by invite flow).
 */
async function createUser({ email, password, name, organizationId, userType }) {
  const auth = await getAuth();

  // Better Auth's sign-up endpoint normally sends a verification email.
  // For admin invite we want the user to be immediately active.
  // We create the user via the internal API directly.
  try {
    const created = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: name || email.split('@')[0],
        organizationId,
        userType: userType || 'operator',
      },
    });

    // Immediately mark email as verified (admin invite = trusted)
    if (created?.user?.id) {
      await auth.api.updateUser({
        body: {
          userId: created.user.id,
          emailVerified: true,
          status: 'active',
        },
      });
    }

    return created;
  } catch (err) {
    console.error('[auth] createUser error:', err);
    throw err;
  }
}

module.exports = {
  getAuth,
  getNodeHandler,
  getSessionFromRequest,
  createUser,
  hashPassword,
  verifyPassword,
};
