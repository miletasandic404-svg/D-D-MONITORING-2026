'use strict';

/**
 * Tests for api/cameras.js — the camera API dispatcher.
 *
 * Phase 2 regression suite: direct camera CREATION through POST /api/cameras
 * is disabled — every camera must be created through the verified setup
 * pipeline (POST /api/cameras?path=setup-create -> task queue ->
 * camera-setup-agent -> RTSP/ONVIF verification -> preview -> DB
 * registration). This endpoint only keeps accepting metadata updates for
 * cameras that already exist (created through that pipeline), so an
 * unverified camera can never be inserted via a direct POST.
 *
 * All external dependencies are faked before the module under test is
 * required, so these tests never hit a real database, a real session store,
 * MediaMTX, or Redis (same technique as test/camera_cloud.test.js).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── fake db ──────────────────────────────────────────────────────────────
const db = require('../db/index');
let queryCalls = [];
let platformAdminCalls = [];
let dbScript = null; // (text, params) => { rows, rowCount }
let mtxAddCalls = [];

let orgStatusMock = { status: 'active', camera_limit: 5 };
let cameraCountMock = 0;

function resetFakes() {
  queryCalls = [];
  platformAdminCalls = [];
  dbScript = null;
  mtxAddCalls = [];
  authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
  orgStatusMock = { status: 'active', camera_limit: 5 };
  cameraCountMock = 0;
}

db.queryAsOrg = async (orgId, text, params) => {
  queryCalls.push({ orgId, text, params });
  if (text.includes('FROM organizations WHERE id = $1')) {
    return { rows: [orgStatusMock], rowCount: 1 };
  }
  if (text.includes('AS total')) {
    return { rows: [{ total: cameraCountMock }], rowCount: 1 };
  }
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

db.queryAsPlatformAdmin = async (text, params) => {
  platformAdminCalls.push({ text, params });
  if (dbScript) return dbScript(text, params);
  return { rows: [], rowCount: 0 };
};

// ── fake auth ────────────────────────────────────────────────────────────
const authModule = require('../lib/_auth');
// Mutable response: handler je require-ovan posle ovoga i uhvatio je ovu
// delegat funkciju, pa per-test promene idu kroz authResponse.
let authResponse = { userId: 'user-1', organizationId: 'org-1', role: 'org_admin' };
authModule.requireAuth = async () => authResponse;
authModule.getAccessibleCameraIds = async () => null;

// ── fake rate limit ──────────────────────────────────────────────────────
const rateLimitModule = require('../lib/_rate_limit');
rateLimitModule.rateLimit = async () => true;

// ── fake media node picker (used by setup-create) ────────────────────────
const mediaNodesModule = require('../lib/_media_nodes');
mediaNodesModule.pickMediaNodeForCamera = async () => ({
  id: 'node-1',
  public_hls_url: 'https://hls.example.test/hls',
});

// ── fake MediaMTX client (no network) ────────────────────────────────────
const mediamtxModule = require('../lib/_mediamtx_client');
mediamtxModule.addOrUpdateCameraPath = async (cameraId, rtspUrl) => {
  mtxAddCalls.push({ cameraId, rtspUrl });
  return true;
};
mediamtxModule.deleteCameraPath = async () => true;

// ── load module under test AFTER patching its dependencies ───────────────
const handler = require('../api/cameras');

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

const existingRow = {
  organization_id: 'org-1',
  media_node_id: 'node-1',
  rtsp_url: 'rtsp://camera-ip/stream',
};

const otherOrgRow = {
  organization_id: 'org-2',
  media_node_id: 'node-9',
  rtsp_url: 'rtsp://other-org/stream',
};

describe('api/cameras — Phase 2: no direct camera creation', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('POST /api/cameras with an unknown id is rejected (409) and no camera INSERT runs', async () => {
    dbScript = () => ({ rows: [], rowCount: 0 }); // camera does not exist
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-NEW', name: 'New cam', rtsp_url: 'rtsp://new-cam/stream' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Direct camera creation is disabled/i);
    const inserts = queryCalls.filter((c) => c.text.startsWith('INSERT INTO cameras'));
    assert.equal(inserts.length, 0, 'an unverified camera may never be inserted via direct POST');
  });

  test('POST /api/cameras with an existing id updates metadata of a verified camera', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT 1 FROM cameras WHERE organization_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...existingRow }] };
      }
      if (text.startsWith('INSERT INTO cameras')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Renamed', rtsp_url: 'rtsp://camera-ip/stream', location: 'yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    const insert = queryCalls.find((c) => c.text.startsWith('INSERT INTO cameras'));
    assert.ok(insert, 'an upsert ran for the existing camera');
    assert.equal(insert.orgId, 'org-1');
    assert.ok(insert.text.includes('ON CONFLICT (id) DO UPDATE'));
  });

  test('POST /api/cameras with an id belonging to another org is rejected (403)', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...otherOrgRow }] };
      }
      return { rows: [], rowCount: 0 }; // dup-check passes; camera belongs to org-2
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-OTHER', name: 'Sneaky', rtsp_url: 'rtsp://other-org/stream' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /different organization/i);
  });

  test('POST /api/cameras?path=setup-create still creates a verified setup task', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) {
        return { rows: [{ id: 'task-1', status: 'pending' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.taskId, 'task-1');
    assert.equal(res.body.node.id, 'node-1');
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'a setup task was created through the blessed pipeline');
    assert.equal(taskInsert.orgId, 'org-1');
  });

  test('GET /api/cameras still lists the org cameras', async () => {
    dbScript = (text) => {
      if (text.includes('FROM cameras c')) {
        return {
          rows: [{ id: 'CAM-01', name: 'Back Yard', rtsp_url: 'rtsp://camera-ip/stream', enabled: true }],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.cameras.length, 1);
    const listQuery = queryCalls.find((c) => c.text.includes('FROM cameras c'));
    assert.equal(listQuery.orgId, 'org-1');
  });

  // ── Dashboard "Offline Cameras" tile: SELECT must include c.status ─
  test('GET /api/cameras SELECT includes c.status so the Offline tile can count heartbeat-offline cameras', async () => {
    dbScript = (text) => {
      if (text.includes('FROM cameras c')) {
        return {
          rows: [
            { id: 'CAM-01', name: 'Back Yard',  rtsp_url: null, enabled: true,  status: 'online'  },
            { id: 'CAM-02', name: 'Side Gate',  rtsp_url: null, enabled: true,  status: 'offline' },
            { id: 'CAM-03', name: 'Front Door', rtsp_url: null, enabled: false, status: null      },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const listQuery = queryCalls.find((c) => c.text.includes('FROM cameras c'))?.text || '';
    // c.status and c.last_seen_at are required for the
    // Dashboard's "Offline Cameras" tile to derive an honest
    // offline count from heartbeat data.
    assert.match(listQuery, /\bc\.status\b/, 'cameras list SELECT must include c.status');
    assert.match(listQuery, /\bc\.last_seen_at\b/, 'cameras list SELECT must include c.last_seen_at');
    // Verify the response carries them through to the client.
    assert.equal(res.body.cameras[0].status, 'online');
    assert.equal(res.body.cameras[1].status, 'offline');
    assert.equal(res.body.cameras[2].status, null);
  });

  test('POST /api/cameras?path=setup-create (mode=scan) still creates a scan task', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) {
        return { rows: [{ id: 'task-scan-1', status: 'pending' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'scan' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.taskId, 'task-scan-1');
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'a scan setup task was created');
    assert.equal(taskInsert.orgId, 'org-1');
    assert.equal(taskInsert.params[3], 'scan');
  });

  test('POST /api/cameras?path=setup-create (mode=onvif) stores encrypted credentials', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) {
        return { rows: [{ id: 'task-onvif-1', status: 'pending' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'onvif', ip: '192.168.1.50', onvif_port: 80, username: 'admin', password: 'secret' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.taskId, 'task-onvif-1');
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'an onvif setup task was created');
    assert.equal(taskInsert.orgId, 'org-1');
    assert.equal(taskInsert.params[3], 'onvif');
    // Credentials must never be stored in plaintext on the task row.
    assert.ok(taskInsert.params[8] && typeof taskInsert.params[8] === 'string',
      'encrypted_credentials must be a non-empty encrypted blob');
    assert.ok(!taskInsert.params[8].includes('secret'),
      'plaintext password must not appear in the stored credentials blob');
  });

  test('GET /api/cameras?path=setup-node (org user): health lookup is organization-scoped', async () => {
    dbScript = (text) => {
      if (text.includes('FROM media_nodes')) {
        return { rows: [{ mediamtx_online: true, tunnel_online: false, health_json: null, health_checked_at: null }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET', query: { path: 'setup-node' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    // Health lookup mora ici kroz queryAsOrg (ne platform admin), sa
    // eksplicitnim tenant filterom zasnovanim na auth.organizationId.
    assert.equal(platformAdminCalls.length, 0, 'org user must never use queryAsPlatformAdmin');
    const healthCall = queryCalls.find((c) => c.text.includes('FROM media_nodes'));
    assert.ok(healthCall, 'health lookup ran');
    assert.equal(healthCall.orgId, 'org-1');
    assert.match(healthCall.text, /organization_id = \$1/);
    assert.equal(healthCall.params[0], 'org-1', 'organization_id = $1 must be auth.organizationId');
    assert.equal(healthCall.params[1], 'node-1', 'node id stays the second parameter');
    assert.match(healthCall.text, /id = \$2/);
  });

  test('GET /api/cameras?path=setup-node (org user): node health je ogranicen na sopstvenu org', async () => {
    // Cak i kada bi neki drugi node id dospeo u lookup, tenant filter
    // (organization_id = $1) mora fail-closed: ne postoji nacin da se
    // dobije health podatak node-a druge organizacije.
    dbScript = (text) => {
      if (text.includes('FROM media_nodes')) {
        return { rows: [{ mediamtx_online: true, tunnel_online: false, health_json: null, health_checked_at: null }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET', query: { path: 'setup-node' } });
    const res = makeRes();
    await handler(req, res);

    const healthCall = queryCalls.find((c) => c.text.includes('FROM media_nodes'));
    assert.ok(healthCall, 'health lookup ran');
    assert.ok(healthCall.text.includes('organization_id = $1'));
    assert.equal(healthCall.params[0], 'org-1');
    // nodeId u query-ju NIJE ulazni parametar: node dolazi iskljucivo iz
    // org-scoped pickera, a tenant filter je auth.organizationId.
    assert.equal(req.query.nodeId, undefined);
    assert.equal(healthCall.params[1], 'node-1', 'node id dolazi iz pickera, ne iz requesta');
  });

  test('GET /api/cameras?path=setup-node (platform_admin): globalni health behavior ostaje nepromenjen', async () => {
    authResponse = { userId: 'admin-1', organizationId: 'org-1', userType: 'platform_admin' };
    dbScript = (text) => {
      if (text.includes('FROM media_nodes')) {
        return { rows: [{ mediamtx_online: true, tunnel_online: false, health_json: null, health_checked_at: null }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET', query: { path: 'setup-node' } });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(queryCalls.length, 0, 'platform_admin must not use queryAsOrg for health');
    const healthCall = platformAdminCalls.find((c) => c.text.includes('FROM media_nodes'));
    assert.ok(healthCall, 'platform health lookup ran through queryAsPlatformAdmin');
    assert.doesNotMatch(healthCall.text, /organization_id/);
    assert.deepEqual(healthCall.params, ['node-1']);
  });

  test('POST /api/cameras with same URL+credentials as DB does NOT trigger MediaMTX reload', async () => {
    const cleanDbUrl = 'rtsp://192.168.1.50:554/stream1';
    dbScript = (text) => {
      if (text.includes('SELECT 1 FROM cameras WHERE organization_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ organization_id: 'org-1', media_node_id: 'node-1', rtsp_url: cleanDbUrl }] };
      }
      if (text.startsWith('INSERT INTO cameras')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const urlWithCreds = 'rtsp://admin:secret@192.168.1.50:554/stream1';
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Metadata only update', stream_url: urlWithCreds, location: 'yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(mtxAddCalls.length, 0, 'addOrUpdateCameraPath must NOT be called when RTSP host/path is unchanged');
  });
});

describe('api/cameras — organization status gate (Critical #3)', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('POST /api/cameras?path=setup-create: active org allows setup task creation', async () => {
    dbScript = (text) => {
      if (text.includes('FROM organizations WHERE id = $1')) return { rows: [{ status: 'active' }], rowCount: 1 };
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-active', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.taskId, 'task-active');
  });

  test('POST /api/cameras?path=setup-create: pending org is blocked (403)', async () => {
    orgStatusMock = { status: 'pending' };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
    const inserts = queryCalls.filter((c) => c.text.includes('INSERT INTO camera_setup_tasks'));
    assert.equal(inserts.length, 0, 'no setup task should be created for a pending org');
  });

  test('POST /api/cameras?path=setup-create: suspended org is blocked (403)', async () => {
    orgStatusMock = { status: 'suspended' };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
    const inserts = queryCalls.filter((c) => c.text.includes('INSERT INTO camera_setup_tasks'));
    assert.equal(inserts.length, 0, 'no setup task should be created for a suspended org');
  });

  test('POST /api/cameras?path=setup-create: unknown status (e.g. "trial") is blocked (403)', async () => {
    orgStatusMock = { status: 'trial' };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
  });

  test('POST /api/cameras (direct): active org allows metadata update on existing camera', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT status FROM organizations WHERE id = $1')) return { rows: [{ status: 'active' }], rowCount: 1 };
      if (text.includes('SELECT 1 FROM cameras WHERE organization_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...existingRow }] };
      }
      if (text.startsWith('INSERT INTO cameras')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Renamed', rtsp_url: 'rtsp://camera-ip/stream', location: 'yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
  });

  test('POST /api/cameras (direct): pending org is blocked (403)', async () => {
    orgStatusMock = { status: 'pending' };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Renamed', rtsp_url: 'rtsp://camera-ip/stream' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
  });

  test('POST /api/cameras (direct): suspended org is blocked (403)', async () => {
    orgStatusMock = { status: 'suspended' };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Renamed', rtsp_url: 'rtsp://camera-ip/stream' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
  });

  test('GET /api/cameras is NOT affected by org status gate (read-only route)', async () => {
    orgStatusMock = { status: 'pending' };
    dbScript = (text) => {
      if (text.includes('FROM cameras c')) {
        return { rows: [{ id: 'CAM-01', name: 'Back Yard', rtsp_url: 'rtsp://camera-ip/stream', enabled: true }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.count, 1);
  });
});

describe('api/cameras — organization camera limit gate (Critical #4)', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('active org: camera_limit=5, current=0 -> setup-create dozvoljen (201)', async () => {
    orgStatusMock = { status: 'active', camera_limit: 5 };
    cameraCountMock = 0;
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam 1' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.taskId, 'task-1');
  });

  test('active org: camera_limit=5, current=4 -> dozvoljen još jedan (201)', async () => {
    orgStatusMock = { status: 'active', camera_limit: 5 };
    cameraCountMock = 4;
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-2', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam 5' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  });

  test('active org: camera_limit=5, current=5 -> blokirano (403), nema task INSERT', async () => {
    orgStatusMock = { status: 'active', camera_limit: 5 };
    cameraCountMock = 5;
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam 6' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /camera limit reached/i);
    assert.equal(res.body.camera_limit, 5);
    assert.equal(res.body.current_camera_count, 5);
    const inserts = queryCalls.filter((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.equal(inserts.length, 0, 'no setup task should be created when limit is reached');
  });

  test('active org: camera_limit=5, current=6 -> blokirano (403)', async () => {
    orgStatusMock = { status: 'active', camera_limit: 5 };
    cameraCountMock = 6;
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam 7' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /camera limit reached/i);
    const inserts = queryCalls.filter((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.equal(inserts.length, 0);
  });

  test('pending org: i dalje blokiran preko Critical #3 (403, not camera limit)', async () => {
    orgStatusMock = { status: 'pending', camera_limit: 5 };
    cameraCountMock = 0;
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
  });

  test('suspended org: i dalje blokiran preko Critical #3 (403, not camera limit)', async () => {
    orgStatusMock = { status: 'suspended', camera_limit: 5 };
    cameraCountMock = 0;
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not active/i);
  });

  test('falsifikovan organization_id u body ne menja tenant/limit', async () => {
    orgStatusMock = { status: 'active', camera_limit: 1 };
    cameraCountMock = 0;
    authResponse = { userId: 'user-1', organizationId: 'org-target', role: 'org_admin' };
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'task INSERT ran');
    assert.equal(taskInsert.orgId, 'org-target', 'org_id from auth, not from request body');
  });

  test('paralelni setup requests: pending task broji kao rezervacija', async () => {
    orgStatusMock = { status: 'active', camera_limit: 5 };
    cameraCountMock = 4;
    dbScript = (text, params) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) {
        return { rows: [{ id: 'task-reserve', status: 'pending' }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);

    cameraCountMock = 5;
    const req2 = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip-2/stream', camera_name: 'Cam 2' },
    });
    const res2 = makeRes();
    await handler(req, res2);

    assert.equal(res2.statusCode, 403, 'second request blocked because 4 cameras + 1 pending task = 5 = limit');
    assert.match(res2.body.error, /camera limit reached/i);
  });

  test('camera_limit=0 (unlimited) ne blokira setup-create', async () => {
    orgStatusMock = { status: 'active', camera_limit: 0 };
    cameraCountMock = 99;
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  });
});

describe('api/cameras — setup-create assigned_node_id (platform node support)', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('setup-create INSERT includes assigned_node_id = node.id', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'a setup task was created');
    assert.match(taskInsert.text, /assigned_node_id/,
      'INSERT must include assigned_node_id column');
    assert.equal(taskInsert.params[11], 'node-1',
      'assigned_node_id param must be the node.id from pickMediaNodeForCamera');
  });

  test('setup-create task.organization_id is scoped to requesting org, not node org', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Back Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.equal(taskInsert.params[0], 'org-1',
      'organization_id param must be the requesting org, not the node org');
  });
});

describe('api/cameras — camera location flow', () => {
  beforeEach(() => {
    resetFakes();
  });

  test('F) setup-create forwards location/lat/lng into the task result jsonb', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-loc-1', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Yard', location: 'Front yard', lat: 45.0, lng: -75.0 },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    assert.ok(taskInsert, 'a setup task was created');
    assert.match(taskInsert.text, /result/, 'INSERT must include the result column');
    const payload = JSON.parse(taskInsert.params[12]);
    assert.equal(payload.location, 'Front yard');
    assert.equal(payload.lat, 45.0);
    assert.equal(payload.lng, -75.0);
  });

  test('B) setup-create without location stores nulls in the task result jsonb', async () => {
    dbScript = (text) => {
      if (text.startsWith('INSERT INTO camera_setup_tasks')) return { rows: [{ id: 'task-loc-2', status: 'pending' }] };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', camera_name: 'Yard' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const taskInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO camera_setup_tasks'));
    const payload = JSON.parse(taskInsert.params[12]);
    assert.equal(payload.location, null);
    assert.equal(payload.lat, null);
    assert.equal(payload.lng, null);
  });

  test('D) setup-create rejects out-of-range latitude (400)', async () => {
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'manual', rtsp_url: 'rtsp://camera-ip/stream', location: 'x', lat: 95, lng: 0 },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  test('E) setup-create rejects out-of-range longitude (400)', async () => {
    const req = makeReq({
      method: 'POST',
      query: { path: 'setup-create' },
      body: { mode: 'onvif', ip: '192.168.1.50', location: 'x', lat: 0, lng: 200 },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  test('H) GET /api/cameras returns location/lat/lng columns', async () => {
    dbScript = (text) => {
      if (text.includes('FROM cameras c')) {
        return {
          rows: [{ id: 'CAM-01', name: 'Yard', rtsp_url: 'rtsp://camera-ip/stream', enabled: true, location: 'Front yard', lat: 45.0, lng: -75.0 }],
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const listQuery = queryCalls.find((c) => c.text.includes('FROM cameras c'));
    assert.ok(listQuery, 'GET /cameras ran the cameras query');
    assert.match(listQuery.text, /c\.location/, 'SELECT must include c.location');
    assert.match(listQuery.text, /c\.lat/, 'SELECT must include c.lat');
    assert.match(listQuery.text, /c\.lng/, 'SELECT must include c.lng');
    assert.equal(res.body.cameras[0].location, 'Front yard');
    assert.equal(res.body.cameras[0].lat, 45.0);
    assert.equal(res.body.cameras[0].lng, -75.0);
  });

  test('A) POST /api/cameras (upsert) writes location/lat/lng to the cameras row', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT 1 FROM cameras WHERE organization_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...existingRow }] };
      }
      if (text.startsWith('INSERT INTO cameras')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Yard Cam', location: 'Front yard', lat: 45.0, lng: -75.0 },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    const insert = queryCalls.find((c) => c.text.startsWith('INSERT INTO cameras'));
    assert.ok(insert, 'an upsert ran for the existing camera');
    assert.equal(insert.params[3], 'Front yard'); // location
    assert.equal(insert.params[4], 45.0); // lat
    assert.equal(insert.params[5], -75.0); // lng
  });

  test('C) POST /api/cameras (upsert) allows clearing location/lat/lng (NULL)', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT 1 FROM cameras WHERE organization_id')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...existingRow }] };
      }
      if (text.startsWith('INSERT INTO cameras')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-01', name: 'Yard Cam' },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    const insert = queryCalls.find((c) => c.text.startsWith('INSERT INTO cameras'));
    assert.equal(insert.params[3], null); // location
    assert.equal(insert.params[4], null); // lat
    assert.equal(insert.params[5], null); // lng
  });

  test('D) POST /api/cameras rejects invalid latitude (400)', async () => {
    const req = makeReq({ method: 'POST', body: { id: 'CAM-01', name: 'x', lat: 95, lng: 0 } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  test('E) POST /api/cameras rejects invalid longitude (400)', async () => {
    const req = makeReq({ method: 'POST', body: { id: 'CAM-01', name: 'x', lat: 0, lng: 200 } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  test('I) POST /api/cameras: updating a camera of another org is blocked (403, no INSERT)', async () => {
    dbScript = (text) => {
      if (text.includes('SELECT organization_id, media_node_id, rtsp_url FROM cameras')) {
        return { rows: [{ ...otherOrgRow }] };
      }
      return { rows: [], rowCount: 0 };
    };
    const req = makeReq({
      method: 'POST',
      body: { id: 'CAM-OTHER', name: 'x', location: 'yard', lat: 1, lng: 2 },
    });
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /different organization/i);
    const cameraInsert = queryCalls.find((c) => c.text.startsWith('INSERT INTO cameras'));
    assert.equal(cameraInsert, undefined, 'no camera INSERT must run for a different-org camera');
  });
});

