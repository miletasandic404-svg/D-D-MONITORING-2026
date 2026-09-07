'use strict';

// =========================================================
// Camera Compatibility Worker
//
// Runs on the media node (next to MediaMTX) — the only place that can
// physically reach cameras on the user's LAN. Performs pre-flight
// compatibility checks before a camera is accepted as production.
//
// Modes:
//   check   - run compatibility check for a specific camera
//   scan    - check all cameras assigned to this media node
//
// Uses MEDIA_NODE_DATABASE_URL (restricted media_node_worker role) if
// available, falling back to DATABASE_URL for backwards compatibility.
// =========================================================

(function loadNearestDotEnv() {
  let dotenv;
  try {
    dotenv = require('dotenv');
  } catch {
    return;
  }
  const fs = require('fs');
  const path = require('path');
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      const result = dotenv.config({ path: candidate });
      if (!result.error) {
        console.log(`[compat] loaded env from ${candidate}`);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

const { Pool } = require('pg');
const os = require('os');
const crypto = require('crypto');
const { checkCameraCompatibility, COMPAT_TIMEOUT_MS } = require('../lib/_camera_compatibility');
const { initSentry } = require('../lib/_sentry');
const Sentry = require('@sentry/node');

initSentry();

const MEDIA_NODE_ID = process.env.MEDIA_NODE_ID || null;
const WORKER_DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;
const POLL_INTERVAL_MS = parseInt(process.env.COMPAT_POLL_INTERVAL_MS || '5000', 10);

if (!WORKER_DB_URL) {
  console.error('[compat] DATABASE_URL (or MEDIA_NODE_DATABASE_URL) is not set -- worker cannot start');
  process.exit(1);
}

const pool = new Pool({ connectionString: WORKER_DB_URL, max: 2 });

const L = require('../lib/_logger');
const logger = L.makeLogger('camera-compat');

// ── LAN helpers ─────────────────────────────────────────────────────────────

function detectSubnet() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of (ifaces[name] || [])) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const parts = iface.address.split('.').map(Number);
      const a = parts[0];
      const privateRfc1918 =
        a === 10 ||
        (a === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (a === 192 && parts[1] === 168);
      if (privateRfc1918) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      }
    }
  }
  return null;
}

// ── Database operations ─────────────────────────────────────────────────────

async function fetchCamerasForNode() {
  if (!MEDIA_NODE_ID) {
    logger.error('worker.media_node_id_missing');
    return [];
  }
  const query = `
    SELECT c.id, c.name, c.connection_type, c.ip, c.port,
           c.rtsp_url, c.rtsp_username, c.rtsp_password_encrypted,
           c.organization_id, c.enabled
    FROM cameras c
    JOIN media_nodes n ON n.id = $1
    WHERE (c.media_node_id = $1 OR c.media_node_id IS NULL)
      AND c.enabled = true
      AND (
        n.organization_id IS NULL
        OR c.organization_id = n.organization_id
      )
  `;
  const result = await pool.query(query, [MEDIA_NODE_ID]);
  return result.rows;
}

async function updateCameraCompatibility(cameraId, compatResult) {
  const query = `
    UPDATE cameras
    SET compatibility_status = $1,
        compatibility_result = $2,
        updated_at = now()
    WHERE id = $3
  `;
  await pool.query(query, [
    compatResult.overall,
    JSON.stringify(compatResult),
    cameraId,
  ]);
}

// ── Check loop ─────────────────────────────────────────────────────────────

async function checkAllCameras() {
  const cameras = await fetchCamerasForNode();
  if (cameras.length === 0) return;

  logger.info('compat.check_start', { camera_count: cameras.length });

  for (const cam of cameras) {
    try {
      const result = await checkCameraCompatibility(cam);
      await updateCameraCompatibility(cam.id, result);
      logger.info('compat.check_done', {
        camera_id: cam.id,
        overall: result.overall,
        failures: result.failures,
      });
    } catch (err) {
      logger.error('compat.check_failed', { camera_id: cam.id, error: err.message });
      try {
        await updateCameraCompatibility(cam.id, {
          overall: 'BLOCKED',
          failures: [`compat_check_error: ${err.message}`],
        });
      } catch { /* ignore */ }
    }
  }

  logger.info('compat.check_complete', { camera_count: cameras.length });
}

async function checkSingleCamera(cameraId) {
  const result = await pool.query(
    `SELECT c.id, c.name, c.connection_type, c.ip, c.port,
            c.rtsp_url, c.rtsp_username, c.rtsp_password_encrypted,
            c.organization_id, c.enabled
     FROM cameras c
     WHERE c.id = $1`,
    [cameraId],
  );

  if (result.rows.length === 0) {
    logger.error('compat.camera_not_found', { camera_id: cameraId });
    return null;
  }

  const cam = result.rows[0];
  const compatResult = await checkCameraCompatibility(cam);
  await updateCameraCompatibility(cam.id, compatResult);
  return compatResult;
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  logger.info('worker.start', {
    media_node_id: MEDIA_NODE_ID,
    poll_interval_ms: POLL_INTERVAL_MS,
  });

  // Run initial check
  await checkAllCameras();

  // Periodic re-check
  setInterval(async () => {
    try {
      await checkAllCameras();
    } catch (err) {
      logger.error('compat.loop_error', { error: err.message });
      Sentry.captureException(err);
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGTERM', () => {
    logger.info('worker.sigterm');
    pool.end().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    logger.info('worker.sigint');
    pool.end().then(() => process.exit(0));
  });
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--check') && args.length > 1) {
    const cameraId = args[args.indexOf('--check') + 1];
    checkSingleCamera(cameraId)
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    main().catch((err) => {
      logger.error('worker.fatal', { error: err.message });
      process.exit(1);
    });
  }
}

module.exports = {
  checkCameraCompatibility,
  checkAllCameras,
  checkSingleCamera,
  fetchCamerasForNode,
  updateCameraCompatibility,
  detectSubnet,
  COMPAT_TIMEOUT_MS,
};
