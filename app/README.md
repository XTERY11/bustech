# BusPulse SG

## BusTech repository integration

This `app/` directory imports the committed `mod-b-app` snapshot from
[apinfiniteloop/buspulse-sg](https://github.com/apinfiniteloop/buspulse-sg/tree/ba3f5c8bb27b8268175330dfd9571539dccf85b5),
commit `ba3f5c8bb27b8268175330dfd9571539dccf85b5`. It is checked-in source, not a submodule.
Local uncommitted changes, build outputs and private configuration are not imported.

Run the commands below from `app/`. Open `BusPulse SG.xcodeproj` for the native iOS client;
`dashboard/`, `twin/` and `vision/` remain sibling modules. Start the hub from the repository
root using its existing instructions, then configure **Settings → BusTech signal hub**
in the app with the reachable host, port and bridge token.

- [App–CV–Dashboard interface mechanism](docs/app-cv-dashboard-interface.md)
- [Hub setup and feedback behavior](docs/bustech-integration.md)
- Signal 2 (`exit` after a correlated entry) displays **Please board the bus** and retains the upstream boarding guidance.
- From `app/`, run `node scripts/test-bustech-integration.mjs ..` for the existing real-hub harness.
- Historical absolute paths and validation records below describe the original standalone checkout; use this repository layout for new runs.


BusPulse SG is a native, privacy-preserving Singapore bus app built with SwiftUI, MapKit, CoreLocation, Swift Concurrency, and LTA DataMall. It has no analytics, ads, accounts, or third-party packages.

The app uses deterministic mock data when no local LTA AccountKey is configured. Live acceptance was completed on 23 July 2026 with a developer-supplied key stored only in the ignored local secrets file; the key is not tracked by Git.

## Requirements

- macOS with a full Xcode that supports Swift 6
- An installed iOS Simulator runtime
- iOS 18 minimum deployment target
- An LTA DataMall AccountKey for live data; mock mode does not need one

This Mac currently has Xcode 27.0 beta (build 27A5228h) at `/Applications/Xcode-beta.app` while `xcode-select` points to Command Line Tools. Commands below therefore set `DEVELOPER_DIR` per process and do not change system settings. The project targets iOS 18 and avoids APIs newer than iOS 18, but a stable-Xcode verification remains advisable before release because the installed full Xcode is a beta.

## Open and run

1. Open `BusPulse SG.xcodeproj` in Xcode.
2. Choose an iPhone Simulator.
3. Run the `BusPulse SG` scheme.
4. With no key configured, the app clearly labels itself as using mock data. With a valid ignored local key, Settings reports **Live LTA DataMall**.

## Configure an LTA key for local development

1. Register or sign in on [LTA DataMall](https://datamall.lta.gov.sg/) and use **Request for API Access** under Dynamic Data.
2. Wait for LTA to issue the AccountKey.
3. Copy `Config/Secrets.xcconfig.example` to `Config/Secrets.xcconfig`.
4. Replace the placeholder value in the copied file. Never commit that file.
5. Clean and relaunch the app. Settings should show **Live LTA DataMall**.

An AccountKey embedded in an app bundle can be extracted. This configuration is development-only. A production release must send requests through a controlled server-side proxy that stores the key, applies quotas, and prevents abuse.

## Build and test

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project "BusPulse SG.xcodeproj" \
  -scheme "BusPulse SG" \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0' \
  -derivedDataPath .build/DerivedData \
  build

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project "BusPulse SG.xcodeproj" \
  -scheme "BusPulse SG" \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0' \
  -derivedDataPath .build/DerivedData \
  -parallel-testing-enabled NO \
  test
```

On this beta toolchain, disabling parallel test clones avoids an intermittent first-boot clone failure. It does not change test coverage.

To exercise live mode from the command line without copying a file, pass `LTA_ACCOUNT_KEY` as a build setting in a private terminal session. Be aware that shell history and process inspection can expose command-line values; the ignored xcconfig is the safer local workflow.

## Data behavior

- Cached stops, routes, and services appear before a refresh and remain searchable offline after the first successful sync.
- Static datasets are fetched in LTA's 500-record pages, validated as a complete snapshot, versioned, and atomically replaced.
- Apple Maps road geometry is cached on disk by adjacent stop pair for 30 days. Opening a route loads its saved line before drawing any fallback, fills only eligible missing or stale sections, saves each successful section immediately, and shares those sections with the main map. The route screen's refresh button deliberately rebuilds that route's cache.
- Directions refinement is serialized and held below Apple's burst ceiling at 40 requests per rolling 60-second window. Concurrent views reuse the same in-flight section request. Failed sections keep no fabricated geometry and use a persisted 15-minute-to-24-hour retry cooldown, so reopening a route does not loop the same failed request; manual refresh can retry immediately.
- Arrivals are shown exactly as supplied by BusArrival v3. Countdown seconds are rounded down as LTA specifies.
- Arrival polling runs only while the persistent Map board or a Favourites pinned-arrival row is visible and the app is active. Requests are per stop—not per pinned service—and are cancelled, deduplicated, and retried with bounded exponential backoff.

## Pre-arrival assistance demo

The centre **Assistant** tab opens directly to a voice-first journey screen; it does not require a passenger to select a stop or bus first. A passenger can name their current location or boarding stop, bus service, and required help in one English request. The selected-service map still exposes **Request Assistance** as a faster contextual path. Manual selection, contextual voice, and global voice all create the same validated `AssistanceRequest` and use the same delivery state machine. **Settings → Start screen → Assistant** can make this voice screen the app's launch destination.

- Speech transcription uses Apple's Speech framework. On-device recognition is required when the current recognizer supports it; otherwise the system recognizer remains the fallback.
- Natural-language understanding uses Apple Foundation Models on device. It is available only on supported Apple Intelligence hardware and system versions. The app detects unsupported, disabled, and not-ready states and routes the passenger to the manual flow without crashing.
- Foundation Models generates constrained journey fields, assistance fields, and a pre-acknowledgement passenger response. For a global request, `AssistanceJourneyResolver` validates the model's stop/service references against local LTA stop and route data, fetches that stop's arrival board, and creates context from a real `ArrivalEstimate`. It never accepts a model-generated ETA or unverified journey.
- `VehicleCloudServing` isolates delivery from the UI and model. With no receiver enabled, the demo uses `MockVehicleCloudService`, including visible send and acknowledgement delays. **Settings → BusTech signal hub** configures an HTTP/HTTPS host and port, with a session-only bridge token. `HTTPVehicleCloudService` sends the frozen `/api/booking` envelope, requires `202 accepted:true`, and polls `/api/state` for correlated passenger feedback. A receipt never becomes a fabricated vehicle acknowledgement.
- The production app does not call a cloud LLM. Deterministic speech and model responses are injected only for the existing `-ui-testing` simulator mode.

**Assistant → Demo Booking** provides a manual BusTech form with editable demo route/stop IDs, all ten accessibility needs, explicit ramp preference, interaction and language. It uses the same send/cancel pipeline as map and voice requests. Feedback displays the hub's READY / NEEDS_CONFIRMATION / CANNOT_EXECUTE status and passenger message, with optional audio for AUDIO/BOTH. The prototype keeps one current booking and the app expires its feedback after five minutes.

The local mock and BusTech hub both demonstrate simulated vehicle behavior. See [BusTech integration](docs/bustech-integration.md) for LAN setup, the actual-hub test harness, contract coverage and upstream expiry/language differences.

## Documentation

- [BusTech input stream 2 integration](docs/bustech-integration.md)
- [Architecture](docs/architecture.md)
- [Glance-first information architecture](docs/information-architecture.md)
- [Research](docs/research.md)
- [Functional benchmark matrix](docs/feature-matrix.md)
- [Milestones](docs/milestones.md)
- [Accessibility checklist](docs/accessibility-checklist.md)
- [Smoke-test checklist](docs/smoke-test-checklist.md)
- [Performance measurements](docs/performance.md)
- [Supplied font provenance](docs/font-provenance.md)
- [Runtime warning audit](docs/runtime-warning-audit.md)

## Known limitations

- Live BusArrival v3 acceptance succeeded for real stop `01012` on 23 July 2026, and the simulator app displayed real monitored arrivals at stop `01619`. The configured AccountKey remains a local development secret and is intentionally absent from the repository.
- The current verification used the installed Xcode 27.0 beta/iOS 27.0 Simulator, not a stable Xcode installation.
- The deterministic glance-first acceptance bundle covers decoding and operating-hours edge cases, conservative interchange classification, local typography and start-screen preferences, compact ETA semantics, pinned ETAs in Favourites, native pinned-stop scrolling, two-way MapKit pinch zoom, three stop-marker levels, inline route/bus overlays, mixed active/inactive service rows, accessibility Dynamic Type, Search/Favourites handoff, pull-to-refresh, dark mode, and pin-only service controls. Exact suite counts and timings are recorded in [docs/performance.md](docs/performance.md).
- The service line drawn on the main map uses only successfully cached Apple Maps road sections; it never connects stops with visible straight-line substitutes. DataMall supplies stop sequence and distance rather than an authoritative road polyline, so the road-aligned result remains an approximation rather than an exact operational path.
- The full route sheet always has the complete cached LTA stop sequence. It focuses slightly above the invoking stop, highlights the same stop on its map, and keeps dotted schematic fallbacks only inside this explanatory full-route view while road sections are unavailable.
- A one-shot whole-network Apple Directions download is intentionally absent. The live 25 July 2026 LTA snapshot contains 7,881 unique directed adjacent-stop pairs; even the app's maximum safe request rate gives a theoretical lower bound of about 197 minutes, so a short blocking update dialog would be misleading.
- Mock bus locations and arrivals are deterministic demonstrations, not live claims.
- With the receiver enabled, bookings and passenger feedback use the real BusTech HTTP contract; vehicle behavior remains simulated. With it disabled, receipt and acknowledgement use the labelled local mock. Speech recognition and Foundation Models are Apple framework integrations on supported devices; simulator tests inject deterministic speech/model outputs.
- The user-supplied LTA Identity binary is enabled by default for stop and service identity and can be disabled under **Settings → Appearance**. Its redistribution status has not been cleared for a production release.
- Static transit data can be refreshed manually in Settings; background refresh is not part of this milestone.
- DataMall does not expose a regular-stop/interchange type. Overview interchange symbols are conservatively derived from terminal words in LTA's stop description and may omit facilities whose description does not identify them.
- Alight-reminder buttons are present but disabled and clearly marked as a later-release action. Alight reminders, Apple Watch, widgets, and an MRT map remain phase-2 work.

## Optional conversational assistant

Settings → Assistant → **Conversational assistant** enables the Groq Whisper + DeepSeek flow. It defaults off and preserves the original experience. The new flow runs its conversation state on the phone and calls provider APIs directly, without a Mac assistant service. Enter the Groq and DeepSeek API keys once in Settings → Assistant → Add API keys; they remain in this iPhone’s Keychain after restart. See [architecture and testing](docs/direct-assistant.md).
