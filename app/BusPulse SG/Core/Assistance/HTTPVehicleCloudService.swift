import Foundation

actor HTTPVehicleCloudService: VehicleCloudServing {
    nonisolated let usesHubFeedback = true

    enum ServiceError: Error, LocalizedError, Sendable {
        case invalidResponse
        case rejected(statusCode: Int, code: String?)
        case bookingReplaced

        var errorDescription: String? {
            switch self {
            case .invalidResponse:
                "The hub returned an invalid response. Check the hub address and try again."
            case .bookingReplaced:
                "Another booking or scenario is current. This app cannot cancel it."
            case let .rejected(status, code):
                switch code {
                case "BRIDGE_TOKEN_REQUIRED": "The hub token is missing or incorrect. Update it in Settings, then submit a new booking."
                case "EVENT_ID_CONFLICT": "This event ID already has different contents. Submit a new booking."
                case "OUT_OF_ORDER_SIGNAL": "A newer booking is already at the hub. Submit a new booking."
                case "INVALID_OBSERVED_AT": "The phone clock is ahead of the hub. Check both clocks, then submit a new booking."
                case "ORIGIN_NOT_ALLOWED": "The hub rejected this client origin. Check the integration settings."
                default: "The hub rejected the request (HTTP \(status)). Check the connection settings and booking."
                }
            }
        }
    }

    private struct Accepted: Decodable { let accepted: Bool }
    private struct Rejection: Decodable { let error: String }
    private struct FrozenEvent {
        let id: String
        let body: Data
        let observedAt: Date
    }

    private let endpoint: URL
    private let token: String
    private let session: URLSession
    private var submissions: [UUID: FrozenEvent] = [:]
    private var cancellations: [UUID: FrozenEvent] = [:]

    init(endpoint: URL, token: String = "", session: URLSession? = nil) {
        self.endpoint = endpoint
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 10
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = session ?? URLSession(configuration: configuration)
    }

    func submit(_ request: AssistanceRequest) async throws -> VehicleSubmissionReceipt {
        _ = try request.validated()
        let event: FrozenEvent
        if let existing = submissions[request.id] {
            event = existing
        } else {
            event = try freeze(request, active: true)
            submissions[request.id] = event
        }
        try await post(event)
        return VehicleSubmissionReceipt(requestID: request.id, providerReference: event.id, submittedAt: event.observedAt)
    }

    /// HTTP receipt is not a vehicle ACK. Hub clients consume snapshot() instead.
    func acknowledgement(for receipt: VehicleSubmissionReceipt, request: AssistanceRequest) async throws -> VehicleAcknowledgement {
        throw ServiceError.invalidResponse
    }

    func snapshot() async throws -> HubSnapshot? {
        let url = endpoint.deletingLastPathComponent().appendingPathComponent("state")
        let data = try await perform(url: url)
        return try JSONDecoder().decode(HubSnapshot.self, from: data)
    }

    // Consume every perception transition, including pulses shorter than the state poll interval.
    func observeSnapshots(_ receive: @escaping @Sendable (HubSnapshot) async -> Void) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 3600
        let streamSession = URLSession(configuration: configuration)
        defer { streamSession.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.deletingLastPathComponent().appendingPathComponent("events"))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        try await withTaskCancellationHandler {
            let (bytes, response) = try await streamSession.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw ServiceError.invalidResponse
            }
            for try await line in bytes.lines {
                try Task.checkCancellation()
                guard line.hasPrefix("data: "), line.utf8.count < 262_144 else { continue }
                if let snapshot = try HubStreamEvent.snapshot(from: Data(line.dropFirst(6).utf8)) {
                    await receive(snapshot)
                }
            }
        } onCancel: { streamSession.invalidateAndCancel() }
    }

    func cancel(_ request: AssistanceRequest) async throws {
        // Avoid cancelling another passenger's current singleton booking. On an
        // ambiguous previous POST, allow a duplicate of our frozen cancellation.
        let state = try await snapshot()
        let currentID = state?.channels["booking"]?.event_id
        let ownID = submissions[request.id]?.id ?? "app-booking-\(request.id.uuidString)"
        guard state?.source == "external",
              currentID == ownID || currentID == cancellations[request.id]?.id else {
            throw ServiceError.bookingReplaced
        }
        let event: FrozenEvent
        if let existing = cancellations[request.id] {
            event = existing
        } else {
            event = try freeze(request, active: false)
            cancellations[request.id] = event
        }
        try await post(event)
    }

    private func freeze(_ request: AssistanceRequest, active: Bool) throws -> FrozenEvent {
        let now = Date.now
        let id = active ? "app-booking-\(request.id.uuidString)" : "app-cancel-\(UUID().uuidString)"
        let envelope = HubBookingEnvelope(request: request, active: active, observedAt: now, eventID: id)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(envelope)
        guard data.count <= 32_768 else { throw ServiceError.invalidResponse }
        return FrozenEvent(id: id, body: data, observedAt: now)
    }

    private func post(_ event: FrozenEvent) async throws {
        let data = try await perform(url: endpoint, body: event.body)
        guard try JSONDecoder().decode(Accepted.self, from: data).accepted else {
            throw ServiceError.invalidResponse
        }
    }

    private func perform(url: URL, body: Data? = nil) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
        guard response.statusCode == (body == nil ? 200 : 202) else {
            let code = (try? JSONDecoder().decode(Rejection.self, from: data))?.error
            throw ServiceError.rejected(statusCode: response.statusCode, code: code)
        }
        return data
    }
}

/// The hub emits a direct snapshot on connect and a nested snapshot for signals.
enum HubStreamEvent {
    static func snapshot(from data: Data) throws -> HubSnapshot? {
        struct Event: Decodable {
            let type: String
            let snapshot: HubSnapshot?
            enum CodingKeys: String, CodingKey { case type, data }
            struct Signal: Decodable { let snapshot: HubSnapshot }
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                type = try container.decode(String.self, forKey: .type)
                switch type {
                case "snapshot": snapshot = try container.decode(HubSnapshot.self, forKey: .data)
                case "signal": snapshot = try container.decode(Signal.self, forKey: .data).snapshot
                default: snapshot = nil
                }
            }
        }
        return try JSONDecoder().decode(Event.self, from: data).snapshot
    }
}
