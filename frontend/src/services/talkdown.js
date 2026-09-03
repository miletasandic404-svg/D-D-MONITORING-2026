/**
 * Talkdown client for the Dashboard "Trigger Talkdown" button.
 *
 * Reuses the same camera_stream_tokens authorization model as the HLS
 * viewer (POST /api/camera-views). The token is passed to the worker
 * HTTP API (workers/two-way-audio-api.js) on every request, and the
 * worker validates it against the database.
 *
 * Architecture (no MediaMTX in the audio path):
 *   browser mic → /api/audio/:id/start|send|stop  (worker HTTP API)
 *                              ↓
 *              XiongmaiDvripAdapter (TCP/OPTalk)
 *                              ↓
 *                       camera speaker
 *
 * Lifecycle of a single talkdown:
 *   1. capabilityCheck(camera, token) — GET /capabilities
 *   2. startSession(camera, token)    — POST /start (server side
 *      hard-timeout 5s; server returns 504 if OPTalk handshake hangs)
 *   3. sendFrame(camera, token, base64Pcm) — POST /send (40 ms PCM
 *      frames). Worker drops frames if a previous send is still
 *      in-flight; the browser must keep producing frames.
 *   4. stopSession(camera, token)     — POST /stop
 *
 * If the audio API base URL is not configured (VITE_AUDIO_API_BASE_URL
 * missing), every method rejects with a clear error so the UI can
 * render "Two-way audio not configured for this deployment".
 */

export const AUDIO_API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AUDIO_API_BASE_URL) || '';

export const TALKDOWN_DEFAULT_DURATION_MS = 5000;
export const TALKDOWN_FRAME_SAMPLES = 320; // 40 ms @ 8 kHz
export const TALKDOWN_SAMPLE_RATE = 8000;

function apiBase() {
  return AUDIO_API_BASE_URL.replace(/\/$/, '');
}

function url(action, cameraId, token) {
  if (!apiBase()) {
    throw new Error('Audio API base URL is not configured (VITE_AUDIO_API_BASE_URL)');
  }
  return `${apiBase()}/api/audio/${encodeURIComponent(cameraId)}/${action}?token=${encodeURIComponent(token)}`;
}

async function readError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
  const err = new Error(msg);
  err.status = res.status;
  err.body = body;
  return err;
}

export function isTalkdownConfigured() {
  return Boolean(apiBase());
}

export async function capabilityCheck(camera, token) {
  if (!isTalkdownConfigured()) {
    return { supported: false, reason: 'Audio API not configured (VITE_AUDIO_API_BASE_URL missing)' };
  }
  const res = await fetch(url('capabilities', camera.id, token), { method: 'GET' });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function startSession(camera, token) {
  const res = await fetch(url('start', camera.id, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function sendFrame(camera, token, base64Pcm) {
  const res = await fetch(url('send', camera.id, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: base64Pcm }),
  });
  // 202 = frame was dropped by server (backpressure); not an error.
  if (!res.ok && res.status !== 202) throw await readError(res);
  return res.json().catch(() => ({}));
}

export async function stopSession(camera, token) {
  const res = await fetch(url('stop', camera.id, token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

// ── Audio capture / encoding (extracted for reuse and test) ──────────────

/**
 * Convert a Float32Array in [-1, 1] to a base64-encoded 16-bit signed
 * little-endian PCM buffer. The worker expects a 320-sample (40 ms
 * @ 8 kHz) frame.
 */
export function float32ToBase64Pcm16Le(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const v = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  let binary = '';
  const bytes = new Uint8Array(int16.buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Build a pipeline that:
 *   - opens a microphone via getUserMedia
 *   - resamples to 8 kHz 16-bit mono
 *   - calls onFrame(base64Pcm) per 40 ms frame
 * Returns a stop() that closes the AudioContext, stops the mic, and
 * detaches listeners. Safe to call multiple times.
 */
export function createMicPipeline({ onFrame, onError, targetSampleRate = TALKDOWN_SAMPLE_RATE, frameSamples = TALKDOWN_FRAME_SAMPLES }) {
  let audioContext = null;
  let source = null;
  let processor = null;
  let micStream = null;
  let resampler = null;
  let stopped = false;
  let inputSampleRate = 0;

  function makeResampler(inputRate) {
    if (inputRate === targetSampleRate) return null;
    const ratio = inputRate / targetSampleRate;
    const buffer = new Float32Array(4096);
    let offset = 0;
    return {
      push(inputFrame) {
        for (let i = 0; i < inputFrame.length; i++) {
          buffer[offset++] = inputFrame[i];
          if (offset >= buffer.length) {
            const out = new Float32Array(frameSamples);
            for (let j = 0; j < frameSamples; j++) {
              const srcIdx = Math.floor(j * ratio);
              out[j] = srcIdx < buffer.length ? buffer[srcIdx] : 0;
            }
            buffer.copyWithin(0, frameSamples);
            offset = Math.max(0, offset - frameSamples);
            return out;
          }
        }
        return null;
      },
    };
  }

  async function start() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('Microphone API not available in this browser context');
    }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio API not supported in this browser');
    audioContext = new Ctx({ latencyHint: 'interactive' });
    inputSampleRate = audioContext.sampleRate;
    resampler = makeResampler(inputSampleRate);
    source = audioContext.createMediaStreamSource(micStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (stopped) return;
      const input = e.inputBuffer.getChannelData(0);
      if (inputSampleRate === targetSampleRate) {
        for (let i = 0; i + frameSamples <= input.length; i += frameSamples) {
          try { onFrame(float32ToBase64Pcm16Le(input.slice(i, i + frameSamples))); }
          catch (err) { onError?.(err); }
        }
      } else if (resampler) {
        for (let i = 0; i < input.length; i++) {
          const frame = resampler.push([input[i]]);
          if (frame) {
            try { onFrame(float32ToBase64Pcm16Le(frame)); }
            catch (err) { onError?.(err); }
          }
        }
      }
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try { if (processor) { processor.disconnect(); processor.onaudioprocess = null; } } catch {}
    try { if (source) source.disconnect(); } catch {}
    try { if (audioContext) audioContext.close().catch(() => {}); } catch {}
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch {}
    audioContext = null;
    source = null;
    processor = null;
    micStream = null;
    resampler = null;
  }

  return { start, stop, get stopped() { return stopped; } };
}
