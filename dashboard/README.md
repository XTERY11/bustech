# AccessRide: App + Python YOLO + DeepSeek + Web Demo

This integrates the existing RideAssistant_demo website with a signal server. App bookings and Python YOLO detections trigger DeepSeek; SSE delivers the decision summary and actions to the dashboard. **No physical vehicle or vehicle interface is required.** Stopping, door, ramp geometry and approval conditions come from a simulated scene. Results remain visible for presentation.

The interface, model summaries, rule-based results, error messages and passenger guidance are in English. Speech output uses the English locale `en-SG`.

For a step-by-step walkthrough of local startup, LAN access, app/YOLO integration and public backend configuration, see the [backend setup guide in Chinese](README_BACKEND.zh-CN.md).

## Run locally

Requires Node.js 22.13+. The Python signal client uses only the standard library.

```powershell
npm ci
# Start the website and signal server, then paste the key and press Enter.
# Input is hidden and the key is kept only in process memory.
node scripts/dev-integrated.mjs --key-stdin
```

Open <http://127.0.0.1:3000>. The signal server listens on `http://127.0.0.1:8787`. Select a scenario and click **Send signals & run**. Stop with Ctrl+C.

Alternatively, set `DEEPSEEK_API_KEY` before running `npm run dev:integrated`. Without a key, Offline rules still works. `.env.example` lists the configuration options; an optional local `.env` can be loaded with `node --env-file=.env scripts/dev-integrated.mjs`. Never expose the key through a `NEXT_PUBLIC_` variable.

## Send Python and app signals

Run a free HTTP integration demo in another terminal:

```powershell
python integrations/demo_signals.py --scenario wheelchair_auto --mode rules --seconds 8
```

The website automatically displays the external signals and their result. This script sends synthetic app and YOLO inputs through the real endpoints; the server supplies simulated vehicle conditions. The last result stays visible after sending stops. Use `--mode single` to call DeepSeek instead of using rules.

The vision team can use its existing Ultralytics environment and trained weights:

```powershell
python integrations/camera_yolo.py --weights path/to/your_model.pt --source 0
```

The script reads camera frames and sends labels, confidence and capture time. Configure the model class mapping for wheelchair/crutch detection. No geometric measurements or vehicle module are required. Use the website presets or the signal script before the camera/model is available.

| Endpoint | Payload |
|---|---|
| POST `/api/booking` | Current booking; see `request` in `backend/examples/input.json` |
| POST `/api/perception` | YOLO labels, confidence and optional track_id |

Both endpoints accept `{event_id, observed_at, payload}`. Use a new ID for each event and preserve the ID, timestamp and body when retrying. Python can reuse `integrations/ride_signal_client.py`; only the server calls DeepSeek.

## Connect a phone or another computer

For an on-site demo, put the devices on the same trusted LAN and run the server on the vision computer. Replace `192.168.1.20` below with that computer's actual LAN IP:

```powershell
$env:BRIDGE_HOST='0.0.0.0'
$env:BRIDGE_TOKEN='replace-with-your-random-access-token'
$env:ALLOWED_ORIGINS='http://192.168.1.20:3000,http://127.0.0.1:3000,http://localhost:3000'
node scripts/dev-integrated.mjs --key-stdin
```

Open `http://192.168.1.20:3000` on the phone and enter the token in **Connection settings**. The phone app posts to `http://192.168.1.20:8787/api/booking` with `Authorization: Bearer <access-token>`. Python on another computer sets `RIDE_BRIDGE_URL` and `BRIDGE_TOKEN`.

`0.0.0.0` is a bind address, not the address to open in a browser. Allow the required ports through the host firewall for your team. Use HTTPS and appropriate authentication for public hosting. This is a shared, single-booking competition prototype.

## Generation modes

- **Single call:** thinking is disabled; one request returns a short decision summary and actions. Default mode.
- **Two turns:** turn 1 produces and streams a short summary; turn 2 generates actions using the original context and that summary.
- **Offline rules:** the same policy runs without API charges, including in the browser when no server is connected.

The Thinking panel is a short explanation for the audience. `meta.source` identifies actual model output, rules, safety rules or fallback. All actions are displayed as simulations.

## GitHub Pages and Sites

The original GitHub Pages workflow and Sites build configuration are preserved. Static Pages can run the UI and offline presets. Live DeepSeek and external signals require a separate HTTPS server: set `NEXT_PUBLIC_API_BASE_URL` or enter its URL in Connection settings, then add the website origin, such as `https://dwjh.github.io`, to the server's `ALLOWED_ORIGINS`.

The current changes are local; no push or deployment has been made.

```text
npm run dev:integrated   Start the dashboard and signal server together
npm run bridge          Start only the signal server
npm test                Run 39 policy and communication checks without API calls
npm run build           Build the Sites/Cloudflare frontend
npm run build:pages     Run the Next build; Pages CI exports a static site
npm run test:render     Build and check server-rendered dashboard HTML
npm run lint            Run ESLint
```

## Team reference

- `docs/COMMUNICATION.md`: architecture, protocol choices, signal JSON and deployment options.
- `docs/VALIDATION.md`: real API and Python integration validation records.
- `backend/prompts/system_prompt.txt`: the English prompt used by DeepSeek.
- `backend/hub.mjs`: signal fusion, scene simulation, deduplication and stage events.
- `backend/planner/`: DeepSeek client, policy and action validator.
- `app/live-dashboard.tsx`: the English dashboard.
- `integrations/`: Python signal client, camera/YOLO adapter and demo publisher.

Wheelchair bookings with an explicit ramp request show **Deploy automatic ramp**. The crutch preset shows **Keep ramp stowed** and extra boarding time. Vision and hearing support show audio and display guidance respectively. The dashboard includes readable action labels, raw JSON, API calls, latency and token usage. Expand Simulation settings to edit preset conditions.
