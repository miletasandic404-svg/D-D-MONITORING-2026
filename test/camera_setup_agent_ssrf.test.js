'use strict';

/**
 * Focused tests for the DNS-rebinding SSRF TOCTOU fix in
 * workers/camera-setup-agent.js.
 */

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Module mock helper ──────────────────────────────────────────────
function mockModule(modulePath, fakeExports) {
  const resolved = require.resolve(modulePath);
  const original = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fakeExports,
  };
  return () => {
    if (original) {
      require.cache[resolved] = original;
    } else {
      delete require.cache[resolved];
    }
  };
}

const restoreFns = [];

after(() => {
  restoreFns.forEach((fn) => fn());
});

// ── Mutable fakes ───────────────────────────────────────────────────
const fakeNetworkSecurity = {
  assertSafeTarget: async () => ({ ok: true, addresses: ['1.2.3.4'] }),
};

const fakeRtspProbe = {
  probeRtspUrl: async (url, opts) => ({
    reachable: true,
    stream_available: true,
    auth_required: false,
    status: 200,
    host: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
    port: (() => { try { const p = new URL(url).port; return p ? parseInt(p, 10) : 554; } catch { return 554; } })(),
    url,
  }),
  embedCredentials: (url, username, password) => {
    if (!username) return url;
    try {
      const u = new URL(url);
      u.username = encodeURIComponent(username);
      if (password) u.password = encodeURIComponent(password);
      return u.toString();
    } catch {
      return url;
    }
  },
};

const fakeOnvifClient = {
  discoverCamera: async (ip, port, username, password) => ({
    manufacturer: 'TestCam',
    model: 'TC-100',
    firmware_version: '1.0',
    serial_number: '123',
    rtsp_urls: [`rtsp://${ip}:${port}/live`],
    rtsp_reachable: true,
    onvif_port: port,
  }),
  scanSubnet: async () => [],
};

const fakeConnectors = {
  connectors: [
    {
      id: 'onvif',
      name: 'ONVIF',
      discover: async (ip, opts) => ({
        onvif_supported: true,
        manufacturer: 'M',
        model: 'X',
        streams: [{ url: `rtsp://${ip}/live`, reachable: true, stream_available: true, status: 200 }],
      }),
    },
    {
      id: 'xiongmai-dvrip',
      name: 'Xiongmai/XMEye DVRIP',
      discover: async (ip, opts) => ({
        dvrip_supported: true,
        manufacturer: 'Xiongmai',
        model: 'XMEye',
        streams: [],
      }),
    },
    {
      id: 'rtsp-common',
      name: 'RTSP',
      discover: async (ip, opts) => ({
        onvif_supported: false,
        streams: [{ url: `rtsp://${ip}/live`, reachable: true, stream_available: true, status: 200 }],
      }),
    },
  ],
  getConnector: (id) => {
    const c = fakeConnectors.connectors.find((c) => c.id === id);
    return c || null;
  },
};

const fakeXiongmai = {
  DVRIP_PORT: 34567,
  xiongmaiConnector: async (ip, opts) => ({
    dvrip_supported: true,
    manufacturer: 'Xiongmai',
    model: 'XMEye',
    streams: [],
  }),
};

const fakeCrypto = {
  encrypt: (v) => Buffer.from(v).toString('base64'),
  decrypt: (b) => Buffer.from(b, 'base64').toString('utf8'),
  extractCredentialsFromUrl: (url) => {
    try {
      const u = new URL(url);
      return { url, username: u.username || '', password: u.password || '' };
    } catch {
      return { url, username: '', password: '' };
    }
  },
  stripCredentialsFromUrl: (url) => url,
};

// ── Install mocks ───────────────────────────────────────────────────
restoreFns.push(mockModule('../lib/_network_security', fakeNetworkSecurity));
restoreFns.push(mockModule('../lib/_rtsp_probe', fakeRtspProbe));
restoreFns.push(mockModule('../lib/_onvif_client', fakeOnvifClient));
restoreFns.push(mockModule('../lib/_camera_connectors', fakeConnectors));
restoreFns.push(mockModule('../lib/_xiongmai_dvrip', fakeXiongmai));
restoreFns.push(mockModule('../lib/_crypto', fakeCrypto));
restoreFns.push(mockModule('../lib/_mediamtx_client', {
  addOrUpdateCameraPath: async () => {},
  deleteCameraPath: async () => {},
  getPathStatus: async () => ({}),
}));
restoreFns.push(mockModule('../lib/_node_health', {
  reportNodeHealth: async () => ({}),
  checkTunnel: async () => ({}),
  HEARTBEAT_LOOP_MS: 30000,
}));
restoreFns.push(mockModule('../lib/_worker_heartbeat', { beat: () => {} }));
restoreFns.push(mockModule('../lib/_task_queue_sql', {
  buildClaimTaskSql: () => ({ sql: 'SELECT ...', params: [] }),
  canClaimTasks: () => true,
}));
restoreFns.push(mockModule('../lib/_task_status_sql', {
  buildTaskStatusQuery: (taskId, status, extra) => {
    const cols = Object.keys(extra);
    const vals = [taskId, status];
    const set = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    return {
      sql: `UPDATE camera_setup_tasks SET status = $1::text, ${set} WHERE id = $2`,
      vals: [...vals, ...cols.map((c) => extra[c])],
      rejected: [],
    };
  },
}));
const poolInstances = [];

restoreFns.push(mockModule('pg', {
  Pool: class {
    constructor() {
      this.queryCalls = [];
      poolInstances.push(this);
    }
    connect() {
      const self = this;
      return Promise.resolve({
        query: async (text, params) => {
          self.queryCalls.push({ text, params });
          if (/BEGIN/.test(text) || /COMMIT/.test(text) || /ROLLBACK/.test(text)) {
            return { rows: [] };
          }
          if (/set_config/.test(text)) {
            return { rows: [] };
          }
          if (/FROM camera_setup_tasks/.test(text) && /WHERE id = \$1/.test(text)) {
            return { rows: [{ id: params[0], status: 'working', assigned_node_id: 'node-1' }] };
          }
          return { rows: [] };
        },
        release: async () => {},
      });
    }
    async query(text, params) {
      this.queryCalls.push({ text, params });
      if (/FROM camera_setup_tasks/.test(text) && /WHERE id = \$1/.test(text)) {
        return { rows: [{ id: params[0], status: 'working', assigned_node_id: 'node-1' }] };
      }
      return { rows: [] };
    }
    async end() {}
  },
}));
restoreFns.push(mockModule('dotenv', { config: () => ({}) }));
restoreFns.push(mockModule('../lib/_sentry', { initSentry: () => {} }));
restoreFns.push(mockModule('../lib/_logger', {
  makeLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

process.env.DATABASE_URL = 'postgres://test-local';

function loadAgent(assertSafeTargetFn) {
  if (assertSafeTargetFn) {
    fakeNetworkSecurity.assertSafeTarget = assertSafeTargetFn;
  }
  delete require.cache[require.resolve('../workers/camera-setup-agent')];
  return require('../workers/camera-setup-agent');
}

// ── Helpers ─────────────────────────────────────────────────────────
function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    organization_id: 'org-1',
    ip: overrides.ip || 'hostname.example',
    rtsp_url: overrides.rtsp_url || 'rtsp://hostname.example:554/live',
    onvif_port: overrides.onvif_port || 80,
    mode: overrides.mode || 'manual',
    camera_name: 'Test',
    username: '',
    password: '',
    encrypted_credentials: null,
    site_id: null,
    result: {},
    ...overrides,
  };
}

describe('workers/camera-setup-agent — DNS rebinding SSRF fix', () => {
  beforeEach(() => {
    poolInstances.length = 0;
  });

  test('runManual rewrites hostname to validated IP before verifyRtsp', async () => {
    let verifyRtspUrl = null;
    fakeRtspProbe.probeRtspUrl = async (url) => {
      verifyRtspUrl = url;
      return { reachable: true, stream_available: true, auth_required: false, status: 200 };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['5.6.7.8'] }));

    try {
      await agent.runManual(makeTask({ rtsp_url: 'rtsp://attacker.example:554/live' }));
      assert.ok(
        verifyRtspUrl && verifyRtspUrl.includes('rtsp://5.6.7.8:554/live'),
        'verifyRtsp must receive the rewritten IP, not the hostname',
      );
      assert.ok(
        !(verifyRtspUrl && verifyRtspUrl.includes('attacker.example')),
        'original hostname must not be passed to verifyRtsp',
      );
    } finally {
      fakeRtspProbe.probeRtspUrl = async (url, opts) => ({
        reachable: true,
        stream_available: true,
        auth_required: false,
        status: 200,
        host: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
        port: (() => { try { const p = new URL(url).port; return p ? parseInt(p, 10) : 554; } catch { return 554; } })(),
        url,
      });
    }
  });

  test('runManual preserves credentials, port, pathname, and query', async () => {
    let verifyRtspUrl = null;
    fakeRtspProbe.probeRtspUrl = async (url) => {
      verifyRtspUrl = url;
      return { reachable: true, stream_available: true, auth_required: false, status: 200 };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['5.6.7.8'] }));

    try {
      const task = makeTask({
        rtsp_url: 'rtsp://user:pass@attacker.example:1554/stream/path?token=abc',
        username: 'user',
        password: 'pass',
      });
      await agent.runManual(task);
      assert.equal(
        verifyRtspUrl,
        'rtsp://user:pass@5.6.7.8:1554/stream/path?token=abc',
      );
    } finally {
      fakeRtspProbe.probeRtspUrl = async (url, opts) => ({
        reachable: true,
        stream_available: true,
        auth_required: false,
        status: 200,
        host: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
        port: (() => { try { const p = new URL(url).port; return p ? parseInt(p, 10) : 554; } catch { return 554; } })(),
        url,
      });
    }
  });

  test('runOnvif rewrites hostname to validated IP before discoverCamera', async () => {
    let discoveredIp = null;
    fakeOnvifClient.discoverCamera = async (ip, port) => {
      discoveredIp = ip;
      return {
        manufacturer: 'Test',
        model: 'M',
        rtsp_urls: [`rtsp://${ip}:${port}/live`],
        rtsp_reachable: true,
        onvif_port: port,
      };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['192.168.1.50'] }));

    try {
      await agent.runOnvif(makeTask({ mode: 'onvif', ip: 'attacker.example' }));
      assert.equal(discoveredIp, '192.168.1.50', 'discoverCamera must receive the validated IP');
    } finally {
      fakeOnvifClient.discoverCamera = async (ip, port, username, password) => ({
        manufacturer: 'TestCam',
        model: 'TC-100',
        firmware_version: '1.0',
        serial_number: '123',
        rtsp_urls: [`rtsp://${ip}:${port}/live`],
        rtsp_reachable: true,
        onvif_port: port,
      });
    }
  });

  test('runPreview adds SSRF guard and rewrites hostname before verifyRtsp', async () => {
    let verifyRtspUrl = null;
    fakeRtspProbe.probeRtspUrl = async (url) => {
      verifyRtspUrl = url;
      return { reachable: true, stream_available: true, auth_required: false, status: 200 };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['5.6.7.8'] }));

    try {
      await agent.runPreview(makeTask({ mode: 'preview', rtsp_url: 'rtsp://attacker.example/live' }));
      assert.ok(
        verifyRtspUrl && verifyRtspUrl.includes('rtsp://5.6.7.8/live'),
        'runPreview must rewrite hostname before verifyRtsp',
      );
    } finally {
      fakeRtspProbe.probeRtspUrl = async (url, opts) => ({
        reachable: true,
        stream_available: true,
        auth_required: false,
        status: 200,
        host: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
        port: (() => { try { const p = new URL(url).port; return p ? parseInt(p, 10) : 554; } catch { return 554; } })(),
        url,
      });
    }
  });

  test('runProbe adds SSRF guard and passes validated IP to connector.discover', async () => {
    let connectorIp = null;
    const originalDiscover = fakeConnectors.connectors[0].discover;
    fakeConnectors.connectors[0].discover = async (ip, opts) => {
      connectorIp = ip;
      return { onvif_supported: true, manufacturer: 'M', model: 'X', streams: [] };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['192.168.1.50'] }));

    try {
      await agent.runProbe(makeTask({ mode: 'probe', ip: 'attacker.example' }));
      assert.equal(connectorIp, '192.168.1.50', 'connector.discover must receive the validated IP');
    } finally {
      fakeConnectors.connectors[0].discover = originalDiscover;
    }
  });

  test('runDvrip uses validated IP for connector.discover and insertDvripCamera', async () => {
    let connectorIp = null;
    const originalDiscover = fakeConnectors.connectors[1].discover;
    fakeConnectors.connectors[1].discover = async (ip, opts) => {
      connectorIp = ip;
      return { dvrip_supported: true, manufacturer: 'Xiongmai', model: 'XMEye', streams: [] };
    };
    const agent = loadAgent(async () => ({ ok: true, addresses: ['192.168.1.50'] }));

    try {
      await agent.runDvrip(makeTask({ mode: 'dvrip', ip: 'attacker.example', onvif_port: 34567 }));
      assert.equal(connectorIp, '192.168.1.50', 'xiongmaiConnector must receive the validated IP');

      const pool = poolInstances[0];
      assert.ok(pool, 'a Pool instance must have been created');
      const insertCall = pool.queryCalls.find((c) => /INSERT INTO cameras/.test(c.text));
      assert.ok(insertCall, 'INSERT INTO cameras must be executed');
      assert.equal(insertCall.params[7], '192.168.1.50', 'insertDvripCamera must store the validated IP');
    } finally {
      fakeConnectors.connectors[1].discover = originalDiscover;
    }
  });

  test('runManual blocks when assertSafeTarget rejects', async () => {
    fakeRtspProbe.probeRtspUrl = async () => {
      return { reachable: true, stream_available: true, auth_required: false, status: 200 };
    };
    const agent = loadAgent(async () => {
      const err = new Error('network policy: blocked');
      err.code = 'NETWORK_POLICY';
      throw err;
    });

    await assert.rejects(
      () => agent.runManual(makeTask({ rtsp_url: 'rtsp://blocked.example/live' })),
      { code: 'NETWORK_POLICY' },
    );
  });

  test('runOnvif blocks loopback hostname via assertSafeTarget', async () => {
    fakeOnvifClient.discoverCamera = async () => {
      return { manufacturer: '', model: '', rtsp_urls: [], rtsp_reachable: false, onvif_port: 80 };
    };
    const agent = loadAgent(async () => {
      const err = new Error('network policy: address 127.0.0.1 (loopback) is not allowed');
      err.code = 'NETWORK_POLICY';
      throw err;
    });

    await assert.rejects(
      () => agent.runOnvif(makeTask({ mode: 'onvif', ip: 'localhost' })),
      { code: 'NETWORK_POLICY' },
    );
  });
});
