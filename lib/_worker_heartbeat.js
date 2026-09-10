'use strict';

/**
 * Shared worker heartbeat registry.
 *
 * Each worker writes a small heartbeat entry to a shared JSON file.
 * reportNodeHealth() reads this file and includes per-worker status
 * (running / stale / stopped) in media_nodes.health_json.
 *
 * No DB table, no Vercel endpoint — purely local file-based coordination
 * between processes in the same media-node container/host.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || '/tmp/dnd-worker-heartbeat.json';
const STALE_THRESHOLD_MS = parseInt(process.env.WORKER_HEARTBEAT_STALE_MS || '60000', 10);

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readHeartbeats() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) return {};
    const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeHeartbeats(data) {
  try {
    ensureDir(HEARTBEAT_FILE);
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // Ignore write failures — health reporting is best-effort.
  }
}

/**
 * Record a heartbeat for a named worker.
 *
 * @param {string} name - e.g. 'camera-setup-agent'
 * @param {object} [meta] - optional { status, pid, detail }
 */
function beat(name, meta = {}) {
  const all = readHeartbeats();
  const entry = {
    name,
    pid: process.pid,
    last_seen: new Date().toISOString(),
    last_seen_ms: Date.now(),
    status: meta.status || 'running',
    detail: meta.detail || null,
  };
  all[name] = entry;
  writeHeartbeats(all);
}

/**
 * Read all worker heartbeats and classify each as running / stale / stopped.
 *
 * @returns {{ workers: Array<{name, status, last_seen, pid, detail}> }}
 */
function getWorkerStatus() {
  const all = readHeartbeats();
  const now = Date.now();
  const workers = Object.values(all).map((entry) => {
    const age = now - (entry.last_seen_ms || 0);
    let status = 'running';
    if (age > STALE_THRESHOLD_MS) {
      status = 'stale';
    }
    return {
      name: entry.name,
      status,
      last_seen: entry.last_seen,
      pid: entry.pid,
      detail: entry.detail,
      age_ms: age,
    };
  });
  return { workers };
}

module.exports = { beat, getWorkerStatus, STALE_THRESHOLD_MS };
