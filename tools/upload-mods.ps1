param(
  [string]$ModsDir = (Join-Path $PSScriptRoot "staging-mods"),
  [string]$Repo    = "MASHINKA34/void_launcher",
  [string]$Tag     = "mods"
)

$ErrorActionPreference = "Stop"

gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run: gh auth login"; exit 1 }

$exists = gh release view $Tag -R $Repo 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating release '$Tag'..."
  gh release create $Tag -R $Repo --title $Tag --notes "Modpack mods" --latest=false
}

$jars = Get-ChildItem -Path $ModsDir -Filter *.jar -File
Write-Host "Uploading $($jars.Count) jars to $Repo @ $Tag ..."

$i = 0
foreach ($jar in $jars) {
  $i++
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    Write-Host "[$i/$($jars.Count)] $($jar.Name) (try $attempt)"
    gh release upload $Tag $jar.FullName -R $Repo --clobber
    if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds (2 * $attempt) }
  }
  if (-not $ok) { Write-Error "Failed: $($jar.Name)"; exit 1 }
}

Write-Host "Done: $($jars.Count) jars uploaded."
