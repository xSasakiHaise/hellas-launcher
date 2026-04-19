param(
  [switch]$SkipInstall,
  [switch]$RequireSigned
)
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

$hasSigningConfig = -not [string]::IsNullOrWhiteSpace($env:CSC_LINK)
if ($hasSigningConfig) {
  Write-Host "Code signing config detected via CSC_LINK." -ForegroundColor Cyan
} else {
  Write-Host "No code signing certificate configured. Build will be unsigned unless electron-builder finds a certificate in the Windows store." -ForegroundColor Yellow
}

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

$artifact = Join-Path (Get-Location) "dist\Hellas Launcher.exe"
if (Test-Path $artifact) {
  $signature = Get-AuthenticodeSignature -FilePath $artifact
  if ($signature.Status -eq "Valid") {
    Write-Host "Authenticode signature valid: $($signature.SignerCertificate.Subject)" -ForegroundColor Green
  } elseif ($RequireSigned) {
    throw "Build artifact is not signed. Set CSC_LINK and CSC_KEY_PASSWORD to a trusted code-signing certificate, then rebuild."
  } else {
    Write-Host "Build artifact is not signed. Set CSC_LINK and CSC_KEY_PASSWORD for a signed release build." -ForegroundColor Yellow
  }
}

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
