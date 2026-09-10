'use strict';

/**
 * Focused tests for the DNS-rebinding SSRF TOCTOU fix in
 * workers/recording-worker.js — recordSegment().
 *
 * Verifies that the validated IP from assertSafeTarget() is used for the
 * actual ffmpeg connection, not the original attacker-controlled hostname.
 */

const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// ── fake child_process.spawn ─────────────────────────────────────────
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
let spawnCalls = [];

childProcess.spawn = (cmd, args) => {
  spawnCalls.push({ cmd, args });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  process.nextTick(() => proc.emit('close', 0));
  return proc;
};

after(() => {
  childProcess.spawn = realSpawn;
});

// ── fake assertSafeTarget ────────────────────────────────────────────
const nsPath = require.resolve('../lib/_network_security');
require(nsPath); // ensure require.cache entry exists
const nsModule = require.cache[nsPath];
const originalAssertSafeTarget = nsModule.exports.assertSafeTarget;

function patchAssertSafeTarget(fn) {
  require.cache[nsPath] = {
    ...nsModule,
    exports: { ...nsModule.exports, assertSafeTarget: fn },
  };
}

function unpatchAssertSafeTarget() {
  require.cache[nsPath] = nsModule;
}

// ── load worker with patched assertSafeTarget ────────────────────────
function loadWorker() {
  delete require.cache[require.resolve('../workers/recording-worker')];
  return require('../workers/recording-worker');
}

describe('workers/recording-worker — DNS rebinding SSRF fix (recordSegment)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  afterEach(() => {
    unpatchAssertSafeTarget();
  });

  test('recordSegment rewrites hostname to validated IP before spawning ffmpeg', async () => {
    patchAssertSafeTarget(async () => ({ ok: true, addresses: ['1.2.3.4'] }));
    const worker = loadWorker();

    await worker.recordSegment('rtsp://attacker.example:554/live', '/tmp/out.mp4', 15);

    const call = spawnCalls[0];
    assert.ok(call, 'ffmpeg must be spawned');
    assert.ok(
      call.args.includes('rtsp://1.2.3.4:554/live'),
      'ffmpeg args must contain the rewritten IP, not the hostname',
    );
    assert.ok(
      !call.args.some((a) => a.includes && a.includes('attacker.example')),
      'original hostname must not appear in ffmpeg args',
    );
  });

  test('recordSegment preserves port, pathname, query and credentials', async () => {
    patchAssertSafeTarget(async () => ({ ok: true, addresses: ['5.6.7.8'] }));
    const worker = loadWorker();

    await worker.recordSegment(
      'rtsp://user:pass@attacker.example:1554/stream/path?token=abc',
      '/tmp/out.mp4',
      15,
    );

    const call = spawnCalls[0];
    assert.ok(
      call.args.includes('rtsp://user:pass@5.6.7.8:1554/stream/path?token=abc'),
      'URL components must be preserved after hostname rewrite',
    );
  });

  test('recordSegment preserves IPv6 brackets after rewrite', async () => {
    patchAssertSafeTarget(async () => ({ ok: true, addresses: ['::1'] }));
    const worker = loadWorker();

    await worker.recordSegment('rtsp://[::1]:554/live', '/tmp/out.mp4', 15);

    const call = spawnCalls[0];
    assert.ok(
      call.args.includes('rtsp://[::1]:554/live'),
      'IPv6 brackets must be preserved by URL API serialization',
    );
  });

  test('recordSegment uses first validated address when multiple are returned', async () => {
    patchAssertSafeTarget(async () => ({ ok: true, addresses: ['1.2.3.4', '5.6.7.8'] }));
    const worker = loadWorker();

    await worker.recordSegment('rtsp://host.example/live', '/tmp/out.mp4', 15);

    const call = spawnCalls[0];
    assert.ok(
      call.args.includes('rtsp://1.2.3.4/live'),
      'first validated address must be used',
    );
  });

  test('recordSegment does not spawn ffmpeg when assertSafeTarget blocks (allowPrivate=false)', async () => {
    patchAssertSafeTarget(async () => {
      const err = new Error('network policy: address 10.0.0.1 (private) is not allowed');
      err.code = 'NETWORK_POLICY';
      throw err;
    });
    const worker = loadWorker();

    await assert.rejects(
      () => worker.recordSegment('rtsp://private.example/live', '/tmp/out.mp4', 15),
      { code: 'NETWORK_POLICY' },
    );
    assert.equal(spawnCalls.length, 0, 'ffmpeg must not be spawned when validation fails');
  });

  test('recordSegment does not spawn ffmpeg when assertSafeTarget blocks loopback', async () => {
    patchAssertSafeTarget(async () => {
      const err = new Error('network policy: address 127.0.0.1 (loopback) is not allowed');
      err.code = 'NETWORK_POLICY';
      throw err;
    });
    const worker = loadWorker();

    await assert.rejects(
      () => worker.recordSegment('rtsp://localhost/live', '/tmp/out.mp4', 15),
      { code: 'NETWORK_POLICY' },
    );
    assert.equal(spawnCalls.length, 0, 'ffmpeg must not be spawned for loopback');
  });

  test('recordSegment does not spawn ffmpeg when assertSafeTarget blocks metadata IP', async () => {
    patchAssertSafeTarget(async () => {
      const err = new Error('network policy: address 169.254.169.254 (metadata) is not allowed');
      err.code = 'NETWORK_POLICY';
      throw err;
    });
    const worker = loadWorker();

    await assert.rejects(
      () => worker.recordSegment('rtsp://metadata.example/live', '/tmp/out.mp4', 15),
      { code: 'NETWORK_POLICY' },
    );
    assert.equal(spawnCalls.length, 0, 'ffmpeg must not be spawned for metadata IP');
  });
});
