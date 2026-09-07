'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

let spawnCalls = [];
const originalSpawn = require('child_process').spawn;

console.log('TEST FILE: Setting up spawn mock...');

require('child_process').spawn = function(cmd, args) {
  spawnCalls.push({ cmd, args });
  console.log('TEST FILE MOCK: spawn called with', cmd, args[args.length - 1]);
  const resp = { close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2) };
  let dataEmitted = false;
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data' && resp.data && !dataEmitted) {
          dataEmitted = true;
          console.log('TEST FILE MOCK: emitting data');
          cb(resp.data);
        }
      },
    },
    stderr: { on: () => {} },
    on: (event, cb) => {
      if (event === 'close') {
        console.log('TEST FILE MOCK: emitting close');
        setTimeout(() => cb(resp.close), 0);
      }
    },
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

  test('debug: check if child_process.spawn mock is active', async () => {
    console.log('\nBefore require - spawnCalls:', spawnCalls.length);
    const mod = require('../lib/_camera_compatibility');
    console.log('After require - spawnCalls:', spawnCalls.length);
    console.log('childProcess.spawn === originalSpawn:', require('child_process').spawn === originalSpawn);
    console.log('childProcess.spawn is mock:', require('child_process').spawn.toString().includes('TEST FILE MOCK'));
    
    const frame = await mod.extractFrameFromRtsp('rtsp://127.0.0.1:8554/test');
    console.log('spawnCalls after extractFrameFromRtsp:', JSON.stringify(spawnCalls));
    console.log('frame result:', frame ? frame.length : null);
    assert.ok(frame !== null);
  });
});
