@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM D&D Monitoring - Laptop Media Node start script
REM Run directly from C:\Users\Korisnik\Desktop\D-D-MONITORING-2026\laptop
REM Loads secrets from .env in project root
REM ============================================================

REM --- Configuration ---
set "PROJECT_ROOT=C:\Users\Korisnik\Desktop\D-D-MONITORING-2026"
set "MEDIAMTX_EXE=C:\dnd-media\mediamtx\mediamtx.exe"
set "MEDIAMTX_YML=C:\dnd-media\mediamtx\mediamtx.yml"
set "LOG_DIR=%PROJECT_ROOT%\logs"

REM --- Load .env into environment ---
if not exist "%PROJECT_ROOT%\.env" (
  echo [start] ERROR: .env file not found at %PROJECT_ROOT%\.env
  echo [start] Create .env with DATABASE_URL, MEDIA_NODE_ID, MEDIA_NODE_HEARTBEAT_SECRET, CREDENTIAL_ENCRYPTION_KEY.
  pause
  goto :done
)

for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT_ROOT%\.env") do (
  set "%%A=%%B"
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM --- Start MediaMTX ---
echo [start] Starting MediaMTX...
if not exist "%MEDIAMTX_EXE%" (
  echo [start] ERROR: MediaMTX exe not found at %MEDIAMTX_EXE%
  pause
  goto :done
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%MEDIAMTX_EXE%' -ArgumentList '%MEDIAMTX_YML%' -WindowStyle Normal"

REM Wait for MediaMTX REST API (max 30s)
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq mediamtx.exe" | find /I "mediamtx.exe" >nul
if %errorlevel% neq 0 (
  echo [start] ERROR: DND-MediaMTX failed to start. Check exe and config.
  pause
  goto :done
)

set /a TRIES=0
:wait_api
timeout /t 1 /nobreak >nul
set /a TRIES+=1
curl -sf http://127.0.0.1:9997/v3/config/global/get >nul 2>&1
if %errorlevel%==0 goto :api_ready
if %TRIES% GEQ 30 goto :api_timeout
goto :wait_api

:api_timeout
echo [start] ERROR: MediaMTX API did not respond in 30s.
pause
goto :done

:api_ready
echo [start] MediaMTX API ready (after %TRIES%s).

REM --- Start Media Node Workers (each in own window) ---
REM Local media-node workers must be allowed to reach cameras on the LAN.
set "ALLOW_PRIVATE_NETWORK=true"
echo [start] Starting camera-sync-worker...
start "DND-camera-sync" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" camera-sync "node workers\camera-sync-worker.js"

echo [start] Starting media-node-heartbeat...
start "DND-heartbeat" /min "%PROJECT_ROOT%\workers\heartbeat-supervisor.bat"

echo [start] Starting camera-setup-agent...
start "DND-camera-setup" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" camera-setup "node workers\camera-setup-agent.js"

echo [start] Starting person-detection-worker...
start "DND-person-detection" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" person-detection "node workers\person-detection-worker.js"

echo [start] Starting xiongmai-stream-worker...
start "DND-xiongmai-stream" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" xiongmai "node workers\xiongmai-stream-worker.js"

echo [start] Starting recording-worker...
start "DND-recording" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" recording "node workers\recording-worker.js"

echo [start] Starting two-way-audio-api...
if not defined TWO_WAY_AUDIO_PORT set "TWO_WAY_AUDIO_PORT=8890"
if not defined ALLOWED_ORIGIN set "ALLOWED_ORIGIN=https://www.dnd-monitoring.com"
start "DND-audio-api" /min "%PROJECT_ROOT%\workers\worker-supervisor.bat" audio-api "node workers\two-way-audio-api.js"

echo.
echo [start] ALL STARTED.
echo [start] Windows: DND-MediaMTX, DND-camera-sync, DND-heartbeat, DND-camera-setup, DND-person-detection, DND-recording, DND-xiongmai-stream, DND-audio-api.
echo [start] Logs: check each window or %LOG_DIR%\*.log
echo [start] MediaMTX API:  curl http://127.0.0.1:9997/v3/config/global/get
echo [start] Audio API:     curl http://127.0.0.1:%TWO_WAY_AUDIO_PORT%/api/audio/test/capabilities

:done
endlocal