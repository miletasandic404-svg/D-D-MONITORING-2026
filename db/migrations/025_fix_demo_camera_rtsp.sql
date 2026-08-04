-- Migration 025: Fix demo camera RTSP source
--
-- CAM-9ezua had an HLS (.m3u8) URL stored in rtsp_url. MediaMTX pulls the
-- path "source" over RTSP only (rtsp:// / rtsps://) -- an HTTP(S) HLS URL
-- can never be pulled, so the path always answered:
--   HTTP 404 {"error":"no stream is available on path 'CAM-9ezua'"}
--
-- This migration points the demo camera at a public RTSP test pattern
-- stream (rtsp.stream). The UPDATE is guarded: it only replaces invalid
-- values (NULL or non-rtsp(s) schemes), so it never overwrites a real
-- camera URL configured later, and is safe to re-run.
--
-- To switch this camera to a real camera later, edit it in the dashboard --
-- the API now rejects http(s) rtsp_url values.

BEGIN;

UPDATE cameras
SET rtsp_url = 'rtsp://rtsp.stream/pattern'
WHERE id = 'CAM-9ezua'
  AND (
    rtsp_url IS NULL
    OR (rtsp_url NOT LIKE 'rtsp://%' AND rtsp_url NOT LIKE 'rtsps://%')
  );

COMMIT;
