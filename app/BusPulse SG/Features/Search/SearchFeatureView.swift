import CoreLocation
import SwiftUI

struct SearchFeatureView: View {
    let onSelectStop: (BusStop) -> Void

    @Environment(TransitDataStore.self) private var dataStore
    @Environment(PreferencesStore.self) private var preferences
    @Environment(LocationService.self) private var location
    @State private var query = ""
    @State private var results: [BusStop] = []
    @State private var nearby: [BusStop] = []
    @FocusState private var searchFieldIsFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Stop code, name or road", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused($searchFieldIsFocused)
                        .onSubmit { searchFieldIsFocused = false }
                        .accessibilityLabel("Search bus stops")
                        .accessibilityIdentifier("search.field")
                }

                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    if !recentStops.isEmpty {
                        Section("Recent") {
                            ForEach(recentStops) { stop in
                                StopResultButton(
                                    stop: stop,
                                    prefix: "Recent",
                                    services: serviceNumbers(at: stop.code)
                                ) { choose(stop) }
                            }
                        }
                    }

                    Section(location.coordinate == nil ? "Nearby Singapore" : "Nearby") {
                        if nearby.isEmpty {
                            Text("Nearby stops appear when transit data is ready.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(nearby) { stop in
                                StopResultButton(
                                    stop: stop,
                                    prefix: "Nearby",
                                    services: serviceNumbers(at: stop.code)
                                ) { choose(stop) }
                            }
                        }
                    }
                } else {
                    Section("Results") {
                        if results.isEmpty {
                            ContentUnavailableView.search(text: query)
                        } else {
                            ForEach(results) { stop in
                                StopResultButton(
                                    stop: stop,
                                    prefix: "Result",
                                    services: serviceNumbers(at: stop.code)
                                ) { choose(stop) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Search")
            .task(id: query) {
                let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalized.isEmpty else {
                    results = []
                    return
                }
                do { try await Task.sleep(for: .milliseconds(180)) }
                catch { return }
                results = await dataStore.search(normalized)
            }
            .task(id: nearbyTaskID) {
                nearby = await dataStore.nearest(to: location.effectiveCoordinate)
            }
        }
    }

    private var recentStops: [BusStop] {
        preferences.recentStopCodes.compactMap(dataStore.stop(code:))
    }

    private var nearbyTaskID: String {
        let coordinate = location.effectiveCoordinate
        return "\(dataStore.stops.count)-\(coordinate.latitude)-\(coordinate.longitude)"
    }

    private func choose(_ stop: BusStop) {
        searchFieldIsFocused = false
        preferences.recordRecent(stopCode: stop.code)
        onSelectStop(stop)
    }

    private func serviceNumbers(at stopCode: String) -> [String] {
        Array(Set(dataStore.routes(at: stopCode).map(\.serviceNo)))
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

private struct StopResultButton: View {
    let stop: BusStop
    let prefix: String
    let services: [String]
    let action: () -> Void
    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(stop.code)
                            .foregroundStyle(Color.pulseTeal)
                        Text(stop.roadName)
                            .foregroundStyle(.secondary)
                    }
                    .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))

                    Text(stop.displayName)
                        .font(TransitTypography.stopName(enabled: preferences.useLTAIdentityTypography))
                        .foregroundStyle(.primary)
                    if !services.isEmpty {
                        Text(services.prefix(8).joined(separator: "  "))
                            .font(.system(.caption2, design: .rounded, weight: .bold))
                            .foregroundStyle(Color.pulseTeal)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "map.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.pulseTeal)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(prefix), bus stop \(stop.code), \(stop.displayName), \(stop.roadName)")
        .accessibilityIdentifier("search.result.\(stop.code)")
    }
}
