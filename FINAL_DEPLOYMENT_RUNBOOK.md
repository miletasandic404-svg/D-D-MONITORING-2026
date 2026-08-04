# Final Deployment Runbook — Media Server V2

## Šta je ovo

Runbook za deploy `feat/media-server-v2-real` grane, i troubleshooting
vodič za najčešće otkaze. Pretpostavlja da je `MIGRATION_CHECKLIST.md`
već odrađen (ovaj fajl se fokusira na operativni deo — šta raditi kad
nešto ne radi, ne na inicijalnu instalaciju).

## Preduslovi

- Fly.io CLI (`flyctl`) instaliran i ulogovan (`fly auth login`)
- Pristup Neon `DATABASE_URL`-u sa dozvolom za SELECT nad `cameras` i
  `media_nodes` tabelama
- Ovaj repo klomiran lokalno, na `feat/media-server-v2-real` grani

## Deploy (kratka verzija — puna verzija u `media-server/DEPLOYMENT.md`)

```bash
git checkout feat/media-server-v2-real
fly secrets set DATABASE_URL="..." -a dnd-media-server
fly deploy
fly logs -a dnd-media-server
```

## Troubleshooting stablo odluka

### Simptom: `fly deploy` ne uspeva (build greška)

- Proveri da li se build pokreće iz **root-a** repozitorijuma (fly.toml
  mora biti tu, ne u `media-server/`) — build kontekst mora obuhvatiti
  `workers/` i `lib/_mediamtx_client.js`.
- `Dockerfile` koristi multi-stage build (`bluenviron/mediamtx:latest`
  + `node:20-alpine`) — proveri da Fly build agent ima pristup Docker
  Hub-u (retko, ali moguće u restriktivnim mrežama).

### Simptom: mašina se pokrene, ali odmah pada (restart loop)

```bash
fly logs -a dnd-media-server
```

- Ako piše `GRESKA: MediaMTX API nije odgovorio u 30s` — MediaMTX se
  nije uspešno pokrenuo. Proveri da `media-server/mediamtx.yml` ima
  validan YAML (`api: yes`, `apiAddress: :9997` moraju biti prisutni).
- Ako piše `DATABASE_URL is not set` — secret nije podešen ili nije
  propagiran; `fly secrets list -a dnd-media-server` da proveriš.
- Ako piše `Failed to read cameras from database` sa SQL greškom tipa
  `column "..." does not exist` — stvarna šema `cameras` tabele se
  razlikuje od onoga što `camera-sync-worker.js` očekuje. Ovo je isti
  obrazac problema koji je već više puta pronađen u ovom projektu
  (migracije ≠ stvarna produkcija) — proveri `information_schema.columns`
  pre nego što menjaš kod naslepo.

### Simptom: kamera postoji u bazi, ali stream i dalje 404

Redosled provere (od najverovatnijeg ka najmanje verovatnom, na
osnovu prethodne runtime revizije ovog sistema):

1. **Da li worker uopšte vidi tu kameru:**
   ```bash
   fly ssh console -a dnd-media-server
   curl -s http://127.0.0.1:9997/v3/paths/get/<camera-id>
   ```
   Ako `404` — kamera nije u MediaMTX-u. Proveri da li `enabled = true`
   i `rtsp_url IS NOT NULL` u bazi (worker ih namerno preskače ako
   nisu).
2. **Da li je RTSP izvor uopšte dostupan sa media servera:**
   ```bash
   ffprobe "<rtsp_url iz baze>"
   ```
   Ako ovo ne uspe sa media servera, MediaMTX nikad neće uspeti da se
   konektuje bez obzira na sinhronizaciju sa bazom — proveri mrežnu
   dostupnost kamere (VPN, firewall, IP adresa).
3. **Da li je `sourceOnDemand` blokirao konekciju jer niko još nije
   probao da gleda:** ovo je OČEKIVANO ponašanje (ne bug) —
   `pathDefaults.sourceOnDemand: true` znači MediaMTX se ne konektuje
   na RTSP izvor dok neko ne zatraži HLS. Prvi zahtev može imati
   kašnjenje do `sourceOnDemandStartTimeout` (10s).
4. **Auth token problem** (401, ne 404): proveri
   `lib/handlers/verify-stream-token.js` i da li je token istekao/
   nevažeći — ovo je odvojen sloj od MediaMTX path konfiguracije.

### Simptom: nova kamera dodata kroz UI, ali se ne pojavljuje odmah

- Real-time sinhronizacija (`api/cameras.js`) zavisi od toga da
  MediaMTX REST API bude dostupan u tom trenutku. Ako je bio privremeno
  nedostupan, poziv je tiho neuspeo (`mediamtx_synced: false` u API
  odgovoru — proveri response body).
- Sačekaj do `CAMERA_SYNC_INTERVAL_SECONDS` (podrazumevano 60s) —
  periodični worker resync će je uhvatiti automatski.

### Simptom: obrisana kamera i dalje ima aktivan MediaMTX path

- Isto kao gore — ili je real-time delete poziv promašio (MediaMTX
  bio nedostupan), ili treba sačekati sledeći periodični resync
  (worker briše "osirotele" putanje koje nisu u bazi).

## Rollback plan

Ako V2 pravi više problema nego što rešava:

```bash
fly deploy --image <prethodni-image-tag>
# ili, ako nema prethodne Fly.io verzije (prvi V2 deploy):
fly apps destroy dnd-media-server
```

Pošto V1 nikad nije imao stvaran, funkcionalan deployment (potvrđeno
revizijom — nije postojao `fly.toml` niti `Dockerfile` u repo-u pre
ove grane), "rollback na V1" praktično znači "kamere ponovo ne rade
dinamički", ne povratak na prethodno funkcionalno stanje.
