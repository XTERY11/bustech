#!/usr/bin/env bash
# Build the twin as a single HTML file and copy it to the dashboard's public folder.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build:single
mkdir -p ../dashboard/public/twin
cp dist-single/index.html ../dashboard/public/twin/index.html
echo "Copied dist-single/index.html -> dashboard/public/twin/index.html"
