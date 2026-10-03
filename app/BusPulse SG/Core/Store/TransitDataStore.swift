import CoreLocation
import Foundation
import Observation
import OSLog

@MainActor
@Observable
final class TransitDataStore {
    private let provider: any TransitDataProviding
    private let cache: TransitCache
    private let searchIndex = StopSearchIndex()
    private let arrivalCoordinator = ArrivalRequestCoordinator()
    private var hasBootstrapped = false

    private(set) var snapshot: TransitSnapshot?
    private(set) var stops: [BusStop] = []
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var lastSuccessfulSync: Date?
    private(set) var errorMessage: String?

    init(
        provider: any TransitDataProviding,
        cache: TransitCache = TransitCache()
    ) {
        self.provider = provider
        self.cache = cache
    }

    var mode: DataMode { provider.mode }

    func bootstrap() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        isLoading = true
        defer { isLoading = false }

        if mode == .live,
           let cached = await cache.load(),
           !cached.version.hasPrefix("mock-") {
            await publish(cached)
        }

        await refreshStatic()
    }

    func refreshStatic() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        errorMessage = nil
        defer { isRefreshing = false }
        let trace = PerformanceTrace.signposter.beginInterval("Static synchronization")
        defer { PerformanceTrace.signposter.endInterval("Static synchronization", trace) }

        do {
            let newSnapshot = try await provider.fetchStaticSnapshot()
            let thresholds = mode == .live
                ? (stops: 1_000, routes: 5_000, services: 100)
                : (stops: 1, routes: 1, services: 1)
            try await Task.detached(priority: .utility) {
                try TransitSnapshotValidator.validate(
                    newSnapshot,
                    minimumStops: thresholds.stops,
                    minimumRoutes: thresholds.routes,
                    minimumServices: thresholds.services
                )
            }.value
            if mode == .live {
                try await cache.save(newSnapshot)
            }
            await publish(newSnapshot)
            lastSuccessfulSync = Date()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func arrivals(for stopCode: String) async throws -> ArrivalBoard {
        let provider = provider
        return try await arrivalCoordinator.value(for: stopCode) {
            let state = PerformanceTrace.signposter.beginInterval("Arrival request")
            defer { PerformanceTrace.signposter.endInterval("Arrival request", state) }
            return try await provider.fetchArrivals(stopCode: stopCode)
        }
    }

    func cancelArrivalRequests() async {
        await arrivalCoordinator.cancelAll()
    }

    func search(_ query: String) async -> [BusStop] {
        await searchIndex.search(query)
    }

    func conversationStops(matching query: String) async -> [BusStop] {
        await searchIndex.conversationSearch(query)
    }

    func nearest(to coordinate: CLLocationCoordinate2D, limit: Int = 8) async -> [BusStop] {
        await searchIndex.nearest(to: coordinate, limit: limit)
    }

    func stop(code: String) -> BusStop? {
        stops.first { $0.code == code }
    }

    func routes(at stopCode: String) -> [BusRoute] {
        snapshot?.routes.filter { $0.busStopCode == stopCode } ?? []
    }

    func route(serviceNo: String, direction: Int?) -> [BusStop] {
        guard let snapshot else { return [] }
        let desiredDirection = direction
            ?? snapshot.routes.first(where: { $0.serviceNo == serviceNo })?.direction
            ?? 1
        let stopLookup = Dictionary(uniqueKeysWithValues: snapshot.stops.map { ($0.code, $0) })
        return snapshot.routes
            .filter { $0.serviceNo == serviceNo && $0.direction == desiredDirection }
            .sorted { $0.stopSequence < $1.stopSequence }
            .compactMap { stopLookup[$0.busStopCode] }
    }

    func directionLabel(for service: ServiceArrivals) -> String {
        if let code = service.destinationCode, let destination = stop(code: code) {
            return "Towards \(destination.displayName)"
        }
        if let direction = service.direction {
            return "Direction \(direction)"
        }
        return "Direction unavailable"
    }

    private func publish(_ newSnapshot: TransitSnapshot) async {
        snapshot = newSnapshot
        stops = newSnapshot.stops
        await searchIndex.rebuild(with: newSnapshot.stops)
    }
}
