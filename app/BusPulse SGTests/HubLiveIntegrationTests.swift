import Foundation
import Testing
@testable import BusPulse_SG

@Suite("Actual BusTech hub integration")
struct HubLiveIntegrationTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BUSTECH_HUB_URL"] != nil))
    @MainActor
    func actualBookingFeedbackAndCancellation() async throws {
        let base = try #require(ProcessInfo.processInfo.environment["BUSTECH_HUB_URL"])
        let token = try #require(ProcessInfo.processInfo.environment["BUSTECH_HUB_TOKEN"])
        let client = HTTPVehicleCloudService(endpoint: URL(string: base + "/api/booking")!, token: token)
        let request = AssistanceRequest(context: AssistanceContext(stopCode: "DEMO_STOP", stopName: "Demo stop",
            roadName: "", busService: "DEMO_ROUTE", estimatedArrival: nil), intent: .boarding, need: .wheelchair,
            preferredInteraction: .both, assistanceRequested: [.deployWheelchairRamp, .additionalBoardingTime], rampPreference: .requested)
        let service = AssistanceRequestService(vehicleCloud: client)
        await service.send(request)
        for _ in 0..<30 {
            await service.refreshFeedback(for: request)
            if service.session(for: request.context)?.hubFeedback?.result != nil { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        if service.session(for: request.context)?.hubFeedback?.result == nil {
            let state = try await client.snapshot()
            print("Hub clock: now=\(Date.now.timeIntervalSince1970), observed_ms=\(String(describing: state?.channels["booking"]?.observed_at)), submitted=\(String(describing: service.session(for: request.context)?.receipt?.submittedAt))")
        }
        let result = try #require(service.session(for: request.context)?.hubFeedback?.result)
        #expect(result.plan_status == .ready)
        #expect(result.simulated)
        #expect(!result.execution_authorized)
        #expect(result.passenger_communication.display_text?.isEmpty == false)
        #expect(result.passenger_communication.audio_text?.isEmpty == false)
        #expect(service.session(for: request.context)?.acknowledgement == nil)
        let first = try #require(service.session(for: request.context)?.receipt)
        let duplicate = try await client.submit(request)
        #expect(first.providerReference == duplicate.providerReference)
        let observer = Task { await service.observeTriggers(for: request) }
        defer { observer.cancel() }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        // No state polling here: short true/false pulses must be captured by SSE.
        for _ in 0..<15 {
            for triggered in [true, false] {
                var signal = URLRequest(url: URL(string: base + "/api/perception")!)
                signal.httpMethod = "POST"
                signal.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                signal.setValue("application/json", forHTTPHeaderField: "Content-Type")
                signal.httpBody = try JSONSerialization.data(withJSONObject: [
                    "event_id": "pulse-" + UUID().uuidString, "observed_at": formatter.string(from: Date()),
                    "payload": ["zone": ["triggered": triggered, "roi_id": "short-pulse"], "yolo_detections": []]
                ])
                let (_, response) = try await URLSession.shared.data(for: signal)
                #expect((response as? HTTPURLResponse)?.statusCode == 202)
            }
            try await Task.sleep(for: .milliseconds(200))
            if service.hasTriggered(for: request) { break }
        }
        #expect(service.hasTriggered(for: request))
        #expect(service.takeTriggerFeedback(for: request))
        #expect(!service.takeTriggerFeedback(for: request))
        observer.cancel()
        await observer.value
        await service.cancel(request)
        #expect(service.session(for: request.context)?.phase == .cancelled)
        let state = try #require(try await client.snapshot())
        #expect(state.context.request?.active == false)
        #expect(state.channels["booking"]?.event_id != first.providerReference)
        for _ in 0..<30 {
            if try await client.snapshot()?.result?.plan_status == .needsConfirmation { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        Issue.record("Hub did not roll back to NEEDS_CONFIRMATION after cancellation")
    }
}
