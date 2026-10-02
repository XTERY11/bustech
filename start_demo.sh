#!/usr/bin/env bash
# One-shot launcher for the integrated BusTech demo on macOS/Linux.
#
#   bash start_demo.sh                 # dashboard + hub + Sense bridge on the packaged test clip (looped)
#   bash start_demo.sh 0               # same, but the bridge reads camera 0 (draw monitor_roi.json first, see README)
#   DEEPSEEK_API_KEY=sk-... bash start_demo.sh 0
#   LAN=1 bash start_demo.sh 0         # bind to 0.0.0.0 with a generated BRIDGE_TOKEN for phones / other PCs
#   BRIDGE_WINDOW=1 bash start_demo.sh 0   # also show the annotated camera view in a local window (Q stops the bridge)
#
# Ports: dashboard 3000 · signal hub 8787 · camera MJPEG/health 8790. Ctrl+C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-demos/clips/wheelchair_test.mp4}"
command -v node >/dev/null || { echo "Node.js 22.13+ is required (brew install node)"; exit 1; }
[ -d "$ROOT/dashboard/node_modules" ] || (cd "$ROOT/dashboard" && npm ci --no-audit --no-fund)
[ -f "$ROOT/dashboard/public/twin/index.html" ] || bash "$ROOT/twin/sync_to_dashboard.sh"
[ -x "$ROOT/vision/.venv/bin/python" ] || { echo "vision/.venv missing. First run:  cd vision && python3 setup_environment.py"; exit 1; }

export BRIDGE_PORT="${BRIDGE_PORT:-8787}"
if [ "${LAN:-0}" = "1" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  export BRIDGE_HOST=0.0.0.0
  export BRIDGE_TOKEN="${BRIDGE_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_hex(16))')}"
  export ALLOWED_ORIGINS="http://${IP}:3000,http://127.0.0.1:3000,http://localhost:3000"
  echo "LAN mode: dashboard http://${IP}:3000  hub http://${IP}:8787  camera http://${IP}:8790"
  echo "Access token (App / dashboard Connection settings): ${BRIDGE_TOKEN}"
else
  echo "Dashboard http://127.0.0.1:3000  hub http://127.0.0.1:8787  camera http://127.0.0.1:8790"
fi

WINDOW_FLAG="--no-window"; [ -n "${BRIDGE_WINDOW:-}" ] && WINDOW_FLAG=""
cleanup() { trap - INT TERM; kill 0 2>/dev/null || true; }
trap cleanup INT TERM EXIT
(cd "$ROOT/vision" && RIDE_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}" BRIDGE_TOKEN="${BRIDGE_TOKEN:-}" bash start_bridge.sh "$SRC" $WINDOW_FLAG) &
sleep 1
(cd "$ROOT/dashboard" && node scripts/dev-integrated.mjs) &
wait
