const db = require('../../db/index');
const { sendError, sendSuccess } = require('../_error');
const { makeLogger } = require('../_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../_sentry');

const logger = makeLogger('handler-verify-stream-token');

initSentry();

// =========================================================
// Contract: MediaMTX's authHTTPAddress webhook (see
// https://mediamtx.org/docs/features/authentication). For every
// access attempt, MediaMTX POSTs JSON:
//   { user, password, ip, action, path, protocol, id, query }
// A 2xx response means "allow"; anything else means "deny".
//
// Wire this up in media-server/mediamtx.yml:
//   authMethod: http
//   authHTTPAddress: https://www.dnd-monitoring.com/api/verify-stream-token
//   authHTTPExclude:
//     - action: api
//     - action: metrics
//     - action: publish   # cameras publish RTSP unauthenticated on the
//                          # trusted network side; only READS (HLS/WebRTC
//                          # to the browser) go through this check
//
// The frontend requests a token via POST /api/camera-views first, then
// appends it to the HLS URL as ?token=<token>, which MediaMTX forwards
// here in the `query` field.
// =========================================================

function extractToken(query) {
  if (!query) return null;
  const params = new URLSearchParams(query);
  return params.get('token');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  if (!db.hasDatabase) {
    // Fail closed: if we can't check the token, don't allow the stream.
    res.status(503).end();
    return;
  }

  const { path: cameraId, query, action } = req.body || {};

  // Only reads (HLS/WebRTC viewing) need a token here; publishing is
  // handled on the trusted camera-network side via authHTTPExclude.
  if (action !== 'read' && action !== 'playback') {
    res.status(403).end();
    return;
  }

  const token = extractToken(query);
  if (!token || !cameraId) {
    res.status(401).end();
    return;
  }

  try {
    const result = await db.queryAsPlatformAdmin(
      `SELECT id FROM camera_stream_tokens
       WHERE token = $1 AND camera_id = $2 AND expires_at > now()`,
      [token, cameraId],
    );
    if (result.rows.length === 0) {
      res.status(401).end();
      return;
    }
    res.status(200).end();
  } catch (err) {
    logger.error('POST /api/verify-stream-token error', { error: err.message });
    Sentry.captureException(err);
    res.status(500).end();
  }
};
