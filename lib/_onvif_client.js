'use strict';
/**
 * Minimal ONVIF Profile S client for targeted single-IP camera discovery.
 *
 * Implements only the operations needed for discovery:
 *   - GetDeviceInformation  → manufacturer, model, firmware, serial
 *   - GetCapabilities       → locate the media service URL
 *   - GetProfiles           → enumerate media profiles and their tokens
 *   - GetStreamUri          → RTSP URI per profile
 *
 * Uses SOAP 1.1 (text/xml + SOAPAction header) for maximum compatibility
 * with real-world IP cameras (Hikvision, Dahua, Axis, Hanwha, Uniview, etc.)
 * which commonly implement only SOAP 1.1 despite the ONVIF spec requiring 1.2.
 *
 * Authentication: HTTP Basic Auth (Authorization header) rather than
 * WS-Security PasswordDigest. HTTP Basic Auth is supported by the vast
 * majority of ONVIF cameras and avoids any use of cryptographic primitives
 * in this module. Credentials are only transmitted when the caller explicitly
 * provides them, and only to the IP address the caller specifies.
 *
 * No external dependencies — uses Node.js built-in http/https/net modules only.
 */

const http = require('http');
const https = require('https');
const net = require('net');

const SOAP_TIMEOUT_MS = 8000;
const RTSP_PROBE_TIMEOUT_MS = 3000;
const RTSP_PORT = 554;

// ─── Subnet-scan tuning constants ─────────────────────────────────────────────
// TCP reachability probe timeout per host/port (Phase 1 of subnet scan).
const SCAN_TCP_TIMEOUT_MS = 1200;
// Overall per-host ONVIF probe timeout (Phase 2 of subnet scan).
// Wraps the entire findDeviceServiceUrl+GetDeviceInformation sequence.
const SCAN_ONVIF_TIMEOUT_MS = 4000;
// ONVIF HTTP ports to probe in Phase 1. Most cameras use 80; 8080/8000/8899
// are common alternatives (Dahua, some Axis, Hikvision NVRs).
const SCAN_ONVIF_PORTS = [80, 8080, 8000, 8899];
// Phase-1 TCP concurrency: probe many hosts simultaneously.
const SCAN_PHASE1_CONCURRENCY = 50;
// Phase-2 ONVIF concurrency: keep low so we don't flood cameras.
const SCAN_PHASE2_CONCURRENCY = 10;
// Maximum host count accepted from a single scan request.
const SCAN_MAX_HOSTS = 254;

// Ordered list of device-service paths to probe when locating the ONVIF endpoint.
// Most cameras use the first path; Dahua and some Axis models use alternatives.
const DEVICE_PATHS = [
  '/onvif/device_service',
  '/onvif/Device',
  '/onvif/device',
  '/onvif/services',
];

// ONVIF WSDL action base URLs
const DEVICE_WSDL = 'http://www.onvif.org/ver10/device/wsdl';
const MEDIA_WSDL = 'http://www.onvif.org/ver10/media/wsdl';

// ─── XML helpers ──────────────────────────────────────────────────────────────

function escapeXml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(v) {
  // Single-pass replacement prevents double-unescaping (e.g. &amp;lt; → &lt; → <).
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  return String(v ?? '').replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => entities[m] ?? m);
}

/**
 * Extract the text content of the first occurrence of `tag` (any namespace prefix).
 */
function xmlGet(xml, tag) {
  const re = new RegExp(
    `<(?:[\\w]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w]+:)?${tag}>`,
    'i',
  );
  const m = xml.match(re);
  return m ? unescapeXml(m[1].trim()) : null;
}

/**
 * Extract all `attr` attribute values from every occurrence of `tag`.
 */
function xmlAttrs(xml, tag, attr) {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}[^>]*\\b${attr}="([^"]*)"`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(unescapeXml(m[1]));
  return results;
}

// ─── SOAP helpers ─────────────────────────────────────────────────────────────

/**
 * Wrap SOAP body content in a SOAP 1.1 envelope.
 */
function soapEnvelope(bodyContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>${bodyContent}</s:Body>
</s:Envelope>`;
}

/**
 * Perform a SOAP 1.1 POST to `url`.
 *
 * @param {string} url      Target SOAP endpoint
 * @param {string} action   SOAPAction value (quoted internally)
 * @param {string} envelope Complete SOAP 1.1 envelope XML
 * @param {string} username Optional HTTP Basic Auth username
 * @param {string} authCred Optional HTTP Basic Auth credential
 */
function soapPost(url, action, envelope, username, authCred) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = Buffer.from(envelope, 'utf8');

    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': body.length,
      SOAPAction: `"${action}"`,
    };
    // Use HTTP Basic Auth when credentials are supplied. This is supported by the
    // vast majority of ONVIF cameras and requires no cryptographic operations here.
    if (username) {
      headers.Authorization = 'Basic ' + Buffer.from(`${username}:${authCred || ''}`).toString('base64');
    }

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers,
        timeout: SOAP_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, xml: data }));
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error(`SOAP request timed out (${url})`)); });
    req.on('error', (err) => reject(new Error(`SOAP request failed (${url}): ${err.message}`)));
    req.write(body);
    req.end();
  });
}

// ─── RTSP probe ───────────────────────────────────────────────────────────────

/**
 * Returns true if TCP port 554 on `ip` accepts a connection within `timeoutMs`.
 * Does not send any RTSP commands — pure reachability check.
 */
function probeRtspPort(ip, timeoutMs = RTSP_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(RTSP_PORT, ip, () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

// ─── ONVIF operations ─────────────────────────────────────────────────────────

/**
 * Find the first ONVIF device service URL that responds to a
 * GetSystemDateAndTime probe (no auth required for this call on most cameras).
 */
async function findDeviceServiceUrl(ip, port) {
  let lastErr = null;
  for (const path of DEVICE_PATHS) {
    const url = `http://${ip}:${port}${path}`;
    const env = soapEnvelope('<tds:GetSystemDateAndTime/>');
    try {
      const { status } = await soapPost(url, `${DEVICE_WSDL}/GetSystemDateAndTime`, env);
      // Accept any non-5xx response — even 400/401 means the endpoint exists.
      if (status < 500) return url;
    } catch (err) {
      lastErr = err;
    }
  }
  const cause = lastErr ? ` (${lastErr.message})` : '';
  const err = new Error(
    `ONVIF device not reachable at ${ip}:${port}. ` +
    `Tried paths: ${DEVICE_PATHS.join(', ')}${cause}`,
  );
  err.code = 'ONVIF_NOT_REACHABLE';
  throw err;
}

/**
 * Call GetDeviceInformation and return basic device details.
 * Falls back to "Unknown" for fields the camera does not expose.
 */
async function getDeviceInformation(deviceUrl, username, authCred) {
  const env = soapEnvelope('<tds:GetDeviceInformation/>');
  const { xml } = await soapPost(deviceUrl, `${DEVICE_WSDL}/GetDeviceInformation`, env, username, authCred);
  return {
    manufacturer: xmlGet(xml, 'Manufacturer') || 'Unknown',
    model: xmlGet(xml, 'Model') || 'Unknown',
    firmware_version: xmlGet(xml, 'FirmwareVersion') || null,
    serial_number: xmlGet(xml, 'SerialNumber') || null,
    hardware_id: xmlGet(xml, 'HardwareId') || null,
  };
}

/**
 * Call GetCapabilities to locate the media service URL.
 * Falls back to the common default path if the camera does not advertise it.
 */
async function getMediaServiceUrl(deviceUrl, ip, port, username, authCred) {
  const env = soapEnvelope(
    '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
  );
  try {
    const { xml } = await soapPost(deviceUrl, `${DEVICE_WSDL}/GetCapabilities`, env, username, authCred);
    // The XAddr sits inside a <Media> or <tds:Media> block.
    const mediaBlock = xml.match(/<(?:\w+:)?Media\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Media>/i);
    if (mediaBlock) {
      const xaddr = xmlGet(mediaBlock[1], 'XAddr');
      if (xaddr && xaddr.startsWith('http')) return xaddr;
    }
  } catch {
    // Non-fatal — fall through to default path
  }
  return `http://${ip}:${port}/onvif/media_service`;
}

/**
 * Call GetProfiles on the media service and return a list of profile tokens.
 */
async function getProfileTokens(mediaUrl, username, authCred) {
  const env = soapEnvelope('<trt:GetProfiles/>');
  try {
    const { xml } = await soapPost(mediaUrl, `${MEDIA_WSDL}/GetProfiles`, env, username, authCred);
    const tokens = xmlAttrs(xml, 'Profiles', 'token');
    return tokens.length > 0 ? tokens : ['Profile_1'];
  } catch {
    return ['Profile_1'];
  }
}

/**
 * Call GetStreamUri for a single profile token and return the RTSP URI string,
 * or null if unavailable.
 */
async function getStreamUri(mediaUrl, profileToken, username, authCred) {
  const env = soapEnvelope(`
    <trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken>
    </trt:GetStreamUri>`);
  try {
    const { xml } = await soapPost(mediaUrl, `${MEDIA_WSDL}/GetStreamUri`, env, username, authCred);
    const uri = xmlGet(xml, 'Uri');
    return uri && uri.startsWith('rtsp://') ? uri : null;
  } catch {
    return null;
  }
}

/**
 * Some cameras embed their internal LAN IP in the RTSP URI returned by
 * GetStreamUri. Replace the host portion with the IP the user actually
 * provided so the resulting URL is usable from outside their LAN.
 */
function normalizeRtspUri(uri, userIp) {
  try {
    const u = new URL(uri);
    u.hostname = userIp;
    return u.toString();
  } catch {
    return uri;
  }
}

// ─── Subnet scan ──────────────────────────────────────────────────────────────

/**
 * Returns true if TCP `port` on `ip` accepts a connection within `timeoutMs`.
 * Used during Phase 1 of subnet scanning to filter hosts that likely run ONVIF.
 */
function probeTcpPort(ip, port, timeoutMs = SCAN_TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

/**
 * Run an array of async thunks with at most `limit` executing concurrently.
 * Returns the resolved values in the same order as `tasks`.
 */
async function runConcurrent(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = await tasks[i]();
      } catch {
        results[i] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Lightweight ONVIF probe used during subnet scanning.
 *
 * Only calls GetDeviceInformation (no media profile enumeration) to keep
 * per-host latency to a minimum. Wrapped externally in a race timeout.
 *
 * @returns {{ ip, onvif_port, manufacturer, model, firmware_version, serial_number }}
 */
async function quickProbeCamera(ip, port) {
  const deviceUrl = await findDeviceServiceUrl(ip, port);
  const info = await getDeviceInformation(deviceUrl, '', '');
  return { ip, onvif_port: port, ...info };
}

/**
 * Scan a LAN subnet (/24 maximum) for ONVIF-capable cameras.
 *
 * The scan runs in two phases:
 *   1. TCP reachability — probe each host on common ONVIF ports with a short
 *      timeout (SCAN_TCP_TIMEOUT_MS). Runs up to SCAN_PHASE1_CONCURRENCY tasks
 *      simultaneously. Only hosts with at least one open port proceed.
 *   2. ONVIF probe — call GetDeviceInformation on each candidate. Each probe is
 *      raced against SCAN_ONVIF_TIMEOUT_MS so a slow host cannot stall the scan.
 *      Runs up to SCAN_PHASE2_CONCURRENCY tasks simultaneously.
 *
 * @param {string} subnet   CIDR notation (e.g. "192.168.1.0/24") or three-octet
 *                          shorthand (e.g. "192.168.1"). Must be a private network.
 * @returns {Promise<Array<{
 *   ip: string,
 *   onvif_port: number,
 *   manufacturer: string,
 *   model: string,
 *   firmware_version: string|null,
 *   serial_number: string|null,
 * }>>}
 */
async function scanSubnet(subnet) {
  // ── Parse subnet ──────────────────────────────────────────────────────────
  let base;
  const cidrMatch = subnet.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/(\d+)$/);
  const shortMatch = subnet.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (cidrMatch) {
    const prefixLen = parseInt(cidrMatch[2], 10);
    if (prefixLen < 24) {
      throw Object.assign(
        new Error('Subnet too large — only /24 or smaller subnets are supported (max 254 hosts)'),
        { code: 'SUBNET_TOO_LARGE' },
      );
    }
    base = cidrMatch[1];
  } else if (shortMatch) {
    base = shortMatch[1];
  } else {
    throw Object.assign(
      new Error('subnet must be in CIDR notation (e.g. 192.168.1.0/24) or three-octet format (e.g. 192.168.1)'),
      { code: 'SUBNET_INVALID' },
    );
  }

  // ── Generate host IPs (.1 – .254) ─────────────────────────────────────────
  const ips = Array.from({ length: SCAN_MAX_HOSTS }, (_, i) => `${base}.${i + 1}`);

  // ── Phase 1: TCP probe ─────────────────────────────────────────────────────
  // Build one task per (ip, port) combination and run with high concurrency.
  const phase1Tasks = ips.flatMap((ip) =>
    SCAN_ONVIF_PORTS.map((port) => async () => {
      const open = await probeTcpPort(ip, port, SCAN_TCP_TIMEOUT_MS);
      return open ? { ip, port } : null;
    }),
  );
  const phase1Results = await runConcurrent(phase1Tasks, SCAN_PHASE1_CONCURRENCY);

  // Deduplicate: keep only the first open port per IP.
  const candidates = new Map();
  for (const r of phase1Results) {
    if (r && !candidates.has(r.ip)) {
      candidates.set(r.ip, r.port);
    }
  }

  if (candidates.size === 0) return [];

  // ── Phase 2: ONVIF device probe ────────────────────────────────────────────
  const phase2Tasks = [...candidates.entries()].map(([ip, port]) => async () => {
    try {
      const result = await Promise.race([
        quickProbeCamera(ip, port),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ONVIF probe timeout')), SCAN_ONVIF_TIMEOUT_MS),
        ),
      ]);
      return result;
    } catch {
      return null;
    }
  });
  const phase2Results = await runConcurrent(phase2Tasks, SCAN_PHASE2_CONCURRENCY);

  return phase2Results.filter(Boolean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover an ONVIF camera at a known IP address and return its details.
 *
 * @param {string}  ip         Camera IPv4 address
 * @param {number}  port       ONVIF HTTP port (default 80; common alternatives: 8080, 8000, 8899)
 * @param {string}  username   ONVIF username (optional — many cameras allow anonymous GetDeviceInformation)
 * @param {string}  authCred   ONVIF credential (optional; sent as HTTP Basic Auth)
 *
 * @returns {{
 *   manufacturer: string,
 *   model: string,
 *   firmware_version: string|null,
 *   serial_number: string|null,
 *   hardware_id: string|null,
 *   rtsp_urls: string[],
 *   rtsp_reachable: boolean,
 *   onvif_port: number,
 * }}
 *
 * @throws {Error} with `.code === 'ONVIF_NOT_REACHABLE'` if no ONVIF endpoint responds.
 */
async function discoverCamera(ip, port = 80, username = '', authCred = '') {
  // Step 1: locate the device service endpoint (probe without credentials first)
  const deviceUrl = await findDeviceServiceUrl(ip, port);

  // Step 2: basic device information
  const deviceInfo = await getDeviceInformation(deviceUrl, username, authCred);

  // Step 3: find the media service URL
  const mediaUrl = await getMediaServiceUrl(deviceUrl, ip, port, username, authCred);

  // Step 4: enumerate profiles (max 4 to keep latency bounded)
  const profileTokens = await getProfileTokens(mediaUrl, username, authCred);

  // Step 5: GetStreamUri for each profile
  const rtspUrls = [];
  for (const token of profileTokens.slice(0, 4)) {
    const uri = await getStreamUri(mediaUrl, token, username, authCred);
    if (uri) {
      const normalized = normalizeRtspUri(uri, ip);
      if (!rtspUrls.includes(normalized)) rtspUrls.push(normalized);
    }
  }

  // Step 6: probe RTSP port 554 reachability (TCP only — no full RTSP handshake)
  const rtspReachable = await probeRtspPort(ip);

  return {
    ...deviceInfo,
    rtsp_urls: rtspUrls,
    rtsp_reachable: rtspReachable,
    onvif_port: port,
  };
}

module.exports = { discoverCamera, scanSubnet };

