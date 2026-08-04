# PHASE 6 — HARDWARE VALIDATION PROTOKOL

> Realna provera kompletnog sistema sa pravim IP kamerama i pravim Media Node-om.
> Ova faza se izvršava na fizičkom hardveru (kamera + računar/laptop kao media node) —
> softverske karike su već validirane (Phase 6.1/6.2 + automatski testovi).

---

## 0. Preduslovi

| # | Preduslov | Provera |
|---|---|---|
| 0.1 | Media Node sinhronizovan sa master-a (uključujući Phase 6 fajlove) | `lib/_rtsp_probe.js`, `lib/_camera_connectors.js`, novi `workers/camera-setup-agent.js` u `C:\dnd-media\app\` |
| 0.2 | `.env` na nodu: `DATABASE_URL` (ili `MEDIA_NODE_DATABASE_URL` sa `media_node_worker` rolom), `MEDIA_NODE_ID`, `MEDIA_NODE_HEARTBEAT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `MEDIAMTX_API_URL=http://127.0.0.1:9997` | `[camera-setup] starting...` log |
| 0.3 | MediaMTX radi (REST na `127.0.0.1:9997`) | `curl http://127.0.0.1:9997/v3/config/global/get` |
| 0.4 | Kamera na istom LAN-u kao node, poznati IP/kredencijali | VMS/VLC veza |
| 0.5 | Node online u bazi (heartbeat < 30s) | `SELECT id, name, online FROM media_nodes;` |
| 0.6 | Demo kamera CAM-9ezua i dalje postoji (regresioni test) | `SELECT id, rtsp_url FROM cameras;` |

---

## 1. Pozitivni test — kompletan tok (srećan put)

```
Kamera (LAN) → Media Node → camera-setup-agent → ONVIF/RTSP → task queue
→ cameras INSERT → MediaMTX path → Cloudflare Tunnel → HLS → Dashboard
```

| # | Korak | Akcija | Očekivani rezultat | Verifikacija |
|---|---|---|---|---|
| 1.1 | Node online | Pokreni `start-laptop.bat` | 4 prozora (MediaMTX, camera-sync, heartbeat, camera-setup) | `[camera-setup] health: mediamtx=true` svakih 15s |
| 1.2 | Auto-scan | Dashboard → Add Camera → auto-scan | Kamera se pojavi (proizvođač/model/IP) | `SELECT id, mode, status FROM camera_setup_tasks ORDER BY created_at DESC LIMIT 5;` → `done` |
| 1.3 | Probe streamova | Izaberi kameru → Test Connection | Main/Sub stream sa `stream_available=true` | Task `result.streams[]` |
| 1.4 | Preview | Connect & Preview | Live HLS preview u wizardu | Task `preview` → `done` sa `camera_id` |
| 1.5 | Save | 💾 Save Camera | Kamera u listi, dashboard igra video | `SELECT id, name, rtsp_url, rtsp_username, rtsp_password_encrypted FROM cameras WHERE name = '<ime>';` |
| 1.6 | MediaMTX path | `curl http://127.0.0.1:9997/v3/paths/list` | `CAM-xxxxx` sa source-om | JSON sadrži putanju |
| 1.7 | HLS + token | HLS URL iz dashboard-a (`?token=...`) u novom tabu | Video igra | 200 + hls.js bez grešaka |
| 1.8 | Regresija | Demo kamera CAM-9ezua | I dalje igra | HLS URL 200 |

**Verifikacioni SQL (kopiraj u Neon editor):**
```sql
-- Kamere: URL BEZ kredencijala, password ENKRIPTOVAN
SELECT id, name, rtsp_url, rtsp_username, rtsp_password_encrypted, media_node_id, enabled
FROM cameras ORDER BY created_at DESC;

-- Taskovi: pending → working → done (nikad zaglavljeni)
SELECT id, mode, status, error, created_at, updated_at
FROM camera_setup_tasks ORDER BY created_at DESC LIMIT 10;

-- Node health
SELECT id, name, online, mediamtx_online, tunnel_online, last_heartbeat_at
FROM media_nodes;

-- Stream tokeni
SELECT camera_id, token IS NOT NULL AS has_token, expires_at
FROM camera_stream_tokens ORDER BY created_at DESC LIMIT 5;
```

---

## 2. RTSP verifikacija (Phase 6.1 — ključni testovi)

| # | Test | Akcija | Očekivani rezultat |
|---|---|---|---|
| 2.1 | **Pogrešna lozinka** | Manual RTSP: tačan URL, pogrešan password → Verify & Add | Task `failed`; poruka: `RTSP authentication failed (HTTP 401) — wrong username or password`; **kamera NIJE kreirana** |
| 2.2 | Tačna lozinka | Manual RTSP: tačan URL + kredencijali | Stream verifikovan, kamera kreirana, HLS radi |
| 2.3 | Nedostupna kamera | Kamera isključena / pogrešan IP | Task `failed`; poruka: `RTSP unreachable at <ip>:<port>` |
| 2.4 | Pogrešna putanja | `rtsp://ip:554/pogresna` | Task `failed`; poruka: `stream not available at this path (HTTP 404)` |
| 2.5 | Enkripcija | Posle 2.1/2.2 | `rtsp_password_encrypted` je šifrovan string; `rtsp_url` nema `user:pass@`; plaintext kolone u tasku su NULL posle završetka |

**Provera da kamera nije sačuvana posle neuspeha:**
```sql
SELECT count(*) AS created_by_mistake
FROM cameras WHERE name = '<ime iz 2.1>';
-- očekivano: 0
```

---

## 3. RTSP fallback — kamera BEZ ONVIF-a (Phase 6.2)

| # | Test | Akcija | Očekivani rezultat |
|---|---|---|---|
| 3.1 | ONVIF nedostupan | ONVIF port zatvoren na kameri (ili kamera bez ONVIF-a) | Probe task se završi `done`; log: `ONVIF probe failed ... trying common RTSP paths`; streams iz fallback-a |
| 3.2 | Fallback pronalazi stream | Kamera sa Hikvision/Dahua putanjom | Main stream (`/Streaming/Channels/101` ili `/cam/realmonitor...`) sa `stream_available=true` |
| 3.3 | Ručni RTSP URL | Manual tab: IP + kredencijali, bez ONVIF | Kamera dodata preko verifikovanog preview task-a |
| 3.4 | ONVIF i dalje radi | Kamera SA ONVIF-om | Potpun discovery (proizvođač/model), `onvif_supported=true` — bez regresije |
| 3.5 | Bez duplikata | Ista kamera dodata dva puta | (Phase 7 dodaje eksplicitnu zaštitu; do tada — ručno proveriti da nema duplih redova) |

---

## 4. Failure testovi

| # | Test | Akcija | Očekivano ponašanje sistema |
|---|---|---|---|
| 4.1 | **Media Node restart** | `taskkill /IM node.exe /F` pa `start-laptop.bat` | Sva 4 procesa se podignu; heartbeat nastavi; kamere se re-registruju u MediaMTX < 60s (camera-sync) |
| 4.2 | **MediaMTX restart** | Ubiti samo `mediamtx.exe`, ponovo ga pokrenuti | Agent/workeri prežive; putanje se re-registruju; HLS se vrati |
| 4.3 | **Worker restart** | Ubiti samo `camera-sync-worker` ili `camera-setup-agent` | Nema duplih putanja (idempotentno); drugi workeri nastavljaju |
| 4.4 | **Kamera isključena** | Isključiti kameru dok streama | Dashboard pokazuje offline/loading, bez crash-a; HLS vraća 404/401 umesto hang-a |
| 4.5 | **Kamera ponovo uključena** | Uključiti kameru | Stream se vrati (MediaMTX `sourceOnDemand`); bez ručne intervencije |
| 4.6 | **Mrežni prekid** | Isključiti Wi-Fi/LAN na nodu 60s | Heartbeat prestane → node `online=false`; posle povratka sve se oporavi samo |
| 4.7 | **Pogrešan token** | HLS URL sa nepostojećim `?token=` | 401 — token verifikacija odbija |
| 4.8 | **Istekao token** | Token sa prošlim `expires_at` | 401 — odbijen |

---

## 5. Sigurnosna provera (uz hardware test)

- [ ] `rtsp_url` kolona nigde ne sadrži `user:pass@` (SELECT sa LIKE `%@%` na `rtsp_url`)
- [ ] Logovi noda (`[camera-setup]`) ne sadrže lozinke ni tokene
- [ ] MediaMTX REST (`:9997`) nije dostupan sa interneta (samo localhost)
- [ ] `authHTTPExclude` u `mediamtx.yml` izuzima samo publish/api/metrics (ne i read)
- [ ] Token bez sesije → 401; token ispravan → 200

```sql
-- Provera da nigde nema URL-a sa kredencijalima
SELECT id, rtsp_url FROM cameras
WHERE rtsp_url ~ 'rtsp://[^/@]+@';
-- očekivano: 0 redova
```

---

## 6. Rezultati (popuniti posle izvršenja)

| Test | Rezultat (PASS/FAIL) | Napomena / dokaz |
|---|---|---|
| 1.1 Node online | | |
| 1.2 Auto-scan | | |
| 1.3 Probe | | |
| 1.4 Preview | | |
| 1.5 Save | | |
| 1.6 MediaMTX path | | |
| 1.7 HLS + token | | |
| 1.8 Regresija demo kamere | | |
| 2.1 Pogrešna lozinka | | |
| 2.2 Tačna lozinka | | |
| 2.3 Nedostupna kamera | | |
| 2.5 Enkripcija | | |
| 3.1 ONVIF pad → fallback | | |
| 3.4 ONVIF i dalje radi | | |
| 4.1 Node restart | | |
| 4.2 MediaMTX restart | | |
| 4.3 Worker restart | | |
| 4.4 Kamera offline | | |
| 4.6 Mrežni prekid | | |
| 4.7/4.8 Token 401 | | |

**Problemi pronađeni:** _(navedi svaki — log, snimak ekrana, SQL izlaz)_

**Fix-evi primenjeni:** _(navedi commit hash za svaki)_

---

## 7. Kriterijum prolaza

Phase 6.3 se smatra **PASS** kada:
1. Kompletan tok (1.1 → 1.8) radi sa pravom kamerom.
2. Pogrešna lozinka **ne** kreira kameru (2.1) i poruka je jasna.
3. Kamera bez ONVIF-a može da se doda (3.1–3.3).
4. Svi failure testovi (4.x) se oporave bez ručne intervencije i bez duplikata.
5. Nema curenja kredencijala (5.x).
