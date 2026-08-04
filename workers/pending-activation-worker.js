#!/usr/bin/env node
'use strict';

/**
 * Pending activation worker.
 *
 * Scans payment_transactions platform-wide for records that are paid
 * but not yet activated (activation_status IN ('pending', 'failed'))
 * and whose next_activation_retry_at has elapsed, then attempts to
 * activate each one.
 *
 * This covers organisations whose activation failed transiently during
 * onboarding and were never retried because the user never returned to
 * the app — closing the gap left by the reactive per-org retry that
 * only fires when a user hits the status or onboarding/status routes.
 *
 * This is a standalone script meant to run on a schedule (cron, a
 * Vercel Cron Job, or a systemd timer) rather than as a long-running
 * process.  It does one pass and exits, matching the pattern of
 * retention-job.js.
 *
 * Uses queryAsPlatformAdmin (Phase 6 RLS bypass) to read across all
 * organisations — this is a trusted background process, not a
 * user-facing request.
 *
 * Run with: node workers/pending-activation-worker.js
 * Required env: DATABASE_URL
 */

const db = require('../db/index');
const { retryAllPendingActivations } = require('../lib/payment_service');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[pending-activation-worker] DATABASE_URL is not set. Exiting.');
    process.exit(1);
  }

  console.log('[pending-activation-worker] scanning for pending activations...');

  const results = await retryAllPendingActivations({ limit: 100 });

  const activated = results.filter((r) => r.activationStatus === 'active').length;
  const failed = results.filter((r) => r.activationStatus === 'failed').length;

  for (const r of results.filter((r) => r.activationStatus === 'failed')) {
    console.error(
      `[pending-activation-worker] payment ${r.paymentId} org ${r.organizationId}: ${r.error}`,
    );
  }

  console.log(
    `[pending-activation-worker] done: ${results.length} processed, ` +
    `${activated} activated, ${failed} still failed`,
  );

  return { total: results.length, activated, failed };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[pending-activation-worker] fatal error:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
