$ErrorActionPreference = "Stop"

Write-Host "== Hellas Launcher Build & Java Bundling =="

# Resolve repo root
$RepoRoot    = Split-Path $MyInvocation.MyCommand.Path -Parent
$DistDir     = Join-Path $RepoRoot "dist"
$ResourcesDir = Join-Path $DistDir "win-unpacked\resources"

$Jre8Dir  = Join-Path $ResourcesDir "jre8"
$Jre11Dir = Join-Path $ResourcesDir "jre11"

# 1) Run Electron build
Write-Host "Running electron-builder..."
npm run build

# Ensure resource dir exists
New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null

# 2) Bundle Java 8 (primary)
if (!(Test-Path $Jre8Dir)) {
    Write-Host "Bundling Java 8 into resources\jre8 ..."
    New-Item -ItemType Directory -Force -Path $Jre8Dir | Out-Null

    $Jre8Zip = Join-Path $RepoRoot "build-deps\jre8-win-x64.zip"
    if (!(Test-Path $Jre8Zip)) {
        throw "Missing $Jre8Zip — place Java 8 runtime ZIP into /build-deps/"
    }

    Expand-Archive -Path $Jre8Zip -DestinationPath $Jre8Dir -Force
}

# 3) Bundle Java 11 (fallback)
if (!(Test-Path $Jre11Dir)) {
    Write-Host "Bundling Java 11 into resources\jre11 ..."
    New-Item -ItemType Directory -Force -Path $Jre11Dir | Out-Null

    $Jre11Zip = Join-Path $RepoRoot "build-deps\jre11-win-x64.zip"
    if (!(Test-Path $Jre11Zip)) {
        throw "Missing $Jre11Zip — place Java 11 runtime ZIP into /build-deps/"
    }

    Expand-Archive -Path $Jre11Zip -DestinationPath $Jre11Dir -Force
}

Write-Host "Java bundling complete."
