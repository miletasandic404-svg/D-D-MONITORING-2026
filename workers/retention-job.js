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
const { keyFromPublicUrl } = require('../lib/_storage');

async function deleteFromStorage(key) {
  const client = new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    region: process.env.STORAGE_REGION || 'us-east-1',
    forcePathStyle: Boolean(process.env.STORAGE_ENDPOINT),
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
  await client.send(new DeleteObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }));
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[retention-job] DATABASE_URL is not set. Exiting.');
    process.exit(1);
  }

  const expired = await db.queryAsPlatformAdmin(
    `SELECT id, storage_url FROM recordings
     WHERE status = 'completed' AND retention_expires_at IS NOT NULL AND retention_expires_at < now()`,
  );

  console.log(`[retention-job] found ${expired.rows.length} expired recording(s)`);

  let deleted = 0;
  let failed = 0;

  for (const row of expired.rows) {
    try {
      const key = row.storage_url ? keyFromPublicUrl(row.storage_url) : null;
      if (key) {
        await deleteFromStorage(key);
      } else {
        console.warn(`[retention-job] recording ${row.id}: could not derive storage key from ${row.storage_url}, deleting DB row anyway`);
      }
      await db.queryAsPlatformAdmin('DELETE FROM recordings WHERE id = $1', [row.id]);
      deleted += 1;
    } catch (err) {
      console.error(`[retention-job] failed to delete recording ${row.id}:`, err.message);
      failed += 1;
    }
  }

  console.log(`[retention-job] done: ${deleted} deleted, ${failed} failed`);
  return { deleted, failed, total: expired.rows.length };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[retention-job] fatal error:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
