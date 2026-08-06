'use strict';

/**
 * Vercel Cron Job — Pending Activation Retry
 *
 * Triggered by Vercel on a schedule (defined in vercel.json "crons").
 * Scans payment_transactions platform-wide for paid records that have
 * not yet been activated (activation_status IN ('pending', 'failed'))
 * and whose next_activation_retry_at has elapsed, then attempts to
 * activate each one.
 *
 * Security: the endpoint is protected by a CRON_SECRET environment
 * variable.  Vercel automatically sends "Authorization: ******"
 * on every scheduled invocation when that variable is set in the project
 * dashboard.  Ad-hoc callers (CI smoke-tests, manual retries) must
 * supply the same header.
 *
 * Required env:
 *   DATABASE_URL   — PostgreSQL connection string
 *   CRON_SECRET    — random secret (min 32 chars recommended); set in
 *                    the Vercel project dashboard under Environment Variables
 *
 * Schedule: once daily (see "crons" in vercel.json) -- changed from
 * every-15-minutes because Vercel Hobby plan only allows daily cron
 * jobs; more frequent schedules fail deployment outright.
 * Method:   GET (Vercel Cron always uses GET)
 */

const crypto = require('crypto');
const { sendError, sendSuccess } = require('../_error');
const { retryAllPendingActivations } = require('../payment_service');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-cron-pending-activations');

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
    logger.error('[cron-pending-activations] CRON_SECRET is not set — endpoint disabled');
    return sendError(res, 503, 'Cron endpoint is not configured');
  }

  if (!isAuthorized(req.headers['authorization'])) {
    return sendError(res, 401, 'Unauthorized');
  }

  try {
    const results = await retryAllPendingActivations({ limit: 100 });

    const activated = results.filter((r) => r.activationStatus === 'active').length;
    const failed = results.filter((r) => r.activationStatus === 'failed').length;

    logger.info(
      'Cron pending activations completed',
      { processed: results.length, activated, failed }
    );

    return sendSuccess(res, {
      processed: results.length,
      activated,
      failed,
    });
  } catch (err) {
    logger.error('[cron-pending-activations] error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};
