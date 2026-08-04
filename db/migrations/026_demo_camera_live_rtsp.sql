-- Migration 026: Point demo camera at a live public RTSP source
--
-- 025 pointed CAM-9ezua at rtsp://rtsp.stream/pattern, which does not emit
-- a stream. MediaMTX still created the path (the 404 changed from a bare
-- 404 to {"error":"no stream is available on path 'CAM-9ezua'"}), but every
-- pull attempt failed, so index.m3u8 kept answering 404.
--
-- This migration switches the demo camera to the Wowza public test stream
-- (Big Buck Bunny, MP4-over-RTSP), a long-running reliable public RTSP
-- source. Unlike 025, the guard is EXACT-match on the dead URL, so this can
-- never overwrite a real camera URL configured later, and is safe to re-run
-- (a second run matches 0 rows).
--
-- After this runs, camera-sync-worker picks up the change within
-- CAMERA_SYNC_INTERVAL_SECONDS (60s), updates the MediaMTX path source, and
-- the first HLS request (with a valid ?token=) triggers the sourceOnDemand
-- pull (up to 10s) and should return HTTP 200.
--
-- If wowzaec2demo ever stops, swap in an alternative public RTSP source,
-- e.g. rtsp://stream.live555.com/live/1

BEGIN;

UPDATE cameras
SET rtsp_url = 'rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov'
WHERE id = 'CAM-9ezua'
  AND rtsp_url = 'rtsp://rtsp.stream/pattern';

COMMIT;
