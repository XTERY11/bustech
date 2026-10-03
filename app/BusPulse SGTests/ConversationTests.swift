import Foundation
import Testing
@testable import BusPulse_SG

@Suite("Conversational assistant")
struct ConversationTests {
    @Test("Missing preferences keep the original experience") @MainActor
    func defaultOff() {
        let preferences = PreferencesStore()
        #expect(!preferences.conversationalAssistantEnabled)
        #expect(preferences.assistantAddress == BundledAssistantConfiguration.runtimeValue("AssistantServiceURL"))
    }

    @Test("Bundled gateway configuration ignores unexpanded build settings")
    func bundledConfiguration() {
        #expect(BundledAssistantConfiguration.clean(nil).isEmpty)
        #expect(BundledAssistantConfiguration.clean("$(ASSISTANT_ACCESS_CODE)").isEmpty)
        #expect(BundledAssistantConfiguration.clean("  test-code  ") == "test-code")
    }

    @Test("A combined mobility and vision request keeps both dimensions")
    func combinedNeeds() throws {
        let draft = ConversationDraft(stopCode: "01012", busService: "191", need: .wheelchair,
            visionSupport: true, ramp: "declined", actions: [.additionalBoardingTime])
        let context = AssistanceContext(stopCode: "01012", stopName: "Hotel", roadName: "Road", busService: "191", estimatedArrival: nil)
        let request = try draft.journeyDraft().request(for: context)
        #expect(request.need == .wheelchair)
        #expect(request.preferredInteraction == .audio)
        #expect(request.rampPreference == .declined)
        #expect(!request.assistanceRequested.contains(.deployWheelchairRamp))
    }

    @Test("Wire format decodes and actions never imply acknowledgement")
    func wireFormat() throws {
        let data = Data(#"{"version":1,"session_id":"s","turn_id":"t","revision":1,"draft":{"stop_code":"01012","stop_query":null,"bus_service":"191","need":"wheelchair","vision_support":false,"ramp":"requested","actions":["additional_boarding_time"]},"question":"ready","message":"Ready","transcript":"hello","send_requested":false}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ConversationReply.self, from: data)
        #expect(response.sessionId == "s")
        #expect(response.draft.journeyDraft().assistanceRequested.contains(.deployWheelchairRamp))
        #expect(!response.sendRequested)
    }

    @Test("Stop aliases, typos and directions retrieve candidates without fuzzy stop codes")
    func stopRetrieval() async {
        let index = StopSearchIndex()
        let stops = [
            BusStop(code: "11111", roadName: "Science Park Rd", name: "Bef The Synergy", latitude: 1, longitude: 1),
            BusStop(code: "11112", roadName: "Science Park Rd", name: "Opp The Synergy", latitude: 1, longitude: 1),
            BusStop(code: "11113", roadName: "Other Rd", name: "Bef The Synergy", latitude: 1, longitude: 1),
            BusStop(code: "22222", roadName: "Duku Rd", name: "Aft Duku Rd", latitude: 1, longitude: 1)
        ]
        await index.rebuild(with: stops)
        for query in ["bef the synergy", "B4 the Synergy", "before synergy", "Bef. The Synergi"] {
            let matches = await index.conversationSearch(query)
            #expect(matches.map(\.code) == ["11111", "11113"])
        }
        #expect(await index.conversationSearch("opposite synergy").map(\.code) == ["11112"])
        #expect(await index.conversationSearch("after duku road").map(\.code) == ["22222"])
        #expect(await index.conversationSearch("synergy").count == 3)
        #expect(await index.conversationSearch("11114").isEmpty)
        #expect(await index.conversationSearch("11111").map(\.code) == ["11111"])
        #expect(await index.conversationSearch("Atlantis space terminal").isEmpty)
        #expect(await index.conversationSearch("before synergy science park road").map(\.code) == ["11111"])
    }

    @Test("Client refuses missing credentials and malformed endpoints")
    func invalidConfiguration() throws {
        for address in ["", "file:///tmp/foo", "https://user:password@example.com", "https://example.com?token=secret"] {
            #expect(throws: (any Error).self) { try HTTPConversationService(address: address, token: "test") }
        }
        #expect(throws: (any Error).self) { try HTTPConversationService(address: "https://example.com", token: "") }
    }
}
