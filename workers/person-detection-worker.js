#!/usr/bin/env node
'use strict';

/**
 * Person detection worker for D&D Monitoring.
 *
 * Runs YOLOv8n ONNX inference on JPEG frames from camera streams.
 * When a person is detected, creates an event in the database which
 * triggers incident creation and notifications.
 *
 * Architecture:
 *   1. Receives JPEG frames from xiongmai-stream-worker via EventEmitter
 *   2. Runs person detection using lib/_person_detection.js
 *   3. Applies debounce (30s) and cooldown (5 min) per camera
 *   4. Inserts into events table → triggers incident creation
 *   5. Sends notifications based on notification_rules
 *
 * Configuration (env vars):
 *   - PERSON_DETECTION_ENABLED - set to "false" to disable (default: true)
 *   - PERSON_MODEL_PATH - path to yolov8n.onnx
 *   - PERSON_CONFIDENCE_THRESHOLD - minimum confidence (default: 0.5)
 *   - PERSON_DEBOUNCE_MS - min time between detections per camera (default: 30000)
 *   - PERSON_COOLDOWN_MS - min time between events per camera (default: 300000)
 *   - PERSON_MAX_ALERTS_PER_HOUR - rate limit per camera (default: 10)
 *   - PERSON_FRAME_QUEUE_MAX - max frames queued per camera (default: 5)
 *
 * Run with: node workers/person-detection-worker.js
 */

const { EventEmitter } = require('events');
const db = require('../db/index');
const detection = require('../lib/_person_detection');
const { makeLogger } = require('../lib/_logger');
const { initSentry } = require('../lib/_sentry');
const Sentry = require('@sentry/node');

const logger = makeLogger('worker-person-detection');

initSentry();

// ── Configuration ───────────────────────────────────────────────────

const DEBOUNCE_MS = parseInt(process.env.PERSON_DEBOUNCE_MS || '30000', 10);
const COOLDOWN_MS = parseInt(process.env.PERSON_COOLDOWN_MS || '300000', 10);
const MAX_ALERTS_PER_HOUR = parseInt(process.env.PERSON_MAX_ALERTS_PER_HOUR || '10', 10);
const FRAME_QUEUE_MAX = parseInt(process.env.PERSON_FRAME_QUEUE_MAX || '5', 10);
const DB_CHECK_INTERVAL_MS = parseInt(process.env.PERSON_DB_CHECK_INTERVAL_MS || '60000', 10);

// ── State ───────────────────────────────────────────────────────────

const frameQueues = new Map(); // cameraId -> Array<{ frameId, jpegBuffer, timestamp }>
const lastDetectionTime = new Map(); // cameraId -> timestamp (debounce)
const lastEventTime = new Map(); // cameraId -> timestamp (cooldown)
const alertsThisHour = new Map(); // cameraId -> count
let currentHour = new Date().getHours();
let cleanupInterval = null;

// Shared EventEmitter for receiving frames from stream workers
const frameBus = new EventEmitter();
frameBus.setMaxListeners(100); // Allow many cameras

// ── Frame receiving ─────────────────────────────────────────────────

/**
 * Submit a JPEG frame for processing.
 * Called by xiongmai-stream-worker.js when a JPEG frame is available.
 *
 * @param {string} cameraId
 * @param {Buffer} jpegBuffer
 */
function submitFrame(cameraId, jpegBuffer) {
  if (!cameraId || !jpegBuffer || jpegBuffer.length === 0) return;

  // Get or create queue for this camera
  let queue = frameQueues.get(cameraId);
  if (!queue) {
    queue = [];
    frameQueues.set(cameraId, queue);
  }

  // Backpressure: drop oldest if queue is full
  if (queue.length >= FRAME_QUEUE_MAX) {
    queue.shift();
    logger.warn('Frame queue full, dropping oldest', { cameraId, queueSize: queue.length });
  }

  queue.push({
    frameId: `${cameraId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    jpegBuffer,
    timestamp: Date.now(),
  });
}

// Register on the shared bus
frameBus.on('frame', submitFrame);

// ── Debounce / Cooldown / Rate Limit ────────────────────────────────

function shouldProcessFrame(cameraId) {
  const now = Date.now();

  // Reset hourly counter if hour changed
  const hour = new Date().getHours();
  if (hour !== currentHour) {
    alertsThisHour.clear();
    currentHour = hour;
  }

  // Check hourly rate limit
  const hourlyCount = alertsThisHour.get(cameraId) || 0;
  if (hourlyCount >= MAX_ALERTS_PER_HOUR) {
    return false;
  }

  // Check debounce (time since last detection attempt)
  const lastDetection = lastDetectionTime.get(cameraId) || 0;
  if (now - lastDetection < DEBOUNCE_MS) {
    return false;
  }

  // Check cooldown (time since last event creation)
  const lastEvent = lastEventTime.get(cameraId) || 0;
  if (now - lastEvent < COOLDOWN_MS) {
    return false;
  }

  return true;
}

function recordDetection(cameraId) {
  lastDetectionTime.set(cameraId, Date.now());
}

function recordEvent(cameraId) {
  lastEventTime.set(cameraId, Date.now());
  const count = alertsThisHour.get(cameraId) || 0;
  alertsThisHour.set(cameraId, count + 1);
}

// ── State cleanup ───────────────────────────────────────────────────

async function cleanupStaleState() {
  try {
    const now = new Date();
    const currentHourVal = now.getHours();

    if (currentHourVal !== currentHour) {
      alertsThisHour.clear();
      currentHour = currentHourVal;
    }

    const { rows } = await db.queryAsPlatformAdmin(
      'SELECT id FROM cameras WHERE enabled = true',
    );
    const activeCameraIds = new Set(rows.map((r) => r.id));

    const staleIds = new Set();

    for (const cameraId of frameQueues.keys()) {
      if (!activeCameraIds.has(cameraId)) {
        frameQueues.delete(cameraId);
        staleIds.add(cameraId);
      }
    }
    for (const cameraId of lastDetectionTime.keys()) {
      if (!activeCameraIds.has(cameraId)) {
        lastDetectionTime.delete(cameraId);
        staleIds.add(cameraId);
      }
    }
    for (const cameraId of lastEventTime.keys()) {
      if (!activeCameraIds.has(cameraId)) {
        lastEventTime.delete(cameraId);
        staleIds.add(cameraId);
      }
    }
    for (const cameraId of alertsThisHour.keys()) {
      if (!activeCameraIds.has(cameraId)) {
        alertsThisHour.delete(cameraId);
        staleIds.add(cameraId);
      }
    }

    if (staleIds.size > 0) {
      logger.info('Cleaned stale detection state', { staleCameraIds: [...staleIds] });
    }
  } catch (err) {
    logger.error('Failed to cleanup stale state', { error: err.message });
  }
}

// ── Database operations ─────────────────────────────────────────────

/**
 * Create an event for person detection.
 * The create_incident_for_event trigger will auto-create an incident.
 *
 * @param {string} cameraId
 * @param {number} confidence
 * @param {Array} boundingBoxes
 * @returns {Promise<{ eventId: number } | null>}
 */
async function createDetectionEvent(cameraId, confidence, boundingBoxes) {
  try {
    const description = `Person detected with ${Math.round(confidence * 100)}% confidence`;

    const result = await db.queryAsPlatformAdmin(
      `INSERT INTO events (camera_id, event_type, severity, description)
       VALUES ($1, 'person_detected', 'medium', $2)
       RETURNING id`,
      [cameraId, description],
    );

    const eventId = result.rows[0]?.id;
    if (!eventId) {
      logger.error('Failed to create event: no id returned', { cameraId });
      return null;
    }

    // Insert into ai_detections if schema supports it
    try {
      await db.queryAsPlatformAdmin(
        `INSERT INTO ai_detections (event_id, object_type, confidence, bounding_box, timestamp, organization_id)
         SELECT $1, 'person', $2, $3::jsonb, now(), c.organization_id
         FROM cameras c WHERE c.id = $4`,
        [eventId, confidence, JSON.stringify(boundingBoxes), cameraId],
      );
    } catch (err) {
      // ai_detections insert is best-effort
      logger.warn('Failed to insert ai_detections (non-fatal)', { error: err.message });
    }

    logger.info('Detection event created', { eventId, cameraId, confidence });
    return { eventId };
  } catch (err) {
    logger.error('Failed to create detection event', { error: err.message, cameraId });
    if (Sentry) Sentry.captureException(err);
    return null;
  }
}

/**
 * Check notification rules and send notifications.
 * Graceful failure: if no provider configured, just log.
 *
 * @param {string} cameraId
 * @param {number} eventId
 * @param {number} confidence
 */
async function sendNotifications(cameraId, eventId, confidence) {
  try {
  // Get the camera's organization to scope notification rules
  const camera = await db.queryAsPlatformAdmin(
    'SELECT organization_id FROM cameras WHERE id = $1',
    [cameraId],
  );
  const orgId = camera.rows[0]?.organization_id;

  const rules = await db.queryAsPlatformAdmin(
    `SELECT id, channel, recipient, event_type
     FROM notification_rules
     WHERE active = true
       AND (event_type IS NULL OR event_type = 'person_detected')
       AND organization_id = $1`,
    [orgId],
  );

    if (rules.rows.length === 0) {
      logger.debug('No active notification rules for person_detected');
      return;
    }

    for (const rule of rules.rows) {
      try {
        if (rule.channel === 'webhook') {
          await sendWebhookNotification(rule.recipient, {
            cameraId,
            eventId,
            confidence,
            eventType: 'person_detected',
            timestamp: new Date().toISOString(),
          });
        } else if (rule.channel === 'email') {
          logger.info('Email notification skipped (no SMTP configured)', { ruleId: rule.id });
        } else if (rule.channel === 'sms') {
          logger.info('SMS notification skipped (no SMS provider configured)', { ruleId: rule.id });
        }
      } catch (err) {
        logger.error('Notification failed', { ruleId: rule.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Failed to check notification rules', { error: err.message });
  }
}

/**
 * Send webhook notification.
 *
 * @param {string} url - Webhook URL
 * @param {Object} payload - Notification payload
 */
async function sendWebhookNotification(url, payload) {
  const http = url.startsWith('https') ? require('https') : require('http');
  const data = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'DndMonitoring-Alert/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Webhook returned ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Webhook timeout'));
    });

    req.write(data);
    req.end();
  });
}

// ── Processing loop ─────────────────────────────────────────────────

async function processFrame(cameraId, frame) {
  // Run detection
  const result = await detection.detectPersons(frame.jpegBuffer);

  if (result.error) {
    logger.warn('Detection error', { cameraId, error: result.error });
    return;
  }

  if (result.persons.length === 0) {
    return; // No persons detected
  }

  // Find highest confidence detection
  const best = result.persons.reduce((a, b) => a.confidence > b.confidence ? a : b);

  logger.info('Person detected', {
    cameraId,
    confidence: best.confidence,
    count: result.persons.length,
    inferenceMs: result.inferenceTimeMs,
  });

  // Apply debounce/cooldown
  if (!shouldProcessFrame(cameraId)) {
    return;
  }

  recordDetection(cameraId);

  // Create event
  const eventResult = await createDetectionEvent(cameraId, best.confidence, result.persons);
  if (!eventResult) return;

  recordEvent(cameraId);

  // Send notifications
  await sendNotifications(cameraId, eventResult.eventId, best.confidence);
}

async function processLoop() {
  for (const [cameraId, queue] of frameQueues) {
    if (queue.length === 0) continue;

    // Process newest frame
    const frame = queue.pop();
    // Clear older frames to prevent backlog
    queue.length = 0;

    try {
      await processFrame(cameraId, frame);
    } catch (err) {
      logger.error('Frame processing failed', { cameraId, error: err.message });
      if (Sentry) Sentry.captureException(err);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  if (process.env.PERSON_DETECTION_ENABLED === 'false') {
    logger.info('Person detection disabled via PERSON_DETECTION_ENABLED=false');
    return;
  }

  // Check detection availability
  const available = await detection.isAvailable();
  if (!available) {
    logger.warn('Person detection not available (model missing or onnxruntime not installed). Worker will retry periodically.');
  }

  logger.info('Person detection worker started', {
    debounceMs: DEBOUNCE_MS,
    cooldownMs: COOLDOWN_MS,
    maxAlertsPerHour: MAX_ALERTS_PER_HOUR,
    frameQueueMax: FRAME_QUEUE_MAX,
    modelPath: process.env.PERSON_MODEL_PATH || 'models/yolov8n.onnx',
  });

  startProcessing();

  const shutdown = () => {
    if (processInterval) clearInterval(processInterval);
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (statusInterval) clearInterval(statusInterval);
    logger.info('Person detection worker shutting down');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startProcessing() {
  if (started) return;
  started = true;

  processInterval = setInterval(processLoop, 1000);

  cleanupInterval = setInterval(cleanupStaleState, 5 * 60 * 1000);

  statusInterval = setInterval(async () => {
    const status = detection.getStatus();
    if (!status.modelLoaded && status.modelExists) {
      logger.info('Attempting model reload...');
      await detection.loadModel();
    }
  }, DB_CHECK_INTERVAL_MS);

  logger.info('Person detection processing started');
}

let started = false;
let processInterval = null;
let statusInterval = null;

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal error', { error: err.message });
    process.exit(1);
  });
} else {
  // When required as a module (e.g., by xiongmai-stream-worker),
  // expose a start function so the parent can begin processing.
}

// Export for use by stream workers
module.exports = {
  submitFrame,
  frameBus,
  startProcessing,
  cleanupStaleState,
  sendNotifications,
  getStatus: () => ({
    ...detection.getStatus(),
    camerasMonitored: frameQueues.size,
    queueSizes: Object.fromEntries([...frameQueues].map(([k, v]) => [k, v.length])),
  }),
  __test: {
    frameQueues,
    lastDetectionTime,
    lastEventTime,
    alertsThisHour,
    get currentHour() { return currentHour; },
    set currentHour(val) { currentHour = val; },
  },
};
