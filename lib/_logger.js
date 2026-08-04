'use strict';
/**
 * Structured production logger for media node workers (Phase 9).
 *
 * Every entry contains: timestamp, component, severity (level) and event,
 * plus any structured fields the caller supplies (e.g. task_id, camera_id).
 *
 * Secrets are NEVER logged: every entry is run through redactSecrets(),
 * which scrubs values whose key looks like a secret (password, token,
 * secret, key, authorization, credentials, nonce), standalone token-like
 * strings (>= 16 chars, no spaces) and RTSP userinfo (rtsp://user:pass@).
 *
 * Env (read on every emit, so it can be toggled at runtime):
 *   LOG_LEVEL  - debug|info|warn|error (default info)
 *   LOG_FORMAT - json | pretty (default pretty; use json for log collectors)
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /password|passwd|secret|token|api[_-]?key|authorization|credential|nonce|heartbeat[_-]?secret/i;

// Token-like standalone values (no separators):
//  - pure hex >= 32 chars (stream tokens, hashes, encryption keys)
//  - base64-ish >= 24 chars with optional trailing '=' (encrypted blobs)
// Timestamps (contain '-', ':', 'T', 'Z'), dotted event names and short
// dashed camera IDs never match, so they are never redacted.
const HEX_TOKEN_RE = /^[a-f0-9]{32,}$/i;
const BASE64_TOKEN_RE = /^[A-Za-z0-9+/]{24,}={0,2}$/;

function isTokenLike(value) {
  const s = String(value).trim();
  return HEX_TOKEN_RE.test(s) || BASE64_TOKEN_RE.test(s);
}

function redactSecrets(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 8) return value;

  if (typeof value === 'string') {
    // Strip RTSP/RTMPS userinfo: rtsp://user:pass@host → rtsp://<redacted>@host
    let s = value.replace(/rtsp[s]?:\/\/[^/@\s]+@/gi, 'rtsp://<redacted>@');
    if (isTokenLike(s)) {
      return '<redacted>';
    }
    return s;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') {
        out[k] = '<redacted>';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

function emit(component, level, event, fields) {
  const active = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;
  if ((LEVELS[level] || LEVELS.info) < active) return;

  const format = (process.env.LOG_FORMAT || 'pretty').toLowerCase();
  const entry = redactSecrets({
    ts: new Date().toISOString(),
    component,
    level,
    event,
    ...(fields || {}),
  });

  const fn = level === 'warn' || level === 'error' ? console[level] : console.log;
  if (format === 'json') {
    fn(JSON.stringify(entry));
  } else {
    const extra = fields ? ` ${JSON.stringify(entry)}` : '';
    fn(`[${entry.ts}] [${component}] ${level.toUpperCase()} ${event}${extra}`);
  }
}

/** Create a logger bound to a component (e.g. 'camera-sync', 'heartbeat'). */
function makeLogger(component) {
  return {
    debug: (event, fields) => emit(component, 'debug', event, fields),
    info: (event, fields) => emit(component, 'info', event, fields),
    warn: (event, fields) => emit(component, 'warn', event, fields),
    error: (event, fields) => emit(component, 'error', event, fields),
  };
}

module.exports = { makeLogger, redactSecrets, LEVELS };
