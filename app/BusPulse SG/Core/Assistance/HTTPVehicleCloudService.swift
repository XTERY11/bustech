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
                case "NEED_ALREADY_BOOKED": "A request for this type of assistance is already active. Please try again after that passenger has boarded."
                default: "The hub rejected the request (HTTP \(status)). Check the connection settings and booking."
                }
            }
        }
    }

    /// Waiting-list hubs add `journey_id`, `queued` and `position`; older hubs send `accepted` only.
    private struct Accepted: Decodable {
        let accepted: Bool
        var queued: Bool? = nil
        var position: Int? = nil

        private enum CodingKeys: String, CodingKey { case accepted, queued, position }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            accepted = try container.decode(Bool.self, forKey: .accepted)
            // Additive fields never turn an acceptance into a failure.
            queued = try? container.decodeIfPresent(Bool.self, forKey: .queued)
            position = try? container.decodeIfPresent(Int.self, forKey: .position)
        }

        var queuePosition: Int? {
            guard queued != nil || position != nil else { return nil }
            return max(0, position ?? (queued == true ? 1 : 0))
        }
    }
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
        let accepted: Accepted
        do {
            accepted = try await post(event)
        } catch ServiceError.rejected(let status, let code) where code == "NEED_ALREADY_BOOKED" {
            // A definite refusal, not an ambiguous failure: forget the frozen event so a later retry is a
            // fresh booking (new observed_at, so the hub's booking lifetime starts then), not a replay.
            submissions[request.id] = nil
            throw ServiceError.rejected(statusCode: status, code: code)
        }
        return VehicleSubmissionReceipt(requestID: request.id, providerReference: event.id, submittedAt: event.observedAt,
                                        queuePosition: accepted.queuePosition)
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
        // Avoid cancelling another passenger's booking. On an ambiguous previous POST, allow a
        // duplicate of our frozen cancellation. A waiting-list hub names every booking it keeps, so
        // ours may be cancelled while another passenger's booking was received later.
        let state = try await snapshot()
        let currentID = state?.channels["booking"]?.event_id
        let ownID = submissions[request.id]?.id ?? "app-booking-\(request.id.uuidString)"
        let listed = state?.ownEntry(eventID: ownID).map { $0.journey.journeyStage != .idle } ?? false
        guard state?.source == "external",
              currentID == ownID || currentID == cancellations[request.id]?.id
                || (state?.listsJourneys == true && listed) else {
            throw ServiceError.bookingReplaced
        }
        let event: FrozenEvent
        if let existing = cancellations[request.id] {
            event = existing
        } else {
            event = try freeze(request, active: false, cancels: ownID)
            cancellations[request.id] = event
        }
        _ = try await post(event)
    }

    private func freeze(_ request: AssistanceRequest, active: Bool, cancels: String? = nil) throws -> FrozenEvent {
        let now = Date.now
        let id = active ? "app-booking-\(request.id.uuidString)" : "app-cancel-\(UUID().uuidString)"
        let envelope = HubBookingEnvelope(request: request, active: active, observedAt: now, eventID: id, cancels: cancels)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(envelope)
        guard data.count <= 32_768 else { throw ServiceError.invalidResponse }
        return FrozenEvent(id: id, body: data, observedAt: now)
    }

    private func post(_ event: FrozenEvent) async throws -> Accepted {
        let data = try await perform(url: endpoint, body: event.body)
        let accepted = try JSONDecoder().decode(Accepted.self, from: data)
        guard accepted.accepted else { throw ServiceError.invalidResponse }
        return accepted
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
