'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

let fetchResponses = new Map();
let spawnResponses = [];
let dvripAuthResults = new Map();
let dvripVideoResults = new Map();
let mediamtxResults = new Map();
let twoWayAudioResults = new Map();
let onvifResults = new Map();

function resetGlobals() {
  fetchResponses = new Map();
  spawnResponses = [];
  dvripAuthResults = new Map();
  dvripVideoResults = new Map();
  mediamtxResults = new Map();
  twoWayAudioResults = new Map();
  onvifResults = new Map();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const resp = fetchResponses.get(url);
  if (resp) {
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => resp.body || '' };
  }
  return { ok: false, status: 404, text: async () => '' };
};

const originalSpawn = require('child_process').spawn;
require('child_process').spawn = (cmd, args) => {
  const key = `${cmd}:${args[args.length - 1]}`;
  const resp = spawnResponses.find((r) => r.key === key) || { close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2) };
  let dataEmitted = false;
  return {
    stdout: { on: (event, cb) => { if (event === 'data' && resp.data && !dataEmitted) { dataEmitted = true; setTimeout(() => cb(resp.data), 5); } } },
    stderr: { on: () => {} },
    on: (event, cb) => { if (event === 'close') setTimeout(() => cb(resp.close), 10); },
    kill: () => {},
    stdin: { destroy: () => {}, writable: true },
  };
};

function patchLibModules() {
  resetGlobals();
  const patches = {
    '../lib/_xiongmai_dvrip': {
      XiongmaiDvripAdapter: class MockAdapter {
        constructor(ip, port) { this.ip = ip; this.port = port; this.sessionId = 12345; this.socket = { destroyed: false }; }
        async authenticate(username, password) {
          const key = `${this.ip}:${this.port}:${username}:${password}`;
          const result = dvripAuthResults.get(key);
          if (result && result.error) throw new Error(result.error);
          return { Ret: 100, SessionId: 12345, AliveInterval: 30 };
        }
        stopKeepalive() {}
      },
      DVRIP_PORT: 34567,
    },
    '../lib/_xiongmai_video': {
      XiongmaiVideoStream: class MockVideoStream {
        constructor(ip, port) { this.ip = ip; this.port = port; }
        async startStreaming(socket, sessionId, opts, onFrame, onError) {
          const key = `${this.ip}:${this.port}`;
          const result = dvripVideoResults.get(key);
          if (result && result.error) { onError(new Error(result.error)); return; }
          onFrame({ kind: 'video', data: Buffer.from('fakevideo'), codec: 'h265', width: 1920, height: 1080, fps: 25 });
        }
        stopStreaming() {}
      },
    },
    '../lib/_mediamtx_client': {
      addOrUpdateCameraPath: async () => ({ status: 200 }),
      getPathStatus: async () => ({ ready: true }),
    },
    '../lib/_person_detection': { loadModel: async () => true, detectPersons: async () => ({ persons: [], inferenceTimeMs: 10 }) },
    '../lib/_two_way_audio': {
      detectTwoWayAudioCapability: (camera) => {
        const result = twoWayAudioResults.get(camera.id);
        if (result) return result;
        return { supported: true, protocol: 'optalk' };
      },
    },
    '../lib/_onvif_client': {
      discoverCamera: async (ip, port) => {
        const result = onvifResults.get(`${ip}:${port}`);
        if (result) return result;
        return { manufacturer: 'TestMfg', model: 'TestModel', onvif_supported: true, rtsp_urls: [`rtsp://${ip}:554/stream1`] };
      },
    },
    '../lib/_rtsp_probe': {
      probeRtspUrl: async (url) => {
        const result = probeResults.get(url);
        if (result) return result;
        return { reachable: true, auth_required: false, stream_available: true };
      },
      embedCredentials: (url, u, p) => url,
    },
    '../lib/_camera_connectors': {
      getConnector: () => ({
        discover: async () => ({ onvif_supported: false, dvrip_supported: false, streams: [{ url: 'rtsp://192.168.1.100:554/stream1', stream_available: true }] }),
      }),
    },
    '../lib/_crypto': {
      decrypt: (blob) => {
        try { const parsed = JSON.parse(blob); return parsed.password || ''; }
        catch { return blob; }
      },
    },
    '../lib/_logger': {
      makeLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
  };

  for (const [path, exports] of Object.entries(patches)) {
    require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports };
  }
  delete require.cache[require.resolve('../lib/_camera_compatibility')];
}

describe('Camera Compatibility Gate', () => {
  beforeEach(() => { patchLibModules(); });
  afterEach(() => { delete require.cache[require.resolve('../lib/_camera_compatibility')]; });

  test('debug DVRIP', async () => {
    fetchResponses.set('https://hls.dnd-monitoring.com/dvrip-cam-1/index.m3u8', { status: 200, body: '#EXTM3U' });
    spawnResponses.push({ key: 'ffmpeg:-', close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2) });

    const { checkCameraCompatibility } = require('../lib/_camera_compatibility');
    const camera = {
      id: 'dvrip-cam-1',
      connection_type: 'dvrip',
      ip: '192.168.1.10',
      port: 34567,
      rtsp_username: 'admin',
      rtsp_password_encrypted: JSON.stringify({ username: 'admin', password: 'realPass' }),
      organization_id: 'org-1',
    };

    const result = await checkCameraCompatibility(camera);
    console.log('RESULT:', JSON.stringify(result, null, 2));
    console.log('FAILURES:', result.failures);
  });
});
