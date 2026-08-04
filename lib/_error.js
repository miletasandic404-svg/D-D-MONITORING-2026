/**
 * Centralized Error Handler + Sentry Integration
 *
 * Provides consistent error response formatting across all API routes.
 * Captures unexpected errors via Sentry in production (when SENTRY_DSN is set).
 *
 * Usage:
 *   const { sendError, sendSuccess, tryCatch } = require('./_error');
 *
 *   // In route handler:
 *   if (!user) return sendError(res, 401, 'Unauthorized');
 *
 *   // Wrap async handlers:
 *   module.exports = tryCatch(async (req, res) => {
 *     // ... handler code
 *     res.json(sendSuccess({ data: result }));
 *   });
 */

// ── Sentry (lazy-init, only when SENTRY_DSN is set) ────────────
let Sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'production',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      beforeSend(event) {
        // Never send sensitive data
        if (event.request?.data) {
          // Redact password, token, streamToken fields
          const sensitive = ['password', 'token', 'streamToken', 'session', 'authorization', 'cookie'];
          const redact = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
              if (sensitive.some(s => key.toLowerCase().includes(s))) {
                obj[key] = '[REDACTED]';
              } else if (typeof obj[key] === 'object') {
                redact(obj[key]);
              }
            }
          };
          redact(event.request.data);
        }
        return event;
      },
    });
  }
} catch {
  // Sentry not installed or configured
}

/**
 * Report an error to Sentry (no-op if not configured).
 */
function reportError(err, req) {
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    if (req) {
      scope.setExtra('method', req.method);
      scope.setExtra('url', req.url);
      scope.setExtra('path', req.path);
      scope.setUser({ ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress });
    }
    Sentry.captureException(err);
  });
}

/**
 * Send a standardized error response.
 */
function sendError(res, statusCode = 500, message = 'Internal server error', details = null) {
  const body = { success: false, error: message };
  if (details) body.details = Array.isArray(details) ? details : [details];
  return res.status(statusCode).json(body);
}

/**
 * Send a standardized success response.
 */
function sendSuccess(res, data = {}, statusCode = 200) {
  const body = { success: true, ...data };
  return res.status(statusCode).json(body);
}

/**
 * Wrap an async route handler with try/catch for consistent error handling.
 * Catches both Zod validation errors and unexpected errors.
 * Reports unexpected errors to Sentry.
 */
function tryCatch(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      // Zod validation errors
      if (err.name === 'ZodError') {
        return sendError(res, 400, 'Validation failed',
          err.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        );
      }
      // Known HTTP errors (thrown with statusCode property)
      if (err.statusCode) {
        return sendError(res, err.statusCode, err.message);
      }
      // Unexpected errors — report to Sentry, return generic 500
      console.error(`[error] ${req.method} ${req.url}:`, err.message);
      reportError(err, req);
      return sendError(res, 500, 'Internal server error');
    }
  };
}

module.exports = { sendError, sendSuccess, tryCatch, reportError };
