param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"

function Ensure-Command {
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$InstallHint = "Install it and re-run this script."
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. $InstallHint"
  }
}

function Ensure-NpmDependencies {
  param([switch]$SkipCheck)

  if ($SkipInstall) {
    Write-Host "Skipping dependency installation (SkipInstall flag set)." -ForegroundColor Yellow
    return
  }

  if (-not (Test-Path "node_modules")) {
    Write-Host "node_modules missing. Installing dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    return
  }

  if ($SkipCheck) {
    Write-Host "node_modules present. Skipping dependency verification." -ForegroundColor Yellow
    return
  }

  Write-Host "Verifying npm dependencies..." -ForegroundColor Cyan
  npm ls --depth=0 | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Dependencies missing or invalid. Installing..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  } else {
    Write-Host "Dependencies already installed." -ForegroundColor Green
  }
}

Write-Host "== Hellas Launcher Build ==" -ForegroundColor Cyan

Ensure-Command node "Install Node.js LTS (includes npm) from https://nodejs.org/en/download and re-run this script."
node -v | Out-Null
Ensure-Command npm "Install Node.js LTS (includes npm) from https://nodejs.org/en/download and re-run this script."

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Edit it as needed." -ForegroundColor Yellow
}

Ensure-NpmDependencies

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
