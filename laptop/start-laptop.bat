@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  D&D Monitoring — Laptop Media Node start skripta
REM  Pokrece: MediaMTX + camera-sync-worker + media-node-heartbeat
REM
REM  POPUNI TRI STVARI ISPOD (ostalo je vec ispravno):
REM   1. DATABASE_URL            -> isti Neon connection string kao na Vercelu
REM   2. MEDIA_NODE_ID           -> iz registracije noda (korak 3 u README.md)
REM   3. MEDIA_NODE_HEARTBEAT_SECRET -> isti secret iz registracije
REM  Zatim pokreni:  start-laptop.bat
REM ============================================================

REM ---- EDIT OVE TRI LINIJE ----
set DATABASE_URL=postgresql://USER:PASS@HOST/neondb?sslmode=require
set MEDIA_NODE_ID=PASTE_NODE_UUID_HERE
set MEDIA_NODE_HEARTBEAT_SECRET=PASTE_HEARTBEAT_SECRET_HERE
REM ------------------------------

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

echo [start] Pokrecem MediaMTX...
start "DND-MediaMTX" /min "%~dp0mediamtx\mediamtx.exe" "%~dp0mediamtx\mediamtx.yml"

REM Sacekaj da MediaMTX REST API bude spreman (max 30s)
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
start "DND-camera-sync" /min cmd /c "cd /d %~dp0app && node workers\camera-sync-worker.js"

echo [start] Pokrecem media-node-heartbeat...
start "DND-heartbeat" /min cmd /c "cd /d %~dp0app && node workers\media-node-heartbeat.js"

echo [start] Pokrecem camera-setup-agent (wizard executor)...
start "DND-camera-setup" /min cmd /c "cd /d %~dp0app && node workers\camera-setup-agent.js"

echo.
echo [start] SVE POKRENUTO. Prozori: DND-MediaMTX, DND-camera-sync, DND-heartbeat.
echo [start] Logove gledaj u svakom prozoru posebno.
echo [start] Provera: curl http://127.0.0.1:9997/v3/config/global/get

:done
endlocal
