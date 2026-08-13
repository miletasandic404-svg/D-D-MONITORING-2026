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
cryptoLib.decrypt = () => {
  decryptCalls += 1;
  return 'decrypted';
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

describe('workers/camera-sync-worker — fail-closed without MEDIA_NODE_ID', () => {
  beforeEach(() => {
    queryCalls = [];
    decryptCalls = 0;
    poolScript = null;
    delete process.env.MEDIA_NODE_ID;
  });

  test('no MEDIA_NODE_ID -> returns [] and never queries cameras', async () => {
    const worker = freshRequireWorker();
    const result = await worker.fetchCamerasFromDb();
    assert.deepEqual(result, []);
    assert.equal(queryCalls.length, 0, 'no DB query may run without MEDIA_NODE_ID');
  });

  test('no MEDIA_NODE_ID -> credentials are never decrypted', async () => {
    const worker = freshRequireWorker();
    await worker.fetchCamerasFromDb();
    assert.equal(decryptCalls, 0, 'decrypt must never be called in the fail-closed path');
  });

  test('no MEDIA_NODE_ID -> returns [] even if a query would have matched rows (no unscoped fallback)', async () => {
    // Poison the pool: if the worker issued ANY query it would return rows
    // with credentials — the fail-closed path must never reach it.
    poolScript = () => ({
      rows: [{ id: 'CAM-OTHER', rtsp_url: 'rtsp://x/live', rtsp_password_encrypted: 'enc' }],
    });
    const worker = freshRequireWorker();
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
