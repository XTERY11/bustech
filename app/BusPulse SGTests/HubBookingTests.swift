import Foundation
import Testing
@testable import BusPulse_SG

@Suite("BusTech booking contract", .serialized)
struct HubBookingTests {
    @Test("Every need maps to the frozen vocabulary, including specific mobility aids")
    func vocabulary() throws {
        #expect(Set(AccessibilityNeed.allCases.map(\.hubValue)) == Set([
            "WHEELCHAIR", "CRUTCH", "CANE", "WALKER", "STROLLER", "VISUAL_ASSISTANCE",
            "HEARING_ASSISTANCE", "MOBILITY_ASSISTANCE", "NONE", "UNKNOWN"
        ]))
        #expect(Set(AssistanceAction.allCases.map(\.hubValue)).count == 5)
        #expect(Set(InteractionMode.allCases.map { $0.rawValue.uppercased() }) == ["AUDIO", "VISUAL", "BOTH"])
        let noConsent = booking(actions: [], ramp: .unspecified)
        #expect(try noConsent.validated().rampPreference == .unspecified)
        #expect(HubBookingEnvelope(request: noConsent).payload.assistance_requested.isEmpty)
        #expect(throws: AssistanceValidationError.conflictingRampPreference) {
            try booking(actions: [.deployWheelchairRamp], ramp: .declined).validated()
        }
        #expect(!HubBookingEnvelope.isValidID("route with spaces"))
        #expect(!HubBookingEnvelope.isValidID(String(repeating: "x", count: 81)))
    }

    @Test("Observation time includes UTC timezone and round-trips independently of the hub timezone")
    func observationTimeIsUnambiguous() throws {
        let now = Date(timeIntervalSince1970: 1_790_859_415.125)
        let envelope = HubBookingEnvelope(request: booking(), observedAt: now)
        #expect(envelope.observed_at == "2026-10-01T12:56:55.125Z")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        #expect(try #require(formatter.date(from: envelope.observed_at)).timeIntervalSince1970 == now.timeIntervalSince1970)
    }

    @Test("Retries keep the identical envelope and Bearer authentication")
    func retriesAreIdempotent() async throws {
        HubURLProtocol.fixture.reset([.response(503, "{}"), .response(202, #"{"accepted":true,"duplicate":true}"#)])
        let client = client()
        let request = booking()
        do { _ = try await client.submit(request); Issue.record("Expected rejection") } catch {}
        let receipt = try await client.submit(request)
        let calls = HubURLProtocol.fixture.calls
        #expect(calls.count == 2)
        #expect(calls[0].body == calls[1].body)
        #expect(calls.allSatisfy { $0.authorization == "Bearer test-token" })
        #expect(calls[0].path == "/api/booking")
        let envelope = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(calls[0].body))
        #expect(envelope.event_id == receipt.providerReference)
        #expect(envelope.payload.active)
        #expect(envelope.payload.accessibility_need == "WHEELCHAIR")
    }

    @Test("Cancellation is a new active:false event; an ambiguous retry is identical")
    func cancellationAndRetry() async throws {
        let request = booking()
        let eventID = "app-booking-\(request.id.uuidString)"
        let state = snapshotJSON(request: request, eventID: eventID)
        HubURLProtocol.fixture.reset([
            .response(202, #"{"accepted":true}"#), .response(200, state), .response(503, "{}"),
            .response(200, state), .response(202, #"{"accepted":true,"duplicate":true}"#)
        ])
        let client = client()
        _ = try await client.submit(request)
        do { try await client.cancel(request); Issue.record("Expected rejection") } catch {}
        try await client.cancel(request)
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        #expect(posts.count == 3)
        #expect(posts[1].body == posts[2].body)
        let cancellation = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts[1].body))
        #expect(!cancellation.payload.active)
        #expect(cancellation.event_id != eventID)
        #expect(HubURLProtocol.fixture.calls.allSatisfy { $0.authorization == "Bearer test-token" })
    }

    @Test("Another passenger's booking cannot be cancelled by this client")
    func cancellationOwnership() async throws {
        let request = booking()
        HubURLProtocol.fixture.reset([.response(200, snapshotJSON(request: request, eventID: "someone-else"))])
        do { try await client().cancel(request); Issue.record("Expected ownership rejection") }
        catch HTTPVehicleCloudService.ServiceError.bookingReplaced {} catch { Issue.record("Unexpected error: \(error)") }
        #expect(HubURLProtocol.fixture.calls.count == 1)
        #expect(HubURLProtocol.fixture.calls[0].path == "/api/state")
    }

    @Test("A 2xx response other than contract acceptance cannot create receipt")
    func strictReceipt() async {
        for response in [HubFixture.Response.response(200, #"{"accepted":true}"#), .response(202, #"{"accepted":false}"#), .response(202, "{}"), .response(401, #"{"error":"BRIDGE_TOKEN_REQUIRED"}"#)] {
            HubURLProtocol.fixture.reset([response])
            do { _ = try await client().submit(booking()); Issue.record("Expected invalid receipt") } catch {}
        }
    }

    @Test("Feedback correlates by booking channel, discards stale decisions and expires at five minutes")
    func feedbackCorrelation() throws {
        let request = booking()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for status in ["READY", "NEEDS_CONFIRMATION", "CANNOT_EXECUTE"] {
            let state = try decode(snapshotJSON(request: request, eventID: "ours", time: now, status: status))
            #expect(state.feedback(for: request, eventID: "ours", now: now).result?.plan_status.rawValue == status)
            #expect(state.feedback(for: request, eventID: "different", now: now) == .replaced)
            #expect(state.feedback(for: request, eventID: "ours", now: now.addingTimeInterval(300)) == .expired)
        }
        let planning = try decode(snapshotJSON(request: request, eventID: "ours", time: now, running: "run-new"))
        #expect(planning.feedback(for: request, eventID: "ours", now: now) == .planning)
        let inactive = try decode(snapshotJSON(request: request, eventID: "ours", time: now, active: false))
        #expect(inactive.feedback(for: request, eventID: "ours", now: now) == .cancelled)
        let demo = try decode(snapshotJSON(request: request, eventID: "ours", time: now, source: "demo"))
        #expect(demo.feedback(for: request, eventID: "ours", now: now) == .replaced)
    }

    @Test("Hub receipt never fabricates an ACK; failed polling clears READY; audio is announced once")
    @MainActor
    func serviceLifecycle() async throws {
        let request = booking(interaction: .both)
        let event = "app-booking-\(request.id.uuidString)"
        let state = snapshotJSON(request: request, eventID: event)
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, state), .response(503, "{}")])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(service.session(for: request.context)?.phase == .sent)
        #expect(service.session(for: request.context)?.acknowledgement == nil)
        #expect(service.takeAudioFeedback(for: request) != nil)
        #expect(service.takeAudioFeedback(for: request) == nil)
        await service.refreshFeedback(for: request)
        #expect(service.session(for: request.context)?.hubFeedback?.result == nil)
        await service.refreshFeedback(for: request, now: .now.addingTimeInterval(301))
        #expect(service.session(for: request.context)?.hubFeedback == .expired)
    }

    @Test("Retry after an ambiguous cancellation retries cancellation and never resubmits the booking")
    @MainActor
    func failedCancellationKeepsItsOperation() async throws {
        let request = booking()
        let state = snapshotJSON(request: request, eventID: "app-booking-\(request.id.uuidString)")
        HubURLProtocol.fixture.reset([
            .response(202, #"{"accepted":true}"#), .response(200, state),
            .response(200, state), .response(503, "{}"),
            .response(200, state), .response(202, #"{"accepted":true,"duplicate":true}"#)
        ])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        await service.cancel(request)
        #expect(service.session(for: request.context)?.hubFeedback?.result == nil)
        await service.retry(request)
        #expect(service.session(for: request.context)?.phase == .cancelled)
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        #expect(posts.count == 3)
        #expect(posts[1].body == posts[2].body)
        let envelope = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts[2].body))
        #expect(!envelope.payload.active)
    }

    @Test("Automatic feedback uses speech only for vision support and ETA never invents minutes")
    func passengerDefaults() throws {
        for need in AccessibilityNeed.allCases {
            let request = AssistanceRequest(context: booking().context, intent: .boarding, need: need,
                preferredInteraction: .both, assistanceRequested: [.deployWheelchairRamp]).withAutomaticFeedback
            #expect(request.preferredInteraction == (need == .visualAccessibility ? .audio : .visual))
            #expect(try request.validated().assistanceRequested == [.deployWheelchairRamp])
        }
        let now = Date.now
        #expect(AssistanceRequest.arrivalMessage(estimatedArrival: now.addingTimeInterval(121), now: now) == "The bus will arrive in 2 min.")
        #expect(AssistanceRequest.arrivalMessage(estimatedArrival: nil) == "Arrival time unavailable.")
        #expect(AssistanceRequest.arrivalMessage(estimatedArrival: now, now: now) == "The bus is arriving.")
    }

    @Test("Trigger latches across false, lost connection and repeat events, and resets for a new request")
    @MainActor
    func triggerLifecycle() async throws {
        let request = booking()
        let event = "app-booking-\(request.id.uuidString)"
        let t = Date.now.addingTimeInterval(1)
        let on = snapshotJSON(request: request, eventID: event, time: t, triggered: true)
        let off = snapshotJSON(request: request, eventID: event, time: t, triggered: false)
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, off),
            .response(200, on), .response(200, off), .response(503, "{}"), .response(200, on),
            .response(200, on), .response(202, #"{"accepted":true}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(!service.hasTriggered(for: request))
        await service.refreshFeedback(for: request)
        #expect(service.hasTriggered(for: request))
        #expect(service.takeTriggerFeedback(for: request))
        #expect(!service.takeTriggerFeedback(for: request))
        for _ in 0..<3 {
            await service.refreshFeedback(for: request)
            #expect(service.hasTriggered(for: request))
            #expect(!service.takeTriggerFeedback(for: request))
        }
        await service.cancel(request)
        #expect(!service.hasTriggered(for: request))
        #expect(!service.takeTriggerFeedback(for: request))
        let replacement = booking()
        try service.prepare(replacement)
        #expect(!service.hasTriggered(for: replacement))
        #expect(!service.hasTriggered(for: request))
        #expect(!service.takeTriggerFeedback(for: replacement))
    }

    @Test("Old or unrelated triggers cannot confirm a request; SSE snapshots preserve short pulses")
    func triggerOwnershipAndStream() throws {
        // Use an exact second: epoch-millisecond serialization can round a live Date below its receipt.
        let request = booking(), now = Date(timeIntervalSince1970: 1_700_000_000)
        let receipt = VehicleSubmissionReceipt(requestID: request.id, providerReference: "ours", submittedAt: now)
        for (id, time, active) in [("other", now, true), ("ours", now.addingTimeInterval(-30), true), ("ours", now, false)] {
            let state = try decode(snapshotJSON(request: request, eventID: id, time: time, active: active, triggered: true))
            #expect(!state.hasTrigger(for: request, receipt: receipt, now: now))
        }
        let json = snapshotJSON(request: request, eventID: "ours", time: now, triggered: true)
        let direct = Data("{\"type\":\"snapshot\",\"data\":\(json)}".utf8)
        let signal = Data("{\"type\":\"signal\",\"data\":{\"snapshot\":\(json)}}".utf8)
        for data in [direct, signal] {
            #expect(try HubStreamEvent.snapshot(from: data)?.hasTrigger(for: request, receipt: receipt, now: now) == true)
        }
        #expect(try HubStreamEvent.snapshot(from: Data(#"{"type":"result","data":{}}"#.utf8)) == nil)
    }

    @Test("Arrival needs matching fresh stopped vehicle telemetry")
    func boardingArrivalContract() throws {
        let request = booking(), now = Date.now
        func state(_ vehicle: [String: Any]?) throws -> HubSnapshot {
            var payload = try JSONSerialization.jsonObject(with: Data(snapshotJSON(request: request, eventID: "ours", time: now).utf8)) as! [String: Any]
            var context = payload["context"] as! [String: Any]
            context["vehicle_context"] = vehicle
            payload["context"] = context
            return try JSONDecoder().decode(HubSnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        }
        let vehicle: [String: Any] = ["route_id": request.busService, "stop_id": request.context.stopCode,
            "motion_state": "STOPPED", "parking_brake_engaged": true, "observation_age_ms": 100]
        #expect(try state(vehicle).busIsAtStop(for: request, eventID: "ours", now: now))
        #expect(try !state(vehicle).busIsAtStop(for: request, eventID: "other", now: now))
        #expect(try !state(vehicle).busIsAtStop(for: request, eventID: "ours", now: now.addingTimeInterval(300)))
        #expect(try !state(nil).busIsAtStop(for: request, eventID: "ours", now: now))
        let invalidFields: [(String, Any)] = [("route_id", "other"), ("stop_id", "other"),
            ("motion_state", "MOVING"), ("parking_brake_engaged", false),
            ("observation_age_ms", 1501), ("observation_age_ms", -1)]
        for (field, value) in invalidFields {
            var invalid = vehicle
            invalid[field] = value
            #expect(try !state(invalid).busIsAtStop(for: request, eventID: "ours", now: now))
        }
        let result = HubResult(request_id: "guidance", plan_status: .needsConfirmation, simulated: true,
            execution_authorized: false, passenger_communication: .init(channel: "BOTH", language: "en-SG",
                audio_text: "Please wait for the safety operator.", display_text: "  "))
        #expect(result.passengerMessage == "Please wait for the safety operator.")
    }

    @Test("Boarding follows trigger and clears on disconnect, movement and cancellation")
    @MainActor
    func boardingLifecycle() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        func state(triggered: Bool, motion: String = "STOPPED", status: String = "READY") throws -> String {
            var payload = try JSONSerialization.jsonObject(with: Data(snapshotJSON(request: request,
                eventID: event, time: .now.addingTimeInterval(1), status: status, triggered: triggered).utf8)) as! [String: Any]
            var context = payload["context"] as! [String: Any]
            context["vehicle_context"] = ["route_id": request.busService, "stop_id": request.context.stopCode,
                "motion_state": motion, "parking_brake_engaged": true, "observation_age_ms": 0]
            payload["context"] = context
            return String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
        }
        let arrived = try state(triggered: true)
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#),
            .response(200, try state(triggered: false)), .response(200, arrived), .response(200, arrived),
            .response(503, "{}"), .response(200, try state(triggered: true, motion: "MOVING")),
            .response(200, try state(triggered: true, status: "CANNOT_EXECUTE")),
            .response(200, arrived), .response(202, #"{"accepted":true}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(!service.busIsAtStop(for: request))
        await service.refreshFeedback(for: request)
        #expect(service.busIsAtStop(for: request))
        #expect(service.takeBoardingFeedback(for: request)?.passengerMessage == "Wait for guidance.")
        await service.refreshFeedback(for: request)
        #expect(service.takeBoardingFeedback(for: request) == nil)
        await service.refreshFeedback(for: request)
        #expect(!service.busIsAtStop(for: request))
        await service.refreshFeedback(for: request)
        #expect(!service.busIsAtStop(for: request))
        await service.refreshFeedback(for: request)
        #expect(service.busIsAtStop(for: request))
        #expect(service.session(for: request.context)?.hubFeedback?.result?.plan_status == .cannotExecute)
        await service.cancel(request)
        #expect(!service.busIsAtStop(for: request))
    }

    @Test("Signal 2 requires a fresh explicit exit for the same booking and ROI after entry")
    func exitContractAndStream() throws {
        let request = booking(), now = Date(timeIntervalSince1970: 1_700_000_000)
        let receipt = VehicleSubmissionReceipt(requestID: request.id, providerReference: "ours",
                                               submittedAt: now.addingTimeInterval(-5))
        let entered = now.addingTimeInterval(-2)
        func exits(_ json: String, roi: String? = "stop-a") throws -> Bool {
            try decode(json).hasExitTrigger(for: request, receipt: receipt, enteredAt: entered, roiID: roi, now: now)
        }
        let valid = snapshotJSON(request: request, eventID: "ours", time: now, zoneEvent: "exit", roiID: "stop-a")
        #expect(try exits(valid))
        #expect(try !exits(valid, roi: nil))
        #expect(try !exits(valid, roi: "other"))
        for event in [nil, "present", "enter", "leaving"] as [String?] {
            #expect(try !exits(snapshotJSON(request: request, eventID: "ours", time: now, zoneEvent: event, roiID: "stop-a")))
        }
        for time in [now.addingTimeInterval(-3), now.addingTimeInterval(-20), now.addingTimeInterval(6)] {
            #expect(try !exits(snapshotJSON(request: request, eventID: "ours", time: time, zoneEvent: "exit", roiID: "stop-a")))
        }
        #expect(try !exits(snapshotJSON(request: request, eventID: "other", time: now, zoneEvent: "exit", roiID: "stop-a")))
        #expect(try !exits(snapshotJSON(request: request, eventID: "ours", time: now, active: false, zoneEvent: "exit", roiID: "stop-a")))
        #expect(try !exits(snapshotJSON(request: request, eventID: "ours", time: now, source: "demo", zoneEvent: "exit", roiID: "stop-a")))
        #expect(try !exits(snapshotJSON(request: request, eventID: "ours", time: now, triggered: true, zoneEvent: "exit", roiID: "stop-a")))
        for envelope in ["{\"type\":\"snapshot\",\"data\":\(valid)}",
                         "{\"type\":\"signal\",\"data\":{\"snapshot\":\(valid)}}"] {
            let snapshot = try #require(try HubStreamEvent.snapshot(from: Data(envelope.utf8)))
            #expect(snapshot.hasExitTrigger(for: request, receipt: receipt, enteredAt: entered, roiID: "stop-a", now: now))
        }
    }

    @Test("Signal 2 latches after entry, preserves guidance, deduplicates audio and clears with the session")
    @MainActor
    func exitLifecycle() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let t = Date.now.addingTimeInterval(1)
        let enter = snapshotJSON(request: request, eventID: event, time: t, triggered: true, zoneEvent: "enter", roiID: "stop-a")
        let exit = snapshotJSON(request: request, eventID: event, time: t.addingTimeInterval(1), zoneEvent: "exit", roiID: "stop-a")
        let clear = snapshotJSON(request: request, eventID: event, time: t, triggered: false)
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, exit),
            .response(200, enter), .response(200, clear), .response(200, exit), .response(200, exit),
            .response(503, "{}"), .response(200, clear), .response(200, clear), .response(202, #"{"accepted":true}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(!service.hasExitTriggered(for: request)) // Exit before entry is not boarding.
        await service.refreshFeedback(for: request)
        #expect(service.hasTriggered(for: request))
        await service.refreshFeedback(for: request)
        #expect(!service.hasExitTriggered(for: request)) // A plain false is not signal 2.
        await service.refreshFeedback(for: request)
        #expect(service.hasExitTriggered(for: request))
        #expect(!service.busIsAtStop(for: request)) // Signal 2 does not depend on simulated vehicle telemetry.
        #expect(service.takeBoardingFeedback(for: request)?.passengerMessage == "Wait for guidance.")
        await service.refreshFeedback(for: request)
        #expect(service.takeBoardingFeedback(for: request) == nil)
        await service.refreshFeedback(for: request)
        #expect(!service.hasExitTriggered(for: request)) // Hide the actionable prompt while disconnected.
        await service.refreshFeedback(for: request)
        #expect(service.hasExitTriggered(for: request)) // Recover the already-observed exit.
        #expect(service.takeBoardingFeedback(for: request) == nil)
        await service.cancel(request)
        #expect(!service.hasExitTriggered(for: request))
        let replacement = booking()
        try service.prepare(replacement)
        #expect(!service.hasExitTriggered(for: replacement))
        #expect(!service.hasExitTriggered(for: request))
    }

    private func booking(actions: [AssistanceAction] = [.deployWheelchairRamp, .additionalBoardingTime],
                         ramp: RampPreference = .requested, interaction: InteractionMode = .visual) -> AssistanceRequest {
        AssistanceRequest(context: AssistanceContext(stopCode: "DEMO_STOP", stopName: "Demo", roadName: "",
                          busService: "DEMO_ROUTE", estimatedArrival: nil), intent: .boarding, need: .wheelchair,
                          preferredInteraction: interaction, assistanceRequested: actions, rampPreference: ramp)
    }

    private func client() -> HTTPVehicleCloudService {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HubURLProtocol.self]
        return HTTPVehicleCloudService(endpoint: URL(string: "http://hub.test:8787/api/booking")!, token: "test-token",
                                       session: URLSession(configuration: configuration))
    }

    private func decode(_ json: String) throws -> HubSnapshot { try JSONDecoder().decode(HubSnapshot.self, from: Data(json.utf8)) }

    private func snapshotJSON(request: AssistanceRequest, eventID: String, time: Date = .now,
                              status: String = "READY", running: String? = nil, active: Bool = true, source: String = "external", triggered: Bool = false,
                              zoneEvent: String? = nil, roiID: String? = nil) -> String {
        var zone: [String: Any] = ["triggered": triggered]
        zone["event"] = zoneEvent
        zone["roi_id"] = roiID
        let payload: [String: Any] = [
            "source": source, "channels": ["booking": ["event_id": eventID, "observed_at": time.timeIntervalSince1970 * 1000], "perception": ["event_id": "sense-1", "observed_at": time.timeIntervalSince1970 * 1000]],
            "context": ["request": ["active": active, "route_id": request.busService, "stop_id": request.context.stopCode], "perception": ["zone": zone]],
            "running": running as Any? ?? NSNull(),
            "result": ["request_id": "run-1", "plan_status": status, "simulated": true, "execution_authorized": false,
                       "passenger_communication": ["channel": "BOTH", "language": "en-SG", "display_text": "Wait for guidance.", "audio_text": "Wait for guidance."]]
        ]
        return String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    }
}

private final class HubFixture: @unchecked Sendable {
    enum Response: Sendable { case response(Int, String) }
    struct Call: Sendable { let path: String; let body: Data?; let authorization: String? }
    private let lock = NSLock()
    private var responses: [Response] = []
    private var recorded: [Call] = []
    var calls: [Call] { lock.withLock { recorded } }
    func reset(_ responses: [Response]) { lock.withLock { self.responses = responses; recorded = [] } }
    func receive(_ request: URLRequest) -> Response {
        lock.withLock {
            var body = request.httpBody
            if body == nil, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 4096)
                var data = Data()
                while stream.hasBytesAvailable {
                    let count = stream.read(&bytes, maxLength: bytes.count)
                    if count <= 0 { break }
                    data.append(contentsOf: bytes.prefix(count))
                }
                body = data
            }
            recorded.append(Call(path: request.url!.path, body: body, authorization: request.value(forHTTPHeaderField: "Authorization")))
            return responses.isEmpty ? .response(500, "{}") : responses.removeFirst()
        }
    }
}

private final class HubURLProtocol: URLProtocol, @unchecked Sendable {
    static let fixture = HubFixture()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = Self.fixture.receive(request)
        if case let .response(status, body) = response {
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
