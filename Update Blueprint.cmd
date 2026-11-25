@echo off
rem Double-click to update ARD Blueprint: pulls the latest changes, rebuilds the
rem installer, reinstalls quietly and reopens the app. Settings are kept.
setlocal
cd /d "%~dp0"
title Updating ARD Blueprint

echo Closing ARD Blueprint if it's open...
taskkill /IM "ARD Blueprint.exe" /F >nul 2>&1

echo.
echo Getting the latest changes...
git fetch origin || goto :fail
git checkout main || goto :fail
git pull --ff-only || goto :fail

echo.
echo Installing packages...
call npm.cmd ci || goto :fail

echo.
echo Building the app (a few minutes)...
call npm.cmd run dist || goto :fail

set "SETUP="
for /f "delims=" %%f in ('dir /b /o-d "release\ARD Blueprint Setup *.exe" 2^>nul') do if not defined SETUP set "SETUP=release\%%f"
if not defined SETUP goto :fail

echo.
echo Installing %SETUP%...
start "" /wait "%SETUP%" /S || goto :fail

echo.
echo Done. Opening ARD Blueprint.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\ARD Blueprint.lnk"
if exist "%LNK%" (start "" "%LNK%") else start "" "%LOCALAPPDATA%\Programs\ARD Blueprint\ARD Blueprint.exe"
timeout /t 3 >nul
exit /b 0

:fail
echo.
echo Something went wrong. Copy the red text above and send it to Claude.
pause
exit /b 1
