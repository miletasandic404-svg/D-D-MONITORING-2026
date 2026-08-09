'use strict';

/**
 * Centralized network-security policy for outbound connections.
 *
 * Why this exists (SSRF hardening): several workers open outbound
 * connections to hosts that originate, directly or indirectly, from
 * user input (RTSP URLs, camera IPs). On SHARED infrastructure (the
 * recording worker on Fly/VPS) an attacker-controlled host could
 * otherwise reach internal services, cloud metadata (169.254.169.254),
 * or other tenants' private networks.
 *
 * Two policy modes, because the two execution contexts have opposite
 * legitimate needs:
 *
 *   allowPrivate: true   -- tenant media node (laptop on the org's own
 *                          LAN). RFC1918 + public IPs are ALLOWED because
 *                          reaching local cameras (192.168.x.x etc.) is
 *                          the product's core function. Still blocked:
 *                          loopback, link-local (169.254.0.0/16 incl.
 *                          cloud metadata), multicast, unspecified,
 *                          IPv4-in-IPv6, and DNS names resolving to them.
 *   allowPrivate: false  -- shared infrastructure (recording worker on
 *                          Fly/VPS). Only public IPs allowed. Any private,
 *                          loopback, link-local, or metadata address is
 *                          rejected -- shared infra must never touch
 *                          internal networks.
 *
 * Covers: IPv4, IPv6, IPv4-in-IPv6 (::ffff:a.b.c.d), hostnames via
 * DNS resolution (with rebinding-aware resolve-then-check), and URL
 * parsing (RTSP/RTSPS/HTTP/HTTPS).
 */

const dns = require('dns');
const net = require('net');

// ─── Block lists (built with node:net BlockList) ────────────────────────────

const FORBIDDEN_ALWAYS = (() => {
  const bl = new net.BlockList();
  // IPv4 -- RFC1918 private ranges are intentionally NOT in this list:
  // they are allowed on tenant media nodes (allowPrivate: true) and only
  // rejected on shared infrastructure via PRIVATE_ONLY.
  bl.addSubnet('0.0.0.0', 8);        // this network (includes 0.0.0.0)
  bl.addSubnet('100.64.0.0', 10);    // CGNAT / carrier-grade NAT
  bl.addSubnet('127.0.0.0', 8);      // loopback
  bl.addSubnet('169.254.0.0', 16);   // link-local (incl. 169.254.169.254 metadata)
  bl.addSubnet('192.0.0.0', 24);     // IETF protocol assignments (192.0.0.9/10 anycast)
  bl.addSubnet('192.0.2.0', 24);     // TEST-NET-1
  bl.addSubnet('192.88.99.0', 24);   // 6to4 relay (deprecated)
  bl.addSubnet('198.18.0.0', 15);    // benchmark / inter-network comms
  bl.addSubnet('198.51.100.0', 24);  // TEST-NET-2
  bl.addSubnet('203.0.113.0', 24);   // TEST-NET-3
  bl.addSubnet('224.0.0.0', 4);      // multicast
  bl.addSubnet('240.0.0.0', 4);      // reserved
  bl.addSubnet('255.255.255.255', 32); // limited broadcast
  return bl;
})();

// net.BlockList does NOT support IPv6 (Node <= 22), so IPv6 checks use a
// manual prefix matcher instead. Prefixes are kept in sync with the IPv4
// block list above.
const IPV6_FORBIDDEN_PREFIXES = [
  // [address, prefixLength]
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b::', 96],     // NAT64 well-known prefix
  ['100::', 64],         // discard / benchmarking
  ['2001:10::', 28],     // ORCHID
  ['2001:db8::', 32],    // documentation
  ['fc00::', 7],         // ULA (unique local, private)
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
];

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is handled by normalizeIp() which
// unwraps it to a plain IPv4 before these checks run.
const IPV6_PRIVATE_PREFIXES = [
  ['fc00::', 7],
];

function ipv6ToBigInt(ip) {
  // Expand '::' and each group into a 128-bit BigInt.
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(parseInt(g || '0', 16));
  }
  return value;
}

function ipv6Matches(ip, prefixAddr, prefixLen) {
  const ipVal = ipv6ToBigInt(ip);
  const prefixVal = ipv6ToBigInt(prefixAddr);
  if (prefixLen === 0) return true;
  const mask = (1n << BigInt(128 - prefixLen)) - 1n;
  return (ipVal & ~mask) === (prefixVal & ~mask);
}

function ipv6InAny(ip, prefixes) {
  return prefixes.some(([addr, len]) => ipv6Matches(ip, addr, len));
}

/**
 * RFC1918-only block list (for the "is this a private LAN address"
 * question). Distinct from FORBIDDEN_ALWAYS so callers can decide
 * whether private is allowed in their context.
 */
// IPv4 private ranges only -- net.BlockList does not support IPv6, so
// IPv6 private (fc00::/7 ULA) is checked via IPV6_PRIVATE_PREFIXES.
const PRIVATE_ONLY = (() => {
  const bl = new net.BlockList();
  bl.addSubnet('10.0.0.0', 8);
  bl.addSubnet('172.16.0.0', 12);
  bl.addSubnet('192.168.0.0', 16);
  return bl;
})();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an address string into a plain IP (strip zone ids, and
 * un-embed IPv4-in-IPv6 mapped addresses like ::ffff:127.0.0.1).
 * Returns the IP string or null if it is not a valid IP.
 */
function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  // Strip IPv6 zone id (fe80::1%eth0)
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  // IPv4-in-IPv6 (::ffff:a.b.c.d or ::a.b.c.d)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return net.isIP(v4mapped[1]) === 4 ? v4mapped[1] : null;
  if (net.isIP(ip) === 0) return null;
  return ip;
}

/**
 * Classify an IP: 'public' | 'private' | 'loopback' | 'link-local' |
 * 'metadata' | 'unspecified' | 'multicast' | 'reserved' | 'invalid'.
 * Always-invalid addresses are classified by their most specific
 * category; 'private' only when allowPrivate would be required.
 */
function classifyIp(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return 'invalid';
  const version = net.isIP(norm);
  if (version !== 4 && version !== 6) return 'invalid';

  // Specific categories first (more informative than the blanket list).
  if (version === 4) {
    if (/^127\./.test(norm)) return 'loopback';
    if (/^169\.254\./.test(norm)) {
      return norm === '169.254.169.254' ? 'metadata' : 'link-local';
    }
    if (/^0\./.test(norm)) return 'unspecified';
    if (/^224\./.test(norm) || /^225\./.test(norm) || /^226\./.test(norm)
      || /^227\./.test(norm) || /^228\./.test(norm) || /^229\./.test(norm)
      || /^230\./.test(norm) || /^231\./.test(norm) || /^232\./.test(norm)
      || /^233\./.test(norm) || /^234\./.test(norm) || /^235\./.test(norm)
      || /^236\./.test(norm) || /^237\./.test(norm) || /^238\./.test(norm)
      || /^239\./.test(norm)) return 'multicast';
    if (/^24[0-9]\./.test(norm) || /^25[0-5]\./.test(norm)) return 'reserved';
    if (PRIVATE_ONLY.check(norm)) return 'private';
    return 'public';
  }

  // IPv6
  if (norm === '::1') return 'loopback';
  if (norm === '::') return 'unspecified';
  if (/^fe80:/i.test(norm)) return 'link-local';
  if (/^ff[0-9a-f]{2}:/i.test(norm)) return 'multicast';
  if (/^fc|^fd/i.test(norm)) return 'private';
  if (/^2001:db8:/i.test(norm)) return 'reserved';
  return 'public';
}

/**
 * Is this IP ever allowed to be connected to? Combines the blanket
 * FORBIDDEN_ALWAYS list with the allowPrivate flag.
 */
function isIpAllowed(ip, { allowPrivate }) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  const version = net.isIP(norm);
  if (version === 4) {
    if (FORBIDDEN_ALWAYS.check(norm)) return false;
    if (!allowPrivate && PRIVATE_ONLY.check(norm)) return false;
    return true;
  }
  if (version === 6) {
    if (ipv6InAny(norm, IPV6_FORBIDDEN_PREFIXES)) return false;
    if (!allowPrivate && ipv6InAny(norm, IPV6_PRIVATE_PREFIXES)) return false;
    return true;
  }
  return false;
}

/**
 * Resolve a hostname to its addresses (all of them, for rebinding-
 * aware checking). Rejects names that cannot be resolved.
 * @returns {Promise<string[]>} list of IPs
 */
function resolveHost(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, family: 0 }, (err, addresses) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((addresses || []).map((a) => a.address));
    });
  });
}

/**
 * Validate a raw host (IP literal or hostname) against the policy.
 * @returns {Promise<{ ok: boolean, reason?: string, addresses?: string[] }>}
 */
async function checkHost(host, { allowPrivate }) {
  if (!host) return { ok: false, reason: 'empty host' };
  const norm = normalizeIp(host);
  if (norm) {
    const allowed = isIpAllowed(norm, { allowPrivate });
    if (!allowed) {
      return { ok: false, reason: `address ${norm} (${classifyIp(norm)}) is not allowed` };
    }
    return { ok: true, addresses: [norm] };
  }
  // Hostname: resolve and check every address (covers DNS rebinding
  // in the common case, and decimal/hex/octal IP forms which DNS
  // resolves to the same address).
  let addresses;
  try {
    addresses = await resolveHost(host);
  } catch {
    return { ok: false, reason: `hostname ${host} could not be resolved` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `hostname ${host} resolved to no addresses` };
  }
  for (const addr of addresses) {
    if (!isIpAllowed(addr, { allowPrivate })) {
      return { ok: false, reason: `hostname ${host} resolves to disallowed address ${addr} (${classifyIp(addr)})` };
    }
  }
  return { ok: true, addresses };
}

/**
 * Extract and validate the host of a URL (rtsp://, rtsps://, http://,
 * https://). Returns { ok, reason?, host?, port?, addresses? }.
 */
async function checkUrl(url, { allowPrivate }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  const proto = parsed.protocol;
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(proto)) {
    return { ok: false, reason: `unsupported protocol ${proto}` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: 'URL has no host' };
  const res = await checkHost(host, { allowPrivate });
  if (!res.ok) return res;
  return { ok: true, host, port: parsed.port || null, addresses: res.addresses };
}

/**
 * High-level guard used by workers before opening ANY outbound
 * connection to a user-influenced target. Throws on violation.
 *
 * @param {string} target - URL (rtsp/rtsps/http/https) or bare host/IP
 * @param {{ allowPrivate?: boolean }} [opts]
 */
async function assertSafeTarget(target, { allowPrivate = false } = {}) {
  if (!target) {
    const err = new Error('network policy: empty target');
    err.code = 'NETWORK_POLICY';
    throw err;
  }
  const looksLikeUrl = /^(rtsp|rtsps|http|https):\/\//i.test(String(target).trim());
  const res = looksLikeUrl
    ? await checkUrl(target, { allowPrivate })
    : await checkHost(target, { allowPrivate });
  if (!res.ok) {
    const err = new Error(`network policy: ${res.reason}`);
    err.code = 'NETWORK_POLICY';
    throw err;
  }
  return res;
}

module.exports = {
  assertSafeTarget,
  checkHost,
  checkUrl,
  classifyIp,
  isIpAllowed,
  normalizeIp,
  resolveHost,
};
