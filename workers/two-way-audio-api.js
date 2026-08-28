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
const storage = require('../lib/_storage');
const Sentry = require('@sentry/node');

initSentry();

const PORT = parseInt(process.env.TWO_WAY_AUDIO_PORT || '8890', 10);
const DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.dnd-monitoring.com';

// Talk session registry: cameraId -> { adapter, createdAt, sessionId }
const talkSessions = new Map();

// Expire sessions after 60 seconds of inactivity
const SESSION_TTL_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [cameraId, session] of talkSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      try { session.adapter.close(); } catch (_) {}
      talkSessions.delete(cameraId);
    }
  }
}, 15_000);

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

async function validateStreamToken(token, cameraId) {
  if (!token || !cameraId) return false;
  if (!pool) return false;
  try {
    const result = await pool.query(
      `SELECT 1 FROM camera_stream_tokens
       WHERE token = $1 AND camera_id = $2 AND expires_at > now()
       LIMIT 1`,
      [token, cameraId],
    );
    return result.rows.length > 0;
  } catch (err) {
    return false;
  }
}

async function getCameraIdFromToken(token) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT camera_id FROM camera_stream_tokens
       WHERE token = $1 AND expires_at > now()
       LIMIT 1`,
      [token],
    );
    return result.rows[0]?.camera_id || null;
  } catch {
    return null;
  }
}

async function getCamera(cameraId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT id, name, connection_type, ip, port, rtsp_url,
              rtsp_username, rtsp_password_encrypted
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

async function handleStorageRequest(req, res, parts) {
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

  const cameraId = await getCameraIdFromToken(token);
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

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // ── Storage routes: /api/storage/:type/:id ──
  if (parts[0] === 'api' && parts[1] === 'storage' && req.method === 'GET') {
    return handleStorageRequest(req, res, parts);
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
    const existing = talkSessions.get(cameraId);
    if (existing) {
      existing.lastActivity = Date.now();
      return jsonResponse(res, 200, {
        success: true,
        session_id: existing.sessionId,
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

    try {
      const adapter = await createTwoWayAudioAdapter(camera);
      const result = await adapter.startTalk();
      const sessionId = `${cameraId}_${Date.now()}`;
      talkSessions.set(cameraId, { adapter, sessionId, createdAt: Date.now(), lastActivity: Date.now() });
      return jsonResponse(res, 200, {
        success: true,
        session_id: sessionId,
        ...result,
      });
    } catch (err) {
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

    const audioBase64 = body.audio;
    if (!audioBase64) {
      return jsonResponse(res, 400, { error: 'audio (base64 PCM) is required' });
    }

    try {
      const pcmBuffer = Buffer.from(audioBase64, 'base64');
      await session.adapter.sendAudioFrame(pcmBuffer);
      session.lastActivity = Date.now();
      return jsonResponse(res, 200, { success: true });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── POST /:cameraId/stop ──
  if (action === 'stop') {
    const session = talkSessions.get(cameraId);
    if (session) {
      try {
        await session.adapter.stopTalk();
      } catch (err) {
        // best-effort
      }
      try { session.adapter.close(); } catch (_) {}
      talkSessions.delete(cameraId);
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
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
