import SwiftUI

struct FavouritesView: View {
    let isActive: Bool
    let onSelectStop: (BusStop) -> Void

    @Environment(TransitDataStore.self) private var dataStore
    @Environment(PreferencesStore.self) private var preferences
    @State private var renameStopCode: String?
    @State private var renameText = ""
    @State private var arrivalBoardModels = StopArrivalBoardModelStore()

    var body: some View {
        NavigationStack {
            Group {
                if favouriteRows.isEmpty {
                    ContentUnavailableView {
                        Label("No favourites yet", systemImage: "star")
                    } description: {
                        Text("Open a bus stop from Map or Search, then tap the star. Favourites stay on this device.")
                    }
                    .accessibilityIdentifier("favourites.empty")
                } else {
                    List {
                        ForEach(favouriteRows, id: \.preference.stopCode) { row in
                            VStack(spacing: 0) {
                                Button {
                                    onSelectStop(row.stop)
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "star.fill")
                                            .foregroundStyle(Color.pulseAmber)
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(alignment: .firstTextBaseline, spacing: 7) {
                                                Text(row.stop.code)
                                                    .foregroundStyle(Color.pulseTeal)
                                                Text(row.stop.roadName)
                                                    .foregroundStyle(.secondary)
                                            }
                                            .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))

                                            Text(row.preference.customName ?? row.stop.displayName)
                                                .font(TransitTypography.stopName(enabled: preferences.useLTAIdentityTypography))
                                                .foregroundStyle(.primary)
                                            if row.preference.pinnedServices.isEmpty {
                                                serviceStrip(for: row)
                                            }
                                        }
                                        Spacer()
                                        Image(systemName: "map.fill")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(Color.pulseTeal)
                                    }
                                    .padding(.vertical, 5)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("favourite.stop.\(row.stop.code)")

                                if !row.preference.pinnedServices.isEmpty {
                                    FavouritePinnedArrivals(
                                        stop: row.stop,
                                        serviceNumbers: row.preference.pinnedServices,
                                        isActive: isActive,
                                        model: arrivalBoardModels.model(for: row.stop.code)
                                    )
                                    .padding(.horizontal, -16)
                                }
                            }
                            .contextMenu {
                                Button("Rename", systemImage: "pencil") {
                                    renameStopCode = row.stop.code
                                    renameText = row.preference.customName ?? ""
                                }
                                Button("Remove", systemImage: "star.slash", role: .destructive) {
                                    preferences.toggleFavourite(stopCode: row.stop.code)
                                }
                            }
                            .swipeActions {
                                Button("Remove", role: .destructive) {
                                    preferences.toggleFavourite(stopCode: row.stop.code)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Favourites")
        }
        .alert("Rename favourite", isPresented: renameBinding) {
            TextField("Custom stop name", text: $renameText)
            Button("Save") {
                if let renameStopCode { preferences.rename(stopCode: renameStopCode, to: renameText) }
                renameStopCode = nil
            }
            Button("Cancel", role: .cancel) { renameStopCode = nil }
        }
    }

    private var favouriteRows: [(preference: FavouriteStopPreference, stop: BusStop)] {
        preferences.favourites.compactMap { preference in
            dataStore.stop(code: preference.stopCode).map { (preference, $0) }
        }
    }

    private func serviceNumbers(at stopCode: String) -> [String] {
        Array(Set(dataStore.routes(at: stopCode).map(\.serviceNo)))
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    private func serviceStrip(
        for row: (preference: FavouriteStopPreference, stop: BusStop)
    ) -> some View {
        let pinned = row.preference.pinnedServices
        let numbers = serviceNumbers(at: row.stop.code)
        return HStack(spacing: 5) {
            ForEach(Array(numbers.prefix(6)), id: \.self) { serviceNo in
                HStack(spacing: 2) {
                    if pinned.contains(serviceNo) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 7, weight: .bold))
                    }
                    Text(serviceNo)
                }
                .font(.caption2.weight(.bold))
                .foregroundStyle(pinned.contains(serviceNo) ? Color.pulseDataInk : .secondary)
            }
            if numbers.count > 6 {
                Text("+\(numbers.count - 6)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .lineLimit(1)
    }

    private var renameBinding: Binding<Bool> {
        Binding(
            get: { renameStopCode != nil },
            set: { if !$0 { renameStopCode = nil } }
        )
    }
}
