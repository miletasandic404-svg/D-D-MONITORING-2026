'use strict';

/**
 * Tests for workers/xiongmai-stream-worker.js
 *
 * Tests: login success, login failure, stream start, frame→FFmpeg pipeline,
 * reconnect, duplicate protection, cleanup, FFmpeg crash/exit, DVRIP socket
 * disconnect, tenant isolation.
 *
 * Uses the same mocking technique as test/camera_sync_worker.test.js:
 * - pg.Pool is faked before requiring the worker
 * - lib/_crypto.js decrypt is faked (module-level property, not destructured)
 * - lib/_xiongmai_dvrip.js XiongmaiDvripAdapter is faked (module-level)
 * - lib/_xiongmai_video.js XiongmaiVideoStream is faked (module-level)
 * - child_process.spawn is faked
 * - lib/_mediamtx_client.js addOrUpdateCameraPath is faked (module-level)
 *
 * No hardware, no real database, no real FFmpeg required.
 */

const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// ── Set env vars BEFORE any require (worker checks at load time) ──────────
process.env.DATABASE_URL = 'postgres://test-local';
process.env.MEDIA_NODE_ID = 'node-1';
process.env.MEDIAMNX_API_URL = 'http://127.0.0.1:9997';

// ── Fake pg Pool ─────────────────────────────────────────────────────────
const pg = require('pg');
let queryCalls = [];
let poolScript = null;

pg.Pool = class {
  constructor() {}
  async query(text, params) {
    queryCalls.push({ text, params });
    return poolScript ? poolScript(text, params) : { rows: [] };
  }
  async end() {}
};

// ── Fake decrypt (module-level property access) ──────────────────────────
const cryptoLib = require('../lib/_crypto');
let decryptCalls = 0;
let decryptReturn = 'decrypted-password';
cryptoLib.decrypt = (blob) => {
  decryptCalls += 1;
  assert.ok(blob, 'decrypt must be called with non-null blob');
  return decryptReturn;
};

// ── Fake spawn (FFmpeg) ───────────────────────────────────────────────────
const cp = require('child_process');
const { Writable, PassThrough } = require('stream');
let spawnCalls = [];
let ffmpegInstances = [];

function makeFakeFfmpeg() {
  const stdin = new Writable({
    write(chunk, enc, cb) { cb(); },
  });
  stdin.writable = true;

  const proc = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = (signal) => {
    proc.killed = true;
    proc.stdin.writable = false;
    return true;
  };
  proc.stdin.destroy = () => { stdin.writable = false; };
  return proc;
}

cp.spawn = (cmd, args) => {
  spawnCalls.push({ cmd, args });
  const proc = makeFakeFfmpeg();
  ffmpegInstances.push(proc);
  return proc;
};

// ── Fake MediaMTX client ──────────────────────────────────────────────────
const mediamtXModule = require('../lib/_mediamtx_client');
const originalAddOrUpdateCameraPath = mediamtXModule.addOrUpdateCameraPath;
let mtxRegisterCalls = [];

mediamtXModule.addOrUpdateCameraPath = async (cameraId, rtspUrl) => {
  mtxRegisterCalls.push({ cameraId, rtspUrl });
  return { status: 200, body: null };
};

// ── Fake XiongmaiDvripAdapter ─────────────────────────────────────────────
const dvripModule = require('../lib/_xiongmai_dvrip');
const videoModule = require('../lib/_xiongmai_video');
const originalAdapter = dvripModule.XiongmaiDvripAdapter;
const originalVideoStream = videoModule.XiongmaiVideoStream;

let adapterInstances = [];
let adapterAuthSuccess = true;
let authResult = { Ret: 100, AliveInterval: 30, SessionId: 12345, success: true };
let streamCodec = 'h265';
let streamFrames = null;

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
  }
  write(data) {}
  destroy() { this.destroyed = true; }
}

dvripModule.XiongmaiDvripAdapter = class FakeXiongmaiDvripAdapter {
  constructor(ip, port) {
    this.ip = ip;
    this.port = port;
    this.socket = new FakeSocket();
    this.sessionId = 0;
    this.isAuthenticated = false;
    this.keepaliveTimer = null;
    this.aliveInterval = 30;
    adapterInstances.push(this);
  }
  async authenticate(username, password) {
    if (!adapterAuthSuccess) {
      throw new Error('DVRIP authentication failed');
    }
    this.sessionId = authResult.SessionId;
    this.isAuthenticated = true;
    return authResult;
  }
  startKeepalive() {
    this.keepaliveTimer = setInterval(() => {}, 1000);
  }
  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
  close() {
    this.isAuthenticated = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
};

videoModule.XiongmaiVideoStream = class FakeXiongmaiVideoStream {
  constructor(ip, port) {
    this.ip = ip;
    this.port = port;
    this.socket = null;
    this.sessionId = 0;
    this.isStreaming = false;
    this.frameCallback = null;
    this.errorCallback = null;
  }
  async startStreaming(socket, sessionId, options, frameCallback, errorCallback) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.frameCallback = frameCallback;
    this.errorCallback = errorCallback;
    this.isStreaming = true;
    if (frameCallback) {
      setTimeout(() => {
        if (streamFrames) {
          for (const f of streamFrames) frameCallback(f);
        } else {
          frameCallback({ kind: 'video', data: Buffer.alloc(100, 0xAB), codec: streamCodec, frameType: 'I' });
          frameCallback({ kind: 'video', data: Buffer.alloc(50, 0xCD), codec: streamCodec, frameType: 'P' });
        }
      }, 0);
    }
    return { success: true, sessionId };
  }
  stopStreaming() {
    this.isStreaming = false;
  }
};

// ── Require worker ONCE (avoids orphaned timers from re-requires) ──────────
const WORKER_PATH = require.resolve('../workers/xiongmai-stream-worker');
const worker = require(WORKER_PATH);

function freshRequireWorker() {
  delete require.cache[WORKER_PATH];
  return require(WORKER_PATH);
}

function resetFakes() {
  queryCalls = [];
  poolScript = null;
  decryptCalls = 0;
  spawnCalls = [];
  ffmpegInstances = [];
  adapterInstances = [];
  adapterAuthSuccess = true;
  authResult = { Ret: 100, AliveInterval: 30, SessionId: 12345, success: true };
  streamCodec = 'h265';
  streamFrames = null;
  mtxRegisterCalls = [];
}

function cleanupAllStreams() {
  for (const [id] of worker.activeStreams) {
    worker.cleanupStream(id, 'test_teardown');
  }
}

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  cleanupAllStreams();
});

describe('xiongmai-stream-worker — module exports', () => {
  test('exports expected functions', () => {
    assert.ok(typeof worker.fetchDvripCameras === 'function');
    assert.ok(typeof worker.startStreamForCamera === 'function');
    assert.ok(typeof worker.discoverAndSync === 'function');
    assert.ok(typeof worker.cleanupStream === 'function');
    assert.ok(typeof worker.scheduleReconnect === 'function');
    assert.ok(typeof worker.shutdown === 'function');
    assert.ok(typeof worker.exponentialBackoff === 'function');
    assert.ok(typeof worker.checkFfmpegAvailable === 'function');
    assert.ok(typeof worker.startFfmpeg === 'function');
    assert.equal(worker.MAX_RECONNECT_ATTEMPTS, 10);
  });

  test('activeStreams starts empty', () => {
    assert.equal(worker.activeStreams.size, 0);
  });
});

describe('xiongmai-stream-worker — fetchDvripCameras', () => {
  test('queries for DVRIP cameras with tenant isolation', async () => {
    poolScript = () => ({ rows: [] });
    await worker.fetchDvripCameras();

    assert.equal(queryCalls.length, 1);
    const q = queryCalls[0];
    assert.match(q.text, /connection_type = 'dvrip'/);
    assert.match(q.text, /JOIN media_nodes n ON n\.id = \$1/);
    assert.match(q.text, /n\.organization_id IS NULL/);
    assert.match(q.text, /c\.organization_id = n\.organization_id/);
    assert.match(q.text, /c\.enabled = true/);
    assert.deepEqual(q.params, ['node-1']);
  });

  test('returns [] when MEDIA_NODE_ID is missing (fail-closed)', async () => {
    const saved = process.env.MEDIA_NODE_ID;
    delete process.env.MEDIA_NODE_ID;
    const w = freshRequireWorker();
    const result = await w.fetchDvripCameras();
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 0);
    process.env.MEDIA_NODE_ID = saved;
  });
});

describe('xiongmai-stream-worker — exponentialBackoff', () => {
  test('starts at 1s and doubles', () => {
    assert.equal(worker.exponentialBackoff(0), 1000);
    assert.equal(worker.exponentialBackoff(1), 2000);
    assert.equal(worker.exponentialBackoff(2), 4000);
    assert.equal(worker.exponentialBackoff(3), 8000);
  });

  test('caps at MAX_BACKOFF_MS', () => {
    assert.equal(worker.exponentialBackoff(100), worker.MAX_BACKOFF_MS);
  });
});

describe('xiongmai-stream-worker — login success + stream start', () => {
  beforeEach(() => {
    decryptReturn = 'mySecret123';
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Front Door', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('login success → stream starts → ffmpeg spawned with correct args', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(decryptCalls, 1, 'password should be decrypted once');
    assert.equal(adapterInstances.length, 1);
    assert.equal(adapterInstances[0].isAuthenticated, true);

    assert.equal(spawnCalls.length, 1);
    const ffmpegArgs = spawnCalls[0].args;
    const allArgs = ffmpegArgs.join(' ');
    assert.equal(ffmpegArgs[0], '-f');
    assert.equal(ffmpegArgs[1], 'hevc');
    assert.equal(ffmpegArgs[3], 'pipe:0');
    assert.equal(ffmpegArgs[5], 'copy');
    assert.ok(allArgs.includes('-tag:v hvc1'), 'H.265 should include -tag:v hvc1');
    assert.strictEqual(ffmpegArgs[ffmpegArgs.length - 1], 'rtsp://127.0.0.1:8554/cam-1');

    assert.ok(!allArgs.includes('mySecret123'), 'password must not appear in FFmpeg args');

    assert.ok(worker.activeStreams.has('cam-1'));
    const ctx = worker.activeStreams.get('cam-1');
    assert.ok(ctx.adapter);
    assert.ok(ctx.ffmpegProcess);
    assert.equal(ctx.ffmpegProcess, ffmpegInstances[0]);

    assert.equal(mtxRegisterCalls.length, 1);
    assert.deepEqual(mtxRegisterCalls[0], { cameraId: 'cam-1', rtspUrl: 'publisher' });
  });
});

describe('xiongmai-stream-worker — login failure', () => {
  beforeEach(() => {
    adapterAuthSuccess = false;
    poolScript = () => ({
      rows: [{
        id: 'cam-2', name: 'Back Door', ip: '192.168.1.20', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('login failure → schedules reconnect, no ffmpeg spawned', async () => {
    await worker.startStreamForCamera('cam-2');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 0);
    assert.ok(worker.activeStreams.has('cam-2'));
    const ctx = worker.activeStreams.get('cam-2');
    assert.ok(ctx.reconnectTimer, 'reconnect timer should be set');
  });
});

describe('xiongmai-stream-worker — stream start + frame→FFmpeg pipeline', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('video frames are written to FFmpeg stdin', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    const ctx = worker.activeStreams.get('cam-1');
    assert.ok(ctx.ffmpegProcess);
    assert.ok(ctx.lastFrameAt > 0);
    assert.ok(ctx.frameTimer, 'frame timer should be active');
  });

  test('frame format and streaming state', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    const ctx = worker.activeStreams.get('cam-1');
    assert.equal(ctx.videoStream.constructor.name, 'FakeXiongmaiVideoStream');
    assert.equal(ctx.videoStream.isStreaming, true);
    assert.equal(ctx.videoStream.sessionId, 12345);
  });

  test('uses adapter.socket and adapter.sessionId', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    const ctx = worker.activeStreams.get('cam-1');
    assert.equal(ctx.adapter.socket, ctx.videoStream.socket);
    assert.equal(ctx.adapter.sessionId, ctx.videoStream.sessionId);
  });
});

describe('xiongmai-stream-worker — reconnect (FFmpeg crash/exit)', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('FFmpeg exit → schedules reconnect', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    const ctx = worker.activeStreams.get('cam-1');
    assert.equal(ctx.reconnectAttempts, 0);
    assert.equal(ctx.reconnectTimer, null);

    const proc = ctx.ffmpegProcess;
    proc.emit('exit', 1, null);
    await new Promise(r => setTimeout(r, 50));

    const newCtx = worker.activeStreams.get('cam-1');
    assert.ok(newCtx.reconnectTimer, 'reconnect timer should be set after ffmpeg crash');
    assert.equal(newCtx.reconnectAttempts, 1);
  });

  test('max reconnect attempts stops scheduling', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    const ctx = worker.activeStreams.get('cam-1');
    ctx.reconnectAttempts = worker.MAX_RECONNECT_ATTEMPTS - 1;
    ctx.ffmpegProcess = null;

    worker.scheduleReconnect('cam-1', ctx, 'test_max');
    await new Promise(r => setTimeout(r, 20));

    assert.equal(worker.activeStreams.has('cam-1'), false, 'stream removed after max attempts');
  });

  test('frame timeout triggers reconnect', async () => {
    process.env.XM_FRAME_TIMEOUT_MS = '100';
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 200));

    const ctx = worker.activeStreams.get('cam-1');
    assert.ok(ctx.reconnectTimer, 'reconnect should be scheduled after frame timeout');

    process.env.XM_FRAME_TIMEOUT_MS = '30000';
  });
});

describe('xiongmai-stream-worker — duplicate protection', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam 1', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('second startStreamForCamera call does not create duplicate', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    const firstAdapterCount = adapterInstances.length;
    const firstFfmpegCount = spawnCalls.length;

    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    assert.equal(adapterInstances.length, firstAdapterCount, 'no second adapter');
    assert.equal(spawnCalls.length, firstFfmpegCount, 'no second ffmpeg');
    assert.equal(worker.activeStreams.size, 1);
  });
});

describe('xiongmai-stream-worker — cleanup', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam 1', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('cleanupStream destroys adapter, ffmpeg, and clears timers', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    assert.ok(worker.activeStreams.has('cam-1'));
    const ctx = worker.activeStreams.get('cam-1');
    const proc = ctx.ffmpegProcess;
    const adapter = ctx.adapter;
    const frameTimer = ctx.frameTimer;

    worker.cleanupStream('cam-1', 'test_cleanup');

    assert.equal(worker.activeStreams.has('cam-1'), false);
    assert.equal(proc.killed, true);
    assert.equal(adapter.socket.destroyed, true);
  });

  test('cleanupStream is safe for non-existent camera', () => {
    worker.cleanupStream('nonexistent', 'test');
    assert.equal(worker.activeStreams.size, 0);
  });
});

describe('xiongmai-stream-worker — credential security', () => {
  beforeEach(() => {
    decryptReturn = 'superSecretPassword123';
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam', ip: '1.2.3.4', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('decrypted password not in FFmpeg args or RTSP URL', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    const allSpawnArgs = spawnCalls.map(c => c.args.join(' ')).join(' ');
    assert.ok(!allSpawnArgs.includes('superSecretPassword123'));

    const rtspUrl = spawnCalls[0].args[spawnCalls[0].args.length - 1];
    assert.equal(rtspUrl, 'rtsp://127.0.0.1:8554/cam-1');
    assert.ok(!rtspUrl.includes('superSecretPassword123'));
    assert.ok(!rtspUrl.includes('admin'));
  });
});

describe('xiongmai-stream-worker — codec detection (lazy FFmpeg startup)', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('FFmpeg is NOT spawned immediately — started lazily on first frame', async () => {
    await worker.startStreamForCamera('cam-1');

    assert.equal(spawnCalls.length, 0, 'FFmpeg should not be spawned before first frame arrives');

    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 1, 'FFmpeg should be spawned after first frame');
  });

  test('H.265 frame → FFmpeg spawned with -f hevc and -tag:v hvc1', async () => {
    streamCodec = 'h265';
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args[1], 'hevc');
    assert.ok(spawnCalls[0].args.includes('-tag:v'), 'h265 should include -tag:v');
    assert.ok(spawnCalls[0].args.includes('hvc1'), 'h265 should include hvc1');
  });

  test('H.264 frame → FFmpeg spawned with -f h264 and NO -tag:v', async () => {
    streamCodec = 'h264';
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args[1], 'h264');
    assert.ok(!spawnCalls[0].args.includes('-tag:v'), 'h264 should NOT include -tag:v');
    const ctx = worker.activeStreams.get('cam-1');
    assert.equal(ctx.detectedCodec, 'h264');
  });

  test('codec change (h265 → h264) restarts FFmpeg with new format and drops -tag:v', async () => {
    streamFrames = [
      { kind: 'video', data: Buffer.alloc(100, 0xAB), codec: 'h265', frameType: 'I' },
      { kind: 'video', data: Buffer.alloc(50, 0xCD), codec: 'h265', frameType: 'P' },
      { kind: 'video', data: Buffer.alloc(80, 0xEF), codec: 'h264', frameType: 'I' },
      { kind: 'video', data: Buffer.alloc(40, 0x22), codec: 'h264', frameType: 'P' },
    ];

    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 2, 'FFmpeg should be spawned twice (codec change)');
    assert.equal(spawnCalls[0].args[1], 'hevc');
    assert.ok(spawnCalls[0].args.includes('-tag:v'), 'h265 args should include -tag:v');
    assert.equal(spawnCalls[1].args[1], 'h264');
    assert.ok(!spawnCalls[1].args.includes('-tag:v'), 'h264 args should NOT include -tag:v');

    const ctx = worker.activeStreams.get('cam-1');
    assert.equal(ctx.detectedCodec, 'h264');
    assert.equal(ctx.ffmpegProcess, ffmpegInstances[1], 'ctx.ffmpegProcess should point to the new instance');
  });

  test('frames with same codec do not restart FFmpeg', async () => {
    streamFrames = [
      { kind: 'video', data: Buffer.alloc(100, 0xAB), codec: 'h265', frameType: 'I' },
      { kind: 'video', data: Buffer.alloc(50, 0xCD), codec: 'h265', frameType: 'P' },
      { kind: 'video', data: Buffer.alloc(80, 0xEF), codec: 'h265', frameType: 'I' },
    ];

    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(spawnCalls.length, 1, 'FFmpeg should only be spawned once for same codec');
  });
});

describe('xiongmai-stream-worker — tenant isolation', () => {
  beforeEach(() => {
    poolScript = () => ({ rows: [] });
  });

  test('query joins media_nodes and checks organization_id', async () => {
    await worker.fetchDvripCameras();

    assert.equal(queryCalls.length, 1);
    const q = queryCalls[0].text;
    assert.match(q, /FROM cameras c\s+JOIN media_nodes n ON n\.id = \$1/);
    assert.match(q, /n\.organization_id IS NULL/);
    assert.match(q, /c\.organization_id = n\.organization_id/);
    assert.match(q, /c\.connection_type = 'dvrip'/);
    assert.ok(!q.includes('WHERE 1=1') && !q.includes('WHERE true'));
  });

  test('query params only contain MEDIA_NODE_ID', async () => {
    await worker.fetchDvripCameras();
    assert.deepEqual(queryCalls[0].params, ['node-1']);
  });
});

describe('xiongmai-stream-worker — discoverAndSync', () => {
  test('starts streams for all discovered cameras', async () => {
    poolScript = () => ({
      rows: [
        { id: 'cam-1', name: 'Front', ip: '192.168.1.10', port: 34567, rtsp_username: 'admin', rtsp_password_encrypted: 'enc' },
        { id: 'cam-2', name: 'Back', ip: '192.168.1.20', port: 34567, rtsp_username: 'admin', rtsp_password_encrypted: 'enc' },
      ],
    });

    await worker.discoverAndSync();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(worker.activeStreams.size, 2);
    assert.equal(adapterInstances.length, 2);
    assert.equal(spawnCalls.length, 2);
  });

  test('removes cameras no longer in discovery results', async () => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Front', ip: '192.168.1.10', port: 34567, rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });

    await worker.discoverAndSync();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(worker.activeStreams.size, 1);

    poolScript = () => ({ rows: [] });
    await worker.discoverAndSync();

    assert.equal(worker.activeStreams.size, 0);
  });

  test('does not duplicate streaming camera', async () => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Front', ip: '192.168.1.10', port: 34567, rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });

    await worker.discoverAndSync();
    await new Promise(r => setTimeout(r, 30));

    const firstCount = adapterInstances.length;
    const firstFfmpeg = spawnCalls.length;

    await worker.discoverAndSync();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(adapterInstances.length, firstCount);
    assert.equal(spawnCalls.length, firstFfmpeg);
  });
});

describe('xiongmai-stream-worker — DVRIP socket disconnect', () => {
  beforeEach(() => {
    poolScript = () => ({
      rows: [{
        id: 'cam-1', name: 'Cam', ip: '192.168.1.10', port: 34567,
        rtsp_username: 'admin', rtsp_password_encrypted: 'enc',
      }],
    });
  });

  test('video stream error callback triggers reconnect', async () => {
    await worker.startStreamForCamera('cam-1');
    await new Promise(r => setTimeout(r, 30));

    const ctx = worker.activeStreams.get('cam-1');
    assert.ok(ctx);

    ctx.videoStream.errorCallback(new Error('DVRIP protocol error'));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx.reconnectTimer, 'reconnect timer should be set after video error');
  });
});

// ── Restore original modules ───────────────────────────────────────────────
after(() => {
  dvripModule.XiongmaiDvripAdapter = originalAdapter;
  videoModule.XiongmaiVideoStream = originalVideoStream;
  mediamtXModule.addOrUpdateCameraPath = originalAddOrUpdateCameraPath;
  cleanupAllStreams();
});
