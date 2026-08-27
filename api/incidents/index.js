const db = require('../../db/index');
const { requireAuth, getAccessibleCameraIds } = require('../../lib/_auth');
const { logAudit, getIp } = require('../../lib/_audit');
const { keyFromPublicUrl, getPresignedDownloadUrl, isConfigured } = require('../../lib/_storage');
const { z } = require('zod');
const { sendError, sendSuccess } = require('../../lib/_error');
const { rateLimit } = require('../../lib/_rate_limit');
const { makeLogger } = require('../../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../../lib/_sentry');

const logger = makeLogger('api-incidents');

initSentry();


const ALLOWED_STATUSES = ['New', 'Acknowledged', 'In Progress', 'Resolved', 'False Alarm'];
const EMERGENCY_PRIORITIES = ['critical', 'high', 'medium', 'low'];
const EMERGENCY_STATUSES = ['pending', 'dispatched', 'resolved', 'cancelled'];
const REPORT_TYPES = ['daily', 'weekly', 'monthly'];

// ─── Zod schema for incident status update ─────────────────────
const statusUpdateSchema = z.object({
  status: z.enum(ALLOWED_STATUSES).optional(),
  assigned_operator_id: z.string().uuid().optional().nullable(),
  assign_to_self: z.boolean().optional(),
}).refine(data => data.status || data.assigned_operator_id !== undefined || data.assign_to_self, {
  message: 'Provide status, assigned_operator_id, or assign_to_self',
});

// ─── Zod schema for emergency dispatch ─────────────────────────
const dispatchSchema = z.object({
  camera_id: z.string().max(50).optional().nullable(),
  incident_type: z.string().min(1, 'incident_type is required').max(50),
  location: z.string().max(255).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  priority: z.enum(EMERGENCY_PRIORITIES).optional().default('high'),
});

// ─── Zod schema for reports query ──────────────────────────────
const reportQuerySchema = z.object({
  type: z.enum(REPORT_TYPES).optional().default('daily'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, expected YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format, expected YYYY-MM-DD').optional(),
}).strict();

// Combined handler for all /api/incidents routes:
//   GET /api/incidents                           → list all incidents
//   GET /api/incidents/:eventId/activity         → get activity log
//   PATCH /api/incidents/:eventId/status         → update incident status
//   GET /api/incidents/:eventId/evidence         → get evidence (recordings + snapshots)
//   GET /api/incidents?path=emergency            → list emergency dispatches
//   POST /api/incidents?path=emergency           → create emergency dispatch
//   GET /api/incidents?path=reports              → get reports summary
module.exports = async (req, res) => {
  if (!(await rateLimit(req, res))) return;
  const { eventId, path: pathInfo } = req.query;

  // ── Emergency dispatch routes ─────────────────────────────────────
  if (pathInfo === 'emergency') {
    if (req.method === 'POST') {
      return handleEmergencyCreate(req, res);
    }
    if (req.method === 'GET') {
      return handleEmergencyList(req, res);
    }
    return sendError(res, 405, 'Method Not Allowed');
  }

  // ── Reports summary route ─────────────────────────────────────────
  if (pathInfo === 'reports') {
    if (req.method === 'GET') {
      return handleReportsSummary(req, res);
    }
    return sendError(res, 405, 'Method Not Allowed');
  }

  // ── Event-specific routes (merged from [eventId]/index.js) ─────────
  if (eventId && pathInfo === 'activity') {
    return handleActivity(req, res, eventId);
  }
  if (eventId && pathInfo === 'status') {
    return handleStatus(req, res, eventId);
  }
  if (eventId && pathInfo === 'evidence') {
    return handleEvidence(req, res, eventId);
  }

  // ── GET /api/incidents — list all incidents ───────────────────────
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const accessibleIds = await getAccessibleCameraIds(auth);
    if (accessibleIds !== null && accessibleIds.length === 0) {
      return sendSuccess(res, { count: 0, incidents: [], statuses: ALLOWED_STATUSES });
    }

    const { rows } = accessibleIds === null
      ? await db.queryAsOrg(auth.organizationId, `
          SELECT
            i.id, i.event_id, i.status, i.severity, i.assigned_operator_id,
            i.created_at, i.acknowledged_at, i.resolved_at,
            e.camera_id, e.description AS source_description,
            a.object_type, a.confidence
          FROM incidents i
          JOIN events e ON e.id = i.event_id
          LEFT JOIN ai_detections a ON a.event_id = e.id
          WHERE e.is_dismissed = FALSE AND i.organization_id = $1 AND i.created_at >= CURRENT_DATE
          ORDER BY i.created_at DESC
          LIMIT 100
        `, [auth.organizationId])
      : await db.queryAsOrg(auth.organizationId, `
          SELECT
            i.id, i.event_id, i.status, i.severity, i.assigned_operator_id,
            i.created_at, i.acknowledged_at, i.resolved_at,
            e.camera_id, e.description AS source_description,
            a.object_type, a.confidence
          FROM incidents i
          JOIN events e ON e.id = i.event_id
          LEFT JOIN ai_detections a ON a.event_id = e.id
          WHERE e.is_dismissed = FALSE AND i.organization_id = $1 AND i.camera_id = ANY($2::varchar[]) AND i.created_at >= CURRENT_DATE
          ORDER BY i.created_at DESC
          LIMIT 100
        `, [auth.organizationId, accessibleIds]);

    const incidents = rows.map((row) => ({
      id: row.id,
      event_id: row.event_id,
      object_type: row.object_type,
      confidence: row.confidence,
      timestamp: row.created_at,
      source: row.source_description || `Event #${row.event_id}`,
      status: row.status,
      severity: row.severity,
      assigned_operator_id: row.assigned_operator_id,
      acknowledged_at: row.acknowledged_at,
      resolved_at: row.resolved_at,
      camera_id: row.camera_id,
      subtitle: row.confidence != null ? `Confidence ${Math.round(Number(row.confidence) * 100)}%` : row.severity,
    }));

    return sendSuccess(res, { count: incidents.length, incidents, statuses: ALLOWED_STATUSES });
  } catch (err) {
    logger.error('GET /api/incidents error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════
//  Event-specific handlers (merged from [eventId]/index.js)
// ═══════════════════════════════════════════════════════════════════

async function handleActivity(req, res, eventId) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const incidentResult = await db.queryAsOrg(
      auth.organizationId,
      'SELECT id, organization_id FROM incidents WHERE event_id = $1',
      [eventId],
    );
    if (incidentResult.rows.length === 0 || incidentResult.rows[0].organization_id !== auth.organizationId) {
      return sendError(res, 404, 'Incident not found in your organization');
    }

    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT l.id, l.action, l.note, l.created_at, l.user_id, u.email AS user_email
       FROM incident_activity_log l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.incident_id = $1
       ORDER BY l.created_at ASC`,
      [incidentResult.rows[0].id],
    );

    return sendSuccess(res, { event_id: eventId, activity: rows });
  } catch (err) {
    logger.error('GET /api/incidents/:eventId/activity error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleStatus(req, res, eventId) {
  if (req.method !== 'PATCH') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const data = statusUpdateSchema.parse(req.body || {});
    const { status, assigned_operator_id: assignedOperatorId, assign_to_self: assignToSelf } = data;

    const incidentResult = await db.queryAsOrg(
      auth.organizationId,
      'SELECT id, organization_id, status FROM incidents WHERE event_id = $1',
      [eventId],
    );
    if (incidentResult.rows.length === 0 || incidentResult.rows[0].organization_id !== auth.organizationId) {
      return sendError(res, 404, 'Incident not found in your organization');
    }
    const incident = incidentResult.rows[0];

    let targetOperatorId;
    if (assignToSelf) {
      targetOperatorId = auth.userId;
    } else if (assignedOperatorId !== undefined) {
      if (assignedOperatorId !== null && assignedOperatorId !== auth.userId
          && auth.userType !== 'org_admin' && auth.userType !== 'platform_admin') {
        return sendError(res, 403, 'Only org_admin/platform_admin can assign incidents to other operators');
      }
      targetOperatorId = assignedOperatorId;
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
      if (status === 'Acknowledged' && !incident.acknowledged_at) {
        updates.push('acknowledged_at = now()');
      }
      if ((status === 'Resolved' || status === 'False Alarm')) {
        updates.push('resolved_at = now()');
      }
    }
    if (targetOperatorId !== undefined) {
      updates.push(`assigned_operator_id = $${paramIndex++}`);
      values.push(targetOperatorId);
    }

    values.push(incident.id);
    await db.queryAsOrg(auth.organizationId, `UPDATE incidents SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

    if (status) {
      await db.queryAsOrg(
        auth.organizationId,
        'INSERT INTO incident_activity_log (incident_id, user_id, action, note) VALUES ($1, $2, $3, $4)',
        [incident.id, auth.userId, 'status_changed', `Status changed from ${incident.status} to ${status}`],
      );
    }
    if (targetOperatorId !== undefined) {
      await db.queryAsOrg(
        auth.organizationId,
        'INSERT INTO incident_activity_log (incident_id, user_id, action, note) VALUES ($1, $2, $3, $4)',
        [incident.id, auth.userId, targetOperatorId ? 'assigned' : 'unassigned',
          targetOperatorId ? `Assigned to operator ${targetOperatorId}` : 'Unassigned'],
      );
    }

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'incident.updated',
      resourceType: 'incident',
      resourceId: incident.id,
      metadata: { event_id: eventId, status, assigned_operator_id: targetOperatorId },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { event_id: eventId, status: status || incident.status, assigned_operator_id: targetOperatorId });
  } catch (err) {
    if (err.name === 'ZodError') {
      return sendError(res, 400, 'Validation failed',
        err.issues.map(e => ({ field: e.path.join('.'), message: e.message }))
      );
    }
    logger.error('PATCH /api/incidents/:eventId/status error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleEvidence(req, res, eventId) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method Not Allowed');
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const eventResult = await db.queryAsOrg(
      auth.organizationId,
      'SELECT e.id, e.camera_id, e.event_type, e.severity, e.description, e.timestamp FROM events e WHERE e.id = $1',
      [eventId],
    );
    if (eventResult.rows.length === 0) {
      return sendError(res, 404, 'Event not found in your organization');
    }
    const event = eventResult.rows[0];

    const recordingsResult = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, storage_url, status, duration_seconds, size_bytes, start_time, end_time
       FROM recordings WHERE event_id = $1 ORDER BY start_time`,
      [eventId],
    );

    const snapshotsResult = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, storage_url, taken_at, trigger
       FROM snapshots
       WHERE camera_id = $1 AND taken_at BETWEEN $2::timestamptz - interval '5 minutes' AND $2::timestamptz + interval '5 minutes'
       ORDER BY taken_at`,
      [event.camera_id, event.timestamp],
    );

    const storageReady = isConfigured();

    const recordings = await Promise.all(recordingsResult.rows.map(async (r) => {
      let downloadUrl = null;
      if (storageReady && r.storage_url && r.status === 'completed') {
        const key = keyFromPublicUrl(r.storage_url);
        if (key) {
          try { downloadUrl = await getPresignedDownloadUrl(key, { expiresInSeconds: 3600 }); }
          catch { logger.error('[evidence] presign failed for recording', { recording_id: r.id }); }
        }
      }
      return {
        id: r.id, status: r.status, duration_seconds: r.duration_seconds, size_bytes: r.size_bytes,
        start_time: r.start_time, end_time: r.end_time, download_url: downloadUrl,
      };
    }));

    const snapshots = await Promise.all(snapshotsResult.rows.map(async (s) => {
      let downloadUrl = null;
      if (storageReady && s.storage_url) {
        const key = keyFromPublicUrl(s.storage_url);
        if (key) {
          try { downloadUrl = await getPresignedDownloadUrl(key, { expiresInSeconds: 3600 }); }
          catch { logger.error('[evidence] presign failed for snapshot', { snapshot_id: s.id }); }
        }
      }
      return { id: s.id, taken_at: s.taken_at, trigger: s.trigger, download_url: downloadUrl };
    }));

    return sendSuccess(res, {
      event,
      recordings,
      snapshots,
      storage_configured: storageReady,
    });
  } catch (err) {
    logger.error('GET /api/incidents/:eventId/evidence error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Emergency dispatch handlers
// ═══════════════════════════════════════════════════════════════════

async function handleEmergencyCreate(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let data;
  try {
    data = dispatchSchema.parse(req.body || {});
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  try {
    const { camera_id, incident_type, location, description, priority } = data;

    const result = await db.queryAsOrg(
      auth.organizationId,
      `INSERT INTO emergency_dispatches
         (organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id, organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by, created_at, updated_at`,
      [auth.organizationId, camera_id || null, incident_type, location || null, description || null, priority, auth.userId],
    );

    const dispatch = result.rows[0];

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'emergency.dispatch',
      resourceType: 'emergency_dispatch',
      resourceId: dispatch.id,
      metadata: { incident_type, priority, camera_id: camera_id || null },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { dispatch }, 201);
  } catch (err) {
    logger.error('POST /api/emergency/dispatch error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

async function handleEmergencyList(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { rows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT id, organization_id, camera_id, incident_type, location, description, priority, status, dispatched_by, created_at, updated_at
       FROM emergency_dispatches
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [auth.organizationId],
    );

    return sendSuccess(res, { count: rows.length, dispatches: rows });
  } catch (err) {
    logger.error('GET /api/emergency/dispatch error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Reports summary handler
// ═══════════════════════════════════════════════════════════════════

function computeDateRange(type, from, to) {
  if (from && to) {
    return { from, to };
  }

  const now = new Date();
  let startDate;

  switch (type) {
    case 'weekly':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case 'monthly':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 30);
      break;
    case 'daily':
    default:
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 1);
      break;
  }

  return {
    from: startDate.toISOString().split('T')[0],
    to: now.toISOString().split('T')[0],
  };
}

async function handleReportsSummary(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let query;
  try {
    const { path, ...queryParams } = req.query || {};
    query = reportQuerySchema.parse(queryParams);
  } catch (zodErr) {
    if (zodErr instanceof z.ZodError) {
      return sendError(res, 400, 'Validation failed',
        zodErr.issues.map(e => ({ field: e.path.join('.'), message: e.message, received: e.received }))
      );
    }
    throw zodErr;
  }

  const { from, to } = computeDateRange(query.type, query.from, query.to);

  try {
    const { rows: statusRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT status, COUNT(*) as count
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date
       GROUP BY status`,
      [auth.organizationId, from, to],
    );

    const { rows: severityRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT severity, COUNT(*) as count
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date
       GROUP BY severity`,
      [auth.organizationId, from, to],
    );

    const { rows: cameraRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT c.name as camera_name, c.id as camera_id, COUNT(*) as count
       FROM incidents i
       JOIN cameras c ON c.id = i.camera_id
       WHERE i.organization_id = $1
         AND i.created_at::date >= $2::date
         AND i.created_at::date <= $3::date
       GROUP BY c.id, c.name
       ORDER BY count DESC
       LIMIT 10`,
      [auth.organizationId, from, to],
    );

    const { rows: totalRow } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT COUNT(*) as total,
               AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60) as avg_resolution_minutes
       FROM incidents
       WHERE organization_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date`,
      [auth.organizationId, from, to],
    );

    const { rows: incidentRows } = await db.queryAsOrg(
      auth.organizationId,
      `SELECT i.id, i.status, i.severity, i.created_at, i.resolved_at,
               e.description, c.name as camera_name
       FROM incidents i
       JOIN events e ON e.id = i.event_id
       LEFT JOIN cameras c ON c.id = i.camera_id
       WHERE i.organization_id = $1
         AND i.created_at::date >= $2::date
         AND i.created_at::date <= $3::date
       ORDER BY i.created_at DESC
       LIMIT 50`,
      [auth.organizationId, from, to],
    );

    const byStatus = {};
    for (const row of statusRows) {
      byStatus[row.status] = parseInt(row.count, 10);
    }

    const bySeverity = {};
    for (const row of severityRows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
    }

    const byCamera = cameraRows.map(r => ({
      camera_id: r.camera_id,
      camera_name: r.camera_name,
      count: parseInt(r.count, 10),
    }));

    const total = totalRow[0]?.total ? parseInt(totalRow[0].total, 10) : 0;
    const avgResolutionMinutes = totalRow[0]?.avg_resolution_minutes
      ? Math.round(parseFloat(totalRow[0].avg_resolution_minutes))
      : null;

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'report.view',
      resourceType: 'report',
      resourceId: null,
      metadata: { report_type: query.type, date_range: { from, to } },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, {
      generated_at: new Date().toISOString(),
      report_type: query.type,
      date_range: { from, to },
      summary: {
        total_incidents: total,
        by_status: byStatus,
        by_severity: bySeverity,
        by_camera: byCamera,
        avg_resolution_time_minutes: avgResolutionMinutes,
      },
      incidents: incidentRows,
    });
  } catch (err) {
    logger.error('GET /api/reports/summary error', { error: err.message });
    Sentry.captureException(err);
    return sendError(res, 500, err.message);
  }
}
