#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
python3 setup_environment.py --backend "${BUSTECH_BACKEND:-auto}"
bash start_monitor.sh
