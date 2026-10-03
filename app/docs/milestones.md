# Milestone plan

## M0 — Gates and foundations

- Audit full Xcode, simulator runtime, workspace, Git, and LTA key.
- Create an Apple Xcode app project, constrain it to iOS 18+, and enable Swift 6.
- Establish secret handling, source research, architecture, and benchmark boundaries.

## M1 — Deterministic vertical slice

- Load a mock static snapshot instantly.
- Ship Map, Favourites, Search, and Settings tabs.
- Show a persistent Map arrival board with deterministic arrivals, route, and reported bus location.
- Persist local favourites and recent searches.

## M2 — Live and offline data core

- Implement BusArrival v3 plus paged BusStops, BusRoutes, and BusServices.
- Validate and atomically version static snapshots.
- Add visible-only arrival polling, deduplication, cancellation, and bounded backoff.
- Verify live BusArrival with a locally configured, ignored AccountKey while retaining deterministic mock coverage.

## M3 — Quality gate

- Cover decoding, countdowns, cache/versioning, and search with unit tests.
- Cover mock launch, stop selection, arrivals, search, and favourites with UI tests.
- Run accessibility and smoke-test checklists.
- Build and test on an available iPhone Simulator and record measured timings.

## Phase 2 backlog

- Alight reminders with explicit background-location and notification design.
- Apple Watch app.
- Home/Lock Screen widgets and Live Activities evaluation.
- MRT network map from an independently licensed or official source.
