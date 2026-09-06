@echo off
setlocal

set "WORKER_NAME=%~1"
set "LOG_DIR=%~dp0..\logs"
set "RESTART_DELAY=5"

shift
set "WORKER_CMD=%~1"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:restart_loop
echo [%WORKER_NAME%-supervisor] %date% %time% - starting >> "%LOG_DIR%\%WORKER_NAME%.log"

cmd /c "%WORKER_CMD%" >> "%LOG_DIR%\%WORKER_NAME%.log" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%WORKER_NAME%-supervisor] %date% %time% - exited with code %EXIT_CODE% >> "%LOG_DIR%\%WORKER_NAME%.log"
echo [%WORKER_NAME%-supervisor] %date% %time% - restarting in %RESTART_DELAY%s >> "%LOG_DIR%\%WORKER_NAME%.log"

timeout /t %RESTART_DELAY% /nobreak >nul
goto restart_loop
