@echo off
rem Backs up the sensor history, sleep nights and settings into backups\ (one zip).
rem Safe while Thalpos is running. setup_backup.bat runs this every week on its own.
cd /d "%~dp0"
if not exist logs mkdir logs
echo ==== %date% %time% ==== >> logs\backup.log
"venv\Scripts\python.exe" tools\backup_data.py >> logs\backup.log 2>&1
