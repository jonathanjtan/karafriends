# Resets karafriends to a fresh install, keeping only your config.yaml
# (DAM/Joysound creds, ports, admin lists, etc.) so you don't have to
# re-enter it. Use this if karafriends is stuck in a weird state (broken
# queue, corrupted cache) and a restart alone doesn't fix it.

if (Get-Process -Name "karafriends" -ErrorAction SilentlyContinue) {
    Write-Host "karafriends is currently running. Please close it first, then run this again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$roamingDir = Join-Path $env:APPDATA "karafriends"
$tempDir = Join-Path $env:LOCALAPPDATA "Temp\karafriends_tmp"

Write-Host "This will reset karafriends to factory settings:"
Write-Host "  - All cached/temporary data will be deleted"
Write-Host "  - Your config.yaml (creds, ports, settings) will be kept"
Write-Host ""
$confirm = Read-Host "Continue? [y/N]"
if ($confirm -notin @("y", "Y")) {
    Write-Host "Cancelled, nothing was deleted."
    Read-Host "Press Enter to exit"
    exit 0
}

if (Test-Path $tempDir) {
    Remove-Item -Recurse -Force $tempDir
}

if (Test-Path $roamingDir) {
    Get-ChildItem -Path $roamingDir -Force |
        Where-Object { $_.Name -ne "config.yaml" } |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
}

Write-Host ""
Write-Host "Done. karafriends has been reset to factory settings." -ForegroundColor Green
Read-Host "Press Enter to exit"
