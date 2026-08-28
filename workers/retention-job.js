#!/usr/bin/env node
/**
 * Retention job (Phase 3).
 *
 * Deletes recordings past their retention_expires_at: removes the
 * object from storage first, then the DB row -- in that order, so a
 * crash between the two leaves an orphaned storage object (cheap to
 * find and clean up later) rather than a DB row pointing at nothing.
 *
 * This is a standalone script meant to run on a schedule (cron, a
 * Vercel Cron Job hitting a thin wrapper, systemd timer, etc.) rather
 * than as a long-running process like the recording worker -- it does
 * one pass and exits, which fits Vercel Cron / any scheduler cleanly.
 *
 * Uses queryAsPlatformAdmin (Phase 6 RLS bypass) throughout: retention
 * applies across every organization's recordings, not one tenant's --
 * a trusted background process, not a user-facing request.
 *
 * Run with: node workers/retention-job.js
 * Required env: DATABASE_URL, STORAGE_* (see api/_storage.js)
 */

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../db/index');
const storage = require('../lib/_storage');
const { keyFromPublicUrl } = storage;
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('worker-retention-job');

initS3Client();

let s3Client = null;

function initS3Client() {
  if (storage.getBackend() === 's3') {
    s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT || undefined,
      region: process.env.STORAGE_REGION || 'us-east-1',
      forcePathStyle: Boolean(process.env.STORAGE_ENDPOINT),
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
      },
    });
  }
}

async function deleteFromStorage(key) {
  if (storage.getBackend() === 'local') {
    return storage.deleteObject(key);
  }

  // S3 deletion
  if (!s3Client) {
    throw new Error('S3 client not initialized');
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }));
  return true;
}

async function run() {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is not set. Exiting.');
    process.exit(1);
  }

  const expired = await db.queryAsPlatformAdmin(
    `SELECT id, storage_url FROM recordings
     WHERE status = 'completed' AND retention_expires_at IS NOT NULL AND retention_expires_at < now()`,
  );

  logger.info('Found expired recordings', { count: expired.rows.length });

  let deleted = 0;
  let failed = 0;

  for (const row of expired.rows) {
    try {
      const key = row.storage_url ? keyFromPublicUrl(row.storage_url) : null;
      if (key) {
        await deleteFromStorage(key);
      } else {
        logger.warn('Could not derive storage key from URL', { recording_id: row.id, storage_url: row.storage_url });
      }
      await db.queryAsPlatformAdmin('DELETE FROM recordings WHERE id = $1', [row.id]);
      deleted += 1;
    } catch (err) {
      logger.error('Failed to delete recording', { recording_id: row.id, error: err.message });
      Sentry.captureException(err);
      failed += 1;
    }
  }

  logger.info('Retention job completed', { deleted, failed, total: expired.rows.length });
  return { deleted, failed, total: expired.rows.length };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Fatal error', { error: err.message });
      Sentry.captureException(err);
      process.exit(1);
    });
}

module.exports = { run };
