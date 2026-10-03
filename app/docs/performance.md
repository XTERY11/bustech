# Performance measurements

## Instrumentation

The app emits `OSSignposter` intervals for cache loading/saving, static synchronization, search indexing, viewport annotation updates, and arrival requests. Instruments can inspect the `sg.buspulse.app` subsystem and `Performance` category.

## Simulator observations

Recorded on 24–26 July 2026 with Xcode 27.0 beta build 27A5228h, an iPhone 17 Pro simulator, iOS 27.0 build 24A5390f, and a Debug deterministic-mock build.

After adopting content-bounded pinned stop sections, closer default map framing, three-level reusable stop annotations, inactive-service rows, and the inline route overlay, the latest `XCTApplicationLaunchMetric(waitUntilResponsive: true)` run recorded responsive-first-frame durations of **2.828191 s**, **3.017303 s**, and **3.073926 s** across three fresh launches. Median was **3.017303 s**, mean was **2.973140 s**, and observed range was **2.828191–3.073926 s**. No sample was discarded.

The latest complete single-run all-green **30-unit/24-UI** acceptance remains the 11 August 2026 run at **591.740 seconds**. On 13 August 2026, the expanded **31-unit/25-UI** suite was verified in bounded batches on iPhone 17 Pro / iOS 27.0 Simulator: all 31 unit tests passed together; all 25 UI identifiers passed across the initial run, targeted reruns, and two six-test remainder batches. Coverage now includes global spoken stop/service resolution, direct Assistant launch preference, global and contextual voice requests, and the earlier map/search/favourites/accessibility checks. One attempted single full UI run hit an Xcode 27 test-runner teardown fault (`Waiting for -runningDidFinish`) after the test app crashed during orchestration, so no misleading aggregate duration or single-xcresult all-green claim is recorded for this date.

These are simulator observations, not physical-device claims or release thresholds. Re-measure on a stable Xcode toolchain and representative devices before setting performance budgets.

## Whole-network road-cache estimate

The live simulator transit snapshot inspected on 25 July 2026 contained 26,872 `BusRoutes` rows across 801 service/direction groups. Those groups produce 26,071 route legs but only **7,881 unique directed adjacent-stop pairs** after deduplication. At BusPulse SG's 40-request rolling-minute gate, the rate-limit-only lower bound is **197.0 minutes (3 h 17 min)**. At MapKit's observed 50-request ceiling it would still be about **157.6 minutes**. These are calculated lower bounds from the cached graph, not measured download durations; network latency, routing failures, app suspension, and retries can only increase them. Consequently, the app refines the route being used and does not present a misleading one-minute whole-network progress dialog.
