'use strict';

/**
 * Camera Compatibility Gate
 *
 * Production-grade pre-flight validation for cameras before they are accepted
 * as production cameras. Reuses existing discovery, streaming, and AI modules
 * without duplicating logic.
 *
 * Compatibility levels:
 *   PRODUCTION_READY - all checks pass
 *   VIDEO_ONLY       - video pipeline works, talkdown not supported
 *   BLOCKED          - hard failure
 */

const { XiongmaiDvripAdapter, DVRIP_PORT } = require('./_xiongmai_dvrip');
const { XiongmaiVideoStream } = require('./_xiongmai_video');
const { discoverCamera } = require('./_onvif_client');
const { probeRtspUrl, embedCredentials } = require('./_rtsp_probe');
const { getConnector, onvifConnector, rtspCommonConnector } = require('./_camera_connectors');
const mediamtxClient = require('./_mediamtx_client');
const detection = require('./_person_detection');
const { detectTwoWayAudioCapability } = require('./_two_way_audio');
const { decrypt } = require('./_crypto');
const childProcess = require('child_process');

// ── Constants ──────────────────────────────────────────────────────────────

const COMPAT_TIMEOUT_MS = 15000;
const FRAME_EXTRACT_TIMEOUT_MS = 10000;
const HLS_CHECK_TIMEOUT_MS = 8000;
const DEFAULT_RTSP_PORT = 554;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger(cameraId) {
  const L = require('./_logger');
  return L.makeLogger(`compat-${cameraId || 'unknown'}`);
}

function maskedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@]+@/, '//***@');
  }
}

async function fetchUrl(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || HLS_CHECK_TIMEOUT_MS);
    const response = await globalThis.fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const text = await response.text();
    return { status: response.status, body: text };
  } catch {
    return { status: 0, body: null };
  }
}

let _extractFrameFromRtsp = async function extractFrameFromRtsp(rtspUrl, timeoutMs) {
  return new Promise((resolve) => {
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vframes', '1',
      '-q:v', '2',
      '-',
    ];
    const ffmpeg = childProcess.spawn('ffmpeg', args);
    const chunks = [];
    let settled = false;

    ffmpeg.stdout.on('data', (chunk) => { chunks.push(chunk); });
    ffmpeg.stderr.on('data', () => { /* ignore */ });

    ffmpeg.on('error', () => {
      if (!settled) { settled = true; resolve(null); }
    });

    ffmpeg.on('close', (code) => {
      if (!settled) {
        settled = true;
        if (code === 0 && chunks.length > 0) {
          const buffer = Buffer.concat(chunks);
          if (buffer.length > 100 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
            resolve(buffer);
          } else {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ffmpeg.kill('SIGKILL');
        resolve(null);
      }
    }, timeoutMs || FRAME_EXTRACT_TIMEOUT_MS);
    ffmpeg.on('close', () => clearTimeout(timer));
    ffmpeg.on('error', () => clearTimeout(timer));
  });
}

// ── DVRIP compatibility ────────────────────────────────────────────────────

async function checkDvripCompatibility(camera, logger) {
  const result = {
    discovery: { detected: false, protocol: 'dvrip' },
    credentials: { valid: false },
    video: { supported: false, codec: null, width: null, height: null, fps: null },
    media: { rtsp: false, mediamtx: false, hls: false },
    ai: { frame_source_available: false },
    audio: { supported: false, protocol: null },
    failures: [],
  };

  const ip = camera.ip;
  const port = camera.port || DVRIP_PORT;
  const username = camera.rtsp_username || '';
  const encryptedPassword = camera.rtsp_password_encrypted || '';
  let password = '';
  try {
    const decrypted = encryptedPassword ? decrypt(encryptedPassword) : '';
    try {
      const creds = JSON.parse(decrypted);
      password = creds.password || '';
    } catch {
      password = decrypted;
    }
  } catch {
    result.failures.push('credential_decrypt_failed');
    return result;
  }

  // 1. Discovery / auth
  let adapter;
  try {
    adapter = new XiongmaiDvripAdapter(ip, port);
    const authResult = await adapter.authenticate(username, password);
    result.discovery.detected = true;
    result.credentials.valid = true;
    logger.info('compat.dvrip.auth_ok', { camera_id: camera.id, session_id: authResult.SessionId });
  } catch (err) {
    result.failures.push(`dvrip_auth_failed: ${err.message}`);
    return result;
  }

  // 2. Video stream
  let videoStream;
  try {
    videoStream = new XiongmaiVideoStream(ip, port);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video_handshake_timeout')), COMPAT_TIMEOUT_MS);
      videoStream.startStreaming(
        adapter.socket,
        adapter.sessionId,
        { channel: 0, streamType: 'Main', transMode: 'TCP' },
        (frame) => {
          if (frame.kind === 'video' && frame.data) {
            result.video.supported = true;
            result.video.codec = frame.codec || 'unknown';
            if (frame.width) result.video.width = frame.width;
            if (frame.height) result.video.height = frame.height;
            if (frame.fps) result.video.fps = frame.fps;
            clearTimeout(timer);
            resolve();
          }
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    logger.info('compat.dvrip.video_ok', { camera_id: camera.id, codec: result.video.codec });
  } catch (err) {
    result.failures.push(`dvrip_video_failed: ${err.message}`);
    return result;
  }

  // 3. MediaMTX publish
  try {
    await mediamtxClient.addOrUpdateCameraPath(camera.id, 'publisher');
    result.media.mediamtx = true;
    const status = await mediamtxClient.getPathStatus(camera.id);
    if (status && status.ready) {
      result.media.rtsp = true;
    }
    logger.info('compat.dvrip.mediamtx_ok', { camera_id: camera.id });
  } catch (err) {
    result.failures.push(`mediamtx_publish_failed: ${err.message}`);
  }

  // 4. HLS
  const hlsUrl = `https://hls.dnd-monitoring.com/${encodeURIComponent(camera.id)}/index.m3u8`;
  try {
    const hlsCheck = await fetchUrl(hlsUrl);
    result.media.hls = hlsCheck.status === 200;
    if (!result.media.hls) {
      result.failures.push(`hls_unavailable: HTTP ${hlsCheck.status}`);
    }
    logger.info('compat.dvrip.hls_ok', { camera_id: camera.id, status: hlsCheck.status });
  } catch (err) {
    result.failures.push(`hls_check_failed: ${err.message}`);
  }

  // 5. AI frame availability
  try {
    const frame = await _extractFrameFromRtsp(`rtsp://127.0.0.1:8554/${encodeURIComponent(camera.id)}`);
    result.ai.frame_source_available = frame !== null;
    if (!result.ai.frame_source_available) {
      result.failures.push('ai_frame_extraction_failed');
    }
    logger.info('compat.dvrip.ai_frame_ok', { camera_id: camera.id, frame_size: frame ? frame.length : 0 });
  } catch (err) {
    result.ai.frame_source_available = false;
    result.failures.push(`ai_frame_failed: ${err.message}`);
  }

  // 6. Audio/talkdown
  const audioCaps = detectTwoWayAudioCapability(camera);
  result.audio.supported = audioCaps.supported;
  result.audio.protocol = audioCaps.protocol;
  if (!audioCaps.supported) {
    result.failures.push('talkdown_not_supported');
  }

  // Cleanup
  if (videoStream) {
    try { videoStream.stopStreaming(); } catch { /* ignore */ }
  }
  if (adapter) {
    try { adapter.stopKeepalive(); } catch { /* ignore */ }
    try { if (adapter.socket && !adapter.socket.destroyed) adapter.socket.destroy(); } catch { /* ignore */ }
  }

  return result;
}

// ── ONVIF/RTSP compatibility ───────────────────────────────────────────────

async function checkOnvifRtspCompatibility(camera, logger) {
  const result = {
    discovery: { detected: false, protocol: 'unknown' },
    credentials: { valid: false },
    video: { supported: false, codec: null, width: null, height: null, fps: null },
    media: { rtsp: false, mediamtx: false, hls: false },
    ai: { frame_source_available: false },
    audio: { supported: false, protocol: null },
    failures: [],
  };

  const ip = camera.ip;
  const port = camera.port || DEFAULT_RTSP_PORT;
  const username = camera.rtsp_username || '';
  const encryptedPassword = camera.rtsp_password_encrypted || '';
  let password = '';
  try {
    const decrypted = encryptedPassword ? decrypt(encryptedPassword) : '';
    try {
      const creds = JSON.parse(decrypted);
      password = creds.password || '';
    } catch {
      password = decrypted;
    }
  } catch {
    result.failures.push('credential_decrypt_failed');
    return result;
  }

  // 1. Discovery
  let discoveredCam = null;
  try {
    discoveredCam = await discoverCamera(ip, port, username, password);
    result.discovery.detected = true;
    result.discovery.protocol = discoveredCam.onvif_supported ? 'onvif' : 'rtsp';
    logger.info('compat.onvif.discovery_ok', { camera_id: camera.id, manufacturer: discoveredCam.manufacturer });
  } catch (err) {
    result.failures.push(`onvif_discovery_failed: ${err.message}`);
    // Continue to RTSP fallback
  }

  // 2. RTSP probe
  let rtspUrl = camera.rtsp_url || '';
  if (!rtspUrl && discoveredCam && discoveredCam.rtsp_urls && discoveredCam.rtsp_urls.length > 0) {
    rtspUrl = discoveredCam.rtsp_urls[0];
  }
  if (!rtspUrl) {
    const connector = getConnector('rtsp-common');
    if (connector) {
      try {
        const probeResult = await connector.discover(ip, { username, password, rtspPort: port });
        if (probeResult.streams && probeResult.streams.length > 0) {
          rtspUrl = probeResult.streams[0].url;
          result.discovery.detected = true;
          result.discovery.protocol = 'rtsp';
        }
      } catch { /* ignore */ }
    }
  }

  if (!rtspUrl) {
    result.failures.push('no_rtsp_url_found');
    return result;
  }

  // 3. RTSP verification
  const rtspWithCreds = embedCredentials(rtspUrl, username, password);
  let rtspProbe;
  try {
    rtspProbe = await probeRtspUrl(rtspWithCreds, { username, password, timeoutMs: COMPAT_TIMEOUT_MS });
    result.credentials.valid = rtspProbe.reachable && !rtspProbe.auth_required;
    if (!rtspProbe.reachable) {
      result.failures.push(`rtsp_unreachable: ${rtspProbe.host || ip}:${rtspProbe.port || port}`);
    } else if (rtspProbe.auth_required) {
      result.failures.push('rtsp_auth_failed');
    } else if (!rtspProbe.stream_available) {
      result.failures.push('rtsp_stream_not_available');
    }
    logger.info('compat.onvif.rtsp_probe_ok', { camera_id: camera.id, reachable: rtspProbe.reachable, stream_available: rtspProbe.stream_available });
  } catch (err) {
    result.failures.push(`rtsp_probe_failed: ${err.message}`);
    return result;
  }

  if (!rtspProbe.reachable || rtspProbe.auth_required || !rtspProbe.stream_available) {
    return result;
  }

  result.video.supported = true;
  result.media.rtsp = true;

  // 4. MediaMTX registration
  try {
    await mediamtxClient.addOrUpdateCameraPath(camera.id, rtspWithCreds);
    result.media.mediamtx = true;
    logger.info('compat.onvif.mediamtx_ok', { camera_id: camera.id });
  } catch (err) {
    result.failures.push(`mediamtx_publish_failed: ${err.message}`);
  }

  // 5. HLS
  const hlsUrl = `https://hls.dnd-monitoring.com/${encodeURIComponent(camera.id)}/index.m3u8`;
  try {
    const hlsCheck = await fetchUrl(hlsUrl);
    result.media.hls = hlsCheck.status === 200;
    if (!result.media.hls) {
      result.failures.push(`hls_unavailable: HTTP ${hlsCheck.status}`);
    }
    logger.info('compat.onvif.hls_ok', { camera_id: camera.id, status: hlsCheck.status });
  } catch (err) {
    result.failures.push(`hls_check_failed: ${err.message}`);
  }

  // 6. AI frame availability
  try {
    const frame = await _extractFrameFromRtsp(rtspWithCreds);
    result.ai.frame_source_available = frame !== null;
    if (!result.ai.frame_source_available) {
      result.failures.push('ai_frame_extraction_failed');
    }
    logger.info('compat.onvif.ai_frame_ok', { camera_id: camera.id, frame_size: frame ? frame.length : 0 });
  } catch (err) {
    result.ai.frame_source_available = false;
    result.failures.push(`ai_frame_failed: ${err.message}`);
  }

  // 7. Audio/talkdown - ONVIF audio not yet implemented
  result.audio.supported = false;
  result.audio.protocol = null;
  result.failures.push('talkdown_not_supported');

  return result;
}

// ── Unknown camera ─────────────────────────────────────────────────────────

async function checkUnknownCompatibility(camera, logger) {
  const result = {
    discovery: { detected: false, protocol: 'unknown' },
    credentials: { valid: false },
    video: { supported: false, codec: null, width: null, height: null, fps: null },
    media: { rtsp: false, mediamtx: false, hls: false },
    ai: { frame_source_available: false },
    audio: { supported: false, protocol: null },
    failures: ['camera_type_unknown'],
  };

  // Try generic RTSP probe as last resort
  if (camera.rtsp_url) {
    const username = camera.rtsp_username || '';
    const encryptedPassword = camera.rtsp_password_encrypted || '';
    let password = '';
    try {
      const decrypted = encryptedPassword ? decrypt(encryptedPassword) : '';
      try {
        const creds = JSON.parse(decrypted);
        password = creds.password || '';
      } catch {
        password = decrypted;
      }
    } catch {
      result.failures.push('credential_decrypt_failed');
      return result;
    }

    const rtspWithCreds = embedCredentials(camera.rtsp_url, username, password);
    try {
      const probe = await probeRtspUrl(rtspWithCreds, { username, password, timeoutMs: COMPAT_TIMEOUT_MS });
      if (probe.reachable && !probe.auth_required && probe.stream_available) {
        result.discovery.detected = true;
        result.discovery.protocol = 'rtsp';
        result.credentials.valid = true;
        result.video.supported = true;
        result.media.rtsp = true;
        result.failures = ['talkdown_not_supported'];
        logger.info('compat.unknown.rtsp_ok', { camera_id: camera.id });
      } else {
        result.failures.push('unknown_rtsp_probe_failed');
      }
    } catch (err) {
      result.failures.push(`unknown_probe_failed: ${err.message}`);
    }
  }

  return result;
}

// ── Overall status ─────────────────────────────────────────────────────────

function computeOverallStatus(result) {
  if (result.failures.length === 0) {
    return 'PRODUCTION_READY';
  }
  if (result.video.supported && result.media.hls && result.ai.frame_source_available) {
    return 'VIDEO_ONLY';
  }
  return 'BLOCKED';
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run full compatibility check for a camera.
 *
 * @param {object} camera - cameras row from DB (id, connection_type, ip, port, rtsp_url, rtsp_username, rtsp_password_encrypted, organization_id)
 * @param {object} [options]
 * @param {string} [options.hlsBaseUrl] - override HLS base URL
 * @returns {Promise<object>} compatibility result
 */
async function checkCameraCompatibility(camera, options = {}) {
  if (!camera || !camera.id) {
    return {
      camera: camera || {},
      discovery: { detected: false, protocol: null },
      credentials: { valid: false },
      video: { supported: false, codec: null, width: null, height: null, fps: null },
      media: { rtsp: false, mediamtx: false, hls: false },
      ai: { frame_source_available: false },
      audio: { supported: false, protocol: null },
      overall: 'BLOCKED',
      failures: ['camera_not_found'],
    };
  }

  const logger = makeLogger(camera.id);
  const connType = camera.connection_type;

  let result;
  if (connType === 'dvrip') {
    result = await checkDvripCompatibility(camera, logger);
  } else if (connType === 'onvif' || camera.rtsp_url) {
    result = await checkOnvifRtspCompatibility(camera, logger);
  } else {
    result = await checkUnknownCompatibility(camera, logger);
  }

  result.camera = {
    id: camera.id,
    connection_type: connType,
    ip: camera.ip,
    port: camera.port,
    organization_id: camera.organization_id,
  };
  result.overall = computeOverallStatus(result);

  // Sanitize: never leak credentials
  if (result.camera && result.camera.rtsp_url) {
    result.camera.rtsp_url = maskedUrl(result.camera.rtsp_url);
  }

  return result;
}

module.exports = {
  checkCameraCompatibility,
  COMPAT_TIMEOUT_MS,
  FRAME_EXTRACT_TIMEOUT_MS,
  HLS_CHECK_TIMEOUT_MS,
  fetchUrl,
  get extractFrameFromRtsp() { return _extractFrameFromRtsp; },
  set extractFrameFromRtsp(fn) { _extractFrameFromRtsp = fn; },
};
