# LAPTOP MEDIA NODE — Windows 11 (V2 worker, dynamic paths)

**Cilj:** Pretvoriti Windows 11 laptop (na ISTOJ LAN mreži kao kamera) u prvi
media node platforme. Laptop pokreće **MediaMTX** (RTSP → HLS) + **camera-sync-worker**
(čita `cameras` tabelu iz Neon-a i dinamički dodaje putanje) + **heartbeat**
(održava node "online" u `media_nodes` registru).

> Zašto laptop a ne cloud: ONVIF discovery i RTSP pull rade samo ako media server
> fizički može da dođe do kamere. `192.168.1.16` je privatna adresa vaše LAN mreže
> — Vercel i Fly (cloud) ne mogu da je dosegnu. Laptop na istoj mreži može.

---

## Arhitektura

```
┌─────────────┐   RTSP (LAN)   ┌───────────────────────┐
│  Kamera      │──────────────▶│  LAPTOP (Win 11)      │
│  192.168.1.16│ rtsp://admin@ │  ├─ MediaMTX :8888    │──HLS (HTTPS)──▶ Dashboard
└─────────────┘   :554/...     │  │   (RTSP→HLS)       │   (hls.js sa tokenom)
                               │  ├─ camera-sync-worker│──▶ Neon DB (čita cameras)
                               │  ├─ media-node-heart. │──▶ /api/media-nodes/heartbeat
                               │  └─ REST API :9997    │   (samo lokalno!)
                               └───────────────────────┘
```

- **HLS ka browseru** ide preko **Tailscale HTTPS** (ili Cloudflare Tunnel) —
  dashboard je `https://www.dnd-monitoring.com`, pa HLS takođe mora biti HTTPS
  (mixed-content pravilo browsera).
- **Port 9997 (MediaMTX REST API) ostaje lokalni** (`127.0.0.1`) — ne otvarati
  ga na internetu (bezbednosna odluka kao i na Fly-u).
- **Token auth ostaje**: svaki HLS `read` zahtev MediaMTX proverava na
  `https://www.dnd-monitoring.com/api/verify-stream-token`.

---

## 1. Struktura foldera

Kreirajte `C:\dnd-media` i rasporedite ovako:

```
C:\dnd-media\
├── mediamtx\
│   ├── mediamtx.exe          (download, korak 2)
│   └── mediamtx.yml          (iz ovog foldera)
├── app\                      (iz ovog repo-a)
│   ├── package.json
│   ├── node_modules\         (npm install)
│   ├── workers\
│   │   ├── camera-sync-worker.js
│   │   └── media-node-heartbeat.js
│   └── lib\
│       └── _mediamtx_client.js
├── .env                       (opciono — varijable se mogu postaviti i u .bat)
└── start-laptop.bat
```

Najbrži put do `app\`: klonirajte repo pa kopirajte:

```powershell
git clone https://github.com/miletasandic7/D-D-MONITORING-2026.git C:\dnd-monitoring-repo
mkdir C:\dnd-media\app
copy C:\dnd-monitoring-repo\workers\camera-sync-worker.js        C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\workers\media-node-heartbeat.js      C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\workers\camera-setup-agent.js        C:\dnd-media\app\workers\
copy C:\dnd-monitoring-repo\lib\_mediamtx_client.js              C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_onvif_client.js                 C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_node_health.js                C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_crypto.js                     C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_rtsp_probe.js                 C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\lib\_camera_connectors.js          C:\dnd-media\app\lib\
copy C:\dnd-monitoring-repo\laptop\app\package.json              C:\dnd-media\app\
copy C:\dnd-monitoring-repo\laptop\mediamtx.yml                  C:\dnd-media\mediamtx\
copy C:\dnd-monitoring-repo\laptop\start-laptop.bat              C:\dnd-media\
```

---

## 2. Instalacija softvera (jednom)

| Softver | Kako | Provera |
|---|---|---|
| Git | `winget install --id Git.Git -e` | `git --version` |
| Node.js LTS | `winget install OpenJS.NodeJS.LTS` | `node --version` (v20+) |
| MediaMTX | download `mediamtx_v*_windows_amd64.zip` sa https://github.com/bluenviron/mediamtx/releases → raspakovati u `C:\dnd-media\mediamtx\` | `mediamtx.exe --version` |
| Tailscale | https://tailscale.com/download/windows ili `winget install Tailscale.Tailscale` | `tailscale status` |
| FFmpeg (opciono, za dijagnostiku) | https://ffmpeg.org/download.html → `ffmpeg -version` | — |

Instalirajte Node zavisnosti worker-a (samo `pg`):

```powershell
cd C:\dnd-media\app
npm install
```

---

## 3. Registracija media node-a (JEDNOM, pre prvog pokretanja)

### Opcija A — preko Neon SQL editora (preporučeno)

```sql
INSERT INTO media_nodes (region, hostname, name, public_hls_url, capacity, heartbeat_secret, last_heartbeat_at)
VALUES (
  'belgrade',
  '<IME-LAPTOPA>',
  'Laptop Media Node',
  'https://<ime-laptopa>.<tvoj-tailnet>.ts.net',   -- korak 4 (Tailscale) ili Cloudflare URL
  10,
  '<TVOJ-TAJNI-SECRET>',                            -- isti string kasnije u .bat / .env
  now()
)
RETURNING id, heartbeat_secret;
```

- `heartbeat_secret` izmislite sami (npr. `openssl rand -hex 24` u Git Bash-u,
  ili `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))`
  u PowerShell-u). **Zapišite ga** — treba vam na laptopu.
- `last_heartbeat_at = now()` čini node odmah "online", pa `pickMediaNodeForCamera()`
  može da dodeli nove kamere ovom nodu.

### Opcija B — preko API-ja (platform_admin, iz aplikacije)

```
POST https://www.dnd-monitoring.com/api/media-nodes
{ "region": "belgrade", "hostname": "<ime-laptopa>", "public_hls_url": "https://...", "capacity": 10 }
```
Odgovor vraća `node.id` i `heartbeat_secret` (prikazan samo jednom).

---

## 4. Javni HTTPS za HLS (izbor jedne opcije)

### Opcija A — Tailscale (preporučeno: privatno, šifrovano, bez izlaganja)

1. Prijavite se u Tailscale na laptopu: `tailscale up`
2. U admin konzoli Tailscale-a omogućite **HTTPS Certificates** (Enable HTTPS).
3. Prosledite MediaMTX na HTTPS:
   ```powershell
   tailscale serve --bg http://localhost:8888
   tailscale status   # zapamtite ime mašine, npr. laptop-abc123
   ```
4. `public_hls_url` iz koraka 3 = `https://laptop-abc123.<tailnet>.ts.net`

> Pogledači dashboard-a takođe moraju imati Tailscale (DNS + ruta) da bi
> browser stigao do HLS-a. Za sada ste samo vi — idealno.

### Opcija B — Cloudflare Tunnel (javno, bez klijenta na gledaocima) — PREPORUČENO

```powershell
# 1. Instalacija
winget install cloudflare.cloudflared

# 2. Prijava + named tunnel (JEDNOM)
cloudflared tunnel login
cloudflared tunnel create dnd-hls
#    -> zapamtite Tunnel ID (UUID) koji komanda vrati

# 3. DNS ruta (JEDNOM): hls.dnd-monitoring.com -> tunnel
cloudflared tunnel route dns dnd-hls hls.dnd-monitoring.com

# 4. Konfiguracija: kreirajte C:\dnd-media\tunnel.yml
#    tunnel: <TUNNEL-ID-UUID>
#    credentials-file: C:\Users\<ti>\.cloudflared\<TUNNEL-ID-UUID>.json
#    ingress:
#      - hostname: hls.dnd-monitoring.com
#        service: http://localhost:8888
#      - service: http_status:404

# 5. Pokretanje (dodati u start-desktop.bat, posle MediaMTX-a):
cloudflared tunnel --config C:\dnd-media\tunnel.yml run dnd-hls
```

4. `public_hls_url` = `https://hls.dnd-monitoring.com`
5. Sadržaj je i dalje zaštićen token auth-om (verify-stream-token) — tunnel samo
   prosleđuje HTTPS; auth radi MediaMTX preko `/api/verify-stream-token`.

---

## 4.5 Camera Setup Wizard (V2) — dodavanje kamere iz dashboard-a

Od sada se kamera dodaje **isključivo iz dashboard-a** (dugme "Add New Camera"
→ wizard), bez SQL-a i bez ručnog podešavanja MediaMTX-a:

1. **Auto-discover** — wizard traži od ovog noda da skenira LAN (ONVIF) i
   prikaže pronađene kamere; ili unesite IP ručno.
2. **Connect & Register** — unesete korisničko ime/lozinku (ONVIF) ili RTSP URL.
3. `camera-setup-agent` (novi worker, pokreće ga `start-laptop.bat`) izvršava:
   ONVIF discovery → pronalazak RTSP URL-a → test konekcije → upis kamere u bazu
   (dodeljuje je samom sebi kao media node) → registracija putanje u MediaMTX-u.
4. Wizard prikazuje napredak i **Live Preview** kad je kamera spremna.

Uslov: ovaj node mora biti online (heartbeat < 90s) da bi wizard radio —
vraća jasan 409 "No online media node" ako nije.

## 5. Konfiguracija i pokretanje

Otvori `start-laptop.bat` i popuni **tri stvari**:
`DATABASE_URL` (isti Neon connection string kao na Vercelu/Fly-u),
`MEDIA_NODE_ID` i `MEDIA_NODE_HEARTBEAT_SECRET` (iz koraka 3).

Zatim:

```powershell
cd C:\dnd-media
start-laptop.bat
```

Očekivani logovi u 3 prozora:

```
[camera-sync] Starting. Interval: 60s. MEDIA_NODE_ID: <uuid> (syncing all cameras)
[camera-sync] Full sync complete in ...ms: 0 added/updated, 1 already correct ...
[heartbeat] ok (2026-08-02T...)
```

Za automatsko pokretanje pri boot-u kasnije: Windows Task Scheduler ili NSSM
(mediamtx.exe + 2× node kao servisi).

---

## 6. Pronalaženje RTSP URL-a kamere (sa laptopa, na LAN-u)

Discovery kroz platformu **ne radi sa clouda** — ali sa laptopa imate sve alate:

```powershell
# Koji portovi su otvoreni na kameri?
nmap -p 80,554,8899,8000,8080 192.168.1.16
```

Najčešći RTSP putanje po proizvođaču (zamenite `user:pass` i `ip`):

| Proizvođač | RTSP URL |
|---|---|
| Hikvision | `rtsp://user:pass@ip:554/Streaming/Channels/101` |
| Dahua | `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0` |
| Reolink | `rtsp://user:pass@ip:554/h264Preview_01_main` |
| Uniview | `rtsp://user:pass@ip:554/unicast/c1/s0/live` |
| Generičko | `rtsp://user:pass@ip:554/stream1` ili `.../live/ch0` |

Brza provera sa VLC-om: **Media → Open Network Stream →** `rtsp://admin:...@192.168.1.16:554/...`

> Ako ne znate tačan URL, najbrže je instalirati **ONVIF Device Manager** na
> laptop — on pronađe kameru na LAN-u i prikaže sve njene RTSP stream URI-jeve.
> (ONVIF port je često 80/8000/8080, ne 8899 — 8899 je verovatno RTSP port.)

---

## 7. Dodavanje kamere u dashboard

1. U dashboard-u: **Add New Camera → ✏️ Manual (RTSP)**.
2. Naziv: npr. "Kućna kamera". **RTSP URL**: `rtsp://admin:...@192.168.1.16:554/...` (iz koraka 6).
3. Sačekajte do 60s (worker ciklus) — kameru će automatski dobiti laptop node
   (jedini online node), a MediaMTX na laptopu će povući stream.

Ako je kamera dodata pre nego što je node postao "online", dodelite je ručno:

```sql
UPDATE cameras
SET media_node_id = '<node-id-iz-koraka-3>'
WHERE id = '<camera-id>';
```

---

## 8. Verifikacija

```powershell
# 1. MediaMTX REST API (lokalno)
curl http://127.0.0.1:9997/v3/config/global/get

# 2. Putanja postoji i streamuje (lokalno, bez auth-a)
curl -I http://127.0.0.1:8888/<camera-id>/index.m3u8
#    očekivano: 200 OK (Content-Type: application/vnd.apple.mpegurl)

# 3. Preko javnog URL-a SA tokenom (token dobijete iz /api/camera-views)
curl -I "https://<ime-laptopa>.<tailnet>.ts.net/<camera-id>/index.m3u8?token=<token>"
#    očekivano: 200

# 4. Heartbeat radi
#    log: [heartbeat] ok

# 5. Node online u registru
#    GET /api/media-nodes (platform_admin) → online: true
```

U dashboard-u kliknite kameru — video bi trebalo da se pojavi (prvi zahtev
može trajati ~10s dok MediaMTX povuče izvor: `sourceOnDemand`).

---

## 9. Troubleshooting

| Simptom | Uzrok | Rešenje |
|---|---|---|
| `401` na HLS | Token nevažeći/istekao | Novi token preko `/api/camera-views`; proveriti sat na serveru |
| `404 no stream is available` | Putanja nema aktivni izvor | `curl http://127.0.0.1:8888/...` — ako i lokalno 404, RTSP URL je pogrešan ili kamera ne dozvoljava pull |
| Worker ne vidi kameru | `enabled=false` ili `rtsp_url` NULL | Uključiti kameru / postaviti RTSP URL; proveriti `SELECT id, rtsp_url, enabled, media_node_id FROM cameras;` |
| `[camera-sync] Failed to read cameras` | Pogrešan `DATABASE_URL` ili rola bez pristupa | Koristiti isti Neon connection string kao Vercel (owner rola — RLS bypass radi) |
| Mixed content (HLS blokiran) | `public_hls_url` je `http://` | Koristiti Tailscale HTTPS ili Cloudflare Tunnel |
| Heartbeat `rejected: HTTP 401` | Pogrešan `MEDIA_NODE_ID`/secret | Proveriti SQL iz koraka 3 |

---

## 10. Bezbednosne napomene

- **Port 9997 nikad ne izlagati** — samo `127.0.0.1` (worker ga koristi lokalno).
- **Port 8888 ne otvarati na internetu** direktno — HLS ide kroz Tailscale/Tunnel.
- `hlsAllowOrigin: 'https://www.dnd-monitoring.com'` ostaje — samo dashboard može da čita.
- Svaki HLS read prolazi kroz `verify-stream-token` (fail-closed).
- Ako kasnije dodajete još nodova: svaki node ima svoj `MEDIA_NODE_ID`; na Fly-u
  postavite `MEDIA_NODE_ID` (i registrujte Fly kao node) da se worker-i ne preklapaju.

---

## 11. (Opcionalno) Razdvajanje Fly i laptop noda

Trenutno Fly worker sinhronizuje **sve** kamere (`MEDIA_NODE_ID` nije postavljen).
Da laptop i Fly ne rade dupli sync:

1. Registrujte Fly kao node (`public_hls_url: https://dnd-media-server.fly.dev`).
2. `fly secrets set MEDIA_NODE_ID="<fly-node-id>" -a dnd-media-server`
3. Dodelite kamerama nodove (SQL `UPDATE cameras SET media_node_id=...`).
---

## 12. Dokaz kompletnog HLS pipeline-a (test kamera, bez prave kamere)

Pre nego što uključite pravu kameru, dokažite da je lanac
baza → worker → MediaMTX → HLS → token auth → dashboard živ. Demo kamera
`CAM-9ezua` je migracijom 026 prebačena na javni test izvor (Wowza Big Buck
Bunny). Očekivano ponašanje:

1. **SQL** — u Neon editoru izvršite migraciju 026 (UPDATE `cameras.rtsp_url`).
2. **Worker** — to pokupi u roku od 60s; u logovima (`fly logs -a dnd-media-server`)
   vidite:
   ```
   [camera-sync] syncing camera CAM-9ezua (rtsp_url=rtsp://wowzaec2demo...)
   [camera-sync] adding path CAM-9ezua -> rtsp://wowzaec2demo...
   [camera-sync] MediaMTX response for CAM-9ezua: HTTP 200
   ```
3. **Token** — otvorite dashboard → Live Streams → kliknite demo kameru
   (frontend sam uzima token preko `/api/camera-views`). Token možete videti u
   DevTools → Network → zahtev za `index.m3u8`.
4. **Test** (sa tokenom iz koraka 3):
   ```powershell
   curl -I "https://dnd-media-server.fly.dev/CAM-9ezua/index.m3u8?token=<TOKEN>"
   # očekivano: HTTP 200, Content-Type: application/vnd.apple.mpegurl
   # (prvi zahtev do ~10s — sourceOnDemand povlači izvor)
   ```
5. **Dashboard** — u Live Streams se pojavljuje video.

Ako i dalje dobijate 404 `no stream is available`, izvor je nedostupan iz Fly-a:
```powershell
ffprobe -rtsp_transport tcp -i rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov -t 5 -show_streams
```
(ako ffprobe sa desktopa prolazi, a Fly ne, reč je o Fly→izvor konekciji).


---

## 4.7 Camera Setup Wizard V3 (One-Click Setup)

Od verzije V3 dashboard nudi potpuno automatski tok dodavanja kamere:

1. **Add Camera** → automatski se pokreće skeniranje lokalne mreže (ONVIF).
2. Prikažu se pronađene kamere (proizvođač, model, IP, firmware) — ili ručni unos IP-a.
3. Uneseš korisničko ime i lozinku kamere → **Test Connection & Find Streams** — agent
   automatski pronalazi RTSP streamove (Main/Sub) i testira ih.
4. Izabereš stream → **Connect & Preview** — agent registruje kameru, kreira MediaMTX
   putanju i prikaže **Live Preview** direktno u čarobnjaku.
5. Tek kada video počne da se reprodukuje omogućeno je **Save Camera**.

Health panel unutar čarobnjaka prikazuje: Media Node online, MediaMTX online,
Tunnel online, RTSP connected, HLS active i Token auth OK — sa objašnjenjem i
predlogom rešenja za svaku stavku koja nije zelena.

### Start Tunnel (auto-cloud)

Ako node nema aktivan Cloudflare Tunnel, u health panelu se pojavi dugme
**Start Tunnel** koje agentu šalje `start_tunnel` zadatak — agent pokreće
`cloudflared` (zahteva `CLOUDFLARE_TUNNEL_NAME` ili `CLOUDFLARE_TUNNEL_CONFIG`
u `.env`, i jednokratno `cloudflared tunnel login` na nodu).

### Novi agent zadaci (migracija 028)

| mode | opis |
|---|---|
| `scan` | skenira LAN za ONVIF kamere (proizvođač/model/IP/firmware) |
| `probe` | pronalazi i testira RTSP streamove izabrane kamere |
| `preview` | registruje kameru + MediaMTX putanju i vraća je za Live Preview |
| `cleanup` | uklanja kameru koju je korisnik odustao da sačuva |
| `start_tunnel` | pokreće cloudflared na nodu |

Agent takođe svakih 15s izveštava health (`mediamtx_online`, `tunnel_online`)
u `media_nodes.health_json` (migracija 028) — to je izvor za health panel.
