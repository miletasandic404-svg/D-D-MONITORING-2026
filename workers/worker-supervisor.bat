@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem worker-supervisor.bat - Robust worker supervisor
rem Handles arguments from start-laptop.bat pattern:
rem   start "" /min cmd /c "cd /d ROOT && call worker-supervisor.bat NAME \"\"\"COMMAND\"\"\""
rem ============================================================

rem --- Parse arguments ---
set "WORKER_NAME=%~1"
set "WORKER_CMD=%~2"

rem --- Paths ---
set "LOG_DIR=%~dp0..\logs"
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "MAX_RESTARTS=3"
set "FAILURE_COUNT=0"
set "LOG_FILE=%LOG_DIR%\%WORKER_NAME%.log"
set "STATE_FILE=%LOG_DIR%\%WORKER_NAME%.health.json"

rem --- Ensure log directory exists ---
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

rem ============================================================
rem Main restart loop
rem ============================================================
:restart_loop

set "STATE_STATUS=running"
set "STATE_EXIT_CODE="
call :write_state
echo [%WORKER_NAME%-supervisor] %date% %time% - starting >> "%LOG_FILE%"

rem Execute from the project root without Unix-style quote escaping.
pushd "%PROJECT_ROOT%"
%WORKER_CMD% >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo [%WORKER_NAME%-supervisor] %date% %time% - exited with code %EXIT_CODE% >> "%LOG_FILE%"
if "%EXIT_CODE%"=="0" (
    set "STATE_STATUS=normal"
    set "STATE_EXIT_CODE=0"
    call :write_state
    echo [%WORKER_NAME%-supervisor] %date% %time% - exited normally; supervisor stopped >> "%LOG_FILE%"
    goto supervisor_done
)

set /a FAILURE_COUNT+=1
if !FAILURE_COUNT! GEQ %MAX_RESTARTS% (
    set "STATE_STATUS=FAILED/UNHEALTHY"
    set "STATE_EXIT_CODE=%EXIT_CODE%"
    call :write_state
    echo [%WORKER_NAME%-supervisor] %date% %time% - FAILED/UNHEALTHY after !FAILURE_COUNT! consecutive failures; last exit code %EXIT_CODE% >> "%LOG_FILE%"
    goto supervisor_done
)

set /a RESTART_DELAY=FAILURE_COUNT*5
set "STATE_STATUS=degraded"
set "STATE_EXIT_CODE=%EXIT_CODE%"
call :write_state
echo [%WORKER_NAME%-supervisor] %date% %time% - failure !FAILURE_COUNT!/%MAX_RESTARTS%; restarting in !RESTART_DELAY!s >> "%LOG_FILE%"
rem timeout requires an interactive console and exits immediately under cmd /c.
set /a WAIT_COUNT=RESTART_DELAY+1
ping 127.0.0.1 -n !WAIT_COUNT! >nul
goto restart_loop

:supervisor_done
endlocal
goto :eof

:write_state
set "STATE_WORKER_NAME=%WORKER_NAME%"
set "STATE_FAILURE_COUNT=%FAILURE_COUNT%"
set "STATE_FILE=%STATE_FILE%"
powershell -NoProfile -NonInteractive -Command "$state = [ordered]@{ worker_name = $env:STATE_WORKER_NAME; status = $env:STATE_STATUS; timestamp = [DateTime]::UtcNow.ToString('o'); failure_count = [int]$env:STATE_FAILURE_COUNT; exit_code = if ($env:STATE_EXIT_CODE) { [int]$env:STATE_EXIT_CODE } else { $null } }; $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:STATE_FILE -Encoding utf8"
exit /b 0