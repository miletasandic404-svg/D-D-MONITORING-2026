/**
 * Auto-Detect Camera API Endpoint
 * 
 * POST /api/auto-detect-camera
 * 
 * Klijent unese IP adresu, sistem:
 * 1. Pronalazi model kamere
 * 2. Pronalazi default kredencijale
 * 3. Pronalazi radnu RTSP putanju
 * 4. Automatski registruje kameru u bazu
 * 5. Pokreće stream
 */

'use strict';

const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { autoDetectCamera } = require('../lib/_auto_camera_detector');
const { addOrUpdateCameraPath } = require('../lib/_mediamtx_client');
const { logAudit, getIp } = require('../lib/_audit');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const { z } = require('zod');
const crypto = require('crypto');

const autoDetectSchema = z.object({
  ip_address: z.string().ip('Invalid IP address'),
  camera_name: z.string().min(1).max(255).optional(),
});

module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;

  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  // Provjera autentičnosti
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // Validacija inputa
  let data;
  try {
    data = autoDetectSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
      );
    }
    throw zodErr;
  }

  const { ip_address, camera_name } = data;

  try {
    console.log(`[auto-detect-camera] POST za org: ${auth.organizationId}, IP: ${ip_address}`);

    // ===== DETEKTUJ KAMERU =====
    const detectionResult = await autoDetectCamera(ip_address);

    if (!detectionResult.success) {
      return sendSuccess(res, {
        success: false,
        detection_result: detectionResult,
        message: detectionResult.error || 'Nije pronašao radnu RTSP putanju',
      }, 400);
    }

    // ===== KREIRAJ KAMERU U BAZI =====
    const cameraId = `CAM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const cameraDisplayName = camera_name || `Camera at ${ip_address}`;

    // Pronađi default site za org
    const siteResult = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id FROM sites WHERE organization_id = $1 LIMIT 1`,
      [auth.organizationId]
    );

    if (siteResult.rows.length === 0) {
      return sendError(res, 409, 'Organization has no site configured. Create a site first.');
    }

    const siteId = siteResult.rows[0].id;

    // Umetni kameru
    const insertResult = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO cameras (id, name, rtsp_url, organization_id, site_id, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, now(), now())
       RETURNING id, name, rtsp_url`,
      [cameraId, cameraDisplayName, detectionResult.rtsp_url_working, auth.organizationId, siteId]
    );

    const newCamera = insertResult.rows[0];

    // ===== REGISTRUJ U MEDIAMTX =====
    try {
      await addOrUpdateCameraPath(cameraId, detectionResult.rtsp_url_working);
      console.log(`[auto-detect-camera] MediaMTX path kreiran za: ${cameraId}`);
    } catch (mtxError) {
      console.warn(`[auto-detect-camera] MediaMTX greška:`, mtxError.message);
      // Nastavi - kamero je u bazi čak i ako MTX nije dostupan
    }

    // ===== LOG AUDIT =====
    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'camera_auto_detected',
      resourceType: 'camera',
      resourceId: cameraId,
      ipAddress: getIp(req),
      details: {
        ip_address,
        detected_vendor: detectionResult.detected_vendor,
        detection_method: detectionResult.detection_method,
        model_guess: detectionResult.model_guess,
      },
    });

    console.log(`[auto-detect-camera] ✅ Kamera uspešno kreirana: ${cameraId}`);

    // ===== ODGOVORI =====
    return sendSuccess(res, {
      success: true,
      camera: {
        id: newCamera.id,
        name: newCamera.name,
        rtsp_url: newCamera.rtsp_url,
        ip_address,
      },
      detection: {
        vendor: detectionResult.detected_vendor,
        model: detectionResult.model_guess,
        method: detectionResult.detection_method,
        credentials: {
          username: detectionResult.default_credentials.username,
          password: '***HIDDEN***',
        },
      },
      message: 'Camera auto-detected and configured successfully!',
    }, 201);

  } catch (error) {
    console.error(`[auto-detect-camera] Error:`, error.message);
    return sendError(res, 500, error.message);
  }
};
