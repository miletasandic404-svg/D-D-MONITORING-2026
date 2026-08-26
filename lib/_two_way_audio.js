'use strict';
/**
 * Camera-agnostic Two-Way Audio adapter layer.
 *
 * Auto-detects speaker/talkback capability per camera type at runtime.
 * No Xiongmai-only coupling — the factory dispatches based on
 * camera.connection_type and can be extended for ONVIF / RTSP cameras.
 *
 * Capability detection rules:
 *   connection_type='dvrip'  → OPTalk protocol (Xiongmai DVRIP port 34567)
 *   connection_type='onvif'  → ONVIF AudioOutput service (not yet probed)
 *   connection_type=null     → RTSP audio channel (SET_PARAMETER) (not yet probed)
 *
 * Adapter interface (every adapter implements):
 *   startTalk()   -> Promise<SessionInfo>
 *   sendAudioFrame(pcmBuffer) -> Promise<void>   (16-bit signed PCM, 8 kHz mono)
 *   stopTalk()    -> Promise<void>
 *   close()       -> void
 */

const { XiongmaiDvripAdapter, DVRIP_PORT } = require('./_xiongmai_dvrip');
const { decrypt } = require('./_crypto');
const net = require('net');
const { execFileSync } = require('child_process');
const { probeRtspUrl } = require('./_rtsp_probe');

// ── Constants ──────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 4000;
const SAMPLE_RATE = 8000;
const FRAME_SIZE_SAMPLES = 320; // 40 ms @ 8 kHz

// ── Capability detection ───────────────────────────────────────────────────

/**
 * Auto-detect whether a camera has a speaker / talkback capability.
 *
 * Detection strategy:
 * 1. If the camera was set up via the DVRIP wizard, `connection_type='dvrip'`
 *    and the Xiongmai connector already verified OPTalk support at setup
 *    time — we trust it.
 * 2. For ONVIF cameras we could probe the AudioOutput service, but that
 *    requires an authenticated ONVIF session (not implemented yet).
 * 3. For RTSP-only cameras we could probe for an audio track via
 *    DESCRIBE + SDP parsing, but that is not implemented yet.
 *
 * @param {object} camera  — row from the cameras table (at minimum: id, connection_type, rtsp_url)
 * @returns {{ supported: boolean, protocol: string|null, audio_format: string|null, reason: string|null }}
 */
function detectTwoWayAudioCapability(camera) {
  if (!camera || !camera.id) {
    return {
      supported: false,
      protocol: null,
      audio_format: null,
      audio_sample_rate: null,
      audio_frame_size: null,
      reason: 'camera not found',
    };
  }

  const connType = camera.connection_type;

  // ── DVRIP / Xiongmai ───────────────────────────────────────
  if (connType === 'dvrip') {
    return {
      supported: true,
      protocol: 'optalk',
      audio_format: 'G.711 A-law',
      audio_sample_rate: SAMPLE_RATE,
      audio_frame_size: FRAME_SIZE_SAMPLES,
      reason: null,
    };
  }

  // ── ONVIF ──────────────────────────────────────────────────
  // Future: probe ONVIF AudioOutput service. For now, cameras flagged
  // as ONVIF-only are not confirmed to have talkback.
  if (connType === 'onvif') {
    return {
      supported: false,
      protocol: 'onvif',
      audio_format: null,
      audio_sample_rate: null,
      audio_frame_size: null,
      reason: 'ONVIF AudioOutput probing not yet implemented',
    };
  }

  // ── RTSP / generic ────────────────────────────────────────
  // Future: probe RTSP DESCRIBE for an audio medias (a: lines in SDP).
  if (camera.rtsp_url) {
    return {
      supported: false,
      protocol: 'rtsp',
      audio_format: null,
      audio_sample_rate: null,
      audio_frame_size: null,
      reason: 'RTSP audio channel detection not yet implemented',
    };
  }

  // ── Fallback ───────────────────────────────────────────────
  return {
    supported: false,
    protocol: null,
    audio_format: null,
    audio_sample_rate: null,
    audio_frame_size: null,
    reason: 'No speaker/talkback detected for this camera type',
  };
}

// ── Adapter factory ────────────────────────────────────────────────────────

/**
 * Create a camera-specific Two-Way Audio adapter.
 *
 * The caller is responsible for calling `close()` on the returned adapter
 * when the session ends.
 *
 * @param {object} camera  — cameras row (id, connection_type, ip, port, rtsp_username, rtsp_password_encrypted, rtsp_url, ...)
 * @returns {Promise<object>}  — adapter with startTalk / sendAudioFrame / stopTalk / close
 * @throws {Error} if the camera's Two-Way Audio is not supported
 */
async function createTwoWayAudioAdapter(camera) {
  const caps = detectTwoWayAudioCapability(camera);
  if (!caps.supported) {
    throw new Error(
      `Two-Way Audio not supported for camera ${camera.id} (${camera.connection_type || 'rtsp'}): ${caps.reason}`
    );
  }

  switch (caps.protocol) {
    // ── DVRIP / OPTalk ────────────────────────────────────────
    case 'optalk': {
      const port = camera.port || DVRIP_PORT;
      const password = camera.rtsp_password_encrypted
        ? decrypt(camera.rtsp_password_encrypted)
        : '';

      const adapter = new XiongmaiDvripAdapter(camera.ip, port);
      await adapter.authenticate(camera.rtsp_username || '', password);

      return {
        type: 'dvrip',
        protocol: 'optalk',
        caps,
        adapter,

        async startTalk() {
          return await adapter.startTalk();
        },

        async sendAudioFrame(pcmData) {
          return await adapter.sendAudioFrame(pcmData);
        },

        async stopTalk() {
          return await adapter.stopTalk();
        },

        close() {
          adapter.close();
        },
      };
    }

    default:
      throw new Error(`Unsupported Two-Way Audio protocol: ${caps.protocol}`);
  }
}

module.exports = {
  detectTwoWayAudioCapability,
  createTwoWayAudioAdapter,
  SAMPLE_RATE,
  FRAME_SIZE_SAMPLES,
};
