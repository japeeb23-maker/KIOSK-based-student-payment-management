@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or later with built-in SQLite support is required.
  pause
  exit /b 1
)

start "FBC Paypoint local server" cmd /k node "%~dp0..\src\server\server.js"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready = $false; for ($i = 0; $i -lt 24; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:4177/health'; if ($response.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 250 } }; if ($ready) { Start-Process 'http://127.0.0.1:4177/' } else { Write-Error 'The local server did not start. Check its window for details.'; exit 1 }"
if errorlevel 1 (
  echo Could not start FBC Paypoint. Check the server window for details.
  pause
  exit /b 1
)
