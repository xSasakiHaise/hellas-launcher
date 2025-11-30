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

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Python command resolved to '$pythonExecutable' but failed to run ($versionOutput). Install Python 3 with pip support and disable the Microsoft Store alias under Settings > Apps > App execution aliases."
    return
  }

  if ($versionOutput -match 'Python\s+(?<major>\d+)\.(?<minor>\d+)') {
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

function Ensure-JavaRuntime {
  $jreDir = Join-Path $PSScriptRoot "jre11-win64"
  $javaExe = Join-Path $jreDir "bin/java.exe"

  if (Test-Path $javaExe) {
    Write-Host "Bundled Java 11 runtime found at $javaExe." -ForegroundColor Green
    return
  }

  $downloadUrl = "https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.24+8/OpenJDK11U-jre_x64_windows_hotspot_11.0.24_8.zip"
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "hellas-launcher-jre11"
  $tempZip = Join-Path $tempRoot "jre11.zip"
  $extractDir = Join-Path $tempRoot "extracted"

  if (Test-Path $tempRoot) {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  Write-Host "Downloading Java 11 runtime..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip

  Write-Host "Extracting Java 11 runtime..." -ForegroundColor Cyan
  Expand-Archive -Path $tempZip -DestinationPath $extractDir -Force

  $extractedRoot = Get-ChildItem -Directory -Path $extractDir | Select-Object -First 1

  if (-not $extractedRoot) {
    throw "Failed to extract Java runtime from archive."
  }

  if (Test-Path $jreDir) {
    Remove-Item $jreDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  New-Item -ItemType Directory -Path $jreDir -Force | Out-Null
  Move-Item -Path (Join-Path $extractedRoot.FullName '*') -Destination $jreDir -Force

  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path $javaExe)) {
    throw "Bundled Java runtime install failed; $javaExe not found."
  }

  Write-Host "Bundled Java 11 runtime installed to $jreDir." -ForegroundColor Green
}

function Get-UnpackedResourcesDir {
  param([Parameter(Mandatory)][string]$DistRoot)

  if (-not (Test-Path $DistRoot)) {
    throw "Dist directory '$DistRoot' not found. Did the Electron build complete?"
  }

  $unpackedDir = Get-ChildItem -Path $DistRoot -Directory -Filter '*-unpacked' |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1

  if (-not $unpackedDir) {
    throw "Could not locate unpacked Electron app under $DistRoot. Check the electron-builder output path."
  }

  $resourcesDir = Join-Path $unpackedDir.FullName 'resources'
  if (-not (Test-Path $resourcesDir)) {
    throw "Resources directory not found at $resourcesDir"
  }

  return $resourcesDir
}

function Expand-JreArchive {
  param(
    [Parameter(Mandatory)][string]$ZipPath,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$Label
  )

  # If the ZIP is missing, download the appropriate runtime into /build-deps/
  if (-not (Test-Path $ZipPath)) {
    $zipDir = Split-Path $ZipPath -Parent
    if (-not (Test-Path $zipDir)) {
      New-Item -ItemType Directory -Force -Path $zipDir | Out-Null
    }

    $downloadUrl = $null
    switch ($Label) {
      'Java 8' {
        # Temurin 8 JRE, Windows x64 zip
        $downloadUrl = "https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u472-b08/OpenJDK8U-jre_x64_windows_hotspot_8u472b08.zip"
      }
      'Java 11' {
        # Temurin 11 JRE, Windows x64 zip
        $downloadUrl = "https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.24+8/OpenJDK11U-jre_x64_windows_hotspot_11.0.24_8.zip"
      }
    }

    if (-not $downloadUrl) {
      throw "Missing $ZipPath — and no download URL is configured for label '$Label'. Place the runtime ZIP into /build-deps/ or extend Expand-JreArchive."
    }

    Write-Host "Downloading $Label runtime for bundling..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $downloadUrl -OutFile $ZipPath
  }

  # Extract to a temp dir and then flatten into $Destination so that bin\javaw.exe is directly under it
  $tempRoot   = Join-Path ([IO.Path]::GetTempPath()) ("hellas-launcher-" + $Label.ToLower().Replace(' ', '-') + "-bundle")
  $extractDir = Join-Path $tempRoot "extracted"

  if (Test-Path $tempRoot) {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  Write-Host "Bundling $Label into $Destination ..." -ForegroundColor Cyan
  Expand-Archive -Path $ZipPath -DestinationPath $extractDir -Force

  $extractedRoot = Get-ChildItem -Directory -Path $extractDir | Select-Object -First 1
  if (-not $extractedRoot) {
    throw "Failed to extract $Label runtime from archive at $ZipPath."
  }

  if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  # Flatten one directory level so bin\javaw.exe ends up at $Destination\bin\javaw.exe
  Move-Item -Path (Join-Path $extractedRoot.FullName '*') -Destination $Destination -Force

  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue

  $javawPath = Join-Path $Destination "bin/javaw.exe"
  if (-not (Test-Path $javawPath)) {
    Write-Warning "$Label runtime was extracted, but bin\javaw.exe was not found at $javawPath. Check the archive layout."
  } else {
    Write-Host "$Label runtime bundled into $Destination." -ForegroundColor Green
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
Ensure-JavaRuntime

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Edit it as needed." -ForegroundColor Yellow
}

Install-NpmDependencies

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

try {
  $repoRoot = Split-Path $MyInvocation.MyCommand.Path -Parent
  $distDir = Join-Path $repoRoot "dist"
  $resourcesDir = Get-UnpackedResourcesDir -DistRoot $distDir

  $jre8Zip = Join-Path $repoRoot "build-deps\jre8-win-x64.zip"
  $jre11Zip = Join-Path $repoRoot "build-deps\jre11-win-x64.zip"

  $jre8Dir = Join-Path $resourcesDir "jre8"
  $jre11Dir = Join-Path $resourcesDir "jre11"

  if (-not (Test-Path (Join-Path $jre8Dir "bin/javaw.exe"))) {
    Expand-JreArchive -ZipPath $jre8Zip -Destination $jre8Dir -Label 'Java 8'
  } else {
    Write-Host "Bundled Java 8 already present at $jre8Dir. Skipping extraction." -ForegroundColor Green
  }

  if (-not (Test-Path (Join-Path $jre11Dir "bin/javaw.exe"))) {
    Expand-JreArchive -ZipPath $jre11Zip -Destination $jre11Dir -Label 'Java 11'
  } else {
    Write-Host "Bundled Java 11 already present at $jre11Dir. Skipping extraction." -ForegroundColor Green
  }

  Write-Host "Java bundling complete." -ForegroundColor Green
} catch {
  throw $_
}

Write-Host "`nBuild complete. Portable EXE is in the dist/ folder." -ForegroundColor Green
