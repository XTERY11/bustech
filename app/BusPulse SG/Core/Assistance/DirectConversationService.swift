import Foundation
import CryptoKit

struct AssistantProviderConfiguration: Sendable {
    let groqKey: String
    let deepSeekKey: String
    var groqModel = "whisper-large-v3"
    var deepSeekModel = "deepseek-flash"

    static func current() async throws -> Self {
        try await AssistantCredentialStore.shared.load()
    }

}

protocol ConversationModelProviding: Sendable {
    func transcribe(_ audio: Data, candidates: [ConversationStop]) async throws -> String
    func interpret(_ payload: Data) async throws -> Data
}

actor DirectConversationProviders: ConversationModelProviding {
    private let configuration: AssistantProviderConfiguration
    private let session: URLSession

    init(configuration: AssistantProviderConfiguration, session: URLSession? = nil) throws {
        guard !configuration.groqKey.isEmpty, !configuration.deepSeekKey.isEmpty else { throw ConversationError.configuration }
        self.configuration = configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 40
        settings.timeoutIntervalForResource = 60
        self.session = session ?? URLSession(configuration: settings)
    }

    private func request(_ url: String, key: String, provider: String, body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("BusPulseAssistant/1.0", forHTTPHeaderField: "User-Agent")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw ConversationError.connection
        }
        try Task.checkCancellation()
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw ConversationError.invalidResponse }
        guard (200..<300).contains(status) else { throw ConversationError.provider(provider, status) }
        return data
    }

    func checkConnection() async throws {
        // Authenticated requests go directly to each provider; no local gateway.
        _ = try await request("https://api.groq.com/openai/v1/models", key: configuration.groqKey, provider: "Speech service")
        _ = try await request("https://api.deepseek.com/models", key: configuration.deepSeekKey, provider: "Assistant service")
    }

    func transcribe(_ audio: Data, candidates: [ConversationStop]) async throws -> String {
        guard (101..<6_000_000).contains(audio.count) else { throw ConversationError.rejected("invalid_audio") }
        let boundary = UUID().uuidString
        var body = Data()
        let fields = ["model": configuration.groqModel, "response_format": "verbose_json",
                      "prompt": String(candidates.map(\.stopName).joined(separator: ", ").prefix(700))]
        for (key, value) in fields {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8))
        body.append(audio)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let data = try await request("https://api.groq.com/openai/v1/audio/transcriptions", key: configuration.groqKey,
                                     provider: "Speech service", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
        struct Transcription: Decodable {
            struct Segment: Decodable { let no_speech_prob: Double? }
            let text: String
            let segments: [Segment]?
        }
        guard let decoded = try? JSONDecoder().decode(Transcription.self, from: data) else { throw ConversationError.invalidResponse }
        if let segments = decoded.segments, !segments.isEmpty, segments.allSatisfy({ ($0.no_speech_prob ?? 0) > 0.7 }) {
            throw ConversationError.rejected("no_speech")
        }
        let text = decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ConversationError.rejected("no_speech") }
        return String(text.prefix(3000))
    }

    func interpret(_ payload: Data) async throws -> Data {
        let body: [String: Any] = ["model": configuration.deepSeekModel, "response_format": ["type": "json_object"],
                                  "max_tokens": 1000, "temperature": 0, "thinking": ["type": "disabled"],
                                  "messages": [["role": "system", "content": ConversationSystemPrompt.text],
                                               ["role": "user", "content": String(decoding: payload, as: UTF8.self)]]]
        let data = try await request("https://api.deepseek.com/chat/completions", key: configuration.deepSeekKey,
                                     provider: "Assistant service", body: JSONSerialization.data(withJSONObject: body))
        struct Completion: Decodable {
            struct Choice: Decodable {
                struct Message: Decodable { let content: String? }
                let finish_reason: String
                let message: Message
            }
            let choices: [Choice]
        }
        guard let result = try? JSONDecoder().decode(Completion.self, from: data),
              let choice = result.choices.first, choice.finish_reason == "stop",
              let content = choice.message.content else { throw ConversationError.invalidResponse }
        return Data(content.utf8)
    }
}

/// Load the latest saved keys for each inference, so updating keys does not
/// discard the passenger's existing conversation or keep using old credentials.
private actor SavedConversationProviders: ConversationModelProviding {
    func transcribe(_ audio: Data, candidates: [ConversationStop]) async throws -> String {
        let provider = try DirectConversationProviders(configuration: try await .current())
        return try await provider.transcribe(audio, candidates: candidates)
    }
    func interpret(_ payload: Data) async throws -> Data {
        let provider = try DirectConversationProviders(configuration: try await .current())
        return try await provider.interpret(payload)
    }
}

/// On-phone state machine. Models propose patches; only validated patches update a draft.
actor DirectConversationService: ConversationServing {
    private let providers: any ConversationModelProviding
    private var sessionID: String?
    private var revision = 0
    private var draft = ConversationDraft(need: .unknown, visionSupport: false, ramp: "unspecified", actions: [])
    private var question = "stop"
    private var submissionHeld = false
    private var history: [[String: String]] = []
    private var cache: [String: (Data, ConversationReply)] = [:]
    private var cacheOrder: [String] = []
    private var busy = false

    init(providers: any ConversationModelProviding) { self.providers = providers }

    func turn(_ input: ConversationTurn) async throws -> ConversationReply {
        guard !busy else { throw ConversationError.rejected("revision_conflict") }
        busy = true
        defer { busy = false }
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = .sortedKeys
        let fingerprint = Data(SHA256.hash(data: try encoder.encode(input)))
        let ctx = input.context
        guard input.version == 1, ctx.candidates.count <= 40,
              Set(ctx.candidates.map(\.stopCode)).count == ctx.candidates.count,
              ctx.stopMatches?.allSatisfy({ code in ctx.candidates.contains { $0.stopCode == code } }) ?? true else { throw ConversationError.invalidResponse }
        if let selected = ctx.selected {
            guard ctx.candidates.contains(where: { $0.stopCode == selected.stopCode && $0.services.contains(selected.busService) }) else { throw ConversationError.invalidResponse }
        }
        if sessionID != input.sessionId {
            guard input.revision == 0 else { throw ConversationError.rejected("session_expired") }
            sessionID = input.sessionId; submissionHeld = false; revision = 0; history = []; cache = [:]; cacheOrder = []
            draft = ConversationDraft(stopCode: ctx.selected?.stopCode, busService: ctx.selected?.busService,
                                      need: .unknown, visionSupport: false, ramp: "unspecified", actions: [])
            question = ctx.selected == nil ? "stop" : "help"
        }
        if let (old, reply) = cache[input.turnId] {
            guard old == fingerprint else { throw ConversationError.rejected("turn_conflict") }
            return reply
        }
        guard input.revision == revision else { throw ConversationError.rejected("revision_conflict") }
        var transcript = ""
        var changes: [String: Any] = [:]
        var intent = "update"
        switch input.event.kind {
        case "start": break
        case "stops":
            guard draft.stopQuery != nil, ctx.stopMatches != nil else { throw ConversationError.invalidResponse }
        case "help":
            guard let actions = input.event.actions, let ramp = input.event.ramp,
                  ["requested", "declined", "unspecified"].contains(ramp),
                  !actions.contains(.deployWheelchairRamp),
                  !actions.isEmpty || ramp == "requested" else { throw ConversationError.invalidResponse }
            changes["add_actions"] = actions.map(\.rawValue)
            changes["ramp"] = ramp
        case "choice":
            guard let field = input.event.field, let value = input.event.value,
                  ["stop_code", "bus_service", "ramp", "add_actions", "remove_actions", "need"].contains(field) else { throw ConversationError.invalidResponse }
            changes[field] = ["add_actions", "remove_actions"].contains(field) ? [value] : value
        case "text", "audio":
            if input.event.kind == "audio" {
                guard let raw = input.event.audio, let audio = Data(base64Encoded: raw) else { throw ConversationError.rejected("invalid_audio") }
                transcript = try await providers.transcribe(audio, candidates: ctx.candidates)
            } else { transcript = input.event.text ?? "" }
            guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, transcript.count <= 3000 else { throw ConversationError.rejected("no_speech") }
            let answer = transcript.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".!。！")))
            if question == "stop", draft.stopQuery != nil, let matches = ctx.stopMatches,
               ["yes", "yes please", "correct", "that one", "是", "对", "是的"].contains(answer) {
                if matches.count == 1 { changes["stop_code"] = matches[0] }
            } else {
                struct Payload: Encodable {
                    let userText: String
                    let draft: ConversationDraft
                    let lastQuestion: String
                    let recentTurns: [[String: String]]
                    let appContext: ConversationAppContext
                }
                let payload = try encoder.encode(Payload(userText: transcript, draft: draft, lastQuestion: question, recentTurns: history, appContext: ctx))
                let data = try await providers.interpret(payload)
                guard let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let patch = result["changes"] as? [String: Any], let proposedIntent = result["intent"] as? String,
                      ["update", "send", "unclear", "hold"].contains(proposedIntent) else { throw ConversationError.invalidResponse }
                intent = proposedIntent
                changes = intent == "unclear" ? [:] : patch
            }
        default: throw ConversationError.invalidResponse
        }
        let updated = try Self.apply(changes, to: draft, candidates: ctx.candidates)
        var (nextQuestion, message) = Self.question(for: updated, context: ctx)
        if intent == "unclear" { message = "Tell me the help you need for this journey, or choose an option below. For another passenger, please make a separate request." }
        var held = submissionHeld
        if intent == "hold" || Self.requestsPause(transcript) { held = true }
        else if intent == "send" && Self.explicitSend(transcript) { held = false }
        let ready = nextQuestion == "ready" && intent != "unclear" && !held
        if held {
            message = nextQuestion == "ready"
                ? "I'll wait. Tell me what else you need, and say ‘send my request’ when you're ready."
                : "I'll wait before sending. " + message
        }
        let reply = ConversationReply(version: 1, sessionId: input.sessionId, turnId: input.turnId, revision: revision + 1,
                                      draft: updated, question: nextQuestion, message: message, transcript: transcript,
                                      sendRequested: intent == "send" && nextQuestion == "ready" && Self.explicitSend(transcript) && !held,
                                      submissionReady: ready)
        try Task.checkCancellation()
        submissionHeld = held
        draft = updated; question = nextQuestion; revision += 1
        history = Array((history + [["user": transcript.isEmpty ? (input.event.value ?? input.event.kind) : transcript, "question": message]]).suffix(6))
        cache[input.turnId] = (fingerprint, reply); cacheOrder.append(input.turnId)
        if cacheOrder.count > 100 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
        return reply
    }

    private static func apply(_ changes: [String: Any], to draft: ConversationDraft, candidates: [ConversationStop]) throws -> ConversationDraft {
        let allowed: Set<String> = ["stop_code", "stop_query", "bus_service", "need", "vision_support", "ramp", "add_actions", "remove_actions"]
        guard Set(changes.keys).isSubset(of: allowed) else { throw ConversationError.invalidResponse }
        var result = draft
        for key in ["stop_code", "stop_query", "bus_service"] where changes.keys.contains(key) {
            let value: String?
            if changes[key] is NSNull { value = nil }
            else if let string = changes[key] as? String, string.count <= 160 { value = string.isEmpty ? nil : string }
            else { throw ConversationError.invalidResponse }
            switch key {
            case "stop_code": result.stopCode = value
            case "stop_query": result.stopQuery = value
            default: result.busService = value?.replacingOccurrences(of: " ", with: "").uppercased()
            }
        }
        if let value = changes["need"] {
            guard let raw = value as? String, let need = AccessibilityNeed(rawValue: raw) else { throw ConversationError.invalidResponse }
            result.need = need
            if need == .visualAccessibility, changes["vision_support"] == nil { result.visionSupport = true }
        }
        if let value = changes["vision_support"] {
            // JSONDecoder distinguishes booleans from numeric values.
            guard let data = try? JSONSerialization.data(withJSONObject: [value]), let booleans = try? JSONDecoder().decode([Bool].self, from: data), let boolean = booleans.first else { throw ConversationError.invalidResponse }
            result.visionSupport = boolean
        }
        if let value = changes["ramp"] {
            guard let ramp = value as? String, ["requested", "declined", "unspecified"].contains(ramp) else { throw ConversationError.invalidResponse }
            result.ramp = ramp
        }
        var actionChanges: [String: [AssistanceAction]] = [:]
        for key in ["add_actions", "remove_actions"] {
            guard let value = changes[key] else { continue }
            guard let raw = value as? [String] else { throw ConversationError.invalidResponse }
            let actions = raw.compactMap(AssistanceAction.init(rawValue:))
            guard actions.count == raw.count, !actions.contains(.deployWheelchairRamp) else { throw ConversationError.invalidResponse }
            actionChanges[key] = actions
        }
        result.actions.removeAll { actionChanges["remove_actions", default: []].contains($0) }
        for action in actionChanges["add_actions", default: []] where !result.actions.contains(action) { result.actions.append(action) }
        if let code = result.stopCode, !candidates.contains(where: { $0.stopCode == code }) { throw ConversationError.rejected("unknown_stop") }
        if changes["stop_query"] is String, changes["stop_code"] == nil { result.stopCode = nil }
        if changes["stop_code"] is String { result.stopQuery = nil }
        return result
    }

    private static func question(for draft: ConversationDraft, context: ConversationAppContext) -> (String, String) {
        guard let stop = context.candidates.first(where: { $0.stopCode == draft.stopCode }) else {
            if let query = draft.stopQuery, let codes = context.stopMatches {
                let matches = context.candidates.filter { codes.contains($0.stopCode) }
                func description(_ stop: ConversationStop) -> String { "\(stop.stopName), \(stop.roadName), stop \(stop.stopCode)" }
                if matches.count == 1 { return ("stop", "Is this your stop: \(description(matches[0]))? Choose it below, or say yes.") }
                if !matches.isEmpty { return ("stop", "Which stop do you mean? \(matches.prefix(3).map(description).joined(separator: "; ")). Choose below or say the stop code.") }
                return ("stop", "I couldn't find a stop matching “\(query)”. Try a nearby landmark or the five-digit stop code, or choose on the map.")
            }
            return ("stop", "Where will you board? Choose a stop, or tell me its name or code.")
        }
        guard let bus = draft.busService, stop.services.contains(bus) else { return ("bus", "Which bus do you need? Choose a service at this stop.") }
        if [.wheelchair, .mobility].contains(draft.need), draft.ramp == "unspecified" { return ("ramp", "Do you need a ramp to board?") }
        if draft.actions.isEmpty && draft.ramp != "requested" { return ("help", "What help do you need to board? Tell me everything you need, or choose a suggestion.") }
        let labels: [AssistanceAction: String] = [.additionalBoardingTime: "more time", .confirmBusArrivalIdentity: "help identifying your bus", .audioBoardingInstruction: "spoken guidance", .visualBoardingConfirmation: "written guidance", .visualServiceStopInformation: "journey information"]
        let help = (draft.ramp == "requested" ? ["a ramp"] : []) + draft.actions.compactMap { labels[$0] }
        return ("ready", "For Bus \(bus) at \(stop.stopName): \(help.joined(separator: ", ")). I have what I need. I'll send this request now.")
    }

    private static func requestsPause(_ text: String) -> Bool {
        let value = text.lowercased().replacingOccurrences(of: "’", with: "'")
        return value == "wait" || value.range(of: #"(^|[.!?,]\s*)wait\b"#, options: .regularExpression) != nil
            || ["don't send", "do not send", "don't submit", "do not submit", "not yet", "hold on", "还没说完", "还有要补充", "先别", "不要发送", "别提交", "等一下"]
            .contains(where: value.contains)
    }

    private static func explicitSend(_ text: String) -> Bool {
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().filter { !".!?。！？,，".contains($0) }
        return ["send", "send it", "send my request", "send the request", "please send", "please send it", "please send my request", "yes send it", "发送", "发送请求", "提交请求", "帮我发送"].contains(command)
    }
}

@MainActor
enum ConversationServiceFactory {
    static func make(preferences: PreferencesStore) async throws -> any ConversationServing {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.arguments.contains("-direct-assistant-fixture") {
            return DirectConversationService(providers: OnDeviceConversationFixture())
        }
        #endif
        _ = try DirectConversationProviders(configuration: try await .current())
        return DirectConversationService(providers: SavedConversationProviders())
    }
}

#if DEBUG
/// Explicit UI test dependency. Never calls a network service or handles bookings.
private actor OnDeviceConversationFixture: ConversationModelProviding {
    func transcribe(_ audio: Data, candidates: [ConversationStop]) async throws -> String { "I use a wheelchair and need more time" }
    func interpret(_ payload: Data) async throws -> Data {
        let body = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        let text = (body?["user_text"] as? String ?? "").lowercased()
        var changes: [String: Any] = [:]
        if text.contains("synergy") { changes["stop_query"] = text }
        else if text.contains("01012") { changes = ["stop_query": "01012", "bus_service": "191"] }
        else if text.contains("wheelchair") {
            changes = ["need": "wheelchair", "add_actions": ["additional_boarding_time"]]
            if text.contains("191") { changes["bus_service"] = "191" }
        } else if text.contains("no ramp") { changes["ramp"] = "declined" }
        else if text.contains("difficulty seeing") || text.contains("cannot see") {
            changes = ["vision_support": true, "add_actions": ["confirm_bus_arrival_identity"]]
        }
        let intent = text == "send my request" ? "send" : (text.contains("wait") || text.contains("don't send") ? "hold" : "update")
        return try JSONSerialization.data(withJSONObject: ["changes": changes, "intent": intent])
    }
}
#endif
