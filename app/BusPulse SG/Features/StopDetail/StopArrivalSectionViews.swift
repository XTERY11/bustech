import Foundation
import Observation
import SwiftUI

@MainActor
final class StopArrivalBoardModelStore {
    private var models: [String: StopArrivalBoardModel] = [:]

    func model(for stopCode: String) -> StopArrivalBoardModel {
        if let model = models[stopCode] { return model }
        let model = StopArrivalBoardModel()
        models[stopCode] = model
        return model
    }
}

@MainActor
@Observable
final class StopArrivalBoardModel {
    var board: ArrivalBoard?
    var isLoading = false
    var isManualRefreshSpinning = false
    var errorMessage: String?
    var failureAttempt = 0

    func refresh(stopCode: String, using dataStore: TransitDataStore) async {
        if board == nil { isLoading = true }
        defer { isLoading = false }
        do {
            board = try await dataStore.arrivals(for: stopCode)
            errorMessage = nil
            failureAttempt = 0
        } catch is CancellationError {
            return
        } catch {
            errorMessage = "\(error.localizedDescription) Pull to refresh or wait for the next retry."
            failureAttempt += 1
        }
    }
}

struct StopArrivalSectionHeader: View {
    let stop: BusStop
    @Binding var isExpanded: Bool
    @Binding var selectedService: ServiceArrivals?
    let model: StopArrivalBoardModel

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(TransitDataStore.self) private var dataStore
    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibilityHeader
            } else {
                standardHeader
            }
        }
        .background(isExpanded ? Color(.secondarySystemBackground) : Color(.systemBackground))
    }

    private var standardHeader: some View {
        HStack(alignment: .center, spacing: 4) {
            disclosureIdentityControl

            if isExpanded {
                headerActions
                    .fixedSize()
                    .layoutPriority(2)
            }

            disclosureIndicator
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, isExpanded ? 5 : 10)
        .contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
            if isExpanded {
                updatedLabel
                    .padding(.top, 1)
                    .padding(.trailing, 12)
                    .offset(y: -2)
            }
        }
    }

    private var accessibilityHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                disclosureIdentityControl
                disclosureIndicator
            }

            if isExpanded {
                HStack {
                    updatedLabel
                    Spacer()
                    headerActions
                }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var disclosureIdentityControl: some View {
        Button {
            isExpanded.toggle()
        } label: {
            stopIdentity
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("map.nearbyStop.\(stop.code)")
    }

    private var disclosureIndicator: some View {
        Button {
            isExpanded.toggle()
        } label: {
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .animation(.snappy(duration: 0.22), value: isExpanded)
                .frame(width: 32, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Collapse stop" : "Expand stop")
        .accessibilityIdentifier("stop.disclosure.\(stop.code)")
    }

    private var stopIdentity: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(stop.code)
                    .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))
                    .foregroundStyle(Color.pulseTeal)

                Text(stop.roadName)
                    .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("stop.roadName")

            }

            Text(preferences.favourite(for: stop.code)?.customName ?? stop.displayName)
                .font(TransitTypography.stopName(enabled: preferences.useLTAIdentityTypography))
                .foregroundStyle(Color(uiColor: .label))
                .lineLimit(isExpanded || dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .accessibilityIdentifier(isExpanded ? "stop.name" : "map.nearbyStopName.\(stop.code)")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stop \(stop.code), \(stop.displayName), \(stop.roadName)")
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }

    @ViewBuilder
    private var updatedLabel: some View {
        if let board = model.board {
            Text(ArrivalFormatting.relativeUpdate(fetchedAt: board.fetchedAt))
                .font(.caption2.weight(.medium))
                .foregroundStyle(ArrivalFormatting.isStale(fetchedAt: board.fetchedAt) ? Color.pulseRed : .secondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel(ArrivalFormatting.isStale(fetchedAt: board.fetchedAt) ? "Arrival data is stale" : "Arrivals updated")
                .accessibilityValue(board.fetchedAt.formatted(date: .abbreviated, time: .standard))
                .accessibilityIdentifier("stop.lastUpdated")
        }
    }

    private var headerActions: some View {
        HStack(alignment: .center, spacing: 0) {
            Button {
                refreshManually()
            } label: {
                Group {
                    if model.isManualRefreshSpinning {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(model.isManualRefreshSpinning)
            .accessibilityLabel("Refresh arrivals")
            .accessibilityValue(model.isManualRefreshSpinning ? "Refreshing" : "Idle")
            .accessibilityIdentifier("stop.refresh")

            Button {
                preferences.toggleFavourite(stopCode: stop.code)
            } label: {
                Image(systemName: preferences.isFavourite(stop.code) ? "star.fill" : "star")
                    .foregroundStyle(preferences.isFavourite(stop.code) ? Color.pulseAmber : .secondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(preferences.isFavourite(stop.code) ? "Remove favourite" : "Add favourite")
            .accessibilityIdentifier("stop.favorite")
        }
    }

    private func refreshManually() {
        guard !model.isManualRefreshSpinning else { return }
        model.isManualRefreshSpinning = true
        Task {
            defer { model.isManualRefreshSpinning = false }
            async let minimumSpin: Void = waitForMinimumRefreshSpin()
            await model.refresh(stopCode: stop.code, using: dataStore)
            if let selectedService, let board = model.board {
                self.selectedService = board.services.first { $0.id == selectedService.id }
            }
            await minimumSpin
        }
    }

    private func waitForMinimumRefreshSpin() async {
        let milliseconds = ProcessInfo.processInfo.arguments.contains("-ui-testing") ? 900 : 650
        try? await Task.sleep(for: .milliseconds(milliseconds))
    }
}

struct StopArrivalSectionContent: View {
    let stop: BusStop
    let isActive: Bool
    @Binding var selectedService: ServiceArrivals?
    let refreshToken: Int
    let model: StopArrivalBoardModel
    let onShowRoute: (String, Int?) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(TransitDataStore.self) private var dataStore
    @Environment(PreferencesStore.self) private var preferences
    private let backoff = BackoffPolicy()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            LazyVStack(spacing: 0) {
                arrivalContent(now: context.date)
            }
            .accessibilityIdentifier("stop.detail.\(stop.code)")
        }
        .task(id: "\(stop.code)-\(scenePhase)-\(isActive)") {
            guard isActive, scenePhase == .active else { return }
            while !Task.isCancelled {
                await refresh()
                let delay: Duration = model.errorMessage == nil
                    ? .seconds(20)
                    : backoff.delay(afterFailure: model.failureAttempt)
                do { try await Task.sleep(for: delay) }
                catch { return }
            }
        }
        .onChange(of: refreshToken) { _, _ in
            guard isActive else { return }
            Task { await refresh() }
        }
    }

    @ViewBuilder
    private func arrivalContent(now: Date) -> some View {
        if let errorMessage = model.errorMessage, model.board == nil {
            ContentUnavailableView {
                Label("Arrivals unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try again") { Task { await refresh() } }
            }
            .padding()
        } else if let board = model.board {
            let services = orderedServices(board.services)
            let inactiveServices = scheduledInactiveServices(excluding: Set(services.map(\.serviceNo)), at: now)
            if services.isEmpty, inactiveServices.isEmpty {
                emptyState()
                    .padding()
            } else {
                ForEach(services) { service in
                    CompactServiceArrivalRow(
                        stop: stop,
                        service: service,
                        directionLabel: dataStore.directionLabel(for: service),
                        now: now,
                        isSelected: selectedService?.id == service.id,
                        onSelect: {
                            selectedService = selectedService?.id == service.id ? nil : service
                        },
                        onShowRoute: {
                            onShowRoute(service.serviceNo, service.direction)
                        }
                    )
                    .id("service-row-\(service.id)")
                }

                ForEach(inactiveServices) { service in
                    CompactInactiveServiceRow(
                        stop: stop,
                        serviceNo: service.serviceNo,
                        resumeDescription: service.resumeDescription,
                        onShowRoute: {
                            onShowRoute(service.serviceNo, service.direction)
                        }
                    )
                    .id("inactive-service-row-\(service.serviceNo)")
                }
            }

            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "arrow.clockwise.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        } else if model.isLoading {
            VStack(spacing: 10) {
                ProgressView()
                Text("Getting arrivals…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 28)
        }
    }

    private func emptyState() -> some View {
        let routes = dataStore.routes(at: stop.code)
        let isOperating = OperatingHoursEvaluator.isAnyServiceOperating(routes: routes)
        let title = isOperating ? "No estimates available" : "Services are not operating now"
        let detail = isOperating
            ? "LTA has not supplied an estimate for this stop. Pull to refresh."
            : "Scheduled operating hours indicate that service has ended. Live arrivals will still appear if LTA supplies them."
        return ContentUnavailableView {
            Label(title, systemImage: "clock.badge.questionmark")
        } description: {
            Text(detail)
        }
    }

    private func orderedServices(_ services: [ServiceArrivals]) -> [ServiceArrivals] {
        let pinned = preferences.favourite(for: stop.code)?.pinnedServices ?? []
        return services.sorted { lhs, rhs in
            let left = pinned.firstIndex(of: lhs.serviceNo)
            let right = pinned.firstIndex(of: rhs.serviceNo)
            switch (left, right) {
            case let (left?, right?): return left < right
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return lhs.serviceNo.localizedStandardCompare(rhs.serviceNo) == .orderedAscending
            }
        }
    }

    private func scheduledInactiveServices(
        excluding activeServiceNumbers: Set<String>,
        at now: Date
    ) -> [InactiveScheduledService] {
        let evaluationDate = operatingEvaluationDate(defaultingTo: now)
        let groupedRoutes = Dictionary(grouping: dataStore.routes(at: stop.code), by: \.serviceNo)
        let pinned = preferences.favourite(for: stop.code)?.pinnedServices ?? []
        return groupedRoutes.compactMap { serviceNo, routes in
            guard !activeServiceNumbers.contains(serviceNo),
                  !OperatingHoursEvaluator.isAnyServiceOperating(routes: routes, at: evaluationDate) else {
                return nil
            }
            return InactiveScheduledService(
                serviceNo: serviceNo,
                direction: routes.min(by: { $0.stopSequence < $1.stopSequence })?.direction,
                resumeDescription: OperatingHoursEvaluator.resumeDescription(
                    routes: routes,
                    after: evaluationDate
                )
            )
        }
        .sorted { lhs, rhs in
            let left = pinned.firstIndex(of: lhs.serviceNo)
            let right = pinned.firstIndex(of: rhs.serviceNo)
            switch (left, right) {
            case let (left?, right?): return left < right
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return lhs.serviceNo.localizedStandardCompare(rhs.serviceNo) == .orderedAscending
            }
        }
    }

    private func operatingEvaluationDate(defaultingTo now: Date) -> Date {
        guard ProcessInfo.processInfo.arguments.contains("-mixed-operation-mock") else { return now }
        return StopArrivalTestClock.mixedOperationDate ?? now
    }

    private func refresh() async {
        await model.refresh(stopCode: stop.code, using: dataStore)
        if let selectedService, let board = model.board {
            self.selectedService = board.services.first { $0.id == selectedService.id }
        }
    }
}

private struct InactiveScheduledService: Identifiable {
    let serviceNo: String
    let direction: Int?
    let resumeDescription: String
    var id: String { serviceNo }
}

private enum StopArrivalTestClock {
    static let mixedOperationDate = ISO8601DateFormatter().date(from: "2026-07-24T02:00:00+08:00")
}
