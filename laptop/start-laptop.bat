@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  D&D Monitoring — Laptop Media Node start skripta
REM
REM  Svi tajni podaci (DATABASE_URL, MEDIA_NODE_ID,
REM  MEDIA_NODE_HEARTBEAT_SECRET, CREDENTIAL_ENCRYPTION_KEY) se
REM  ucitavaju iz lokalnog .env fajla:
REM    C:\Users\Korisnik\Desktop\D-D-MONITORING-2026\.env
REM
REM  NIKAD ne stavljaj prave vrednosti u ovu skriptu.
REM  NIKAD ne commit-uj .env fajl.
REM ============================================================

set API_BASE_URL=https://www.dnd-monitoring.com/api
set CAMERA_SYNC_INTERVAL_SECONDS=60
set MEDIAMTX_API_URL=http://127.0.0.1:9997

REM ---- OPCIONALNO: Cloudflare Tunnel (za "Start Tunnel" dugme u wizardu) ----
REM Prvo jednom:  cloudflared tunnel login
REM Napravi tunnel:  cloudflared tunnel create dnd-hls
REM DNS:  cloudflared tunnel route dns dnd-hls hls.dnd-monitoring.com
REM Zatim otkomentarisi dve linije ispod:
REM set CLOUDFLARE_TUNNEL_NAME=dnd-hls
REM set CLOUDFLARE_TUNNEL_CONFIG=C:\dnd-media\cloudflared\config.yml
REM -------------------------------------------------------------------------

REM ---- Project root (override ako je workers/ na drugoj lokaciji) ----
set PROJECT_ROOT=C:\Users\Korisnik\Desktop\D-D-MONITORING-2026
set MEDIAMTX_EXE=C:\dnd-media\mediamtx\mediamtx.exe
set MEDIAMTX_YML=C:\dnd-media\mediamtx\mediamtx.yml

if not exist "%PROJECT_ROOT%\.env" (
  echo [start] GRESKA: .env fajl ne postoji na %PROJECT_ROOT%\.env
  echo [start] Kreiraj .env sa DATABASE_URL, MEDIA_NODE_ID,
  echo [start] MEDIA_NODE_HEARTBEAT_SECRET, CREDENTIAL_ENCRYPTION_KEY.
  goto done
)

REM Ucitaj .env varijable u trenutni shell.
REM Koristimo cmd /c for /f da parsiramo KEY=VALUE linije.
for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT_ROOT%\.env") do (
  set "%%A=%%B"
)

if not exist "%PROJECT_ROOT%\logs" mkdir "%PROJECT_ROOT%\logs"

echo [start] Pokrecem MediaMTX...
if not exist "%MEDIAMTX_EXE%" (
  echo [start] GRESKA: MediaMTX exe ne postoji na %MEDIAMTX_EXE%
  goto done
)
start "DND-MediaMTX" /min "%MEDIAMTX_EXE%" "%MEDIAMTX_YML%"

REM Sacekaj da MediaMTX REST API bude spreman (max 30s).
REM Da izbegnemo lažno "ready" ako neki drugi proces vec drzi port 9997,
REM proveravamo da li nas DND-MediaMTX prozor postoji posle 2s.
timeout /t 2 /nobreak >nul
tasklist /FI "WINDOWTITLE eq DND-MediaMTX*" | find /I "mediamtx.exe" >nul
if %errorlevel% neq 0 (
  echo [start] GRESKA: DND-MediaMTX nije pokrenut. Proveri exe i config.
  goto done
)

set /a TRIES=0
:wait_api
timeout /t 1 /nobreak >nul
set /a TRIES+=1
curl -sf http://127.0.0.1:9997/v3/config/global/get >nul 2>&1
if %errorlevel%==0 goto api_ready
if %TRIES% GEQ 30 goto api_timeout
goto wait_api
:api_timeout
echo [start] GRESKA: MediaMTX API nije odgovorio u 30s. Proveri da mediamtx.exe radi.
goto done
:api_ready
echo [start] MediaMTX API spreman (posle %TRIES%s).

echo [start] Pokrecem camera-sync-worker...
start "DND-camera-sync" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\camera-sync-worker.js"

echo [start] Pokrecem media-node-heartbeat...
start "DND-heartbeat" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\media-node-heartbeat.js"

echo [start] Pokrecem camera-setup-agent (wizard executor)...
start "DND-camera-setup" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\camera-setup-agent.js"

echo [start] Pokrecem person-detection-worker...
start "DND-person-detection" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\person-detection-worker.js"

echo [start] Pokrecem xiongmai-stream-worker (DVRIP kamere)...
start "DND-xiongmai-stream" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\xiongmai-stream-worker.js >> %PROJECT_ROOT%\logs\xiongmai-runtime.log 2>>&1"

REM ---- Two-Way Audio API (lokalni, OPTalk ka DVRIP kamerama) ----
REM Sluša na TWO_WAY_AUDIO_PORT (default 8890). Frontend ga zove
REM preko VITE_AUDIO_API_BASE_URL kroz Cloudflare Tunnel.
REM Env (preuzima iz %PROJECT_ROOT%\.env): DATABASE_URL,
REM MEDIA_NODE_DATABASE_URL (fallback), ALLOWED_ORIGIN.
set TWO_WAY_AUDIO_PORT=8890
if not defined ALLOWED_ORIGIN set ALLOWED_ORIGIN=https://www.dnd-monitoring.com
echo [start] Pokrecem two-way-audio-api (port %TWO_WAY_AUDIO_PORT%)...
start "DND-audio-api" /min cmd /c "cd /d %PROJECT_ROOT% && node workers\two-way-audio-api.js >> %PROJECT_ROOT%\logs\audio-api-runtime.log 2>>&1"

echo.
echo [start] SVE POKRENUTO. Prozori: DND-MediaMTX, DND-camera-sync, DND-heartbeat, DND-camera-setup, DND-person-detection, DND-xiongmai-stream, DND-audio-api.
echo [start] Logove gledaj u svakom prozoru posebno.
echo [start] Provera: curl http://127.0.0.1:9997/v3/config/global/get
echo [start] Audio API provera: curl http://127.0.0.1:%TWO_WAY_AUDIO_PORT%/api/audio/test/capabilities

:done
endlocal
