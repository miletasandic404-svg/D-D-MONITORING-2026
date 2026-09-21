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
const { beat } = require('../lib/_worker_heartbeat');

// Person detection worker (optional - only if available)
let personDetection = null;
try {
  personDetection = require('./person-detection-worker');
  if (personDetection.startProcessing) {
    personDetection.startProcessing();
  }
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
const WORKER_HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '15000', 10);

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
      AND c.media_node_id = $1
      AND c.enabled = true
      AND n.organization_id IS NOT NULL
      AND c.organization_id = n.organization_id
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
  const isH265Input = codec === 'h265' || codec === 'hevc';
  const args = [
    '-f', ffmpegFormat,
    '-i', 'pipe:0',
    // Audio input: G.711 A-law (8kHz, mono) from DVRIP
    '-f', 'alaw',
    '-ar', '8000',
    '-ac', '1',
    '-i', 'pipe:3',
    // Transcode H.265 to H.264 for browser compatibility (Chrome/Edge/Firefox don't support HEVC in MSE)
    // Use ultrafast preset for minimal latency, tune zerolatency for live streaming
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    // Level 4.1 supports 1920x1080@30fps (level 3.1 max is 1280x720)
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    // Audio: G.711 A-law (8kHz, mono) from DVRIP → AAC
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '44100',
    '-ac', '1',
  ];
  // No -tag:v hvc1 on H.264 output (that's HEVC tag)
  // H.264 will use avc1 tag automatically
  args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', `${MEDIAMTX_RTSP_BASE}/${cameraId}`);

  const proc = spawn(FFMPEG_PATH, args, {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });

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

  if (ctx.readyCheckInterval) {
    clearInterval(ctx.readyCheckInterval);
    ctx.readyCheckInterval = null;
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
      if (ctx.ffmpegProcess.stdin[1]) {
        ctx.ffmpegProcess.stdin[1].destroy();
      }
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
  // Reconnect already pending: preserve existing state so discovery
  // does not interfere with an in-flight reconnect timer.
  if (ctx && ctx.reconnectTimer) {
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
  const decrypted = cam.rtsp_password_encrypted
    ? cryptoLib.decrypt(cam.rtsp_password_encrypted)
    : '';
  let password = '';
  try {
    const creds = JSON.parse(decrypted);
    password = creds.password || '';
  } catch {
    password = decrypted;
  }

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

    // Step 1: Register/verify path exists in MediaMTX (config accepted)
    await ensureMtxPublishPath(cameraId);

    // Step 2: Start DVRIP/FFmpeg publisher.
    // The publisher is what makes the path ready by pushing video.
    // We do NOT require ready=true before starting the publisher
    // because the publisher is what MAKES the path ready.
    let pathRegistered = false;
    try {
      const { getPathStatus } = require('../lib/_mediamtx_client');
      const pathStatus = await getPathStatus(cameraId);
      if (!pathStatus) {
        throw new Error('MediaMTX path not registered after addOrUpdateCameraPath');
      }
      logger.info('stream.path_registered', { camera_id: cameraId });
      pathRegistered = true;
    } catch (verifyErr) {
      logger.error('stream.path_verification_failed', {
        camera_id: cameraId,
        error: verifyErr.message,
      });
    }

    if (!pathRegistered) {
      logger.warn('stream.start_blocked', { camera_id: cameraId, reason: 'MediaMTX path not registered' });
      ctx.starting = false;
      scheduleReconnect(cameraId, ctx, 'MediaMTX path not registered');
      return;
    }

    // Step 3: Start DVRIP video stream and FFmpeg publisher.
    // The publisher will make the path ready by pushing video frames.
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
          } else if (frame.kind === 'audio' && frame.data) {
            // Forward audio frames (G.711 A-law) to FFmpeg's audio stdin (pipe:3 -> FD 3)
            if (ctx.ffmpegProcess && !ctx.ffmpegProcess.killed && ctx.ffmpegProcess.stdio[3] && ctx.ffmpegProcess.stdio[3].writable) {
              try {
                ctx.ffmpegProcess.stdio[3].write(frame.data);
              } catch (e) {
                logger.debug('audio_write_failed', { camera_id: cameraId, error: e.message });
              }
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

    // Step 4: Monitor path readiness after publisher starts.
    // The FFmpeg publisher should make the path ready within a few seconds.
    // If path doesn't become ready within READY_TIMEOUT_MS, treat as failure.
    const READY_TIMEOUT_MS = parseInt(process.env.XM_READY_TIMEOUT_MS || '30000', 10);
    const readyCheckInterval = setInterval(async () => {
      const ctxCheck = activeStreams.get(cameraId);
      if (!ctxCheck || ctxCheck.starting) {
        clearInterval(readyCheckInterval);
        return;
      }
      try {
        const { getPathStatus } = require('../lib/_mediamtx_client');
        const pathStatus = await getPathStatus(cameraId);

        const hasPublisher =
          pathStatus &&
          pathStatus.online === true &&
          pathStatus.source != null &&
          pathStatus.inboundBytes > 0;

        const isReady = pathStatus && (pathStatus.ready === true || hasPublisher);

        if (isReady) {
          const mode = pathStatus && pathStatus.ready === true ? 'ready' : 'publisher';
          logger.info('stream.path_ready', { camera_id: cameraId, readiness_mode: mode });
          clearInterval(readyCheckInterval);
        }
      } catch (err) {
        logger.warn('stream.readiness_check_failed', { camera_id: cameraId, error: err.message });
      }
    }, 2000);

    // Store the interval ID so we can clean it up
    ctx.readyCheckInterval = readyCheckInterval;

    // Timeout for path readiness
    setTimeout(() => {
      clearInterval(readyCheckInterval);
      const ctxCheck = activeStreams.get(cameraId);
      if (ctxCheck && !ctxCheck.starting) {
        try {
          const { getPathStatus } = require('../lib/_mediamtx_client');
          getPathStatus(cameraId).then(pathStatus => {
            const hasPublisher =
              pathStatus &&
              pathStatus.online === true &&
              pathStatus.source != null &&
              pathStatus.inboundBytes > 0;

            const isReady = pathStatus && (pathStatus.ready === true || hasPublisher);

            if (!isReady) {
              logger.warn('stream.readiness_timeout', {
                camera_id: cameraId,
                reason: 'MediaMTX path did not become ready in time',
              });
              cleanupStream(cameraId, 'readiness_timeout');
            }
          });
        } catch (err) {
          logger.warn('stream.readiness_timeout_check_failed', { camera_id: cameraId, error: err.message });
        }
      }
    }, READY_TIMEOUT_MS);
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

  beat('xiongmai-stream-worker', { status: 'stopped' });
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

  beat('xiongmai-stream-worker', { status: 'running' });
  const heartbeatTimer = setInterval(() => {
    beat('xiongmai-stream-worker', { status: 'running' });
  }, WORKER_HEARTBEAT_INTERVAL_MS);

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
    clearInterval(heartbeatTimer);
    shutdown().catch(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    logger.info('worker.sigint');
    clearInterval(heartbeatTimer);
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
  getStreamHealth,
};

function getStreamHealth() {
  const health = {};
  for (const [cameraId, ctx] of activeStreams) {
    const hasAdapter = !!ctx.adapter;
    const hasVideoStream = !!ctx.videoStream;
    const hasFfmpeg = !!ctx.ffmpegProcess && !ctx.ffmpegProcess.killed;
    const isStarting = ctx.starting;
    const lastFrameAgo = ctx.lastFrameAt ? Date.now() - ctx.lastFrameAt : null;
    const isHealthy = hasAdapter && hasVideoStream && hasFfmpeg && !isStarting;
    health[cameraId] = {
      healthy: isHealthy,
      starting: isStarting,
      hasAdapter,
      hasVideoStream,
      hasFfmpeg,
      reconnectAttempts: ctx.reconnectAttempts,
      lastFrameMsAgo: lastFrameAgo,
      detectedCodec: ctx.detectedCodec,
    };
  }
  return health;
}
