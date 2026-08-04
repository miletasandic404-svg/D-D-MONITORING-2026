/**
 * Rate Limiting Middleware
 *
 * Provides a simple in-memory token bucket rate limiter for Vercel
 * serverless API routes. In-memory tracking is per-instance so it is
 * not perfectly accurate across cold starts, but provides meaningful
 * protection against individual abusive clients.
 *
 * Usage:
 *   const { rateLimit } = require('./_rate_limit');
 *   if (!rateLimit(req, res)) return;
 *
 * Configuration (via env vars):
 *   RATE_LIMIT_MAX      - max requests per window (default 100)
 *   RATE_LIMIT_WINDOW_MS - window in ms (default 60000 = 1 minute)
 */

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

// In-memory store: IP -> { count, resetAt }
const store = new Map();

/**
 * Rate limit check.
 * Returns true if request is allowed, false if rate limited (sends 429).
 */
function rateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  const now = Date.now();
  let entry = store.get(ip);

  // Cleanup expired entries (lazy cleanup - runs during request)
  if (store.size > 1000) {
    for (const [key, e] of store) {
      if (e.resetAt <= now) store.delete(key);
    }
  }

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  }

  entry.count += 1;
  const remaining = Math.max(0, MAX_REQUESTS - entry.count);
  const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);

  res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > MAX_REQUESTS) {
    res.setHeader('Retry-After', String(resetSeconds));
    res.status(429).json({ success: false, error: `Too many requests. Try again in ${resetSeconds}s.` });
    return false;
  }

  return true;
}

module.exports = { rateLimit };
