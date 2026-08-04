# Phase 12 — Performance Testing

**Branch:** master
**Baseline commit:** `968de644b7` (Phase 11 — disaster recovery)
**Status:** 📋 Protocol ready — execution requires real hardware (media node + cameras)
**Method:** Scale test 1 → 5 → 10 → 25+ cameras; measure node resources, HLS latency, worker load, DB load.

---

## 1. Metrics available (Phase 8 `lib/_node_health.js`)

| Metric | Source | Reported in |
|---|---|---|
| CPU % | `os.cpus()` two-sample delta (`cpu_usage_percent`) | `health_json.system.cpu_usage_percent` |
| Memory (used/total) | `os.totalmem()` / `os.freemem()` | `health_json.system.memory` |
| Disk (used/free) | fs statvfs | `health_json.system.disk` |
| Uptime (node) | `os.uptime()` | `health_json.system.uptime_seconds` |
| Worker uptime | `process.uptime()` | `health_json.worker.uptime_seconds` |
| MediaMTX online | HTTP check localhost:9997 | `mediamtx_online` |
| Tunnel online | Cloudflare check | `tunnel_online` |

View on the dashboard's wizard health panel or via DB:
```sql
SELECT node_id, mediamtx_online, tunnel_online, health_checked_at, health_json
FROM media_nodes;
```

## 2. Test environment

- **Media Node:** Windows PC (specs recorded below) running `start-laptop.bat` (MediaMTX + camera-sync-worker + heartbeat + setup-agent).
- **Cameras:** real IP cameras on LAN (or demo RTSP sources for the first scale points).
- **Viewer:** 1 dashboard client playing HLS (hls.js).

## 3. Test procedure

### Scale point 1 — 1 camera (baseline)
1. Add camera via wizard; confirm `[camera-sync] adding path` log and HLS 200.
2. Record baseline metrics (table below) for **5 minutes** with playback active.
3. Measure **HLS latency** (see §4).

### Scale point 2 — 5 cameras
1. Add 4 more cameras (or duplicate demo streams with distinct URLs).
2. Wait for sync worker to add all 5 paths; verify no duplicate paths:
   ```sql
   SELECT rtsp_url, count(*) FROM cameras WHERE enabled GROUP BY rtsp_url HAVING count(*)>1;  -- expect 0 rows
   ```
3. Record metrics 5 min. Verify **no stream interruption** during sync (HLS stays 200 on all cameras).

### Scale point 3 — 10 cameras
Repeat procedure; watch CPU (MediaMTX transcode/remux is the main consumer).

### Scale point 4 — 25+ cameras (if hardware allows)
Same procedure. Record peak values.

## 4. HLS latency measurement

| Method | Steps |
|---|---|
| **Segment-based estimate** | Open `index.m3u8`, read `#EXT-X-TARGETDURATION` (typical 1–2 s in MediaMTX). Live latency ≈ segment duration × (2–3) + network. |
| **Clock-based (accurate)** | Play stream in browser; point a phone camera at the physical scene; note the wall-clock time visible on screen vs. real time. Record delta in seconds. |
| **hls.js stats** | In dashboard DevTools console: `document.querySelector('video').hls` → `latency` / `targetLatency` fields. |

## 5. Result tables

### 5.1 System metrics (fill per scale point)

| Cameras | CPU % (idle → peak) | RAM used (GB) | Disk IO | Node uptime | HLS latency (s) | Bandwidth (Mbps) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 5 | | | | | | |
| 10 | | | | | | |
| 25+ | | | | | | |

### 5.2 Reliability checks (expect ✅)

| Check | 1 | 5 | 10 | 25+ |
|---|---|---|---|---|
| All camera paths in MediaMTX (`[camera-sync] adding path` ×N) | | | | |
| No duplicate tasks (`camera_setup_tasks` count per org stable) | | | | |
| No duplicate paths in MediaMTX | | | | |
| No stream interruption during sync (HLS 200 continuous) | | | | |
| DB query time under load (`/api/cameras` < 500 ms) | | | | |
| Worker memory stable (< 300 MB) | | | | |
| Dashboard playback smooth on all cameras | | | | |

### 5.3 Database load

```sql
-- concurrent activity during test
SELECT count(*) FROM pg_stat_activity WHERE state='active';
-- task queue health (should return 0 pending after completion)
SELECT status, count(*) FROM camera_setup_tasks GROUP BY status;
```

## 6. Known expectations

- MediaMTX in **pull mode** uses low CPU per stream for RTSP→HLS when the source is H.264 (remux, not transcode). CPU jumps if transcoding is needed (H.265 sources, incompatible audio) — record which codec each camera uses.
- `camera-sync-worker` is a single timer loop (interval 60 s) — its DB load is negligible (one query per cycle). Worker count scales with **node count**, not camera count.
- HLS latency in MediaMTX is typically 1–3 s.

## 7. Pass criteria

- ✅ All scale points reachable without worker/MediaMTX crash.
- ✅ No duplicate tasks or duplicate camera registrations at any scale.
- ✅ HLS latency ≤ 5 s on LAN, ≤ 8 s over tunnel.
- ✅ Node CPU peak < 80% and RAM < 70% at the tested scale.
- ✅ `/api/cameras` stays < 500 ms under load.

## 8. Results log

| Date | Scale | Result | Notes |
|---|---|---|---|
| — | — | ⏳ pending | fill after hardware run |
