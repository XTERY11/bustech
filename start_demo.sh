#!/usr/bin/env bash
# One-shot launcher for the integrated BusTech demo on macOS/Linux.
#
#   bash start_demo.sh                 # dashboard + hub + Sense bridge on the packaged test clip (looped)
#   bash start_demo.sh 0               # same, but the bridge reads camera 0 (draw monitor_roi.json first, see README)
#   DEEPSEEK_API_KEY=sk-... bash start_demo.sh 0
#   LAN=1 bash start_demo.sh 0         # bind to 0.0.0.0 with a generated BRIDGE_TOKEN for phones / other PCs
#   APP_ORIGINS=http://192.168.1.20:5173 LAN=1 bash start_demo.sh 0  # allow an external App origin
#   BRIDGE_WINDOW=1 bash start_demo.sh 0   # also show the annotated camera view in a local window (Q stops the bridge)
#   SCENE=classroom LAN=1 bash start_demo.sh "http://<phone>:4747/video"   # a named scene: its region + bus side
#   BRIDGE_RECORD=1 bash start_demo.sh 0   # also save the raw camera frames to vision/recordings/ for replay
#   bash start_demo.sh demos/captures/venue   # replay a recorded session (no camera, no YOLO);
#                                      # each pass starts once a booking arrives (AFTER_BOOKING=0: at once)
#
# Ports: dashboard 3000 · signal hub 8787 · camera MJPEG/health 8790. Ctrl+C stops everything.
# Override DASHBOARD_PORT, BRIDGE_PORT or VISION_PORT when a default port is busy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-demos/clips/wheelchair_2.mp4}"
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
  # The same token on every start of this machine, so the phone app and the dashboard keep working
  # across restarts. It is derived, not stored anywhere; set BRIDGE_TOKEN yourself to use another one.
  MACHINE_ID="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')"
  [ -n "$MACHINE_ID" ] || MACHINE_ID="$(cat /etc/machine-id 2>/dev/null || hostname)"
  export BRIDGE_TOKEN="${BRIDGE_TOKEN:-$(printf 'bustech-demo:%s:%s' "$MACHINE_ID" "$(id -un)" | shasum -a 256 | cut -c1-32)}"
  DEFAULT_ORIGINS="http://${IP}:${DASHBOARD_PORT},http://127.0.0.1:${DASHBOARD_PORT},http://localhost:${DASHBOARD_PORT}"
  [ -z "${APP_ORIGINS:-}" ] || DEFAULT_ORIGINS="${DEFAULT_ORIGINS},${APP_ORIGINS}"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${DEFAULT_ORIGINS}}"
  echo "LAN mode: dashboard http://${IP}:${DASHBOARD_PORT}  hub http://${IP}:${BRIDGE_PORT}  camera http://${IP}:${VISION_PORT}"
  echo "Access token (App / dashboard Connection settings): ${BRIDGE_TOKEN}"
  echo "Dashboard with token: http://127.0.0.1:${DASHBOARD_PORT}/#token=${BRIDGE_TOKEN}"
else
  DEFAULT_ORIGINS="http://127.0.0.1:${DASHBOARD_PORT},http://localhost:${DASHBOARD_PORT}"
  [ -z "${APP_ORIGINS:-}" ] || DEFAULT_ORIGINS="${DEFAULT_ORIGINS},${APP_ORIGINS}"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${DEFAULT_ORIGINS}}"
  echo "Dashboard http://127.0.0.1:${DASHBOARD_PORT}  hub http://127.0.0.1:${BRIDGE_PORT}  camera http://127.0.0.1:${VISION_PORT}"
fi

# SCENE picks the stop region and the side the bus is on: vision/scenes/<name>.json (drawn with
# vision/draw_region.sh). Without it the bridge uses vision/monitor_roi.json as before.
if [ -n "${SCENE:-}" ]; then
  [ -f "$ROOT/vision/scenes/$SCENE.json" ] || { echo "No scene vision/scenes/$SCENE.json. Draw it first:  bash vision/draw_region.sh $SCENE <camera> <up|down|left|right>"; exit 1; }
  export BUSTECH_ROI="scenes/$SCENE.json"
  echo "Scene: $SCENE ($(python3 -c 'import json,sys;r=json.load(open(sys.argv[1]));print("bus side:",r.get("board_direction","up"))' "$ROOT/vision/scenes/$SCENE.json"))"
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
if [ -f "$SRC/signals.jsonl" ] || ls "$SRC"/*/signals.jsonl >/dev/null 2>&1; then
  # A capture folder (yolo_bridge.py --capture): replay its video and signals instead of running YOLO.
  # The replay waits for a booking before each pass; AFTER_BOOKING=0 plays it straight away.
  CAPTURE="$(cd "$SRC" && pwd)"
  WAIT_FLAG="--after-booking"; [ "${AFTER_BOOKING:-1}" = "0" ] && WAIT_FLAG=""
  (cd "$ROOT/vision" && RIDE_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}" BRIDGE_TOKEN="${BRIDGE_TOKEN:-}" exec .venv/bin/python replay_bridge.py --capture "$CAPTURE" --loop $WAIT_FLAG --mjpeg-port "$VISION_PORT") &
else
  (cd "$ROOT/vision" && RIDE_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}" BRIDGE_TOKEN="${BRIDGE_TOKEN:-}" exec bash start_bridge.sh "$SRC" $WINDOW_FLAG --snapshots "$ROOT/vision/trigger_snapshots" $RECORD_FLAG --mjpeg-port "$VISION_PORT") &
fi
PIDS+=("$!")

# Open the dashboard once it answers (LAN mode passes the token in the fragment). NO_BROWSER=1 skips it.
if [ -z "${NO_BROWSER:-}" ] && command -v open >/dev/null; then
  ( for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${DASHBOARD_PORT}/" && break; sleep 1; done
    open "http://127.0.0.1:${DASHBOARD_PORT}/${BRIDGE_TOKEN:+#token=${BRIDGE_TOKEN}}" ) &
fi

# macOS still ships Bash 3.2, so use a portable fail-fast monitor instead of
# `wait -n`: if either long-running service exits, stop the other one too.
while kill -0 "${PIDS[0]}" 2>/dev/null && kill -0 "${PIDS[1]}" 2>/dev/null; do
  sleep 1
done
echo "A demo process stopped; shutting down the remaining services." >&2
exit 1
