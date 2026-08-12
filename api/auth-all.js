const { getNodeHandler } = require('../lib/auth');
const { rateLimit, authRateLimit, isSensitiveAuthPath } = require('../lib/_rate_limit');

/**
 * Catch-all handler for every /api/auth/* route (Vercel rewrite:
 * "/api/auth/:path*" -> "/api/auth-all").
 *
 * Rate limiting: authentication endpoints (sign-in, sign-up, password
 * forget/reset/change) are brute-force targets, so they get a STRICTER
 * limiter that combines client IP with the hashed account email. All
 * other auth paths (get-session, sign-out, update-user, ...) are covered
 * by the standard limiter like the rest of the API.
 *
 * Credentials are never logged: the email is only used to derive a
 * sha256 limiter key, and passwords/tokens are never inspected here.
 * When the limit is hit a 429 is returned and the request does not
 * reach Better Auth; otherwise the request flows through unchanged.
 */
module.exports = async (req, res) => {
  const path = String(req.url || '').split('?')[0];

  if (isSensitiveAuthPath(path)) {
    if (!(await authRateLimit(req, res))) return;
  } else if (!(await rateLimit(req, res))) return;

  const handler = await getNodeHandler();
  return handler(req, res);
};
