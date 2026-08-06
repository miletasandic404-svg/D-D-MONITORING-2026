#!/usr/bin/env node
/**
 * Media node heartbeat script (Phase 5).
 *
 * Run this alongside each MediaMTX instance so the platform's
 * media_nodes registry knows the node is alive and can route new
 * cameras to it. A node with no recent heartbeat is treated as
 * offline (see api/_media_nodes.js's HEARTBEAT_FRESHNESS_SECONDS) and
 * skipped when assigning cameras -- so a crashed/restarting node just
 * stops receiving new cameras rather than needing manual intervention.
 *
 * Required env vars:
 *   API_BASE_URL        - e.g. https://your-vercel-domain/api
 *   MEDIA_NODE_ID        - the node's id (returned when it was created
 *                          via POST /api/media-nodes)
 *   MEDIA_NODE_HEARTBEAT_SECRET - the secret returned at creation time
 *   HEARTBEAT_INTERVAL_SECONDS  - default 30
 *
 * Run with: node workers/media-node-heartbeat.js
 */

// Load .env if one exists, without assuming any fixed install path (e.g.
// C:\dnd-media). Walks up from THIS FILE'S OWN directory rather than
// process.cwd(), so it works regardless of how/where the worker is launched
// from. Silent no-op if dotenv isn't installed or no .env is found -- real
// environment variables (e.g. set directly in start-laptop.bat) still work.
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

const https = require('https');
const http = require('http');
const { URL } = require('url');
const L = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = L.makeLogger('heartbeat');

initSentry();

const API_BASE_URL = process.env.API_BASE_URL;
const MEDIA_NODE_ID = process.env.MEDIA_NODE_ID;
const HEARTBEAT_SECRET = process.env.MEDIA_NODE_HEARTBEAT_SECRET;
const INTERVAL_SECONDS = parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '30', 10);

if (!API_BASE_URL || !MEDIA_NODE_ID || !HEARTBEAT_SECRET) {
  logger.error('worker.config_missing');
  process.exit(1);
}

function sendHeartbeat() {
  const url = new URL(`${API_BASE_URL.replace(/\/$/, '')}/media-nodes/${MEDIA_NODE_ID}/heartbeat`);
  const body = JSON.stringify({ heartbeat_secret: HEARTBEAT_SECRET });
  const lib = url.protocol === 'https:' ? https : http;

  const req = lib.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        logger.info('heartbeat.ok', { at: new Date().toISOString() });
      } else {
        logger.error('heartbeat.rejected', { http_status: res.statusCode, body: data });
      }
    });
  });
  req.on('error', (err) => logger.error('heartbeat.request_failed', { error: err.message }));
  req.write(body);
  req.end();
}

logger.info('worker.start', { node_id: MEDIA_NODE_ID, interval_seconds: INTERVAL_SECONDS, api_base_url: API_BASE_URL });
sendHeartbeat();
setInterval(sendHeartbeat, INTERVAL_SECONDS * 1000);

process.on('SIGTERM', () => {
  logger.info('worker.sigterm');
  process.exit(0);
});
