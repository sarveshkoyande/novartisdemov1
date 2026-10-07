@echo off
REM Launches the Accelerate backend independently of any terminal or tool
REM session. Registered as a Scheduled Task ("NovartisAccelerateServer") that
REM runs at logon, so the server is owned by the Task Scheduler service rather
REM than by whatever shell happened to start it — that is what stops it being
REM killed when a terminal, VS Code window, or agent session closes.
REM
REM --use-system-ca is required on this machine: corporate TLS interception
REM re-signs traffic with a root CA that lives in the Windows trust store,
REM which Node otherwise ignores. Without it every model call fails with
REM UNABLE_TO_GET_ISSUER_CERT_LOCALLY, surfaced to the browser as
REM "Couldn't reach the agent backend".
cd /d "%~dp0"
echo [%date% %time%] starting server >> server.out.log
node --use-system-ca server.js >> server.out.log 2>&1
echo [%date% %time%] server exited with code %errorlevel% >> server.out.log
