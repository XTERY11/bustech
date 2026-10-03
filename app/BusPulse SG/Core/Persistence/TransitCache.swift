import Foundation

struct TransitCacheEnvelope: Codable, Sendable {
    let schemaVersion: Int
    let snapshot: TransitSnapshot
}

actor TransitCache {
    static let currentSchemaVersion = 1

    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(fileURL: URL = TransitCache.defaultFileURL()) {
        self.fileURL = fileURL
        encoder = JSONEncoder()
        decoder = JSONDecoder()
    }

    func load() -> TransitSnapshot? {
        PerformanceTrace.measure("Cache load") {
            guard let data = try? Data(contentsOf: fileURL),
                  let envelope = try? decoder.decode(TransitCacheEnvelope.self, from: data),
                  envelope.schemaVersion == Self.currentSchemaVersion else { return nil }
            return envelope.snapshot
        }
    }

    func save(_ snapshot: TransitSnapshot) throws {
        try PerformanceTrace.measure("Cache save") {
            let directory = fileURL.deletingLastPathComponent()
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                let envelope = TransitCacheEnvelope(
                    schemaVersion: Self.currentSchemaVersion,
                    snapshot: snapshot
                )
                let data = try encoder.encode(envelope)
                try data.write(to: fileURL, options: [.atomic])
            } catch {
                throw TransitDataError.cacheWriteFailed
            }
        }
    }

    func removeForTesting() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }

    nonisolated static func defaultFileURL() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return root
            .appendingPathComponent("BusPulse SG", isDirectory: true)
            .appendingPathComponent("transit-cache-v1.json")
    }
}

enum TransitSnapshotValidator {
    static func validate(
        _ snapshot: TransitSnapshot,
        minimumStops: Int,
        minimumRoutes: Int,
        minimumServices: Int
    ) throws {
        guard snapshot.stops.count >= minimumStops else {
            throw TransitDataError.incompleteSnapshot("expected at least \(minimumStops) stops")
        }
        guard snapshot.routes.count >= minimumRoutes else {
            throw TransitDataError.incompleteSnapshot("expected at least \(minimumRoutes) route rows")
        }
        guard snapshot.services.count >= minimumServices else {
            throw TransitDataError.incompleteSnapshot("expected at least \(minimumServices) services")
        }

        let stopCodes = Set(snapshot.stops.map(\.code))
        guard stopCodes.count == snapshot.stops.count else {
            throw TransitDataError.incompleteSnapshot("duplicate stop codes were returned")
        }
        guard snapshot.stops.allSatisfy({ stop in
            !stop.code.isEmpty
                && (1.1 ... 1.6).contains(stop.latitude)
                && (103.5 ... 104.2).contains(stop.longitude)
        }) else {
            throw TransitDataError.incompleteSnapshot("one or more stops had invalid Singapore coordinates")
        }
    }
}
