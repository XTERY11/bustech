# Architecture

## Shape

BusPulse SG uses feature-oriented SwiftUI views over a small protocol-driven core:

```text
App
├── Root tabs and dependency container
├── Assistant
│   └── voice-first stop/current-location, service, and assistance request
├── Map
│   ├── viewport-filtered MKMapView
│   ├── native lazy nearby-stop scroll surface
│   └── persistent stop board
│       ├── compact route and ETA rows
│       ├── inactive-service resume rows
│       ├── inline route and next-three reported-location map
│       ├── next-bus pre-arrival assistance action
│       └── native route sheet
│           ├── road-aligned preview map
│           └── connected LTA stop sequence
├── Search (stop locator)
├── Favourites (saved-stop launcher)
├── Settings
└── Core
    ├── models and LTA decoding
    ├── live/mock providers
    ├── versioned atomic cache
    ├── local preferences
    ├── location service
    ├── constrained local accessibility assistant and speech recognition
    ├── unified assistance request state machine
    ├── replaceable mock vehicle cloud
    └── search, countdown, backoff, and signposts
```

Views and observable feature state are `@MainActor`. Network requests, decoding, caching, preference JSON/persistence, and search indexing live in actor-isolated work; snapshot validation runs in a detached utility task. All data access is exposed through `TransitDataProviding`, so deterministic mock behavior and live LTA behavior share the same product UI.

## Data flow

1. `TransitDataStore` asks `TransitCache` for the last valid snapshot.
2. Cached content is published immediately.
3. The configured provider refreshes BusStops, BusRoutes, and BusServices away from the main actor.
4. `TransitSnapshotValidator` rejects incomplete or malformed replacements.
5. `TransitCache` atomically writes the validated, schema-versioned envelope.
6. Search and the map read the same in-memory snapshot. Search keeps all stops; the map renders only a bounded visible subset.

BusArrival is intentionally not smoothed or persisted as a prediction. The focused stop board and active pinned-Favourites rows request it through `ArrivalRequestCoordinator`, which coalesces concurrent work by stop code. Each consumer owns a cancellation-aware 20-second loop and exponential backoff. Changing or collapsing stops, leaving the owning tab, or deactivating the app cancels its task. A Favourites row makes one stop request and filters the returned board to locally pinned services; it never requests each service separately. Scheduled services missing from a Map response are evaluated against cached BusRoutes first/last-bus fields; non-operating services remain below live services with the next scheduled start, while operating services with no estimate retain an honest unavailable state.

Search and Favourites do not create competing stop-detail stacks. Choosing a row records the relevant local state, switches to Map, and focuses that row in the canonical Map list. This keeps the selected stop and map context in one predictable location.

## Pre-arrival assistance flow

There are two journey entry points. The selected-service map exposes one compact action for its first upcoming arrival and builds `AssistanceContext` from the focused `BusStop`, selected `ServiceArrivals`, and first `ArrivalEstimate`. The centre Assistant tab opens directly to a global voice screen. Its structured model output separates the named service, current-location/stop reference, and assistance need. `AssistanceJourneyResolver` resolves those journey fields against the local stop search index and route snapshot, fetches that stop's arrival board, and builds `AssistanceContext` from an actual upcoming estimate. The model cannot create or rewrite stop, route, or ETA data.

Manual selection, selected-journey voice, and global voice all produce `AssistanceRequest`. The model contains travel intent, a specific accessibility need, explicit ramp preference, feedback language, preferred interaction, and a validated list of requested assistance options. `LocalAccessibilityAssistantService` uses Apple Foundation Models constrained generation on supported iOS 26+ Apple Intelligence devices. It checks `SystemLanguageModel.availability`, never invokes a remote LLM, and rejects malformed category/action combinations. Its passenger response is also guarded against claiming acknowledgement before delivery. Unsupported systems, ineligible devices, disabled Apple Intelligence, a model still preparing, speech failure, no speech, and generation failure all retain a route to the existing map/manual flow.

`SpeechRecognitionService` owns English Apple Speech transcription and audio-session lifecycle outside SwiftUI views. AVAudioEngine's real-time tap and Speech's result handler are created in explicit nonisolated contexts, then hop to `MainActor` only when observable state changes; this prevents iOS 27's Swift executor checks from trapping an audio callback on the framework queue. `AssistanceRequestService` alone owns `draft`, `readyToSend`, `sending`, `sent`, `received`, `failed`, `cancelled`, `active`, and `completed` phases. It submits through `VehicleCloudServing`, stores the provider receipt, then waits for a separate `VehicleAcknowledgement`. Neither the model nor a view can manufacture `received`. The default demo implementation adds bounded delays in `MockVehicleCloudService`. When the BusTech hub is enabled, `HTTPVehicleCloudService` encodes the same request into the frozen booking envelope and requires HTTP 202 plus `accepted:true`. It does not manufacture an ACK. The service polls authenticated `/api/state` and correlates feedback to the booking channel event ID, route and stop. Cancel sends a new immutable `active:false` event. Only the local mock uses the separate acknowledgement step. See [BusTech integration](bustech-integration.md) for expiry, replacement and validation details.

In the labelled local simulation, acknowledgement triggers VoiceOver, speech and success haptics. In hub mode, the status view displays the returned plan status and passenger message, and reads returned audio once per result for AUDIO/BOTH. Polling stops when the status view is hidden or the app becomes inactive. The selected-service map retains the active request control until cancellation or completion. Simulator UI tests inject deterministic English speech and constrained assistant output only under `-ui-testing`; production availability behavior remains unchanged.

`RootTabView.focusedStopCode` is the single selection source for map markers, the nearby-stop hierarchy, Search, and Favourites. The lower Map surface is always one native `ScrollView` with a `LazyVStack` of `Section` values whose headers use SwiftUI's pinned-section behavior. Every nearby stop remains in the collection before, during, and after focus. An explicit selection increments a one-shot focus request and `ScrollViewReader` positions that stable section toward the top; it reaches the exact top whenever the real content below it provides enough scroll range. Arrival refreshes and ordinary layout changes do not repeat the animation. Scrolling down pins the focused header over its routes, while scrolling above the section reveals earlier stops normally. The scroll content has no synthetic bottom margin, and native bounce is content-size-aware, so a short list stops at its real final row instead of creating blank space solely to force top alignment. Collapsing clears focus and issues one bounded request for the first stop. Search, Favourites, annotations, and the stop identity all write the same state.

## Map performance

One persistent `MKMapView` provides native annotation reuse, pinch zoom, pan, overlays, and every main-map state. SwiftUI overlays occupy only their visible control bounds so they do not intercept map gestures. Region changes are debounced. The standard nearby camera requests a `0.006` latitude span and Locate requests `0.005`; MapKit may adjust the effective span for the view's aspect ratio. Marker and list selection preserve the current user-controlled span. Before stop annotations are applied, stops are filtered by the expanded visible map rect, sorted by distance to the viewport center, and capped. The full static stop set is never added to the map. Compact reusable stop-code annotations replace the bulky default pin and use the optional LTA Identity face with a monospace fallback. At latitude spans through `0.006`, individual signs and their annotations are required rather than collision-suppressed. Medium views use nine-point green dots with a 600-stop viewport bound. Broad views use six-point green overview dots with a 1,100-stop bound; conservative interchange/terminal matches use a 21-point circled bus symbol. Every installed annotation remains required, so MapKit does not silently hide an opposite-side stop.

Route selection keeps the same map, adds only successfully cached road-aligned `MKPolyline` sections, and shows the reported locations of up to three arrivals plus the selected stop. It never draws straight connectors while sections are pending. The camera fits the combined buses-and-stop extent rather than the buses alone. DataMall's BusRoutes response contains stop sequence and cumulative distance, not road-following geometry, so MapKit's road result is an approximation rather than an authoritative operational path. Each bus marker glyph is the current floored upstream ETA rather than its list ordinal. Returning, recentering, and selecting a different map stop animate that same map; Reduce Motion makes those region changes immediate.

The service-row `Menu` also exposes **Bus route** directly below its pin action. This presents a native sheet: an independently zoomable SwiftUI `Map` stays above a scrollable, connected stop list. The list is derived solely from cached LTA `BusRoutes` ordering and `BusStops` metadata and appears immediately offline. It initially scrolls to the invoking stop at a 0.28 vertical anchor, preserving some preceding context, and marks that row with a translucent LTA-green surface and semantic foreground colours. Every stop is also a map marker with at least a 44-point native button target. Its visual uses the same overview-dot, medium-dot, and close-sign levels as the main map. Map-marker selection recentres the map and scrolls the list to that row; list selection runs the same action and recentres the marker. **Show on map** dismisses the sheet and writes that stop into the canonical main-map focus state. The disabled alight-reminder control reserves the phase-2 interaction without implying that reminders work today.

`RouteGeometryStore` keys geometry by adjacent stop codes and coordinates, loads a schema-versioned JSON cache off the main actor, and atomically persists every successful section. A section is fresh for 30 days. A route open first displays the saved result without constructing a temporary straight route, then lazily refreshes only eligible missing or stale sections; the route refresh control forces that route's sections to rebuild. Shared in-flight tasks deduplicate identical section requests. `DirectionsRequestGate` serializes MapKit work at no more than 40 Directions requests per rolling 60 seconds, below the observed 50-request burst limit. Cancellation stops later sections. A failed request writes retry metadata—but no geometry—with exponential cooldown from 15 minutes to 24 hours, preventing repeated work on every sheet open; manual refresh bypasses it. An older successful section survives a failed refresh. The full sheet may show dotted LTA sequence fallbacks while sections are unavailable; the main map consumes road-aligned sections only.

The deterministic UI test zooms through sign, dot, and overview levels, verifies that no cluster replaces individual stops, and confirms opposite-side annotations remain exposed. User-location rendering is suppressed in mock UI tests to avoid a permission dialog.

## Cache safety

The static-data cache envelope includes a schema version, snapshot version, fetch date, and all three static collections. Updates use atomic replacement; a snapshot is published only after validation. The road-geometry cache has its own schema and independent atomic file so a format change cannot damage transit data. An incompatible schema is ignored rather than partially decoded. Local favourites, recent stops, appearance, default Map/Favourites launch tab, and the LTA Identity typography flag use a separate actor-backed `UserDefaults` payload and never leave the device.

## Security

The live client reads a build-injected AccountKey and sends it only in the `AccountKey` HTTPS request header to LTA DataMall. The ignored `Config/Secrets.xcconfig` is suitable only for development. Production requires a proxy because any secret embedded in a shipped app is recoverable.

## Glance-first design direction

The visual system is based on a Singapore route-control panel rather than another bus app: deep navy and teal location states, the optional supplied LTA Identity face for stop/service identity, fixed lime service tiles, standard SF Pro ETA numerals, and a compact vector road-sign marker built from UIKit views and an SF bus symbol. ETA cells have no decorative container. Their text carries occupancy colour; monitored/scheduled, vehicle type, and exceptional non-wheelchair state use native SF Symbols, while the full VoiceOver label states every condition. Selecting a route row retargets the persistent `MKMapView` to the stop sequence, selected stop, and next three reported bus locations, while the row remains the stable source of ETA information. The separate ellipsis action opens the full route sheet. The location count is explicit and missing coordinates are never inferred. Native `ScrollView`, `LazyVStack`, pinned `Section` headers, `ScrollViewReader`, `Button`, `Menu`, `Toggle`, sheet presentation, and MapKit primitives provide the stop → route → spatial hierarchy; there is no custom carousel, row-replacement animation, or redundant expanded text-detail screen. The Map navigation bar is hidden with SwiftUI toolbar visibility while the persistent map extends beneath the status bar. Standard SF Symbols and MapKit content are used; there are no benchmark assets, screenshots, or copied layouts.

The complete view hierarchy and interaction decisions are recorded in [information-architecture.md](information-architecture.md).
