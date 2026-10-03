import Foundation

protocol TransitDataProviding: Sendable {
    var mode: DataMode { get }
    func fetchStaticSnapshot() async throws -> TransitSnapshot
    func fetchArrivals(stopCode: String) async throws -> ArrivalBoard
}

actor ArrivalRequestCoordinator {
    private var inFlight: [String: Task<ArrivalBoard, Error>] = [:]

    func value(
        for stopCode: String,
        operation: @escaping @Sendable () async throws -> ArrivalBoard
    ) async throws -> ArrivalBoard {
        if let existing = inFlight[stopCode] {
            return try await withTaskCancellationHandler {
                try await existing.value
            } onCancel: {
                existing.cancel()
            }
        }

        let task = Task { try await operation() }
        inFlight[stopCode] = task
        defer { inFlight[stopCode] = nil }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    func cancelAll() {
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
    }
}
