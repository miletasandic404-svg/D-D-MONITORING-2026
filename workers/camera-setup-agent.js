// =========================================================
// Camera Setup Agent (V2 wizard executor)
//
// Runs on the media node (next to MediaMTX) — the ONLY process that can
// physically reach cameras on the user's LAN. Consumes camera_setup_tasks
// rows created by the dashboard wizard (see migration 027) and executes:
//
//   scan   -> detect own subnet, scanSubnet() for ONVIF cameras
//   onvif  -> discoverCamera() -> RTSP URL -> test -> register -> MediaMTX path
//   manual -> test provided rtsp_url -> register -> MediaMTX path
//
// Uses MEDIA_NODE_DATABASE_URL (restricted media_node_worker role) if available,
// falling back to DATABASE_URL for backwards compatibility. MEDIA_NODE_ID is
// recommended so the node claims cameras for itself.
// =========================================================

// Load .env if one exists, without assuming any fixed install path (e.g.
// C:\dnd-media). This walks up from THIS FILE'S OWN directory rather than
// process.cwd(), since cwd varies depending on how the worker is launched
// (double-clicked .bat, Task Scheduler, a shortcut with a different start-in
// folder, etc.) — so it finds the .env that sits next to start-laptop.bat
// (one level above app/) regardless of where that folder actually lives.
// If dotenv isn't installed, or no .env is found, this is a silent no-op —
// real environment variables (e.g. set directly in start-laptop.bat) still
// work exactly as before.
(function loadNearestDotEnv() {
  let dotenv;
  try {
    dotenv = require('dotenv');
  } catch {
    return; // dotenv not installed -- rely on real env vars
  }
  const fs = require('fs');
  const path = require('path');
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      const result = dotenv.config({ path: candidate });
      if (!result.error) {
        console.log(`[camera-setup] loaded env from ${candidate}`);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
})();

const { Pool } = require('pg');
const os = require('os');
const crypto = require('crypto');
const { discoverCamera, scanSubnet } = require('../lib/_onvif_client');
const { probeRtspUrl, embedCredentials } = require('../lib/_rtsp_probe');
const { rtspCommonConnector } = require('../lib/_camera_connectors');
const { addOrUpdateCameraPath, deleteCameraPath, getPathStatus } = require('../lib/_mediamtx_client');
const { reportNodeHealth, checkTunnel, HEARTBEAT_LOOP_MS } = require('../lib/_node_health');
const { encrypt, decrypt, extractCredentialsFromUrl, stripCredentialsFromUrl } = require('../lib/_crypto');
const { spawn } = require('child_process');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

initSentry();

const POLL_INTERVAL_MS = parseInt(process.env.CAMERA_SETUP_POLL_INTERVAL_MS || '3000', 10);
const MAX_TASK_AGE_MINUTES = parseInt(process.env.CAMERA_SETUP_MAX_AGE_MINUTES || '30', 10);
const STUCK_TASK_TIMEOUT_MINUTES = parseInt(process.env.CAMERA_SETUP_STUCK_TIMEOUT_MINUTES || '7', 10);
const MEDIA_NODE_ID = process.env.MEDIA_NODE_ID || null;

const WORKER_DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;

if (!WORKER_DB_URL) {
  console.error('[camera-setup] DATABASE_URL (or MEDIA_NODE_DATABASE_URL) is not set -- worker cannot start');
  process.exit(1);
}

if (!process.env.MEDIA_NODE_DATABASE_URL) {
  console.warn('[camera-setup] WARNING: MEDIA_NODE_DATABASE_URL not set — using owner role (DATABASE_URL). For production, create a restricted media_node_worker role and set MEDIA_NODE_DATABASE_URL.');
}

const pool = new Pool({ connectionString: WORKER_DB_URL, max: 2 });

const L = require('../lib/_logger');
const logger = L.makeLogger('camera-setup');

// Structured task-scoped log: always carries task_id + camera_id so failures
// are traceable end-to-end (Phase 9).
function logTask(event, task, extra = {}) {
  logger.info(event, {
    task_id: task && task.id ? task.id : null,
    mode: task && task.mode ? task.mode : null,
    camera_id: task && task.camera_id ? task.camera_id : null,
    ip: task && task.ip ? task.ip : null,
    ...extra,
  });
}

// ─── LAN helpers ─────────────────────────────────────────────────────────────

function detectSubnet() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
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

/**
 * Real RTSP verification (OPTIONS + DESCRIBE handshake) before a camera is
 * registered. Wrong credentials or an unavailable stream fail with a clear
 * error — a camera that cannot authenticate is NEVER saved.
 */
async function verifyRtsp(rtspUrl, creds, what) {
  const r = await probeRtspUrl(rtspUrl, {
    username: (creds && creds.username) || undefined,
    password: (creds && creds.password) || undefined,
    timeoutMs: 5000,
  });
  if (!r.reachable) {
    throw new Error(`${what} — RTSP unreachable at ${r.host || '?'}:${r.port || 554}${r.error ? ` (${r.error})` : ''}`);
  }
  if (r.auth_required) {
    throw new Error(`${what} — RTSP authentication failed (HTTP ${r.status}) — wrong username or password`);
  }
  if (!r.stream_available) {
    throw new Error(`${what} — RTSP stream not available at this path (HTTP ${r.status || 'no response'})`);
  }
  return r;
}

function makeCameraId() {
  return `CAM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ─── Task state ──────────────────────────────────────────────────────────────

/**
 * Run a query with app.current_org_id set from the task's organization_id.
 * Required for cameras/sites which have FORCE RLS + tenant_isolation
 * policies that check current_org_matches(organization_id).
 */
async function queryAsTaskOrg(task, text, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (task.organization_id) {
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [task.organization_id]);
    }
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function reclaimStuckTasks() {
  const result = await pool.query(
    `UPDATE camera_setup_tasks
     SET status = 'pending',
         assigned_node_id = NULL,
         updated_at = now()
     WHERE status = 'working'
       AND updated_at < now() - ($1 * interval '1 minute')`,
    [STUCK_TASK_TIMEOUT_MINUTES],
  );
  if (result.rowCount > 0) {
    logger.info('tasks.reclaimed', { count: result.rowCount, threshold_minutes: STUCK_TASK_TIMEOUT_MINUTES });
  }
  // Phase 7: abandoned pending tasks (wizard closed before the agent claimed
  // them) are cancelled and their temporary credentials are wiped.
  const abandoned = await pool.query(
    `UPDATE camera_setup_tasks
     SET status = 'cancelled', updated_at = now(),
         username = NULL, password = NULL, encrypted_credentials = NULL
     WHERE status = 'pending'
       AND created_at < now() - ($1 * interval '1 minute')
     RETURNING id`,
    [MAX_TASK_AGE_MINUTES],
  );
  if (abandoned.rowCount > 0) {
    logger.info('tasks.abandoned_cancelled', { count: abandoned.rowCount, max_age_minutes: MAX_TASK_AGE_MINUTES });
  }
  return result.rowCount;
}

async function verifyTaskOwnership(taskId) {
  const result = await pool.query(
    `SELECT 1 FROM camera_setup_tasks
     WHERE id = $1 AND status = 'working'
       AND ($2::uuid IS NULL OR assigned_node_id = $2)`,
    [taskId, MEDIA_NODE_ID],
  );
  return result.rows.length > 0;
}

async function claimNextTask() {
  const result = await pool.query(
    `UPDATE camera_setup_tasks
     SET status = 'working',
         assigned_node_id = COALESCE($1, assigned_node_id),
         updated_at = now()
     WHERE id = (
       SELECT id FROM camera_setup_tasks
       WHERE status = 'pending'
         AND created_at > now() - ($2 * interval '1 minute')
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [MEDIA_NODE_ID, MAX_TASK_AGE_MINUTES],
  );
  return result.rows[0] || null;
}

const { buildTaskStatusQuery } = require('../lib/_task_status_sql');

async function setTaskStatus(taskId, status, extra = {}) {
  const { sql, vals, rejected } = buildTaskStatusQuery(taskId, status, extra);
  for (const k of rejected) {
    console.warn(`[agent] setTaskStatus: rejecting unknown column "${k}"`);
  }
  await pool.query(sql, vals);

  // Security: clear plaintext credentials after task reaches a terminal state
  if (status === 'done' || status === 'failed') {
    await pool.query(
      `UPDATE camera_setup_tasks
       SET username = NULL, password = NULL, encrypted_credentials = NULL
       WHERE id = $1`,
      [taskId],
    );
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function insertCamera(task, rtspUrl, manufacturer, model) {
  const cameraId = makeCameraId();
  const name = (task.camera_name || '').trim()
    || [manufacturer, model].filter(Boolean).join(' ').trim()
    || `Camera ${task.ip || 'LAN'}`;

  // Strip credentials from RTSP URL and store them encrypted separately
  const { url: cleanUrl, username, password } = extractCredentialsFromUrl(rtspUrl);
  const encPassword = password ? encrypt(password) : null;

  // Use queryAsTaskOrg so FORCE RLS on cameras/sites passes tenant_isolation
  let result;
  try {
    result = await queryAsTaskOrg(task,
      `INSERT INTO cameras (id, name, rtsp_url, enabled, organization_id, site_id, media_node_id,
           rtsp_username, rtsp_password_encrypted)
       VALUES ($1, $2, $3, true, $4,
         COALESCE($5, (SELECT id FROM sites WHERE organization_id = $4 ORDER BY created_at ASC LIMIT 1)),
         $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [cameraId, name, cleanUrl, task.organization_id, task.site_id || null, MEDIA_NODE_ID,
       username || null, encPassword],
    );
  } catch (err) {
    // Phase 7: unique index uq_cameras_org_rtsp — the same RTSP source is
    // already registered in this organization.
    if (err.code === '23505') {
      throw new Error('A camera with this RTSP URL already exists in this organization');
    }
    throw err;
  }
  return result.rows[0] ? result.rows[0].id : cameraId;
}

async function registerMediaPath(cameraId, rtspUrl) {
  try {
    await addOrUpdateCameraPath(cameraId, rtspUrl);
    let state = null;
    try {
      const s = await getPathStatus(cameraId);
      state = s && (s.ready !== undefined) ? (s.ready ? 'ready' : 'registered (starts on first view)') : null;
    } catch { /* runtime status not critical */ }
    logger.info('mediamtx.path_registered', { camera_id: cameraId, state: state || null });
  } catch (err) {
    // Not fatal: camera-sync-worker re-registers the path within 60s.
    logger.warn('mediamtx.path_deferred', { camera_id: cameraId, error: err.message });
  }
}

async function runScan(task) {
  const subnet = detectSubnet();
  if (!subnet) throw new Error('Cannot detect local subnet (no private IPv4 interface on this node)');
  logTask('scan.start', task, { subnet });
  const found = await scanSubnet(subnet);
  const cameras = (found || []).map((c) => ({
    ip: c.ip || c.host || null,
    onvif_port: c.onvif_port || 80,
    manufacturer: c.manufacturer || 'Unknown',
    model: c.model || 'Unknown',
    rtsp_urls: Array.isArray(c.rtsp_urls) ? c.rtsp_urls.slice(0, 3) : [],
  }));
  logTask('scan.complete', task, { cameras: cameras.length });
  await setTaskStatus(task.id, 'done', { result: JSON.stringify({ subnet, cameras }) });
}

function getTaskCredentials(task) {
  // Try encrypted credentials first, fall back to plaintext for backwards compat
  if (task.encrypted_credentials) {
    try {
      const decoded = JSON.parse(decrypt(task.encrypted_credentials));
      return { username: decoded.username || '', password: decoded.password || '' };
    } catch { /* fall through */ }
  }
  return { username: task.username || '', password: task.password || '' };
}

async function runOnvif(task) {
  const ip = task.ip;
  if (!ip) throw new Error('Camera IP is required for ONVIF mode');
  const port = task.onvif_port || 80;
  logTask('onvif.discover', task, { ip, port });
  const creds = getTaskCredentials(task);
  const cam = await discoverCamera(ip, port, creds.username, creds.password);
  if (!cam || !Array.isArray(cam.rtsp_urls) || cam.rtsp_urls.length === 0) {
    throw new Error(`No RTSP streams found on ${ip} via ONVIF (check credentials and ONVIF port)`);
  }
  const rtspUrl = embedCredentials(cam.rtsp_urls[0], creds.username, creds.password);
  await verifyRtsp(rtspUrl, creds, `Camera ${ip}`);
  if (!await verifyTaskOwnership(task.id)) {
    throw new Error('Task was reclaimed by another node — aborting to prevent duplicate registration');
  }
  const cameraId = await insertCamera(task, rtspUrl, cam.manufacturer || '', cam.model || '');
  await registerMediaPath(cameraId, rtspUrl);
  await setTaskStatus(task.id, 'done', {
    camera_id: cameraId,
    result: JSON.stringify({
      camera_id: cameraId,
      rtsp_url: stripCredentialsFromUrl(rtspUrl),
      manufacturer: cam.manufacturer || 'Unknown',
      model: cam.model || 'Unknown',
    }),
  });
  logTask('task.done', task, { camera_id: cameraId });
}

async function runManual(task) {
  if (!task.rtsp_url) throw new Error('rtsp_url is required for manual mode');
  const creds = getTaskCredentials(task);
  const rtspUrl = embedCredentials(task.rtsp_url, creds.username, creds.password);
  await verifyRtsp(rtspUrl, creds, 'Camera');
  if (!await verifyTaskOwnership(task.id)) {
    throw new Error('Task was reclaimed by another node — aborting to prevent duplicate registration');
  }
  const cameraId = await insertCamera(task, rtspUrl, '', '');
  await registerMediaPath(cameraId, rtspUrl);
  await setTaskStatus(task.id, 'done', {
    camera_id: cameraId,
    result: JSON.stringify({ camera_id: cameraId, rtsp_url: stripCredentialsFromUrl(task.rtsp_url) }),
  });
  logTask('task.done', task, { camera_id: cameraId });
}

// ─── V3 task modes (Camera Setup Wizard V3) ─────────────────────────────────

function streamLabel(uri, index) {
  const u = String(uri || '').toLowerCase();
  if (u.includes('sub') || u.includes('_2') || u.includes('/102') || u.includes('/2')) return 'Sub stream';
  if (u.includes('main') || u.includes('_1') || u.includes('/101') || u.includes('/1')) return 'Main stream';
  return `Stream ${index + 1}`;
}

/**
 * probe — discover a camera by IP, enumerate RTSP streams (main/sub),
 * test reachability of each, and return them so the wizard can offer
 * a choice. Does NOT register anything.
 */
async function runProbe(task) {
  const ip = task.ip;
  if (!ip) throw new Error('Camera IP is required for probe mode');
  const port = task.onvif_port || 80;
  logTask('probe.start', task, { ip, port });
  const creds = getTaskCredentials(task);

  let manufacturer = 'Unknown';
  let model = 'Unknown';
  let firmware_version = null;
  let onvif_supported = false;
  let streams = [];

  // 1) ONVIF first — full discovery (manufacturer/model/streams). Each stream
  //    is then verified with a real RTSP handshake (auth + availability).
  try {
    const cam = await discoverCamera(ip, port, creds.username, creds.password);
    onvif_supported = true;
    manufacturer = cam.manufacturer || 'Unknown';
    model = cam.model || 'Unknown';
    firmware_version = cam.firmware_version || null;
    const candidates = (cam.rtsp_urls || []).map((url, i) => ({
      url: stripCredentialsFromUrl(url),
      label: streamLabel(url, i),
    }));
    for (const s of candidates) {
      const r = await probeRtspUrl(s.url, {
        username: creds.username || undefined,
        password: creds.password || undefined,
        timeoutMs: 2500,
      });
      streams.push({
        ...s,
        reachable: r.reachable,
        authenticated: r.stream_available,
        stream_available: r.stream_available,
        status: r.status,
        error: r.error || null,
        host: r.host,
        port: r.port,
      });
    }
  } catch (err) {
    logger.warn('probe.onvif_failed_fallback', { task_id: task.id, ip, error: err.message });
  }

  // 2) Fallback for cameras WITHOUT ONVIF — well-known vendor RTSP paths,
  //    each verified with a real handshake. ONVIF stays primary.
  if (streams.length === 0) {
    const fallback = await rtspCommonConnector(ip, {
      username: creds.username,
      password: creds.password,
    });
    streams = fallback.streams;
  }

  const needCredentials = streams.length === 0 ||
    streams.every((s) => s.status === 401 || s.status === 403);
  const result = {
    ip,
    onvif_port: port,
    manufacturer,
    model,
    firmware_version,
    onvif_supported,
    rtsp_reachable: streams.some((s) => s.reachable),
    streams,
    need_credentials: needCredentials,
  };
  await setTaskStatus(task.id, 'done', { result: JSON.stringify(result) });
  logTask('probe.done', task, { streams: streams.length, onvif_supported });
}

/**
 * preview — register the camera (own media node) + MediaMTX path so the
 * wizard can show a live HLS preview. If the user cancels afterwards, the
 * cleanup mode removes the camera again.
 */
async function runPreview(task) {
  if (!task.rtsp_url) throw new Error('rtsp_url is required for preview mode');
  const creds = getTaskCredentials(task);
  const rtspUrl = embedCredentials(task.rtsp_url, creds.username, creds.password);
  await verifyRtsp(rtspUrl, creds, 'Camera');
  if (!await verifyTaskOwnership(task.id)) {
    throw new Error('Task was reclaimed by another node — aborting to prevent duplicate registration');
  }
  const cameraId = await insertCamera(task, rtspUrl, '', '');
  await registerMediaPath(cameraId, rtspUrl);
  await setTaskStatus(task.id, 'done', {
    camera_id: cameraId,
    result: JSON.stringify({ camera_id: cameraId, rtsp_url: stripCredentialsFromUrl(task.rtsp_url), rtsp_ok: true }),
  });
  logTask('task.done', task, { camera_id: cameraId });
}

/**
 * cleanup — remove a wizard-registered camera + its MediaMTX path
 * (used when the user cancels the wizard before saving).
 */
async function runCleanup(task) {
  if (!task.camera_id) throw new Error('camera_id is required for cleanup mode');
  const own = MEDIA_NODE_ID;
  // Use queryAsTaskOrg for RLS on cameras (FORCE RLS + tenant_isolation)
  const del = await queryAsTaskOrg(task,
    'DELETE FROM cameras WHERE id = $1 AND ($2::uuid IS NULL OR media_node_id = $2) RETURNING id',
    [task.camera_id, own],
  );
  try {
    await deleteCameraPath(task.camera_id);
  } catch { /* path may already be gone */ }
  const removed = del.rowCount > 0;
  await setTaskStatus(task.id, 'done', {
    result: JSON.stringify({ removed, camera_id: task.camera_id }),
  });
  logTask('cleanup.done', task, { removed });
}

/**
 * start_tunnel — ask the agent to launch cloudflared on the node
 * (named tunnel via CLOUDFLARE_TUNNEL_NAME, or config-file run via
 * CLOUDFLARE_TUNNEL_CONFIG). Then re-check tunnel reachability.
 */
async function runStartTunnel(task) {
  const name = process.env.CLOUDFLARE_TUNNEL_NAME;
  const configPath = process.env.CLOUDFLARE_TUNNEL_CONFIG;
  const args = configPath
    ? ['tunnel', '--config', configPath, 'run']
    : (name ? ['tunnel', 'run', name] : null);
  if (!args) {
    throw new Error('Tunnel is not configured on this node. Set CLOUDFLARE_TUNNEL_NAME (or CLOUDFLARE_TUNNEL_CONFIG) in the media app .env, then press Start Tunnel again.');
  }
  logger.info('tunnel.launch', { task_id: task.id, command: 'cloudflared ' + args.join(' ') });
  const child = spawn('cloudflared', args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // Give the tunnel a few seconds to establish, then re-check.
  await new Promise((r) => setTimeout(r, 7000));
  const nodeRes = await pool.query('SELECT public_hls_url FROM media_nodes WHERE id = $1', [MEDIA_NODE_ID]);
  let tunnel = { ok: false, reason: 'public_hls_url not set on node' };
  if (nodeRes.rows[0] && nodeRes.rows[0].public_hls_url) {
    tunnel = await checkTunnel(nodeRes.rows[0].public_hls_url);
  }
  const result = {
    started: true,
    tunnel_online: tunnel.ok,
    detail: tunnel.reason ? { reason: tunnel.reason } : { status: tunnel.status },
  };
  await setTaskStatus(task.id, 'done', { result: JSON.stringify(result) });
  logTask('tunnel.start_requested', task, { online: tunnel.ok });
}

async function processTask(task) {
  // Phase 7: if the user cancelled this task before we executed it, abort
  // and wipe any temporary credentials — a cancelled task never registers a camera.
  const fresh = await pool.query('SELECT status FROM camera_setup_tasks WHERE id = $1', [task.id]);
  if (fresh.rows[0] && fresh.rows[0].status === 'cancelled') {
    logTask('task.cancelled_abort', task);
    await pool.query(
      `UPDATE camera_setup_tasks
       SET username = NULL, password = NULL, encrypted_credentials = NULL, updated_at = now()
       WHERE id = $1`,
      [task.id],
    );
    return;
  }
  logTask('task.claimed', task);
  try {
    if (task.mode === 'scan') return await runScan(task);
    if (task.mode === 'onvif') return await runOnvif(task);
    if (task.mode === 'manual') return await runManual(task);
    if (task.mode === 'probe') return await runProbe(task);
    if (task.mode === 'preview') return await runPreview(task);
    if (task.mode === 'cleanup') return await runCleanup(task);
    if (task.mode === 'start_tunnel') return await runStartTunnel(task);
    throw new Error(`Unknown mode: ${task.mode}`);
  } catch (err) {
    logTask('task.failed', task, { error: err.message });
    try {
      await setTaskStatus(task.id, 'failed', { error: err.message });
    } catch (statusErr) {
      logger.error('task.status_write_failed', { error: statusErr.message });
    }
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

let lastHealthAt = 0;
async function healthTick() {
  const now = Date.now();
  if (now - lastHealthAt < HEARTBEAT_LOOP_MS) return;
  lastHealthAt = now;
  const h = await reportNodeHealth(pool, MEDIA_NODE_ID);
  if (h) logger.info('health.report', { mediamtx: h.mediamtx_online, tunnel: h.tunnel_online });
}

async function main() {
  logger.info('worker.start', { poll_interval_ms: POLL_INTERVAL_MS, media_node_id: MEDIA_NODE_ID || null });
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await reclaimStuckTasks();
      const task = await claimNextTask();
      if (task) await processTask(task);
      await healthTick();
    } catch (err) {
      logger.error('worker.loop_error', { error: err.message });
      Sentry.captureException(err);
    } finally {
      busy = false;
    }
  };

  // Immediate first pass, then poll.
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('[camera-setup] Fatal error, exiting:', err);
  Sentry.captureException(err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('worker.sigterm');
  await pool.end();
  process.exit(0);
});
