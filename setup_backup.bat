@echo off
rem Once: back up the Thalpos data every week automatically, and take a first backup now.
rem Undo: Task Scheduler, delete the task "Thalpos backup".
cd /d "%~dp0"
if not exist logs mkdir logs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup_backup.ps1" > logs\setup_backup.log 2>&1
call backup_data.bat
type logs\setup_backup.log
