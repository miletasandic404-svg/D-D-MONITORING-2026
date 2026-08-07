'use strict';

/**
 * Vercel Cron Job - Recording Retention Cleanup
 *
 * Triggered by Vercel on a schedule (defined in vercel.json "crons").
 * Deletes recordings past their retention_expires_at across all
 * organizations: removes the object from storage first, then the DB row
 * (same ordering as workers/retention-job.js, whose run() is reused
 * here so there is a single source of truth for the cleanup logic).
 *
 * Security: protected by the same CRON_SECRET mechanism as the other
 * cron endpoints. Vercel automatically sends
 * "Authorization: Bearer <CRON_SECRET>" on every scheduled invocation
 * when that variable is set in the project dashboard; ad-hoc callers
 * must supply the same header.
 *
 * Required env:
 *   DATABASE_URL   - PostgreSQL connection string
 *   CRON_SECRET    - random secret (min 32 chars recommended); set in
 *                    the Vercel project dashboard under Environment Variables
 *   STORAGE_*      - S3/R2-compatible storage credentials (see api/_storage.js)
 *
 * Schedule: once daily (Hobby plan only allows daily cron jobs).
 * Method:   GET (Vercel Cron always uses GET).
 */

const crypto = require('crypto');
const { sendError, sendSuccess } = require('../_error');
const { run } = require('../../workers/retention-job');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-cron-retention');

initSentry();

function getCronSecret() {
  return String(process.env.CRON_SECRET || '').trim();
}

function isAuthorized(authHeader) {
  const secret = getCronSecret();
  if (!secret) return false;

  const expected = 'Bearer ' + secret;
  const provided = String(authHeader || '');

  // Lengths must match before timingSafeEqual comparison.
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const secret = getCronSecret();
  if (!secret) {
    logger.error('[cron-retention] CRON_SECRET is not set - endpoint disabled');
    return sendError(res, 503, 'Cron endpoint is not configured');
  }

  if (!isAuthorized(req.headers['authorization'])) {
    return sendError(res, 401, 'Unauthorized');
  }

  try {
    const result = await run();
    logger.info('Cron retention completed', result);
    return sendSuccess(res, result);
  } catch (err) {
    logger.error('[cron-retention] error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};
