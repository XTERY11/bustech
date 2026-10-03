# Research notes

Research was performed on 21–22 July 2026. Singabus was treated only as a functional benchmark from its public App Store metadata and release history; no app assets, screenshots, code, or distinctive UI were used.

## Official LTA contract

Primary source: [LTA DataMall API User Guide & Documentation, version 6.8, 21 April 2026](https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf?ref=public_apis).

- Live APIs use HTTPS and require an `AccountKey` request header.
- BusArrival v3 is `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival`, requires `BusStopCode`, optionally accepts `ServiceNo`, and has a documented 20-second update frequency.
- Each service may contain `NextBus`, `NextBus2`, and `NextBus3`. Empty strings are valid when fewer vehicles remain.
- `Monitored == 1` means an estimate based on bus location; `0` is operator schedule data.
- `Load` values are `SEA`, `SDA`, and `LSD`; `Feature == WAB` denotes wheelchair accessibility; vehicle types are `SD`, `DD`, and `BD`.
- LTA says arrival data should take precedence whenever present. Only when it is absent should route operating hours distinguish “No estimates available” from “Not in operation”.
- Derived countdowns must be rounded down. Less than one minute is shown as arriving.
- BusServices, BusRoutes, and BusStops are ad-hoc static data. Non-arrival collections are paged at at most 500 records using `$skip`.
- As of guide v6.8, BusServices can filter by `ServiceNo` and BusStops by `BusStopCode`.
- Loop variants such as `225G` and `225W` are distinct services and must not be collapsed.
- Attributes that appear upstream but are not documented should be ignored.

The [DataMall Dynamic Data page](https://datamall.lta.gov.sg/content/datamall/en.html) confirms that AccountKeys are issued to registered subscribers through its API access request.

## Functional benchmark

Public source: [Singabus — Bus Timing + MRT on the Singapore App Store](https://apps.apple.com/sg/app/singabus-bus-timing-mrt/id1044984870?platform=iphone).

The listing describes nearby map stops, three arrival estimates, vehicle/load/accessibility details, route and reported bus locations, offline/preloaded static data, stop search, favourite naming, dark mode, an alight reminder, Apple Watch support, and an MRT map. Its public history shows milestones including dark mode (2.1.5), alight reminder and auto-refresh (2.2.0), Watch complication (2.3.0), self-updating data and live locations/routes (3.0.0), data-update prompts/direction indicators (3.2.0), and later data/MRT maintenance updates through 3.3.2.

The product lesson is functional, not visual: fast access to a nearby stop, immediate cached structure, reliable refresh lifecycle, explicit direction, and durable favourites matter. BusPulse SG makes its own information architecture and visual choices, does not aggregate alternative ETA sources, and never adjusts the upstream ETA clock.

## LTA Identity typography

The requested GitHub project is [jglim/IdentityFont](https://github.com/jglim/IdentityFont). Its README describes it as a reconstruction, but also states that its glyphs were pulled from an LTA document. The repository contains no licence granting redistribution or app embedding.

LTA's current [Bus Shelter Signs reference manual](https://www.lta.gov.sg/content/dam/ltagov/industry_innovations/industry_matters/development_construction_resources/architectural_standards/pdf/Attachments%20to%20Section%204.4_Bus%20Shelter.pdf) explicitly calls LTA Identity proprietary and says a signage contractor must apply to the Authority for a user licence. A public GitHub download therefore does not establish permission to ship the font or its extracted reconstruction.

Implementation decision for this development build: the user supplied `LTAIdentity.Medium.ttf` directly and explicitly asked the project to proceed without a licence gate. The binary is bundled behind a local, default-on **LTA Identity typography** flag in Settings. It is applied narrowly to stop code, road, stop name, and fixed service-number tiles; ETAs, metadata icons, controls, and long-form text retain Apple system typography. Both paths use relative text styles and scaled metrics for Dynamic Type.

This development choice is not a redistribution conclusion. The exact supplied file and checksum are recorded in [font-provenance.md](font-provenance.md), and production distribution remains contingent on a separate rights review.

## Native scrolling, annotations, and map chrome

Apple's [pinned scrollable views documentation](https://developer.apple.com/documentation/swiftui/pinnedscrollableviews) provides native sticky section-header behavior, and [ScrollViewReader](https://developer.apple.com/documentation/swiftui/scrollviewreader) provides proxy-based positioning in response to explicit state changes. `OutlineGroup` is intended for recursively tree-structured data, which does not match the app's fixed stop → routes hierarchy. Apple's `List` was also evaluated, but its cell layout did not reliably honour the required selected-section top anchor while a route branch changed height.

Implementation decision: every stop is one stable `Section` in a `LazyVStack` with pinned headers, and the complete nearby-stop collection remains mounted. A one-shot `ScrollViewReader` request runs only after explicit selection or collapse. It is not tied to arrival data, section height, or focused-stop task identity, preventing the repeated focus animation that previously fought user scrolling. The focused header pins over its routes; scrolling above that section reveals preceding stops instead of hitting an artificial top boundary and invoking pull-to-refresh.

Apple's [MKAnnotationView documentation](https://developer.apple.com/documentation/mapkit/mkannotationview) supports reusable custom annotation views, display priority, and collision behavior. A compact stop-code rounded rectangle therefore uses `MKAnnotationView` reuse rather than a SwiftUI overlay per marker. BusPulse deliberately keeps clustering disabled across all three zoom levels: close stop-code signs become medium dots and then very small overview dots, while viewport filtering and explicit caps bound work. Installed annotations use required priority so close opposite-side stops are not hidden by collision suppression.

[LTA DataMall's official API guide](https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf?ref=public_apis) exposes only `BusStopCode`, `RoadName`, `Description`, `Latitude`, and `Longitude` for BusStops; it has no regular-stop/interchange attribute. BusPulse therefore treats interchange presentation as derived metadata, not an LTA fact. It recognises only descriptions ending in `Int`, `Interchange`, `Ter`, or `Terminal`, and rejects relative-landmark prefixes such as `Opp`, `Aft`, and `Bef`. This intentionally favours false negatives over mislabelling ordinary roadside stops and can be replaced if LTA adds an authoritative field.

Applied to the 5,208-stop live simulator snapshot inspected on 25 July 2026, that conservative rule recognized 64 descriptions. This is a measured classifier result, not a claim that Singapore has exactly 64 interchanges or terminals.

LTA's BusRoutes contract lists `StopSequence`, `BusStopCode`, and cumulative `Distance`, but no road geometry. It is enough to order and label every stop, but not to reconstruct turns, express sections, or the road carriageway a bus follows. The inline main-map overlay therefore remains a schematic stop sequence and is never labelled as an exact driven path.

[OneMap's official routing API](https://www.onemap.gov.sg/apidocs/routing) can return encoded `route_geometry`, but it is a separate authenticated service and its public routing modes do not define an LTA bus-service geometry product. BusPulse therefore does not silently treat a OneMap driving route as authoritative LTA route data. The dedicated route view instead shows the LTA stop sequence immediately and, on a normal non-test launch, asks MapKit for an automobile route between eligible adjacent stops. Successful segments are cached on disk for 30 days; failed or pending sections retain dotted schematic fallbacks only in the explanatory route sheet, while the main map omits them. This is visually closer to roads but remains an approximation because neither LTA DataMall nor MapKit promises the actual operational bus path.

Obtaining a complete authoritative polyline for every direction would require a separately licensed/operated geometry source keyed to `(ServiceNo, Direction)` or a maintained internal shape dataset. At Singapore-wide scale this should be precomputed and versioned with static transit data, rather than issuing many on-device routing requests for every route in advance.

Apple's [toolbar visibility documentation](https://developer.apple.com/documentation/swiftui/view/toolbarvisibility(_:for:)) provides the native way to hide a navigation bar without removing the `NavigationStack`. The Map root uses it and extends the persistent `MKMapView` beneath the top safe area; overlay controls add the reported safe-area inset, so the map fills behind the status bar without placing buttons under status items.

## Simulator rendering-warning audit

The warnings reported on 24 July 2026 were audited against the app source and focused iPhone 17 Pro UI-test runs. Findings and mitigations are recorded in [runtime-warning-audit.md](runtime-warning-audit.md). The post-mitigation route action log did not reproduce the reported strings; this is recorded as a bounded observation, not proof that the iOS 27 beta MapKit renderer will never emit them.
