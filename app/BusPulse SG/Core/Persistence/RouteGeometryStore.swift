import CoreLocation
import Foundation
import MapKit
import Observation

struct RouteMapCoordinate: Codable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double

    init(_ coordinate: CLLocationCoordinate2D) {
        latitude = coordinate.latitude
        longitude = coordinate.longitude
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

struct RouteGeometrySegment: Hashable, Sendable {
    let startCode: String
    let endCode: String
    let coordinates: [RouteMapCoordinate]
    let isRoadAligned: Bool

    var id: String { "\(startCode)>\(endCode)" }
}

struct RouteGeometrySnapshot: Hashable, Sendable {
    let segments: [RouteGeometrySegment]
    let roadAlignedSegmentCount: Int
    let totalSegmentCount: Int
    let deferredSegmentCount: Int
    let needsRefresh: Bool
    let newestUpdate: Date?

    var isFullyRoadAligned: Bool {
        totalSegmentCount > 0 && roadAlignedSegmentCount == totalSegmentCount
    }
}

protocol RouteSegmentProviding: Sendable {
    func roadSegment(from start: BusStop, to end: BusStop) async throws -> [RouteMapCoordinate]
}

actor MapKitRouteSegmentProvider: RouteSegmentProviding {
    private let requestGate: DirectionsRequestGate

    init(requestGate: DirectionsRequestGate = DirectionsRequestGate()) {
        self.requestGate = requestGate
    }

    func roadSegment(from start: BusStop, to end: BusStop) async throws -> [RouteMapCoordinate] {
        try await requestGate.waitForPermit()
        try Task.checkCancellation()

        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: start.coordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: end.coordinate))
        request.transportType = .automobile
        request.requestsAlternateRoutes = false

        let directions = MKDirections(request: request)
        defer { directions.cancel() }
        let response = try await directions.calculate()
        guard let polyline = response.routes.first?.polyline, polyline.pointCount > 1 else { return [] }
        var coordinates = Array(
            repeating: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            count: polyline.pointCount
        )
        polyline.getCoordinates(&coordinates, range: NSRange(location: 0, length: polyline.pointCount))
        return coordinates.map(RouteMapCoordinate.init)
    }
}

actor DirectionsRequestGate {
    static let maximumRequestsPerWindow = 40
    static let windowDuration: TimeInterval = 60

    private var requestDates: [Date] = []

    func waitForPermit() async throws {
        while true {
            try Task.checkCancellation()
            let now = Date()
            let cutoff = now.addingTimeInterval(-Self.windowDuration)
            requestDates.removeAll { $0 <= cutoff }

            if requestDates.count < Self.maximumRequestsPerWindow {
                requestDates.append(now)
                return
            }

            guard let oldest = requestDates.first else { continue }
            let delay = max(oldest.addingTimeInterval(Self.windowDuration).timeIntervalSince(now), 0.05)
            try await Task.sleep(for: .seconds(delay))
        }
    }
}

private actor UnavailableRouteSegmentProvider: RouteSegmentProviding {
    enum Unavailable: Error { case offline }

    func roadSegment(from start: BusStop, to end: BusStop) async throws -> [RouteMapCoordinate] {
        _ = (start, end)
        throw Unavailable.offline
    }
}

struct RouteGeometryCacheEnvelope: Codable, Sendable {
    let schemaVersion: Int
    let segments: [CachedRouteGeometrySegment]
    let failures: [CachedRouteGeometryFailure]?

    init(
        schemaVersion: Int,
        segments: [CachedRouteGeometrySegment],
        failures: [CachedRouteGeometryFailure]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.segments = segments
        self.failures = failures
    }
}

struct CachedRouteGeometrySegment: Codable, Hashable, Sendable {
    let key: String
    let updatedAt: Date
    let coordinates: [RouteMapCoordinate]
}

struct CachedRouteGeometryFailure: Codable, Hashable, Sendable {
    let key: String
    let failedAt: Date
    let retryAfter: Date
    let attemptCount: Int
}

struct RouteGeometryCacheState: Sendable {
    let segments: [String: CachedRouteGeometrySegment]
    let failures: [String: CachedRouteGeometryFailure]
}

actor RouteGeometryCache {
    static let currentSchemaVersion = 1

    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(fileURL: URL = RouteGeometryCache.defaultFileURL()) {
        self.fileURL = fileURL
    }

    func load() -> RouteGeometryCacheState {
        guard let data = try? Data(contentsOf: fileURL),
              let envelope = try? decoder.decode(RouteGeometryCacheEnvelope.self, from: data),
              envelope.schemaVersion == Self.currentSchemaVersion else {
            return RouteGeometryCacheState(segments: [:], failures: [:])
        }
        return RouteGeometryCacheState(
            segments: Dictionary(uniqueKeysWithValues: envelope.segments.map { ($0.key, $0) }),
            failures: Dictionary(uniqueKeysWithValues: (envelope.failures ?? []).map { ($0.key, $0) })
        )
    }

    func save(
        segments: [String: CachedRouteGeometrySegment],
        failures: [String: CachedRouteGeometryFailure]
    ) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let envelope = RouteGeometryCacheEnvelope(
            schemaVersion: Self.currentSchemaVersion,
            segments: segments.values.sorted { $0.key < $1.key },
            failures: failures.values.sorted { $0.key < $1.key }
        )
        let data = try encoder.encode(envelope)
        try data.write(to: fileURL, options: [.atomic])
    }

    nonisolated static func defaultFileURL() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return root
            .appendingPathComponent("BusPulse SG", isDirectory: true)
            .appendingPathComponent("route-geometry-cache-v1.json")
    }
}

actor RouteGeometryStore {
    static let freshnessInterval: TimeInterval = 30 * 24 * 60 * 60
    static let failureRetryBaseInterval: TimeInterval = 15 * 60
    static let maximumFailureRetryInterval: TimeInterval = 24 * 60 * 60

    private let provider: any RouteSegmentProviding
    private let cache: RouteGeometryCache
    private var cachedSegments: [String: CachedRouteGeometrySegment]?
    private var cachedFailures: [String: CachedRouteGeometryFailure]?
    private var inFlightSegments: [String: Task<[RouteMapCoordinate], Error>] = [:]

    init(provider: any RouteSegmentProviding, cache: RouteGeometryCache = RouteGeometryCache()) {
        self.provider = provider
        self.cache = cache
    }

    func cachedGeometry(for stops: [BusStop], now: Date = .now) async -> RouteGeometrySnapshot {
        await ensureLoaded()
        return snapshot(for: stops, now: now)
    }

    func geometry(
        for stops: [BusStop],
        forceRefresh: Bool = false,
        now: Date = .now
    ) async -> RouteGeometrySnapshot {
        await ensureLoaded()
        let pairs = Array(zip(stops, stops.dropFirst()))

        for (start, end) in pairs {
            guard !Task.isCancelled else { break }
            let key = Self.segmentKey(from: start, to: end)
            if !forceRefresh, isFresh(cachedSegments?[key], now: now) { continue }
            if !forceRefresh, isRetryDeferred(cachedFailures?[key], now: now) { continue }

            do {
                let coordinates = try await loadRoadSegment(key: key, start: start, end: end)
                guard coordinates.count > 1 else {
                    recordFailure(for: key, now: now)
                    await saveCache()
                    continue
                }
                cachedSegments?[key] = CachedRouteGeometrySegment(
                    key: key,
                    updatedAt: now,
                    coordinates: coordinates
                )
                cachedFailures?[key] = nil
                await saveCache()
            } catch is CancellationError {
                break
            } catch {
                recordFailure(for: key, now: now)
                await saveCache()
                // Keep an older road-aligned segment if one exists. Failure
                // metadata delays retry loops but never becomes route geometry.
                continue
            }
        }

        return snapshot(for: stops, now: now)
    }

    private func ensureLoaded() async {
        guard cachedSegments == nil else { return }
        let state = await cache.load()
        cachedSegments = state.segments
        cachedFailures = state.failures
    }

    private func saveCache() async {
        guard let cachedSegments, let cachedFailures else { return }
        try? await cache.save(segments: cachedSegments, failures: cachedFailures)
    }

    private func loadRoadSegment(
        key: String,
        start: BusStop,
        end: BusStop
    ) async throws -> [RouteMapCoordinate] {
        if let existing = inFlightSegments[key] {
            return try await existing.value
        }
        let provider = self.provider
        let task = Task {
            try await provider.roadSegment(from: start, to: end)
        }
        inFlightSegments[key] = task
        defer { inFlightSegments[key] = nil }
        return try await task.value
    }

    private func snapshot(for stops: [BusStop], now: Date) -> RouteGeometrySnapshot {
        let pairs = Array(zip(stops, stops.dropFirst()))
        var roadAlignedCount = 0
        var deferredCount = 0
        var needsRefresh = false
        var newestUpdate: Date?
        let segments = pairs.map { start, end in
            let key = Self.segmentKey(from: start, to: end)
            if let cached = cachedSegments?[key], cached.coordinates.count > 1 {
                roadAlignedCount += 1
                if !isFresh(cached, now: now) {
                    if isRetryDeferred(cachedFailures?[key], now: now) {
                        deferredCount += 1
                    } else {
                        needsRefresh = true
                    }
                }
                newestUpdate = max(newestUpdate ?? .distantPast, cached.updatedAt)
                return RouteGeometrySegment(
                    startCode: start.code,
                    endCode: end.code,
                    coordinates: cached.coordinates,
                    isRoadAligned: true
                )
            }
            if isRetryDeferred(cachedFailures?[key], now: now) {
                deferredCount += 1
            } else {
                needsRefresh = true
            }
            return RouteGeometrySegment(
                startCode: start.code,
                endCode: end.code,
                coordinates: [RouteMapCoordinate(start.coordinate), RouteMapCoordinate(end.coordinate)],
                isRoadAligned: false
            )
        }
        return RouteGeometrySnapshot(
            segments: segments,
            roadAlignedSegmentCount: roadAlignedCount,
            totalSegmentCount: pairs.count,
            deferredSegmentCount: deferredCount,
            needsRefresh: needsRefresh,
            newestUpdate: newestUpdate == .distantPast ? nil : newestUpdate
        )
    }

    private func isFresh(_ segment: CachedRouteGeometrySegment?, now: Date) -> Bool {
        guard let segment else { return false }
        return now.timeIntervalSince(segment.updatedAt) < Self.freshnessInterval
    }

    private func isRetryDeferred(_ failure: CachedRouteGeometryFailure?, now: Date) -> Bool {
        guard let failure else { return false }
        return failure.retryAfter > now
    }

    private func recordFailure(for key: String, now: Date) {
        let previousAttempts = cachedFailures?[key]?.attemptCount ?? 0
        let attemptCount = min(previousAttempts + 1, 8)
        let multiplier = pow(4.0, Double(attemptCount - 1))
        let delay = min(
            Self.failureRetryBaseInterval * multiplier,
            Self.maximumFailureRetryInterval
        )
        cachedFailures?[key] = CachedRouteGeometryFailure(
            key: key,
            failedAt: now,
            retryAfter: now.addingTimeInterval(delay),
            attemptCount: attemptCount
        )
    }

    nonisolated static func segmentKey(from start: BusStop, to end: BusStop) -> String {
        "\(start.code)@\(start.latitude),\(start.longitude)>\(end.code)@\(end.latitude),\(end.longitude)"
    }
}

@MainActor
@Observable
final class RouteGeometryService {
    private let store: RouteGeometryStore

    init(store: RouteGeometryStore) {
        self.store = store
    }

    convenience init(isUITesting: Bool) {
        let provider: any RouteSegmentProviding = isUITesting
            ? UnavailableRouteSegmentProvider()
            : MapKitRouteSegmentProvider()
        self.init(store: RouteGeometryStore(provider: provider))
    }

    func cachedGeometry(for stops: [BusStop]) async -> RouteGeometrySnapshot {
        await store.cachedGeometry(for: stops)
    }

    func geometry(for stops: [BusStop], forceRefresh: Bool = false) async -> RouteGeometrySnapshot {
        await store.geometry(for: stops, forceRefresh: forceRefresh)
    }
}
