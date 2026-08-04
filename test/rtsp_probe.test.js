'use strict';
/**
 * Unit + integration tests for the real RTSP verification added in Phase 6:
 *
 *   - computeDigestResponse matches the RFC 2617 known-answer vector
 *   - probeRtspUrl against a MOCK RTSP server (no auth / Basic / Digest,
 *     wrong credentials, unreachable host)
 *   - guessRtspUrls / embedCredentials / parseRtspUrl helpers
 *   - connector registry (onvif primary, rtsp-common fallback)
 *   - rtspCommonConnector end-to-end: finds a Hikvision-style stream on a
 *     digest-protected camera and strips credentials from the returned URL
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');

const {
  probeRtspUrl,
  computeDigestResponse,
  guessRtspUrls,
  embedCredentials,
  parseRtspUrl,
} = require('../lib/_rtsp_probe');
const { connectors, getConnector, rtspCommonConnector } = require('../lib/_camera_connectors');

// ─── Mock RTSP server ────────────────────────────────────────────────────────

const MOCK_USER = 'admin';
const MOCK_PASS = 'secret123';
const MOCK_REALM = 'cam-test';
const MOCK_NONCE = 'deadbeef1234';

function parseDigestHeader(auth) {
  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(auth))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return params;
}

/**
 * Mock RTSP server. One request per connection (the probe opens a fresh
 * socket per request, like real clients).
 *
 * @param {'none'|'basic'|'digest'|'digest-path'} authMode
 *   - none        : OPTIONS/DESCRIBE always 200
 *   - basic       : DESCRIBE requires Basic auth (correct creds)
 *   - digest      : DESCRIBE requires Digest auth (correct creds)
 *   - digest-path : digest + 404 unless target is /Streaming/Channels/101
 */
function startMockRtsp(authMode = 'none') {
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx);
      buf = buf.slice(idx + 4);
      const lines = head.split('\r\n');
      const m = /^(\w+)\s+(\S+)\s+RTSP\/1\.\d/.exec(lines[0] || '');
      if (!m) return;
      const method = m[1];
      const target = m[2];
      const headers = {};
      for (let i = 1; i < lines.length; i++) {
        const c = /^([^:]+):\s*(.*)$/.exec(lines[i]);
        if (c) headers[c[1].toLowerCase()] = c[2].trim();
      }
      respond(socket, method, target, headers, authMode);
    });
  });

  function send(socket, status, statusText, headers = {}) {
    const out = [`RTSP/1.0 ${status} ${statusText}`];
    for (const [k, v] of Object.entries(headers)) out.push(`${k}: ${v}`);
    out.push('Content-Length: 0', '', '');
    socket.end(out.join('\r\n'));
  }

  function respond(socket, method, target, headers, mode) {
    if (method === 'OPTIONS') {
      return send(socket, 200, 'OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN' });
    }
    if (method === 'DESCRIBE') {
      if (mode === 'none') return send(socket, 200, 'OK');
      if (mode === 'digest-path' && target !== '/Streaming/Channels/101') {
        return send(socket, 404, 'Not Found');
      }
      if (mode === 'basic') {
        const b = /^Basic\s+(.+)$/.exec(headers.authorization || '');
        const decoded = b ? Buffer.from(b[1], 'base64').toString('utf8') : '';
        if (decoded === `${MOCK_USER}:${MOCK_PASS}`) return send(socket, 200, 'OK');
        return send(socket, 401, 'Unauthorized', { 'WWW-Authenticate': `Basic realm="${MOCK_REALM}"` });
      }
      if (mode === 'digest' || mode === 'digest-path') {
        if (/^Digest\s+/.test(headers.authorization || '')) {
          const p = parseDigestHeader(headers.authorization);
          const expected = computeDigestResponse({
            method, uri: target,
            username: MOCK_USER, password: MOCK_PASS,
            realm: MOCK_REALM, nonce: MOCK_NONCE,
            qop: 'auth', nc: p.nc || '00000001', cnonce: p.cnonce || '',
          });
          if (p.response === expected) return send(socket, 200, 'OK');
          return send(socket, 401, 'Unauthorized', {
            'WWW-Authenticate': `Digest realm="${MOCK_REALM}", nonce="${MOCK_NONCE}", qop="auth", algorithm=MD5`,
          });
        }
        return send(socket, 401, 'Unauthorized', {
          'WWW-Authenticate': `Digest realm="${MOCK_REALM}", nonce="${MOCK_NONCE}", qop="auth", algorithm=MD5`,
        });
      }
      return send(socket, 200, 'OK');
    }
    return send(socket, 404, 'Not Found');
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('computeDigestResponse matches the RFC 2617 known-answer vector', () => {
  const response = computeDigestResponse({
    method: 'GET',
    uri: '/dir/index.html',
    username: 'Mufasa',
    password: 'Circle Of Life',
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    qop: 'auth',
    nc: '00000001',
    cnonce: '0a4f113b',
  });
  assert.strictEqual(response, '6629fae49393a05397450978507c4ef1');
});

test('parseRtspUrl parses host/port/creds and defaults RTSP port to 554', () => {
  const u = parseRtspUrl('rtsp://admin:pass@192.168.1.17:8554/Streaming/Channels/101');
  assert.strictEqual(u.host, '192.168.1.17');
  assert.strictEqual(u.port, 8554);
  assert.strictEqual(u.username, 'admin');
  assert.strictEqual(u.password, 'pass');
  assert.strictEqual(u.path, '/Streaming/Channels/101');
  const d = parseRtspUrl('rtsp://192.168.1.17/live');
  assert.strictEqual(d.port, 554);
  assert.strictEqual(parseRtspUrl('http://example.com/x'), null);
  assert.strictEqual(parseRtspUrl('not a url'), null);
});

test('probeRtspUrl: camera without auth → ok', async () => {
  const s = await startMockRtsp('none');
  const r = await probeRtspUrl(`rtsp://127.0.0.1:${s.port}/live`, { timeoutMs: 3000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reachable, true);
  assert.strictEqual(r.stream_available, true);
  assert.strictEqual(r.auth_required, false);
  s.close();
});

test('probeRtspUrl: Basic auth — correct creds pass, wrong creds fail with 401', async () => {
  const s = await startMockRtsp('basic');
  const ok = await probeRtspUrl(`rtsp://127.0.0.1:${s.port}/live`, {
    username: MOCK_USER, password: MOCK_PASS, timeoutMs: 3000,
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.authenticated, true);

  const bad = await probeRtspUrl(`rtsp://127.0.0.1:${s.port}/live`, {
    username: MOCK_USER, password: 'wrong-password', timeoutMs: 3000,
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.authenticated, false);
  assert.strictEqual(bad.auth_required, true);
  assert.strictEqual(bad.status, 401);
  s.close();
});

test('probeRtspUrl: Digest auth — correct creds pass (end-to-end digest), wrong creds fail', async () => {
  const s = await startMockRtsp('digest');
  const ok = await probeRtspUrl(`rtsp://127.0.0.1:${s.port}/live`, {
    username: MOCK_USER, password: MOCK_PASS, timeoutMs: 3000,
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.authenticated, true);

  const bad = await probeRtspUrl(`rtsp://127.0.0.1:${s.port}/live`, {
    username: MOCK_USER, password: 'nope', timeoutMs: 3000,
  });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.auth_required, true);
  s.close();
});

test('probeRtspUrl: unreachable host → ok=false with error', async () => {
  const r = await probeRtspUrl('rtsp://127.0.0.1:1/nope', { timeoutMs: 1500 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reachable, false);
  assert.ok(r.error, 'expected an error message');
});

test('probeRtspUrl: invalid URL → ok=false', async () => {
  const r = await probeRtspUrl('ftp://127.0.0.1/x', { timeoutMs: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.probed, false);
});

test('probeRtspUrl: rtsps:// is skipped (not probed) but reported ok for MediaMTX to verify', async () => {
  const r = await probeRtspUrl('rtsps://cam.example.com:322/live', { timeoutMs: 1000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.probed, false);
  assert.strictEqual(r.reachable, null);
});

test('guessRtspUrls generates vendor paths with embedded credentials', () => {
  const list = guessRtspUrls('192.168.1.17', { username: 'admin', password: 'pw' });
  assert.ok(list.some((c) => c.url.includes('/Streaming/Channels/101')), 'Hikvision main');
  assert.ok(list.some((c) => c.url.includes('/cam/realmonitor')), 'Dahua');
  assert.ok(list.every((c) => c.url.startsWith('rtsp://admin:pw@192.168.1.17:554')), 'creds embedded');
  assert.ok(list.every((c) => c.label), 'every candidate has a label');
  assert.ok(list.length >= 10);
});

test('embedCredentials injects creds and never duplicates existing userinfo', () => {
  assert.strictEqual(embedCredentials('rtsp://192.168.1.17/live', 'admin', 'pw'), 'rtsp://admin:pw@192.168.1.17/live');
  assert.strictEqual(embedCredentials('rtsp://admin:old@192.168.1.17/live', 'admin', 'pw'), 'rtsp://admin:old@192.168.1.17/live');
  assert.strictEqual(embedCredentials('rtsp://192.168.1.17/live', '', 'pw'), 'rtsp://192.168.1.17/live');
});

test('connector registry: onvif is primary, rtsp-common present', () => {
  assert.ok(getConnector('onvif'));
  assert.ok(getConnector('rtsp-common'));
  assert.strictEqual(connectors[0].id, 'onvif');
  assert.strictEqual(getConnector('does-not-exist'), null);
});

test('rtspCommonConnector finds a Hikvision-style stream on a digest-protected camera and strips credentials', async () => {
  const s = await startMockRtsp('digest-path');
  const res = await rtspCommonConnector('127.0.0.1', {
    username: MOCK_USER, password: MOCK_PASS, rtspPort: s.port,
  });
  assert.strictEqual(res.onvif_supported, false);
  const main = res.streams.find((st) => st.url.includes('/Streaming/Channels/101'));
  assert.ok(main, 'expected the Hikvision main stream to be discovered');
  assert.strictEqual(main.stream_available, true);
  assert.strictEqual(main.authenticated, true);
  assert.ok(!main.url.includes(`${MOCK_USER}:`), 'credentials must be stripped from the returned URL');
  s.close();
});
