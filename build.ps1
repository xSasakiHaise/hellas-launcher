param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"

Write-Host "== Hellas Launcher Build ==" -ForegroundColor Cyan

node -v | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Node.js not found. Install Node LTS." }

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Edit it as needed." -ForegroundColor Yellow
}

if (-not $SkipInstall) {
  npm install
}

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
