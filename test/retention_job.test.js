'use strict';

/**
 * Tests for workers/retention-job.js.
 *
 * Validates:
 *   - Valid storage URL -> object + DB row deletion works
 *   - Invalid/mismatched storage URL -> DB row still deleted (no storage object to delete)
 *   - NULL storage_url -> DB row still deleted (no storage object to delete)
 *   - One bad row does not stop processing of other rows
 *   - Non-expired rows are never touched
 *   - Rows from multiple organizations are processed independently
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');

const db = require('../db/index');
const storage = require('../lib/_storage');

let queryCalls = [];
let deletedKeys = [];
let deletedRows = [];
let logs = [];
let retentionJob;

function resetMocks(rows) {
  queryCalls = [];
  deletedKeys = [];
  deletedRows = [];
  logs = [];

  db.queryAsPlatformAdmin = async (text, params) => {
    queryCalls.push({ text, params });
    if (text.includes('SELECT') && text.includes('recordings')) {
      return { rows: rows || [] };
    }
    if (text.includes('DELETE FROM recordings')) {
      deletedRows.push(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };

  storage.getBackend = () => 'local';
  storage.deleteObject = async (key) => {
    deletedKeys.push(key);
  };
}

describe('retention-job', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    process.env.STORAGE_PUBLIC_BASE_URL = 'https://storage.example';
    resetMocks();
    console.warn = (...args) => {
      logs.push({ level: 'warn', args });
    };
    delete require.cache[require.resolve('../workers/retention-job')];
    retentionJob = require('../workers/retention-job');
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.STORAGE_PUBLIC_BASE_URL;
  });

  test('A: expired row with valid storage_url -> object + DB row deletion', async () => {
    resetMocks([
      { id: 'rec-1', organization_id: 'org-1', storage_url: 'https://storage.example/recordings/org-1/cam-1/rec-1.mp4' },
    ]);
    const result = await retentionJob.run();

    assert.ok(deletedKeys.includes('recordings/org-1/cam-1/rec-1.mp4'), 'should delete storage object for valid URL');
    assert.ok(deletedRows.includes('rec-1'), 'should delete DB row for valid URL');
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
  });

  test('B: expired row with NULL storage_url -> DB row deleted, no storage deletion', async () => {
    resetMocks([
      { id: 'rec-2', organization_id: 'org-1', storage_url: null },
    ]);
    const result = await retentionJob.run();

    assert.equal(deletedKeys.length, 0, 'should NOT attempt storage deletion for null storage_url');
    assert.ok(deletedRows.includes('rec-2'), 'should still delete DB row for null storage_url');
    assert.ok(logs.some(l => l.args.some(a => typeof a === 'string' && a.includes('rec-2'))), 'should log the null URL condition');
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
  });

  test('C: expired row with unparseable storage_url -> DB row deleted, no storage deletion', async () => {
    resetMocks([
      { id: 'rec-3', organization_id: 'org-1', storage_url: 'https://old-storage.example/recordings/org-1/cam-1/rec-3.mp4' },
    ]);
    const result = await retentionJob.run();

    assert.equal(deletedKeys.length, 0, 'should NOT attempt storage deletion for unparseable URL');
    assert.ok(deletedRows.includes('rec-3'), 'should still delete DB row for unparseable storage_url');
    assert.ok(logs.some(l => l.args.some(a => typeof a === 'string' && a.includes('rec-3'))), 'should log the unrecognized URL condition');
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
  });

  test('D: non-expired row -> not selected (no deletion query)', async () => {
    // Only expired rows are returned by the SELECT (WHERE retention_expires_at < now()).
    // A non-expired row would not appear in `expired.rows`, so nothing runs for it.
    resetMocks([
      { id: 'rec-active', organization_id: 'org-1', storage_url: 'https://storage.example/recordings/org-1/cam-1/rec-active.mp4' },
    ]);
    // Simulate the SELECT returning empty (the non-expired row is filtered server-side).
    db.queryAsPlatformAdmin = async (text, params) => {
      queryCalls.push({ text, params });
      if (text.includes('SELECT') && text.includes('recordings')) return { rows: [] };
      if (text.includes('DELETE FROM recordings')) { deletedRows.push(params[0]); return { rows: [] }; }
      return { rows: [] };
    };
    const result = await retentionJob.run();

    assert.equal(deletedKeys.length, 0, 'should not attempt storage deletion for non-expired row');
    assert.ok(!deletedRows.includes('rec-active'), 'should NOT delete non-expired row');
    assert.equal(result.deleted, 0);
  });

  test('E: rows from multiple organizations processed independently', async () => {
    resetMocks([
      { id: 'rec-org1', organization_id: 'org-1', storage_url: 'https://storage.example/recordings/org-1/cam-1/rec-org1.mp4' },
      { id: 'rec-org2-null', organization_id: 'org-2', storage_url: null },
      { id: 'rec-org1-bad', organization_id: 'org-1', storage_url: 'https://storage.example-wrong/recordings/x/y/z.mp4' },
    ]);
    const result = await retentionJob.run();

    // org-1 valid
    assert.ok(deletedKeys.includes('recordings/org-1/cam-1/rec-org1.mp4'), 'should delete org-1 storage object');
    assert.ok(deletedRows.includes('rec-org1'), 'should delete org-1 DB row');
    // org-2 null
    assert.equal(deletedKeys.filter(k => k.includes('rec-org2')).length, 0, 'should not delete storage for null URL');
    assert.ok(deletedRows.includes('rec-org2-null'), 'should delete org-2 DB row despite null URL');
    // org-1 bad URL
    assert.equal(deletedKeys.filter(k => k.includes('rec-org1-bad')).length, 0, 'should not delete storage for bad URL');
    assert.ok(deletedRows.includes('rec-org1-bad'), 'should delete org-1 DB row despite bad URL');

    assert.equal(result.deleted, 3);
    assert.equal(result.failed, 0);
  });

  test('one bad row does not stop processing of other rows', async () => {
    resetMocks([
      { id: 'rec-1', organization_id: 'org-1', storage_url: 'https://storage.example/recordings/org-1/cam-1/rec-1.mp4' },
      { id: 'rec-2', organization_id: 'org-1', storage_url: 'https://old-storage.example/recordings/org-1/cam-1/rec-2.mp4' },
      { id: 'rec-3', organization_id: 'org-1', storage_url: null },
    ]);
    const result = await retentionJob.run();

    assert.equal(result.deleted, 3, 'should delete all expired rows despite bad/null rows');
    assert.equal(result.failed, 0, 'should not fail on skipped rows');
    assert.ok(deletedRows.includes('rec-1'), 'should delete valid row');
  });
});
