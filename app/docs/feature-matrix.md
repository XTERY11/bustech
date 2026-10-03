# Functional benchmark matrix

This matrix compares only publicly described capability. It is not a visual or implementation reference.

| Capability | Public Singabus listing/history | BusPulse SG milestone | Original BusPulse SG decision |
|---|---|---|---|
| Nearby map stops | Listed | Phase 1 | Viewport filtering; sign/dot/overview levels; Singapore fallback |
| Three arrivals | Listed | Phase 1 | Direct BusArrival v3 values with LTA floor rounding |
| Bus type, load, wheelchair | Listed | Phase 1 | Text plus SF Symbols; never colour-only |
| Live vs scheduled | Public history mentions live timing | Phase 1 | Explicit `Monitored` label from LTA v3 |
| Reported bus location | Listed | Phase 1 | Optional native map only when non-zero coordinates exist |
| Route and direction | Listed/history | Phase 1 | Cached LTA route stops and clear direction label |
| Offline static data | Listed/history | Phase 1 | Versioned, validated, atomic cache after first sync |
| Stop search | Listed | Phase 1 | Stop code, name, and road; nearby and recent sections |
| Favourite custom names | Listed | Phase 1 | Local names plus pin/reorder; pinned ETAs appear directly in Favourites |
| Dark mode | Version 2.1.5 | Phase 1 | Semantic system colours and original night-route accent system |
| Automatic refresh | Version 2.2.0/3.0.0 | Phase 1 | Visible-and-active only, with cancellation, dedupe, and backoff |
| Self-updating transit data | Version 3.0.0/3.1.0 | Phase 1 | Manual safe update path now; background policy deferred |
| Direction indicator | Version 3.2.0 | Phase 1 | Service direction derived from cached route/service metadata |
| Multiple ETA sources | Version 3.3.0 | Excluded | LTA remains the sole source; no fabricated blending or smoothing |
| Pre-arrival assistance signalling | Not identified in public listing | BusTech demo | Global/contextual on-device voice or manual/demo selection → one validated booking → BusTech HTTP hub feedback or labelled local mock |
| Alight reminder | Version 2.2.0 | Phase 2 | Backlog; needs a separately designed location/notification lifecycle |
| Apple Watch | Listed/history | Phase 2 | Backlog |
| Widgets | Watch complication is public | Phase 2 | iOS widgets backlog |
| MRT map | Listed/history | Phase 2 | Backlog; no benchmark map asset used |

Source: [public Singapore App Store listing and version history](https://apps.apple.com/sg/app/singabus-bus-timing-mrt/id1044984870?platform=iphone), accessed 21 July 2026.
