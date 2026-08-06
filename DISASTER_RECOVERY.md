# Disaster Recovery Plan

**Repository:** https://github.com/miletasandic7/D-D-MONITORING-2026
**Platform stack:** Vercel (API/frontend) · Neon (PostgreSQL) · Fly.io `dnd-media-server` (MediaMTX + workers) · Cloudflare Tunnel (HLS) · Media Node(s) on LAN
**Goal:** Recover the platform from any failure class with minimal downtime and **zero data loss** for tenant data.

---

## Failure classes

| Class | Blast radius | RTO target | RPO target |
|---|---|---|---|
| Media Node crash / reinstall | One node's cameras offline | < 30 min | n/a (no local state) |
| MediaMTX / Fly app crash | HLS playback down | < 15 min | n/a |
| Vercel deployment broken | API + dashboard down | < 30 min | n/a |
| Environment secret lost | Auth/DB/storage broken | < 1 h | n/a |
| Neon database loss/corruption | Everything | < 2 h | Neon PITR (configurable, default ~24 h) |
| GitHub repository loss | Source of truth | < 1 h (local clones) | n/a |

---

## 1. Database (Neon)

### Architecture notes
- Neon is the **single source of truth** for all tenant data, cameras, users, tasks, stream tokens.
- Workers (media nodes) connect **directly** to Neon via `MEDIA_NODE_DATABASE_URL` (restricted `media_node_worker` role).
- No data is stored locally on media nodes — nothing to back up there.

### Backup (automatic — verify only)
Neon provides **automatic continuous backups** with Point-in-Time Restore (PITR):

1. Log in to the Neon console → your project → **Settings → Backups**.
2. Verify:
   - **PITR retention** (recommend ≥ 7 days; adjust by plan).
   - **History retention** for time-travel restore.
3. Optional scheduled export (recommended weekly for long-term retention):
   - `pg_dump` via a cron/CI job against a **read-only branch** (never against production directly):
     ```bash
     # create a fresh branch (Neon CLI)
     neon branches create --name backup-$(date +%F)
     # dump it
     pg_dump "$NEON_BRANCH_DATABASE_URL" -F c -f backup-$(date +%F).dump
     # upload to S3/R2 object storage (retention 30/90 days)
     aws s3 cp backup-$(date +%F).dump s3://dnd-backups/db/
     ```

### Restore (two options)

**Option A — Time-travel restore (fastest, recommended for corruption/accidental delete):**
1. Neon console → **Restore → Time Travel**.
2. Pick a timestamp **before** the incident.
3. Choose *Restore to a new branch* (default — never overwrite production blindly).
4. Verify data on the branch: run the health SQL below.
5. Promote: update `DATABASE_URL` / `MEDIA_NODE_DATABASE_URL` to the restored branch (or rename it to take over the old DB).

**Option B — pg_restore from weekly dump:**
```bash
# create a fresh database/branch
createdb "$DATABASE_URL_NEW"
# restore (disable triggers during load, re-enable after)
pg_restore -d "$DATABASE_URL_NEW" --no-owner --no-privileges \
  --disable-triggers backup-YYYY-MM-DD.dump
# then run all migrations 001–031 that postdate the dump:
psql "$DATABASE_URL_NEW" -f db/migrations/03X_*.sql   # apply missing ones in order
```

### Post-restore verification checklist
```sql
-- tenants intact
SELECT count(*) FROM organizations;
-- cameras/tokens/sites intact
SELECT count(*) FROM cameras;
SELECT count(*) FROM sites;
SELECT count(*) FROM camera_stream_tokens;
-- RLS still enforced
SELECT tablename FROM pg_tables WHERE rowsecurity AND schemaname='public';
-- worker role still exists
SELECT rolname FROM pg_roles WHERE rolname='media_node_worker';
```
Then hit `GET /api/health` and confirm `database.connected: true`.

### Credential note
After any restore, confirm the following match the environment: `media_node_worker` password (`MEDIA_NODE_DATABASE_URL`), `CREDENTIAL_ENCRYPTION_KEY` (camera passwords are AES-256-GCM — **lost key = unrecoverable camera passwords**, but cameras can be re-onboarded; keep the key in a password manager).

---

## 2. Application (Vercel + GitHub)

### GitHub is the source of truth for code
- Every phase is committed atomically to `master` (see commit history: Phase 6 `9fa8f4dee6` → Phase 7 `fc7b2f91ac` → Phase 8 `19c4eb748a` → Phase 9 `71bc4c7cca` → Phase 10 `35483948cf`).
- **Local clone exists** on the development machine — even if GitHub were lost, the full tree + `.git` history is recoverable.
- Recommended: keep a second offsite clone or mirror (e.g., a bare `git clone --mirror` on another machine or a private backup storage).

### Vercel redeploy
1. Vercel automatically deploys each push to `master` (production branch).
2. Manual redeploy if needed: **Vercel dashboard → Project → Deployments → Redeploy** (latest production commit).
3. Rollback: **Deployments → (previous commit) → Promote to Production**.

### Environment variables (Vercel — must exist before restore works)
| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection (API/Better Auth) | ✅ |
| `BETTER_AUTH_SECRET` | Session signing | ✅ |
| `BETTER_AUTH_URL` | Auth callback base | ✅ |
| `APP_URL` | CORS origin / links | ✅ |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM camera credential encryption | ✅ |
| `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | Object storage (snapshots/recordings) | ✅ |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Rate limiting (optional, has defaults) | ❌ |

**Recovery procedure:** Vercel → Project → Settings → Environment Variables → re-add all values (from password manager). If any secret was lost: `BETTER_AUTH_SECRET` → regenerate, all sessions invalidate (users re-login); `CREDENTIAL_ENCRYPTION_KEY` → see §1 credential note.

---

## 3. Media Node (LAN) — reinstall & camera recovery

### What the node holds
- `C:\dnd-media\` — MediaMTX (`mediamtx.exe` + `mediamtx.yml`), `app\` (workers + lib), `.env` / `.bat` config, `cloudflared` tunnel.
- **No camera data lives on the node** — cameras are re-pulled from the database on worker start. Recovery is mostly re-installation + config restore.

### Reinstall procedure (from scratch)
1. **Reinstall runtime:** Node.js LTS (v18+) — `winget install OpenJS.NodeJS.LTS`.
2. **MediaMTX:** download `mediamtx_v*_windows_amd64.zip` from https://github.com/bluenviron/mediamtx/releases → extract to `C:\dnd-media\mediamtx\`.
3. **App files:** clone repo and copy (see `laptop/README.md` copy list):
   ```
   workers\camera-sync-worker.js
   workers\media-node-heartbeat.js
   workers\camera-setup-agent.js
   lib\_mediamtx_client.js, _onvif_client.js, _node_health.js, _crypto.js,
        _rtsp_probe.js, _camera_connectors.js, _logger.js
   laptop\app\package.json, laptop\mediamtx.yml, laptop\start-laptop.bat
   ```
4. **Config restore** (`.env` / `start-laptop.bat`):
   - `DATABASE_URL` / `MEDIA_NODE_DATABASE_URL` (restricted `media_node_worker` connection string)
   - `MEDIA_NODE_ID` (uuid from `media_nodes` table)
   - `MEDIA_NODE_HEARTBEAT_SECRET` (same value stored in DB)
   - `CREDENTIAL_ENCRYPTION_KEY` (same as Vercel)
5. **Tunnel restore:** re-authenticate cloudflared (`cloudflared tunnel login`) and recreate/restore the tunnel config + DNS record (`hls.*.com`). If the tunnel was deleted, create a new one and update `public_hls_url`/frontend `VITE_HLS_BASE_URL`.
6. **Start:** run `start-laptop.bat` and verify logs:
   ```
   [camera-sync] Starting. Interval: 60s. MEDIA_NODE_ID: <uuid>
   [camera-sync] adding path CAM-xxx -> rtsp://...
   [heartbeat] heartbeat.ok
   ```

### Camera recovery (no re-onboarding needed)
Cameras are stored in Neon with their RTSP URLs and encrypted credentials. After node reinstall:
1. Verify node is online: `SELECT id, hostname, last_heartbeat_at FROM media_nodes;`
2. `camera-sync-worker` automatically recreates all MediaMTX paths for cameras where `rtsp_url IS NOT NULL AND enabled = true AND media_node_id = <this node>`.
3. Verify playback: `GET https://<hls-domain>/CAM-xxx/index.m3u8?token=<valid>` → 200.
4. If a camera was **removed/re-added**, the unique index `uq_cameras_org_rtsp` prevents duplicates — re-register through the wizard instead of SQL.

---

## 4. Fly.io media server (MediaMTX on cloud)

### Restart / redeploy
```bash
fly status -a dnd-media-server
fly logs -a dnd-media-server | grep camera-sync
fly deploy -a dnd-media-server    # from repo root (fly.toml + media-server/Dockerfile)
fly secrets set DATABASE_URL=... MEDIA_NODE_ID=... API_BASE_URL=... \
  MEDIA_NODE_HEARTBEAT_SECRET=... -a dnd-media-server
```
### Recovery notes
- MediaMTX paths are rebuilt automatically by `camera-sync-worker` from the database (pull mode). No manual path config to restore.
- HLS port 8888 is exposed via Fly services; RTSP 8554 is intentionally internal-only.

---

## 5. Recovery runbook (ordered)

| # | Scenario | Action |
|---|---|---|
| 1 | Node offline / restarted | Restart `start-laptop.bat`; workers auto-recover; verify heartbeat |
| 2 | MediaMTX crash | Restart MediaMTX; sync worker rebuilds paths within 60 s |
| 3 | Vercel broken deploy | Rollback to previous deployment; report issue; redeploy fix |
| 4 | HLS 404 | Check MediaMTX path exists + camera `enabled`/`rtsp_url`; check tunnel DNS; token verify |
| 5 | Data corruption/delete | Neon PITR to pre-incident timestamp (Option A) |
| 6 | Full DB loss | Restore weekly dump (Option B) + replay later migrations |
| 7 | GitHub loss | Restore from local clone / mirror; re-push to new remote |

---

## 6. Backup schedule (recommended)

| Item | Frequency | Location |
|---|---|---|
| Neon PITR (automatic) | continuous | Neon |
| Weekly pg_dump export | weekly | S3/R2 (30–90 day retention) |
| GitHub code | every commit | GitHub + local clone + optional mirror |
| Env secrets | on change | password manager (Vercel/Fly/Neon/Cloudflare) |
| Tunnel config | on change | local `~/.cloudflared/` + note in README |

---

## 7. Validation test (quarterly, ~30 min)

1. Create a Neon **branch** from production.
2. Restore the latest weekly dump into it.
3. Run migration continuity test (`npm test` covers 001–031 ordering).
4. Point a staging Vercel project at the branch; confirm `/api/health` green.
5. Document the result in the validation log below.

---

## 8. Validation Log

| Date | Performed By | Test Type | Result | Notes | RTO Recorded |
|---|---|---|---|---|---|
| 2026-08-06 | System | Retention Policy Verification | ✅ Passed | Verified retention_expires_at calculation in recording-worker.js uses camera.retention_days from DB (migration 004). Default 30 days. Calculation: `endTime + (retention_days * 24 * 60 * 60 * 1000)`. Matches DB schema. | N/A |
| 2026-08-06 | System | Logging & Sentry Integration | ✅ Passed | Structured logging and Sentry error tracking integrated across all API routes, handlers, lib files, and workers. Sentry initialization module created. Sensitive data filtering configured. | N/A |
| TBD | TBD | Full DR Exercise | Pending | Schedule quarterly DR exercise per section 7 | TBD |
