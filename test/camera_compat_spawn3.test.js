'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

let spawnCalls = [];
const originalSpawn = require('child_process').spawn;

require('child_process').spawn = function(cmd, args) {
  spawnCalls.push({ cmd, args });
  console.log('GLOBAL MOCK: spawn called');
  const resp = { close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2) };
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
  spawnCalls = [];
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

  test('debug: verify childProcess.spawn is mocked', async () => {
    const mod = require('../lib/_camera_compatibility');
    const childProcess = require('child_process');
    console.log('childProcess.spawn === originalSpawn:', childProcess.spawn === originalSpawn);
    console.log('childProcess.spawn is mock:', childProcess.spawn.toString().includes('GLOBAL MOCK'));
    console.log('mod.internal childProcess? Need to check source...');
    
    // Check if the module source uses childProcess.spawn
    const source = mod.checkCameraCompatibility.toString();
    console.log('checkCameraCompatibility mentions childProcess:', source.includes('childProcess'));
    
    const frame = await mod.extractFrameFromRtsp('rtsp://127.0.0.1:8554/test');
    console.log('spawnCalls:', spawnCalls.length);
    console.log('frame result:', frame ? frame.length : null);
    assert.ok(frame !== null);
  });
});
