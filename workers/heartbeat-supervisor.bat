@echo off
setlocal

for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "LOG_DIR=%PROJECT_ROOT%\logs"
set "HEARTBEAT_CMD=node workers\media-node-heartbeat.js"
set "LOG_FILE=%LOG_DIR%\heartbeat.log"
set "RESTART_DELAY=5"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:restart_loop
echo [heartbeat-supervisor] %date% %time% - starting heartbeat >> "%LOG_FILE%"

cmd /c "cd /d %PROJECT_ROOT% && %HEARTBEAT_CMD%" >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [heartbeat-supervisor] %date% %time% - heartbeat exited with code %EXIT_CODE% >> "%LOG_FILE%"
echo [heartbeat-supervisor] %date% %time% - restarting in %RESTART_DELAY%s >> "%LOG_FILE%"

timeout /t %RESTART_DELAY% /nobreak >nul
goto restart_loop
