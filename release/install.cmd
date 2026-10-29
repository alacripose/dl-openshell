@echo off
rem dl-openshell installer entry point. Windows blocks a downloaded .ps1 under the default
rem RemoteSigned policy, so double-clicking this file starts it with a process-scoped bypass.
rem install.ps1 stays the installer; this only launches it and keeps a failure on screen.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "openshell_code=%ERRORLEVEL%"
if not "%openshell_code%"=="0" (
    echo.
    echo dl-openshell installer exited with code %openshell_code%.
    pause
)
exit /b %openshell_code%
