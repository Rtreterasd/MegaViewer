@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 LTS or newer from https://nodejs.org/
  echo Then run this launcher again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)
if not exist "node_modules\.bin\electron.cmd" (
  echo Installing dependencies. Internet access is required...
  call npm.cmd ci
  if errorlevel 1 (
    echo Installation failed. Check your connection and try again.
    pause
    exit /b 1
  )
)
call npm.cmd start -- %*
if errorlevel 1 (
  echo Application could not start. See the error above.
  pause
  exit /b 1
)
