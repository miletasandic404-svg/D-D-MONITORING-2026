'use strict';
/**
 * Node health collector for the Camera Setup Wizard V3 health panel and
 * Media Node monitoring (Phase 8).
 *
 * Runs on the media node (next to MediaMTX) — the only place that can
 * truthfully answer "is MediaMTX up?" and "is the Cloudflare tunnel up?".
 * The agent writes the result onto media_nodes.health_json; the dashboard
 * reads it back via GET /api/camera-setup/node and renders the panel.
 *
 *  - mediamtx_online : local REST API (MEDIAMTX_API_URL, default :9997) responds
 *  - tunnel_online   : node's public_hls_url answers over HTTPS (tunnel up)
 *  - system          : CPU %, memory, disk, uptime of the node (Phase 8)
 *  - cameras         : camera count on this node (Phase 8)
 *  - worker          : this camera-setup-agent process (Phase 8)
 *
 * No secrets are ever included — only aggregate, non-sensitive metrics.
 */

const os = require('os');
const fs = require('fs');
const { request } = require('./_mediamtx_client');

const HEARTBEAT_LOOP_MS = 15000;
const CPU_SAMPLE_MS = 400;

function mb(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

/** Sample CPU usage % over `sampleMs` (two os.cpus() deltas, async sleep). */
async function cpuUsagePercent(sampleMs = CPU_SAMPLE_MS) {
  try {
    const sample = () => {
      const cpus = os.cpus();
      const idle = cpus.reduce((s, c) => s + c.times.idle, 0);
      const total = cpus.reduce(
        (s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
        0,
      );
      return { idle, total };
    };
    const a = sample();
    await new Promise((r) => setTimeout(r, sampleMs));
    const b = sample();
    const dTotal = b.total - a.total;
    const dIdle = b.idle - a.idle;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  } catch {
    return null;
  }
}

/** Collect non-sensitive system metrics (CPU, RAM, disk, uptime). */
async function collectSystemMetrics() {
  try {
    const memory = (() => {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      return {
        total_mb: mb(total),
        free_mb: mb(free),
        used_mb: mb(used),
        usage_percent: total > 0 ? Math.round((used / total) * 100) : null,
      };
    })();

    let disk = null;
    try {
      // fs.statfs is available on Node >= 18.15 — exactly what the media
      // node runs. Disk of the process working directory (the app folder).
      const s = fs.statfsSync(process.cwd());
      const total = s.bsize * s.blocks;
      const free = s.bsize * s.bavail;
      disk = {
        total_mb: mb(total),
        free_mb: mb(free),
        used_mb: mb(total - free),
        usage_percent: total > 0 ? Math.round(((total - free) / total) * 100) : null,
      };
    } catch { /* disk stats unavailable — omit */ }

    return {
      cpu_usage_percent: await cpuUsagePercent(),
      memory,
      disk,
      uptime_seconds: Math.floor(os.uptime()),
    };
  } catch {
    return null;
  }
}

async function checkMediamtx() {
  try {
    const res = await request('GET', '/v3/config/global/get');
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function checkTunnel(publicHlsUrl) {
  if (!publicHlsUrl) return { ok: false, reason: 'node has no public_hls_url configured' };
  try {
    const res = await fetch(publicHlsUrl.replace(/\/$/, ''), {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    // Any HTTP response (even 404/401) proves the tunnel + origin are reachable.
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Collect health and persist it on the media_nodes row.
 * @param {import('pg').Pool} pool
 * @param {string} nodeId
 */
async function reportNodeHealth(pool, nodeId) {
  if (!nodeId) return null;
  try {
    const nodeRes = await pool.query('SELECT public_hls_url FROM media_nodes WHERE id = $1', [nodeId]);
    const node = nodeRes.rows[0];
    if (!node) return null;

    const mtx = await checkMediamtx();
    const tunnel = await checkTunnel(node.public_hls_url);
    const system = await collectSystemMetrics();

    // Camera count on this node (the media_node_worker role has a permissive
    // cameras policy, so the count is readable without RLS issues).
    let cameras = null;
    try {
      const camRes = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE enabled)::int AS active
         FROM cameras WHERE media_node_id = $1`,
        [nodeId],
      );
      if (camRes.rows[0]) {
        cameras = { total: camRes.rows[0].total, active: camRes.rows[0].active };
      }
    } catch { /* camera count unavailable — omit */ }

    const health = {
      mediamtx_online: mtx.ok,
      mediamtx_detail: mtx.reason ? { reason: mtx.reason } : { status: mtx.status },
      tunnel_online: tunnel.ok,
      tunnel_detail: tunnel.reason ? { reason: tunnel.reason } : { status: tunnel.status },
      system,
      cameras,
      worker: {
        alive: true,
        uptime_seconds: Math.floor(process.uptime()),
        pid: process.pid,
      },
      checked_at: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE media_nodes
       SET mediamtx_online = $1, tunnel_online = $2, health_json = $3, health_checked_at = now()
       WHERE id = $4`,
      [health.mediamtx_online, health.tunnel_online, JSON.stringify(health), nodeId],
    );
    return health;
  } catch (err) {
    console.error('[node-health] report failed:', err.message);
    return null;
  }
}

module.exports = { reportNodeHealth, checkMediamtx, checkTunnel, collectSystemMetrics, HEARTBEAT_LOOP_MS };
