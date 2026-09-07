'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

function patchLibModules() {
  const patches = {
    '../lib/_xiongmai_dvrip': { XiongmaiDvripAdapter: class { constructor() { this.socket = {}; this.sessionId = 12345; } authenticate() { return { SessionId: 12345 }; } stopKeepalive() {} }, DVRIP_PORT: 34567 },
    '../lib/_xiongmai_video': { XiongmaiVideoStream: class { startStreaming(s, sid, opts, frameCb, errCb) { if (frameCb) frameCb({ kind: 'video', data: Buffer.alloc(100), codec: 'h264' }); } } },
    '../lib/_mediamtx_client': { addOrUpdateCameraPath: async () => ({}), getPathStatus: async () => ({}) },
    '../lib/_person_detection': { loadModel: async () => true, detectPersons: async () => ({}) },
    '../lib/_two_way_audio': { detectTwoWayAudioCapability: () => ({ supported: true, protocol: 'test' }) },
    '../lib/_onvif_client': { discoverCamera: async () => ({}) },
    '../lib/_rtsp_probe': { probeRtspUrl: async () => ({}), embedCredentials: (u) => u },
    '../lib/_camera_connectors': { getConnector: () => ({ discover: async () => ({}) }) },
    '../lib/_crypto': { decrypt: (b) => b },
    '../lib/_logger': { makeLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
  };
  for (const [path, exports] of Object.entries(patches)) {
    require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports };
  }
  delete require.cache[require.resolve('../lib/_camera_compatibility')];
}

describe('Camera Compatibility Gate', () => {
  beforeEach(() => { patchLibModules(); });
  afterEach(() => { delete require.cache[require.resolve('../lib/_camera_compatibility')]; });

  test('debug: patch extractFrameFromRtsp', async () => {
    const mod = require('../lib/_camera_compatibility');
    
    // Replace extractFrameFromRtsp with a mock
    mod.extractFrameFromRtsp = async () => Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2);
    
    // Mock global fetch for HLS check
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('hls.dnd-monitoring.com')) {
        return { status: 200, text: async () => '#EXTM3U' };
      }
      return { status: 404, text: async () => null };
    };

    const camera = {
      id: 'test-cam',
      connection_type: 'dvrip',
      ip: '192.168.1.10',
      port: 34567,
      rtsp_username: 'admin',
      rtsp_password_encrypted: JSON.stringify({ username: 'admin', password: 'pass' }),
      organization_id: 'org-1',
    };

    const result = await mod.checkCameraCompatibility(camera);
    console.log('RESULT:', JSON.stringify(result, null, 2));
    globalThis.fetch = originalFetch;
    assert.equal(result.overall, 'PRODUCTION_READY');
  });
});
