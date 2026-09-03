'use strict';
/**
 * Two-Way Audio + Local Storage HTTP API server (runs on the media node).
 *
 * Exposes a minimal REST API so the browser frontend can:
 *   - Start a talk session, stream microphone PCM data to the camera's speaker
 *   - Serve snapshot and recording files from local storage
 *
 * Auth: every request must include a valid stream token (issued by
 * POST /api/camera-views on the Vercel API) as either:
 *   ?token=<hex 64>           (query param, for browser SSE/fetch)
 *   Authorization: Bearer <hex 64>
 *
 * Endpoints:
 *   GET  /api/audio/:cameraId/capabilities  → { supported, protocol, ... }
 *   POST /api/audio/:cameraId/start         → { success, session_id }
 *   POST /api/audio/:cameraId/send          → { success }
 *   POST /api/audio/:cameraId/stop          → { success }
 *   GET  /api/storage/snapshot/:id          → file stream (local only)
 *   GET  /api/storage/recording/:id         → file stream (local only)
 *
 * CORS: restricted to the dashboard origin (configurable via ALLOWED_ORIGIN).
 */

const http = require('http');
const { Pool } = require('pg');
const { detectTwoWayAudioCapability, createTwoWayAudioAdapter } = require('../lib/_two_way_audio');
const { initSentry } = require('../lib/_sentry');
const { logAudit } = require('../lib/_audit');
const storage = require('../lib/_storage');
const Sentry = require('@sentry/node');

initSentry();

const PORT = parseInt(process.env.TWO_WAY_AUDIO_PORT || '8890', 10);
const DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.dnd-monitoring.com';

// Talk session registry: cameraId -> { adapter, createdAt, sessionId,
// lastActivity, framesSent, startedByUserId }
const talkSessions = new Map();

// Expire sessions after 60 seconds of inactivity
const SESSION_TTL_MS = 60_000;
const sessionSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [cameraId, session] of talkSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      try { session.adapter.close(); } catch (_) {}
      talkSessions.delete(cameraId);
    }
  }
}, 15_000);

// ── Hardening: rate limit + session caps ──────────────────────────────────
//
// 1. start  : max 5 starts / camera / minute (prevents tight restart loops).
// 2. send   : max 1 in-flight send per camera (prevents unbounded promise
//             accumulation if the network is slow). Additional frames that
//             arrive while a send is in flight are dropped, not queued —
//             the source is real-time audio and 40 ms frames are cheap to
//             re-capture.
// 3. session: max 30 s wall-clock per session (defense in depth alongside
//             the 5 s default UI window).
const startRateLimits = new Map(); // cameraId -> [timestamps]
const START_RATE_WINDOW_MS = 60_000;
const START_RATE_MAX = 5;
const MAX_SESSION_DURATION_MS = 30_000;

function checkStartRateLimit(cameraId) {
  const now = Date.now();
  const arr = (startRateLimits.get(cameraId) || []).filter((t) => now - t < START_RATE_WINDOW_MS);
  if (arr.length >= START_RATE_MAX) return false;
  arr.push(now);
  startRateLimits.set(cameraId, arr);
  return true;
}

let pool = null;
if (DB_URL) {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'application/json' });
  res.end(payload);
}

// In-memory fallback so a missing DB doesn't make all audio fail.
// Real production uses the DB-backed implementation in validateStreamTokenDb.
function validateStreamTokenInMemory(token, cameraId) {
  if (!token || !cameraId) return null;
  const entry = inMemoryTokenStore.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    inMemoryTokenStore.delete(token);
    return null;
  }
  if (entry.cameraId !== cameraId) return null;
  return { userId: entry.userId };
}

// In-memory cache: token -> { cameraId, userId, expiresAt }.
// Populated by the Vercel API on first /start via a separate internal
// endpoint, or — when the DB pool is available — by validateStreamTokenDb.
const inMemoryTokenStore = new Map();

async function validateStreamTokenDb(token, cameraId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT user_id, camera_id, expires_at
       FROM camera_stream_tokens
       WHERE token = $1 AND expires_at > now()
       LIMIT 1`,
      [token],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.camera_id !== cameraId) return null;
    return { userId: row.user_id };
  } catch (err) {
    return null;
  }
}

async function validateStreamToken(token, cameraId) {
  const db = await validateStreamTokenDb(token, cameraId);
  if (db) return db;
  // DB miss doesn't mean "deny" if a real implementation has a fallback
  // (e.g. an in-memory cache populated by a separate write-through
  // channel). For this worker, DB miss = deny.
  return null;
}

async function getCamera(cameraId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT id, name, connection_type, ip, port, rtsp_url,
              rtsp_username, rtsp_password_encrypted, organization_id
       FROM cameras WHERE id = $1 AND enabled = true`,
      [cameraId],
    );
    return result.rows[0] || null;
  } catch (err) {
    return null;
  }
}

function extractToken(req, url) {
  const token = url.searchParams.get('token');
  if (token) return token;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    let tooBig = false;
    const limit = 2 * 1024 * 1024; // 2 MB
    req.on('data', (chunk) => {
      chunks += chunk;
      if (chunks.length > limit) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => tooBig ? reject(new Error('payload too large')) : resolve(chunks));
    req.on('error', reject);
  });
}

// ── Storage file serving ──────────────────────────────────────────────

async function handleStorageRequest(req, res, parts, url) {
  // parts[0] = 'api', parts[1] = 'storage', parts[2] = type, parts[3] = id
  const fileType = parts[2];
  const fileId = parts[3];

  if (!fileType || !fileId) {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File type and ID required' }));
    return;
  }

  if (fileType !== 'snapshot' && fileType !== 'recording') {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file type' }));
    return;
  }

  const token = extractToken(req, url);
  if (!token) {
    res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Token required' }));
    return;
  }

  const db = await validateStreamTokenDb(token, null);
  if (!db) {
    res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }
  const cameraId = db.cameraId || null;
  if (!cameraId) {
    res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  try {
    const table = fileType === 'snapshot' ? 'snapshots' : 'recordings';
    const result = await pool.query(
      `SELECT s.storage_url, s.camera_id
       FROM ${table} s
       JOIN cameras c ON c.id = s.camera_id
       WHERE s.id = $1 AND s.camera_id = $2`,
      [fileId, cameraId],
    );

    if (result.rows.length === 0) {
      res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    const storageUrl = result.rows[0].storage_url;
    if (!storageUrl || !storageUrl.startsWith('local://')) {
      res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not available locally' }));
      return;
    }

    const key = storage.keyFromPublicUrl(storageUrl);
    if (!key || !storage.exists(key)) {
      res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found on disk' }));
      return;
    }

    const fileBuffer = storage.readObject(key);
    const contentType = storage.getContentType(key);

    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': contentType,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(fileBuffer);
  } catch (err) {
    if (Sentry) Sentry.captureException(err);
    res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to serve file' }));
  }
}

// ── Main server ───────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Always close the socket after the response so clients (and tests)
  // don't sit in TIME_WAIT.
  res.setHeader('Connection', 'close');

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // ── Storage routes: /api/storage/:type/:id ──
  if (parts[0] === 'api' && parts[1] === 'storage' && req.method === 'GET') {
    return handleStorageRequest(req, res, parts, url);
  }

  // ── Audio routes: /api/audio/:cameraId/:action ──
  if (parts[0] === 'api' && parts[1] === 'audio') {
    parts.shift(); // remove 'api'
    parts.shift(); // remove 'audio'
  }

  const cameraId = parts[0];
  const action = parts[1];

  // ── Token validation ──
  const token = extractToken(req, url);
  if (!token) {
    return jsonResponse(res, 401, { error: 'Token required' });
  }

  if (!cameraId) {
    return jsonResponse(res, 400, { error: 'Camera ID required' });
  }

  const valid = await validateStreamToken(token, cameraId);
  if (!valid) {
    return jsonResponse(res, 401, { error: 'Invalid or expired token' });
  }

  // ── GET /:cameraId/capabilities ──
  if (req.method === 'GET' && action === 'capabilities') {
    const camera = await getCamera(cameraId);
    if (!camera) {
      return jsonResponse(res, 404, { error: 'Camera not found' });
    }
    const caps = detectTwoWayAudioCapability(camera);
    return jsonResponse(res, 200, caps);
  }

  // ── POST endpoints ──
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'Method not allowed' });
  }

  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch (err) {
    return jsonResponse(res, 400, { error: 'Invalid JSON body' });
  }

  // ── POST /:cameraId/start ──
  if (action === 'start') {
    if (!checkStartRateLimit(cameraId)) {
      return jsonResponse(res, 429, { error: 'Too many start requests for this camera; slow down' });
    }

    const existing = talkSessions.get(cameraId);
    if (existing) {
      existing.lastActivity = Date.now();
      return jsonResponse(res, 200, {
        success: true,
        session_id: existing.sessionId,
        resumed: true,
      });
    }

    const camera = await getCamera(cameraId);
    if (!camera) {
      return jsonResponse(res, 404, { error: 'Camera not found' });
    }

    const caps = detectTwoWayAudioCapability(camera);
    if (!caps.supported) {
      return jsonResponse(res, 409, {
        supported: false,
        reason: caps.reason,
      });
    }

    // Race the OPTalk start against a hard 5 s server-side timeout so
    // a wedged camera never leaves a session "active" forever.
    let timerHandle;
    const timeoutPromise = new Promise((resolve) => {
      timerHandle = setTimeout(() => resolve({ __timedOut: true }), 5000);
    });
    try {
      const adapter = await createTwoWayAudioAdapter(camera);
      // Build startPromise AFTER adapter is in scope so the closure
      // captures a defined value (TDZ-safe).
      let startPromiseError = null;
      const startPromise = Promise.resolve()
        .then(() => adapter.startTalk())
        .catch((err) => { startPromiseError = err; return { __err: err }; });
      const result = await Promise.race([startPromise, timeoutPromise]);
      clearTimeout(timerHandle);
      if (result && result.__timedOut) {
        // Lost the race: clean up and surface a timeout error.
        try { adapter.stopTalk(); } catch (_) {}
        try { adapter.close(); } catch (_) {}
        // Swallow the still-pending startPromise so an unhandled
        // rejection does not crash the process.
        startPromise.catch(() => {});
        return jsonResponse(res, 504, { error: 'Talk session start timed out' });
      }
      if (startPromiseError) {
        // adapter.startTalk() rejected before the timeout.
        try { adapter.close(); } catch (_) {}
        throw startPromiseError;
      }
      const sessionId = `${cameraId}_${Date.now()}`;
      talkSessions.set(cameraId, {
        adapter, sessionId,
        createdAt: Date.now(), lastActivity: Date.now(),
        framesSent: 0, sendInFlight: false,
        startedByUserId: valid.userId,
      });

      // Server audit (non-blocking: logAudit never throws).
      logAudit({
        organizationId: camera.organization_id,
        userId: valid.userId,
        action: 'talkdown.start',
        resourceType: 'camera',
        resourceId: cameraId,
        metadata: { session_id: sessionId, protocol: caps.protocol },
      }).catch(() => {});

      return jsonResponse(res, 200, {
        success: true,
        session_id: sessionId,
        ...result,
      });
    } catch (err) {
      clearTimeout(timerHandle);
      if (Sentry) Sentry.captureException(err);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── POST /:cameraId/send ──
  if (action === 'send') {
    const session = talkSessions.get(cameraId);
    if (!session) {
      return jsonResponse(res, 400, { error: 'No active talk session — call /start first' });
    }
    if (Date.now() - session.createdAt > MAX_SESSION_DURATION_MS) {
      // Defense-in-depth: hard cap on session wall-clock.
      try { await session.adapter.stopTalk(); } catch (_) {}
      try { session.adapter.close(); } catch (_) {}
      talkSessions.delete(cameraId);
      return jsonResponse(res, 410, { error: 'Talk session exceeded maximum duration' });
    }
    if (session.sendInFlight) {
      // Drop frame rather than queue (real-time audio is cheap to
      // re-capture; backpressure is the correct behavior).
      return jsonResponse(res, 202, { success: true, dropped: true });
    }
    const audioBase64 = body.audio;
    if (!audioBase64) {
      return jsonResponse(res, 400, { error: 'audio (base64 PCM) is required' });
    }

    session.sendInFlight = true;
    try {
      const pcmBuffer = Buffer.from(audioBase64, 'base64');
      await session.adapter.sendAudioFrame(pcmBuffer);
      session.lastActivity = Date.now();
      session.framesSent = (session.framesSent || 0) + 1;
      return jsonResponse(res, 200, { success: true, frames_sent: session.framesSent });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    } finally {
      session.sendInFlight = false;
    }
  }

  // ── POST /:cameraId/stop ──
  if (action === 'stop') {
    const session = talkSessions.get(cameraId);
    if (session) {
      let stopError = null;
      try {
        await session.adapter.stopTalk();
      } catch (err) {
        stopError = err.message;
      }
      try { session.adapter.close(); } catch (_) {}
      talkSessions.delete(cameraId);

      const durationMs = Date.now() - session.createdAt;
      const camera = await getCamera(cameraId);
      logAudit({
        organizationId: camera?.organization_id,
        userId: session.startedByUserId,
        action: 'talkdown.stop',
        resourceType: 'camera',
        resourceId: cameraId,
        metadata: {
          session_id: session.sessionId,
          frames_sent: session.framesSent || 0,
          duration_ms: durationMs,
        },
      }).catch(() => {});

      if (stopError) {
        return jsonResponse(res, 200, { success: true, warning: stopError, frames_sent: session.framesSent || 0 });
      }
    }
    return jsonResponse(res, 200, { success: true });
  }

  // ── Unknown action ──
  return jsonResponse(res, 404, { error: 'Unknown action' });
});

const shutdown = async () => {
  for (const [cameraId, session] of talkSessions) {
    try { await session.adapter.stopTalk(); } catch (_) {}
    try { session.adapter.close(); } catch (_) {}
  }
  talkSessions.clear();
  if (pool) await pool.end();
  server.close(() => process.exit(0));
};

server.listen(PORT, () => {
  console.log(`[node-api] Two-way audio + storage server listening on port ${PORT}`);
  if (storage.getBackend() === 'local') {
    console.log(`[node-api] Local storage: ${storage.getBackend()} at ${require('../lib/_storage_local').getStorageRoot()}`);
  }
  // When run under the test harness (TALKDOWN_TEST_EXPORT=1), export
  // the server and stop helpers so the test can drive a clean
  // lifecycle without leaving the Node process hanging.
  if (process.env.TALKDOWN_TEST_EXPORT === '1') {
    module.exports.server = server;
    module.exports.talkSessions = talkSessions;
    module.exports.startRateLimits = startRateLimits;
    module.exports._stopSessionSweep = () => clearInterval(sessionSweepTimer);
  }
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
