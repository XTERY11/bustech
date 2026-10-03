# BusPulse SG contributor guide

## Product boundaries

- Build an original, native SwiftUI iOS app for Singapore bus information.
- Treat Singabus only as a public functional benchmark. Never copy its name, assets, code, screenshots, wording, or distinctive UI.
- Never fabricate, interpolate, or smooth LTA arrival estimates. Show the upstream state honestly.
- Keep alight reminders, Apple Watch, widgets, and an MRT map in phase 2.

## Engineering constraints

- Swift 6, iOS 18 minimum, and Apple frameworks only unless a dependency is explicitly approved.
- Keep networking, JSON decoding, search indexing, and disk persistence off the main actor.
- Put external data behind protocols and keep deterministic mock implementations available.
- Keep map annotations viewport-limited and clusterable. Do not add every Singapore stop to the map at once.
- Cancel polling and outstanding work when its screen becomes invisible or the app becomes inactive.
- New persistence formats must be versioned, validated, and atomically replaced.

## Security and verification

- Never commit `Config/Secrets.xcconfig` or an LTA AccountKey.
- Embedded keys are for local development only; production must use a server-side proxy.
- Run the unit and UI test plans against an available iPhone Simulator before declaring work complete.
- Record only timings actually measured in the simulator.
