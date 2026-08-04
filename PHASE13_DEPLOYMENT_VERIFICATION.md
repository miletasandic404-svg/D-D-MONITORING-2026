# Phase 13 — Production Deployment Verification

**Branch:** master
**Baseline commit:** `95d956d747` (Phase 12 — performance testing protocol)
**Status:** 📋 Checklist ready — execution requires production credentials + hardware
**Goal:** Verify every environment variable, every infrastructure piece, and the complete smoke test before final acceptance.

---

## 1. Environment variables

### 1.1 Vercel (production) — verify presence only, never paste values

| Variable | Required | Present | Verified by |
|---|---|---|---|
| `DATABASE_URL` | ✅ | ☐ | Vercel → Project → Settings → Environment Variables |
| `BETTER_AUTH_SECRET` | ✅ | ☐ | same |
| `BETTER_AUTH_URL` | ✅ | ☐ | same |
| `APP_URL` | ✅ | ☐ | same |
| `CREDENTIAL_ENCRYPTION_KEY` | ✅ | ☐ | same — **must equal media node value** |
| `STORAGE_BUCKET` | ✅ | ☐ | same |
| `STORAGE_ACCESS_KEY_ID` | ✅ | ☐ | same |
| `STORAGE_SECRET_ACCESS_KEY` | ✅ | ☐ | same |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | optional | ☐ | same |

### 1.2 Fly.io (`dnd-media-server`)

```bash
fly secrets list -a dnd-media-server   # names only
```
| Variable | Required | Present |
|---|---|---|
| `DATABASE_URL` | ✅ | ☐ |
| `MEDIA_NODE_ID` | ✅ | ☐ |
| `API_BASE_URL` | ✅ | ☐ |
| `MEDIA_NODE_HEARTBEAT_SECRET` | ✅ | ☐ |

### 1.3 Media Node (LAN, `C:\dnd-media\.env` / `start-laptop.bat`)

| Variable | Required | Present | Must equal |
|---|---|---|---|
| `MEDIA_NODE_DATABASE_URL` (or `DATABASE_URL`) | ✅ | ☐ | Neon, restricted `media_node_worker` role |
| `MEDIA_NODE_ID` | ✅ | ☐ | uuid in `media_nodes` table |
| `MEDIA_NODE_HEARTBEAT_SECRET` | ✅ | ☐ | value stored in DB |
| `CREDENTIAL_ENCRYPTION_KEY` | ✅ | ☐ | **exact same as Vercel** |
| `CAMERA_SYNC_INTERVAL_SECONDS` | optional | ☐ | default 60 |
| `MEDIAMTX_API_URL` / user / pass | ✅ | ☐ | localhost:9997 (loopback only) |

### 1.4 Rotation & storage checks
- ☐ `media_node_worker` DB password **rotated** since migration 029 default (`change-me-in-production`).
- ☐ All secrets stored in a password manager; no secret in any committed file (`.env*` gitignored).
- ☐ No development secrets (local keys, test tokens) present in production env.

---

## 2. Infrastructure

| Piece | Verify | Command / location |
|---|---|---|
| Vercel | latest production deployment green | Dashboard → Deployments |
| Neon | connected, pooler URL | `GET /api/health` → `database.connected: true` |
| Fly media server | running, no crash loop | `fly status -a dnd-media-server` |
| MediaMTX | online, paths present | dashboard health panel / `mediamtx_online` |
| Cloudflare Tunnel | up, DNS points to HLS | `cloudflared tunnel list`; `curl -I https://<hls-domain>/` |
| Media Node | online, recent heartbeat | `SELECT hostname, last_heartbeat_at FROM media_nodes;` |

---

## 3. Smoke test (complete flow)

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | User registration (new email) | 201, user created | ☐ |
| 2 | Organization creation | org created, user bound | ☐ |
| 3 | Invite/add second user (operator) | invite sent, role set | ☐ |
| 4 | Add camera via **wizard** | scan → select → creds → preview → save | ☐ |
| 5 | Camera appears in dashboard | list shows new camera | ☐ |
| 6 | Live playback | HLS 200 + video renders < 10 s | ☐ |
| 7 | Wrong camera password | wizard fails with clear 401, **camera not saved** | ☐ |
| 8 | Duplicate camera URL | 409 "already exists" | ☐ |
| 9 | Stream token invalid | 403, no playback | ☐ |
| 10 | Logout → deep link to protected page | redirect to /auth?returnTo=... | ☐ |

### Multi-tenant isolation (RLS)
| # | Step | Expected | Result |
|---|---|---|---|
| 11 | Org A user requests Org B camera | 403/404, no data leak | ☐ |
| 12 | `queryAsOrg` org scoping on /api/cameras, /api/events | only own rows | ☐ |

### Recovery scenarios
| # | Scenario | Expected | Result |
|---|---|---|---|
| 13 | Restart media node | workers auto-recover, cameras back < 2 min | ☐ |
| 14 | Restart MediaMTX | sync worker rebuilds paths < 60 s | ☐ |
| 15 | Camera disconnect/reconnect | dashboard shows camera, playback resumes | ☐ |

---

## 4. Verification commands

```bash
# health (public, no auth)
curl -s https://www.dnd-monitoring.com/api/health

# HLS with valid token (expect 200)
curl -s -o /dev/null -w '%{http_code}' \
  "https://<hls-domain>/<CAMERA_ID>/index.m3u8?token=<valid>"

# HLS with invalid token (expect 403)
curl -s -o /dev/null -w '%{http_code}' \
  "https://<hls-domain>/<CAMERA_ID>/index.m3u8?token=deadbeef"

# DB: node heartbeat fresh
SELECT node_id, last_heartbeat_at, mediamtx_online, tunnel_online
FROM media_nodes ORDER BY last_heartbeat_at DESC;
```

---

## 5. Sign-off

All environment variables present: ☐  ·  Infrastructure green: ☐  ·  Smoke test 1–15 passed: ☐

**Result:** READY FOR FINAL ACCEPTANCE (Phase 14) / issues found (list below):
