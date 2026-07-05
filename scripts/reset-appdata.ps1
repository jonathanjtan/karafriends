# Wipes karafriends' Windows AppData state back to a fresh install, keeping
# only config.yaml (creds, ports, admin lists, etc.) so you don't have to
# re-enter them. Useful when debugging weird persistent state (stuck queue,
# corrupted cache) without losing your config.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/reset-appdata.ps1
#    or: yarn reset-appdata

$ErrorActionPreference = "Stop"

if (Get-Process -Name "karafriends" -ErrorAction SilentlyContinue) {
    Write-Host "karafriends.exe is running. Close it first, then re-run this script." -ForegroundColor Red
    exit 1
}

# app.getPath("userData") -> config.yaml plus Electron's own Cache/Local
# Storage/IndexedDB/etc.
$roamingDir = Join-Path $env:APPDATA "karafriends"
# app.getPath("temp") + "/karafriends_tmp" -> queue.json (NotARealDb) and
# predownloaded song files.
$tempDir = Join-Path $env:LOCALAPPDATA "Temp\karafriends_tmp"

Write-Host "This will delete:"
Write-Host "  $tempDir (entirely)"
Write-Host "  $roamingDir (everything except config.yaml)"
$confirm = Read-Host "Continue? [y/N]"
if ($confirm -notin @("y", "Y")) {
    Write-Host "Aborted."
    exit 0
}

if (Test-Path $tempDir) {
    Remove-Item -Recurse -Force $tempDir
    Write-Host "Deleted $tempDir"
} else {
    Write-Host "$tempDir doesn't exist, skipping."
}

if (Test-Path $roamingDir) {
    Get-ChildItem -Path $roamingDir -Force |
        Where-Object { $_.Name -ne "config.yaml" } |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
    Write-Host "Cleared $roamingDir (kept config.yaml)"
} else {
    Write-Host "$roamingDir doesn't exist, skipping."
}

Write-Host "Done. Next launch will be a fresh install using your existing config."
