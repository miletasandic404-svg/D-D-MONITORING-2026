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
 *   const { rateLimit } = require('./_rate_limit');
 *   if (!rateLimit(req, res)) return;
 *
 * Configuration (via env vars):
 *   RATE_LIMIT_MAX      - max requests per window (default 100)
 *   RATE_LIMIT_WINDOW_MS - window in ms (default 60000 = 1 minute)
 *   UPSTASH_REDIS_REST_URL - Upstash Redis REST API URL
 *   UPSTASH_REDIS_REST_TOKEN - Upstash Redis REST API token
 */

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

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

// In-memory fallback store: IP -> { count, resetAt }
const fallbackStore = new Map();

/**
 * Rate limit check.
 * Returns true if request is allowed, false if rate limited (sends 429).
 */
async function rateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  const now = Date.now();
  const redisClient = getRedis();

  if (redisClient) {
    // Use Upstash Redis for distributed rate limiting
    try {
      const key = `ratelimit:${ip}`;
      const windowKey = `ratelimit:${ip}:window`;
      
      // Get current count and window
      const [currentCount, windowEnd] = await Promise.all([
        redisClient.get(key),
        redisClient.get(windowKey),
      ]);
      
      const count = parseInt(currentCount || '0', 10);
      const resetAt = parseInt(windowEnd || String(now + WINDOW_MS), 10);
      
      // Reset if window expired
      if (resetAt <= now) {
        await redisClient.set(key, '1');
        await redisClient.setex(windowKey, Math.ceil(WINDOW_MS / 1000), String(now + WINDOW_MS));
        const remaining = MAX_REQUESTS - 1;
        const resetSeconds = Math.ceil((now + WINDOW_MS - now) / 1000);
        
        res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + WINDOW_MS) / 1000)));
        return true;
      }
      
      // Check if over limit
      if (count >= MAX_REQUESTS) {
        const resetSeconds = Math.ceil((resetAt - now) / 1000);
        res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
        res.setHeader('Retry-After', String(resetSeconds));
        res.status(429).json({ success: false, error: `Too many requests. Try again in ${resetSeconds}s.` });
        return false;
      }
      
      // Increment count
      await redisClient.incr(key);
      const remaining = MAX_REQUESTS - (count + 1);
      const resetSeconds = Math.ceil((resetAt - now) / 1000);
      
      res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
      return true;
    } catch (err) {
      console.error('Redis rate limit error, falling back to in-memory:', err.message);
      // Fall through to in-memory fallback
    }
  }

  // In-memory fallback
  let entry = fallbackStore.get(ip);

  // Cleanup expired entries (lazy cleanup - runs during request)
  if (fallbackStore.size > 1000) {
    for (const [key, e] of fallbackStore) {
      if (e.resetAt <= now) fallbackStore.delete(key);
    }
  }

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    fallbackStore.set(ip, entry);
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
