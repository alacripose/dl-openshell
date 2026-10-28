@echo off
rem Launch the Deadworks server for the Openlock mode in this console window.
pushd "%~dp0"
echo Starting Deadworks in %CD%
"%~dp0deadworks.exe" -dedicated -console -dev -insecure -allow_no_lobby_connect +tv_citadel_auto_record 0 +spec_replay_enable 0 +tv_enable 0 +citadel_upload_replay_enabled 0 +hostport 27067 +map dl_midtown
echo.
echo Deadworks exited with code %ERRORLEVEL%.
pause
