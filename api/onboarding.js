'use strict';

/**
 * Customer onboarding API.
 *
 * POST /api/onboarding?path=register
 *   Creates a new organization + default site for an already-authenticated user
 *   (user must have signed up via Better Auth /api/auth/sign-up/email first).
 *
 * POST /api/onboarding?path=connect-camera
 *   ONVIF discovery + automatic camera registration for the caller's org.
 *   The customer provides IP, ONVIF credentials; the system discovers the RTSP
 *   URL, assigns a media node, and syncs MediaMTX automatically.
 *
 * GET  /api/onboarding?path=status
 *   Returns the org's onboarding_completed flag plus camera list.
 *
 * POST /api/onboarding?path=complete
 *   Marks onboarding_completed = true on the org.
 */

const crypto = require('crypto');
const db = require('../db/index');
const { requireAuth } = require('../lib/_auth');
const { logAudit, getIp } = require('../lib/_audit');
const { sendError, sendSuccess } = require('../lib/_error');
const { rateLimit } = require('../lib/_rate_limit');
const {
  getPlanLimits,
  linkRegistrationToOrganization,
  retryOrganizationPaymentActivations,
  validateRegistrationPayment,
} = require('../lib/_payment_activation');

const VALID_PLANS = ['starter', 'growth', 'enterprise'];

// ─── Route handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (!rateLimit(req, res)) return;

  // ── POST /api/onboarding/register ─────────────────────────────────────────
  // Creates a new organization + default site, then links the authenticated
  // user to it as org_admin. Call this immediately after Better Auth sign-up
  // while the user's session cookie / token is fresh.
  if (req.query.path === 'register') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;

    // If user already belongs to a real (non-default) org, refuse re-registration.
    if (auth.organizationId) {
      const { rows: orgRows } = await db.query(
        `SELECT name FROM organizations WHERE id = $1`,
        [auth.organizationId],
      );
      if (orgRows.length > 0 && orgRows[0].name !== 'Default Organization') {
        return sendError(res, 409, 'Your account already has an organization set up.');
      }
    }

    const {
      orgName,
      phone,
      address,
      planTier: requestedPlanTier = 'starter',
      paymentId = '',
    } = req.body || {};

    if (!orgName || typeof orgName !== 'string' || orgName.trim().length < 2) {
      return sendError(res, 400, 'orgName is required (minimum 2 characters)');
    }
    let planTier = requestedPlanTier;
    if (!VALID_PLANS.includes(planTier)) {
      return sendError(res, 400, `planTier must be one of: ${VALID_PLANS.join(', ')}`);
    }

    let paymentRecord = null;
    try {
      const validated = await validateRegistrationPayment({
        paymentId: String(paymentId || '').trim() || undefined,
        planId: planTier,
      });
      planTier = validated.planId;
      paymentRecord = validated.payment;
    } catch (err) {
      return sendError(res, err.statusCode || 400, err.message);
    }

    const limits = getPlanLimits(planTier);
    if (!limits) {
      return sendError(res, 400, `planTier must be one of: ${VALID_PLANS.join(', ')}`);
    }
    const trimmedName = orgName.trim();

    // For paid plans the org starts as 'pending' so that an activation
    // failure (step 2) never leaves an 'active' org without a confirmed
    // payment.  activatePaymentForOrganization (called inside
    // linkRegistrationToOrganization) atomically sets the status to
    // 'active' once the payment record is linked.  Free plans are set to
    // 'active' immediately since no payment linking is needed.
    const initialOrgStatus = paymentRecord ? 'pending' : 'active';

    let orgId, siteId;
    try {
      // Step 1 — create org, site, and user link atomically.
      ({ orgId, siteId } = await db.transaction(async (client) => {
        const orgResult = await client.query(
          `INSERT INTO organizations
             (name, plan_tier, status, phone, address,
              camera_limit, site_limit, onboarding_completed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           RETURNING id`,
          [trimmedName, planTier, initialOrgStatus, phone || null, address || null,
           limits.camera_limit, limits.site_limit],
        );
        const newOrgId = orgResult.rows[0].id;

        const siteResult = await client.query(
          `INSERT INTO sites (organization_id, name, address, timezone, status)
           VALUES ($1, $2, $3, 'UTC', 'active')
           RETURNING id`,
          [newOrgId, `${trimmedName} — Main Site`, address || null],
        );

        await client.query(
          `UPDATE users SET organization_id = $1, user_type = 'org_admin' WHERE id = $2`,
          [newOrgId, auth.userId],
        );

        return { orgId: newOrgId, siteId: siteResult.rows[0].id };
      }));

      // Step 2 — link payment and activate org (sets status → 'active').
      // Runs after step 1 commits so that activatePaymentForOrganization
      // can see the new org on its own connection.  If this fails, the org
      // remains 'pending' — the user can retry via /api/payments/retry.
      if (paymentRecord) {
        await linkRegistrationToOrganization({
          paymentId: paymentRecord.id,
          organizationId: orgId,
          userId: auth.userId,
          req,
        });
      }
    } catch (dbErr) {
      console.error('[onboarding/register] DB error:', dbErr.message);
      return sendError(res, 500, `Failed to create organization: ${dbErr.message}`);
    }

    await logAudit({
      organizationId: orgId,
      userId: auth.userId,
      action: 'org.created_via_onboarding',
      resourceType: 'organization',
      resourceId: orgId,
      metadata: { orgName: trimmedName, planTier },
      ipAddress: getIp(req),
    });

    return sendSuccess(res, {
      organizationId: orgId,
      siteId,
      orgName: trimmedName,
      planTier,
    }, 201);
  }

  // ── POST /api/onboarding/connect-camera — DISABLED: cloud cannot reach LAN cameras ──
  // ONVIF discovery + camera registration must run on the local media node.
  // Use POST /api/cameras?path=setup-create with mode='onvif' instead.
  if (req.query.path === 'connect-camera') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendError(res, 501,
      'Camera connection from the cloud is not available — cloud servers cannot reach cameras on your local network. ' +
      'Use the camera setup wizard (POST /api/cameras?path=setup-create with mode=onvif), ' +
      'which dispatches discovery and registration to your local media node.',
    );
  }

  // ── GET /api/onboarding/status ────────────────────────────────────────────
  // Returns the org's onboarding state plus the list of registered cameras.
  if (req.query.path === 'status') {
    if (req.method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res);
    if (!auth) return;

    if (!auth.organizationId) {
      return sendSuccess(res, { onboarding_completed: false, org: null, cameras: [] });
    }

    try {
      await retryOrganizationPaymentActivations({
        organizationId: auth.organizationId,
        userId: auth.userId,
        req,
      });

      const { rows: orgRows } = await db.query(
        `SELECT id, name, plan_tier, onboarding_completed, camera_limit
         FROM organizations WHERE id = $1`,
        [auth.organizationId],
      );
      const org = orgRows[0] || null;

      const { rows: cameraRows } = await db.queryAsOrg(
        auth.organizationId,
        `SELECT c.id, c.name, c.enabled, c.media_node_id,
                n.public_hls_url AS hls_base_url
         FROM cameras c
         LEFT JOIN media_nodes n ON n.id = c.media_node_id
         WHERE c.organization_id = $1
         ORDER BY c.id`,
        [auth.organizationId],
      );

      const cameras = cameraRows.map((c) => ({
        id: c.id,
        name: c.name,
        enabled: c.enabled,
        hls_url: c.hls_base_url
          ? `${c.hls_base_url.replace(/\/$/, '')}/${c.id}/index.m3u8`
          : null,
      }));

      return sendSuccess(res, {
        onboarding_completed: org?.onboarding_completed ?? false,
        org,
        cameras,
      });
    } catch (err) {
      console.error('[onboarding/status] Error:', err.message);
      return sendError(res, 500, err.message);
    }
  }

  // ── POST /api/onboarding/complete ─────────────────────────────────────────
  // Marks the org's onboarding as complete. Called when the customer clicks
  // "Go to Dashboard" at the end of the wizard.
  if (req.query.path === 'complete') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const auth = await requireAuth(req, res, { roles: ['org_admin', 'platform_admin'] });
    if (!auth) return;

    if (!auth.organizationId) {
      return sendError(res, 400, 'No organization linked to this account.');
    }

    try {
      await db.query(
        `UPDATE organizations
         SET onboarding_completed = true, updated_at = now()
         WHERE id = $1`,
        [auth.organizationId],
      );
    } catch (err) {
      console.error('[onboarding/complete] DB error:', err.message);
      return sendError(res, 500, err.message);
    }

    await logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'org.onboarding_completed',
      resourceType: 'organization',
      resourceId: auth.organizationId,
      metadata: {},
      ipAddress: getIp(req),
    });

    return sendSuccess(res, { message: 'Onboarding complete. Welcome to your dashboard.' });
  }

  return sendError(res, 404, 'Unknown onboarding path. ' +
    'Valid paths: register, connect-camera, status, complete');
};
