'use strict';

/**
 * Tests for workers/recording-worker.js — cross-organization isolation
 * of the camera lookup (CRITICAL #3).
 *
 * The worker reacts to Postgres LISTEN notifications whose payload
 * carries camera_id + organization_id. Before this fix it loaded the
 * camera by id alone, so a payload with organization_id=A could read
 * the rtsp_url of a camera owned by organization B and record it under
 * A. The lookup must now be strictly org-scoped and fail closed:
 *
 *   SELECT rtsp_url, recording_mode, retention_days
 *   FROM cameras
 *   WHERE id = $1 AND organization_id = $2
 *
 * with params [cameraId, organizationId]. When the query returns 0 rows
 * the worker returns without inserting a recording and without starting
 * ffmpeg.
 *
 * All external dependencies are faked before the module under test is
 * required (same technique as test/cameras_api.test.js), so these tests
 * never hit a real database, real storage or a real ffmpeg process.
 */

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let dbScript = null; // (text, params) => { rows }

function resetFakes() {
  queryCalls = [];
  dbScript = null;
  spawnCalls.length = 0;
}

db.queryAsPlatformAdmin = async (text, params) => {
  queryCalls.push({ text, params });
  return dbScript ? dbScript(text, params) : { rows: [] };
};

// ── fake child_process.spawn (captures ffmpeg starts, never runs ffmpeg) ─
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
let spawnCalls = [];

childProcess.spawn = (cmd, args) => {
  spawnCalls.push({ cmd, args });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // Simulate an immediate ffmpeg failure so the worker takes the
  // error path deterministically and quickly.
  process.nextTick(() => proc.emit('error', new Error('mocked: ffmpeg unavailable')));
  return proc;
};

// The worker destructures `spawn` at require time, so the stub above
// must be installed before the module is loaded.
const worker = require('../workers/recording-worker');

after(() => {
  childProcess.spawn = realSpawn;
});

const CAMERA_MATCH = { rtsp_url: 'rtsp://127.0.0.1/live', recording_mode: 'on', retention_days: 7 };

function cameraSelectCall() {
  return queryCalls.find((c) => /FROM cameras/.test(c.text));
}

function insertCalls() {
  return queryCalls.filter((c) => /INSERT INTO recordings/.test(c.text));
}

function updateCalls() {
  return queryCalls.filter((c) => /UPDATE recordings/.test(c.text));
}

describe('workers/recording-worker — org-scoped camera lookup', () => {
  beforeEach(resetFakes);

  test('camera lookup is strictly org-scoped (AND organization_id = $2, params [cameraId, organizationId])', async () => {
    dbScript = (text) =>
      /INSERT INTO recordings/.test(text) ? { rows: [{ id: 'rec-1' }] } : { rows: [CAMERA_MATCH] };

    await worker.handleEvent({ camera_id: 'CAM-1', event_id: 'evt-1', organization_id: 'org-A' });

    const sel = cameraSelectCall();
    assert.ok(sel, 'a SELECT on cameras must be executed');
    assert.match(sel.text, /WHERE id = \$1\s+AND organization_id = \$2/);
    assert.deepEqual(sel.params, ['CAM-1', 'org-A']);
  });

  test('organization mismatch (0 rows) -> return, no INSERT INTO recordings, ffmpeg never spawned', async () => {
    // The payload claims org-A but the camera belongs to org-B: the
    // org-scoped SELECT must come back empty and the worker must stop.
    dbScript = () => ({ rows: [] });

    await worker.handleEvent({ camera_id: 'CAM-B-OWNED', event_id: 'evt-2', organization_id: 'org-A' });

    const sel = cameraSelectCall();
    assert.ok(sel);
    assert.match(sel.text, /AND organization_id = \$2/);
    assert.deepEqual(sel.params, ['CAM-B-OWNED', 'org-A']);
    assert.equal(insertCalls().length, 0, 'no recording may be inserted for a camera of another org');
    assert.equal(spawnCalls.length, 0, 'ffmpeg must not be started');
  });

  test('organization match -> recordings INSERT runs with the payload organization_id', async () => {
    dbScript = (text) => {
      if (/INSERT INTO recordings/.test(text)) return { rows: [{ id: 'rec-1' }] };
      return { rows: [CAMERA_MATCH] };
    };

    await worker.handleEvent({ camera_id: 'CAM-1', event_id: 'evt-3', organization_id: 'org-A' });

    const ins = insertCalls()[0];
    assert.ok(ins, 'INSERT INTO recordings should be executed');
    // INSERT INTO recordings (camera_id, organization_id, event_id, ...)
    // VALUES ($1, $2, $3, ...)
    assert.equal(ins.params[0], 'CAM-1');
    assert.equal(ins.params[1], 'org-A');
    assert.equal(ins.params[2], 'evt-3');
  });

  test('camera does not exist -> return, no INSERT, no ffmpeg', async () => {
    dbScript = () => ({ rows: [] });

    await worker.handleEvent({ camera_id: 'CAM-MISSING', event_id: 'evt-4', organization_id: 'org-A' });

    assert.equal(insertCalls().length, 0);
    assert.equal(spawnCalls.length, 0);
  });

  test('recording_mode off -> return before INSERT, no ffmpeg', async () => {
    dbScript = () => ({ rows: [{ rtsp_url: 'rtsp://cam.example/live', recording_mode: 'off', retention_days: 7 }] });

    await worker.handleEvent({ camera_id: 'CAM-1', event_id: 'evt-5', organization_id: 'org-A' });

    assert.equal(insertCalls().length, 0);
    assert.equal(spawnCalls.length, 0);
  });

  test('camera without rtsp_url -> return before INSERT, no ffmpeg', async () => {
    dbScript = () => ({ rows: [{ rtsp_url: null, recording_mode: 'on', retention_days: 7 }] });

    await worker.handleEvent({ camera_id: 'CAM-1', event_id: 'evt-6', organization_id: 'org-A' });

    assert.equal(insertCalls().length, 0);
    assert.equal(spawnCalls.length, 0);
  });

  test('recordings UPDATE targets the id returned by INSERT RETURNING', async () => {
    dbScript = (text) => {
      if (/INSERT INTO recordings/.test(text)) return { rows: [{ id: 'rec-xyz' }] };
      return { rows: [CAMERA_MATCH] };
    };

    await worker.handleEvent({ camera_id: 'CAM-1', event_id: 'evt-7', organization_id: 'org-A' });

    const upd = updateCalls()[0];
    assert.ok(upd, 'an UPDATE on recordings should be executed after the ffmpeg outcome');
    assert.equal(upd.params[0], 'rec-xyz', 'UPDATE must target the recording id from INSERT RETURNING');
  });
});
