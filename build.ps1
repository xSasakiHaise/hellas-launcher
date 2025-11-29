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

function Add-DefaultNodePath {
  # Try to add a standard Windows install location for Node.js to PATH if it's missing.
  # Returns $true if a path was added and $false otherwise.
  $defaultNodeDirs = @(
    Join-Path $env:ProgramFiles "nodejs",
    Join-Path $env:"ProgramFiles(x86)" "nodejs"
  ) | Where-Object { $_ }

  foreach ($dir in $defaultNodeDirs) {
    $nodeExe = Join-Path $dir "node.exe"
    if (-not (Test-Path $nodeExe)) { continue }

    $pathEntries = $env:Path -split ";"
    if ($pathEntries -notcontains $dir) {
      $env:Path = "$dir;" + $env:Path
      Write-Host "Detected Node.js at $dir and added it to PATH for this session." -ForegroundColor Yellow
    }

    return $true
  }

  return $false
}

Write-Host "== Hellas Launcher Build ==" -ForegroundColor Cyan

$nodeHint = "Install Node.js LTS (includes npm) from https://nodejs.org/en/download and re-run this script."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if ($IsWindows -and (Add-DefaultNodePath)) {
    Write-Host "Retrying Node.js detection after updating PATH..." -ForegroundColor Cyan
  }
}

Ensure-Command node $nodeHint
node -v | Out-Null
Ensure-Command npm $nodeHint

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Edit it as needed." -ForegroundColor Yellow
}

Ensure-NpmDependencies

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
