@echo off
cd /d "%~dp0"
if exist .venv-sleep\Scripts\python.exe (
  .venv-sleep\Scripts\python.exe tools\run_sleep_bridge.py
) else if exist venv\Scripts\python.exe (
  venv\Scripts\python.exe tools\run_sleep_bridge.py
) else (
  echo Run setup_sleep_sync.bat first.
)
pause
