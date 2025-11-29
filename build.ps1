param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-CommandAvailable {
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$InstallHint = "Install it and re-run this script."
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. $InstallHint"
  }
}

function Install-NpmDependencies {
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
    Join-Path $env:ProgramFiles "nodejs"
    Join-Path ${env:ProgramFiles(x86)} "nodejs"
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

function Test-PythonSupport {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue

  if (-not $pythonCommand -and $IsWindows) {
    $pythonCommand = Get-Command py -ErrorAction SilentlyContinue
  }

  if (-not $pythonCommand) {
    Write-Warning "Python was not found. Native npm modules may fail to compile. Install Python 3 from https://www.python.org/downloads/."
    return
  }

  $pythonExecutable = $pythonCommand.Path
  $versionOutput = & $pythonExecutable --version 2>&1

  if ($LASTEXITCODE -eq 0 -and $versionOutput -match 'Python\s+(?<major>\d+)\.(?<minor>\d+)') {
    $major = [int]$Matches.major
    if ($major -lt 3) {
      Write-Warning "Python 3 is required for native module builds. Detected version: $versionOutput"
      return
    }
  }

  & $pythonExecutable -m pip --version | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Pip is missing. Attempting to bootstrap it with ensurepip..." -ForegroundColor Yellow
    & $pythonExecutable -m ensurepip --upgrade

    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not initialize pip automatically. Install Python with pip support to avoid build issues."
      return
    }
  }

  foreach ($module in @("pip", "setuptools", "wheel")) {
    & $pythonExecutable -m pip show $module | Out-Null

    if ($LASTEXITCODE -ne 0) {
      Write-Host "Installing missing Python module '$module'..." -ForegroundColor Yellow
      & $pythonExecutable -m pip install --upgrade $module

      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to install Python module '$module'. Install it manually if native dependencies require it."
        return
      }
    }
  }

  $env:npm_config_python = $pythonExecutable
  Write-Host "Python runtime and core build modules detected. Exported npm_config_python for node-gyp." -ForegroundColor Green
}

function Test-JsonCompliance {
  param([string[]]$Paths)

  foreach ($path in $Paths) {
    if (-not (Test-Path $path)) {
      Write-Warning "$path not found. Skipping JSON validation."
      continue
    }

    try {
      Get-Content -Raw -Path $path | ConvertFrom-Json -ErrorAction Stop | Out-Null
      Write-Host "Validated JSON file: $path" -ForegroundColor Green
    } catch {
      throw "Invalid JSON in $path. Remove comments or trailing commas and try again. $($_.Exception.Message)"
    }
  }
}

Write-Host "== Hellas Launcher Build ==" -ForegroundColor Cyan

$nodeHint = "Install Node.js LTS (includes npm) from https://nodejs.org/en/download and re-run this script."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if ($IsWindows -and (Add-DefaultNodePath)) {
    Write-Host "Retrying Node.js detection after updating PATH..." -ForegroundColor Cyan
  }
}

Test-CommandAvailable node $nodeHint
node -v | Out-Null
Test-CommandAvailable npm $nodeHint

Test-PythonSupport
Test-JsonCompliance -Paths @("package.json", ".eslintrc.json")

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Edit it as needed." -ForegroundColor Yellow
}

Install-NpmDependencies

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
