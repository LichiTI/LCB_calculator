@echo off
setlocal
cd /d "%~dp0"
title Limbus Uptie4 Calculator

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 LTS: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo First run: extracting game data and building the web app, about 2-5 minutes...
  node scripts\update.mjs --mode data
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

node scripts\serve.mjs
pause
