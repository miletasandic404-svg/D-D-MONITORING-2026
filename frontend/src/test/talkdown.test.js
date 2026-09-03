/**
 * Unit tests for the Talkdown client service.
 *
 * Covers:
 *  - float32ToBase64Pcm16Le correctness (zero, max, min, rounding)
 *  - createMicPipeline frame production at the target rate
 *  - createMicPipeline resampling path (48 kHz -> 8 kHz)
 *  - createMicPipeline stop() is idempotent and tears down all handles
 *  - createMicPipeline surfaces getUserMedia failures
 *  - URL helper rejects unconfigured deployments
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  float32ToBase64Pcm16Le,
  createMicPipeline,
  TALKDOWN_FRAME_SAMPLES,
} from '../services/talkdown.js';

function base64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

describe('float32ToBase64Pcm16Le', () => {
  it('converts 0.0 to 0x0000', () => {
    const f = new Float32Array([0]);
    const b = base64ToInt16(float32ToBase64Pcm16Le(f));
    expect(b.length).toBe(1);
    expect(b[0]).toBe(0);
  });

  it('converts 1.0 to 0x7fff (positive max)', () => {
    const f = new Float32Array([1.0]);
    const b = base64ToInt16(float32ToBase64Pcm16Le(f));
    expect(b[0]).toBe(0x7fff);
  });

  it('converts -1.0 to -0x8000 (negative min)', () => {
    const f = new Float32Array([-1.0]);
    const b = base64ToInt16(float32ToBase64Pcm16Le(f));
    expect(b[0]).toBe(-0x8000);
  });

  it('clamps values outside [-1, 1]', () => {
    const f = new Float32Array([2.0, -2.0]);
    const b = base64ToInt16(float32ToBase64Pcm16Le(f));
    expect(b[0]).toBe(0x7fff);
    expect(b[1]).toBe(-0x8000);
  });

  it('produces 2 bytes per sample (16-bit little-endian)', () => {
    const f = new Float32Array(TALKDOWN_FRAME_SAMPLES);
    const b64 = float32ToBase64Pcm16Le(f);
    const bin = atob(b64);
    expect(bin.length).toBe(TALKDOWN_FRAME_SAMPLES * 2);
  });
});

describe('createMicPipeline', () => {
  /** Build a minimal Web Audio stand-in. */
  function makeAudioEnv({ sampleRate, onaudioprocessTrigger }) {
    const processors = [];
    const sources = [];
    const fakeContext = {
      sampleRate,
      destination: { name: 'destination' },
      createMediaStreamSource: (stream) => {
        const node = { type: 'source', stream, connect: vi.fn() };
        sources.push(node);
        return node;
      },
      createScriptProcessor: (bufSize, inCh, outCh) => {
        const node = {
          type: 'processor', bufSize, inCh, outCh,
          onaudioprocess: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        processors.push(node);
        return node;
      },
      close: vi.fn(() => Promise.resolve()),
    };
    function AudioContextCtor() { return fakeContext; }
    return { AudioContext: AudioContextCtor, fakeContext, processors, sources };
  }

  function makeMicStream() {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    return {
      getTracks: () => tracks,
    };
  }

  let getUserMedia;

  beforeEach(() => {
    getUserMedia = vi.fn(async () => makeMicStream());
    global.navigator = {
      mediaDevices: { getUserMedia },
    };
  });

  afterEach(() => {
    delete global.navigator;
    delete global.window;
  });

  it('emits one 40 ms frame per onaudioprocess call at 8 kHz', async () => {
    const env = makeAudioEnv({ sampleRate: 8000 });
    global.window = { AudioContext: env.AudioContext, webkitAudioContext: env.AudioContext };

    const onFrame = vi.fn();
    const pipeline = createMicPipeline({ onFrame });
    await pipeline.start();
    expect(env.processors.length).toBe(1);
    const proc = env.processors[0];

    // Simulate one full buffer of 8 kHz audio (4096 samples = 12.8 frames).
    const input = new Float32Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = (i % 320) / 320;
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => input } });

    // 4096 / 320 = 12 full frames; 16 remainder samples are dropped.
    expect(onFrame).toHaveBeenCalledTimes(12);
    for (const call of onFrame.mock.calls) {
      const b64 = call[0];
      const int16 = base64ToInt16(b64);
      expect(int16.length).toBe(TALKDOWN_FRAME_SAMPLES);
    }
  });

  it('resamples 48 kHz -> 8 kHz and produces 40 ms frames', async () => {
    const env = makeAudioEnv({ sampleRate: 48000 });
    global.window = { AudioContext: env.AudioContext, webkitAudioContext: env.AudioContext };

    const onFrame = vi.fn();
    const pipeline = createMicPipeline({ onFrame });
    await pipeline.start();
    const proc = env.processors[0];

    // 11520 input samples at 48 kHz. After the internal resampler
    // fills its 4096-sample buffer it emits one 40 ms frame per 320
    // new input samples, yielding at least one frame. We assert at
    // least one frame was produced, and that every emitted frame is
    // exactly 320 samples (40 ms @ 8 kHz).
    const input = new Float32Array(11520);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((i / 48000) * 2 * Math.PI * 440);
    proc.onaudioprocess({ inputBuffer: { getChannelData: () => input } });

    expect(onFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of onFrame.mock.calls) {
      const int16 = base64ToInt16(call[0]);
      expect(int16.length).toBe(TALKDOWN_FRAME_SAMPLES);
    }
  });

  it('stop() is idempotent and releases context + tracks', async () => {
    const env = makeAudioEnv({ sampleRate: 8000 });
    global.window = { AudioContext: env.AudioContext, webkitAudioContext: env.AudioContext };

    const onFrame = vi.fn();
    const pipeline = createMicPipeline({ onFrame });
    await pipeline.start();

    const proc = env.processors[0];
    const micStream = (env.sources[0].stream);

    pipeline.stop();
    pipeline.stop(); // idempotent

    expect(proc.disconnect).toHaveBeenCalled();
    expect(proc.onaudioprocess).toBeNull();
    expect(env.fakeContext.close).toHaveBeenCalled();
    for (const t of micStream.getTracks()) {
      expect(t.stop).toHaveBeenCalled();
    }
    expect(pipeline.stopped).toBe(true);

    // Frames emitted after stop are ignored.
    const input = new Float32Array(640);
    if (typeof proc.onaudioprocess === 'function') {
      proc.onaudioprocess({ inputBuffer: { getChannelData: () => input } });
    }
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('surfaces getUserMedia failures to the caller', async () => {
    const env = makeAudioEnv({ sampleRate: 8000 });
    global.window = { AudioContext: env.AudioContext, webkitAudioContext: env.AudioContext };
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));

    const pipeline = createMicPipeline({ onFrame: vi.fn() });
    await expect(pipeline.start()).rejects.toThrow(/Permission denied/);
  });
});

describe('isTalkdownConfigured / URL helper', () => {
  it('rejects with a clear error when VITE_AUDIO_API_BASE_URL is missing', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', '');
    global.fetch = vi.fn();
    try {
      const { capabilityCheck } = await import('../services/talkdown.js');
      const caps = await capabilityCheck({ id: 'cam1' }, 'tok');
      expect(caps.supported).toBe(false);
      expect(caps.reason).toMatch(/VITE_AUDIO_API_BASE_URL/);
    } finally {
      delete global.fetch;
      vi.unstubAllEnvs();
    }
  });
});

describe('HTTP wrappers (with global fetch mock)', () => {
  // This block re-uses the module under test but with the env stubbed
  // *before* the module is read. We do that with vi.resetModules +
  // vi.stubEnv inside a dynamic import below.
  it('capabilityCheck parses { supported: true } when base URL configured', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', 'http://localhost:8890');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ supported: true, protocol: 'optalk' }),
    });
    global.fetch = fetchMock;
    try {
      const { capabilityCheck } = await import('../services/talkdown.js');
      const caps = await capabilityCheck({ id: 'cam1' }, 'tok');
      expect(caps.supported).toBe(true);
      const [called] = fetchMock.mock.calls[0];
      expect(called).toMatch(/^http:\/\/localhost:8890\/api\/audio\/cam1\/capabilities\?token=tok$/);
    } finally {
      delete global.fetch;
      vi.unstubAllEnvs();
    }
  });

  it('startSession POSTs and returns session_id', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', 'http://localhost:8890');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, session_id: 's1' }),
    });
    global.fetch = fetchMock;
    try {
      const { startSession } = await import('../services/talkdown.js');
      const r = await startSession({ id: 'cam1' }, 'tok');
      expect(r.session_id).toBe('s1');
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe('POST');
    } finally {
      delete global.fetch;
      vi.unstubAllEnvs();
    }
  });

  it('sendFrame treats HTTP 202 (backpressure drop) as success', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', 'http://localhost:8890');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 202,
      json: async () => ({ dropped: true }),
    });
    global.fetch = fetchMock;
    try {
      const { sendFrame } = await import('../services/talkdown.js');
      const r = await sendFrame({ id: 'cam1' }, 'tok', 'AAAA');
      expect(r.dropped).toBe(true);
    } finally {
      delete global.fetch;
      vi.unstubAllEnvs();
    }
  });

  it('stopSession POSTs and resolves', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', 'http://localhost:8890');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = fetchMock;
    try {
      const { stopSession } = await import('../services/talkdown.js');
      const r = await stopSession({ id: 'cam1' }, 'tok');
      expect(r.success).toBe(true);
    } finally {
      delete global.fetch;
      vi.unstubAllEnvs();
    }
  });
});
