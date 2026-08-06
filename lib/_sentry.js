'use strict';

/**
 * Sentry initialization for production error tracking.
 *
 * This module initializes Sentry for error monitoring and performance tracking.
 * It's safe to call multiple times - Sentry handles deduplication.
 *
 * Environment variables required:
 *   SENTRY_DSN - Sentry DSN for error reporting
 *   SENTRY_ENVIRONMENT - Environment name (production, staging, development)
 */

const Sentry = require('@sentry/node');

let initialized = false;

function initSentry() {
  if (initialized) return;
  
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Sentry not configured - skip initialization
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.SENTRY_ENVIRONMENT === 'production' ? 0.1 : 0.0,
    beforeSend(event) {
      // Filter out sensitive data from events
      if (event.request) {
        // Remove sensitive headers
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });

  initialized = true;
}

module.exports = { initSentry };
