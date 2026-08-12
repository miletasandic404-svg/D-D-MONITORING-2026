/**
 * Rate Limiting Middleware
 *
 * Provides distributed rate limiting using Upstash Redis for Vercel
 * serverless API routes. Redis-based tracking works across cold starts
 * and multiple instances, providing robust protection against abusive clients.
 *
 * Falls back to in-memory if Upstash is not configured (for local dev).
 *
 * Usage:
 *   const { rateLimit, authRateLimit, isSensitiveAuthPath } = require('./_rate_limit');
 *   if (!rateLimit(req, res)) return;              // standard limiter
 *   if (!authRateLimit(req, res)) return;          // strict limiter for auth ops
 *
 * Configuration (via env vars):
 *   RATE_LIMIT_MAX        - max requests per window (default 100)
 *   RATE_LIMIT_WINDOW_MS  - window in ms (default 60000 = 1 minute)
 *   AUTH_RATE_LIMIT_MAX   - max auth requests per window (default 10)
 *   AUTH_RATE_LIMIT_WINDOW_MS - auth window in ms (default 60000)
 *   UPSTASH_REDIS_REST_URL - Upstash Redis REST API URL
 *   UPSTASH_REDIS_REST_TOKEN - Upstash Redis REST API token
 */

const crypto = require('crypto');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

// Stricter, separate limits for authentication endpoints (sign-in,
// sign-up, password reset/change) which are brute-force targets.
const AUTH_WINDOW_MS = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '60000', 10);
const AUTH_MAX_REQUESTS = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10);

// Upstash Redis client (lazy load)
let redis = null;

function getRedis() {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null; // Fallback to in-memory
  }

  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url,
      token,
    });
    return redis;
  } catch (err) {
    console.error('Failed to initialize Upstash Redis:', err.message);
    return null;
  }
}

// In-memory fallback store: full composite key -> { count, resetAt }
const fallbackStore = new Map();

/** Best-effort client IP, mirroring the pre-existing convention. */
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

/** sha256 hex digest — used to key limiter buckets without storing PII/credentials. */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Extract a normalized account email from the request body, if present.
 *
 * Never logs it and never stores it: callers only use the return value
 * to derive a hashed limiter key. Returns null when the request carries
 * no email (e.g. reset-password submits a token, not an email).
 */
function accountEmail(req) {
  const raw = req && req.body && typeof req.body.email === 'string' ? req.body.email : null;
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return email.length > 0 && email.includes('@') ? email : null;
}

/**
 * Core check for a single named bucket.
 * Returns true if the request is allowed, false if rate limited (sends 429).
 */
async function checkLimit(req, res, { max, windowMs, redisKey }) {
  const now = Date.now();
  const redisClient = getRedis();

  if (redisClient) {
    // Use Upstash Redis for distributed rate limiting.
    //
    // INCR is atomic in Redis: concurrent requests from the same client
    // are serialized by Redis itself, so there's no read-then-write race
    // window. We only set the TTL on the request that creates the key
    // (count === 1) — subsequent requests just increment. This also
    // guarantees the key expires on its own; nothing leaks in Redis.
    try {
      const count = await redisClient.incr(redisKey);
      if (count === 1) {
        await redisClient.expire(redisKey, Math.ceil(windowMs / 1000));
      }

      // TTL is only informative for headers here; if the key was just
      // created we know it precisely, otherwise ask Redis for the
      // remaining time so the reported reset stays accurate.
      let ttl = Math.ceil(windowMs / 1000);
      if (count > 1) {
        const pttl = await redisClient.pttl(redisKey);
        ttl = pttl > 0 ? Math.ceil(pttl / 1000) : ttl;
      }
      const resetAt = now + ttl * 1000;

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

      if (count > max) {
        res.setHeader('Retry-After', String(ttl));
        res.status(429).json({ success: false, error: `Too many requests. Try again in ${ttl}s.` });
        return false;
      }

      return true;
    } catch (err) {
      console.error('Redis rate limit error, falling back to in-memory:', err.message);
      // Fall through to in-memory fallback
    }
  }

  // In-memory fallback
  let entry = fallbackStore.get(redisKey);

  // Cleanup expired entries (lazy cleanup - runs during request)
  if (fallbackStore.size > 1000) {
    for (const [key, e] of fallbackStore) {
      if (e.resetAt <= now) fallbackStore.delete(key);
    }
  }

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    fallbackStore.set(redisKey, entry);
  }

  entry.count += 1;
  const remaining = Math.max(0, max - entry.count);
  const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > max) {
    res.setHeader('Retry-After', String(resetSeconds));
    res.status(429).json({ success: false, error: `Too many requests. Try again in ${resetSeconds}s.` });
    return false;
  }

  return true;
}

/**
 * Standard rate limit check.
 *
 * Backwards compatible: calling rateLimit(req, res) with no options keeps
 * the exact previous behavior (per-IP bucket, RATE_LIMIT_MAX/WINDOW_MS).
 * Optional overrides: { max, windowMs, prefix, key }.
 */
async function rateLimit(req, res, options = {}) {
  const {
    max = MAX_REQUESTS,
    windowMs = WINDOW_MS,
    prefix = 'ratelimit',
    key,
  } = options;

  const ip = clientIp(req);
  const finalKey = key || ip;
  return checkLimit(req, res, { max, windowMs, redisKey: `${prefix}:${finalKey}` });
}

/**
 * True for authentication endpoints that are brute-force targets:
 * sign-in, sign-up, forget/reset/change password.
 * All other /api/auth/* paths (get-session, sign-out, update-user, ...)
 * are served by the standard limiter.
 */
function isSensitiveAuthPath(path) {
  if (!path) return false;
  return /(sign-in|sign-up|forget-password|reset-password|change-password)/.test(path);
}

/**
 * Strict rate limiter for authentication operations.
 *
 * Applies two independent buckets, each with the stricter AUTH_* limits:
 *   1. Account bucket  — keyed by sha256(email), so one account cannot be
 *      brute-forced from many different IPs.
 *   2. IP+account bucket — keyed by `ip|sha256(email)` (or the bare IP
 *      when no email is present, e.g. reset-password submits a token).
 *
 * Only the hashed key ever reaches Redis — the email itself is never
 * stored or logged, and passwords/tokens are never inspected here.
 */
async function authRateLimit(req, res) {
  const ip = clientIp(req);
  const email = accountEmail(req);
  const emailHash = email ? sha256Hex(email) : null;

  if (emailHash) {
    const accountAllowed = await checkLimit(req, res, {
      max: AUTH_MAX_REQUESTS,
      windowMs: AUTH_WINDOW_MS,
      redisKey: `ratelimit:auth:acct:${emailHash}`,
    });
    if (!accountAllowed) return false;
  }

  const composite = emailHash ? `${ip}|${emailHash}` : ip;
  return checkLimit(req, res, {
    max: AUTH_MAX_REQUESTS,
    windowMs: AUTH_WINDOW_MS,
    redisKey: `ratelimit:auth:${composite}`,
  });
}

module.exports = { rateLimit, authRateLimit, isSensitiveAuthPath };
