const crypto = require("crypto");
const db = require("../db/index");
const { requireAuth, getAccessibleCameraIds } = require("../lib/_auth");
const { pickMediaNodeForCamera } = require("../lib/_media_nodes");
const { addOrUpdateCameraPath, deleteCameraPath } = require("../lib/_mediamtx_client");
const { logAudit, getIp } = require("../lib/_audit");
const { z } = require("zod");
const { sendError, sendSuccess, tryCatch } = require("../lib/_error");
const { rateLimit } = require("../lib/_rate_limit");

// ─── Zod schema ──────────────────────────────────────────────────────────
const cameraSchema = z.object({
  id: z.string().min(1, "id is required").max(20).regex(/^[A-Za-z0-9_-]+$/, "id must be alphanumeric (underscore/dash allowed)"),
  name: z.string().min(1, "name is required").max(100),
  rtsp_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^rtsps?:\/\//i.test(v), {
      message: "rtsp_url must start with rtsp:// or rtsps:// (HTTP/HTTPS sources are not supported)",
    })
    .optional()
    .nullable(),
  stream_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^rtsps?:\/\//i.test(v), {
      message: "stream_url must start with rtsp:// or rtsps:// (HTTP/HTTPS sources are not supported)",
    })
    .optional()
    .nullable(),
  location: z.string().max(200).optional().nullable(),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  enabled: z.boolean().optional().default(true),
  resolution: z.string().max(20).optional().nullable(),
  fps: z.number().int().positive("fps must be a positive integer").optional().nullable(),
  codec: z.string().max(20).optional().nullable(),
  region: z.string().max(50).optional().nullable(),
});

module.exports = async (req, res) => {
  if (!rateLimit(req, res)) return;
  // ── Camera Setup Wizard (V2): create a setup task ───────────────────────
  // The wizard UI creates a task; the LOCAL camera-setup-agent on the media
  // node (the only process that can reach LAN cameras) executes it:
  // ONVIF discovery -> RTSP test -> DB registration -> MediaMTX path.
  if (req.query.path === 'setup-create') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res, { roles: ['platform_admin', 'org_admin'] });
    if (!auth) return;

    const setupSchema = z.object({
      mode: z.enum(['scan', 'onvif', 'manual', 'probe', 'preview', 'cleanup', 'start_tunnel']),
      ip: z.string().max(64).optional().nullable(),
      onvif_port: z.number().int().min(1).max(65535).optional().default(80),
      username: z.string().max(255).optional().nullable(),
      password: z.string().max(255).optional().nullable(),
      rtsp_url: z.string().max(1024).optional().nullable(),
      camera_name: z.string().max(255).optional().nullable(),
      site_id: z.string().uuid().optional().nullable(),
      camera_id: z.string().max(64).optional().nullable(),
    });

    let data;
    try {
      data = setupSchema.parse(req.body || {});
    } catch (zodErr) {
      if (zodErr instanceof z.ZodError) {
        return sendError(res, 400, 'Validation failed',
          zodErr.errors.map((e) => ({ field: e.path.join('.'), message: e.message })));
      }
      throw zodErr;
    }

    // Every mode runs on a media node (LAN access), so we require an online
    // node up front and fail with a clear, actionable message otherwise.
    const node = await pickMediaNodeForCamera({});
    if (!node) {
      return sendError(res, 409, 'No online media node is available. Start the desktop media app (it runs camera discovery on your local network), then try again.');
    }

    try {
      // Encrypt credentials at rest instead of storing plaintext
      const { encrypt, extractCredentialsFromUrl, stripCredentialsFromUrl } = require('../lib/_crypto');
      let encryptedCredentials = null;
      let cleanRtspUrl = data.rtsp_url || null;

      if (data.username || data.password) {
        encryptedCredentials = encrypt(JSON.stringify({
          username: data.username || '',
          password: data.password || '',
        }));
      } else if (data.rtsp_url) {
        // Extract credentials from RTSP URL and store encrypted
        const extracted = extractCredentialsFromUrl(data.rtsp_url);
        if (extracted.username || extracted.password) {
          encryptedCredentials = encrypt(JSON.stringify({
            username: extracted.username || '',
            password: extracted.password || '',
          }));
          cleanRtspUrl = extracted.url;
        }
      }

      // Phase 7: reject duplicate registrations (organization_id + rtsp_url)
      if (cleanRtspUrl) {
        const dup = await db.queryAsOrg(auth.organizationId,
          'SELECT 1 FROM cameras WHERE organization_id = $1 AND rtsp_url = $2 AND rtsp_url IS NOT NULL LIMIT 1',
          [auth.organizationId, cleanRtspUrl]);
        if (dup.rows.length > 0) {
          return sendError(res, 409, 'A camera with this RTSP URL already exists in your organization');
        }
      }

      const inserted = await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO camera_setup_tasks
           (organization_id, site_id, created_by, mode, ip, onvif_port, username, password, encrypted_credentials, rtsp_url, camera_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, status`,
        [auth.organizationId, data.site_id || null, auth.userId, data.mode,
         data.ip || null, data.onvif_port || 80, null, null,
         encryptedCredentials, cleanRtspUrl, data.camera_name || null],
      );
      const task = inserted.rows[0];
      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'camera_setup.create',
        resourceType: 'camera_setup_task',
        resourceId: task.id,
        ipAddress: getIp(req),
        metadata: { mode: data.mode, ip: data.ip || null },
      });
      return sendSuccess(res, {
        taskId: task.id,
        status: task.status,
        node: node ? { id: node.id, public_hls_url: node.public_hls_url } : null,
      });
    } catch (err) {
      console.error('POST /api/cameras?path=setup-create error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── POST /api/camera-setup/cancel — cancel an in-flight setup task ────────
  // Phase 7: the wizard cancels scan/probe/preview tasks when the user closes
  // it. Cancelled tasks are never claimed by the agent (only 'pending' is
  // claimed) and the agent aborts a task that turns 'cancelled' mid-flight.
  // Temporary credentials are wiped here so no orphan credentials remain.
  if (req.query.path === 'setup-cancel') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const taskId = req.body?.task_id || req.query.id;
    if (!taskId) return sendError(res, 400, 'task_id is required');
    try {
      const result = await db.queryAsOrg(auth.organizationId,
        `UPDATE camera_setup_tasks
         SET status = 'cancelled', updated_at = now(),
             username = NULL, password = NULL, encrypted_credentials = NULL
         WHERE id = $1 AND organization_id = $2
           AND status IN ('pending', 'working')
         RETURNING id, status`,
        [taskId, auth.organizationId]);
      if (result.rows.length === 0) {
        const existing = await db.queryAsOrg(auth.organizationId,
          'SELECT status FROM camera_setup_tasks WHERE id = $1 AND organization_id = $2',
          [taskId, auth.organizationId]);
        if (existing.rows.length === 0) return sendError(res, 404, 'Setup task not found');
        return sendSuccess(res, { task: existing.rows[0], already_cancelled: true });
      }
      return sendSuccess(res, { task: result.rows[0] });
    } catch (err) {
      console.error('POST /api/cameras?path=setup-cancel error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── GET /api/camera-setup/:id — poll task progress (org-scoped) ─────────
  if (req.query.path === 'setup-get') {
    if (req.method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const id = req.query.id;
    if (!id) return sendError(res, 400, 'Task id is required');
    try {
      const result = await db.queryAsOrg(
        auth.organizationId,
        `SELECT t.id, t.mode, t.ip, t.camera_name, t.status, t.assigned_node_id,
                t.result, t.error, t.camera_id, t.created_at, t.updated_at,
                n.public_hls_url AS node_hls_base_url
         FROM camera_setup_tasks t
         LEFT JOIN media_nodes n ON n.id = t.assigned_node_id
         WHERE t.id = $1 AND t.organization_id = $2`,
        [id, auth.organizationId],
      );
      if (result.rows.length === 0) return sendError(res, 404, 'Setup task not found');
      const task = result.rows[0];
      // Strip credentials from any RTSP URLs in the result JSON
      if (task.result && typeof task.result === 'object' && task.result.rtsp_url) {
        const { stripCredentialsFromUrl } = require('../lib/_crypto');
        task.result = { ...task.result, rtsp_url: stripCredentialsFromUrl(task.result.rtsp_url) };
      } else if (task.result && typeof task.result === 'string') {
        try {
          const parsed = JSON.parse(task.result);
          if (parsed.rtsp_url) {
            const { stripCredentialsFromUrl } = require('../lib/_crypto');
            parsed.rtsp_url = stripCredentialsFromUrl(parsed.rtsp_url);
            task.result = parsed;
          }
        } catch { /* leave as-is if not JSON */ }
      }
      return sendSuccess(res, { task });
    } catch (err) {
      console.error('GET /api/cameras?path=setup-get error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── GET /api/camera-setup/tasks — recent tasks for this org ─────────────
  if (req.query.path === 'setup-list') {
    if (req.method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const result = await db.queryAsOrg(
        auth.organizationId,
        `SELECT id, mode, ip, camera_name, status, error, camera_id, created_at
         FROM camera_setup_tasks
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [auth.organizationId],
      );
      return sendSuccess(res, { tasks: result.rows });
    } catch (err) {
      console.error('GET /api/cameras?path=setup-list error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── GET /api/camera-setup/node — best online node + live health ─────────
  // V3 wizard: auto-picks the media node (the user never needs to know what
  // a media node is). Returns the node plus health panel data (MediaMTX
  // online, tunnel online) reported by the local camera-setup-agent.
  if (req.query.path === 'setup-node') {
    if (req.method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const node = await pickMediaNodeForCamera({});
      if (!node) {
        return sendError(res, 409,
          'No online media node is available. Start the desktop media app on your local network (it runs camera discovery), then try again.');
      }
      const healthRes = await db.queryAsPlatformAdmin(
        `SELECT mediamtx_online, tunnel_online, health_json, health_checked_at
         FROM media_nodes WHERE id = $1`,
        [node.id],
      );
      const h = healthRes.rows[0] || null;
      let health = null;
      if (h) {
        health = h.health_json;
        if (typeof health === 'string') { try { health = JSON.parse(health); } catch { health = null; } }
      }
      return sendSuccess(res, {
        node: {
          id: node.id,
          hostname: node.hostname || node.region,
          public_hls_url: node.public_hls_url,
          capacity: node.capacity,
          current_cameras: node.current_cameras,
          online: true,
          mediamtx_online: h ? !!h.mediamtx_online : false,
          tunnel_online: h ? !!h.tunnel_online : false,
          health,
          health_checked_at: h ? h.health_checked_at : null,
        },
      });
    } catch (err) {
      console.error('GET /api/cameras?path=setup-node error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── POST /api/cameras/discover — DISABLED: cloud cannot reach LAN cameras ──
  // ONVIF discovery must run on the local media node via the task queue.
  // Use POST /api/cameras?path=setup-create with mode='onvif' instead.
  if (req.query.path === 'discover') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendError(res, 501,
      'ONVIF discovery from the cloud is not available — cloud servers cannot reach cameras on your local network. ' +
      'Use the camera setup wizard (POST /api/cameras?path=setup-create with mode=onvif), ' +
      'which dispatches discovery to your local media node.',
    );
  }

  // ── POST /api/cameras/auto-register — DISABLED: cloud cannot reach LAN cameras ──
  // Camera registration with ONVIF discovery must run on the local media node.
  // Use POST /api/cameras?path=setup-create with mode='onvif' instead.
  if (req.query.path === 'auto-register') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendError(res, 501,
      'Camera auto-registration from the cloud is not available — cloud servers cannot reach cameras on your local network. ' +
      'Use the camera setup wizard (POST /api/cameras?path=setup-create with mode=onvif), ' +
      'which dispatches discovery and registration to your local media node.',
    );
  }

  // ── POST /api/cameras/subnet-scan — DISABLED: cloud cannot scan LAN ──
  // LAN subnet scanning must run on the local media node via the task queue.
  // Use POST /api/cameras?path=setup-create with mode='scan' instead.
  if (req.query.path === 'subnet-scan') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendError(res, 501,
      'LAN subnet scanning from the cloud is not available — cloud servers cannot scan your local network. ' +
      'Use the camera setup wizard (POST /api/cameras?path=setup-create with mode=scan), ' +
      'which dispatches the scan to your local media node.',
    );
  }

  // ── GET /api/cameras/scan — DISABLED: cloud cannot scan LAN ──
  // Use POST /api/cameras?path=setup-create with mode='scan' instead.
  if (req.query.path === 'scan') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendError(res, 501,
      'LAN scanning from the cloud is not available. ' +
      'Use the camera setup wizard (POST /api/cameras?path=setup-create with mode=scan), ' +
      'which dispatches the scan to your local media node.',
    );
  }

  // ── Sites endpoint (merged to save serverless functions) ──
  if (req.query.path === 'sites') {
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;
    try {
      const result = await db.queryAsOrg(
        auth.organizationId,
        'SELECT id, name, address, created_at FROM sites WHERE organization_id = $1 ORDER BY created_at ASC'
      );
      return res.json({ sites: result.rows });
    } catch (err) {
      console.error('GET /api/sites error:', err.message);
      return res.json({ sites: [], warning: 'Database schema may need migration. Run migration 009.' });
    }
  }

  if (req.method === "GET") {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const accessibleIds = await getAccessibleCameraIds(auth);
      if (accessibleIds !== null && accessibleIds.length === 0) {
        return res.status(200).json({ success: true, count: 0, cameras: [] });
      }

      const baseSelect = `
        SELECT c.id, c.name, c.rtsp_url, c.location, c.lat, c.lng, c.enabled,
               c.resolution, c.fps, c.codec, n.public_hls_url AS hls_base_url
        FROM cameras c
        LEFT JOIN media_nodes n ON n.id = c.media_node_id`;

      const result = accessibleIds === null
        ? await db.queryAsOrg(auth.organizationId, `${baseSelect} WHERE c.organization_id = $1 ORDER BY c.id`, [auth.organizationId])
        : await db.queryAsOrg(auth.organizationId, `${baseSelect} WHERE c.organization_id = $1 AND c.id = ANY($2::varchar[]) ORDER BY c.id`,
            [auth.organizationId, accessibleIds]);
      const { stripCredentialsFromUrl } = require('../lib/_crypto');
      const cameras = result.rows.map((c) => ({
        ...c,
        rtsp_url: c.rtsp_url ? stripCredentialsFromUrl(c.rtsp_url) : c.rtsp_url,
      }));
      return res.status(200).json({ success: true, count: cameras.length, cameras });
    } catch (err) {
      console.error("GET /api/cameras error:", err.message);
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === "POST") {
    const auth = await requireAuth(req, res, { roles: ["platform_admin", "org_admin"] });
    if (!auth) return;

    try {
      let data;
      try {
        data = cameraSchema.parse(req.body || {});
      } catch (zodErr) {
        if (zodErr instanceof z.ZodError) {
          return sendError(res, 400, "Validation failed",
            zodErr.errors.map(e => ({ field: e.path.join("."), message: e.message, received: e.received }))
          );
        }
        throw zodErr;
      }

      const { id, name, rtsp_url, location, lat, lng, enabled, resolution, fps, codec, region } = data;
      // Accept stream_url as alias for rtsp_url (frontend compatibility)
      const cameraUrl = rtsp_url || req.body?.stream_url || null;

      // Strip credentials from RTSP URL and store encrypted separately
      const { extractCredentialsFromUrl, encrypt: encryptCreds } = require('../lib/_crypto');
      let cleanUrl = cameraUrl;
      let rtspUsername = null;
      let rtspPasswordEnc = null;
      if (cameraUrl) {
        const extracted = extractCredentialsFromUrl(cameraUrl);
        cleanUrl = extracted.url;
        rtspUsername = extracted.username || null;
        rtspPasswordEnc = extracted.password ? encryptCreds(extracted.password) : null;
      }

      // Phase 7: reject duplicate registrations (organization_id + rtsp_url)
      if (cleanUrl) {
        const dup = await db.queryAsOrg(auth.organizationId,
          'SELECT 1 FROM cameras WHERE organization_id = $1 AND rtsp_url = $2 AND id <> $3 LIMIT 1',
          [auth.organizationId, cleanUrl, id]);
        if (dup.rows.length > 0) {
          return sendError(res, 409, 'A camera with this RTSP URL already exists in your organization');
        }
      }

      const existing = await db.queryAsOrg(auth.organizationId, "SELECT organization_id, media_node_id, rtsp_url FROM cameras WHERE id = $1", [id]);
      if (existing.rows.length > 0 && existing.rows[0].organization_id !== auth.organizationId) {
        return sendError(res, 403, "A camera with this id belongs to a different organization");
      }

      let mediaNodeId = existing.rows[0]?.media_node_id ?? null;
      if (existing.rows.length === 0) {
        const node = await pickMediaNodeForCamera({ preferredRegion: region });
        mediaNodeId = node?.id || null;
      }

      await db.queryAsOrg(
        auth.organizationId,
        `INSERT INTO cameras (id, name, rtsp_url, location, lat, lng, enabled, resolution, fps, codec, organization_id, site_id, media_node_id,
            rtsp_username, rtsp_password_encrypted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
           COALESCE((SELECT site_id FROM cameras WHERE id = $1::VARCHAR(20)), (SELECT id FROM sites WHERE organization_id = $11 ORDER BY created_at ASC LIMIT 1)),
           $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, rtsp_url=EXCLUDED.rtsp_url, location=EXCLUDED.location,
           lat=EXCLUDED.lat, lng=EXCLUDED.lng,
           enabled=EXCLUDED.enabled, resolution=EXCLUDED.resolution, fps=EXCLUDED.fps,
           codec=EXCLUDED.codec, updated_at=now(),
           -- Preserve existing encrypted credentials when the update carries no new ones
           rtsp_username=COALESCE(EXCLUDED.rtsp_username, cameras.rtsp_username),
           rtsp_password_encrypted=COALESCE(EXCLUDED.rtsp_password_encrypted, cameras.rtsp_password_encrypted),
           media_node_id = CASE
             WHEN cameras.media_node_id IS NULL THEN EXCLUDED.media_node_id
             ELSE cameras.media_node_id
           END`,
        [id, name, cleanUrl, location || null, lat ?? null, lng ?? null, enabled, resolution || null, fps || null, codec || null, auth.organizationId, mediaNodeId, rtspUsername, rtspPasswordEnc],
      );

      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: existing.rows.length === 0 ? "camera.create" : "camera.update",
        resourceType: "camera", resourceId: id,
        metadata: { name, media_node_id: mediaNodeId },
        ipAddress: getIp(req),
      });

      // Sinhronizuj MediaMTX path SAMO ako je kamera nova ili se
      // rtsp_url stvarno promenio -- POST /v3/config/paths/add uvek
      // radi pun reload putanje, sto prekida aktivnu konekciju cak i
      // kad se salju identicni podaci (poznato MediaMTX ponasanje,
      // https://github.com/bluenviron/mediamtx/issues/5525). Obicna
      // izmena imena/lokacije kamere ne treba da prekine live stream.
      const isNewCamera = existing.rows.length === 0;
      const rtspUrlChanged = !isNewCamera && existing.rows[0].rtsp_url !== cameraUrl;
      let mediamtxSynced = true;
      if (cameraUrl && (isNewCamera || rtspUrlChanged)) {
        try {
          await addOrUpdateCameraPath(id, cameraUrl);
        } catch (mtxErr) {
          mediamtxSynced = false;
          console.error(`[mediamtx-sync] Failed to sync path for camera ${id}:`, mtxErr.message);
        }
      }

      return sendSuccess(res, { message: "Camera saved", media_node_id: mediaNodeId, mediamtx_synced: mediamtxSynced }, 201);
    } catch (err) {
      console.error("Error saving camera:", err);
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === "DELETE") {
    const auth = await requireAuth(req, res, { roles: ["platform_admin", "org_admin"] });
    if (!auth) return;

    try {
      const { id } = req.query;
      if (!id) return sendError(res, 400, "id is required");

      const result = await db.queryAsOrg(
        auth.organizationId,
        "DELETE FROM cameras WHERE id = $1 AND organization_id = $2",
        [id, auth.organizationId],
      );
      if (result.rowCount === 0) return sendError(res, 404, "Camera not found in your organization");

      await logAudit({
        organizationId: auth.organizationId,
        userId: auth.userId, action: "camera.delete",
        resourceType: "camera", resourceId: id,
        ipAddress: getIp(req),
      });

      // Ukloni MediaMTX path. NAMERNO bez state-comparison zastite
      // (za razliku od addOrUpdateCameraPath iznad) -- ovo je direktna
      // posledica eksplicitnog DELETE zahteva korisnika nad TACNO ovom
      // kamerom, ne periodicni "slepi" ciklus. Nema scenarija gde bi
      // trebalo da se preskoci: kamera je vec obrisana iz baze, pa
      // njena MediaMTX putanja uvek treba da nestane. Ne baca gresku
      // ako MediaMTX nije dostupan -- kamera je vec obrisana iz baze,
      // sto je izvor istine; osirotela MediaMTX putanja (ako ostane)
      // ce biti uklonjena pri sledecem camera-sync-worker recovery
      // ciklusu.
      try {
        await deleteCameraPath(id);
      } catch (mtxErr) {
        console.error(`[mediamtx-sync] Failed to delete path for camera ${id}:`, mtxErr.message);
      }

      return sendSuccess(res, { message: "Camera deleted" });
    } catch (err) {
      console.error("Error deleting camera:", err);
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, "Method Not Allowed");
};
