'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

function patchLibModules() {
  const patches = {
    '../lib/_xiongmai_dvrip': { XiongmaiDvripAdapter: class {}, DVRIP_PORT: 34567 },
    '../lib/_xiongmai_video': { XiongmaiVideoStream: class {} },
    '../lib/_mediamtx_client': { addOrUpdateCameraPath: async () => ({}), getPathStatus: async () => ({}) },
    '../lib/_person_detection': { loadModel: async () => true, detectPersons: async () => ({}) },
    '../lib/_two_way_audio': { detectTwoWayAudioCapability: () => ({}) },
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

  test('debug module loading', async () => {
    const mod = require('../lib/_camera_compatibility');
    console.log('module exports keys:', Object.keys(mod));
    console.log('extractFrameFromRtsp:', typeof mod.extractFrameFromRtsp);
    console.log('checkCameraCompatibility:', typeof mod.checkCameraCompatibility);
  });
});
