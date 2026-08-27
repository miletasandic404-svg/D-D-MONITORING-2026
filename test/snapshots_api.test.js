'use strict';

/**
 * Tests for POST /api/snapshots handler (lib/handlers/snapshots.js).
 *
 * Validates:
 *   - Auth is required (401 when session missing)
 *   - Camera must belong to the caller's org (404 otherwise)
 *   - Base64 is decoded and uploaded via _storage.uploadObject (not stored as a truncated data URL)
 *   - storage_url in the DB INSERT is the real object-storage URL returned by uploadObject
 *   - If storage is not configured, the handler returns 503 and inserts nothing
 *   - Org isolation is enforced (queryAsOrg with the right orgId)
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('assert/strict');
const crypto = require('crypto');

const db = require('../db/index');
let queryCalls = [];
let lastInsert = null;

function resetFakes() {
  queryCalls = [];
  lastInsert = null;
  db.queryAsOrg = (orgId, text, params) => {
    queryCalls.push({ orgId, text, params });
    if (/SELECT id FROM cameras WHERE id = \$1 AND organization_id = \$2/.test(text)) {
      return { rows: [{ id: params[0] }] };
    }
    if (/INSERT INTO snapshots/.test(text)) {
      lastInsert = { text, params };
      return { rows: [{ id: crypto.randomUUID(), taken_at: new Date().toISOString(), storage_url: params[3] }] };
    }
    return { rows: [] };
  };
}

// ── fake storage ─────────────────────────────────────────────────────────────
const storage = require('../lib/_storage');
let uploadCalls = [];
let storageConfigured = true;
let presignedCalls = [];

storage.isConfigured = () => storageConfigured;
storage.uploadObject = async ({ key, body, contentType }) => {
  uploadCalls.push({ key, body, contentType });
  return `https://storage.example/${key}`;
};

// ── fake auth ────────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
let authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };

authModule.requireAuth = async (req, res) => {
  if (authResponse === null) {
    res.status(401).json({ success: false, error: 'No valid session found.' });
    return null;
  }
  return authResponse;
};

// ── fake rate limit ──────────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── fake audit ───────────────────────────────────────────────────────────────
const auditModule = require('../lib/_audit');
auditModule.logAudit = async () => undefined;
auditModule.getIp = () => '127.0.0.1';

// ── fake sentry ─────────────────────────────────────────────────────────────
const sentryModule = require('../lib/_sentry');
sentryModule.initSentry = () => {};

// ── load handler AFTER fakes ─────────────────────────────────────────────────
const handler = require('../lib/handlers/snapshots');

const JFIF_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxAgMDBeJ/loWFDAvPTk9/A',
  'base64',
);

function makeReq(body) {
  return { method: 'POST', url: '/api/snapshots', headers: {}, body };
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('POST /api/snapshots', () => {
  beforeEach(() => {
    resetFakes();
    uploadCalls = [];
    storageConfigured = true;
    presignedCalls = [];
    authResponse = { userId: 'user-1', organizationId: 'org-1', userType: 'org_admin' };
  });

  test('auth required — 401 when no session', async () => {
    authResponse = null;
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1', image_base64: 'base64data' }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(uploadCalls.length, 0);
  });

  test('camera not in org — 404, no upload, no insert', async () => {
    db.queryAsOrg = async (orgId, text, params) => {
      queryCalls.push({ orgId, text, params });
      return { rows: [] }; // camera not found
    };

    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-other', image_base64: JFIF_BYTES.toString('base64') }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(uploadCalls.length, 0);
    assert.equal(queryCalls.filter(c => /INSERT INTO snapshots/.test(c.text)).length, 0);
  });

  test('valid snapshot → base64 decoded → uploadObject called with Buffer', async () => {
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1', image_base64: JFIF_BYTES.toString('base64') }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(uploadCalls.length, 1);
    assert.match(uploadCalls[0].key, /^snapshots\/org-1\/cam-1\/[0-9a-f-]{36}\.jpg$/);
    assert.ok(uploadCalls[0].body instanceof Buffer, 'uploadObject body must be a Buffer, not a string');
    assert.equal(uploadCalls[0].body.length, JFIF_BYTES.length);
    assert.equal(uploadCalls[0].contentType, 'image/jpeg');
  });

  test('storage_url stored in DB is the real uploadObject URL, not a truncated data URL', async () => {
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1', image_base64: JFIF_BYTES.toString('base64') }), res);

    assert.equal(res.statusCode, 201);
    assert.ok(res.body.snapshot.storage_url);
    assert.ok(!res.body.snapshot.storage_url.startsWith('data:image'),
      'storage_url must NOT be a truncated data URL');
    assert.ok(res.body.snapshot.storage_url.includes('storage.example'),
      'storage_url must be a real object-storage URL');
  });

  test('org isolation — queryAsOrg called with caller organizationId', async () => {
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1', image_base64: JFIF_BYTES.toString('base64') }), res);

    assert.ok(queryCalls.every(c => c.orgId === 'org-1'));
    const camCheck = queryCalls.find(c => /SELECT id FROM cameras/.test(c.text));
    assert.deepEqual(camCheck.params, ['cam-1', 'org-1']);
  });

  test('storage not configured — 503, no DB insert', async () => {
    storageConfigured = false;
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1', image_base64: JFIF_BYTES.toString('base64') }), res);

    assert.equal(res.statusCode, 503);
    assert.equal(uploadCalls.length, 0);
    assert.equal(queryCalls.filter(c => /INSERT INTO snapshots/.test(c.text)).length, 0);
  });

  test('invalid body — missing camera_id → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ image_base64: JFIF_BYTES.toString('base64') }), res);
    assert.equal(res.statusCode, 400);
  });

  test('invalid body — missing image_base64 → 400', async () => {
    const res = makeRes();
    await handler(makeReq({ camera_id: 'cam-1' }), res);
    assert.equal(res.statusCode, 400);
  });

  test('GET method — 405', async () => {
    const res = makeRes();
    await handler({ method: 'GET', url: '/api/snapshots', headers: {}, body: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});
