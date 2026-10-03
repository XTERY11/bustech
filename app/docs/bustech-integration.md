# BusTech input stream 2 (native iOS)

Aligned to `/Users/franz/bustech/PROMPT.md` v0.3 (2026-10-01), sections 1–3 and module B. The user chose to retain the existing SwiftUI app instead of the document's web/PWA delivery form. Module C's frozen HTTP contract is unchanged. No BusTech repository files are modified.

## Use with the integration machine

1. Start the hub in the BusTech checkout. For a phone, use its documented `LAN=1 bash start_demo.sh` flow. Keep the phone and integration machine on the same reachable network.
2. In the iOS app, open **Settings → BusTech signal hub**, enable the receiver, enter the integration machine's IP/host and port (default **8787**), and enter its bridge token. The booking path is fixed to `/api/booking`. Do not put tokens in source files or version control. The token field is masked and kept in process memory only; re-enter it after relaunch. Development launches can alternatively supply `BRIDGE_TOKEN` in the process environment. Connection changes apply to new bookings; retries and cancellation retain the original connection.
3. Open **Assistant → Demo Booking**. The form defaults to `DEMO_ROUTE` / `DEMO_STOP`, which can be edited. Choose the requested help, ramp preference and optional accessibility need. The app uses spoken updates for vision support and on-screen updates otherwise; language stays at the API default en-SG. This entry point works without LTA data, location, microphone or Apple Intelligence. Map-based and voice requests use the same booking service and retain their selected real stop/service IDs.
4. Submit directly. After HTTP acceptance, the passenger card says **Request received by bus** and **Please proceed to** the map-style stop sign and stop name. This is product wording for service receipt; the app still does not fabricate a vehicle acknowledgement object. A fresh `context.perception.zone.triggered` event for the current active booking latches **You're all set!** and triggers one success haptic. Subsequent false signals, replanning and temporary disconnection do not remove the green state. Cancellation, replacement, expiry or a new request end that state.
5. Cancel on the same screen. The app sends a new `active:false` event and shows cancellation only after the hub accepts it. The dashboard then replans with the inactive booking.

For local simulator development, the hub can stay on `127.0.0.1`. An actual phone must use the integration machine's LAN address. Native URLSession requests do not use browser Origin/CORS, EventSource or Service Workers; the web/PWA-specific setup in PROMPT.md therefore does not apply to this delivery form. HTTP is for the trusted local demonstration; remote connections should use HTTPS. The existing local-network usage description and ATS local-network exception remain in place.

## First physical-phone test without camera or DeepSeek

For an app-to-hub check, start only the dashboard and hub. This does not require the vision virtual environment used by `start_demo.sh`:

```sh
cd /Users/franz/bustech/dashboard
npm ci
export BRIDGE_HOST=0.0.0.0
export BRIDGE_TOKEN="$(openssl rand -hex 16)"
printf 'App / dashboard token: %s\n' "$BRIDGE_TOKEN"
npm run dev:integrated
```

Keep that terminal open. On the Mac, open `http://localhost:3000`, expand **Connection settings**, set **Server URL** to `http://127.0.0.1:8787`, enter the generated token and press **Connect**. Choose **Offline rules · No API calls**. The Mac browser uses the hub's default allowed localhost origin.

On the phone, configure the hub with HTTP, the Mac's current Wi-Fi IP address, port 8787 and the same token. Allow local-network access when prompted. To check reachability separately, open `http://<Mac-IP>:8787/api/health` in the phone's Safari; a running reachable hub returns JSON with `ok: true`.

1. Open **Assistant → Demo Booking**; keep `DEMO_ROUTE` and `DEMO_STOP`, optionally choose **Wheelchair** under About you and explicitly request the ramp.
2. Submit and watch the dashboard's **Mobile app booking** update. The phone should show **Request received by bus** and the stop directions. With the current demo conditions and explicit ramp request, the rules planner can return **READY** without a camera signal; vehicle and geometry conditions are simulated.
3. Cancel from the phone. Verify **Booking cancelled** on the phone and an inactive booking / **NEEDS_CONFIRMATION** at the hub.
4. Run the vision bridge and enter its configured region. Verify **You're all set!**, then leave the region and confirm the green state remains. Reopening the request must not repeat the haptic. Select **Vision support** to check automatic spoken guidance. A phone is required to verify actual vibration and audio.

Do not run dashboard presets or the synthetic booking generator during this check: they can replace the hub's singleton phone booking. A new token is generated each time the export command runs; re-enter it in both clients. The app also needs its token re-entered after relaunch. If the Wi-Fi changes, recheck the Mac's IP address.

## Contract and behavior

| Requirement | Implementation |
|---|---|
| Submit `POST /api/booking` | `HubBookingEnvelope`: only `event_id`, `observed_at`, `payload`; frozen uppercase field vocabulary |
| All needs | Wheelchair, crutch, cane, walker, stroller, visual/hearing/mobility assistance, none and unknown |
| Ramp consent | Explicit REQUESTED / DECLINED / UNSPECIFIED; an aid alone does not imply consent; conflicting choices are rejected |
| Interaction / language | AUDIO / VISUAL / BOTH; en-SG / zh-CN; returned messages and audio language come from the hub |
| Retry | Original encoded bytes, event ID and observation time are retained per event, including ambiguous cancellation retries |
| Authentication | Bearer token on both booking POSTs and state GETs; no token persistence/logging |
| Receipt | Requires HTTP 202 and `accepted:true`; no fabricated vehicle ACK |
| Feedback | GET `/api/state` once per second plus authenticated `/api/events` SSE for short trigger pulses, while visible and active; cancellation closes both network tasks |
| Result correlation | Requires external source, matching `channels.booking.event_id`, route and stop; a running plan suppresses old results |
| Single booking | A replacement invalidates previous local feedback; before cancellation, check that the hub still holds this app's event |
| Five-minute lifetime | Expiry uses original observation/submission time, including after backgrounding or disconnection; hides old decisions and requires a new booking |
| Failure / reconnect | Removes stale decisions, shows an actionable message and retries state reads; failed POSTs require explicit retry |
| Passenger audio | Automatically AUDIO for vision support and VISUAL otherwise; speaks the displayed receipt/stop directions and first trigger confirmation |
| Local demonstration | With receiver disabled, explicitly labels the existing local simulation; it makes no hub request |

The model interprets intent only. It cannot choose or confirm a vehicle plan. Unsupported old client choices such as kneeling commands and haptic-only interaction are not sent to the frozen API. No transcript, name, image, fabricated ETA or direct actuator command is included in a booking.

## Upstream differences found in the current checkout

The inspected BusTech revision is `2ddbcb8`. Its `hub.mjs` deliberately keeps presentation snapshots with `observation_age_ms: 0`, so the current hub does **not** expire bookings after five wall-clock minutes as PROMPT.md describes. The app expires its own display at five minutes, but that cannot make the dashboard clear the upstream booking. The integration owner needs to reconcile this in module C; module B does not edit `hub.mjs`. Explicit cancellation still clears the active booking at the hub.

The current planner returns English (`en-SG`) passenger templates even when the submitted language is `zh-CN`. The app sends the chosen language faithfully and displays/reads the returned response without translating or inventing one.

The cancellation API has no conditional/compare-and-set parameter. The app checks the current event before cancelling, but another client could replace the singleton booking between that GET and POST. Fully atomic per-booking cancellation requires a future contract change by module C.

## Reproducible validation

The real-hub harness imports the original Node `SignalHub` and `createBridge` read-only, creates a fresh loopback listener with a random in-memory token, injects a wheelchair perception signal, and runs all unit tests (including native networking integration), the real-hub simulator submission/cancellation test, the existing manual/global-voice/contextual-voice UI flows, and the Dynamic Type map case. It stops its own listener afterward and requires both tests to have actually submitted and cancelled bookings. No DeepSeek key, camera or physical vehicle is required.

```sh
node scripts/test-bustech-integration.mjs /Users/franz/bustech
```

The default destination is iPhone 17 Pro Max / iOS 27.0 on this Mac. Override `BUSTECH_TEST_DESTINATION` or `DEVELOPER_DIR` if needed. Tokens are passed through test-runner environment variables, not command-line arguments or files.

For the regular unit and UI suite:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project 'BusPulse SG.xcodeproj' -scheme 'BusPulse SG' \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0' \
  -derivedDataPath .build/BusTechDerivedData -parallel-testing-enabled NO test
```

The two real-hub tests are intentionally skipped without the harness. Contract tests cover immutable retries, Bearer authentication, strict acceptance, cancellation, replacement, all plan statuses, expiry, stale-feedback removal and audio deduplication. Simulator speech/model inputs are deterministic; physical-device speech/model and LAN validation remain separate checks.

## Validation recorded on 2026-10-01

- Xcode 27 beta / iOS 27.0, iPhone 17 Pro Max Simulator: final app and test build succeeded.
- Final real-hub harness: **45 unit tests passed**, including the actual authenticated hub round trip; **5 UI tests passed** (real booking/cancel, manual request, global voice, contextual voice and accessibility Dynamic Type). The actual hub recorded two active bookings, two cancellations and two READY results, each cancellation returning the hub to NEEDS_CONFIRMATION.
- `cd /Users/franz/bustech/dashboard && npm test`: **40 passed**. The BusTech repository remained clean.
- Full UI run: 24 passed, the real-hub case skipped outside the harness, and the existing Dynamic Type map case initially failed because `service.select.7` was not found within its timeout. That case passed both on unchanged baseline `3b43dc6` and on the final source without a map-code change. The original failure's cause remains undetermined; do not describe the first full run as wholly passing.
- The real-hub feedback screenshot was exported and visually checked: status, exact passenger guidance, selected ramp preference and cancellation control were readable.
- Physical-phone LAN reachability, local-network permission behavior, real speech/model generation and audible playback have not been verified in this run. Vehicle behavior is simulated throughout.

## Passenger trigger state

The green state records a region trigger, independently of planner READY. `target_match_confirmed` is not required: the existing vision bridge explicitly reports it as false. This demo has a singleton booking and no per-person visual identity; the app correlates the booking event, route and stop, then accepts a recent perception observation made after submission. It does not claim the detector identified a specific passenger.

The latch and one-time feedback consumption live in the request service, surviving view recreation and false signals for the lifetime of the current in-memory request. Requests are not restored after process termination. Monitoring pauses off-screen/in the background. The current hub does not replay missed events; events entirely missed while disconnected cannot be recovered unless the current snapshot still contains a fresh positive trigger. No BusTech backend files are changed.

Arrival text uses the selected service/arrival slot from the existing arrival provider, refreshed every 30 seconds while the green card is visible and the app active. Countdown formatting matches the map. Missing, failed or stale estimates show **Arrival time unavailable.**, including demo routes without LTA data.

### Validation recorded on 2026-10-02

- Final trigger-flow harness: **48 unit tests and 5 UI tests passed**. The real hub accepted two bookings and two cancellations. An integration test captures true/false pulses through SSE without state polling, and the UI test keeps the green card through repeated trigger clearing.
- Unit checks cover automatic spoken feedback, mixed needs, trigger ownership/freshness, haptic-event consumption, cancellation/reset, connection loss, and missing arrival estimates.
- Exported screenshots were inspected for the map-style stop sign, LTA stop-name typography and green confirmation card. Physical haptic/audio output remains a device check.

### Arrival and upstream boarding guidance (PR #3)

The passenger card now progresses from “Please proceed to” to “You're all set!”
(the existing matched perception trigger), then “The bus is here”. The third
stage requires that trigger plus `context.vehicle_context` matching the booking's
route and stop, `motion_state == STOPPED`, `parking_brake_engaged == true`, and
`observation_age_ms` in 0–1500 ms. Missing vehicle data preserves the earlier UI.
LTA ETA is not used as proof of arrival.

The message is read from `result.passenger_communication.display_text`, falling
back to nonblank `audio_text`; while the planner is running or has no message,
the card says “Preparing your boarding guidance…”. NEEDS_CONFIRMATION and
CANNOT_EXECUTE messages are also shown verbatim. Arrival is not authorization
to board. Polling errors, cancellation, replacement and expiry remove the guidance.

PR https://github.com/XTERY11/bustech/pull/3 chooses an empty seat/wheelchair bay
from cabin occupancy upstream; the app does not allocate seats or generate a
second message. That hub currently supplies **simulated** vehicle context from
its fixture (including age zero), not a real vehicle arrival feed. Consequently,
the demo can move directly to stage three after recognition; actual separation
of stages two and three requires changing upstream vehicle telemetry.

For a deterministic three-stage UI check, start `python3 scripts/boarding_ui_fixture.py`
and run `testBoardingGuidanceThirdStage` with
`TEST_RUNNER_BOARDING_FIXTURE_URL=http://127.0.0.1:18789` in the xcodebuild environment.
This fixture verifies presentation and HTTP decoding, not real vehicle integration.

### CV signal 2: passenger boarding prompt

The app now consumes an explicit `context.perception.zone.event == "exit"` with
`triggered == false` through either SSE or state polling. It requires a previously
observed positive trigger for the current booking, the same nonempty `roi_id`,
and an observation no earlier than that entry. Existing booking/route/stop
correlation and freshness checks apply; plain false, stale exits, and exits before
entry do not trigger boarding. Legacy entry snapshots without an ROI still support
the original green confirmation, but cannot establish the paired exit.

Signal 2 latches **Please board the bus** in place of **The bus is here**, keeping
the current hub passenger guidance below it. It can advance the card without
vehicle-arrival telemetry. It is a presentation trigger, not a vehicle execution
command or proof of completed boarding. Disconnect hides the actionable prompt;
recovery restores the latch. Cancellation, replacement and expiry invalidate it.
During replanning, the existing preparing-guidance placeholder remains in use
instead of retaining a stale plan. Speech/haptic feedback is deduplicated per
boarding stage and plan/message.

The deterministic `scripts/boarding_ui_fixture.py` now supports stage 4 (explicit
exit) in addition to stages 1–3. `SignalTwoUITests` checks the new heading, unchanged
upstream guidance, latching and cancellation with `BOARDING_FIXTURE_URL` configured.

Signal-2 validation on 2026-10-03: iPhone 17 Pro Max / iOS 27.0 simulator,
unit runner reported 71 tests passing (the real-hub integration case skipped
without its harness); both `testBoardingGuidanceThirdStage` and
`SignalTwoUITests.testExitShowsBoardingPromptAndKeepsGuidance` passed against the
local fixture. This verifies native decoding, session behavior and UI, not
physical-camera/phone/vehicle integration.
