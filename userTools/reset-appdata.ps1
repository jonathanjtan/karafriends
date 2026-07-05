# Resets karafriends to a fresh install, keeping only your config.yaml
# (DAM/Joysound creds, ports, admin lists, etc.) so you don't have to
# re-enter it. Use this if karafriends is stuck in a weird state (broken
# queue, corrupted cache) and a restart alone doesn't fix it.

function Assert-SafePathToWipe {
    param(
        [Parameter(Mandatory)] [string]$EnvVarName,
        [Parameter(Mandatory)] [string]$EnvVarValue,
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$ExpectedLeafName
    )

    # These guards exist so that if %APPDATA%/%LOCALAPPDATA% are ever unset,
    # blank, or resolve unexpectedly, we refuse to touch anything rather
    # than risk deleting the wrong folder (or someone's whole profile).
    if ([string]::IsNullOrWhiteSpace($EnvVarValue)) {
        throw "$EnvVarName is not set. Refusing to continue."
    }
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "Resolved path '$Path' is not absolute. Refusing to continue."
    }
    $leaf = Split-Path -Path $Path -Leaf
    if ($leaf -ne $ExpectedLeafName) {
        throw "Resolved path '$Path' doesn't end in '$ExpectedLeafName' as expected. Refusing to continue."
    }
}

try {
    if (Get-Process -Name "karafriends" -ErrorAction SilentlyContinue) {
        Write-Host "karafriends is currently running. Please close it first, then run this again." -ForegroundColor Red
        exit 1
    }

    $roamingDir = Join-Path $env:APPDATA "karafriends"
    $tempDir = Join-Path $env:LOCALAPPDATA "Temp\karafriends_tmp"

    Assert-SafePathToWipe -EnvVarName "%APPDATA%" -EnvVarValue $env:APPDATA -Path $roamingDir -ExpectedLeafName "karafriends"
    Assert-SafePathToWipe -EnvVarName "%LOCALAPPDATA%" -EnvVarValue $env:LOCALAPPDATA -Path $tempDir -ExpectedLeafName "karafriends_tmp"

    Write-Host "This will reset karafriends to factory settings:"
    Write-Host "  - All cached/temporary data will be deleted"
    Write-Host "  - Your config.yaml (creds, ports, settings) will be kept"
    Write-Host ""
    Write-Host "Specifically, this deletes:"
    Write-Host "  $tempDir"
    Write-Host "  everything under $roamingDir except config.yaml"
    Write-Host ""
    $confirm = Read-Host "Continue? [y/N]"
    if ($confirm -notin @("y", "Y")) {
        Write-Host "Cancelled, nothing was deleted."
        exit 0
    }

    $hadErrors = $false

    if (Test-Path -LiteralPath $tempDir) {
        try {
            Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host "Couldn't fully delete $tempDir : $_" -ForegroundColor Yellow
            $hadErrors = $true
        }
    }

    if (Test-Path -LiteralPath $roamingDir) {
        Get-ChildItem -LiteralPath $roamingDir -Force |
            Where-Object { $_.Name -ne "config.yaml" } |
            ForEach-Object {
                try {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                } catch {
                    Write-Host "Couldn't fully delete $($_.FullName) : $_" -ForegroundColor Yellow
                    $hadErrors = $true
                }
            }
    }

    Write-Host ""
    if ($hadErrors) {
        Write-Host "Finished with some files skipped (probably still in use). See above." -ForegroundColor Yellow
    } else {
        Write-Host "Done. karafriends has been reset to factory settings." -ForegroundColor Green
    }
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
} finally {
    Read-Host "Press Enter to exit"
}
