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

    @Test("Legacy hub without journey: trigger latches across false, lost connection and repeat events, and resets for a new request")
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

    @Test("Legacy hub without journey: old or unrelated triggers cannot confirm a request; SSE snapshots preserve short pulses")
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

    @Test("Legacy hub without journey: arrival needs matching fresh stopped vehicle telemetry")
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

    @Test("Legacy hub without journey: boarding follows trigger and clears on disconnect, movement and cancellation")
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

    @Test("Legacy hub without journey: signal 2 requires a fresh explicit exit for the same booking and ROI after entry")
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

    @Test("Legacy hub without journey: signal 2 latches after entry, preserves guidance, deduplicates audio and clears with the session")
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


    // MARK: v0.5 hub journey

    @Test("Journey and navigation decode from a v0.5 snapshot; older or malformed journeys fall back")
    func journeyDecoding() throws {
        let request = booking(), now = Date(timeIntervalSince1970: 1_800_000_000)
        let onBoard = try decode(snapshotJSON(request: request, eventID: "ours", time: now,
            journey: journeyJSON("ours", revision: 8, stage: "ON_BOARD", matched: true, labels: ["WHEELCHAIR"],
                                 completed: true, reason: "boarding_preview",
                                 title: "Follow the wheelchair-space guidance", text: "From the entrance, face into the bus.",
                                 animation: ["id": "ours:boarding", "phase": "boarding", "aid": "wheelchair",
                                             "started_at": 1_800_000_000_000.0, "duration_ms": 16000,
                                             "target": ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"]]),
            navigation: navigationJSON(phase: "TO_WHEELCHAIR_BAY", destination: ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"],
                                       steps: true)))
        let journey = try #require(onBoard.journey)
        #expect(journey.journeyStage == .onBoard)
        #expect(journey.isMatched && journey.isCompleted)
        #expect(journey.revision == 8)
        #expect(journey.labels == ["WHEELCHAIR"])
        #expect(journey.boarding_target?.title == "Wheelchair bay")
        #expect(journey.animation?.duration_ms == 16000)
        #expect(journey.guidanceTitle == "Follow the wheelchair-space guidance")
        let navigation = try #require(onBoard.navigation)
        #expect(navigation.visibleSteps.map(\.maneuver) == ["START", "STRAIGHT", "TURN_RIGHT", "ARRIVE"])
        #expect(navigation.visibleSteps.first?.distance_m == nil)
        #expect(navigation.visibleSteps[1].distance_m == 0.9)
        #expect(navigation.cabin_route?.steps?.count == 4)
        #expect(onBoard.ownJourney(eventID: "ours") != nil)
        #expect(onBoard.ownJourney(eventID: "other") == nil)
        #expect(HubBoardingTarget(type: "SEAT", id: "S03").title == "Seat S03")
        #expect(HubBoardingTarget(type: "BUS_STOP", id: "09048").title == nil)

        let legacy = try decode(snapshotJSON(request: request, eventID: "ours", time: now))
        #expect(legacy.journey == nil && legacy.navigation == nil)
        var payload = try JSONSerialization.jsonObject(with: Data(snapshotJSON(request: request, eventID: "ours", time: now).utf8)) as! [String: Any]
        payload["journey"] = ["stage": 3, "revision": "x"]
        payload["navigation"] = NSNull()
        let malformed = try JSONDecoder().decode(HubSnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        #expect(malformed.journey == nil)
        #expect(malformed.result?.plan_status == .ready)
    }

    @Test("Journey feedback follows the hub: ownership, cancel, expiry, and no local expiry once completed")
    func journeyFeedback() throws {
        let request = booking(), now = Date(timeIntervalSince1970: 1_800_000_000)
        func state(_ id: String, stage: String, reason: String, completed: Bool = false, title: String = "Title",
                   running: String? = nil) throws -> HubSnapshot {
            try decode(snapshotJSON(request: request, eventID: "ours", time: now, running: running,
                journey: journeyJSON(id, revision: 2, stage: stage, completed: completed, reason: reason,
                                     title: title, text: "Text")))
        }
        #expect(try state("ours", stage: "BOOKED", reason: "booked").feedback(for: request, eventID: "ours", now: now).result != nil)
        #expect(try state("ours", stage: "BOOKED", reason: "booked", running: "run-1").feedback(for: request, eventID: "ours", now: now) == .planning)
        #expect(try state("someone-else", stage: "BOOKED", reason: "booked").feedback(for: request, eventID: "ours", now: now) == .replaced)
        #expect(try state("ours", stage: "IDLE", reason: "cancelled", title: "Booking cancelled").feedback(for: request, eventID: "ours", now: now) == .cancelled)
        #expect(try state("ours", stage: "IDLE", reason: "expired", title: "Booking expired").feedback(for: request, eventID: "ours", now: now) == .expired)
        // The legacy path expired at 300 s from the booking's observed_at; a completed journey does not.
        let boarded = try state("ours", stage: "ON_BOARD", reason: "boarding_preview", completed: true)
        #expect(boarded.feedback(for: request, eventID: "ours", now: now.addingTimeInterval(900)).result != nil)
    }

    @Test("Venue: a mismatching stroller enters and leaves, then the matching wheelchair enters, leaves and is ON_BOARD")
    @MainActor
    func venueJourney() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let t = Date.now
        let wheelchairBay: [String: Any] = ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"]
        func state(_ journey: [String: Any], navigation: [String: Any]? = nil, triggered: Bool = false,
                   zoneEvent: String? = nil) -> String {
            snapshotJSON(request: request, eventID: event, time: t, triggered: triggered, zoneEvent: zoneEvent,
                         roiID: "stop-a", journey: journey, navigation: navigation)
        }
        let toStop = navigationJSON(phase: "TO_STOP", destination: ["type": "BUS_STOP", "id": "DEMO_STOP"], steps: false)
        let booked = state(journeyJSON(event, revision: 2, stage: "BOOKED", reason: "booked",
                                       title: "Go to the bus stop", text: "Please go to the marked boarding point at the demo bus stop for route 400. Your assistance plan is ready."),
                           navigation: toStop)
        let stroller = state(journeyJSON(event, revision: 3, stage: "AT_STOP", labels: ["STROLLER"], reason: "unmatched",
                                         title: "Please wait at the stop", text: "The detected assistance does not match the booking. Please wait for the safety operator."),
                             navigation: navigationJSON(phase: "WAIT_AT_STOP", destination: ["type": "BUS_STOP", "id": "DEMO_STOP"], steps: false),
                             triggered: true, zoneEvent: "enter")
        let strollerLeft = state(journeyJSON(event, revision: 4, stage: "BOOKED", reason: "unmatched",
                                             title: "Go to the bus stop", text: "Please go to the marked boarding point at the demo bus stop for route 400. Your assistance plan is ready."),
                                 navigation: toStop, zoneEvent: "exit")
        let wheelchair = state(journeyJSON(event, revision: 6, stage: "AT_STOP", matched: true, labels: ["WHEELCHAIR"], reason: "entered",
                                           title: "Bus arriving", text: "We have recognised you at the bus stop. The bus is arriving; please stay behind the marked boarding line.",
                                           animation: ["id": "\(event):legacy:5:arrival", "phase": "arrival", "aid": "wheelchair",
                                                       "started_at": t.timeIntervalSince1970 * 1000, "duration_ms": 10000, "target": wheelchairBay]),
                               triggered: true, zoneEvent: "enter")
        let preparing = state(journeyJSON(event, revision: 6, stage: "AT_STOP", matched: true, labels: ["WHEELCHAIR"], reason: "entered",
                                          title: "Preparing to board", text: "The bus has stopped and is preparing the entrance. Please wait for the safety operator to signal."),
                              triggered: true, zoneEvent: "present")
        let leaving = state(journeyJSON(event, revision: 7, stage: "AT_STOP", matched: true, labels: ["WHEELCHAIR"], pendingExit: true,
                                        reason: "left_stop", title: "Preparing to board",
                                        text: "The bus has stopped and is preparing the entrance. Please wait for the safety operator to signal."),
                            zoneEvent: "exit")
        let onBoard = state(journeyJSON(event, revision: 8, stage: "ON_BOARD", matched: true, labels: ["WHEELCHAIR"], completed: true,
                                        reason: "boarding_preview", title: "Follow the wheelchair-space guidance",
                                        text: "From the entrance, face into the bus. Continue straight for 0.9 metres. Turn right. Arrive at the wheelchair space."),
                            navigation: navigationJSON(phase: "TO_WHEELCHAIR_BAY", destination: wheelchairBay, steps: true))
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, booked),
            .response(200, stroller), .response(200, strollerLeft), .response(200, wheelchair), .response(200, preparing),
            .response(200, leaving), .response(200, onBoard), .response(200, onBoard)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)

        // Round 1: booked, go to the stop.
        #expect(service.journey(for: request)?.journeyStage == .booked)
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Go to the bus stop")
        #expect(service.takeJourneyFeedback(for: request) == nil)

        // The stroller does not match: wait, and never the legacy "bus is here".
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .atStop)
        #expect(service.journey(for: request)?.isMatched == false)
        #expect(service.journey(for: request)?.reason == "unmatched")
        #expect(!service.hasTriggered(for: request))
        #expect(!service.busIsAtStop(for: request))
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Please wait at the stop")

        // It leaves: back to round 1 instead of latching.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .booked)
        #expect(!service.hasExitTriggered(for: request))
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Go to the bus stop")

        // Round 2: the wheelchair matches.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .atStop)
        #expect(service.journey(for: request)?.isMatched == true)
        #expect(service.journey(for: request)?.animation?.phase == "arrival")
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Bus arriving")
        await service.refreshFeedback(for: request)
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Preparing to board") // Same revision, new title.

        // A matching exit before the arrival animation ends is not boarding yet.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .atStop)
        #expect(service.journey(for: request)?.pending_exit == true)
        #expect(service.takeJourneyFeedback(for: request) == nil)

        // Round 3: on board with the assigned place and step-by-step guidance.
        await service.refreshFeedback(for: request)
        let boarded = try #require(service.journey(for: request))
        #expect(boarded.journeyStage == .onBoard)
        #expect(boarded.boarding_target?.title == "Wheelchair bay")
        #expect(service.navigation(for: request)?.visibleSteps.count == 4)
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Follow the wheelchair-space guidance")
        #expect(service.takeJourneyFeedback(for: request) == nil)

        // The hub keeps a completed journey; the App's local five-minute expiry must not override it.
        await service.refreshFeedback(for: request, now: .now.addingTimeInterval(400))
        #expect(service.session(for: request.context)?.hubFeedback?.isTerminal == false)
        #expect(service.journey(for: request)?.journeyStage == .onBoard)
    }

    @Test("An older journey revision delivered late never replaces a newer one; another booking replaces ours")
    @MainActor
    func journeyOrderingAndReplacement() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let atStop = snapshotJSON(request: request, eventID: event, journey: journeyJSON(event, revision: 6, stage: "AT_STOP",
            matched: true, labels: ["WHEELCHAIR"], reason: "entered", title: "Bus arriving", text: "Text"))
        let stale = snapshotJSON(request: request, eventID: event, journey: journeyJSON(event, revision: 2, stage: "BOOKED",
            reason: "booked", title: "Go to the bus stop", text: "Text"))
        let other = snapshotJSON(request: request, eventID: "app-booking-other", journey: journeyJSON("app-booking-other",
            revision: 9, stage: "BOOKED", reason: "booked", title: "Go to the bus stop", text: "Text"))
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, atStop),
            .response(200, stale), .response(200, other)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(service.journey(for: request)?.revision == 6)
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.revision == 6)
        #expect(service.journey(for: request)?.journeyStage == .atStop)
        await service.refreshFeedback(for: request)
        #expect(service.session(for: request.context)?.hubFeedback == .replaced)
        #expect(service.takeJourneyFeedback(for: request) == nil)
    }

    @Test("Cancelling from the App ends the journey screen; the hub's cancelled journey is terminal")
    @MainActor
    func journeyCancellation() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let booked = snapshotJSON(request: request, eventID: event, journey: journeyJSON(event, revision: 2, stage: "BOOKED",
            reason: "booked", title: "Go to the bus stop", text: "Text"))
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, booked),
            .response(200, booked), .response(202, #"{"accepted":true}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(service.journey(for: request)?.journeyStage == .booked)
        await service.cancel(request)
        #expect(service.session(for: request.context)?.phase == .cancelled)
        #expect(service.session(for: request.context)?.hubFeedback == .cancelled)
        #expect(service.takeJourneyFeedback(for: request) == nil)
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        let cancellation = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts.last?.body))
        #expect(!cancellation.payload.active)

        // Hub-side end of this booking (e.g. expiry) uses the hub's wording and stops the journey screen.
        let cancelled = try decode(snapshotJSON(request: request, eventID: event, active: false,
            journey: journeyJSON(event, revision: 3, stage: "IDLE", reason: "cancelled", title: "Booking cancelled",
                                 text: "Your assistance request has been cancelled.", target: nil)))
        #expect(cancelled.feedback(for: request, eventID: event).isTerminal)
        #expect(cancelled.journey?.guidanceText == "Your assistance request has been cancelled.")
    }

    @Test("The passenger twin URL keeps the token in the fragment")
    func passengerTwinURL() throws {
        let receiver = AssistanceReceiverConfiguration(isEnabled: true, scheme: .http, host: " 192.168.1.20 ", port: "8787")
        #expect(try receiver.passengerTwinURL(token: "abc123").absoluteString == "http://192.168.1.20:3000/passenger-twin#token=abc123")
        #expect(try receiver.passengerTwinURL(token: "", dashboardPort: 3105).absoluteString == "http://192.168.1.20:3105/passenger-twin")
        let url = try receiver.passengerTwinURL(token: "a b&c")
        #expect(url.query == nil)
        #expect(url.fragment(percentEncoded: true) == "token=a%20b%26c")
        #expect(throws: AssistanceReceiverConfigurationError.invalidHost) {
            try AssistanceReceiverConfiguration(isEnabled: true, host: "").passengerTwinURL(token: "x")
        }
    }

    // MARK: Waiting list (several phones, one passenger at a time)

    @Test("Three phones: this booking waits at position 2, then 1, then boards, while other bookings come and go")
    @MainActor
    func waitingListFromOnePhone() async throws {
        let request = booking(), ours = "app-booking-\(request.id.uuidString)"
        let a = "app-booking-phone-a", b = "app-booking-phone-b", d = "app-booking-phone-d"
        let bay: [String: Any] = ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"]
        let otherNavigation = navigationJSON(phase: "TO_SEAT", destination: ["type": "SEAT", "id": "S02"], steps: true)
        func state(current: [String: Any], latestBooking: String, _ journeys: [[String: Any]],
                   navigation: [String: Any]? = nil) -> String {
            snapshotJSON(request: request, eventID: latestBooking, journey: current,
                         navigation: navigation ?? otherNavigation, journeys: journeys)
        }
        let aAtStop = entryJSON(a, need: "CANE", stage: "AT_STOP", matched: true, reason: "entered", title: "Bus arriving")
        let aDone = entryJSON(a, need: "CANE", revision: 3, stage: "ON_BOARD", matched: true, completed: true,
                              reason: "boarding_preview", title: "Follow guidance to seat S02", navigation: otherNavigation)
        let bWaiting = entryJSON(b, need: "STROLLER", stage: "BOOKED", queued: true, position: 1, reason: "booked", title: "Booking received")
        let bAtStop = entryJSON(b, need: "STROLLER", revision: 2, stage: "AT_STOP", matched: true, reason: "entered", title: "Bus arriving")
        let bDone = entryJSON(b, need: "STROLLER", revision: 3, stage: "ON_BOARD", matched: true, completed: true,
                              reason: "boarding_preview", title: "Follow guidance to seat S03")
        let dWaiting = entryJSON(d, need: "CANE", stage: "BOOKED", queued: true, position: 2, reason: "booked", title: "Booking received")
        let dCancelled = entryJSON(d, need: "CANE", revision: 2, stage: "IDLE", reason: "cancelled", title: "Booking cancelled")
        let ours2 = entryJSON(ours, revision: 1, stage: "BOOKED", queued: true, position: 2, reason: "booked",
                              title: "Booking received", text: "Two passengers are ahead of you. Please wait near the stop.")
        let ours1 = entryJSON(ours, revision: 2, stage: "BOOKED", queued: true, position: 1, reason: "booked",
                              title: "Booking received", text: "One passenger is ahead of you. Please wait near the stop.")
        let oursTurn = entryJSON(ours, revision: 3, stage: "BOOKED", queued: true, position: 0, reason: "waiting_turn",
                                 title: "Please wait at the stop", text: "Another passenger is boarding. You are next.")
        let oursArrival = entryJSON(ours, revision: 4, stage: "AT_STOP", matched: true, reason: "entered", title: "Bus arriving",
                                    animation: ["id": "\(ours):arrival", "phase": "arrival", "aid": "wheelchair",
                                                "started_at": 1_800_000_000_000.0, "duration_ms": 3000, "target": bay])
        let oursNavigation = navigationJSON(phase: "TO_WHEELCHAIR_BAY", destination: bay, steps: true)
        let oursBoarded = entryJSON(ours, revision: 5, stage: "ON_BOARD", matched: true, completed: true, reason: "boarding_preview",
                                    title: "Follow the wheelchair-space guidance", navigation: oursNavigation)
        HubURLProtocol.fixture.reset([
            .response(202, "{\"accepted\":true,\"journey_id\":\"\(ours)\",\"queued\":true,\"position\":2}"),
            .response(200, state(current: aAtStop, latestBooking: ours, [aAtStop, bWaiting, ours2])),
            .response(200, state(current: bAtStop, latestBooking: d, [aDone, bAtStop, ours1, dWaiting])),
            .response(200, state(current: bAtStop, latestBooking: d, [aDone, bAtStop, ours1, dWaiting])),
            .response(200, state(current: bDone, latestBooking: d, [bDone, oursTurn, dCancelled])),
            .response(200, state(current: oursArrival, latestBooking: d, [bDone, oursArrival])),
            // The top-level navigation is deliberately another phase: the App must use its own entry's.
            .response(200, state(current: oursBoarded, latestBooking: d, [bDone, oursBoarded],
                                 navigation: navigationJSON(phase: "TO_STOP", destination: ["type": "BUS_STOP", "id": "DEMO_STOP"], steps: false))),
            .response(200, state(current: bDone, latestBooking: d, [])),
        ])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(service.session(for: request.context)?.receipt?.queuePosition == 2)

        // Position 2: round 1 with the hub's words; another passenger's plan and navigation are not ours.
        var journey = try #require(service.journey(for: request))
        #expect(journey.journeyStage == .booked && journey.isQueued)
        #expect(journey.queueText == "2 passengers ahead of you")
        #expect(service.navigation(for: request) == nil)
        #expect(service.session(for: request.context)?.hubFeedback == .waiting)
        #expect(service.takeJourneyFeedback(for: request)?.guidanceText == "Two passengers are ahead of you. Please wait near the stop.")

        // Position 1 while A boards and D books after us; the local five-minute timer defers to the hub.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.queueText == "1 passenger ahead of you")
        await service.refreshFeedback(for: request, now: .now.addingTimeInterval(400))
        #expect(service.session(for: request.context)?.hubFeedback == .waiting)
        #expect(service.journey(for: request)?.bookingsAhead == 1)

        // Recognised at the stop while B boards: hold, in the hub's words.
        await service.refreshFeedback(for: request)
        journey = try #require(service.journey(for: request))
        #expect(journey.reason == "waiting_turn" && journey.isHeldAtStop && journey.isQueued)
        #expect(journey.queueText == "You are next.")
        #expect(service.session(for: request.context)?.hubFeedback?.isTerminal == false)
        #expect(service.takeJourneyFeedback(for: request)?.guidanceTitle == "Please wait at the stop")

        // Our turn: the bus is already docked (short arrival); the plan in `result` is now ours.
        await service.refreshFeedback(for: request)
        journey = try #require(service.journey(for: request))
        #expect(journey.journeyStage == .atStop && journey.isMatched && !journey.isQueued)
        #expect(journey.animation?.duration_ms == 3000)
        #expect(service.session(for: request.context)?.hubFeedback?.result?.plan_status == .ready)

        // On board, with this entry's own step-by-step navigation.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .onBoard)
        #expect(service.navigation(for: request)?.phase == "TO_WHEELCHAIR_BAY")
        #expect(service.navigation(for: request)?.visibleSteps.count == 4)

        // About two minutes later the hub forgets the boarded journey: a normal end, not expired or cancelled.
        await service.refreshFeedback(for: request)
        #expect(service.journey(for: request)?.journeyStage == .onBoard)
        #expect(service.session(for: request.context)?.hubFeedback == .finished)
    }

    // MARK: One phone, one passenger after another

    @Test("Finish: resets locally at once, tells the hub once with cancels, and the next booking follows its new id")
    @MainActor
    func finishThenNextPassenger() async throws {
        let first = booking(), firstID = "app-booking-\(first.id.uuidString)"
        let bay: [String: Any] = ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"]
        let boarded = entryJSON(firstID, revision: 5, stage: "ON_BOARD", matched: true, completed: true, reason: "boarding_preview",
                                title: "Follow the wheelchair-space guidance",
                                navigation: navigationJSON(phase: "TO_WHEELCHAIR_BAY", destination: bay, steps: true))
        let onBoard = snapshotJSON(request: first, eventID: firstID, journey: boarded, journeys: [boarded])
        let ended = entryJSON(firstID, revision: 6, stage: "IDLE", completed: true, reason: "completed", title: "Journey finished")
        HubURLProtocol.fixture.reset([.response(202, "{\"accepted\":true,\"journey_id\":\"\(firstID)\",\"queued\":false,\"position\":0}"),
            .response(200, onBoard), .response(200, onBoard), .response(202, #"{"accepted":true}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(first)
        #expect(service.journey(for: first)?.isCompleted == true)

        let notify = service.finish(first)
        #expect(service.session(for: first.context) == nil) // Before the hub has answered.
        #expect(notify != nil)
        await notify?.value
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        let reset = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts.last?.body))
        #expect(!reset.payload.active && reset.payload.cancels == firstID)
        #expect(service.finish(first) == nil) // Nothing left to finish; nothing re-sent.

        // The next passenger books another category at once; the old entry is still listed as completed.
        let next = AssistanceRequest(context: first.context, intent: .boarding, need: .stroller,
                                     preferredInteraction: .visual, assistanceRequested: [.additionalBoardingTime])
        let nextID = "app-booking-\(next.id.uuidString)"
        let waiting = entryJSON(nextID, need: "STROLLER", stage: "BOOKED", reason: "booked", title: "Go to the bus stop", text: "Stroller booking.")
        HubURLProtocol.fixture.reset([.response(202, "{\"accepted\":true,\"journey_id\":\"\(nextID)\",\"queued\":false,\"position\":0}"),
            .response(200, snapshotJSON(request: next, eventID: nextID, journey: waiting, journeys: [ended, waiting]))])
        await service.send(next)
        #expect(service.session(for: next.context)?.phase == .sent)
        #expect(service.journey(for: next)?.journey_id == nextID)
        #expect(service.journey(for: next)?.guidanceText == "Stroller booking.")
        #expect(service.session(for: next.context)?.hubFeedback?.isTerminal == false)
        #expect(service.journey(for: first) == nil)
    }

    @Test("Finish works with the hub unreachable: one attempt, no error state, no retry")
    @MainActor
    func finishWithHubUnreachable() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let boarded = entryJSON(event, revision: 5, stage: "ON_BOARD", matched: true, completed: true, reason: "boarding_preview", title: "On board")
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#),
            .response(200, snapshotJSON(request: request, eventID: event, journey: boarded, journeys: [boarded])),
            .response(503, "{}")])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        await service.finish(request)?.value
        #expect(service.session(for: request.context) == nil)
        #expect(!service.isUpdating)
        #expect(HubURLProtocol.fixture.calls.count == 3) // Booking, state, and the single failed reset attempt.
        try await Task.sleep(for: .milliseconds(50))
        #expect(HubURLProtocol.fixture.calls.count == 3)
    }

    @Test("Hub reason completed is a normal end (Journey finished), and finishing it again stays local")
    @MainActor
    func completedReasonIsFinished() async throws {
        let request = booking(), event = "app-booking-\(request.id.uuidString)"
        let ended = entryJSON(event, revision: 6, stage: "IDLE", completed: true, reason: "completed", title: "Journey finished")
        let state = try decode(snapshotJSON(request: request, eventID: event, journey: ended, journeys: [ended]))
        #expect(state.feedback(for: request, eventID: event) == .finished)
        #expect(HubFeedback.finished.isTerminal && HubFeedback.finished.title == "Journey finished")
        // Single-journey hub: the same reason on `journey`.
        let single = try decode(snapshotJSON(request: request, eventID: event, journey: ended))
        #expect(single.feedback(for: request, eventID: event) == .finished)

        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true}"#), .response(200, snapshotJSON(request: request, eventID: event, journey: ended, journeys: [ended]))])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        #expect(service.session(for: request.context)?.hubFeedback == .finished)
        #expect(service.finish(request) == nil) // Already ended at the hub: local reset only.
        #expect(service.session(for: request.context) == nil)
        #expect(HubURLProtocol.fixture.calls.count == 2)
    }

    @Test("no_place waits in amber; a booking the hub stops listing has ended, but not in its first seconds")
    @MainActor
    func waitingListNoPlaceAndDropped() async throws {
        let request = booking(), ours = "app-booking-\(request.id.uuidString)"
        let other = entryJSON("app-booking-other", need: "CANE", stage: "AT_STOP", matched: true, reason: "entered", title: "Bus arriving")
        let noPlace = entryJSON(ours, revision: 2, stage: "BOOKED", queued: true, position: 0, reason: "no_place",
                                title: "Please wait for the operator", text: "No accessible place is left on this bus. Please wait for the safety operator.")
        let listed = snapshotJSON(request: request, eventID: ours, journey: other, journeys: [other, noPlace])
        let dropped = snapshotJSON(request: request, eventID: ours, journey: other, journeys: [other])
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true,"queued":true,"position":1}"#),
            .response(200, listed), .response(200, dropped)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        let journey = try #require(service.journey(for: request))
        #expect(journey.reason == "no_place" && journey.isHeldAtStop)
        #expect(journey.queueText == nil) // Nobody is ahead; the bus is full. The hub's words say what happens.
        #expect(journey.guidanceText == "No accessible place is left on this bus. Please wait for the safety operator.")
        #expect(service.session(for: request.context)?.hubFeedback == .waiting)
        await service.refreshFeedback(for: request)
        #expect(service.session(for: request.context)?.hubFeedback == .expired)
        #expect(service.takeJourneyFeedback(for: request) == nil)
        #expect(!service.hasTriggered(for: request)) // No fallback to the legacy trigger logic.

        // A snapshot taken just before the hub listed a brand-new booking does not end it at once.
        let fresh = booking(), unlisted = snapshotJSON(request: fresh, eventID: "app-booking-other", journey: other, journeys: [other])
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true,"queued":true,"position":1}"#),
            .response(200, unlisted), .response(200, unlisted)])
        let second = AssistanceRequestService(vehicleCloud: client())
        await second.send(fresh)
        #expect(second.session(for: fresh.context)?.hubFeedback?.isTerminal == false)
        await second.refreshFeedback(for: fresh, now: .now.addingTimeInterval(30))
        #expect(second.session(for: fresh.context)?.hubFeedback == .expired)
    }

    @Test("409 NEED_ALREADY_BOOKED is a clear failure, is not retried, and a later retry is a fresh booking")
    @MainActor
    func needAlreadyBooked() async throws {
        let request = booking(), ours = "app-booking-\(request.id.uuidString)"
        HubURLProtocol.fixture.reset([.response(409,
            #"{"error":"NEED_ALREADY_BOOKED","need":"WHEELCHAIR","existing_journey_id":"app-booking-other"}"#)])
        let service = AssistanceRequestService(vehicleCloud: client())
        await service.send(request)
        let message = "A request for this type of assistance is already active. Please try again after that passenger has boarded."
        let session = try #require(service.session(for: request.context))
        #expect(session.phase == .failed(message))
        #expect(session.receipt == nil && session.journey == nil)
        await service.refreshFeedback(for: request) // No receipt: nothing to poll, nothing re-sent.
        #expect(HubURLProtocol.fixture.calls.count == 1)

        let waiting = entryJSON(ours, stage: "BOOKED", reason: "booked", title: "Go to the bus stop")
        HubURLProtocol.fixture.reset([.response(202, "{\"accepted\":true,\"journey_id\":\"\(ours)\",\"queued\":false,\"position\":0}"),
            .response(200, snapshotJSON(request: request, eventID: ours, journey: waiting, journeys: [waiting]))])
        await service.retry(request)
        #expect(service.session(for: request.context)?.phase == .sent)
        #expect(service.session(for: request.context)?.receipt?.queuePosition == 0)
        #expect(service.journey(for: request)?.isQueued == false)
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        #expect(posts.count == 1)
        #expect(try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts[0].body)).event_id == ours)
    }

    @Test("Cancel names this booking; a waiting-list hub lets it cancel although another booking arrived later")
    func cancelListedBooking() async throws {
        let request = booking(), ours = "app-booking-\(request.id.uuidString)"
        let other = entryJSON("app-booking-later", need: "CANE", stage: "AT_STOP", matched: true, reason: "entered", title: "Bus arriving")
        let waiting = entryJSON(ours, stage: "BOOKED", queued: true, position: 1, reason: "booked", title: "Booking received")
        HubURLProtocol.fixture.reset([.response(202, #"{"accepted":true,"queued":true,"position":1}"#),
            .response(200, snapshotJSON(request: request, eventID: "app-booking-later", journey: other, journeys: [other, waiting])),
            .response(202, #"{"accepted":true}"#)])
        let client = client()
        _ = try await client.submit(request)
        try await client.cancel(request)
        let posts = HubURLProtocol.fixture.calls.filter { $0.body != nil }
        #expect(posts.count == 2)
        #expect(!String(decoding: try #require(posts[0].body), as: UTF8.self).contains("cancels"))
        let cancellation = try JSONDecoder().decode(HubBookingEnvelope.self, from: #require(posts[1].body))
        #expect(!cancellation.payload.active)
        #expect(cancellation.payload.cancels == ours)

        // Not listed (already ended at the hub): this client does not cancel anything.
        let gone = booking()
        HubURLProtocol.fixture.reset([.response(200, snapshotJSON(request: gone, eventID: "app-booking-later", journey: other, journeys: [other]))])
        do { try await client.cancel(gone); Issue.record("Expected ownership rejection") }
        catch HTTPVehicleCloudService.ServiceError.bookingReplaced {} catch { Issue.record("Unexpected error: \(error)") }
    }

    @Test("journeys decode leniently; an older hub without journeys keeps the single-journey rule")
    func journeysDecoding() throws {
        let request = booking()
        let good = entryJSON("ours", stage: "BOOKED", queued: true, position: 3, reason: "booked", title: "Booking received")
        var odd = entryJSON("odd", stage: "BOOKED", reason: "booked", title: "Booking received")
        odd["position"] = "first" // Wrong type: the entry is kept with its id and stage.
        let json = snapshotJSON(request: request, eventID: "ours", journey: good, journeys: [good, odd, ["no": "id"]])
        var payload = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        payload["journeys"] = (payload["journeys"] as! [Any]) + [NSNull()]
        let state = try JSONDecoder().decode(HubSnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
        #expect(state.journeys?.map(\.journey.journey_id) == ["ours", "odd"])
        #expect(state.ownJourney(eventID: "ours")?.bookingsAhead == 3)
        #expect(state.ownJourney(eventID: "odd")?.journeyStage == .booked)
        #expect(state.feedback(for: request, eventID: "missing") == .expired)

        let single = try decode(snapshotJSON(request: request, eventID: "ours",
            journey: journeyJSON("someone-else", revision: 2, stage: "BOOKED", reason: "booked", title: "T", text: "T")))
        #expect(single.journeys == nil && !single.listsJourneys)
        #expect(single.feedback(for: request, eventID: "ours") == .replaced)
    }

    /// A `journeys[]` entry: the journey shape plus `queued`, `position`, `plan_status` and its own `navigation`.
    private func entryJSON(_ id: String, need: String = "WHEELCHAIR", revision: Int = 1, stage: String,
                           queued: Bool = false, position: Int = 0, matched: Bool = false, completed: Bool = false,
                           reason: String, title: String, text: String = "Text", animation: [String: Any]? = nil,
                           navigation: [String: Any]? = nil) -> [String: Any] {
        var value = journeyJSON(id, revision: revision, stage: stage, matched: matched, completed: completed,
                                reason: reason, title: title, text: text, animation: animation, need: need)
        value["queued"] = queued
        value["position"] = position
        value["plan_status"] = "READY"
        value["navigation"] = navigation ?? NSNull()
        return value
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
                              zoneEvent: String? = nil, roiID: String? = nil,
                              journey: [String: Any]? = nil, navigation: [String: Any]? = nil,
                              journeys: [[String: Any]]? = nil) -> String {
        var zone: [String: Any] = ["triggered": triggered]
        zone["event"] = zoneEvent
        zone["roi_id"] = roiID
        var payload: [String: Any] = [
            "source": source, "channels": ["booking": ["event_id": eventID, "observed_at": time.timeIntervalSince1970 * 1000], "perception": ["event_id": "sense-1", "observed_at": time.timeIntervalSince1970 * 1000]],
            "context": ["request": ["active": active, "route_id": request.busService, "stop_id": request.context.stopCode], "perception": ["zone": zone]],
            "running": running as Any? ?? NSNull(),
            "result": ["request_id": "run-1", "plan_status": status, "simulated": true, "execution_authorized": false,
                       "passenger_communication": ["channel": "BOTH", "language": "en-SG", "display_text": "Wait for guidance.", "audio_text": "Wait for guidance."]]
        ]
        // v0.5 hubs always send both keys; the legacy tests above model an older hub without them.
        if let journey { payload["journey"] = journey; payload["navigation"] = navigation ?? NSNull() }
        // Waiting-list hubs add `journeys`; single-journey hubs never send the key.
        if let journeys { payload["journeys"] = journeys }
        return String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    }

    /// Shaped like dashboard/backend/journey.mjs output (see app/docs/hub-v05-gap.md section 5).
    private func journeyJSON(_ id: String, revision: Int, stage: String, matched: Bool = false, labels: [String] = [],
                             pendingExit: Bool = false, completed: Bool = false, reason: String,
                             title: String, text: String, animation: [String: Any]? = nil,
                             target: [String: Any]? = ["type": "WHEELCHAIR_BAY", "id": "WHEELCHAIR_BAY"],
                             need: String = "WHEELCHAIR") -> [String: Any] {
        [
            "journey_id": id, "revision": revision, "stage": stage, "need": need, "labels": labels,
            "matched": matched, "pending_exit": pendingExit, "completed": completed, "reason": reason,
            "seat": (target?["id"] as Any?) ?? NSNull(), "boarding_target": (target as Any?) ?? NSNull(),
            "animation": (animation as Any?) ?? NSNull(), "visit_id": NSNull(), "roi_id": "stop-a", "updated_at": 1_800_000_000_000.0,
            "guidance": ["title": title, "display_text": text, "audio_text": text]
        ]
    }

    private func navigationJSON(phase: String, destination: [String: Any], steps: Bool) -> [String: Any] {
        let route: [[String: Any]] = [
            ["step": 1, "maneuver": "START", "distance_m": NSNull(), "text": "From the entrance, face into the bus."],
            ["step": 2, "maneuver": "STRAIGHT", "distance_m": 0.9, "text": "Continue straight for 0.9 metres."],
            ["step": 3, "maneuver": "TURN_RIGHT", "distance_m": NSNull(), "text": "Turn right."],
            ["step": 4, "maneuver": "ARRIVE", "distance_m": NSNull(), "text": "Arrive at the wheelchair space."]
        ]
        return ["id": "journey", "revision": 1, "phase": phase, "destination": destination, "instruction": "Text",
                "simulated": true, "steps": steps ? route : [], "cabin_route": ["steps": route, "simulated": true]]
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
