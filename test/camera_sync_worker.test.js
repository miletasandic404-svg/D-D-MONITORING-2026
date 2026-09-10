'use strict';

/**
 * Tests for workers/camera-sync-worker.js — fail-closed behavior when
 * MEDIA_NODE_ID is not configured (security fix).
 *
 * Before this fix, a sync worker without MEDIA_NODE_ID fell back to an
 * UNscoped SELECT over every enabled camera (with decryptable RTSP
 * credentials), letting any mis-configured node pull foreign
 * organizations' streams into its own MediaMTX. Now:
 *
 *   - no MEDIA_NODE_ID  -> logs an error, returns [], never queries
 *                          `cameras`, never decrypts credentials
 *   - with MEDIA_NODE_ID -> the existing org-scoped query stays active
 *                          (JOIN media_nodes, c.organization_id =
 *                          n.organization_id)
 *
 * The pg Pool, decrypt() and the MediaMTX client are faked before the
 * module is required (same technique as test/recording_worker.test.js),
 * so the tests never hit a real database, Neon, MediaMTX or real
 * credentials.
 */

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// ── fake _worker_heartbeat.beat (intercept calls without touching the FS) ─
const heartbeat = require('../lib/_worker_heartbeat');
let beatCalls = [];
heartbeat.beat = (name, meta = {}) => {
  beatCalls.push({ name, status: meta && meta.status });
};

// ── fake pg Pool ─────────────────────────────────────────────────────────
const pg = require('pg');
let queryCalls = [];
let poolScript = null; // (text, params) => { rows }

pg.Pool = class {
  constructor() {}
  async query(text, params) {
    queryCalls.push({ text, params });
    return poolScript ? poolScript(text, params) : { rows: [] };
  }
  async end() {}
};

// ── fake decrypt (must never run in the fail-closed path) ────────────────
const cryptoLib = require('../lib/_crypto');
let decryptCalls = 0;
let decryptReturn = 'decrypted';
cryptoLib.decrypt = (blob) => {
  decryptCalls += 1;
  return decryptReturn;
};

// The worker reads env at require time and only starts its main() loop
// when run directly (require.main === module), so tests re-require it
// with a controlled MEDIA_NODE_ID. DATABASE_URL must be present or the
// worker exits at load time (fail fast on missing DB) — this fake value
// never connects because the Pool is mocked. It intentionally stays set
// for the whole test process (the Pool mock never opens a connection).
process.env.DATABASE_URL = 'postgres://test-local';

const WORKER_PATH = require.resolve('../workers/camera-sync-worker');

function freshRequireWorker() {
  delete require.cache[WORKER_PATH];
  return require(WORKER_PATH);
}

function freshRequireWorkerWithoutDotenv() {
  const dotenv = require('dotenv');
  const originalConfig = dotenv.config;
  dotenv.config = () => {};
  delete require.cache[WORKER_PATH];
  const w = require(WORKER_PATH);
  dotenv.config = originalConfig;
  return w;
}

describe('workers/camera-sync-worker — fail-closed without MEDIA_NODE_ID', () => {
  beforeEach(() => {
    queryCalls = [];
    decryptCalls = 0;
    poolScript = null;
    beatCalls = [];
    delete process.env.MEDIA_NODE_ID;
  });

  test('no MEDIA_NODE_ID -> returns [] and never queries cameras', async () => {
    const worker = freshRequireWorkerWithoutDotenv();
    const result = await worker.fetchCamerasFromDb();
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 0, 'no DB query may run without MEDIA_NODE_ID');
  });

  test('no MEDIA_NODE_ID -> credentials are never decrypted', async () => {
    const worker = freshRequireWorkerWithoutDotenv();
    await worker.fetchCamerasFromDb();
    assert.equal(decryptCalls, 0, 'decrypt must never be called in the fail-closed path');
  });

  test('no MEDIA_NODE_ID -> returns [] even if a query would have matched rows (no unscoped fallback)', async () => {
    // Poison the pool: if the worker issued ANY query it would return rows
    // with credentials — the fail-closed path must never reach it.
    poolScript = () => ({
      rows: [{ id: 'CAM-OTHER', rtsp_url: 'rtsp://x/live', rtsp_password_encrypted: 'enc' }],
    });
    const worker = freshRequireWorkerWithoutDotenv();
    const result = await worker.fetchCamerasFromDb();
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 0);
    assert.equal(decryptCalls, 0);
  });
});

describe('workers/camera-sync-worker — org-scoped sync with MEDIA_NODE_ID', () => {
  beforeEach(() => {
    queryCalls = [];
    decryptCalls = 0;
    poolScript = null;
    beatCalls = [];
    process.env.MEDIA_NODE_ID = 'node-1';
  });

  test('with MEDIA_NODE_ID the org-scoped query runs (JOIN media_nodes, c.organization_id = n.organization_id)', async () => {
    poolScript = () => ({
      rows: [
        { id: 'CAM-1', rtsp_url: 'rtsp://host/live', media_node_id: 'node-1', rtsp_username: 'user', rtsp_password_encrypted: 'enc' },
      ],
    });
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();

    assert.equal(queryCalls.length, 1);
    const q = queryCalls[0];
    assert.match(q.text, /JOIN media_nodes n ON n\.id = \$1/);
    assert.match(q.text, /c\.organization_id = n\.organization_id/);
    assert.doesNotMatch(q.text, /WHERE rtsp_url IS NOT NULL AND enabled = true/, 'unscoped fallback must not exist');
    assert.deepEqual(q.params, ['node-1']);

    assert.equal(decryptCalls, 1, "credentials are decrypted for the node's own camera");
    assert.equal(result.length, 1);
    assert.notEqual(result[0].rtsp_url, 'rtsp://host/live', 'credentials are embedded into the URL');
    assert.ok(result[0].rtsp_url.includes('user'));
  });

  test('empty result set passes through as []', async () => {
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 1);
    assert.equal(decryptCalls, 0);
  });
});

describe('workers/camera-sync-worker — JSON credential parsing', () => {
  beforeEach(() => {
    queryCalls = [];
    decryptCalls = 0;
    poolScript = null;
    beatCalls = [];
    process.env.MEDIA_NODE_ID = 'node-1';
  });

  test('JSON decrypted credential embeds password in RTSP URL', async () => {
    decryptReturn = JSON.stringify({ username: 'admin', password: 'realPassword123' });
    poolScript = () => ({
      rows: [
        { id: 'CAM-1', rtsp_url: 'rtsp://host/live', media_node_id: 'node-1', rtsp_username: 'admin', rtsp_password_encrypted: 'enc' },
      ],
    });
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();

    assert.equal(result.length, 1);
    assert.ok(result[0].rtsp_url.includes('admin:realPassword123@'), 'RTSP URL should contain extracted password');
    assert.ok(!result[0].rtsp_url.includes('username'), 'JSON structure should not leak into URL');
  });

  test('legacy plain decrypted password embeds in RTSP URL', async () => {
    decryptReturn = 'plainLegacyPassword';
    poolScript = () => ({
      rows: [
        { id: 'CAM-1', rtsp_url: 'rtsp://host/live', media_node_id: 'node-1', rtsp_username: 'admin', rtsp_password_encrypted: 'enc' },
      ],
    });
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();

    assert.equal(result.length, 1);
    assert.ok(result[0].rtsp_url.includes('admin:plainLegacyPassword@'), 'RTSP URL should contain legacy password');
  });

  test('JSON with missing password field results in empty password', async () => {
    decryptReturn = JSON.stringify({ username: 'admin' });
    poolScript = () => ({
      rows: [
        { id: 'CAM-1', rtsp_url: 'rtsp://host/live', media_node_id: 'node-1', rtsp_username: 'admin', rtsp_password_encrypted: 'enc' },
      ],
    });
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();

    assert.equal(result.length, 1);
    assert.ok(result[0].rtsp_url.includes('admin'), 'RTSP URL should contain username');
    assert.ok(!result[0].rtsp_url.includes('username'), 'JSON structure should not leak into URL');
    assert.ok(!result[0].rtsp_url.includes('password'), 'JSON structure should not leak into URL');
  });
});

describe('workers/camera-sync-worker — heartbeat', () => {
  beforeEach(() => {
    queryCalls = [];
    decryptCalls = 0;
    poolScript = null;
    beatCalls = [];
    process.env.MEDIA_NODE_ID = 'node-1';
  });

  test('main() emits a running heartbeat before the first sync', async () => {
    const worker = freshRequireWorker();
    // runFullSync runs immediately inside main(); intercept it so the sync
    // loop doesn't set up the polling setInterval that would keep the
    // process alive (open handle).
    worker.runFullSync = () => Promise.resolve();
    // Replace the sync setInterval factory so no timer is created.
    const realSetInterval = setInterval;
    let intervalCreated = false;
    global.setInterval = () => {
      intervalCreated = true;
      return { _isMock: true };
    };

    await worker.main();

    global.setInterval = realSetInterval;

    const runningBeats = beatCalls.filter((b) => b.name === 'camera-sync-worker' && b.status === 'running');
    assert.ok(runningBeats.length >= 1, 'a running heartbeat should be emitted at startup');
    // main() should still schedule the periodic heartbeat timer.
    assert.equal(intervalCreated, true, 'sync interval timer should be scheduled');
  });

  test('SIGTERM emits a stopped heartbeat before exit', async () => {
    const worker = freshRequireWorker();
    // Override process.exit to prevent the test from terminating.
    const realExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; };

    // Override pool.end to prevent real DB interaction.
    worker; // no-op to ensure module is loaded
    // The pool is created at module load with the mocked pg.Pool, whose
    // end() is a no-op. SIGTERM handler calls beat then pool.end then exit.

    // We can't easily invoke the process 'SIGTERM' listener directly without
    // triggering real signals, so call it via process.emit.
    process.emit('SIGTERM');

    // Allow the async handler to flush.
    await new Promise((r) => setTimeout(r, 50));

    process.exit = realExit;

    const stoppedBeats = beatCalls.filter((b) => b.name === 'camera-sync-worker' && b.status === 'stopped');
    assert.ok(stoppedBeats.length >= 1, 'a stopped heartbeat should be emitted on SIGTERM');
  });
});
