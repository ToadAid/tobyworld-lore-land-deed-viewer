@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY_CMD=py -3"
) else (
  where python >nul 2>&1
  if %errorlevel%==0 (
    set "PY_CMD=python"
  ) else (
    echo.
    echo Python 3 was not found.
    echo Install Python 3 from https://www.python.org/downloads/windows/
    echo During setup, enable "Add python.exe to PATH", then run this file again.
    echo.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set "PORT=7777"
set "OPEN_BROWSER=1"
echo Starting Tobyworld Lore Land Deed Viewer at http://127.0.0.1:%PORT%/
if "%OPENSEA_API_KEY%"=="" (
  echo OpenSea API key: not set; public-page artwork fallback will still be tried.
) else (
  echo OpenSea API key: available.
)
%PY_CMD% serve-vault.py
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo Viewer stopped with exit code %RC%.
  pause
)
exit /b %RC%
