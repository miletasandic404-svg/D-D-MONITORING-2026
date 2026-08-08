let Pool;
try {
  Pool = require('pg').Pool;
} catch {
  Pool = null;
}

try {
  require('dotenv').config();
} catch {
  // dotenv not available, env vars come from host
}

const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('db-index');

initSentry();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SET LOCAL does not support parameterized placeholders ($1), so the
// org id has to be interpolated directly into the SQL text below.
// This validates it's a well-formed UUID first -- otherwise a
// malformed/attacker-controlled value could break out of the quoted
// literal (SQL injection via a session-config statement).
function assertValidUuid(value, label) {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} is not a valid UUID: ${JSON.stringify(value)}`);
  }
}

const connectionString = process.env.DATABASE_URL;
const hasDatabase = Boolean(connectionString) && Boolean(Pool);

// ── Pool configuration with timeouts ─────────────────────────────────────
const pool = hasDatabase
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,   // fail fast if Neon is unreachable
      idleTimeoutMillis: 30000,         // close idle clients after 30s
      max: 10,                          // max clients in pool
    })
  : null;

// ── Graceful pool error handling ─────────────────────────────────────────
if (pool) {
  pool.on('error', (err) => {
    logger.error('Unexpected pool error', { error: err.message });
    Sentry.captureException(err);
  });
}

/**
 * Retry a database operation on transient errors (connection refused,
 * timeout, deadlock detected).
 * Max 2 retries with exponential backoff (50ms, 200ms).
 */
async function withRetry(fn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(50 * Math.pow(2, attempt), 500);
        await new Promise(r => setTimeout(r, delay));
      }
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on transient/connection errors
      const code = err?.code || '';
      const msg = (err?.message || '').toLowerCase();
      const isTransient = code === 'ECONNRESET'
        || code === 'ECONNREFUSED'
        || code === 'ETIMEDOUT'
        || code === 'PROTOCOL_CONNECTION_LOST'
        || code === '57P01'  // admin_shutdown
        || code === '57P03'  // cannot_connect_now
        || code === '40P01'  // deadlock_detected
        || code === '40001'  // serialization_failure
        || msg.includes('timeout')
        || msg.includes('connection terminated')
        || msg.includes('connection refused')
        || msg.includes('deadlock detected');
      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }
      logger.error('Transient error', { attempt: attempt + 1, max_retries: maxRetries + 1, error: err.message });
    }
  }
  throw lastError;
}

module.exports = {
  hasDatabase,
  query: (text, params) => {
    if (!pool) {
      throw new Error('No database connection available');
    }
    return withRetry(() => pool.query(text, params));
  },

  /**
   * Runs a query with app.current_org_id set for the duration of a
   * single transaction, so the Phase 6 RLS policies (see
   * db/migrations/007_rls_audit_logs.sql) actually apply. Every API
   * route reading/writing a tenant-scoped table (cameras, events,
   * incidents, snapshots, recordings, sites, camera_view_logs,
   * notification_rules, audit_logs) should use this instead of the
   * plain `query()` above -- otherwise the request runs with no
   * app.current_org_id set, and RLS will correctly return zero rows
   * rather than silently skip enforcement.
   *
   * SET LOCAL only takes effect inside a transaction and is
   * automatically reset at COMMIT/ROLLBACK, so there's no risk of a
   * stale org id leaking to the next query on a pooled connection.
   */
  queryAsOrg: async (organizationId, text, params) => {
    if (!pool) {
      throw new Error('No database connection available');
    }
    assertValidUuid(organizationId, 'organizationId');
    return withRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_org_id = '${organizationId}'`);
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  },

  /**
   * Same mechanism, but sets app.is_platform_admin instead -- RLS
   * policies treat this as "see every organization's rows" (see
   * current_org_matches() in the migration). Only use this after
   * requireAuth has already confirmed the caller's user_type is
   * platform_admin; this helper does not check that itself.
   */
  queryAsPlatformAdmin: async (text, params) => {
    if (!pool) {
      throw new Error('No database connection available');
    }
    return withRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.is_platform_admin = 'true'`);
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  },

  transaction: async (fn) => {
    if (!pool) {
      throw new Error('No database connection available');
    }
    return withRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  },
};
