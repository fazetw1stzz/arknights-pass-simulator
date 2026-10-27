@echo off
setlocal
cd /d "%~dp0"
set "PYTHONDONTWRITEBYTECODE=1"
where py >nul 2>nul
if errorlevel 1 goto try_python
py -3 -B -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 goto try_python
py -3 -B server.py %* --open-browser
set "APP_EXIT=%errorlevel%"
goto finished
:try_python
python -B -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 goto missing_python
python -B server.py %* --open-browser
set "APP_EXIT=%errorlevel%"
goto finished
:missing_python
echo Required: Python 3.10 or newer. No compatible Python was found.
echo Install or enable Python, then run this launcher again.
echo This package does not install Python or change network/security settings.
pause
exit /b 1
:finished
if "%APP_EXIT%"=="0" exit /b 0
echo Local server stopped with exit code %APP_EXIT%.
echo If the port is busy, run this launcher with: --port 8766
pause
exit /b %APP_EXIT%
