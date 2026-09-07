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
let probeResults = new Map();

function resetGlobals() {
  fetchResponses = new Map();
  spawnResponses = [];
  dvripAuthResults = new Map();
  dvripVideoResults = new Map();
  mediamtxResults = new Map();
  twoWayAudioResults = new Map();
  onvifResults = new Map();
  probeResults = new Map();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  console.log('  [fetch] called with URL:', url);
  const resp = fetchResponses.get(url);
  if (resp) {
    console.log('  [fetch] found mock response:', resp.status);
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => resp.body || '' };
  }
  console.log('  [fetch] no mock, returning 404');
  return { ok: false, status: 404, text: async () => '' };
};

const originalSpawn = require('child_process').spawn;
require('child_process').spawn = (cmd, args) => {
  const key = `${cmd}:${args[args.length - 1]}`;
  const resp = spawnResponses.find((r) => r.key === key) || { close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2) };
  let dataEmitted = false;
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data' && resp.data && !dataEmitted) {
          dataEmitted = true;
          cb(resp.data);
        }
      },
    },
    stderr: { on: () => {} },
    on: (event, cb) => {
      if (event === 'close') {
        setTimeout(() => cb(resp.close), 0);
      }
    },
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
          if (result && result.frames) { for (const frame of result.frames) onFrame(frame); }
          else { onFrame({ kind: 'video', data: Buffer.from('fakevideo'), codec: 'h265', width: 1920, height: 1080, fps: 25 }); }
        }
        stopStreaming() {}
      },
    },
    '../lib/_mediamtx_client': {
      addOrUpdateCameraPath: async (cameraId, source) => {
        const result = mediamtxResults.get('addOrUpdateCameraPath');
        if (result && result.error) throw new Error(result.error);
        return { status: 200 };
      },
      getPathStatus: async () => ({ ready: true }),
    },
    '../lib/_person_detection': { loadModel: async () => true, detectPersons: async () => ({ persons: [], inferenceTimeMs: 10 }) },
    '../lib/_two_way_audio': {
      detectTwoWayAudioCapability: (camera) => {
        const key = camera.id;
        const result = twoWayAudioResults.get(key);
        if (result) return result;
        return { supported: true, protocol: 'optalk' };
      },
    },
    '../lib/_onvif_client': {
      discoverCamera: async (ip, port, username, password) => {
        const key = `${ip}:${port}`;
        const result = onvifResults.get(key);
        if (result) return result;
        return { manufacturer: 'TestMfg', model: 'TestModel', onvif_supported: true, rtsp_urls: [`rtsp://${ip}:554/stream1`] };
      },
    },
    '../lib/_rtsp_probe': {
      probeRtspUrl: async (url, opts) => {
        console.log('  [probeRtspUrl] called with URL:', url);
        const result = probeResults.get(url);
        if (result) {
          console.log('  [probeRtspUrl] found mock result');
          return result;
        }
        console.log('  [probeRtspUrl] no mock, returning default');
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

describe('Camera Compatibility Gate - ROOT CAUSE DEBUG', () => {
  beforeEach(() => { patchLibModules(); });
  afterEach(() => { delete require.cache[require.resolve('../lib/_camera_compatibility')]; });

  test('debug 1: DVRIP valid credentials - trace every step', async () => {
    const mod = require('../lib/_camera_compatibility');
    mod.extractFrameFromRtsp = async () => Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2);
    fetchResponses.set('https://hls.dnd-monitoring.com/dvrip-cam-1/index.m3u8', { status: 200, body: '#EXTM3U' });

    const camera = {
      id: 'dvrip-cam-1',
      connection_type: 'dvrip',
      ip: '192.168.1.10',
      port: 34567,
      rtsp_username: 'admin',
      rtsp_password_encrypted: JSON.stringify({ username: 'admin', password: 'realPass' }),
      organization_id: 'org-1',
    };

    console.log('\n=== TEST 1: DVRIP valid credentials ===');
    const result = await mod.checkCameraCompatibility(camera);
    console.log('overall:', result.overall);
    console.log('failures:', JSON.stringify(result.failures));
  });

  test('debug 2: ONVIF no talkdown - trace probeRtspUrl', async () => {
    twoWayAudioResults.set('onvif-cam-1', { supported: false, protocol: null });
    fetchResponses.set('https://hls.dnd-monitoring.com/onvif-cam-1/index.m3u8', { status: 200, body: '#EXTM3U' });
    probeResults.set('rtsp://192.168.1.20:554/stream1', { reachable: true, auth_required: false, stream_available: true });

    const mod = require('../lib/_camera_compatibility');
    mod.extractFrameFromRtsp = async () => Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2);

    const camera = {
      id: 'onvif-cam-1',
      connection_type: 'onvif',
      ip: '192.168.1.20',
      port: 80,
      rtsp_username: 'admin',
      rtsp_password_encrypted: JSON.stringify({ username: 'admin', password: 'pass' }),
      rtsp_url: 'rtsp://192.168.1.20:554/stream1',
      organization_id: 'org-1',
    };

    console.log('\n=== TEST 2: ONVIF no talkdown ===');
    const result = await mod.checkCameraCompatibility(camera);
    console.log('overall:', result.overall);
    console.log('failures:', JSON.stringify(result.failures));
  });

  test('debug 3: HLS failure - should reach HLS step', async () => {
    fetchResponses.set('https://hls.dnd-monitoring.com/onvif-cam-hls/index.m3u8', { status: 404, body: 'Not Found' });
    probeResults.set('rtsp://192.168.1.20:554/stream1', { reachable: true, auth_required: false, stream_available: true });

    const mod = require('../lib/_camera_compatibility');
    mod.extractFrameFromRtsp = async () => Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2);

    const camera = {
      id: 'onvif-cam-hls',
      connection_type: 'onvif',
      ip: '192.168.1.20',
      port: 80,
      rtsp_username: 'admin',
      rtsp_password_encrypted: JSON.stringify({ username: 'admin', password: 'pass' }),
      rtsp_url: 'rtsp://192.168.1.20:554/stream1',
      organization_id: 'org-1',
    };

    console.log('\n=== TEST 3: HLS failure ===');
    const result = await mod.checkCameraCompatibility(camera);
    console.log('overall:', result.overall);
    console.log('media.hls:', result.media.hls);
    console.log('failures:', JSON.stringify(result.failures));
  });

  test('debug 4: Legacy plaintext password', async () => {
    fetchResponses.set('https://hls.dnd-monitoring.com/dvrip-cam-legacy/index.m3u8', { status: 200, body: '#EXTM3U' });

    const mod = require('../lib/_camera_compatibility');
    mod.extractFrameFromRtsp = async () => Buffer.alloc(200, 0xFF).fill(0xD8, 0, 1).fill(0xE0, 1, 2);

    const camera = {
      id: 'dvrip-cam-legacy',
      connection_type: 'dvrip',
      ip: '192.168.1.10',
      port: 34567,
      rtsp_username: 'admin',
      rtsp_password_encrypted: 'plainLegacyPassword',
      organization_id: 'org-1',
    };

    console.log('\n=== TEST 4: Legacy plaintext password ===');
    const result = await mod.checkCameraCompatibility(camera);
    console.log('overall:', result.overall);
    console.log('failures:', JSON.stringify(result.failures));
  });
});
