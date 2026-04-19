param(
  [switch]$SkipInstall,
  [switch]$RequireSigned,
  [switch]$SelfSign,
  [string]$SelfSignCertPath = ".certs\hellas-local-code-signing.pfx",
  [string]$SelfSignPasswordPath = ".certs\hellas-local-code-signing.password.txt"
)
$ErrorActionPreference = "Stop"

function New-RandomPassword {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Get-LocalCodeSigningCertificate {
  param(
    [string]$PfxPath,
    [string]$PasswordPath
  )

  $certSubject = "CN=Hellas Launcher Local Code Signing"
  $certDir = Split-Path -Parent $PfxPath
  if (-not [string]::IsNullOrWhiteSpace($certDir) -and -not (Test-Path $certDir)) {
    New-Item -ItemType Directory -Path $certDir | Out-Null
  }

  if (-not (Test-Path $PasswordPath)) {
    New-RandomPassword | Set-Content -Path $PasswordPath -Encoding ASCII
  }

  $password = (Get-Content -Path $PasswordPath -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($password)) {
    throw "Self-sign password file is empty: $PasswordPath"
  }

  $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force

  if (-not (Test-Path $PfxPath)) {
    Write-Host "Creating local self-signed code signing certificate." -ForegroundColor Cyan
    $newCert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $certSubject `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyExportPolicy Exportable `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -NotAfter (Get-Date).AddYears(5)

    Export-PfxCertificate -Cert $newCert -FilePath $PfxPath -Password $securePassword | Out-Null
  }

  $imported = Import-PfxCertificate `
    -FilePath $PfxPath `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -Password $securePassword `
    -Exportable

  $cerPath = [System.IO.Path]::ChangeExtension($PfxPath, ".cer")
  Export-Certificate -Cert $imported -FilePath $cerPath | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null

  return Get-ChildItem "Cert:\CurrentUser\My" |
    Where-Object { $_.Thumbprint -eq $imported.Thumbprint } |
    Select-Object -First 1
}

function Set-AuthenticodeSignatureWithRetry {
  param(
    [string]$FilePath,
    [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
  )

  $lastError = $null
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      return Set-AuthenticodeSignature -FilePath $FilePath -Certificate $Certificate -HashAlgorithm SHA256
    } catch {
      $lastError = $_
      Write-Host "Signing attempt $attempt failed because the artifact is not ready yet. Retrying..." -ForegroundColor Yellow
      Start-Sleep -Seconds ([Math]::Min(12, $attempt * 2))
    }
  }

  throw $lastError
}

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
if ($SelfSign) {
  Write-Host "Local self-signing enabled. This is only trusted on machines that trust the generated certificate." -ForegroundColor Yellow
} elseif ($hasSigningConfig) {
  Write-Host "Code signing config detected via CSC_LINK." -ForegroundColor Cyan
} else {
  Write-Host "No code signing certificate configured. Build will be unsigned unless electron-builder finds a certificate in the Windows store." -ForegroundColor Yellow
}

npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

$artifact = Join-Path (Get-Location) "dist\Hellas Launcher.exe"
if (Test-Path $artifact) {
  if ($SelfSign) {
    $signingCert = Get-LocalCodeSigningCertificate -PfxPath $SelfSignCertPath -PasswordPath $SelfSignPasswordPath
    if ($null -eq $signingCert) {
      throw "Could not load local self-signing certificate."
    }

    Write-Host "Signing build artifact with local certificate: $($signingCert.Subject)" -ForegroundColor Cyan
    Set-AuthenticodeSignatureWithRetry -FilePath $artifact -Certificate $signingCert | Out-Null
  }

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
