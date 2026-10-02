@echo off
setlocal
cd /d "%~dp0"
echo.
echo ================================================
echo WhatsApp Group Manager - Clean Install
echo ================================================
echo.
if exist node_modules (
  echo Removing old/corrupt node_modules...
  rmdir /s /q node_modules
)
echo.
echo Installing dependencies...
npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Please check the error above.
  pause
  exit /b 1
)
echo.
echo Starting WhatsApp Group Manager...
npm start
pause
