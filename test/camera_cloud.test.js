'use strict';

/**
 * Tests for api/camera-cloud.js — the vendor-cloud camera onboarding
 * endpoint (Tuya/Hikvision/Reolink), which lets an org connect cameras
 * that already push to their manufacturer's cloud, without any local
 * media node on the customer's site.
 *
 * All external dependencies are faked before the module under test is
 * required, so these tests never hit a real database, a real session
 * store, or a real vendor API:
 *   - db.queryAsOrg is replaced with an in-memory recorder/responder
 *     (same technique as test/payment.test.js)
 *   - lib/_auth's requireAuth is replaced with a fake authenticated org admin
 *   - lib/_global_camera_discovery's vendor classes are replaced with
 *     fakes whose behavior each test controls directly
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let fakeQueryFn = null;

function resetFakes() {
  queryCalls = [];
  fakeQueryFn = null;
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (fakeQueryFn) return fakeQueryFn(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
authModule.requireAuth = async () => ({
  userId: 'user-1',
  organizationId: 'org-1',
  role: 'org_admin',
});

// ── fake vendor discovery classes ───────────────────────────────────────
const discoveryModule = require('../lib/_global_camera_discovery');
let tuyaBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };
let hikvisionBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };
let reolinkBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };

discoveryModule.TuyaCloudDiscovery = class {
  constructor(clientId, clientSecret, region) { this.args = { clientId, clientSecret, region }; }
  discoverCameras(...a) { return tuyaBehavior.discoverCameras(...a); }
  getRtspUrl(...a) { return tuyaBehavior.getRtspUrl(...a); }
};
discoveryModule.HikvisionCloudDiscovery = class {
  constructor(accessToken, region) { this.args = { accessToken, region }; }
  discoverCameras(...a) { return hikvisionBehavior.discoverCameras(...a); }
  getRtspUrl(...a) { return hikvisionBehavior.getRtspUrl(...a); }
};
discoveryModule.ReolinkCloudDiscovery = class {
  constructor(accessToken) { this.args = { accessToken }; }
  discoverCameras(...a) { return reolinkBehavior.discoverCameras(...a); }
  getRtspUrl(...a) { return reolinkBehavior.getRtspUrl(...a); }
};

// ── load module under test AFTER patching its dependencies ───────────────
const handler = require('../api/camera-cloud');

// ── req/res test helpers ──────────────────────────────────────────────────
function makeReq({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('api/camera-cloud', () => {
  beforeEach(() => {
    resetFakes();
    tuyaBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };
    hikvisionBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };
    reolinkBehavior = { discoverCameras: async () => [], getRtspUrl: async () => null };
  });

  describe('POST ?path=connect', () => {
    test('rejects an unknown provider', async () => {
      const req = makeReq({ method: 'POST', query: { path: 'connect' }, body: { provider: 'nope', credentials: {} } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
    });

    test('rejects tuya credentials missing clientSecret', async () => {
      const req = makeReq({
        method: 'POST',
        query: { path: 'connect' },
        body: { provider: 'tuya', credentials: { clientId: 'abc' } },
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 400);
    });

    test('saves a connected account when the vendor check succeeds', async () => {
      tuyaBehavior.discoverCameras = async () => [{ id: 'dev-1', name: 'Front Door' }];
      fakeQueryFn = (text) => {
        if (text.startsWith('INSERT INTO camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'tuya', label: 'HQ', status: 'connected', last_checked_at: new Date(), last_error: null, created_at: new Date() }] };
        }
        return { rows: [] };
      };

      const req = makeReq({
        method: 'POST',
        query: { path: 'connect' },
        body: { provider: 'tuya', label: 'HQ', credentials: { clientId: 'abc', clientSecret: 'xyz', region: 'eu' } },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.account.status, 'connected');
      // The insert must carry an encrypted blob, not the raw secret.
      const insertCall = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_cloud_accounts'));
      assert.ok(insertCall);
      const encryptedBlob = insertCall.params[3];
      assert.ok(!encryptedBlob.includes('xyz'), 'stored credentials must not contain the plaintext secret');
    });

    test('still saves the account (as status=error) when the vendor check throws', async () => {
      tuyaBehavior.discoverCameras = async () => { throw new Error('401 Unauthorized'); };
      fakeQueryFn = (text) => {
        if (text.startsWith('INSERT INTO camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-2', provider: 'tuya', label: '', status: 'error', last_checked_at: new Date(), last_error: '401 Unauthorized', created_at: new Date() }] };
        }
        return { rows: [] };
      };

      const req = makeReq({
        method: 'POST',
        query: { path: 'connect' },
        body: { provider: 'tuya', credentials: { clientId: 'abc', clientSecret: 'bad' } },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.account.status, 'error');
      assert.equal(res.body.account.last_error, '401 Unauthorized');
    });
  });

  describe('GET ?path=accounts', () => {
    test('lists accounts without leaking encrypted_credentials', async () => {
      fakeQueryFn = () => ({
        rows: [{ id: 'acct-1', provider: 'tuya', label: 'HQ', status: 'connected', last_checked_at: new Date(), last_error: null, created_at: new Date() }],
      });
      const req = makeReq({ method: 'GET', query: { path: 'accounts' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.accounts.length, 1);
      assert.equal(res.body.accounts[0].encrypted_credentials, undefined);
    });
  });

  describe('DELETE ?path=accounts', () => {
    test('returns 400 for a non-uuid id', async () => {
      const req = makeReq({ method: 'DELETE', query: { path: 'accounts', id: 'not-a-uuid' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 400);
    });

    test('returns 404 when nothing was deleted', async () => {
      fakeQueryFn = () => ({ rows: [], rowCount: 0 });
      const req = makeReq({ method: 'DELETE', query: { path: 'accounts', id: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    });

    test('returns success when a row is deleted', async () => {
      fakeQueryFn = () => ({ rows: [], rowCount: 1 });
      const req = makeReq({ method: 'DELETE', query: { path: 'accounts', id: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.deleted, true);
    });
  });

  describe('GET ?path=discover', () => {
    test('marks cameras already present in the DB as already_imported', async () => {
      hikvisionBehavior.discoverCameras = async () => [
        { device_id: 'dev-1', name: 'Gate' },
        { device_id: 'dev-2', name: 'Lobby' },
      ];
      const { encrypt } = require('../lib/_crypto');
      const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'tok', region: 'eu' }));

      fakeQueryFn = (text) => {
        if (text.includes('FROM camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'hikvision', encrypted_credentials: encryptedCreds }] };
        }
        if (text.includes('FROM cameras WHERE cloud_account_id')) {
          return { rows: [{ cloud_device_id: 'dev-1' }] };
        }
        return { rows: [] };
      };

      const req = makeReq({ method: 'GET', query: { path: 'discover', accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6' } });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);
      const byId = Object.fromEntries(res.body.cameras.map((c) => [c.device_id, c]));
      assert.equal(byId['dev-1'].already_imported, true);
      assert.equal(byId['dev-2'].already_imported, false);
    });

    test('returns 502 when the vendor API call fails', async () => {
      hikvisionBehavior.discoverCameras = async () => { throw new Error('timeout'); };
      const { encrypt } = require('../lib/_crypto');
      const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'tok' }));
      fakeQueryFn = (text) => {
        if (text.includes('FROM camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'hikvision', encrypted_credentials: encryptedCreds }] };
        }
        return { rows: [] };
      };

      const req = makeReq({ method: 'GET', query: { path: 'discover', accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    });

    test('returns 404 for an account belonging to another org / not found', async () => {
      fakeQueryFn = () => ({ rows: [] });
      const req = makeReq({ method: 'GET', query: { path: 'discover', accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST ?path=import', () => {
    test('rejects an invalid camera id', async () => {
      const req = makeReq({
        method: 'POST',
        query: { path: 'import' },
        body: { accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6', deviceId: 'dev-1', id: 'has spaces', name: 'Cam' },
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 400);
    });

    test('returns 502 when the vendor has no stream URL for the device', async () => {
      const { encrypt } = require('../lib/_crypto');
      const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'tok' }));
      reolinkBehavior.getRtspUrl = async () => null;
      fakeQueryFn = (text) => {
        if (text.includes('FROM camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'reolink', encrypted_credentials: encryptedCreds }] };
        }
        return { rows: [] };
      };

      const req = makeReq({
        method: 'POST',
        query: { path: 'import' },
        body: { accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6', deviceId: 'dev-1', id: 'CAM-01', name: 'Front' },
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    });

    test('imports the camera using the vendor RTSP URL and tags it with cloud_account_id/cloud_device_id', async () => {
      const { encrypt } = require('../lib/_crypto');
      const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'tok' }));
      reolinkBehavior.getRtspUrl = async () => 'rtsp://relay.reolink.com/live/dev-1';

      fakeQueryFn = (text) => {
        if (text.includes('FROM camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'reolink', encrypted_credentials: encryptedCreds }] };
        }
        if (text.startsWith('SELECT id FROM sites')) {
          return { rows: [{ id: 'site-1' }] };
        }
        if (text.startsWith('INSERT INTO cameras')) {
          return { rows: [{ id: 'CAM-01', name: 'Front', cloud_account_id: 'acct-1', cloud_device_id: 'dev-1' }] };
        }
        return { rows: [] };
      };

      const req = makeReq({
        method: 'POST',
        query: { path: 'import' },
        body: { accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6', deviceId: 'dev-1', id: 'CAM-01', name: 'Front' },
      });
      const res = makeRes();
      await handler(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.camera.id, 'CAM-01');
      const insertCall = queryCalls.find((c) => c.text.startsWith('INSERT INTO cameras'));
      assert.ok(insertCall.params.includes('rtsp://relay.reolink.com/live/dev-1'));
    });

    test('returns 400 when the org has no site and none was specified', async () => {
      const { encrypt } = require('../lib/_crypto');
      const encryptedCreds = encrypt(JSON.stringify({ accessToken: 'tok' }));
      reolinkBehavior.getRtspUrl = async () => 'rtsp://relay.reolink.com/live/dev-1';
      fakeQueryFn = (text) => {
        if (text.includes('FROM camera_cloud_accounts')) {
          return { rows: [{ id: 'acct-1', provider: 'reolink', encrypted_credentials: encryptedCreds }] };
        }
        if (text.startsWith('SELECT id FROM sites')) {
          return { rows: [] };
        }
        return { rows: [] };
      };

      const req = makeReq({
        method: 'POST',
        query: { path: 'import' },
        body: { accountId: 'a1a2a3a4-b1b2-4b3b-8b4b-c1c2c3c4c5c6', deviceId: 'dev-1', id: 'CAM-01', name: 'Front' },
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 400);
    });
  });

  describe('unknown path', () => {
    test('returns 404', async () => {
      const req = makeReq({ method: 'GET', query: { path: 'bogus' } });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    });
  });
});
