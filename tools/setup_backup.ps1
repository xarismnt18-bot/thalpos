# Registers a weekly Windows task that runs backup_data.bat (Sunday 13:07).
# StartWhenAvailable: if the laptop is off or asleep then, it runs at the next chance.
$root = Split-Path -Parent $PSScriptRoot
$action = New-ScheduledTaskAction -Execute "$root\backup_data.bat" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 13:07
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "Thalpos backup" -Action $action -Trigger $trigger -Settings $settings -Description "Weekly backup of the Thalpos data" -Force | Out-Null
Write-Output "Scheduled task 'Thalpos backup' registered (weekly, Sunday 13:07)."
