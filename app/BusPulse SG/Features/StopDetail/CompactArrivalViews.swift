import SwiftUI

struct FavouritePinnedArrivals: View {
    let stop: BusStop
    let serviceNumbers: [String]
    let isActive: Bool
    let model: StopArrivalBoardModel

    @Environment(\.scenePhase) private var scenePhase
    @Environment(TransitDataStore.self) private var dataStore
    private let backoff = BackoffPolicy()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: 0) {
                ForEach(serviceNumbers, id: \.self) { serviceNo in
                    if let service = model.board?.services.first(where: { $0.serviceNo == serviceNo }) {
                        FavouritePinnedServiceRow(service: service, now: context.date)
                    } else {
                        FavouritePinnedUnavailableRow(
                            serviceNo: serviceNo,
                            isLoading: model.board == nil && model.errorMessage == nil
                        )
                    }
                }

                if let errorMessage = model.errorMessage, model.board == nil {
                    Label("Pinned arrivals unavailable", systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .accessibilityValue(errorMessage)
                }
            }
        }
        .task(id: "favourite-\(stop.code)-\(scenePhase)-\(isActive)") {
            guard isActive, scenePhase == .active else { return }
            while !Task.isCancelled {
                await model.refresh(stopCode: stop.code, using: dataStore)
                let delay: Duration = model.errorMessage == nil
                    ? .seconds(20)
                    : backoff.delay(afterFailure: model.failureAttempt)
                do { try await Task.sleep(for: delay) }
                catch { return }
            }
        }
        .accessibilityIdentifier("favourite.pinnedArrivals.\(stop.code)")
    }
}

private struct FavouritePinnedServiceRow: View {
    let service: ServiceArrivals
    let now: Date

    var body: some View {
        HStack(spacing: 6) {
            CompactServiceBadge(serviceNo: service.serviceNo, isPinned: true)
            HStack(spacing: 4) {
                ForEach(0 ..< 3, id: \.self) { index in
                    if service.estimates.indices.contains(index) {
                        CompactArrivalCell(estimate: service.estimates[index], now: now)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("—")
                            .font(.headline)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, minHeight: 46)
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.pulseTeal.opacity(0.045))
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("favourite.pinnedService.\(service.serviceNo)")
    }
}

private struct FavouritePinnedUnavailableRow: View {
    let serviceNo: String
    let isLoading: Bool

    var body: some View {
        HStack(spacing: 10) {
            CompactServiceBadge(serviceNo: serviceNo, isPinned: true)
            if isLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Getting arrivals…")
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("No current estimate")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.pulseTeal.opacity(0.045))
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("favourite.pinnedService.\(serviceNo)")
    }
}

struct CompactServiceArrivalRow: View {
    let stop: BusStop
    let service: ServiceArrivals
    let directionLabel: String
    let now: Date
    let isSelected: Bool
    let onSelect: () -> Void
    let onShowRoute: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                HStack(alignment: .top, spacing: 4) {
                    Button(action: onSelect) {
                        VStack(alignment: .leading, spacing: 8) {
                            serviceBadge
                            estimateCells
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityLabel)
                    .accessibilityIdentifier("service.select.\(service.serviceNo)")

                    manageMenu
                }
            } else {
                HStack(alignment: .center, spacing: 6) {
                    Button(action: onSelect) {
                        HStack(alignment: .center, spacing: 6) {
                            serviceBadge
                            estimateCells
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(accessibilityLabel)
                    .accessibilityIdentifier("service.select.\(service.serviceNo)")

                    manageMenu
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(rowBackground)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var serviceBadge: some View {
        CompactServiceBadge(serviceNo: service.serviceNo, isPinned: isPinned)
    }

    private var estimateCells: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< 3, id: \.self) { index in
                if service.estimates.indices.contains(index) {
                    CompactArrivalCell(estimate: service.estimates[index], now: now)
                        .frame(maxWidth: .infinity)
                } else {
                    Text("—")
                        .font(.headline)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .accessibilityLabel("No estimate supplied")
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var manageMenu: some View {
        CompactServiceManageMenu(
            stop: stop,
            serviceNo: service.serviceNo,
            isPinned: isPinned,
            onShowRoute: onShowRoute
        )
    }

    private var isPinned: Bool {
        preferences.favourite(for: stop.code)?.pinnedServices.contains(service.serviceNo) ?? false
    }

    private var accessibilityLabel: String {
        let pinned = isPinned ? ", pinned" : ""
        return "Service \(service.serviceNo), \(directionLabel)\(pinned), \(isSelected ? "return to stop map" : "show next bus locations")"
    }

    private var rowBackground: Color {
        if isSelected { return Color(.secondarySystemBackground) }
        if isPinned { return Color.pulseTeal.opacity(0.055) }
        return Color(.systemBackground)
    }
}

struct CompactInactiveServiceRow: View {
    let stop: BusStop
    let serviceNo: String
    let resumeDescription: String
    let onShowRoute: () -> Void

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            CompactServiceBadge(serviceNo: serviceNo, isPinned: isPinned)

            Text(resumeDescription)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(1)

            CompactServiceManageMenu(
                stop: stop,
                serviceNo: serviceNo,
                isPinned: isPinned,
                onShowRoute: onShowRoute
            )
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.systemBackground))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("service.inactive.\(serviceNo)")
    }

    private var isPinned: Bool {
        preferences.favourite(for: stop.code)?.pinnedServices.contains(serviceNo) ?? false
    }
}

private struct CompactServiceBadge: View {
    let serviceNo: String
    let isPinned: Bool

    @Environment(PreferencesStore.self) private var preferences
    @ScaledMetric(relativeTo: .title3) private var width = 58.0
    @ScaledMetric(relativeTo: .title3) private var height = 42.0

    var body: some View {
        ZStack {
            Text(serviceNo)
                .font(TransitTypography.serviceNumber(enabled: preferences.useLTAIdentityTypography))
                .foregroundStyle(Color.black.opacity(0.82))
                .lineLimit(1)
                .minimumScaleFactor(0.55)
                .padding(.horizontal, 4)

            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color.black.opacity(0.66))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(5)
                    .accessibilityLabel("Pinned")
                    .accessibilityIdentifier("service.pinned.\(serviceNo)")
            }
        }
        .frame(width: width, height: height)
        .background(Color.pulseServiceGreen, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .accessibilityHidden(true)
    }
}

private struct CompactServiceManageMenu: View {
    let stop: BusStop
    let serviceNo: String
    let isPinned: Bool
    let onShowRoute: () -> Void

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        Menu {
            Button(isPinned ? "Unpin service" : "Pin service", systemImage: isPinned ? "pin.slash" : "pin") {
                preferences.togglePinned(serviceNo: serviceNo, at: stop.code)
            }
            Button("Bus route", systemImage: "map") {
                onShowRoute()
            }
            if isPinned {
                Button("Move earlier", systemImage: "arrow.up") {
                    preferences.movePinned(serviceNo: serviceNo, at: stop.code, offset: -1)
                }
                Button("Move later", systemImage: "arrow.down") {
                    preferences.movePinned(serviceNo: serviceNo, at: stop.code, offset: 1)
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.subheadline.weight(.bold))
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Manage service \(serviceNo)")
        .accessibilityIdentifier("service.manage.\(serviceNo)")
    }
}

private struct CompactArrivalCell: View {
    let estimate: ArrivalEstimate
    let now: Date

    var body: some View {
        VStack(spacing: 3) {
            Text(ArrivalFormatting.compactCountdown(to: estimate.estimatedArrival, now: now))
                .font(.headline.weight(.semibold))
                .foregroundStyle(occupancyColor)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .contentTransition(.numericText())

            HStack(spacing: 5) {
                Image(systemName: estimate.monitored ? "dot.radiowaves.left.and.right" : "calendar")
                    .foregroundStyle(estimate.monitored ? Color.pulseTeal : .secondary)
                Image(systemName: estimate.vehicleType.symbolName)
                    .foregroundStyle(.secondary)
                if !estimate.wheelchairAccessible {
                    ZStack {
                        Image(systemName: "figure.roll")
                        Image(systemName: "nosign")
                            .font(.caption2.weight(.black))
                    }
                    .foregroundStyle(Color.pulseRed)
                }
            }
            .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 3)
        .padding(.vertical, 5)
        .frame(minHeight: 46)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityIdentifier("arrival.eta.\(estimate.serviceNo).\(estimate.slot)")
    }

    private var occupancyColor: Color {
        switch estimate.occupancy {
        case .seatsAvailable: .pulseGreen
        case .standingAvailable: .pulseAmber
        case .limitedStanding: .pulseRed
        case .unknown: .secondary
        }
    }

    private var accessibilitySummary: String {
        let wheelchair = estimate.wheelchairAccessible ? "wheelchair accessible" : "not wheelchair accessible"
        return "Service \(estimate.serviceNo), \(ArrivalFormatting.countdown(to: estimate.estimatedArrival, now: now)), \(estimate.monitored ? "live monitored estimate" : "scheduled estimate"), \(estimate.occupancy.title), \(estimate.vehicleType.title), \(wheelchair)"
    }
}

private extension VehicleType {
    var symbolName: String {
        switch self {
        case .singleDeck: "bus.fill"
        case .doubleDeck: "bus.doubledecker.fill"
        case .bendy: "bus.fill"
        case .unknown: "questionmark.circle"
        }
    }
}
