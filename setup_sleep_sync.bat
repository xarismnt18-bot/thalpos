@echo off
cd /d "%~dp0"
if exist venv\Scripts\python.exe (
  set "SLEEP_PYTHON=venv\Scripts\python.exe"
  goto install
)
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 -m venv .venv-sleep
) else (
  python -m venv .venv-sleep
)
if not exist .venv-sleep\Scripts\python.exe (
  echo Python 3.11 or newer is required. Install Python, then run this again.
  pause
  exit /b 1
)
set "SLEEP_PYTHON=.venv-sleep\Scripts\python.exe"
:install
"%SLEEP_PYTHON%" -m pip install "fastapi>=0.111,<1" "pydantic>=2.9,<3" "uvicorn>=0.29,<1" "python-dotenv>=1,<2"
if errorlevel 1 (
  echo Dependency installation failed. Check your internet connection.
  pause
  exit /b 1
)
"%SLEEP_PYTHON%" tools\pair_sleep.py
echo Wearable sleep will also start with normal Thalpos after you restart it.
pause
