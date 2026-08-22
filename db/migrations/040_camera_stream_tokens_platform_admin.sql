-- =========================================================
-- Migration 040: Platform admin SELECT on camera_stream_tokens
--
-- Problem (P1): verify-stream-token handler (MediaMTX webhook) runs
-- with no user session and no organization context. RLS is enabled
-- on camera_stream_tokens (migration 029) but only media_node_worker
-- role has a policy. The application's default role has no SELECT
-- policy, so token verification returns 0 rows and all HLS/WebRTC
-- playback is blocked.
--
-- Fix: Add a policy that allows SELECT when app.is_platform_admin
-- is set, matching the pattern used for other platform admin access.
--
-- Only SELECT is granted. INSERT/UPDATE/DELETE require the normal
-- application path through api/camera-views.js which uses queryAsOrg().
--
-- Safe to run: idempotent.
-- =========================================================

BEGIN;

DROP POLICY IF EXISTS camera_stream_tokens_platform_admin ON camera_stream_tokens;

CREATE POLICY camera_stream_tokens_platform_admin
  ON camera_stream_tokens
  FOR SELECT
  USING (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
