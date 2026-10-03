import Foundation

protocol VehicleCloudServing: Sendable {
    var usesHubFeedback: Bool { get }
    func observeSnapshots(_ receive: @escaping @Sendable (HubSnapshot) async -> Void) async throws
    func snapshot() async throws -> HubSnapshot?
    func submit(_ request: AssistanceRequest) async throws -> VehicleSubmissionReceipt
    func acknowledgement(
        for receipt: VehicleSubmissionReceipt,
        request: AssistanceRequest
    ) async throws -> VehicleAcknowledgement
    func cancel(_ request: AssistanceRequest) async throws
}

extension VehicleCloudServing {
    var usesHubFeedback: Bool { false }
    func observeSnapshots(_ receive: @escaping @Sendable (HubSnapshot) async -> Void) async throws {}
    func snapshot() async throws -> HubSnapshot? { nil }
}

actor MockVehicleCloudService: VehicleCloudServing {
    enum FailureStage: Sendable {
        case submission
        case acknowledgement
        case cancellation
    }

    struct Configuration: Sendable {
        let submissionDelay: Duration
        let acknowledgementDelay: Duration
        let failureStage: FailureStage?

        init(
            submissionDelay: Duration = .milliseconds(450),
            acknowledgementDelay: Duration = .milliseconds(750),
            failureStage: FailureStage? = nil
        ) {
            self.submissionDelay = submissionDelay
            self.acknowledgementDelay = acknowledgementDelay
            self.failureStage = failureStage
        }
    }

    enum ServiceError: Error, LocalizedError, Sendable {
        case connectionUnavailable
        case acknowledgementTimedOut
        case cancellationFailed

        var errorDescription: String? {
            switch self {
            case .connectionUnavailable:
                "The request could not reach the bus service. Check your connection and try again."
            case .acknowledgementTimedOut:
                "The bus has not confirmed the request yet. Try sending it again."
            case .cancellationFailed:
                "The cancellation could not reach the bus. Try again."
            }
        }
    }

    private let configuration: Configuration

    init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    func submit(_ request: AssistanceRequest) async throws -> VehicleSubmissionReceipt {
        try await delay(configuration.submissionDelay)
        if configuration.failureStage == .submission {
            throw ServiceError.connectionUnavailable
        }
        return VehicleSubmissionReceipt(
            requestID: request.id,
            providerReference: "BPSG-\(request.id.uuidString.prefix(8).uppercased())",
            submittedAt: .now
        )
    }

    func acknowledgement(
        for receipt: VehicleSubmissionReceipt,
        request: AssistanceRequest
    ) async throws -> VehicleAcknowledgement {
        try await delay(configuration.acknowledgementDelay)
        guard configuration.failureStage != .acknowledgement else {
            throw ServiceError.acknowledgementTimedOut
        }
        return VehicleAcknowledgement(
            requestID: receipt.requestID,
            providerReference: receipt.providerReference,
            busService: request.busService,
            receivedAt: .now
        )
    }

    func cancel(_ request: AssistanceRequest) async throws {
        try await delay(.milliseconds(250))
        guard configuration.failureStage != .cancellation else {
            throw ServiceError.cancellationFailed
        }
    }

    private func delay(_ duration: Duration) async throws {
        guard duration > .zero else { return }
        try await Task.sleep(for: duration)
    }
}
