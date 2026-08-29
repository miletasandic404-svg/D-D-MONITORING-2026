'use strict';

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
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

const { spawn } = require('child_process');
const { Pool } = require('pg');
const { XiongmaiDvripAdapter, DVRIP_PORT } = require('../lib/_xiongmai_dvrip');
const { XiongmaiVideoStream } = require('../lib/_xiongmai_video');
const cryptoLib = require('../lib/_crypto');
const mediamtXClient = require('../lib/_mediamtx_client');
const L = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

// Person detection worker (optional - only if available)
let personDetection = null;
try {
  personDetection = require('./person-detection-worker');
} catch (err) {
  // Person detection not available - continue without it
}

const logger = L.makeLogger('xiongmai-stream');

initSentry();

const MEDIA_NODE_ID = process.env.MEDIA_NODE_ID || null;
const WORKER_DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;
const FFMPEG_PATH = process.env.FFMPEG || 'ffmpeg';
const MEDIAMTX_RTSP_BASE = process.env.MEDIAMTX_RTSP_BASE || 'rtsp://127.0.0.1:8554';
const DISCOVERY_INTERVAL_SECONDS = parseInt(process.env.XM_DISCOVERY_INTERVAL_SECONDS || '30', 10);
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60000;
let FRAME_TIMEOUT_MS = parseInt(process.env.XM_FRAME_TIMEOUT_MS || '30000', 10);

if (!WORKER_DB_URL) {
  logger.error('worker.database_url_missing');
  process.exit(1);
}

if (!process.env.MEDIA_NODE_DATABASE_URL) {
  logger.warn('worker.owner_role_fallback');
}

const pool = new Pool({ connectionString: WORKER_DB_URL, max: 2 });

const activeStreams = new Map();

let shuttingDown = false;
let discoveryTimer = null;

function exponentialBackoff(attempt) {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function checkFfmpegAvailable() {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-version']);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => {
      resolve(code === 0 && stdout.includes('ffmpeg'));
    });
  });
}

async function fetchDvripCameras() {
  if (!MEDIA_NODE_ID) {
    logger.error('worker.media_node_id_missing');
    return [];
  }
  const query = `
    SELECT c.id, c.name, c.ip, c.port, c.rtsp_username, c.rtsp_password_encrypted
    FROM cameras c
    JOIN media_nodes n ON n.id = $1
    WHERE c.connection_type = 'dvrip'
      AND (c.media_node_id = $1 OR c.media_node_id IS NULL)
      AND c.enabled = true
      AND (
        n.organization_id IS NULL
        OR c.organization_id = n.organization_id
      )
  `;
  const result = await pool.query(query, [MEDIA_NODE_ID]);
  return result.rows;
}

async function ensureMtxPublishPath(cameraId) {
  try {
    await mediamtXClient.addOrUpdateCameraPath(cameraId, 'publisher');
    logger.info('stream.mtx_path_registered', { camera_id: cameraId });
  } catch (err) {
    logger.warn('stream.mtx_path_failed', { camera_id: cameraId, error: err.message });
  }
}

function startFfmpeg(cameraId, codec) {
  const ffmpegFormat = codec === 'h264' ? 'h264' : 'hevc';
  const rtspUrl = `${MEDIAMTX_RTSP_BASE}/${cameraId}`;
  const args = [
    '-f', ffmpegFormat,
    '-i', 'pipe:0',
    '-c:v', 'copy',
  ];
  if (codec === 'h265' || codec === 'hevc') {
    args.push('-tag:v', 'hvc1');
  }
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl);

  const proc = spawn(FFMPEG_PATH, args);

  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (data) => {
    const stderr = data.toString();
    if (stderr.includes('Error') || stderr.includes('error') || stderr.includes('Invalid')) {
      logger.warn('stream.ffmpeg_error', { camera_id: cameraId, error: stderr.trim().slice(0, 200) });
    }
  });

  proc.on('error', (err) => {
    logger.error('stream.ffmpeg_spawn_error', { camera_id: cameraId, error: err.message });
  });

  proc.on('exit', (code, signal) => {
    logger.info('stream.ffmpeg_exit', { camera_id: cameraId, code, signal });
    if (shuttingDown) return;
    const ctx = activeStreams.get(cameraId);
    if (ctx) {
      ctx.ffmpegProcess = null;
      ctx.detectedCodec = null;
      scheduleReconnect(cameraId, ctx, `ffmpeg_exit_${code}`);
    }
  });

  return proc;
}

function cleanupStream(cameraId, reason) {
  const ctx = activeStreams.get(cameraId);
  if (!ctx) return;

  logger.info('stream.cleanup', { camera_id: cameraId, reason });

  if (ctx.reconnectTimer) {
    clearTimeout(ctx.reconnectTimer);
    ctx.reconnectTimer = null;
  }

  if (ctx.frameTimer) {
    clearTimeout(ctx.frameTimer);
    ctx.frameTimer = null;
  }

  if (ctx.videoStream) {
    ctx.videoStream.stopStreaming();
    ctx.videoStream = null;
  }

  if (ctx.adapter) {
    ctx.adapter.stopKeepalive();
    if (ctx.adapter.socket && !ctx.adapter.socket.destroyed) {
      ctx.adapter.socket.destroy();
    }
    ctx.adapter = null;
  }

  if (ctx.ffmpegProcess) {
    if (!ctx.ffmpegProcess.killed) {
      ctx.ffmpegProcess.stdin.destroy();
       ctx.ffmpegProcess.kill('SIGTERM');
     }
     ctx.ffmpegProcess = null;
     ctx.detectedCodec = null;
   }

   ctx.starting = false;
   activeStreams.delete(cameraId);
 }

function scheduleReconnect(cameraId, ctx, reason) {
  if (ctx.reconnectTimer) {
    clearTimeout(ctx.reconnectTimer);
    ctx.reconnectTimer = null;
  }
  if (ctx.frameTimer) {
    clearTimeout(ctx.frameTimer);
    ctx.frameTimer = null;
  }

  if (ctx.videoStream) {
    ctx.videoStream.stopStreaming();
    ctx.videoStream = null;
  }

  if (ctx.adapter) {
    ctx.adapter.stopKeepalive();
    if (ctx.adapter.socket && !ctx.adapter.socket.destroyed) {
      ctx.adapter.socket.destroy();
    }
    ctx.adapter = null;
  }

  if (ctx.ffmpegProcess) {
    if (!ctx.ffmpegProcess.killed) {
      ctx.ffmpegProcess.stdin.destroy();
      ctx.ffmpegProcess.kill('SIGTERM');
    }
    ctx.ffmpegProcess = null;
    ctx.detectedCodec = null;
  }

  ctx.starting = false;

  const attempts = ctx.reconnectAttempts + 1;
  ctx.reconnectAttempts = attempts;

  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error('stream.reconnect_failed_max', {
      camera_id: cameraId,
      attempts,
      reason,
    });
    activeStreams.delete(cameraId);
    return;
  }

  const delay = exponentialBackoff(attempts);
  logger.info('stream.reconnect_scheduled', {
    camera_id: cameraId,
    attempt: attempts,
    delay_ms: delay,
    reason,
  });

  ctx.reconnectTimer = setTimeout(() => {
    ctx.reconnectTimer = null;
    startStreamForCamera(cameraId).catch((err) => {
      logger.error('stream.reconnect_error', { camera_id: cameraId, error: err.message });
      const c = activeStreams.get(cameraId);
      if (c) scheduleReconnect(cameraId, c, err.message);
    });
  }, delay);
}

function resetFrameTimer(cameraId, ctx) {
  if (ctx.frameTimer) {
    clearTimeout(ctx.frameTimer);
  }
  ctx.frameTimer = setTimeout(() => {
    logger.warn('stream.frame_timeout', { camera_id: cameraId });
    scheduleReconnect(cameraId, ctx, 'frame_timeout');
  }, parseInt(process.env.XM_FRAME_TIMEOUT_MS || '30000', 10));
}

async function startStreamForCamera(cameraId) {
  if (shuttingDown) return;

  let ctx = activeStreams.get(cameraId);
  // Stream is already running: just reset reconnect attempts
  if (ctx && ctx.adapter && ctx.videoStream) {
    ctx.reconnectAttempts = 0;
    return;
  }
  // Stream start is already in progress: don't start another one
  if (ctx && ctx.starting) {
    return;
  }

  ctx = {
    adapter: null,
    videoStream: null,
    ffmpegProcess: null,
    detectedCodec: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    frameTimer: null,
    lastFrameAt: 0,
    starting: true,
  };
  activeStreams.set(cameraId, ctx);

  let cam;
  try {
    const cameras = await fetchDvripCameras();
    cam = cameras.find((c) => c.id === cameraId);
  } catch (err) {
    logger.error('stream.discovery_failed', { camera_id: cameraId, error: err.message });
    ctx.starting = false;
    scheduleReconnect(cameraId, ctx, err.message);
    return;
  }

  if (!cam) {
    cleanupStream(cameraId, 'camera_removed_or_disabled');
    return;
  }

  const port = cam.port || DVRIP_PORT;
  const password = cam.rtsp_password_encrypted ? cryptoLib.decrypt(cam.rtsp_password_encrypted) : '';

  logger.info('stream.starting_auth', { camera_id: cameraId, ip: cam.ip, port });

  ctx.adapter = new XiongmaiDvripAdapter(cam.ip, port);

  let authResult;
  try {
    authResult = await ctx.adapter.authenticate(cam.rtsp_username || '', password);
  } catch (err) {
    logger.error('stream.auth_failed', { camera_id: cameraId, error: err.message });
    ctx.starting = false;
    scheduleReconnect(cameraId, ctx, err.message);
    return;
  }

  logger.info('stream.auth_success', { camera_id: cameraId, session_id: authResult.SessionId });

  await ensureMtxPublishPath(cameraId);

  ctx.videoStream = new XiongmaiVideoStream(cam.ip, port);

  try {
    await ctx.videoStream.startStreaming(
      ctx.adapter.socket,
      authResult.SessionId,
      { channel: 0, streamType: 'Main', transMode: 'TCP' },
       (frame) => {
         if (frame.kind === 'video' && frame.data) {
           ctx.lastFrameAt = Date.now();
           // Stream is now active: clear starting flag
           ctx.starting = false;
           resetFrameTimer(cameraId, ctx);

           if (frame.codec && frame.codec !== ctx.detectedCodec) {
             if (ctx.ffmpegProcess) {
               if (!ctx.ffmpegProcess.killed) {
                 ctx.ffmpegProcess.stdin.destroy();
                 ctx.ffmpegProcess.kill('SIGTERM');
               }
               ctx.ffmpegProcess = null;
             }
             ctx.detectedCodec = frame.codec;
             ctx.ffmpegProcess = startFfmpeg(cameraId, ctx.detectedCodec);
             logger.info('stream.ffmpeg_started', { camera_id: cameraId, codec: ctx.detectedCodec });
           }

           if (ctx.ffmpegProcess && !ctx.ffmpegProcess.killed && ctx.ffmpegProcess.stdin.writable) {
             ctx.ffmpegProcess.stdin.write(frame.data);
           }
         } else if (frame.kind === 'jpeg' && frame.data && personDetection) {
           // Pass JPEG frames to person detection worker (non-blocking)
           try {
             personDetection.submitFrame(cameraId, frame.data);
           } catch (err) {
             // Detection is best-effort, don't break the stream
             logger.debug('person_detection_submit_failed', { camera_id: cameraId, error: err.message });
           }
         }
       },
      (err) => {
        logger.error('stream.video_error', { camera_id: cameraId, error: err.message });
        ctx.starting = false;
        scheduleReconnect(cameraId, ctx, err.message);
      },
    );

    logger.info('stream.started', { camera_id: cameraId });
    resetFrameTimer(cameraId, ctx);
  } catch (err) {
    logger.error('stream.video_start_failed', { camera_id: cameraId, error: err.message });
    ctx.starting = false;
    scheduleReconnect(cameraId, ctx, err.message);
  }
}

async function discoverAndSync() {
  if (shuttingDown) return;

  logger.info('discovery.start');

  let cameras;
  try {
    cameras = await fetchDvripCameras();
  } catch (err) {
    logger.error('discovery.failed', { error: err.message });
    return;
  }

  const cameraIds = new Set(cameras.map((c) => c.id));

  for (const cam of cameras) {
    const existing = activeStreams.get(cam.id);
    // Stream is running normally: reset reconnect attempts
    if (existing && existing.adapter && existing.videoStream && existing.ffmpegProcess) {
      existing.reconnectAttempts = 0;
    }
    // Stream exists but is being cleaned up / reconnect is pending: don't interfere
    else if (existing && existing.reconnectTimer) {
      // reconnect is scheduled, discovery should not reset state
    }
    // Stream not running and no reconnect scheduled: start fresh
    else {
      startStreamForCamera(cam.id).catch((err) => {
        logger.error('stream.start_error', { camera_id: cam.id, error: err.message });
      });
    }
  }

  for (const [cameraId, ctx] of activeStreams) {
    if (!cameraIds.has(cameraId)) {
      cleanupStream(cameraId, 'camera_removed_from_query');
    }
  }

  logger.info('discovery.complete', { total_cameras: cameras.length });
}

async function shutdown() {
  shuttingDown = true;

  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }

  for (const [cameraId] of activeStreams) {
    cleanupStream(cameraId, 'shutdown');
  }

  await pool.end();
  logger.info('worker.shutdown_complete');
  process.exit(0);
}

async function main() {
  logger.info('worker.start', {
    media_node_id: MEDIA_NODE_ID,
    discovery_interval_seconds: DISCOVERY_INTERVAL_SECONDS,
    ffmpeg_path: FFMPEG_PATH,
  });

  const ffmpegOk = await checkFfmpegAvailable();
  if (!ffmpegOk) {
    logger.error('worker.ffmpeg_unavailable', { ffmpeg_path: FFMPEG_PATH });
    process.exit(1);
  }
  logger.info('worker.ffmpeg_available');

  await discoverAndSync();

  discoveryTimer = setInterval(() => {
    if (!shuttingDown) {
      discoverAndSync().catch((err) => {
        logger.error('discovery.unexpected', { error: err.message });
        Sentry.captureException(err);
      });
    }
  }, DISCOVERY_INTERVAL_SECONDS * 1000);

  process.on('SIGTERM', () => {
    logger.info('worker.sigterm');
    shutdown().catch(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    logger.info('worker.sigint');
    shutdown().catch(() => process.exit(0));
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('worker.fatal', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  activeStreams,
  fetchDvripCameras,
  exponentialBackoff,
  checkFfmpegAvailable,
  startFfmpeg,
  startStreamForCamera,
  discoverAndSync,
  cleanupStream,
  scheduleReconnect,
  shutdown,
  main,
  MAX_RECONNECT_ATTEMPTS,
  MAX_BACKOFF_MS,
  FRAME_TIMEOUT_MS,
};
