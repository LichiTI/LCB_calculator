@echo off
setlocal
cd /d "%~dp0"
title Limbus Uptie4 Calculator - Update

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 LTS: https://nodejs.org/
  pause
  exit /b 1
)

rem Optional argument: 1=all 2=translations 3=code 4=game data. No argument shows the menu.
if "%~1"=="" (
  node scripts\update.mjs --menu
) else (
  node scripts\update.mjs --mode %~1
)
if errorlevel 1 (
  echo.
  echo [ERROR] Update failed. Please screenshot the messages above.
)
echo.
pause
