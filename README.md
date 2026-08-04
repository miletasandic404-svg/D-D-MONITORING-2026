# D&D Monitoring Platform

Cloud video monitoring platform: IP cameras on your LAN are discovered and
connected **without any technical setup** (no SQL, no MediaMTX config, no
Cloudflare commands), viewed through a multi-tenant dashboard, with AI
detections, incidents, recordings and notifications.

```
IP camera (LAN) ──RTSP──▶ Desktop/Laptop media node (MediaMTX)
                              │  Cloudflare Tunnel (HTTPS)
                              ▼
        hls.dnd-monitoring.com/CAM-xxx/index.m3u8?token=...  ← dashboard (hls.js)
        │
        Vercel (API + dashboard)  ──▶  Neon (PostgreSQL, RLS multi-tenant)
```

---

## Architecture

| Component | Where | Role |
|---|---|---|
| **Dashboard + API** | Vercel (serverless, `api/`) | Auth (Better Auth), cameras/sites/incidents, billing, wizard task queue |
| **Database** | Neon (PostgreSQL) | 21 tables, RLS `tenant_isolation` on tenant data, migrations `db/migrations/001–028` |
| **Media node** | Your PC/Laptop (`laptop/`) | MediaMTX (RTSP→HLS), `camera-sync-worker`, `camera-setup-agent`, `media-node-heartbeat`, `cloudflared` tunnel |
| **Streaming** | MediaMTX + Cloudflare Tunnel | Publishes HLS publicly; every HLS request is token-checked via `/api/verify-stream-token` |

---

## Quick start (from scratch)

### 1. Database (Neon)

1. Create a Neon project and copy the **connection string** (owner role).
2. Run the migrations in order: `db/migrations/001_*.sql` → … → `028_wizard_v3_health.sql`.
   Apply 028 (Wizard V3 health + task modes):

```sql
-- db/migrations/028_wizard_v3_health.sql
BEGIN;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS mediamtx_online    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS tunnel_online      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS health_json        JSONB;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS health_checked_at  TIMESTAMPTZ;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_setup_tasks_mode_check'
             AND conrelid = 'camera_setup_tasks'::regclass) THEN
    ALTER TABLE camera_setup_tasks DROP CONSTRAINT camera_setup_tasks_mode_check;
  END IF;
END $$;
ALTER TABLE camera_setup_tasks ADD CONSTRAINT camera_setup_tasks_mode_check
  CHECK (mode IN ('scan','onvif','manual','probe','preview','cleanup','start_tunnel'));
COMMIT;
```

### 2. Deploy the API + dashboard (Vercel)

Connect the repo, add environment variables (never commit real secrets):

```
DATABASE_URL=<neon owner connection string>
BETTER_AUTH_SECRET=<long random string>
BETTER_AUTH_URL=https://www.dnd-monitoring.com
APP_URL=https://www.dnd-monitoring.com
STORAGE_BUCKET=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=...
```

Vercel deploys automatically on push to `master` (`vercel.json` maps API routes).

### 3. Media node (your PC/Laptop) — the only LAN-side component

Install once: **Git**, **Node.js LTS**, **MediaMTX** (from GitHub releases,
`mediamtx_windows_amd64.zip` → `C:\dnd-media\mediamtx\`), **cloudflared**
(`winget install cloudflare.cloudflared`).

```powershell
git clone https://github.com/miletasandic7/D-D-MONITORING-2026.git C:\dnd-monitoring-repo
mkdir C:\dnd-media\app\workers C:\dnd-media\app\lib C:\dnd-media\mediamtx C:\dnd-media\cloudflared
copy C:\dnd-monitoring-repo\laptop\mediamtx.yml            C:\dnd-media\mediamtx\
copy C:\dnd-monitoring-repo\workers\camera-sync-worker.js  C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\workers\camera-setup-agent.js  C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\workers\media-node-heartbeat.js C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\lib\_mediamtx_client.js         C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_node_health.js             C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\laptop\app\package.json        C:\dnd-media\app\
copy C:\dnd-monitoring-repo\laptop\start-laptop.bat        C:\dnd-media\
cd C:\dnd-media\app && npm install
```

Register the node (platform admin):

```sql
INSERT INTO media_nodes (region, hostname, name, public_hls_url, capacity, heartbeat_secret, last_heartbeat_at)
VALUES ('belgrade', 'DESKTOP-PC', 'Desktop Media Node', 'https://hls.dnd-monitoring.com', 10,
        '<your-secret>', now()) RETURNING id;
```

Fill the 3 values in `C:\dnd-media\start-laptop.bat` (`DATABASE_URL`,
`MEDIA_NODE_ID`, `MEDIA_NODE_HEARTBEAT_SECRET`), then double-click it.
It starts MediaMTX + camera-sync + heartbeat + the setup agent.

### 4. Cloudflare Tunnel (public HLS)

```powershell
cloudflared tunnel login
cloudflared tunnel create dnd-hls
cloudflared tunnel route dns dnd-hls hls.dnd-monitoring.com
```

Point the tunnel at the local MediaMTX HLS port (8888) with a config file and
set `CLOUDFLARE_TUNNEL_NAME`/`CLOUDFLARE_TUNNEL_CONFIG` in `start-laptop.bat`
— the wizard's **Start Tunnel** button then manages it for you.

### 5. Add your first camera — Camera Setup Wizard V3

Dashboard → **Add Camera**. That is everything a user needs to do:

1. **Auto scan** starts immediately — the LAN is scanned for ONVIF cameras
   (manufacturer, model, IP, firmware shown as cards).
2. Click a found camera (or type the IP) → enter camera username/password →
   **Test Connection & Find Streams** — the agent detects the RTSP streams.
3. Pick **Main / Sub** stream → **Connect & Preview**.
4. **Live Preview** plays (hls.js); **Save Camera** becomes enabled only when
   the video is actually playing.
5. The camera appears in the dashboard and streams through the public HLS URL.

The **health panel** inside the wizard shows in real time (10 s refresh):
🟢 Media Node online · MediaMTX online · Tunnel online · RTSP connected ·
HLS active · Token auth OK — each with a reason and a suggested fix when red.

---

## Camera Setup Wizard V3 — internals

The wizard never talks to cameras directly (Vercel is in the cloud). It pushes
a task into `camera_setup_tasks` (migration 027) that the local
`camera-setup-agent.js` executes next to MediaMTX:

| mode | what the agent does |
|---|---|
| `scan` | scans the LAN subnet for ONVIF cameras (device info per camera) |
| `probe` | discovers + tests RTSP streams of the selected camera (Main/Sub) |
| `preview` | registers the camera + MediaMTX path; the dashboard shows a live preview |
| `cleanup` | removes a camera the user cancelled before saving |
| `start_tunnel` | launches `cloudflared` on the node and re-checks the tunnel |
| `onvif` / `manual` | legacy one-shot registration (kept for API compatibility) |

Every 15 s the agent reports node health (`mediamtx_online`, `tunnel_online`,
`health_json`) onto `media_nodes` (migration 028); the dashboard reads it via
`GET /api/camera-setup/node`.

API routes (all org-scoped, Zod-validated):

```
POST /api/camera-setup                 create a setup task (any mode above)
GET  /api/camera-setup/node            best online node + live health
GET  /api/camera-setup/:id             poll task progress + node HLS base URL
GET  /api/camera-setup/tasks           recent tasks for this org
```

---

## API overview

| Endpoint | Auth | Notes |
|---|---|---|
| `/api/health` | public | DB + env + storage check |
| `/api/cameras` | user | CRUD, org-scoped (RLS + queryAsOrg) |
| `/api/camera-views` | user | mints 1 h HLS stream tokens |
| `/api/verify-stream-token` | MediaMTX webhook | token check for every HLS request |
| `/api/incidents`, `/api/events`, `/api/sites`, `/api/media-nodes` … | user/admin | full resource CRUD |
| `/api/payments/*`, `/api/paypal/*` | user/admin | billing |

## Workers

- `workers/camera-sync-worker.js` — syncs cameras → MediaMTX paths (diff-based, no reload churn)
- `workers/camera-setup-agent.js` — executes wizard tasks + node health
- `workers/media-node-heartbeat.js` — keeps the node "online" in the registry
- `workers/recording-worker.js`, `workers/retention-job.js`, `workers/pending-activation-worker.js`

## Tests

```bash
npm test        # 18 tests incl. migration continuity 001–028
cd frontend && npm run build   # production bundle
```

## Security

- Multi-tenant via PostgreSQL **RLS** (`tenant_isolation` policy on all tenant tables)
- HLS is **fail-closed**: no valid short-lived token → no stream
- CORS locked to `https://www.dnd-monitoring.com`; security headers set in `vercel.json`
- Zod validation on every API body; parametrized SQL only
- Camera credentials live briefly in `camera_setup_tasks` and are never returned by the API

## Known limitations

- The media node must be online for wizard tasks (heartbeat freshness ~90 s).
- Wizard LAN steps (scan/probe) need a real camera on the same network —
  they cannot be exercised from CI or Vercel.
- Public HLS requires a Cloudflare Tunnel (or equivalent) configured on the node.


---

## Camera onboarding — real RTSP verification (Phase 6)

- `lib/_rtsp_probe.js` — dependency-free RTSP OPTIONS/DESCRIBE handshake
  (reachability, HTTP Basic + Digest authentication, stream availability) run
  on the media node. Wrong credentials fail with HTTP 401 and the camera is
  **never saved**.
- `lib/_camera_connectors.js` — connector registry: `onvif` (primary) and
  `rtsp-common` (fallback for cameras without ONVIF, probing well-known vendor
  RTSP paths: Hikvision, Dahua, Uniview, Axis, generic).
- Manual / preview camera registration in `workers/camera-setup-agent.js`
  verifies the stream with a real handshake before inserting the camera row;
  credentials are embedded into the RTSP URL only at probe/pull time and
  stored encrypted at rest (migration 030).
- Media node copy list: include `lib/_rtsp_probe.js` and
  `lib/_camera_connectors.js` in `C:\dnd-media\app\lib\` — see
  `laptop/README.md`.
