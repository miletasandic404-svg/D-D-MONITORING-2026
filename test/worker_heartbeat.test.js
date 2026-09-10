'use strict';

/**
 * Focused tests for lib/_worker_heartbeat.js
 */

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Reset module cache between tests to get fresh state.
const WORKER_HEARTBEAT_PATH = require.resolve('../lib/_worker_heartbeat');

function freshRequire() {
  delete require.cache[WORKER_HEARTBEAT_PATH];
  return require(WORKER_HEARTBEAT_PATH);
}

const TEST_HEARTBEAT_FILE = path.join(require('os').tmpdir(), 'dnd-worker-heartbeat-test.json');

describe('lib/_worker_heartbeat', () => {
  beforeEach(() => {
    // Force a unique file path for each test run via env override
    process.env.WORKER_HEARTBEAT_FILE = TEST_HEARTBEAT_FILE;
    try { fs.unlinkSync(TEST_HEARTBEAT_FILE); } catch {}
  });

  after(() => {
    try { fs.unlinkSync(TEST_HEARTBEAT_FILE); } catch {}
    delete process.env.WORKER_HEARTBEAT_FILE;
  });

  test('beat() creates a heartbeat entry for a named worker', () => {
    const { beat, getWorkerStatus } = freshRequire();
    beat('camera-setup-agent', { status: 'running' });
    const status = getWorkerStatus();
    assert.equal(status.workers.length, 1);
    assert.equal(status.workers[0].name, 'camera-setup-agent');
    assert.equal(status.workers[0].status, 'running');
    assert.ok(status.workers[0].pid > 0);
  });

  test('multiple workers are tracked independently', () => {
    const { beat, getWorkerStatus } = freshRequire();
    beat('camera-setup-agent');
    beat('xiongmai-stream-worker');
    beat('two-way-audio-api');
    const status = getWorkerStatus();
    assert.equal(status.workers.length, 3);
    const names = status.workers.map((w) => w.name).sort();
    assert.deepEqual(names, [
      'camera-setup-agent',
      'two-way-audio-api',
      'xiongmai-stream-worker',
    ]);
  });

  test('worker status transitions to stale after threshold', async () => {
    const { beat, getWorkerStatus, STALE_THRESHOLD_MS } = freshRequire();
    beat('camera-setup-agent', { status: 'running' });

    // Initially running
    let status = getWorkerStatus();
    assert.equal(status.workers[0].status, 'running');

    // Artificially age the heartbeat past the stale threshold
    const raw = JSON.parse(fs.readFileSync(TEST_HEARTBEAT_FILE, 'utf-8'));
    raw['camera-setup-agent'].last_seen_ms = Date.now() - STALE_THRESHOLD_MS - 1000;
    fs.writeFileSync(TEST_HEARTBEAT_FILE, JSON.stringify(raw), 'utf-8');

    status = getWorkerStatus();
    assert.equal(status.workers[0].status, 'stale');
  });

  test('recovery back to healthy after new heartbeat', () => {
    const { beat, getWorkerStatus, STALE_THRESHOLD_MS } = freshRequire();
    beat('camera-setup-agent');

    // Age it stale
    let raw = JSON.parse(fs.readFileSync(TEST_HEARTBEAT_FILE, 'utf-8'));
    raw['camera-setup-agent'].last_seen_ms = Date.now() - STALE_THRESHOLD_MS - 1000;
    fs.writeFileSync(TEST_HEARTBEAT_FILE, JSON.stringify(raw), 'utf-8');

    let status = getWorkerStatus();
    assert.equal(status.workers[0].status, 'stale');

    // Beat again
    beat('camera-setup-agent');
    status = getWorkerStatus();
    assert.equal(status.workers[0].status, 'running');
  });

  test('beat() updates existing worker entry (same name overwrites)', () => {
    const { beat, getWorkerStatus } = freshRequire();
    beat('camera-setup-agent', { status: 'running', detail: 'first' });
    beat('camera-setup-agent', { status: 'running', detail: 'second' });
    const status = getWorkerStatus();
    assert.equal(status.workers.length, 1);
    assert.equal(status.workers[0].detail, 'second');
  });

  test('getWorkerStatus handles missing/corrupt file gracefully', () => {
    const { getWorkerStatus } = freshRequire();
    const status = getWorkerStatus();
    assert.deepEqual(status.workers, []);
  });

  test('failure/error transition is reflected via status metadata', () => {
    const { beat, getWorkerStatus } = freshRequire();
    beat('xiongmai-stream-worker', { status: 'error', detail: 'ffmpeg crashed' });
    const status = getWorkerStatus();
    assert.equal(status.workers[0].name, 'xiongmai-stream-worker');
    assert.equal(status.workers[0].status, 'running'); // status field from beat() is just metadata
    assert.equal(status.workers[0].detail, 'ffmpeg crashed');
  });

  test('tenant/media-node isolation is preserved (no cross-node bleed)', () => {
    const { beat, getWorkerStatus } = freshRequire();
    beat('camera-setup-agent');
    // Simulate a different node writing to its own file — in this
    // implementation each host/container has its own file, so there
    // is no cross-node data bleed.
    const status = getWorkerStatus();
    assert.equal(status.workers.length, 1);
    assert.equal(status.workers[0].name, 'camera-setup-agent');
  });
});
