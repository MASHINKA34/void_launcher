param(
  [string]$ModsDir = (Join-Path $PSScriptRoot "staging-mods"),
  [string]$Repo    = "MASHINKA34/void_launcher",
  [string]$Tag     = "mods",
  [string]$ManifestPath = (Join-Path $PSScriptRoot "..\mods-list.json")
)

$ErrorActionPreference = "Stop"

gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run: gh auth login"; exit 1 }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.Count -eq 0) { Write-Error "Manifest is empty"; exit 1 }

$versions = @($manifest | ForEach-Object { $_.manifestVersion } | Sort-Object -Unique)
if ($versions.Count -ne 1 -or -not $versions[0]) { Write-Error "Manifest version is invalid"; exit 1 }

$AssetTag = "$Tag-$($versions[0])"
$expected = @{}
foreach ($mod in $manifest) {
  if (-not $mod.filename -or -not $mod.sha256 -or -not $mod.size) { Write-Error "Invalid manifest entry"; exit 1 }
  $assetName = [Uri]::UnescapeDataString(([Uri]$mod.url).Segments[-1])
  if (-not $assetName -or $expected.ContainsKey($assetName)) { Write-Error "Duplicate: $assetName"; exit 1 }

  $filePath = Join-Path $ModsDir $assetName
  if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { Write-Error "Missing: $($mod.filename)"; exit 1 }

  $file = Get-Item -LiteralPath $filePath
  $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash
  $expectedUrl = "https://github.com/$Repo/releases/download/$AssetTag/$assetName"
  if ($file.Length -ne $mod.size -or $hash -ne $mod.sha256 -or $mod.url -ne $expectedUrl) {
    Write-Error "Manifest mismatch: $($mod.filename)"
    exit 1
  }
  $expected[$assetName] = $file.Length
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$null = gh release view $AssetTag -R $Repo 2>$null
$releaseExists = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previousErrorActionPreference
if (-not $releaseExists) {
  Write-Host "Creating release '$AssetTag'..."
  gh release create $AssetTag -R $Repo --title $AssetTag --notes "Modpack mods" --latest=false
  if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create release: $AssetTag"; exit 1 }
}

$jars = Get-ChildItem -Path $ModsDir -Filter *.jar -File
if ($jars.Count -ne $manifest.Count) { Write-Error "Staging contains unexpected files"; exit 1 }

Write-Host "Uploading $($jars.Count) jars to $Repo @ $AssetTag ..."

$i = 0
foreach ($jar in $jars) {
  $i++
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    Write-Host "[$i/$($jars.Count)] $($jar.Name) (try $attempt)"
    gh release upload $AssetTag $jar.FullName -R $Repo --clobber
    if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds (2 * $attempt) }
  }
  if (-not $ok) { Write-Error "Failed: $($jar.Name)"; exit 1 }
}

$release = gh release view $AssetTag -R $Repo --json assets | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $release.assets.Count -ne $expected.Count) { Write-Error "Release verification failed"; exit 1 }
foreach ($asset in $release.assets) {
  if (-not $expected.ContainsKey($asset.name) -or $expected[$asset.name] -ne $asset.size) {
    Write-Error "Release verification failed: $($asset.name)"
    exit 1
  }
}

Write-Host "Done: $($jars.Count) jars uploaded."
