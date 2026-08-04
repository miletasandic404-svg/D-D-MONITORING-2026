'use strict';
/**
 * Node health collector for the Camera Setup Wizard V3 health panel.
 *
 * Runs on the media node (next to MediaMTX) — the only place that can
 * truthfully answer "is MediaMTX up?" and "is the Cloudflare tunnel up?".
 * The agent writes the result onto media_nodes.health_json; the dashboard
 * reads it back via GET /api/camera-setup/node and renders the panel.
 *
 *  - mediamtx_online : local REST API (MEDIAMTX_API_URL, default :9997) responds
 *  - tunnel_online   : node's public_hls_url answers over HTTPS (tunnel up)
 */

const { request } = require('./_mediamtx_client');

const HEARTBEAT_LOOP_MS = 15000;

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

    const health = {
      mediamtx_online: mtx.ok,
      mediamtx_detail: mtx.reason ? { reason: mtx.reason } : { status: mtx.status },
      tunnel_online: tunnel.ok,
      tunnel_detail: tunnel.reason ? { reason: tunnel.reason } : { status: tunnel.status },
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

module.exports = { reportNodeHealth, checkMediamtx, checkTunnel, HEARTBEAT_LOOP_MS };
