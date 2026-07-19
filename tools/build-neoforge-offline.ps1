param(
  [string]$Version = "21.1.233",
  [string]$Java = "java"
)

$ErrorActionPreference = "Stop"

$work = Join-Path $env:TEMP "nfbuild-$Version"
$out  = Join-Path $PSScriptRoot "neoforge-$Version-offline.zip"
$installer = Join-Path $PSScriptRoot "neoforge-$Version-installer.jar"

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

Write-Host "Downloading installer $Version ..."
$url = "https://maven.neoforged.net/releases/net/neoforged/neoforge/$Version/neoforge-$Version-installer.jar"
$part = "$installer.part"
$ok = $false
for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
  try {
    if (Test-Path $part) { Remove-Item $part -Force }
    Invoke-WebRequest -Uri $url -OutFile $part -TimeoutSec 90
    Move-Item -LiteralPath $part -Destination $installer -Force
    $ok = $true
  } catch {
    if (Test-Path $part) { Remove-Item $part -Force }
    if ($attempt -eq 3) { throw }
    Start-Sleep -Seconds (2 * $attempt)
  }
}

$profiles = @{
  profiles = @{}
  selectedProfile = "(Default)"
  authenticationDatabase = @{}
  clientToken = "00000000-0000-0000-0000-000000000000"
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $work "launcher_profiles.json") -Value $profiles -Encoding utf8

Write-Host "Running installClient ..."
& $Java -jar $installer --installClient $work
if ($LASTEXITCODE -ne 0) { Write-Error "installer exited $LASTEXITCODE"; exit 1 }

$verJson = Join-Path $work "versions\neoforge-$Version\neoforge-$Version.json"
$uni     = Join-Path $work "libraries\net\neoforged\neoforge\$Version\neoforge-$Version-universal.jar"
if (-not (Test-Path $verJson)) { Write-Error "missing $verJson"; exit 1 }
if (-not (Test-Path $uni))     { Write-Error "missing $uni"; exit 1 }

Write-Host "Zipping -> $out"
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $work "versions"),(Join-Path $work "libraries") -DestinationPath $out

Write-Host "DONE offline zip: $out"
Write-Host "DONE installer:   $installer"
