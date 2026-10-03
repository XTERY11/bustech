# BusTech integrated demo · Camera → YOLO → Hub → LLM → Dashboard + Digital Twin

> Start here: [HANDOFF.md](HANDOFF.md) (what works, how to run it) · [HANDOFF-APP.md](HANDOFF-APP.md) (the phone app: what it must do, how it connects, where to make small changes) · [PROMPT-APP.md](PROMPT-APP.md) (what the app owner does next: compile, run on a phone, report back) · [RUNBOOK.md](RUNBOOK.md) (real-camera acceptance: order of operations, signal flow, what each screen shows, where the waits are) · [docs/INTEGRATION.md](docs/INTEGRATION.md) (how teammate branches are absorbed into main) · interfaces in [PROMPT.md](PROMPT.md).

The native passenger app and three companion modules are wired into one open-loop demonstration:

```
                      ┌─────────────── vision/ (Python, port 8790) ───────────────┐
camera / video ──────►│ open-vocabulary detector + device tracking → stop-region trigger │
                      │   ├─ POST /api/perception  (enter = signal 1, exit = signal 2, heartbeat)│
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
| `app/` | Native BusPulse SG iOS app (SwiftUI) | Open `app/BusPulse SG.xcodeproj`; see [app setup](app/README.md) and [App–CV–Dashboard contract](app/docs/app-cv-dashboard-interface.md) |
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
bash start_demo.sh demos/captures/venue          # no camera, no YOLO: replays recorded venue clips (see below)
bash start_demo.sh "http://172.20.10.4:4747/video"   # real phone camera (draw the region first)
LAN=1 bash start_demo.sh demos/captures/venue    # also reachable from a phone: prints the LAN IP and an access token
DASHBOARD_PORT=3100 BRIDGE_PORT=8887 VISION_PORT=8890 bash start_demo.sh  # if the default ports are busy
```

For the DeepSeek planner, pass the key only through the environment, in the same terminal: `read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY`. Without a key choose **Offline rules** in the dashboard.

Open <http://127.0.0.1:3000>.

## The flow

One passenger at a time, three rounds, the same content on the phone and on the dashboard:

| Step | Signal | Hub (`journey.stage`) | Dashboard / twin | Phone |
|---|---|---|---|---|
| 1 | App → `POST /api/booking` with the chosen need (wheelchair, stroller, cane …) | `BOOKED`; the planner (DeepSeek or rules) runs **once** and assigns a seat or the wheelchair bay | reasoning summary, plan; twin waits | "Go to the bus stop", reserved place |
| 2 | Camera → `enter` (**signal 1**): the matching aid is in the stop region | `AT_STOP`, `matched` | the bus drives in, kneels, opens the door, deploys the ramp if planned (10 s) | "Bus arriving" → "Preparing to board", live twin |
| 3 | Camera → `exit` (**signal 2**): the passenger waited, then left towards the bus | `ON_BOARD` | passenger is guided through the cabin to the assigned place | seat / bay, step-by-step cabin directions, twin |

- An aid that does not match the booking only waits: the bus does not dock or open, the phone says to wait.
- Leaving sideways, towards the camera, or after less than 2 s is not boarding (`zone.boarding: false`): the journey returns to `BOOKED`.
- The camera may see several aids at once; the hub follows one booked passenger at a time and takes the next booking after boarding. Simultaneous boarding is out of scope.
- "Preview boarding" under the twin plays the boarding half on demand, for demos without a camera signal.

**Replay mode.** `demos/captures/venue/{wheelchair,stroller,cane}` are 15–18 s clips of a real venue test, already processed by the real bridge (annotated video + every hub signal with its time). `vision/replay_bridge.py` serves them on the bridge's own endpoints: after a booking it plays the clip matching the booked need, signal 1 after about 5 s and `ON_BOARD` about 10 s later. Simulate the App with the `curl` command in [HANDOFF-APP.md](HANDOFF-APP.md) section 5.

## Interfaces

**Perception** (`vision/yolo_bridge.py` → `POST /api/perception`)

```json
{ "event_id": "perception-…", "observed_at": "2026-10-03T10:00:00Z",
  "payload": { "yolo_detections": [{ "label": "WHEELCHAIR", "confidence": 0.96 }],
               "target_match_confirmed": true,
               "zone": { "triggered": true, "roi_id": "monitor_roi", "visit_id": "284e9188ab60", "event": "enter" } } }
```
`zone.event` is `enter`, `present` (heartbeat) or `exit`; all signals of one visit share `visit_id`. The exit carries `left` (the aids that were there), `boarding` (left towards the bus after waiting) and `dwell_seconds`. Full contract: [PROMPT.md](PROMPT.md) 2.3 and `dashboard/docs/COMMUNICATION.md`.

Model classes map as `wheelchair_with`/`wheelchair_without → WHEELCHAIR`, `cane → CANE`, `stroller → STROLLER` (new label; policy: extra boarding time, ramp stays stowed unless the App asks for it). Sent once on region entry, every `--heartbeat` seconds while occupied, and an empty list on exit.

**Video**: `GET http://<vision-host>:8790/stream.mjpg` (multipart JPEG), `GET /health` (fps, triggered, inside, detections). Set the URL in the dashboard's *Stream URL* control when the camera runs on another computer.

**Booking** (phone App → `POST /api/booking`) and what the App reads back (`journey`, `navigation` in `GET /api/state` / SSE): see [HANDOFF-APP.md](HANDOFF-APP.md) section 4.

**Twin** (dashboard → iframe): `{type:'twin:hello'}` handshake → `{type:'twin:ready'}`; then `{type:'twin:telemetry', frame}` where `frame` is the twin's `TelemetryMessage` (`door`, `ramp`, `kneeling`, `boardingStatus`, `announcement`, `passengerInfo`, `seatOccupancy`, `passengerJourney`). The action→frame timeline lives in `dashboard/app/lib/twinScenario.ts`.

| Hub action | Twin |
|---|---|
| plan running / NEEDS_CONFIRMATION | `boardingStatus: request_received` (+ operator announcement) |
| READY | `preparing` → door `opening/open` → (`DEPLOY_AUTOMATIC_SHORT_RAMP`: `kneeling`, ramp `extending/extended`) → `ready` |
| `KEEP_RAMPS_STOWED` | ramp stays `retracted` |
| `ACTIVATE_EXTERNAL_SPEAKER` / `CONFIRM_ROUTE_IDENTITY` | `announcement` = audio text |
| `SHOW_EXTERNAL_DISPLAY` / `EXTEND_DWELL_TIME` | `passengerInfo` = display text / "+60 s dwell time" |
| `GUIDE_PASSENGER_TO_ASSIGNED_PLACE` | highlight the validated empty seat/bay and animate the passenger through the cabin |
| `WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION` | show the passenger at the assigned place; keep the boarding state open pending operator confirmation |
| CANNOT_EXECUTE / `ABORT_*` | reset + "assistance paused" announcement |

## LAN demo (phone + separate vision PC)

`LAN=1 bash start_demo.sh 0` binds the hub to `0.0.0.0`, prints the LAN IP and a generated access token. Phone: open `http://<ip>:3000`, paste the token under *Connection settings*; the App posts to `http://<ip>:8787/api/booking` with `Authorization: Bearer <token>`. A vision PC runs `RIDE_BRIDGE_URL=http://<ip>:8787 BRIDGE_TOKEN=<token> bash vision/start_bridge.sh 0 --mjpeg-host 0.0.0.0`, and the dashboard's *Stream URL* is set to `http://<vision-ip>:8790`.

## Tests

```bash
cd dashboard && npm test                       # policy / communication / seat-allocation / journey checks
cd twin && npm test && npm run typecheck       # cabin and passenger-journey checks
cd vision && .venv/bin/python -m unittest test_aid_verifier test_monitor_zone test_signal_delivery test_bridge_signals
cd vision && .venv/bin/python yolo_bridge.py --source demos/clips/wheelchair_2.mp4 --roi monitor_example_roi.json --no-window --max-frames 120 --no-signal
```

## Not covered yet
- The iOS app has not been compiled with Xcode on the integration machine; see HANDOFF-APP.md section 2 for what was checked instead.
- The merged v0.5 journey has been run end to end with the replay and DeepSeek, not yet with the real camera.
- One passenger at a time by design: the hub keeps one active booking; the bridge reports region occupancy, not per-person identity.
