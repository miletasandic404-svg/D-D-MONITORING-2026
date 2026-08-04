'use strict';
/**
 * Dependency-free RTSP probing for camera onboarding.
 *
 * Runs on the local media node (next to MediaMTX) — the only place that can
 * reach cameras on the user's LAN. Capabilities:
 *
 *   1. probeRtspUrl()    — REAL RTSP handshake (OPTIONS + DESCRIBE) over a
 *                          plain TCP socket. Verifies reachability,
 *                          authentication (HTTP Basic AND Digest), and stream
 *                          availability without pulling media. Wrong
 *                          credentials fail with HTTP 401 and are reported
 *                          clearly — a camera that cannot authenticate is
 *                          never allowed to be saved.
 *   2. guessRtspUrls()   — well-known RTSP path patterns for cameras that do
 *                          NOT support ONVIF (Hikvision, Dahua, Uniview, Axis,
 *                          generic). Used as the fallback when ONVIF fails.
 *   3. embedCredentials()— injects username/password into an RTSP URL so the
 *                          user never has to hand-encode them.
 *   4. probeBatch()      — concurrent probing with a configurable concurrency
 *                          cap and early exit once enough streams are found
 *                          (cameras have limited RTSP connection slots).
 *
 * NOTE: rtsps:// (TLS RTSP) cannot be probed with a plain TCP socket — we
 * skip the handshake and let MediaMTX verify it when it pulls the stream.
 */

const net = require('net');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 5000;
const RTSP_DEFAULT_PORT = 554;

// ─── URL / auth helpers ──────────────────────────────────────────────────────

function parseRtspUrl(rtspUrl) {
  try {
    const u = new URL(rtspUrl);
    if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') return null;
    return {
      protocol: u.protocol,
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : RTSP_DEFAULT_PORT,
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
      path: (u.pathname || '/') + u.search,
    };
  } catch {
    return null;
  }
}

function basicAuthHeader(username, password) {
  if (!username) return null;
  return 'Authorization: Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
}

/**
 * Compute an HTTP/RTSP Digest (RFC 2617) response.
 * Exported separately so the RFC 2617 known-answer vector can be unit-tested.
 */
function computeDigestResponse({ method, uri, username, password, realm, nonce, qop, nc, cnonce }) {
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  if (qop && qop !== 'auth') throw new Error(`Unsupported digest qop: ${qop}`);
  if (qop === 'auth') {
    return md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  }
  return md5(`${ha1}:${nonce}:${ha2}`);
}

/** Parse `WWW-Authenticate: <scheme> k1="v1", k2=v2` into { scheme, params }. */
function parseWwwAuthenticate(header) {
  const m = /^(\w+)\s+(.*)$/.exec(String(header || ''));
  if (!m) return null;
  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match;
  while ((match = re.exec(m[2]))) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return { scheme: m[1].toLowerCase(), params };
}

function buildDigestHeader({ method, uri, username, password, challenge, nc, cnonce }) {
  const p = challenge.params;
  const qops = String(p.qop || '').split(',').map((s) => s.trim());
  const useQop = qops.includes('auth');
  const response = computeDigestResponse({
    method, uri, username, password,
    realm: p.realm || '',
    nonce: p.nonce || '',
    qop: useQop ? 'auth' : undefined,
    nc, cnonce,
  });
  let h = `Digest username="${username}", realm="${p.realm || ''}", nonce="${p.nonce || ''}", uri="${uri}", response="${response}"`;
  if (useQop) h += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  return h;
}

// ─── Low-level RTSP request ──────────────────────────────────────────────────

function rtspRequest(host, port, method, target, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('RTSP request timed out'));
    }, timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const lines = [`${method} ${target} RTSP/1.0`, 'CSeq: 1', 'User-Agent: DND-Monitoring/1.0', ...headers, '', ''];
      socket.write(lines.join('\r\n'));
    });
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const idx = raw.indexOf('\r\n\r\n');
      if (idx !== -1) {
        clearTimeout(timer);
        socket.destroy();
        resolve(parseResponse(raw.slice(0, idx)));
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('RTSP request timed out'));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => clearTimeout(timer));
    socket.connect(port, host);
  });
}

function parseResponse(head) {
  const lines = head.split('\r\n');
  const m = /^RTSP\/1\.\d\s+(\d{3})\s*(.*)$/.exec(lines[0] || '');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = /^([^:]+):\s*(.*)$/.exec(lines[i]);
    if (c) headers[c[1].toLowerCase()] = c[2].trim();
  }
  return {
    status: m ? parseInt(m[1], 10) : 0,
    statusText: m ? m[2] : lines[0] || '',
    headers,
  };
}

// ─── Main probe ──────────────────────────────────────────────────────────────

/**
 * Probe an RTSP URL: reachability (OPTIONS), then authentication and stream
 * availability (DESCRIBE with Basic or Digest auth).
 *
 * @param {string} rtspUrl
 * @param {{ username?: string, password?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean, probed: boolean, reachable: boolean|null,
 *   authenticated: boolean|null, stream_available: boolean|null,
 *   auth_required: boolean, status: number|null, status_text: string|null,
 *   host: string|null, port: number|null, error?: string, url: string
 * }>}
 */
async function probeRtspUrl(rtspUrl, { username, password, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const u = parseRtspUrl(rtspUrl);
  if (!u) {
    return { ok: false, probed: false, reachable: false, authenticated: false, stream_available: false, auth_required: false, status: null, status_text: null, host: null, port: null, error: 'Invalid RTSP URL', url: rtspUrl };
  }
  // rtsps:// is TLS — plain TCP cannot complete the handshake. Skip probing
  // and let MediaMTX verify the stream when it pulls it.
  if (u.protocol === 'rtsps:') {
    return { ok: true, probed: false, reachable: null, authenticated: null, stream_available: null, auth_required: false, status: null, status_text: null, host: u.host, port: u.port, url: rtspUrl };
  }

  const user = username ?? u.username;
  const pass = password ?? u.password;
  const initialAuth = basicAuthHeader(user, pass);

  try {
    const opt = await rtspRequest(u.host, u.port, 'OPTIONS', u.path, [], timeoutMs);
    // "Reachable" = the RTSP server answered (2xx, or 401/403 asking for auth).
    const reachable = opt.status >= 200 && opt.status < 300
      || opt.status === 401 || opt.status === 403;

    let desc = await rtspRequest(u.host, u.port, 'DESCRIBE', u.path, initialAuth ? [initialAuth] : [], timeoutMs);

    // Retry with Digest if the camera challenged us and we have credentials.
    if ((desc.status === 401 || desc.status === 403) && desc.headers['www-authenticate'] && user) {
      const challenge = parseWwwAuthenticate(desc.headers['www-authenticate']);
      if (challenge && challenge.scheme === 'digest') {
        const cnonce = crypto.randomBytes(8).toString('hex');
        const nc = '00000001';
        const digestHeader = buildDigestHeader({
          method: 'DESCRIBE', uri: u.path,
          username: user, password: pass,
          challenge, nc, cnonce,
        });
        desc = await rtspRequest(u.host, u.port, 'DESCRIBE', u.path, [`Authorization: ${digestHeader}`], timeoutMs);
      }
    }

    const streamAvailable = desc.status === 200;
    return {
      ok: reachable && streamAvailable,
      probed: true,
      reachable,
      authenticated: streamAvailable,
      stream_available: streamAvailable,
      auth_required: desc.status === 401 || desc.status === 403,
      status: desc.status,
      status_text: desc.statusText,
      host: u.host,
      port: u.port,
      url: rtspUrl,
    };
  } catch (err) {
    return { ok: false, probed: true, reachable: false, authenticated: false, stream_available: false, auth_required: false, status: null, status_text: null, host: u.host, port: u.port, error: err.message, url: rtspUrl };
  }
}

// Well-known RTSP path patterns, ordered by likelihood. Used for cameras that
// do not support ONVIF.
const COMMON_PATHS = [
  { path: '/Streaming/Channels/101', label: 'Hikvision-style main stream' },
  { path: '/Streaming/Channels/102', label: 'Hikvision-style sub stream' },
  { path: '/cam/realmonitor?channel=1&subtype=0', label: 'Dahua-style main stream' },
  { path: '/cam/realmonitor?channel=1&subtype=1', label: 'Dahua-style sub stream' },
  { path: '/h264Preview_01_main', label: 'Uniview-style main stream' },
  { path: '/h264Preview_01_sub', label: 'Uniview-style sub stream' },
  { path: '/media/video1', label: 'Axis-style stream' },
  { path: '/axis-media/media.amp', label: 'Axis Media Control' },
  { path: '/live', label: 'Generic live stream' },
  { path: '/live0', label: 'Generic stream 0' },
  { path: '/h264', label: 'Generic H.264 stream' },
  { path: '/ch01/main', label: 'Generic main channel' },
  { path: '/ch01/sub', label: 'Generic sub channel' },
  { path: '/onvif1', label: 'Generic ONVIF RTSP path' },
  { path: '/11', label: 'Generic stream 11' },
  { path: '/1', label: 'Generic stream 1' },
];

/**
 * Build candidate RTSP URLs for a camera IP using well-known vendor paths.
 * Credentials (if any) are embedded directly in the URL for MediaMTX.
 *
 * @param {string} ip
 * @param {{ username?: string, password?: string, port?: number }} [opts]
 * @returns {Array<{ url: string, label: string }>}
 */
function guessRtspUrls(ip, { username, password, port = RTSP_DEFAULT_PORT } = {}) {
  const userinfo = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  return COMMON_PATHS.map((c) => ({
    url: `rtsp://${userinfo}${ip}:${port}${c.path}`,
    label: c.label,
  }));
}

/**
 * Inject username/password into an RTSP URL that has no userinfo yet.
 * Returns the original URL unchanged if it already contains credentials.
 */
function embedCredentials(rtspUrl, username, password) {
  if (!username || !rtspUrl) return rtspUrl;
  try {
    const u = new URL(rtspUrl);
    if (u.username) return rtspUrl;
    u.username = encodeURIComponent(username);
    if (password) u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    return rtspUrl;
  }
}

/**
 * Probe a list of candidate URLs with a concurrency cap and early exit once
 * `minAvailable` streams are confirmed available (cameras have limited RTSP
 * connection slots — probing everything at once can trigger failures).
 *
 * @param {Array<{ url: string, label?: string }>} candidates
 * @param {{ username?: string, password?: string, timeoutMs?: number, concurrency?: number, minAvailable?: number }} [opts]
 * @returns {Promise<Array<{ url, label, reachable, authenticated, stream_available, status, error, host, port }>>}
 */
async function probeBatch(candidates, {
  username, password, timeoutMs = 2500,
  concurrency = 4, minAvailable = 2,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const results = new Array(candidates.length).fill(null);
  let next = 0;
  let available = 0;
  let stopped = false;
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopped) {
      const i = next++;
      if (i >= candidates.length) break;
      const r = await probeRtspUrl(candidates[i].url, {
        username: username || undefined,
        password: password || undefined,
        timeoutMs,
      });
      results[i] = {
        ...candidates[i],
        reachable: r.reachable,
        authenticated: r.stream_available,
        stream_available: r.stream_available,
        status: r.status,
        error: r.error || null,
        host: r.host,
        port: r.port,
      };
      if (r.stream_available) {
        available += 1;
        if (available >= minAvailable) stopped = true;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

module.exports = {
  probeRtspUrl,
  probeBatch,
  guessRtspUrls,
  embedCredentials,
  computeDigestResponse,
  parseRtspUrl,
  parseWwwAuthenticate,
  COMMON_PATHS,
};
