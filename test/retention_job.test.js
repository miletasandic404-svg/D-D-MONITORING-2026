'use strict';

/**
 * Tests for workers/retention-job.js.
 *
 * Validates:
 *   - Valid storage URL -> object + DB row deletion works
 *   - Invalid/mismatched storage URL -> nothing is deleted, orphan is logged
 *   - One bad row does not stop processing of other rows
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

function resetMocks() {
  queryCalls = [];
  deletedKeys = [];
  deletedRows = [];
  logs = [];

  db.queryAsPlatformAdmin = async (text, params) => {
    queryCalls.push({ text, params });
    if (text.includes('SELECT') && text.includes('recordings')) {
      return {
        rows: [
          { id: 'rec-1', storage_url: 'https://storage.example/recordings/org-1/cam-1/rec-1.mp4' },
          { id: 'rec-2', storage_url: 'https://old-storage.example/recordings/org-1/cam-1/rec-2.mp4' },
          { id: 'rec-3', storage_url: null },
        ],
      };
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

  test('valid storage URL -> object + DB row deletion works', async () => {
    const result = await retentionJob.run();

    assert.ok(deletedKeys.includes('recordings/org-1/cam-1/rec-1.mp4'), 'should delete storage object for valid URL');
    assert.ok(deletedRows.includes('rec-1'), 'should delete DB row for valid URL');
    assert.equal(result.deleted, 1);
  });

  test('invalid/mismatched storage URL -> nothing is deleted, orphan is logged', async () => {
    const result = await retentionJob.run();

    assert.ok(!deletedKeys.includes('recordings/org-1/cam-1/rec-2.mp4'), 'should NOT delete storage object for mismatched URL');
    assert.ok(!deletedRows.includes('rec-2'), 'should NOT delete DB row for mismatched URL');
    assert.ok(logs.some(l => l.args.some(a => typeof a === 'string' && a.includes('rec-2'))), 'should log orphan warning');
    assert.equal(result.deleted, 1);
  });

  test('null storage_url is skipped safely', async () => {
    const result = await retentionJob.run();

    assert.ok(!deletedRows.includes('rec-3'), 'should NOT delete DB row for null storage_url');
    assert.ok(logs.some(l => l.args.some(a => typeof a === 'string' && a.includes('rec-3'))), 'should log null URL warning');
  });

  test('one bad row does not stop processing of other rows', async () => {
    const result = await retentionJob.run();

    assert.equal(result.deleted, 1, 'should process valid row despite bad rows');
    assert.equal(result.failed, 0, 'should not fail on skipped rows');
    assert.ok(deletedRows.includes('rec-1'), 'should delete valid row');
  });
});
