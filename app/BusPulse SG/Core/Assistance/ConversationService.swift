import Foundation

struct ConversationStop: Codable, Equatable, Identifiable, Sendable {
    let stopCode: String
    let stopName: String
    let roadName: String
    let services: [String]
    var id: String { stopCode }
}

struct ConversationSelection: Codable, Sendable {
    let stopCode: String
    let busService: String
}

struct ConversationAppContext: Codable, Sendable {
    var candidates: [ConversationStop]
    var selected: ConversationSelection?
    var stopMatches: [String]? = nil
    var locationAvailable: Bool
}

struct ConversationEvent: Codable, Sendable {
    let kind: String
    var text: String? = nil
    var audio: String? = nil
    var field: String? = nil
    var value: String? = nil
    var actions: [AssistanceAction]? = nil
    var ramp: String? = nil
}

struct ConversationTurn: Codable, Sendable {
    let version: Int
    let sessionId: String
    let turnId: String
    let revision: Int
    let context: ConversationAppContext
    let event: ConversationEvent
}

struct ConversationDraft: Codable, Equatable, Sendable {
    var stopCode: String?
    var stopQuery: String?
    var busService: String?
    var need: AccessibilityNeed
    var visionSupport: Bool
    var ramp: String
    var actions: [AssistanceAction]

    var rampPreference: RampPreference {
        switch ramp {
        case "requested": .requested
        case "declined": .declined
        default: .unspecified
        }
    }

    func journeyDraft() -> JourneyAssistanceDraft {
        JourneyAssistanceDraft(passengerResponse: "Your request is ready.", busService: busService ?? "",
            usesCurrentLocation: false, boardingStopCode: stopCode, boardingStopReference: nil,
            intent: .boarding, need: need, preferredInteraction: visionSupport ? .audio : .visual,
            assistanceRequested: actions + (ramp == "requested" ? [.deployWheelchairRamp] : []),
            rampPreference: rampPreference)
    }
}

struct ConversationReply: Codable, Sendable {
    let version: Int
    let sessionId: String
    let turnId: String
    let revision: Int
    let draft: ConversationDraft
    let question: String
    let message: String
    let transcript: String
    let sendRequested: Bool
    var submissionReady: Bool? = nil
}

protocol ConversationServing: Sendable {
    func turn(_ input: ConversationTurn) async throws -> ConversationReply
}

enum ConversationError: LocalizedError {
    case configuration, connection, rejected(String), invalidResponse
    case provider(String, Int)
    var errorDescription: String? {
        switch self {
        case .configuration: "Add your API keys in Settings → Assistant → Add API keys, or choose help manually."
        case .connection: "I couldn't connect. Your choices are still here. Try again, or choose help manually."
        case .invalidResponse: "I couldn't understand that reliably. Please try a shorter sentence or choose an option."
        case .provider(let name, let status):
            switch status {
            case 401, 403: "\(name) could not accept this app’s API key. Please contact the person who provided the app, or choose help manually."
            case 402: "\(name) has no remaining credit. Please choose help manually for now."
            case 429: "\(name) is busy or has reached its usage limit. Wait a moment and try again. Your choices are still here."
            default: "\(name) is temporarily unavailable. Try again, or choose help manually."
            }
        case .rejected(let code):
            switch code {
            case "unauthorized": "The assistant access code isn't accepted. Check it in Settings."
            case "not_configured": "The assistant service still needs its API keys. You can choose help manually."
            case "no_speech", "invalid_audio": "I couldn't hear clear speech. Tap Speak and try again, or type your message."
            case "session_expired", "revision_conflict", "turn_conflict": "This conversation has expired or changed. Tap Start again, or choose help manually."
            case "unknown_stop": "I couldn't match that stop. Choose a stop below or use the map."
            default: "The assistant couldn't respond. Your choices are still here. Try again or choose help manually."
            }
        }
    }
}

actor HTTPConversationService: ConversationServing {
    private let endpoint: URL
    private let token: String
    init(address: String, token: String) throws {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ConversationError.configuration }
        endpoint = url.appendingPathComponent("v1/turn")
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func checkConnection() async throws {
        let health = endpoint.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("health")
        var request = URLRequest(url: health)
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConversationError.rejected("unauthorized") }
        guard let result = try? JSONDecoder().decode([String:Bool].self, from: data), result["ready"] == true else {
            throw ConversationError.rejected("not_configured")
        }
    }

    func turn(_ input: ConversationTurn) async throws -> ConversationReply {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 85
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try encoder.encode(input)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw ConversationError.connection }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let problem = try? JSONDecoder().decode([String:String].self, from: data)
            throw ConversationError.rejected(problem?["error"] ?? "unavailable")
        }
        guard let reply = try? decoder.decode(ConversationReply.self, from: data),
              reply.version == 1, reply.sessionId == input.sessionId, reply.turnId == input.turnId,
              reply.revision == input.revision + 1,
              ["stop", "bus", "ramp", "help", "ready"].contains(reply.question),
              ["requested", "declined", "unspecified"].contains(reply.draft.ramp),
              !reply.draft.actions.contains(.deployWheelchairRamp) else { throw ConversationError.invalidResponse }
        return reply
    }
    nonisolated static func encodedAudio(at url: URL) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            try Data(contentsOf: url).base64EncodedString()
        }.value
    }
}
