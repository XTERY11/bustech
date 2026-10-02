#!/usr/bin/env bash
# Start the Sense bridge: YOLO + ROI trigger -> signal hub, with an MJPEG preview.
# Usage: bash start_bridge.sh [source] [extra yolo_bridge.py args...]
#   source: camera index (0), a video path, or an RTSP/HTTP URL. Default: the packaged test clip, looped.
set -euo pipefail
cd "$(dirname "$0")"
PY=".venv/bin/python"; [ -x "$PY" ] || PY="python3"
SRC="${1:-demos/clips/wheelchair-003.mp4}"; shift || true
ROI="${BUSTECH_ROI:-monitor_roi.json}"
EXTRA=()
case "$SRC" in demos/*) ROI="monitor_example_roi.json"; EXTRA+=(--loop);; esac
if [ ! -f "$ROI" ]; then
  echo "No region file $ROI. Draw one first (ENTER saves):"; echo "  $PY monitor_zone.py --source $SRC --roi $ROI"; exit 1
fi
exec "$PY" yolo_bridge.py --source "$SRC" --roi "$ROI" ${EXTRA[@]+"${EXTRA[@]}"} "$@"
