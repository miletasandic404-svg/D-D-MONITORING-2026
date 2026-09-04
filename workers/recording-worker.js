#!/usr/bin/env node
/**
 * Event-triggered recording worker (Phase 3).
 *
 * This is a standalone, always-on Node process -- NOT a Vercel
 * serverless function. It must run on a persistent host (same place
 * as the MediaMTX media server, or a separate small VPS/container),
 * for the same reason the media server itself can't live on Vercel:
 * it needs to hold an open connection (here, Postgres LISTEN, plus a
 * live ffmpeg subprocess per recording) for longer than a serverless
 * function's request lifetime allows.
 *
 * Flow:
 *   1. LISTEN on the `new_camera_event` Postgres channel (see
 *      db/migrations/004_snapshots_recordings.sql for the trigger that
 *      fires this on every new `events` row).
 *   2. On notification, look up the camera. If recording_mode is 'off',
 *      skip. Otherwise insert a `recordings` row (status=recording) and
 *      run ffmpeg against the camera's RTSP source for
 *      RECORDING_DURATION_SECONDS.
 *   3. On success, upload the resulting file to object storage and
 *      mark the row completed (with retention_expires_at based on the
 *      camera's retention_days). On failure, mark it failed.
 *
 * Uses queryAsPlatformAdmin (Phase 6 RLS bypass) throughout: this
 * worker reacts to events from ANY organization's cameras, not one
 * tenant's -- there is no single auth.organizationId to scope it to.
 * It's a trusted background process, not a user-facing request.
 *
 * Run with:  node workers/recording-worker.js
 * Required env: DATABASE_URL, STORAGE_* (see api/_storage.js), and
 * ffmpeg must be installed on the host.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const db = require('../db/index');
const { uploadObject, getBackend } = require('../lib/_storage');
const { assertSafeTarget } = require('../lib/_network_security');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('worker-recording-worker');

initSentry();

const RECORDING_DURATION_SECONDS = parseInt(process.env.RECORDING_DURATION_SECONDS || '15', 10);

async function recordSegment(rtspUrl, outputPath, durationSeconds) {
  // SSRF guard (shared infrastructure -- Fly/VPS, NOT a tenant laptop):
  // only public hosts may be reached. Private/loopback/link-local/
  // metadata (169.254.169.254) addresses are rejected so an attacker-
  // controlled rtsp_url cannot probe the internal network.
  await assertSafeTarget(rtspUrl, { allowPrivate: process.env.ALLOW_PRIVATE_NETWORK === 'true' });
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-t', String(durationSeconds),
      '-c', 'copy',
      outputPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function handleEvent(payload) {
  const { camera_id: cameraId, event_id: eventId, organization_id: organizationId } = payload;
  logger.info('Handling camera event', { event_id: eventId, camera_id: cameraId, organization_id: organizationId });

  const cameraResult = await db.queryAsPlatformAdmin(
    'SELECT rtsp_url, recording_mode, retention_days FROM cameras WHERE id = $1 AND organization_id = $2',
    [cameraId, organizationId],
  );
  if (cameraResult.rows.length === 0) {
    logger.warn('Camera not found or organization mismatch', { camera_id: cameraId, organization_id: organizationId });
    return;
  }
  const camera = cameraResult.rows[0];
  if (camera.recording_mode === 'off') {
    logger.info('Camera recording mode is off', { camera_id: cameraId });
    return;
  }
  if (!camera.rtsp_url) {
    logger.warn('Camera has no RTSP URL', { camera_id: cameraId });
    return;
  }

  const startTime = new Date();
  const recordingRow = await db.queryAsPlatformAdmin(
    `INSERT INTO recordings (camera_id, organization_id, event_id, start_time, trigger_reason, status)
     VALUES ($1, $2, $3, $4, 'event', 'recording')
     RETURNING id`,
    [cameraId, organizationId, eventId, startTime],
  );
  const recordingId = recordingRow.rows[0].id;

  const tempFile = path.join(os.tmpdir(), `recording-${recordingId}.mp4`);

  try {
    await recordSegment(camera.rtsp_url, tempFile, RECORDING_DURATION_SECONDS);

    const stats = fs.statSync(tempFile);
    const fileBuffer = fs.readFileSync(tempFile);
    const key = `recordings/${organizationId}/${cameraId}/${recordingId}.mp4`;
    const storageUrl = await uploadObject({ key, body: fileBuffer, contentType: 'video/mp4' });

    const endTime = new Date();
    const retentionExpiresAt = new Date(endTime.getTime() + camera.retention_days * 24 * 60 * 60 * 1000);

    await db.queryAsPlatformAdmin(
      `UPDATE recordings
       SET status = 'completed', end_time = $2, duration_seconds = $3,
           size_bytes = $4, storage_url = $5, retention_expires_at = $6
       WHERE id = $1`,
      [recordingId, endTime, Math.round((endTime - startTime) / 1000), stats.size, storageUrl, retentionExpiresAt],
    );
    logger.info('Recording completed', { recording_id: recordingId, size_bytes: stats.size, storage_url: storageUrl });
  } catch (err) {
    logger.error('Recording failed', { recording_id: recordingId, error: err.message });
    Sentry.captureException(err);
    await db.queryAsPlatformAdmin(`UPDATE recordings SET status = 'failed', end_time = now() WHERE id = $1`, [recordingId]);
  } finally {
    fs.promises.unlink(tempFile).catch(() => {});
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is not set. Exiting.');
    process.exit(1);
  }

  let listenClient = null;
  let listenRetryDelay = 1000;

  async function connectListener() {
    const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
    listenClient = new Client({ connectionString: directUrl });
    await listenClient.connect();
    await listenClient.query('LISTEN new_camera_event');
    logger.info('Listening on new_camera_event channel', { backend: directUrl === process.env.DIRECT_DATABASE_URL ? 'direct' : 'pooled' });
    listenRetryDelay = 1000;
  }

  await connectListener().catch((err) => {
    logger.error('Failed to connect listener', { error: err.message });
    Sentry.captureException(err);
    process.exit(1);
  });

  listenClient.on('notification', (msg) => {
    let payload;
    try {
      payload = JSON.parse(msg.payload);
    } catch {
      logger.error('Could not parse notification payload', { payload: msg.payload });
      return;
    }
    handleEvent(payload).catch((err) => {
      logger.error('Unhandled error processing event', { error: err.message });
      Sentry.captureException(err);
    });
  });

  listenClient.on('error', (err) => {
    logger.error('Listener connection error, will reconnect', { error: err.message });
    Sentry.captureException(err);
    setTimeout(async () => {
      try {
        await connectListener();
      } catch (reconnectErr) {
        logger.error('Listener reconnection failed', { error: reconnectErr.message });
        Sentry.captureException(reconnectErr);
        process.exit(1);
      }
    }, Math.min(listenRetryDelay, 30000));
    listenRetryDelay = Math.min(listenRetryDelay * 2, 30000);
  });
}

if (require.main === module) {
  main();
}

module.exports = { handleEvent, recordSegment };
