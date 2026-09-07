'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

let fetchResponses = new Map();
let spawnResponses = [];
let twoWayAudioResults = new Map();

function resetGlobals() {
  fetchResponses = new Map();
  spawnResponses = [];
  twoWayAudioResults = new Map();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  console.log('[fetch] called:', url);
  const resp = fetchResponses.get(url);
  if (resp) {
    console.log('[fetch] found mock:', resp.status);
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => resp.body || '' };
  }
  console.log('[fetch] no mock, returning 404');
  return { ok: false, status: 404, text: async () => '' };
};

const originalSpawn = require('child_process').spawn;
require('child_process').spawn = (cmd, args) => {
  console.log('[spawn] called:', cmd);
  const key = `${cmd}:${args[args.length - 1]}`;
  const resp = spawnResponses.find((r) => r.key === key) || { close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2) };
  let dataEmitted = false;
  return {
    stdout: { on: (event, cb) => { if (event === 'data' && resp.data && !dataEmitted) { dataEmitted = true; cb(resp.data); } } },
    stderr: { on: () => {} },
    on: (event, cb) => { if (event === 'close') setTimeout(() => cb(resp.close), 0); },
    kill: () => {},
    stdin: { destroy: () => {}, writable: true },
  };
};

function patchLibModules() {
  resetGlobals();
  const patches = {
    '../lib/_xiongmai_dvrip': { XiongmaiDvripAdapter: class {}, DVRIP_PORT: 34567 },
    '../lib/_xiongmai_video': { XiongmaiVideoStream: class {} },
    '../lib/_mediamtx_client': { addOrUpdateCameraPath: async () => ({}), getPathStatus: async () => ({}) },
    '../lib/_person_detection': { loadModel: async () => true, detectPersons: async () => ({}) },
    '../lib/_two_way_audio': { detectTwoWayAudioCapability: () => ({ supported: false, protocol: null }) },
    '../lib/_onvif_client': { discoverCamera: async () => ({ manufacturer: 'TestMfg', model: 'TestModel', onvif_supported: true, rtsp_urls: ['rtsp://192.168.1.20:554/stream1'] }) },
    '../lib/_rtsp_probe': { probeRtspUrl: async () => ({ reachable: true, auth_required: false, stream_available: true }), embedCredentials: (u) => u },
    '../lib/_camera_connectors': { getConnector: () => ({ discover: async () => ({}) }) },
    '../lib/_crypto': { decrypt: (b) => b },
    '../lib/_logger': { makeLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
  };
  for (const [path, exports] of Object.entries(patches)) {
    require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports };
  }
  delete require.cache[require.resolve('../lib/_camera_compatibility')];
}

describe('Camera Compatibility Gate - ONVIF DEBUG', () => {
  beforeEach(() => { patchLibModules(); });
  afterEach(() => { delete require.cache[require.resolve('../lib/_camera_compatibility')]; });

  test('ONVIF camera without talkdown', async () => {
    twoWayAudioResults.set('onvif-cam-1', { supported: false, protocol: null });
    fetchResponses.set('https://hls.dnd-monitoring.com/onvif-cam-1/index.m3u8', { status: 200, body: '#EXTM3U' });
    spawnResponses.push({ key: 'ffmpeg:-', close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2) });

    const { checkCameraCompatibility } = require('../lib/_camera_compatibility');

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

    const result = await checkCameraCompatibility(camera);
    console.log('\nONVIF RESULT:', JSON.stringify(result, null, 2));
    console.log('Expected: VIDEO_ONLY');
    console.log('Actual:', result.overall);
  });
});
