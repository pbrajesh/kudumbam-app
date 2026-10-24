#!/usr/bin/env bash
# Pack the API server for the Raspberry Pi into deploy/out/kudumbam-app-<date>.zip
#   bash deploy/package.sh
# Contains server/ with the API code only: src, migrations, scripts, package.json, package-lock.json, tsconfig.json.
# Node runs the .ts files directly, so there is nothing to build; run npm run typecheck yourself first if you like.
# Never includes .env files (not even .env.example), node_modules, the local database (.pgdata), tests, data or backups.
# Install it on the Pi with install-server.sh from the web app's package (kudumbam-web, deploy/raspberry-pi).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

stamp=$(date +%Y%m%d-%H%M)
stage="deploy/out/stage-app-$stamp"
out="$root/deploy/out/kudumbam-app-$stamp.zip"
rm -rf "$stage"
mkdir -p "$stage/server"
trap 'rm -rf "$root/$stage"' EXIT

cp -R src migrations scripts package.json package-lock.json tsconfig.json "$stage/server/"

# Never ship settings or family data, even if something was dropped into these folders.
find "$stage" \( -name '.env' -o -name '.env.*' -o -name '*.ged' -o -name '*.dump' -o -name 'backup-*.json' -o -name '.pgdata' \) -exec rm -rf {} +

# zip if installed, otherwise Python (Git Bash on Windows has neither zip nor a tar that writes zips).
(
  cd "$stage"
  if command -v zip >/dev/null 2>&1; then zip -qr "$out" server
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -c "$out" server
  elif command -v python >/dev/null 2>&1; then python -m zipfile -c "$out" server
  else echo "Install zip (or Python) to make the package."; exit 1
  fi
)
echo "Package: $out"
echo "Copy it to the Pi, e.g.:  scp \"$out\" <user>@familytree.local:"
