# BusTech integrated demo · Camera → YOLO → Hub → LLM → Dashboard + Digital Twin

Three prototypes wired into one open-loop demonstration:

```
                      ┌─────────────── vision/ (Python, port 8790) ───────────────┐
camera / video ──────►│ YOLOv8n best.pt → ROI trigger (monitor_zone logic)         │
                      │   ├─ POST /api/perception  (only on enter / exit + heartbeat)│
                      │   └─ GET  /stream.mjpg · /health  (annotated frames)        │
                      └────────────────────────────┬───────────────────────────────┘
phone App ── POST /api/booking ──────────────────► │
                                                   ▼
                 dashboard/backend  (Node signal hub, port 8787): fuse → policy → DeepSeek or rules
                                                   │ SSE /api/events
                                                   ▼
          dashboard/ (Next.js, port 3000):  [Live camera] [Digital twin] / [Signals] [Thinking→Action] [Output]
                                                   │ postMessage({type:'twin:telemetry', frame})
                                                   ▼
                 twin/  (bus-digital-twin, built to dashboard/public/twin/index.html, `?embed=1`)
```

Open loop: the twin only *displays* the validated plan. Vehicle conditions stay simulated (`vehicle_context_source: SIMULATED_SCENARIO`); nothing is written back from the 3D model.

## Folders

| Folder | What | Entry points |
|---|---|---|
| `vision/` | YOLO runtime (Bustech-runtime package) + **new** `yolo_bridge.py`, `start_bridge.sh`, `ride_signal_client.py` | `bash setup_unix.sh` once · `bash start_bridge.sh [source]` |
| `dashboard/` | AccessRide dashboard + signal hub + DeepSeek planner | `npm ci` once · `node scripts/dev-integrated.mjs` |
| `twin/` | Bus digital twin (React Three Fiber) + **new** embed mode | `bash sync_to_dashboard.sh` after any twin change |
| `start_demo.sh` | Starts everything on one machine | `bash start_demo.sh [camera-or-video]` |

## First-time setup (macOS, Apple Silicon)

```bash
cd ~/Documents/bustech
cd vision && python3 setup_environment.py && cd ..   # creates vision/.venv (CPU torch; the bridge auto-selects mps if available)
cd dashboard && npm ci && cd ..
bash twin/sync_to_dashboard.sh                     # builds twin → dashboard/public/twin/index.html
```

Draw the boarding region once for the real camera (ENTER saves `vision/monitor_roi.json`):

```bash
cd vision && .venv/bin/python monitor_zone.py --source 0
```

## Run

```bash
bash start_demo.sh                       # test clip, looped, no API key: use "Offline rules"
DEEPSEEK_API_KEY=sk-... bash start_demo.sh 0  # camera + DeepSeek
DASHBOARD_PORT=3100 BRIDGE_PORT=8887 VISION_PORT=8890 bash start_demo.sh  # if the default ports are busy
```

Open <http://127.0.0.1:3000>. The top row shows the live annotated camera stream and the bus twin; the lower row is the original signal / reasoning / output workspace.

Demo flow:
1. A wheelchair, stroller or cane user enters the green region → the bridge posts the detection → the hub plans. With no booking the result is **NEEDS_CONFIRMATION** (perception alone never authorises a ramp) and the twin shows the operator announcement.
2. The App posts a booking (or run `python integrations/demo_signals.py --scenario wheelchair_auto --mode rules` from `dashboard/`) → **READY** → the twin kneels, opens the door, extends the ramp, shows "+60 s" / the passenger message.
3. Switch Generation mode to **DeepSeek · Single call** to show the model-generated summary; the twin animation is identical because actions are validated by the same policy.

## Interfaces

**Perception** (`vision/yolo_bridge.py` → `POST /api/perception`)

```json
{ "event_id": "perception-…", "observed_at": "2026-10-01T10:00:00Z",
  "payload": { "yolo_detections": [{ "label": "WHEELCHAIR", "confidence": 0.96 }],
               "target_match_confirmed": false, "zone": { "triggered": true, "roi_id": "monitor_roi" } } }
```
Model classes map as `wheelchair_with`/`wheelchair_without → WHEELCHAIR`, `cane → CANE`, `stroller → STROLLER` (new label; policy: extra boarding time, ramp stays stowed unless the App asks for it). Sent once on region entry, every `--heartbeat` seconds while occupied, and an empty list on exit.

**Video**: `GET http://<vision-host>:8790/stream.mjpg` (multipart JPEG), `GET /health` (fps, triggered, inside, detections). Set the URL in the dashboard's *Stream URL* control when the camera runs on another computer.

**Booking** (phone App → `POST /api/booking`): unchanged, see `dashboard/docs/COMMUNICATION.md`.

**Twin** (dashboard → iframe): `{type:'twin:hello'}` handshake → `{type:'twin:ready'}`; then `{type:'twin:telemetry', frame}` where `frame` is the twin's `TelemetryMessage` (`door`, `ramp`, `kneeling`, `boardingStatus`, `announcement`, `passengerInfo`). The action→frame timeline lives in `dashboard/app/lib/twinScenario.ts`.

| Hub action | Twin |
|---|---|
| plan running / NEEDS_CONFIRMATION | `boardingStatus: request_received` (+ operator announcement) |
| READY | `preparing` → door `opening/open` → (`DEPLOY_AUTOMATIC_SHORT_RAMP`: `kneeling`, ramp `extending/extended`) → `ready` |
| `KEEP_RAMPS_STOWED` | ramp stays `retracted` |
| `ACTIVATE_EXTERNAL_SPEAKER` / `CONFIRM_ROUTE_IDENTITY` | `announcement` = audio text |
| `SHOW_EXTERNAL_DISPLAY` / `EXTEND_DWELL_TIME` | `passengerInfo` = display text / "+60 s dwell time" |
| CANNOT_EXECUTE / `ABORT_*` | reset + "assistance paused" announcement |

## LAN demo (phone + separate vision PC)

`LAN=1 bash start_demo.sh 0` binds the hub to `0.0.0.0`, prints the LAN IP and a generated access token. Phone: open `http://<ip>:3000`, paste the token under *Connection settings*; the App posts to `http://<ip>:8787/api/booking` with `Authorization: Bearer <token>`. A vision PC runs `RIDE_BRIDGE_URL=http://<ip>:8787 BRIDGE_TOKEN=<token> bash vision/start_bridge.sh 0 --mjpeg-host 0.0.0.0`, and the dashboard's *Stream URL* is set to `http://<vision-ip>:8790`.

## Tests

```bash
cd dashboard && npm test                       # 42 policy/communication checks (incl. stroller)
cd vision && .venv/bin/python -m unittest test_monitor_zone -v
cd vision && .venv/bin/python yolo_bridge.py --source demos/clips/wheelchair-003.mp4 --roi monitor_example_roi.json --no-window --max-frames 120 --no-signal
```

## Not covered yet
- Real camera / RTSP on this Mac has not been exercised by the automated checks (only the packaged clips).
- The phone App's booking sender will be reviewed once its repository is available.
- Multiple simultaneous passengers: the hub keeps one active booking; the bridge reports region occupancy, not per-person tracks.
