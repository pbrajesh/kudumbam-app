# Pack the API server for the Raspberry Pi into deploy\out\kudumbam-app-<date>.zip
#   powershell -ExecutionPolicy Bypass -File deploy\package.ps1
# Contains server\ with the API code only: src, migrations, scripts, package.json, package-lock.json, tsconfig.json.
# Never includes .env files (not even .env.example), node_modules, the local database (.pgdata), tests, data or backups.
# Node runs the .ts files directly, so there is no build step; the type check below catches mistakes first.
# Install it on the Pi with install-update.sh from the web app's package (kudumbam-web, deploy\raspberry-pi).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$node = 'D:\nodejs-v24.11.0'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path "$node\node.exe")) { $env:Path = "$node;$env:Path" }

Push-Location $root
try {
  Write-Host 'Checking types…'
  npm run --silent typecheck
  if ($LASTEXITCODE -ne 0) { throw 'The type check failed.' }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $stage = Join-Path $root "deploy\out\stage-app-$stamp"
  New-Item -ItemType Directory -Force "$stage\server" | Out-Null
  foreach ($item in 'src', 'migrations', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json') {
    Copy-Item -Recurse $item "$stage\server\$item"
  }

  # Never ship settings or family data, even if something was dropped into these folders.
  Get-ChildItem -Recurse -Force $stage -Include '.env', '.env.*', '*.ged', '*.dump', 'backup-*.json', '.pgdata' |
    Remove-Item -Recurse -Force

  # Windows' tar writes a standard zip (-a picks the format from the .zip name); unzip on the Pi reads it.
  $out = Join-Path $root "deploy\out\kudumbam-app-$stamp.zip"
  tar -a -cf $out -C $stage server
  if ($LASTEXITCODE -ne 0) { throw 'Packing failed.' }
  Remove-Item -Recurse -Force $stage
  Write-Host ''
  Write-Host "Package: $out"
  Write-Host 'Copy it to the Pi, e.g.:'
  Write-Host "  scp `"$out`" <user>@familytree.local:"
} finally {
  Pop-Location
}
