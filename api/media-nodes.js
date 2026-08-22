const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { generateHeartbeatSecret, HEARTBEAT_FRESHNESS_SECONDS } = require('../lib/_media_nodes');
const { logPlatformAudit, getIp } = require('../lib/_audit');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const { makeLogger } = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = makeLogger('api-media-nodes');

initSentry();


// ─── Zod schema for media node creation ─────────────────────────
const createMediaNodeSchema = z.object({
  region: z.string().min(1, 'region is required').max(50),
  hostname: z.string().min(1, 'hostname is required').max(255),
  name: z.string().min(1).max(255).optional(),
  public_hls_url: z.string().url('public_hls_url must be a valid URL').min(1, 'public_hls_url is required'),
  capacity: z.number().int().positive('capacity must be a positive integer').optional().default(50),
  // Model B: media nodes are tenant-owned. Binding a node to an org
  // restricts its camera-setup-task claiming (and camera sync) to that
  // org's tasks/cameras. Optional for backward compatibility -- nodes
  // without an org fail closed (claim nothing) until an admin assigns one.
  organization_id: z.string().uuid('organization_id must be a valid UUID').optional().nullable(),
});

// GET /api/media-nodes - list all media nodes (platform_admin only)
async function handleGetMediaNodes(req, res) {
  const auth = await requireAuth(req, res, { roles: ['platform_admin'] });
  if (!auth) return;

  try {
    const { rows } = await db.queryAsPlatformAdmin(`
      SELECT
        n.id, n.region, n.hostname, n.name, n.public_hls_url, n.capacity,
        n.organization_id, n.last_heartbeat_at, n.mediamtx_online, n.tunnel_online,
        n.health_json, n.health_checked_at,
        count(c.id)::int AS current_cameras,
        COALESCE(n.last_heartbeat_at > now() - interval '${HEARTBEAT_FRESHNESS_SECONDS} seconds', false) AS online
      FROM media_nodes n
      LEFT JOIN cameras c ON c.media_node_id = n.id
      GROUP BY n.id
      ORDER BY n.region, n.hostname
    `);
    return sendSuccess(res, { count: rows.length, nodes: rows });
  } catch (err) {
    console.error('GET /api/media-nodes error:', err.message);
    return sendError(res, 500, err.message);
  }
}

// POST /api/media-nodes - create media node
async function handlePostMediaNodes(req, res) {
  const auth = await requireAuth(req, res, { roles: ['platform_admin'] });
  if (!auth) return;

  let data;
  try {
    data = createMediaNodeSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }
  const { region, hostname, name, public_hls_url: publicHlsUrl, capacity, organization_id: organizationId } = data;

  try {
    const heartbeatSecret = generateHeartbeatSecret();
    const inserted = await db.queryAsPlatformAdmin(
      `INSERT INTO media_nodes (region, hostname, name, public_hls_url, capacity, heartbeat_secret, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, region, hostname, name, public_hls_url, capacity, organization_id`,
      [region, hostname, name || hostname, publicHlsUrl, capacity || 50, heartbeatSecret, organizationId || null],
    );
    await logPlatformAudit({
      userId: auth.userId,
      action: 'media_node.create',
      resourceType: 'media_node',
      resourceId: inserted.rows[0].id,
      metadata: { region, hostname },
      ipAddress: getIp(req),
    });
    return sendSuccess(res, { node: inserted.rows[0], heartbeat_secret: heartbeatSecret }, 201);
  } catch (err) {
    console.error('POST /api/media-nodes error:', err.message);
    return sendError(res, 500, err.message);
  }
}

// POST /api/media-nodes/heartbeat - receive heartbeat from media node
async function handlePostHeartbeat(req, res) {
  const { nodeId } = req.query || req.body || {};
  const { heartbeat_secret: providedSecret, status, region } = req.body || {};

  if (!nodeId || !providedSecret) {
    return sendError(res, 400, 'nodeId and heartbeat_secret are required');
  }

  try {
    const node = await db.queryAsPlatformAdmin(
      `SELECT id, heartbeat_secret, organization_id FROM media_nodes WHERE id = $1`,
      [nodeId],
    );

    if (node.rows.length === 0 || node.rows[0].heartbeat_secret !== providedSecret) {
      return sendError(res, 401, 'Invalid node ID or heartbeat secret');
    }

    const nodeData = node.rows[0];
    const { mediamtx_online, tunnel_online, health } = req.body || {};
    const healthJson = health ? (typeof health === 'string' ? health : JSON.stringify(health)) : null;

    // Security: if node is bound to an organization, scope the UPDATE to that org
    // This prevents cross-organization heartbeat manipulation
    if (nodeData.organization_id) {
      await db.queryAsOrg(
        nodeData.organization_id,
        `UPDATE media_nodes
         SET last_heartbeat_at = now(), status = $1, region = COALESCE($2, region),
             mediamtx_online = COALESCE($3, mediamtx_online),
             tunnel_online = COALESCE($4, tunnel_online),
             health_json = COALESCE($5::jsonb, health_json),
             health_checked_at = CASE WHEN $5::jsonb IS NOT NULL THEN now() ELSE health_checked_at END
         WHERE id = $6 AND organization_id = $7`,
        [status || 'online', region,
         mediamtx_online === undefined ? null : !!mediamtx_online,
         tunnel_online === undefined ? null : !!tunnel_online,
         healthJson, nodeId, nodeData.organization_id],
      );
    } else {
      // Unbound node (legacy): use platform admin scope
      await db.queryAsPlatformAdmin(
        `UPDATE media_nodes
         SET last_heartbeat_at = now(), status = $1, region = COALESCE($2, region),
             mediamtx_online = COALESCE($4, mediamtx_online),
             tunnel_online = COALESCE($5, tunnel_online),
             health_json = COALESCE($6::jsonb, health_json),
             health_checked_at = CASE WHEN $6::jsonb IS NOT NULL THEN now() ELSE health_checked_at END
         WHERE id = $3`,
        [status || 'online', region, nodeId,
         mediamtx_online === undefined ? null : !!mediamtx_online,
         tunnel_online === undefined ? null : !!tunnel_online,
         healthJson],
      );
    }

    return sendSuccess(res, { synced: true });
  } catch (err) {
    logger.error('POST /api/media-nodes/heartbeat error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method === 'GET') {
    return handleGetMediaNodes(req, res);
  }

  if (req.method === 'POST') {
    // KLJUCNA ISPRAVKA: vercel.json rewrite-uje
    // /api/media-nodes/:nodeId/heartbeat -> /api/media-nodes?nodeId=:nodeId
    // -- posle rewrite-a, req.url vise NE sadrzi string '/heartbeat'
    // (destinacija ga u potpunosti zamenjuje query stringom), pa je
    // url.includes('/heartbeat') UVEK bilo false u produkciji. Svaki
    // heartbeat poziv bi zavrsio u handlePostMediaNodes (pogresna grana)
    // umesto u handlePostHeartbeat. Isti obrazac kao ostatak koda
    // (cameras.js koristi req.query.path, camera-views.js req.query.id)
    // -- oslanjanje na query parametar, ne na string-matching URL-a.
    if (req.query.nodeId) {
      return handlePostHeartbeat(req, res);
    }
    return handlePostMediaNodes(req, res);
  }

  return sendError(res, 405, 'Method Not Allowed');
};
