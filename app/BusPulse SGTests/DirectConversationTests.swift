import Foundation
import Testing
@testable import BusPulse_SG

private actor ConversationModelStub: ConversationModelProviding {
    var calls = 0
    var answer = #"{"changes":{},"intent":"update"}"#
    func set(_ value: String) { answer = value }
    func interpret(_ payload: Data) async throws -> Data { calls += 1; return Data(answer.utf8) }
    func transcribe(_ audio: Data, candidates: [ConversationStop]) async throws -> String { "wheelchair, more time" }
}

@Suite("On-phone conversational state")
struct DirectConversationTests {
    private func context(selected: Bool = true) -> ConversationAppContext {
        ConversationAppContext(candidates: [ConversationStop(stopCode: "28031", stopName: "Bef The Synergy", roadName: "Boon Lay Way", services: ["191", "7"])],
                               selected: selected ? ConversationSelection(stopCode: "28031", busService: "191") : nil, locationAvailable: false)
    }
    private func input(_ revision: Int, _ event: ConversationEvent, context: ConversationAppContext? = nil, id: String = UUID().uuidString) -> ConversationTurn {
        ConversationTurn(version: 1, sessionId: "test-session", turnId: id, revision: revision, context: context ?? self.context(), event: event)
    }

    @Test("Multiple help choices submit together without inference")
    func multipleHelpChoices() async throws {
        let model = ConversationModelStub()
        let service = DirectConversationService(providers: model)
        let event = ConversationEvent(kind: "help",
            actions: [.additionalBoardingTime, .audioBoardingInstruction], ramp: "requested")
        let result = try await service.turn(input(0, event))
        #expect(result.draft.actions == [.additionalBoardingTime, .audioBoardingInstruction])
        #expect(result.draft.ramp == "requested")
        #expect(result.submissionReady == true)
        #expect(await model.calls == 0)
    }

    @Test("Local choices work with no inference and retries are idempotent")
    func choicesAndReplay() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        let request = input(0, ConversationEvent(kind: "choice", field: "add_actions", value: "additional_boarding_time"))
        let first = try await service.turn(request)
        #expect(first.question == "ready")
        #expect(first.submissionReady == true)
        #expect(try await service.turn(request).revision == 1)
        #expect(await model.calls == 0)
        await #expect(throws: (any Error).self) { try await service.turn(input(0, ConversationEvent(kind: "choice", field: "ramp", value: "requested"), id: request.turnId)) }
    }

    @Test("Follow-ups preserve needs and refuse a negated send")
    func followups() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        await model.set(#"{"changes":{"need":"wheelchair","add_actions":["additional_boarding_time"]},"intent":"update"}"#)
        let first = try await service.turn(input(0, ConversationEvent(kind: "text", text: "wheelchair, more time")))
        #expect(first.question == "ramp"); #expect(first.draft.ramp == "unspecified")
        _ = try await service.turn(input(1, ConversationEvent(kind: "choice", field: "ramp", value: "requested")))
        await model.set(#"{"changes":{"ramp":"declined","vision_support":true,"add_actions":["confirm_bus_arrival_identity"]},"intent":"update"}"#)
        let corrected = try await service.turn(input(2, ConversationEvent(kind: "text", text: "No ramp. I also have difficulty seeing.")))
        #expect(corrected.draft.need == .wheelchair)
        #expect(corrected.draft.actions == [.additionalBoardingTime, .confirmBusArrivalIdentity])
        #expect(corrected.draft.visionSupport)
        await model.set(#"{"changes":{},"intent":"send"}"#)
        let refused = try await service.turn(input(3, ConversationEvent(kind: "text", text: "Don't send my request")))
        #expect(!refused.sendRequested)
        #expect(refused.submissionReady == false)
        #expect(try await service.turn(input(4, ConversationEvent(kind: "text", text: "send my request"))).sendRequested)
    }

    @Test("Automatic submission waits for missing fields, uncertainty and an explicit hold")
    func automaticSubmission() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        await model.set(#"{"changes":{"need":"wheelchair","add_actions":["additional_boarding_time"]},"intent":"update"}"#)
        let incomplete = try await service.turn(input(0, ConversationEvent(kind: "text", text: "wheelchair, more time")))
        #expect(incomplete.submissionReady == false)
        await model.set(#"{"changes":{"ramp":"declined"},"intent":"hold"}"#)
        let held = try await service.turn(input(1, ConversationEvent(kind: "text", text: "No ramp, I have more to add")))
        #expect(held.question == "ready"); #expect(held.submissionReady == false)
        await model.set(#"{"changes":{"vision_support":true},"intent":"update"}"#)
        #expect(try await service.turn(input(2, ConversationEvent(kind: "text", text: "I cannot see"))).submissionReady == false)
        await model.set(#"{"changes":{},"intent":"send"}"#)
        #expect(try await service.turn(input(3, ConversationEvent(kind: "text", text: "send my request"))).submissionReady == true)
        await model.set(#"{"changes":{},"intent":"unclear"}"#)
        #expect(try await service.turn(input(4, ConversationEvent(kind: "text", text: "My companion needs help too"))).submissionReady == false)
    }

    @Test("Waiting at a stop does not mean hold the request")
    func waitingIsNotAHold() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        await model.set(#"{"changes":{"add_actions":["additional_boarding_time"]},"intent":"update"}"#)
        let reply = try await service.turn(input(0, ConversationEvent(kind: "text", text: "I need more time because waiting is difficult")))
        #expect(reply.submissionReady == true)
    }

    @Test("Stop retrieval and yes confirmation require no second model call")
    func retrieval() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        var ctx = context(selected: false)
        await model.set(#"{"changes":{"stop_query":"B4 the Synergy"},"intent":"update"}"#)
        _ = try await service.turn(input(0, ConversationEvent(kind: "text", text: "B4 the Synergy"), context: ctx))
        ctx.stopMatches = ["28031"]
        let found = try await service.turn(input(1, ConversationEvent(kind: "stops"), context: ctx))
        #expect(found.message.contains("Is this your stop: Bef The Synergy"))
        #expect(found.draft.stopCode == nil)
        let yes = try await service.turn(input(2, ConversationEvent(kind: "text", text: "yes"), context: ctx))
        #expect(yes.draft.stopCode == "28031"); #expect(yes.question == "bus")
        #expect(await model.calls == 1)
    }

    @Test("Ambiguous yes and an empty search never select a stop")
    func ambiguity() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        var ctx = context(selected: false)
        ctx.candidates.append(ConversationStop(stopCode: "28049", stopName: "Opp The Synergy", roadName: "Boon Lay Way", services: ["7"]))
        await model.set(#"{"changes":{"stop_query":"Synergy"},"intent":"update"}"#)
        _ = try await service.turn(input(0, ConversationEvent(kind: "text", text: "Synergy"), context: ctx))
        ctx.stopMatches = ["28031", "28049"]
        _ = try await service.turn(input(1, ConversationEvent(kind: "stops"), context: ctx))
        let yes = try await service.turn(input(2, ConversationEvent(kind: "text", text: "yes"), context: ctx))
        #expect(yes.draft.stopCode == nil); #expect(yes.message.contains("Which stop"))
        ctx.stopMatches = []
        #expect(try await service.turn(input(3, ConversationEvent(kind: "stops"), context: ctx)).message.contains("couldn't find"))
    }

    @Test("Malformed output is atomic and the same turn can be retried", arguments: [
        #"{"changes":{"ramp":"requested","add_actions":["drive_bus"]},"intent":"update"}"#,
        #"{"changes":{"vision_support":1},"intent":"update"}"#,
        #"{"changes":{"stop_code":"99999"},"intent":"update"}"#,
        #"{"changes":{"need":"invented"},"intent":"update"}"#,
        #"{"changes":{"extra_field":true},"intent":"update"}"#,
        #"{"changes":{},"intent":"book_now"}"#,
        "not json"
    ])
    func invalidPatch(_ bad: String) async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        await model.set(bad)
        let turn = input(0, ConversationEvent(kind: "text", text: "help"))
        await #expect(throws: (any Error).self) { try await service.turn(turn) }
        await model.set(#"{"changes":{"add_actions":["additional_boarding_time"]},"intent":"update"}"#)
        let retried = try await service.turn(turn)
        #expect(retried.revision == 1); #expect(retried.draft.ramp == "unspecified")
    }

    @Test("Invalid route prevents send and a new session has independent state")
    func invalidRoute() async throws {
        let model = ConversationModelStub(); let service = DirectConversationService(providers: model)
        await model.set(#"{"changes":{"bus_service":"999","ramp":"requested"},"intent":"send"}"#)
        let reply = try await service.turn(input(0, ConversationEvent(kind: "text", text: "send my request")))
        #expect(reply.question == "bus"); #expect(!reply.sendRequested)
        let other = ConversationTurn(version: 1, sessionId: "other", turnId: "other-turn", revision: 0, context: context(), event: ConversationEvent(kind: "start"))
        #expect(try await service.turn(other).draft.ramp == "unspecified")
    }
}

private final class ProviderURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (code, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite("Direct provider transport", .serialized)
struct DirectProviderTests {
    private func provider() throws -> DirectConversationProviders {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProviderURLProtocol.self]
        return try DirectConversationProviders(configuration: AssistantProviderConfiguration(groqKey: "synthetic-groq", deepSeekKey: "synthetic-deepseek"), session: URLSession(configuration: config))
    }
    @Test("Only the two HTTPS provider hosts are called, with no Mac gateway")
    func endpoints() async throws {
        ProviderURLProtocol.handler = { request in
            #expect(request.url?.scheme == "https")
            #expect(["api.groq.com", "api.deepseek.com"].contains(request.url!.host!))
            #expect(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer synthetic-") == true)
            switch request.url!.path {
            case "/openai/v1/audio/transcriptions":
                #expect(request.value(forHTTPHeaderField: "Content-Type")?.contains("multipart/form-data") == true)
                return (200, Data(#"{"text":"B4 the Synergy","segments":[{"no_speech_prob":0.01}]}"#.utf8))
            case "/chat/completions":
                return (200, Data(#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"changes\":{},\"intent\":\"update\"}"}}]}"#.utf8))
            case "/models", "/openai/v1/models": return (200, Data(#"{"data":[]}"#.utf8))
            default: throw URLError(.unsupportedURL)
            }
        }
        let service = try provider()
        try await service.checkConnection()
        #expect(try await service.transcribe(Data(repeating: 1, count: 200), candidates: []) == "B4 the Synergy")
        #expect(try await service.interpret(Data("{}".utf8)) == Data(#"{"changes":{},"intent":"update"}"#.utf8))
    }
    @Test("Silence is rejected rather than interpreted")
    func silence() async throws {
        ProviderURLProtocol.handler = { _ in (200, Data(#"{"text":"made up","segments":[{"no_speech_prob":0.95}]}"#.utf8)) }
        let service = try provider()
        await #expect(throws: (any Error).self) { try await service.transcribe(Data(repeating: 1, count: 200), candidates: []) }
    }
    @Test("Provider errors never expose raw response bodies or credentials", arguments: [401, 402, 429, 503])
    func errors(_ status: Int) async throws {
        ProviderURLProtocol.handler = { _ in (status, Data("secret-provider-detail".utf8)) }
        do { try await provider().checkConnection(); Issue.record("Expected provider error") }
        catch { #expect(!error.localizedDescription.contains("secret-provider-detail")) }
    }
}

@Suite("Assistant Keychain")
struct AssistantCredentialTests {
    @Test("Both keys survive a new store instance; invalid updates preserve previous keys")
    func persistence() async throws {
        let name = "sg.buspulse.tests." + UUID().uuidString
        let first = AssistantCredentialStore(service: name)
        #expect(try await first.load().groqKey.isEmpty)
        try await first.save(groq: "synthetic-groq", deepSeek: "synthetic-deepseek")
        let reopened = AssistantCredentialStore(service: name)
        #expect(try await reopened.load().groqKey == "synthetic-groq")
        #expect(try await reopened.load().deepSeekKey == "synthetic-deepseek")
        await #expect(throws: (any Error).self) { try await reopened.save(groq: "bad key", deepSeek: "new") }
        #expect(try await first.load().deepSeekKey == "synthetic-deepseek")
        try await reopened.save(groq: "replacement", deepSeek: "replacement2")
        #expect(try await first.load().groqKey == "replacement")
        try await first.remove()
        #expect(try await reopened.load().groqKey.isEmpty)
    }
}
