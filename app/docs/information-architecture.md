# Glance-first information architecture

## Product job

BusPulse SG is for a person who is already moving. Its primary job is to answer **which bus, how soon, and from which stop** within one glance. Exploration and configuration are secondary. A stop is therefore persistent operating context, not a temporary modal object.

## Canonical interaction model

```text
Launch or location update
        │
        ▼
Map + one stop-list hierarchy ◀──── map annotation / selected nearby stop
        ▲                                      │
        │                                      │ replaces in place
Search result ── records Recent ───────────────┤
Favourite row ─────────────────────────────────┘
        │
        ├── Nearby stops ── collapses board to a top-level stop List
        │                         └── stop row ── expands that stop's route List
        │
        └── route row ── overlays stop sequence + next-three bus locations
                              on the same persistent map
```

The focused Map stop owns the primary live-arrival board. A Favourites row may also show only its explicitly pinned services, fetched once per stop and only while Favourites is active. Search and Favourites still focus the canonical Map row rather than presenting an independent stop-detail view. This prevents stacked sheets and inconsistent back behavior while keeping pinned ETAs glanceable.

## Information layers

### Layer 0 — place

The upper stop map remains viewport-filtered, freely pinch-zoomable, and extends behind the status bar without a Map-tab title bar. It has three semantic levels: close LTA-style stop-code signs, medium green dots, and broad overview marks. The overview uses tiny green dots rather than numbered clusters; stops conservatively identified as an interchange or terminal use a slightly larger circled bus symbol. The route sheet uses the same three levels. **Nearby stops** uses a close `0.006` latitude-span request and Locate uses `0.005`, while selecting a stop preserves the current zoom. The lower surface is always one native lazy vertical scroll surface with pinned `Section` headers. **Nearby stops** collapses the focused section so only stop code, stop name, and road remain; it does not open or switch to another stop screen. Choosing a row opens that stop's section in the same list and smoothly positions its header toward the top. It reaches the exact top when real content provides sufficient scroll range; a short list stops at its natural upper position rather than adding a fake blank tail. All stops remain in the same order, including those before the focus, so the user can scroll upward to them. The content ends at its final stop with no synthetic blank scroll range, and native bounce follows the actual content size. Only explicit focus/collapse requests move the scroll position; arrival changes never repeat the animation. Reduce Motion makes positioning immediate. A marker tap, nearby-list choice, Search result, and Favourite row all write the same selected stop code and target the same section.

### Layer 1 — stop

The focused row header puts stop code before road on one identity line and the local/custom stop name on its own line. Freshness sits at the top-right of the metadata line, above the name, so it does not shorten the stop-name column. Refresh and favourite actions remain aligned beside the trailing collapse control and are not mounted for unfocused rows. Refresh uses the centred native indeterminate progress control and always returns to its idle icon when the request and minimum visible interval finish. It does not add a service-count/jump control.

### Layer 2 — routes and arrivals

Each service occupies one compact, consistently aligned row:

```text
[ 7 ]   1m      7m      13m     ···
        live    live    sched
        1-deck  2-deck  1-deck  (+ slashed wheelchair only when not accessible)
```

The borderless route tile is a fixed size at a given Dynamic Type size and uses `RGB(147, 213, 0)`, so one- and multi-character services remain aligned. Destination text, ETA containers, and crowd glyphs are omitted. The ETA number uses standard Dynamic Type-aware SF Pro—not the LTA Identity or rounded system design—and its green/amber/red text reflects LTA occupancy; each ETA's VoiceOver label states the occupancy in words. Native SF Symbols carry monitored/scheduled and single-/double-deck state. Accessible buses show no wheelchair glyph; a native prohibition overlay appears only when the upstream bus is not marked wheelchair accessible. Selecting a route does not change the row's height, reorder the list, or introduce explanatory text beneath it. When a scheduled service has no live row because it is outside its operating window, it stays visible after the active services with the three ETA columns replaced by one horizontal `Resumes …` label derived from LTA's first-bus schedule.

### Layer 3 — spatial feedback

Tapping anywhere on a route summary draws available cached road-aligned sections directly in the existing native map and adds the reported locations for that route's next three arrivals plus the selected stop. MapKit animates the camera to the combined geometric extent of all of them. Tapping the row again, or **Stops**, animates the same camera back to the selected stop. Recenter and map-marker stop changes use the same continuous map surface, while pinch zoom and pan remain available in every state. Each bus marker carries its honest floored ETA directly (`3'`, `6'`, `12'`, or `Now`) instead of a redundant ordinal. Missing upstream coordinates and pending road sections are omitted; neither position nor geometry is fabricated. The compact route-and-ETA list stays unchanged underneath. There is no expanded arrival-detail block, pushed route screen, or stop/service modal. Camera animation is disabled when Reduce Motion is enabled.

### Layer 4 — global and contextual assistance

The centre **Assistant** tab opens directly to a large-microphone screen with no stop-selection precondition. Spoken English may include the passenger's current location or a stop name/code, the bus service, and the requested help. After local structured interpretation, the app resolves the journey against its stop, route, and arrival data; only then does it show the same passenger-readable request card and **Confirm & Send** action. The start-screen preference can open the app directly to this tab.

When a service is already selected, one material control remains over its existing map: **Request Assistance · Next bus · ETA**. It does not alter the compact ETA row or compete with the route and bus-location information. The control opens one native sheet with manual action selection and a contextual voice shortcut. Both global and contextual paths converge on the same request and vehicle state.

Delivery uses a three-step rail—**Prepared → Sent → Bus confirmed**—whose text and symbols make every state understandable without colour. Before vehicle acknowledgement, copy says only prepared, sending, or waiting. After acknowledgement, the active card states exactly what Bus 191 (or any selected service) will do and offers one cancellation action. Returning to the selected-service map retains a compact active state until cancellation or completion.

## View responsibilities

| View | Opens with | Primary action | Destination |
|---|---|---|---|
| Map | Native stop list with nearest/map-centre stop focused | Change stop, scan ETAs | Same list focuses another row |
| Nearby stops | Stop-only vertical list | Choose a stop | That stop's route list in place |
| Favourites | Saved stops; pinned services show their three ETAs | Glance at pins or choose a stop | Focus that row in the Map list |
| Search | Recent, nearby, or query results | Locate a stop | Focus that row in the Map list; records Recent |
| Assistant | Large microphone, transcript, resolved journey, and request card | Speak stop/location, service, and required help; confirm and send | Shared request state and vehicle acknowledgement |
| Settings | Local data and display controls | Configure or refresh static data | Remains in Settings |
| Selected-route map | Stop sequence, selected stop, and up to three reported arrivals | Compare route and bus positions; return to stops | Reuses the upper map surface |
| Pre-arrival assistance | Selected next bus, stop, and ETA | Choose actions or speak; confirm and send | Shared request state and vehicle acknowledgement sheet |

## Performance and lifecycle rules

- Never prefetch live arrivals for every visible or nearby stop. Map fetches the focused stop; active Favourites fetches only stops that have pinned services, once per stop.
- Static nearby-stop and route-number information can appear immediately from cache.
- Changing stop cancels the prior board task through SwiftUI identity.
- Switching away from Map changes the board's active state and cancels its polling; switching away from Favourites likewise cancels its pinned-stop tasks.
- Selecting a route keeps the canonical board visible and polling because route geometry and bus positions remain on the same map.
- Only the expanded Nearby stop owns an arrival task. Collapsing or opening another branch cancels the previous task through SwiftUI view lifetime.
- ETA row identities remain `service + slot`, so refreshes update in place without reordering or scroll reset.
- Every upstream service remains visible. Pinning may promote and reorder chosen services, but no preference can hide a route from the board.

## Deliberately rejected patterns

- **Modal stop sheets:** repeated annotation taps move the entire reading surface and accumulate visual transitions.
- **Horizontal stop carousels and stop popovers:** hide stops behind swipes or temporary surfaces and make switching behavior difficult to predict.
- **Expanded or pushed arrival-detail text:** repeats state already encoded in the compact ETA cell and makes long stops slower to scan.
- **One card per service:** repeated padding and labels make a 15-route stop unscannable.
- **Unlabelled colour-only occupancy:** the compact visual uses requested ETA colour, but every accessibility element still names the exact LTA occupancy state.
- **Live arrivals for every favourite/nearby stop:** increases radio, battery, quota, and competing freshness states before the user chooses a stop.
- **Automatic ETA smoothing:** would replace upstream truth with an invented prediction.
