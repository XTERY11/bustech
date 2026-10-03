#!/usr/bin/env bash
# Draw the stop region for a named scene and record which side the bus is on.
#   bash vision/draw_region.sh classroom "http://172.20.10.4:4747/video" down
# In the window: R clears, left-click the corners, ENTER saves, Q quits (the camera app allows one client).
# Bus side = the way a passenger leaves the region to board: up (deeper into the picture), down (towards
# the camera), left or right. Leaving any other way is not counted as boarding.
set -euo pipefail
cd "$(dirname "$0")"
SCENE="${1:?scene name, e.g. classroom}"; SRC="${2:?camera index or stream URL}"; DIR="${3:-}"
ROI="scenes/$SCENE.json"; mkdir -p scenes
[ -z "$DIR" ] && [ -f "$ROI" ] && DIR="$(.venv/bin/python -c 'import json,sys;print(json.load(open(sys.argv[1])).get("board_direction","up"))' "$ROI")"
DIR="${DIR:-up}"
case "$DIR" in up|down|left|right) ;; *) echo "bus side must be up, down, left or right"; exit 1;; esac
.venv/bin/python monitor_zone.py --source "$SRC" --roi "$ROI"
[ -f "$ROI" ] || { echo "No region saved."; exit 1; }
.venv/bin/python - "$ROI" "$DIR" <<'PY'
import json, sys
path, side = sys.argv[1:3]
roi = json.load(open(path)); roi['board_direction'] = side
json.dump(roi, open(path, 'w'), indent=2)
print(f'Scene saved: {path} (bus side: {side})')
PY
