'use strict';

const assert = require('node:assert');
const { describe, test, beforeEach, afterEach } = require('node:test');

let spawnResponses = [];

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
  spawnResponses = [];
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

  test('extractFrameFromRtsp returns frame when ffmpeg succeeds', async () => {
    spawnResponses.push({ key: 'ffmpeg:-', close: 0, data: Buffer.alloc(200, 0xFF).fill(0xD8, 1, 2) });

    const { extractFrameFromRtsp } = require('../lib/_camera_compatibility');
    const frame = await extractFrameFromRtsp('rtsp://127.0.0.1:8554/test');
    assert.ok(frame !== null, 'frame should not be null');
    assert.ok(frame.length > 100, 'frame should be > 100 bytes');
    assert.equal(frame[0], 0xFF);
    assert.equal(frame[1], 0xD8);
  });
});
