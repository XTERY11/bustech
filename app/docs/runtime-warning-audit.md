# Runtime warning audit

Audited on 24 July 2026 with Xcode 27.0 beta (build 27A5228h) and the iOS 27.0 iPhone 17 Pro Simulator. These findings distinguish app-controlled inputs from diagnostics emitted inside Apple frameworks.

## `CAMetalLayer ignoring invalid setDrawableSize width=0 height=0`

The app did create its persistent `MKMapView` with `frame: .zero`. SwiftUI can briefly mount a representable before final constraints arrive, allowing MapKit's Metal surface to see a zero-sized drawable. This was a real app-controlled contributor even though the diagnostic itself comes from QuartzCore.

Mitigation: the representable now starts at a minimal valid `1 × 1` frame and receives its actual SwiftUI size immediately afterward. The route sheet's SwiftUI Map also has an explicit nonzero height. The initial region publish is suppressed so this construction change cannot overwrite the intended Singapore camera before first focus.

## `Wrapped around the polygon…` and `Building failed to triangulate!`

No `MKPolygon`, custom polygon mesh, or custom map-tile renderer exists in BusPulse SG. The app's service geometry is an `MKPolyline`. These messages are therefore most consistent with Apple Maps vector-tile polygon tessellation in this beta runtime, rather than the bus line itself. This remains an inference because the message contains no subsystem or source location.

Mitigation within app control: coordinates are filtered for finiteness and MapKit validity, and a line is not installed unless it has at least two distinct coordinates. A malformed or empty service route therefore never reaches the overlay renderer.

## `cannot add handler to 0 from 0 - dropping`

The source contains no event-handler registration matching this diagnostic. The warning appeared during simulator-driven interaction and is most consistent with an internal UIKit/MapKit event-routing diagnostic. It did not correspond to a failed gesture or assertion in the focused tests. No app behavior is hidden or retried in response to it.

## `clip: empty path.`

The map feature contains no custom clipping path. The new connected route list deliberately uses repeated vector capsules for its dashed rail rather than an empty or dynamically clipped `Path`. Route and main-map overlays are guarded against empty coordinate collections. The remaining message, if reproduced, is therefore likely framework rendering noise; a future occurrence should be captured with its exact screen and simulator build before assigning a different cause.

## `Throttled "Directions" request` / `GEOErrorDomain Code=-3`

This was app-controlled. The first road-preview implementation requested one `MKDirections` result for every adjacent stop whenever a route opened, held successful results only in memory, and had no process-wide request budget. A long route or repeated opens could therefore cross MapKit's 50-request burst window.

Mitigation: successful adjacent-stop road sections now live in an atomic, schema-versioned on-disk cache for 30 days and are reused across services wherever the pair is identical. Opening a route requests only eligible missing or stale sections, identical concurrent work is deduplicated, and a gate permits at most 40 requests per rolling 60 seconds. Each success is saved immediately so cancellation does not discard earlier work. A failure persists only retry timing—not geometry—with a 15-minute-to-24-hour cooldown; stale successful geometry is retained. The route screen provides an explicit manual rebuild, which bypasses the cooldown but still obeys the request gate.

## Verification result

- Debug simulator build succeeded after the guards.
- The focused route UI test passed and its Xcode action log contained none of the five reported warning strings.
- The focused custom-marker UI test passed.
- The final 24-unit/22-UI simulator run passed, including route-cache cooldown, full-route bidirectional interaction, opposite-side annotation retention, shared three-level density states without clusters, pinned favourite ETAs, and default-launch preference coverage. Xcode 27 beta continued to print debugger-version lookup diagnostics between cloned launches. One zero-size Metal diagnostic was also emitted while the host transitioned from the completed UI suite to unit-test execution; no map assertion or screenshot was missing. These are distinct from the app's earlier MapKit Directions throttle.
- Xcode's result summary reported no structured runtime warnings for the passing route test.

This is not a blanket suppression policy. A warning accompanied by missing content, broken gestures, a crash, or a reproducible app-only input should be treated as a defect and diagnosed again.
