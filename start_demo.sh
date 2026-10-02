#!/usr/bin/env bash
# One-shot launcher for the integrated BusTech demo on macOS/Linux.
#
#   bash start_demo.sh                 # dashboard + hub + Sense bridge on the packaged test clip (looped)
#   bash start_demo.sh 0               # same, but the bridge reads camera 0 (draw monitor_roi.json first, see README)
#   DEEPSEEK_API_KEY=sk-... bash start_demo.sh 0
#   LAN=1 bash start_demo.sh 0         # bind to 0.0.0.0 with a generated BRIDGE_TOKEN for phones / other PCs
#   BRIDGE_WINDOW=1 bash start_demo.sh 0   # also show the annotated camera view in a local window (Q stops the bridge)
#   BRIDGE_RECORD=1 bash start_demo.sh 0   # also save the raw camera frames to vision/recordings/ for replay
#
# Ports: dashboard 3000 · signal hub 8787 · camera MJPEG/health 8790. Ctrl+C stops everything.
# Override DASHBOARD_PORT, BRIDGE_PORT or VISION_PORT when a default port is busy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-demos/clips/wheelchair-003.mp4}"
command -v node >/dev/null || { echo "Node.js 22.13+ is required (brew install node)"; exit 1; }
[ -d "$ROOT/dashboard/node_modules" ] || (cd "$ROOT/dashboard" && npm ci --no-audit --no-fund)
[ -f "$ROOT/dashboard/public/twin/index.html" ] || bash "$ROOT/twin/sync_to_dashboard.sh"
[ -x "$ROOT/vision/.venv/bin/python" ] || { echo "vision/.venv missing. First run:  cd vision && python3 setup_environment.py"; exit 1; }

export BRIDGE_PORT="${BRIDGE_PORT:-8787}"
export DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
export VISION_PORT="${VISION_PORT:-8790}"
export NEXT_PUBLIC_VISION_PORT="${NEXT_PUBLIC_VISION_PORT:-$VISION_PORT}"
if [ "${LAN:-0}" = "1" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  export BRIDGE_HOST=0.0.0.0
  export BRIDGE_TOKEN="${BRIDGE_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_hex(16))')}"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://${IP}:${DASHBOARD_PORT},http://127.0.0.1:${DASHBOARD_PORT},http://localhost:${DASHBOARD_PORT}}"
  echo "LAN mode: dashboard http://${IP}:${DASHBOARD_PORT}  hub http://${IP}:${BRIDGE_PORT}  camera http://${IP}:${VISION_PORT}"
  echo "Access token (App / dashboard Connection settings): ${BRIDGE_TOKEN}"
else
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://127.0.0.1:${DASHBOARD_PORT},http://localhost:${DASHBOARD_PORT}}"
  echo "Dashboard http://127.0.0.1:${DASHBOARD_PORT}  hub http://127.0.0.1:${BRIDGE_PORT}  camera http://127.0.0.1:${VISION_PORT}"
fi

WINDOW_FLAG="--no-window"; [ -n "${BRIDGE_WINDOW:-}" ] && WINDOW_FLAG=""
RECORD_FLAG=""; [ -n "${BRIDGE_RECORD:-}" ] && RECORD_FLAG="--record $ROOT/vision/recordings/live_$(date +%H%M%S).mp4"
PIDS=()
cleanup() {
  trap - INT TERM EXIT
  [ "${#PIDS[@]}" -eq 0 ] || kill "${PIDS[@]}" 2>/dev/null || true
  [ "${#PIDS[@]}" -eq 0 ] || wait "${PIDS[@]}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Start the hub first so the bridge cannot accidentally post to another process
# already using the requested port. `exec` makes each recorded PID the service itself,
# so cleanup stops the service and not just the subshell around it.
(cd "$ROOT/dashboard" && exec node scripts/dev-integrated.mjs) &
PIDS+=("$!")
sleep 1
if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
  wait "${PIDS[0]}" || exit $?
  exit 1
fi
(cd "$ROOT/vision" && RIDE_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}" BRIDGE_TOKEN="${BRIDGE_TOKEN:-}" exec bash start_bridge.sh "$SRC" $WINDOW_FLAG --snapshots "$ROOT/vision/trigger_snapshots" $RECORD_FLAG --mjpeg-port "$VISION_PORT") &
PIDS+=("$!")

# macOS still ships Bash 3.2, so use a portable fail-fast monitor instead of
# `wait -n`: if either long-running service exits, stop the other one too.
while kill -0 "${PIDS[0]}" 2>/dev/null && kill -0 "${PIDS[1]}" 2>/dev/null; do
  sleep 1
done
echo "A demo process stopped; shutting down the remaining services." >&2
exit 1
