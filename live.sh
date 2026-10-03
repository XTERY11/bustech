#!/usr/bin/env bash
# One command for a live-camera run: phone camera -> detection -> hub -> dashboard, phone app over the LAN.
#
#   bash live.sh                      # scene "classroom", camera at the address used last time
#   bash live.sh 172.20.10.4          # camera phone's address (DroidCam, port 4747)
#   SCENE=venue bash live.sh 172.20.10.4
#
# It waits for the camera, prints what to enter in the phone app, opens the dashboard connected to the
# hub, and shows the annotated camera window. Ctrl+C stops everything.
# The DeepSeek key is taken from DEEPSEEK_API_KEY if set, otherwise asked for once (not shown, not stored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.toolchain/env.sh" ] && source "$ROOT/.toolchain/env.sh"

SCENE="${SCENE:-classroom}"
LAST="$ROOT/vision/scenes/.last_camera"   # only the camera address of the previous run (not secret, git-ignored)
CAMERA="${1:-$(cat "$LAST" 2>/dev/null || true)}"
[ -n "$CAMERA" ] || { echo "Camera address needed once:  bash live.sh <phone ip>   (shown in DroidCam, e.g. 172.20.10.4)"; exit 1; }
case "$CAMERA" in http*) URL="$CAMERA";; *:*) URL="http://$CAMERA/video";; *) URL="http://$CAMERA:4747/video";; esac
[ -f "$ROOT/vision/scenes/$SCENE.json" ] || { echo "No scene '$SCENE'. Draw it:  bash vision/draw_region.sh $SCENE \"$URL\" <up|down|left|right>"; exit 1; }
echo "$CAMERA" > "$LAST"

for port in "${DASHBOARD_PORT:-3000}" "${BRIDGE_PORT:-8787}" "${VISION_PORT:-8790}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use: another demo is still running. Stop it first (Ctrl+C in its terminal)."; exit 1
  fi
done

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  printf 'DeepSeek key (Enter alone = offline rules): '; read -rs DEEPSEEK_API_KEY; echo
  [ -n "$DEEPSEEK_API_KEY" ] && export DEEPSEEK_API_KEY || unset DEEPSEEK_API_KEY
fi

BASE="${URL%/video}"
if ! curl -s -m 2 -o /dev/null "$BASE/"; then
  echo "Camera at $BASE does not answer yet: unlock the camera phone, bring DroidCam to the front, check its address."
  printf 'Waiting '; until curl -s -m 2 -o /dev/null "$BASE/"; do printf '.'; sleep 1; done; echo
fi
echo "Camera ok: $BASE"

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo
echo "================= enter in the phone app: Settings -> BusTech signal hub ================="
echo "  HTTP   host: ${IP:-unknown, run ipconfig getifaddr en0}   port: ${BRIDGE_PORT:-8787}"
echo "  token: printed below as 'Access token' (the same on every start of this computer)"
echo "=========================================================================================="
echo

SCENE="$SCENE" LAN=1 BRIDGE_WINDOW="${BRIDGE_WINDOW-1}" BRIDGE_RECORD="${BRIDGE_RECORD-1}" exec bash "$ROOT/start_demo.sh" "$URL"
