'use strict';

/**
 * Integration tests for workers/two-way-audio-api.js (DVRIP / OPTalk
 * talkdown). The test harness owns the server lifecycle by
 * requiring the worker with TALKDOWN_TEST_EXPORT=1, then closing
 * the http.Server in `after()`. Fakes the DB pool, logAudit, and
 * XiongmaiDvripAdapter.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

// Patch the pg Pool constructor BEFORE requiring the worker.
const pg = require('pg');
const OriginalPool = pg.Pool;
const RealPool = OriginalPool;
let fakePoolInstance = null;
pg.Pool = function (cfg) {
  return fakePoolInstance || new RealPool(cfg);
};
// Also expose fakePoolInstance for the test code to swap.
global.__setFakePool = (p) => { fakePoolInstance = p; };

// ── DB / adapter fakes ──────────────────────────────────────────────
const dbState = {
  tokenUserId: 'u1',
  tokenCameraId: 'cam_dvrip_1',
  overrideValidate: null,
  overrideGetCamera: null,
  auditCalls: [],
  auditShouldThrow: false,
  // Adapter behavior overrides for the lifetime of a single test.
  adapterMode: 'default', // 'default' | 'hang' | 'throw'
};

const poolState = {
  validateCalls: 0,
  queryCalls: 0,
};

const fakePool = {
  query: async (sql, params) => {
    poolState.queryCalls += 1;
    if (/FROM camera_stream_tokens/.test(sql)) {
      poolState.validateCalls += 1;
      if (typeof dbState.overrideValidate === 'function') {
        return dbState.overrideValidate(sql, params);
      }
      return {
        rows: [{
          user_id: dbState.tokenUserId,
          camera_id: dbState.tokenCameraId,
          expires_at: new Date(Date.now() + 60_000),
        }],
      };
    }
    if (/FROM cameras WHERE id/.test(sql)) {
      if (typeof dbState.overrideGetCamera === 'function') {
        return dbState.overrideGetCamera(sql, params);
      }
      return {
        rows: [{
          id: 'cam_dvrip_1',
          name: 'Xiongmai Test',
          connection_type: 'dvrip',
          ip: '127.0.0.1',
          port: 34567,
          rtsp_username: 'admin',
          rtsp_password_encrypted: null,
          organization_id: 'org-1',
        }],
      };
    }
    return { rows: [] };
  },
  end: async () => {},
};
fakePoolInstance = fakePool;

// Build a fresh adapter every time the factory is invoked so the
// dbState.adapterMode controls behavior for the current test.
let _hangStartTalkPromise = null;
const fakeAdapter = {
  authenticate: async () => {},
  startTalk: async () => {
    if (dbState.adapterMode === 'hang') {
      // Never resolves on its own; the server's 5 s timeout must
      // surface a 504 to the client.
      return new Promise(() => {});
    }
    if (dbState.adapterMode === 'throw') {
      throw new Error('simulated adapter failure');
    }
    return { ok: true };
  },
  sendAudioFrame: async () => {},
  stopTalk: async () => {},
  close: () => {},
};
const fakeAdapterClass = function () { return fakeAdapter; };
const dvripPath = require.resolve('../lib/_xiongmai_dvrip');
const origDvrip = require.cache[dvripPath];
require.cache[dvripPath] = {
  id: dvripPath, filename: dvripPath, loaded: true,
  exports: {
    ...(origDvrip ? origDvrip.exports : {}),
    XiongmaiDvripAdapter: fakeAdapterClass,
    DVRIP_PORT: 34567,
  },
};

const auditPath = require.resolve('../lib/_audit');
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true,
  exports: {
    logAudit: async (entry) => {
      if (dbState.auditShouldThrow) throw new Error('audit failed');
      dbState.auditCalls.push(entry);
    },
    logPlatformAudit: async () => {},
    getIp: () => null,
  },
};

require.cache[require.resolve('../lib/_sentry')] = {
  id: require.resolve('../lib/_sentry'),
  filename: require.resolve('../lib/_sentry'),
  loaded: true,
  exports: { initSentry: () => {} },
};

// ── Boot the worker on a known port ────────────────────────────────
process.env.TWO_WAY_AUDIO_PORT = '18901';
process.env.MEDIA_NODE_DATABASE_URL = 'postgres://fake';
process.env.ALLOWED_ORIGIN = 'https://www.dnd-monitoring.com';
process.env.TALKDOWN_TEST_EXPORT = '1';
delete process.env.DATABASE_URL;

let server, baseUrl, _stopSessionSweep;
before(async () => {
  const mod = require('../workers/two-way-audio-api');
  // Wait for the worker's listen() callback to mutate module.exports
  // with the http.Server handle.
  await new Promise((resolve) => {
    if (mod.server) return resolve();
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      if (mod.server) { clearInterval(iv); resolve(); }
      else if (tries > 200) { clearInterval(iv); resolve(); }
    }, 25);
  });
  server = mod.server;
  _stopSessionSweep = mod._stopSessionSweep;
  if (!server || !server.address()) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const addr = server.address();
  if (!addr) throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (_stopSessionSweep) _stopSessionSweep();
  if (server && server.listening) {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

function request(method, path, { headers = {}, body, query } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    const payload = body !== undefined
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : '';
    const reqHeaders = {
      Host: url.host,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Connection': 'close',
      ...headers,
    };
    let reqLine = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(reqHeaders)) reqLine += `${k}: ${v}\r\n`;
    reqLine += `\r\n${payload}`;

    const sock = net.createConnection(parseInt(url.port, 10), url.hostname);
    let buf = '';
    let finalized = false;
    const timer = setTimeout(() => {
      sock.destroy(new Error('client timeout 8s'));
    }, 8000);
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (buf.includes('\r\n0\r\n\r\n') || buf.includes('\r\n0\r\n')) {
        finalize();
        return;
      }
      const sep = buf.indexOf('\r\n\r\n');
      if (sep !== -1) {
        const headerBlock = buf.slice(0, sep);
        if (!/^transfer-encoding:\s*chunked/im.test(headerBlock) &&
            /^content-length:\s*(\d+)/im.test(headerBlock)) {
          const m = headerBlock.match(/^content-length:\s*(\d+)/im);
          if (m && buf.length >= sep + 4 + parseInt(m[1], 10)) finalize();
        }
      }
    });
    sock.on('end', () => finalize());

    function finalize() {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* */ }
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) {
        reject(new Error('malformed response: no header terminator'));
        return;
      }
      const headerBlock = buf.slice(0, sep);
      let bodyBlock = buf.slice(sep + 4);
      if ((headerBlock.match(/^transfer-encoding:\s*chunked/im))) {
        const out = [];
        let i = 0;
        while (i < bodyBlock.length) {
          const crlf = bodyBlock.indexOf('\r\n', i);
          if (crlf === -1) break;
          const sizeStr = bodyBlock.slice(i, crlf).trim();
          const size = parseInt(sizeStr, 16);
          if (!Number.isFinite(size) || size === 0) break;
          out.push(bodyBlock.slice(crlf + 2, crlf + 2 + size));
          i = crlf + 2 + size + 2;
        }
        bodyBlock = out.join('');
      }
      const statusMatch = headerBlock.match(/^HTTP\/1\.[01] (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const headersObj = {};
      for (const line of headerBlock.split('\r\n').slice(1)) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) headersObj[m[1].toLowerCase()] = m[2];
      }
      let parsed = null;
      try { parsed = bodyBlock ? JSON.parse(bodyBlock) : null; } catch { /* */ }
      resolve({ status, headers: headersObj, body: parsed, raw: bodyBlock });
    }
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.write(reqLine);
  });
}

const TOKEN = 'tok_test_123';
const CAMERA_ID = 'cam_dvrip_1';

beforeEach(() => {
  dbState.auditCalls = [];
  dbState.auditShouldThrow = false;
  dbState.overrideValidate = null;
  dbState.overrideGetCamera = null;
  dbState.adapterMode = 'default';
  poolState.validateCalls = 0;
  poolState.queryCalls = 0;
});

describe('worker /api/audio/*', () => {
  test('CORS preflight: OPTIONS returns 204 with CORS headers', async () => {
    const r = await request('OPTIONS', `/api/audio/${CAMERA_ID}/start`, {
      headers: { Origin: 'https://www.dnd-monitoring.com' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], 'https://www.dnd-monitoring.com');
    assert.match(r.headers['access-control-allow-methods'] || '', /POST/);
  });

  test('missing token → 401', async () => {
    const r = await request('POST', `/api/audio/${CAMERA_ID}/start`);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Token required');
  });

  test('invalid token (no row) → 401', async () => {
    dbState.overrideValidate = () => ({ rows: [] });
    const r = await request('POST', `/api/audio/${CAMERA_ID}/start`, { query: { token: 'bad' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid or expired token');
  });

  test('GET /capabilities returns supported=true for DVRIP', async () => {
    const r = await request('GET', `/api/audio/${CAMERA_ID}/capabilities`, { query: { token: TOKEN } });
    assert.equal(r.status, 200);
    assert.equal(r.body.supported, true);
    assert.equal(r.body.protocol, 'optalk');
  });

  test('GET /capabilities returns supported=false for ONVIF (probing not implemented)', async () => {
    // Token row for cam_onvif, camera row for cam_onvif.
    dbState.overrideValidate = () => ({ rows: [{
      user_id: 'u1', camera_id: 'cam_onvif',
      expires_at: new Date(Date.now() + 60_000),
    }] });
    dbState.overrideGetCamera = () => ({ rows: [{
      id: 'cam_onvif', name: 'o', connection_type: 'onvif',
      ip: '127.0.0.1', port: 80, rtsp_username: null, rtsp_password_encrypted: null,
      organization_id: 'org-1',
    }] });
    const r = await request('GET', `/api/audio/cam_onvif/capabilities`, { query: { token: TOKEN } });
    assert.equal(r.status, 200);
    assert.equal(r.body.supported, false);
    assert.equal(r.body.protocol, 'onvif');
  });

  test('start → send (×3) → stop happy path: 1 start, 3 sends, 1 stop, audit emitted', async () => {
    await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    dbState.auditCalls = [];

    const s = await request('POST', `/api/audio/${CAMERA_ID}/start`, { query: { token: TOKEN } });
    assert.equal(s.status, 200);
    assert.equal(s.body.success, true);
    assert.ok(s.body.session_id);

    for (let i = 0; i < 3; i++) {
      const sr = await request('POST', `/api/audio/${CAMERA_ID}/send`, {
        query: { token: TOKEN },
        body: { audio: Buffer.alloc(640).toString('base64') },
      });
      assert.equal(sr.status, 200);
      assert.equal(sr.body.success, true);
      assert.equal(sr.body.frames_sent, i + 1);
    }

    const stop = await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.success, true);

    const actions = dbState.auditCalls.map((c) => c.action);
    assert.ok(actions.includes('talkdown.start'), 'expected talkdown.start audit');
    assert.ok(actions.includes('talkdown.stop'), 'expected talkdown.stop audit');
    const stopEntry = dbState.auditCalls.find((c) => c.action === 'talkdown.stop');
    assert.equal(stopEntry.resourceType, 'camera');
    assert.equal(stopEntry.resourceId, CAMERA_ID);
    assert.equal(stopEntry.metadata.frames_sent, 3);
    assert.ok(stopEntry.metadata.session_id);
    assert.ok(stopEntry.metadata.duration_ms >= 0);
  });

  test('send when no active session → 400', async () => {
    await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    const r = await request('POST', `/api/audio/${CAMERA_ID}/send`, {
      query: { token: TOKEN },
      body: { audio: 'AAAA' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No active talk session/);
  });

  test('send without audio field → 400', async () => {
    await request('POST', `/api/audio/${CAMERA_ID}/start`, { query: { token: TOKEN } });
    const r = await request('POST', `/api/audio/${CAMERA_ID}/send`, {
      query: { token: TOKEN },
      body: {},
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'audio (base64 PCM) is required');
    await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
  });

  test('start rate limit: 6th start within a minute → 429', async () => {
    // Use a fresh camera id so prior tests' starts don't count.
    const cid = 'cam_ratelimit';
    dbState.overrideValidate = () => ({ rows: [{
      user_id: 'u1', camera_id: cid,
      expires_at: new Date(Date.now() + 60_000),
    }] });
    dbState.overrideGetCamera = () => ({ rows: [{
      id: cid, name: 'rl', connection_type: 'dvrip',
      ip: '127.0.0.1', port: 34567, rtsp_username: null, rtsp_password_encrypted: null,
      organization_id: 'org-1',
    }] });
    await request('POST', `/api/audio/${cid}/stop`, { query: { token: TOKEN } });
    for (let i = 0; i < 5; i++) {
      const r = await request('POST', `/api/audio/${cid}/start`, { query: { token: TOKEN } });
      assert.equal(r.status, 200);
      await request('POST', `/api/audio/${cid}/stop`, { query: { token: TOKEN } });
    }
    const sixth = await request('POST', `/api/audio/${cid}/start`, { query: { token: TOKEN } });
    assert.equal(sixth.status, 429);
  });

  test('start timeout (504) when adapter hangs longer than 5s', async () => {
    // Use a fresh camera id so prior tests' starts don't count.
    const cid = 'cam_timeout';
    dbState.overrideValidate = () => ({ rows: [{
      user_id: 'u1', camera_id: cid,
      expires_at: new Date(Date.now() + 60_000),
    }] });
    dbState.overrideGetCamera = () => ({ rows: [{
      id: cid, name: 't', connection_type: 'dvrip',
      ip: '127.0.0.1', port: 34567, rtsp_username: null, rtsp_password_encrypted: null,
      organization_id: 'org-1',
    }] });
    // The pre-cached fakeAdapter (already installed in the
    // XiongmaiDvripAdapter require.cache slot) will be returned by
    // the worker's createTwoWayAudioAdapter. Tell it to hang.
    dbState.adapterMode = 'hang';
    const r = await request('POST', `/api/audio/${cid}/start`, { query: { token: TOKEN } });
    assert.equal(r.status, 504);
    assert.match(r.body.error, /timed out/);
  });

  test('audit log failure does NOT block stop response', async () => {
    dbState.auditShouldThrow = true;
    await request('POST', `/api/audio/${CAMERA_ID}/start`, { query: { token: TOKEN } });
    const r = await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    dbState.auditShouldThrow = false;
  });

  test('stop on nonexistent session is a no-op success', async () => {
    await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    const r = await request('POST', `/api/audio/${CAMERA_ID}/stop`, { query: { token: TOKEN } });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
  });

  test('GET on a POST action → 405', async () => {
    const r = await request('GET', `/api/audio/${CAMERA_ID}/start`, { query: { token: TOKEN } });
    assert.equal(r.status, 405);
  });

  test('unknown action → 404', async () => {
    const r = await request('POST', `/api/audio/${CAMERA_ID}/bogus`, { query: { token: TOKEN } });
    assert.equal(r.status, 404);
  });
});
