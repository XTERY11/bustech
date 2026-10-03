import CoreLocation
import Foundation
import Testing
import UIKit
@testable import BusPulse_SG

@Suite("Transit typography")
struct TransitTypographyTests {
    @Test("The supplied LTA Identity resource registers under its expected PostScript name")
    func bundledFontRegisters() {
        #expect(TransitTypography.registerBundledFont())
        #expect(TransitTypography.isLTAIdentityAvailable)
        #expect(UIFont(name: TransitTypography.postScriptName, size: 17)?.fontName == "LTAIdentity")
    }

    @Test("Every compact arrival status uses an available native symbol")
    func statusSymbolsExist() {
        #expect(UIImage(systemName: "bus.fill") != nil)
        #expect(UIImage(systemName: "bus.doubledecker.fill") != nil)
        #expect(UIImage(systemName: "figure.roll") != nil)
        #expect(UIImage(systemName: "nosign") != nil)
        #expect(UIImage(systemName: "dot.radiowaves.left.and.right") != nil)
        #expect(UIImage(systemName: "calendar") != nil)
    }
}

@Suite("LTA decoding")
struct LTADecodingTests {
    @Test("Missing and blank optional bus fields decode without inventing values")
    func missingFieldsDecode() throws {
        let json = #"""
        {
          "BusStopCode": "01012",
          "Services": [
            {
              "ServiceNo": "7",
              "Operator": "SBST",
              "NextBus": {
                "EstimatedArrival": "2026-07-21T16:00:00+08:00",
                "Monitored": 1,
                "Latitude": 1.298,
                "Longitude": "103.854",
                "Load": "SEA"
              },
              "NextBus2": {
                "EstimatedArrival": "",
                "Monitored": 0
              }
            }
          ]
        }
        """#.data(using: .utf8)!

        let response = try JSONDecoder().decode(LTAArrivalResponse.self, from: json)

        #expect(response.busStopCode == "01012")
        #expect(response.services.count == 1)
        #expect(response.services[0].buses.count == 2)
        #expect(response.services[0].buses[0].originCode.isEmpty)
        #expect(response.services[0].buses[0].latitude == "1.298")
        #expect(response.services[0].buses[0].feature.isEmpty)
        #expect(response.services[0].buses[1].estimatedArrival.isEmpty)
    }

    @Test("A response with no Services field decodes as an honest empty board")
    func absentServicesDecodeAsEmpty() throws {
        let json = #"{"BusStopCode":"01012"}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(LTAArrivalResponse.self, from: json)
        #expect(response.services.isEmpty)
    }
}

@Suite("Arrival countdown")
struct ArrivalCountdownTests {
    @Test("LTA countdowns floor seconds to whole minutes")
    func countdownFloorsSeconds() {
        let now = Date(timeIntervalSince1970: 1_000)
        #expect(ArrivalFormatting.countdown(to: now.addingTimeInterval(229), now: now) == "3 min")
        #expect(ArrivalFormatting.countdown(to: now.addingTimeInterval(127), now: now) == "2 min")
        #expect(ArrivalFormatting.countdown(to: now.addingTimeInterval(119), now: now) == "1 min")
        #expect(ArrivalFormatting.compactCountdown(to: now.addingTimeInterval(229), now: now) == "3m")
        #expect(ArrivalFormatting.mapMarkerCountdown(to: now.addingTimeInterval(229), now: now) == "3'")
        #expect(ArrivalFormatting.mapMarkerCountdown(to: now.addingTimeInterval(779), now: now) == "12'")
    }

    @Test("Less than one minute is arriving and missing remains unknown")
    func arrivingAndMissing() {
        let now = Date(timeIntervalSince1970: 1_000)
        #expect(ArrivalFormatting.countdown(to: now.addingTimeInterval(59), now: now) == "Arr")
        #expect(ArrivalFormatting.countdown(to: now.addingTimeInterval(-5), now: now) == "Arr")
        #expect(ArrivalFormatting.countdown(to: nil, now: now) == "—")
        #expect(ArrivalFormatting.mapMarkerCountdown(to: now.addingTimeInterval(59), now: now) == "Now")
        #expect(ArrivalFormatting.mapMarkerCountdown(to: nil, now: now) == "—")
    }
}

@Suite("Operating hours")
struct OperatingHoursTests {
    @Test("A missing live row reports the next scheduled start")
    func nextScheduledStart() throws {
        let calendar = singaporeCalendar()
        let beforeService = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 24,
            hour: 2
        )))
        let route = route(first: "0530", last: "2355")

        #expect(!OperatingHoursEvaluator.isAnyServiceOperating(
            routes: [route],
            at: beforeService,
            calendar: calendar
        ))
        #expect(OperatingHoursEvaluator.resumeDescription(
            routes: [route],
            after: beforeService,
            calendar: calendar
        ) == "Resumes 5:30 AM")
    }

    @Test("An overnight service remains active after midnight")
    func overnightService() throws {
        let calendar = singaporeCalendar()
        let afterMidnight = try #require(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 24,
            hour: 0,
            minute: 30
        )))
        #expect(OperatingHoursEvaluator.isAnyServiceOperating(
            routes: [route(first: "2300", last: "0130")],
            at: afterMidnight,
            calendar: calendar
        ))
    }

    private func singaporeCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Singapore")!
        return calendar
    }

    private func route(first: String, last: String) -> BusRoute {
        BusRoute(
            serviceNo: "190",
            operatorCode: "SMRT",
            direction: 1,
            stopSequence: 1,
            busStopCode: "01012",
            distance: 0,
            weekdayFirstBus: first,
            weekdayLastBus: last,
            saturdayFirstBus: first,
            saturdayLastBus: last,
            sundayFirstBus: first,
            sundayLastBus: last
        )
    }
}

@Suite("Versioned cache")
struct TransitCacheTests {
    @Test("A current snapshot round-trips through the atomic cache")
    func currentVersionRoundTrip() async throws {
        let fileURL = temporaryCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let cache = TransitCache(fileURL: fileURL)
        let snapshot = MockTransitProvider.makeSnapshot()

        try await cache.save(snapshot)
        let loaded = await cache.load()

        #expect(loaded == snapshot)
    }

    @Test("An incompatible cache schema is ignored safely")
    func incompatibleVersionIsIgnored() async throws {
        let fileURL = temporaryCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let envelope = TransitCacheEnvelope(
            schemaVersion: TransitCache.currentSchemaVersion + 1,
            snapshot: MockTransitProvider.makeSnapshot()
        )
        try JSONEncoder().encode(envelope).write(to: fileURL, options: .atomic)

        let loaded = await TransitCache(fileURL: fileURL).load()
        #expect(loaded == nil)
    }

    private func temporaryCacheURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("cache.json")
    }
}

@Suite("Route geometry cache")
struct RouteGeometryCacheTests {
    @Test("Road segments persist and a fresh cache prevents duplicate directions requests")
    func freshSegmentsAreReusedFromDisk() async throws {
        let fileURL = temporaryRouteCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let stops = Array(MockTransitProvider.makeSnapshot().stops.prefix(2))
        let cache = RouteGeometryCache(fileURL: fileURL)
        let firstProvider = RecordingRouteSegmentProvider()
        let firstStore = RouteGeometryStore(provider: firstProvider, cache: cache)
        let now = Date()

        let first = await firstStore.geometry(for: stops, now: now)
        #expect(first.isFullyRoadAligned)
        #expect(await firstProvider.requestCount == 1)

        let secondProvider = RecordingRouteSegmentProvider()
        let reopenedStore = RouteGeometryStore(provider: secondProvider, cache: cache)
        let cached = await reopenedStore.cachedGeometry(for: stops, now: now.addingTimeInterval(60))
        let second = await reopenedStore.geometry(for: stops, now: now.addingTimeInterval(60))

        #expect(cached.isFullyRoadAligned)
        #expect(!cached.needsRefresh)
        #expect(second.isFullyRoadAligned)
        #expect(await secondProvider.requestCount == 0)
    }

    @Test("Monthly expiry and manual refresh request new road geometry safely")
    func staleAndForcedSegmentsRefresh() async throws {
        let fileURL = temporaryRouteCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let stops = Array(MockTransitProvider.makeSnapshot().stops.prefix(2))
        let provider = RecordingRouteSegmentProvider()
        let store = RouteGeometryStore(
            provider: provider,
            cache: RouteGeometryCache(fileURL: fileURL)
        )
        let now = Date()

        _ = await store.geometry(for: stops, now: now)
        _ = await store.geometry(
            for: stops,
            now: now.addingTimeInterval(RouteGeometryStore.freshnessInterval + 1)
        )
        _ = await store.geometry(for: stops, forceRefresh: true, now: now)

        #expect(await provider.requestCount == 3)
        #expect(DirectionsRequestGate.maximumRequestsPerWindow < 50)
        #expect(DirectionsRequestGate.windowDuration == 60)
    }

    @Test("An incompatible route cache schema is ignored")
    func incompatibleRouteCacheIsIgnored() async throws {
        let fileURL = temporaryRouteCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let envelope = RouteGeometryCacheEnvelope(
            schemaVersion: RouteGeometryCache.currentSchemaVersion + 1,
            segments: []
        )
        try JSONEncoder().encode(envelope).write(to: fileURL, options: .atomic)

        #expect(await RouteGeometryCache(fileURL: fileURL).load().segments.isEmpty)
    }

    @Test("Failed road legs use a persistent retry cooldown instead of recalculating on every open")
    func failedSegmentsAreDeferredUntilManualRefresh() async throws {
        let fileURL = temporaryRouteCacheURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let stops = Array(MockTransitProvider.makeSnapshot().stops.prefix(2))
        let cache = RouteGeometryCache(fileURL: fileURL)
        let firstProvider = FailingRouteSegmentProvider()
        let firstStore = RouteGeometryStore(provider: firstProvider, cache: cache)
        let now = Date()

        let first = await firstStore.geometry(for: stops, now: now)
        #expect(first.deferredSegmentCount == 1)
        #expect(!first.needsRefresh)
        #expect(await firstProvider.requestCount == 1)

        let reopenedProvider = FailingRouteSegmentProvider()
        let reopenedStore = RouteGeometryStore(provider: reopenedProvider, cache: cache)
        let automatic = await reopenedStore.geometry(for: stops, now: now.addingTimeInterval(60))
        #expect(automatic.deferredSegmentCount == 1)
        #expect(await reopenedProvider.requestCount == 0)

        _ = await reopenedStore.geometry(
            for: stops,
            forceRefresh: true,
            now: now.addingTimeInterval(61)
        )
        #expect(await reopenedProvider.requestCount == 1)
    }

    private func temporaryRouteCacheURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("route-geometry.json")
    }
}

private actor RecordingRouteSegmentProvider: RouteSegmentProviding {
    private(set) var requestCount = 0

    func roadSegment(from start: BusStop, to end: BusStop) async throws -> [RouteMapCoordinate] {
        requestCount += 1
        let midpoint = CLLocationCoordinate2D(
            latitude: (start.latitude + end.latitude) / 2 + 0.000_1,
            longitude: (start.longitude + end.longitude) / 2
        )
        return [
            RouteMapCoordinate(start.coordinate),
            RouteMapCoordinate(midpoint),
            RouteMapCoordinate(end.coordinate)
        ]
    }
}

private actor FailingRouteSegmentProvider: RouteSegmentProviding {
    enum Failure: Error { case unavailable }
    private(set) var requestCount = 0

    func roadSegment(from start: BusStop, to end: BusStop) async throws -> [RouteMapCoordinate] {
        _ = (start, end)
        requestCount += 1
        throw Failure.unavailable
    }
}

@Suite("Stop search")
struct StopSearchTests {
    @Test("Search ranks exact code and matches name and road")
    func searchFields() async {
        let index = StopSearchIndex()
        let stops = MockTransitProvider.makeSnapshot().stops
        await index.rebuild(with: stops)

        let byCode = await index.search("01012")
        let byName = await index.search("grand pacific")
        let byRoad = await index.search("bras basah")

        #expect(byCode.first?.code == "01012")
        #expect(byName.first?.code == "01012")
        #expect(byRoad.contains { $0.code == "02049" })
    }

    @Test("Blank search does not return every stop")
    func blankSearchIsEmpty() async {
        let index = StopSearchIndex()
        await index.rebuild(with: MockTransitProvider.makeSnapshot().stops)
        #expect(await index.search("   ").isEmpty)
    }
}

@Suite("Local preferences", .serialized)
struct PreferencesStoreTests {
    @Test("Names, recent stops and pinned-service order persist locally")
    @MainActor
    func customisationAndPersistence() async throws {
        let store = PreferencesStore(resetBeforeLoading: true)
        await store.bootstrap()
        #expect(store.useLTAIdentityTypography)

        store.toggleFavourite(stopCode: "01012")
        store.rename(stopCode: "01012", to: "  Home  ")
        store.recordRecent(stopCode: "01012")
        store.recordRecent(stopCode: "02049")
        store.recordRecent(stopCode: "01012")
        store.togglePinned(serviceNo: "7", at: "01012")
        store.togglePinned(serviceNo: "14", at: "01012")
        store.movePinned(serviceNo: "14", at: "01012", offset: -1)
        store.useLTAIdentityTypography = false
        store.defaultLaunchTab = .favourites
        store.assistanceReceiver = AssistanceReceiverConfiguration(
            isEnabled: true,
            scheme: .http,
            host: "192.168.1.20",
            port: "8080"
        )

        #expect(store.favourite(for: "01012")?.customName == "Home")
        #expect(store.favourite(for: "01012")?.pinnedServices == ["14", "7"])
        #expect(store.recentStopCodes == ["01012", "02049"])

        await store.flushPendingWrites()

        let reloaded = PreferencesStore()
        await reloaded.bootstrap()
        #expect(reloaded.favourite(for: "01012")?.customName == "Home")
        #expect(reloaded.favourite(for: "01012")?.pinnedServices == ["14", "7"])
        #expect(reloaded.recentStopCodes == ["01012", "02049"])
        #expect(!reloaded.useLTAIdentityTypography)
        #expect(reloaded.defaultLaunchTab == .favourites)
        #expect(reloaded.assistanceReceiver.host == "192.168.1.20")
        #expect(try reloaded.assistanceReceiverEndpoint()?.absoluteString ==
            "http://192.168.1.20:8080/api/booking")

        reloaded.toggleFavourite(stopCode: "01012")
        #expect(!reloaded.isFavourite("01012"))
        await reloaded.flushPendingWrites()
    }
}

@Suite("Bus stop classification")
struct BusStopClassificationTests {
    @Test("Only explicit interchange and terminal suffixes are promoted")
    func conservativeInterchangeClassification() {
        #expect(BusStopKind(description: "Bedok Int") == .interchange)
        #expect(BusStopKind(description: "Punggol Bus Interchange") == .interchange)
        #expect(BusStopKind(description: "Changi Village Ter") == .interchange)
        #expect(BusStopKind(description: "Shenton Way Terminal") == .interchange)
        #expect(BusStopKind(description: "Aft Bedok Int") == .regular)
        #expect(BusStopKind(description: "Opp Tampines Interchange") == .regular)
        #expect(BusStopKind(description: "Opp Interchange Bldg") == .regular)
        #expect(BusStopKind(description: "City Hall Stn Exit B") == .regular)
        #expect(BusStopKind(description: "International Plaza") == .regular)
    }
}

@Suite("Stop marker presentation")
struct StopMarkerPresentationTests {
    @Test("Main and route maps share stable zoom thresholds")
    func latitudeDeltaThresholds() {
        #expect(StopMarkerPresentation(latitudeDelta: 0.005) == .sign)
        #expect(StopMarkerPresentation(latitudeDelta: 0.006) == .sign)
        #expect(StopMarkerPresentation(latitudeDelta: 0.006_001) == .dot)
        #expect(StopMarkerPresentation(latitudeDelta: 0.032) == .dot)
        #expect(StopMarkerPresentation(latitudeDelta: 0.032_001) == .overview)
    }
}

@Suite("Static update safety")
struct StaticUpdateSafetyTests {
    @Test("A route query preserves LTA stop sequence for one direction")
    @MainActor
    func routeQueryPreservesSequence() async {
        let store = TransitDataStore(provider: MockTransitProvider())
        await store.bootstrap()

        let route = store.route(serviceNo: "7", direction: 1)

        #expect(route.map(\.code) == ["01012", "01013", "02049", "04167"])
    }

    @Test("A failed refresh preserves the last complete snapshot")
    @MainActor
    func failedRefreshPreservesSnapshot() async {
        let provider = FailsAfterFirstSnapshotProvider()
        let store = TransitDataStore(provider: provider)

        await store.bootstrap()
        let installed = store.snapshot
        await store.refreshStatic()

        #expect(installed != nil)
        #expect(store.snapshot == installed)
        #expect(store.errorMessage != nil)
    }
}

@Suite("Arrival lifecycle")
struct ArrivalLifecycleTests {
    @Test("Concurrent requests for one stop are deduplicated")
    func requestsAreDeduplicated() async throws {
        let coordinator = ArrivalRequestCoordinator()
        let probe = ArrivalProbe()

        async let first = coordinator.value(for: "01012") {
            try await probe.board()
        }
        async let second = coordinator.value(for: "01012") {
            try await probe.board()
        }
        let (firstBoard, secondBoard) = try await (first, second)

        #expect(firstBoard.stopCode == "01012")
        #expect(secondBoard.stopCode == "01012")
        #expect(await probe.requestCount() == 1)
    }

    @Test("Cancelling the visible consumer cancels its in-flight request")
    func requestCancellationPropagates() async throws {
        let coordinator = ArrivalRequestCoordinator()
        let probe = CancellationProbe()
        let request = Task {
            try await coordinator.value(for: "01012") {
                try await probe.board()
            }
        }

        try await Task.sleep(for: .milliseconds(50))
        request.cancel()
        do {
            _ = try await request.value
            Issue.record("Expected the request to be cancelled")
        } catch is CancellationError {
            // Expected.
        } catch {
            Issue.record("Unexpected cancellation error: \(error)")
        }

        #expect(await probe.wasCancelled())
    }

    @Test("Refreshes keep stable row identities")
    func refreshedRowsKeepIdentity() async throws {
        let provider = MockTransitProvider()
        let first = try await provider.fetchArrivals(stopCode: "01012")
        let second = try await provider.fetchArrivals(stopCode: "01012")
        let firstIDs = first.services.flatMap { $0.estimates.map(\.id) }
        let secondIDs = second.services.flatMap { $0.estimates.map(\.id) }

        #expect(firstIDs == secondIDs)
        #expect(second.fetchedAt >= first.fetchedAt)
    }
}

@Suite("Pre-arrival assistance")
struct PreArrivalAssistanceTests {
    @Test("Receiver configuration builds a validated endpoint")
    func receiverConfigurationBuildsURL() throws {
        let configuration = AssistanceReceiverConfiguration(
            isEnabled: true,
            scheme: .https,
            host: "10.0.0.42",
            port: "8443"
        )

        #expect(try configuration.endpointURL().absoluteString ==
            "https://10.0.0.42:8443/api/booking")
        #expect(throws: AssistanceReceiverConfigurationError.invalidPort) {
            try AssistanceReceiverConfiguration(
                isEnabled: true,
                host: "10.0.0.42",
                port: "70000"
            ).endpointURL()
        }
    }

    @Test("Booking JSON uses the frozen BusTech contract")
    func vehiclePayloadUsesStableContract() throws {
        let request = makeVisualRequest()
        let data = try JSONEncoder().encode(HubBookingEnvelope(request: request))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(json.keys) == ["event_id", "observed_at", "payload"])
        let payload = try #require(json["payload"] as? [String: Any])
        #expect(payload["route_id"] as? String == "191")
        #expect(payload["stop_id"] as? String == "01012")
        #expect(payload["accessibility_need"] as? String == "VISUAL_ASSISTANCE")
        #expect(payload["ramp_preference"] as? String == "UNSPECIFIED")
        #expect(payload["preferred_interaction"] as? String == "AUDIO")
        #expect(payload["assistance_requested"] as? [String] == [
            "CONFIRM_BUS_IDENTITY", "AUDIO_BOARDING_GUIDANCE", "ADDITIONAL_BOARDING_TIME"
        ])
    }

    @Test("Manual and voice paths produce the same validated request model")
    @MainActor
    func manualAndVoiceShareOneModel() async throws {
        let context = makeContext()
        let manual = try AssistanceRequest(
            context: context,
            intent: .boarding,
            need: .visualAccessibility,
            preferredInteraction: .audio,
            assistanceRequested: [
                .confirmBusArrivalIdentity,
                .audioBoardingInstruction,
                .additionalBoardingTime
            ]
        ).validated()
        let assistant = LocalAccessibilityAssistantService(usesDeterministicUITestResponse: true)
        let voice = try await assistant.interpret(
            transcript: "Please identify the bus, guide me to the entrance, and allow more time.",
            context: context
        ).request

        #expect(voice.context == manual.context)
        #expect(voice.intent == manual.intent)
        #expect(voice.need == manual.need)
        #expect(voice.preferredInteraction == manual.preferredInteraction)
        #expect(voice.assistanceRequested == manual.assistanceRequested)
    }

    @Test("Global voice resolves a spoken stop and service before creating the shared request")
    @MainActor
    func globalVoiceResolvesJourneyContext() async throws {
        let dataStore = TransitDataStore(provider: MockTransitProvider())
        await dataStore.bootstrap()
        let resolver = AssistanceJourneyResolver(dataStore: dataStore)
        let nearbyStops = await resolver.nearbyCandidates(
            to: LocationService.singaporeCentre
        )
        let assistant = LocalAccessibilityAssistantService(
            usesDeterministicUITestResponse: true
        )
        let draft = try await assistant.interpretJourney(
            transcript: "I'm at stop 01012 waiting for Bus 191 and need audio boarding guidance.",
            nearbyStops: nearbyStops,
            currentLocationIsAvailable: false
        )
        let result = try await resolver.resolve(draft, coordinate: nil)

        #expect(result.request.context.stopCode == "01012")
        #expect(result.request.busService == "191")
        #expect(result.request.need == .visualAccessibility)
        #expect(result.request.assistanceRequested == [
            .confirmBusArrivalIdentity,
            .audioBoardingInstruction,
            .additionalBoardingTime
        ])
        #expect(result.passengerResponse.contains("Hotel Grand Pacific"))
        #expect(!result.passengerResponse.localizedCaseInsensitiveContains("received"))
    }

    @Test("Global voice follow-ups retain earlier journey details without duplicating speech")
    func globalVoiceConversationAccumulatesFollowUps() {
        var conversation = JourneyConversation()

        #expect(conversation.append("I need audio guidance and more time to board.") ==
            "I need audio guidance and more time to board.")
        #expect(conversation.append("Bus 191 from stop 01012.") ==
            "I need audio guidance and more time to board.\nPassenger added: Bus 191 from stop 01012.")
        #expect(conversation.append("Bus 191 from stop 01012.") ==
            "I need audio guidance and more time to board.\nPassenger added: Bus 191 from stop 01012.")
    }

    @Test("Vision support preserves mixed help choices and automatically uses spoken updates")
    func visualModelMismatchIsRepaired() {
        let actions = AssistanceModelNormalization.actions(
            [.visualBoardingConfirmation],
            for: .visualAccessibility
        )
        let interaction = AssistanceModelNormalization.interaction(
            .visual,
            for: .visualAccessibility
        )

        #expect(actions == [.visualBoardingConfirmation])
        #expect(interaction == .audio)
    }

    @Test("Vehicle receipt never becomes received before an acknowledgement")
    @MainActor
    func acknowledgementOwnsReceivedState() async throws {
        let vehicle = ControlledVehicleCloudService()
        let service = AssistanceRequestService(vehicleCloud: vehicle)
        let request = makeVisualRequest()
        try service.prepare(request)

        let sendTask = Task { @MainActor in
            await service.send(request)
        }
        await vehicle.waitUntilAcknowledgementRequested()

        #expect(service.session(for: request.context)?.phase == .sent)
        #expect(service.session(for: request.context)?.acknowledgement == nil)

        await vehicle.releaseAcknowledgement()
        await sendTask.value

        #expect(service.session(for: request.context)?.phase == .received)
        #expect(service.session(for: request.context)?.acknowledgement?.busService == "191")
    }

    @Test("Mixed assistance needs remain available")
    func mixedAssistanceNeedsAreAllowed() throws {
        let request = AssistanceRequest(
            context: makeContext(),
            intent: .boarding,
            need: .visualAccessibility,
            preferredInteraction: .audio,
            assistanceRequested: [.deployWheelchairRamp]
        )

        #expect(try request.validated().assistanceRequested == [.deployWheelchairRamp])
    }

    @Test("Passenger-facing model text cannot claim a premature ACK")
    @MainActor
    func acknowledgementClaimsAreBlocked() {
        #expect(LocalAccessibilityAssistantService.isPreAcknowledgementSafe(
            "I've prepared a request for you to review."
        ))
        #expect(!LocalAccessibilityAssistantService.isPreAcknowledgementSafe(
            "The bus has received your request."
        ))
        #expect(!LocalAccessibilityAssistantService.isPreAcknowledgementSafe(
            "I've prepared it, and the driver knows what you need."
        ))
    }

    @Test("Acknowledgement failure stays failed and carries no ACK")
    @MainActor
    func acknowledgementFailureIsRecoverable() async throws {
        let vehicle = MockVehicleCloudService(configuration: .init(
            submissionDelay: .zero,
            acknowledgementDelay: .zero,
            failureStage: .acknowledgement
        ))
        let service = AssistanceRequestService(vehicleCloud: vehicle)
        let request = makeVisualRequest()
        try service.prepare(request)
        await service.send(request)

        guard let session = service.session(for: request.context) else {
            Issue.record("Expected a request session")
            return
        }
        if case .failed = session.phase {
            #expect(session.acknowledgement == nil)
        } else {
            Issue.record("Expected a failed request, got \(session.phase)")
        }
    }

    @Test("The deterministic mock includes the Bus 191 demo arrival")
    func bus191DemoArrivalExists() async throws {
        let board = try await MockTransitProvider().fetchArrivals(stopCode: "01012")
        let service = try #require(board.services.first(where: { $0.serviceNo == "191" }))
        let estimate = try #require(service.estimates.first)

        #expect(estimate.slot == 0)
        #expect(estimate.estimatedArrival != nil)
        #expect(ArrivalFormatting.countdown(to: estimate.estimatedArrival).hasSuffix("min"))
    }

    private func makeContext() -> AssistanceContext {
        AssistanceContext(
            stopCode: "01012",
            stopName: "Hotel Grand Pacific",
            roadName: "Victoria St",
            busService: "191",
            estimatedArrival: .now.addingTimeInterval(240)
        )
    }

    private func makeVisualRequest() -> AssistanceRequest {
        AssistanceRequest(
            context: makeContext(),
            intent: .boarding,
            need: .visualAccessibility,
            preferredInteraction: .audio,
            assistanceRequested: [
                .confirmBusArrivalIdentity,
                .audioBoardingInstruction,
                .additionalBoardingTime
            ]
        )
    }
}

private actor ControlledVehicleCloudService: VehicleCloudServing {
    private var acknowledgementContinuation: CheckedContinuation<VehicleAcknowledgement, Error>?
    private var pendingReceipt: VehicleSubmissionReceipt?
    private var pendingRequest: AssistanceRequest?

    func submit(_ request: AssistanceRequest) async throws -> VehicleSubmissionReceipt {
        VehicleSubmissionReceipt(
            requestID: request.id,
            providerReference: "CONTROLLED-ACK",
            submittedAt: .now
        )
    }

    func acknowledgement(
        for receipt: VehicleSubmissionReceipt,
        request: AssistanceRequest
    ) async throws -> VehicleAcknowledgement {
        pendingReceipt = receipt
        pendingRequest = request
        return try await withCheckedThrowingContinuation { continuation in
            acknowledgementContinuation = continuation
        }
    }

    func cancel(_ request: AssistanceRequest) async throws {
        _ = request
    }

    func waitUntilAcknowledgementRequested() async {
        while acknowledgementContinuation == nil {
            await Task.yield()
        }
    }

    func releaseAcknowledgement() {
        guard let receipt = pendingReceipt,
              let request = pendingRequest,
              let continuation = acknowledgementContinuation else { return }
        acknowledgementContinuation = nil
        continuation.resume(returning: VehicleAcknowledgement(
            requestID: receipt.requestID,
            providerReference: receipt.providerReference,
            busService: request.busService,
            receivedAt: .now
        ))
    }
}

private actor FailsAfterFirstSnapshotProvider: TransitDataProviding {
    nonisolated let mode: DataMode = .mock
    private var requestCount = 0

    func fetchStaticSnapshot() async throws -> TransitSnapshot {
        requestCount += 1
        guard requestCount == 1 else { throw TestUpdateError.expectedFailure }
        return MockTransitProvider.makeSnapshot()
    }

    func fetchArrivals(stopCode: String) async throws -> ArrivalBoard {
        ArrivalBoard(stopCode: stopCode, services: [], fetchedAt: .now, mode: .mock)
    }
}

private actor ArrivalProbe {
    private var count = 0

    func board() async throws -> ArrivalBoard {
        count += 1
        try await Task.sleep(for: .milliseconds(120))
        return ArrivalBoard(stopCode: "01012", services: [], fetchedAt: .now, mode: .mock)
    }

    func requestCount() -> Int { count }
}

private actor CancellationProbe {
    private var cancelled = false

    func board() async throws -> ArrivalBoard {
        do {
            try await Task.sleep(for: .seconds(5))
        } catch is CancellationError {
            cancelled = true
            throw CancellationError()
        }
        return ArrivalBoard(stopCode: "01012", services: [], fetchedAt: .now, mode: .mock)
    }

    func wasCancelled() -> Bool { cancelled }
}

private enum TestUpdateError: Error {
    case expectedFailure
}
