import Foundation
import Observation

@MainActor
@Observable
final class AssistanceRequestService {
    private(set) var sessions: [String: AssistanceSession] = [:]
    private(set) var isUpdating = false
    private let vehicleCloudProvider: () throws -> any VehicleCloudServing
    private var clients: [UUID: any VehicleCloudServing] = [:]
    private var failedCancellations: Set<UUID> = []
    private var announcedResults: Set<String> = []
    private var refreshingRequests: Set<UUID> = []
    private var announcedTriggers: Set<UUID> = []
    private var observingRequests: Set<UUID> = []
    private var announcedJourneys: [UUID: String] = [:]

    init(vehicleCloud: any VehicleCloudServing = MockVehicleCloudService()) {
        vehicleCloudProvider = { vehicleCloud }
    }

    init(vehicleCloudProvider: @escaping () throws -> any VehicleCloudServing) {
        self.vehicleCloudProvider = vehicleCloudProvider
    }

    func session(for context: AssistanceContext) -> AssistanceSession? { sessions[context.id] }

    @discardableResult
    func prepare(_ request: AssistanceRequest) throws -> AssistanceSession {
        let validated = try request.validated()
        let session = AssistanceSession(request: validated, phase: .readyToSend, receipt: nil, acknowledgement: nil)
        sessions[validated.context.id] = session
        return session
    }

    func send(_ request: AssistanceRequest) async {
        guard !isUpdating else { return }
        isUpdating = true
        defer { isUpdating = false }
        do {
            if sessions[request.context.id]?.request.id != request.id { try prepare(request) }
            let client: any VehicleCloudServing
            if let existing = clients[request.id] { client = existing }
            else {
                client = try vehicleCloudProvider()
                clients[request.id] = client
            }
            update(request, phase: .sending)
            if client.usesHubFeedback { setFeedback(.waiting, for: request) }
            let receipt = try await client.submit(request)
            guard isCurrent(request) else { return }
            update(request, phase: .sent, receipt: receipt)
            if client.usesHubFeedback {
                // BusTech supports exactly one active booking at this hub.
                for key in Array(sessions.keys) where sessions[key]?.request.id != request.id && sessions[key]?.hubFeedback != nil {
                    sessions[key]?.hubFeedback = .replaced
                }
                await refreshFeedback(for: request)
            } else {
                let acknowledgement = try await client.acknowledgement(for: receipt, request: request)
                guard isCurrent(request), sessions[request.context.id]?.phase != .cancelled else { return }
                update(request, phase: .received, receipt: receipt, acknowledgement: acknowledgement)
            }
        } catch {
            if isCurrent(request) { update(request, phase: .failed(error.localizedDescription)) }
        }
    }

    func retry(_ request: AssistanceRequest) async {
        if failedCancellations.contains(request.id) { await cancel(request) }
        else { await send(request) }
    }

    func cancel(_ request: AssistanceRequest) async {
        guard !isUpdating, isCurrent(request) else { return }
        isUpdating = true
        defer { isUpdating = false }
        do {
            let client = try clients[request.id] ?? vehicleCloudProvider()
            if client.usesHubFeedback { setFeedback(.cancelling, for: request) }
            try await client.cancel(request)
            failedCancellations.remove(request.id)
            update(request, phase: .cancelled)
            if client.usesHubFeedback { setFeedback(.cancelled, for: request) }
        } catch HTTPVehicleCloudService.ServiceError.bookingReplaced {
            failedCancellations.remove(request.id)
            setFeedback(.replaced, for: request)
            update(request, phase: .completed)
        } catch {
            if sessions[request.context.id]?.hubFeedback != nil {
                setFeedback(.unavailable("Cancellation is not confirmed. Retry the cancellation to check with the hub."), for: request)
            }
            failedCancellations.insert(request.id)
            update(request, phase: .failed(error.localizedDescription))
        }
    }

    func refreshFeedback(for request: AssistanceRequest, now: Date = .now) async {
        guard isCurrent(request), let session = sessions[request.context.id],
              session.hubFeedback != nil, session.hubFeedback?.isTerminal != true,
              session.hubFeedback != .cancelling, !failedCancellations.contains(request.id),
              session.phase != .sending,
              let client = clients[request.id], let receipt = session.receipt,
              session.phase != .cancelled, refreshingRequests.insert(request.id).inserted else { return }
        defer { refreshingRequests.remove(request.id) }
        // Do not keep presenting a READY result after its five-minute lifetime,
        // including when this version of the hub preserves presentation snapshots.
        // A completed hub journey (ON_BOARD) no longer expires at the hub, so it does not expire here either.
        guard now.timeIntervalSince(receipt.submittedAt) < 300 || session.journey?.isCompleted == true else {
            setFeedback(.expired, for: request)
            return
        }
        do {
            guard let snapshot = try await client.snapshot() else { return }
            try Task.checkCancellation()
            guard isCurrent(request), sessions[request.context.id]?.phase != .cancelled,
                  sessions[request.context.id]?.hubFeedback?.isTerminal != true,
                  sessions[request.context.id]?.hubFeedback != .cancelling,
                  !failedCancellations.contains(request.id) else { return }
            if applyJourney(snapshot, for: request, receipt: receipt) { return }
            setFeedback(snapshot.feedback(for: request, eventID: receipt.providerReference, now: now), for: request)
            sessions[request.context.id]?.busAtStop = snapshot.busIsAtStop(
                for: request, eventID: receipt.providerReference, now: now)
            recordTrigger(snapshot, for: request, now: now)
        } catch {
            guard !Task.isCancelled, sessions[request.context.id]?.phase != .cancelled,
                  sessions[request.context.id]?.hubFeedback?.isTerminal != true,
                  sessions[request.context.id]?.hubFeedback != .cancelling else { return }
            setFeedback(.unavailable("Connection interrupted. Reconnecting… \(error.localizedDescription)"), for: request)
        }
    }

    func observeTriggers(for request: AssistanceRequest) async {
        guard observingRequests.insert(request.id).inserted else { return }
        defer { observingRequests.remove(request.id) }
        while !Task.isCancelled, isCurrent(request) {
            guard let session = sessions[request.context.id], session.hubFeedback?.isTerminal != true,
                  session.phase != .cancelled, session.phase != .completed else { return }
            if let client = clients[request.id], session.receipt != nil, client.usesHubFeedback {
                do {
                    try await client.observeSnapshots { [weak self] snapshot in
                        await self?.recordTrigger(snapshot, for: request)
                    }
                } catch { if Task.isCancelled { return } }
            } else if session.receipt != nil { return }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    private func recordTrigger(_ snapshot: HubSnapshot, for request: AssistanceRequest, now: Date = .now) {
        guard isCurrent(request), let session = sessions[request.context.id],
              session.phase != .cancelled, session.phase != .completed,
              session.hubFeedback?.isTerminal != true, session.hubFeedback != .cancelling,
              !failedCancellations.contains(request.id), let receipt = session.receipt,
              now.timeIntervalSince(receipt.submittedAt) < 300 || session.journey?.isCompleted == true else { return }
        if applyJourney(snapshot, for: request, receipt: receipt) { return }
        if session.triggeredAt == nil, snapshot.hasTrigger(for: request, receipt: receipt, now: now) {
            sessions[request.context.id]?.triggeredAt = now
            sessions[request.context.id]?.triggerObservedAt = snapshot.perceptionObservedAt
            sessions[request.context.id]?.triggerROI = snapshot.context.perception?.zone?.roi_id
        } else if session.exitTriggeredAt == nil, let enteredAt = session.triggerObservedAt,
                  snapshot.hasExitTrigger(for: request, receipt: receipt, enteredAt: enteredAt,
                                          roiID: session.triggerROI, now: now) {
            sessions[request.context.id]?.exitTriggeredAt = now
        }
    }

    /// v0.5 hubs publish one passenger journey. When the snapshot has one, it replaces the legacy
    /// trigger latching, vehicle telemetry check, freshness window and ROI correlation, and the
    /// stage may move back (AT_STOP → BOOKED) exactly as the hub decides. Returns false for older hubs.
    private func applyJourney(_ snapshot: HubSnapshot, for request: AssistanceRequest,
                              receipt: VehicleSubmissionReceipt) -> Bool {
        guard snapshot.journey != nil else { return false }
        guard isCurrent(request), let session = sessions[request.context.id] else { return true }
        if let journey = snapshot.ownJourney(eventID: receipt.providerReference) {
            // Polling and the event stream can arrive out of order; never step back to an older revision.
            if let current = session.journey, current.journey_id == journey.journey_id,
               (journey.revision ?? 0) < (current.revision ?? 0) { return true }
            sessions[request.context.id]?.journey = journey
            sessions[request.context.id]?.navigation = snapshot.navigation
        }
        setFeedback(snapshot.feedback(for: request, eventID: receipt.providerReference), for: request)
        return true
    }

    /// The hub's journey for this request, or nil when the hub predates v0.5.
    func journey(for request: AssistanceRequest) -> HubJourney? {
        guard isCurrent(request) else { return nil }
        return sessions[request.context.id]?.journey
    }

    func navigation(for request: AssistanceRequest) -> HubNavigation? {
        guard isCurrent(request) else { return nil }
        return sessions[request.context.id]?.navigation
    }

    /// Announces new hub guidance once, across view instances. Stale revisions never reach the
    /// session (see applyJourney); a newer revision with the same words (e.g. pending_exit) is not
    /// repeated, while returning to earlier guidance (AT_STOP → BOOKED) is announced again.
    func takeJourneyFeedback(for request: AssistanceRequest) -> HubJourney? {
        guard let journey = journey(for: request), journey.guidanceTitle != nil,
              let feedback = sessions[request.context.id]?.hubFeedback,
              !feedback.isTerminal, feedback != .cancelling,
              !failedCancellations.contains(request.id),
              announcedJourneys[request.id] != journey.announcementKey else { return nil }
        announcedJourneys[request.id] = journey.announcementKey
        return journey
    }

    func hasTriggered(for request: AssistanceRequest) -> Bool {
        guard isCurrent(request), let session = sessions[request.context.id] else { return false }
        return session.triggeredAt != nil && session.hubFeedback?.isTerminal != true
            && session.phase != .cancelled && session.phase != .completed
    }

    /// An explicit CV exit is a presentation trigger, not confirmation of boarding or vehicle execution.
    func hasExitTriggered(for request: AssistanceRequest) -> Bool {
        guard hasTriggered(for: request), let session = sessions[request.context.id],
              session.exitTriggeredAt != nil, session.hubFeedback != .cancelling,
              !failedCancellations.contains(request.id) else { return false }
        if case .unavailable = session.hubFeedback { return false }
        return true
    }

    /// Shared across view instances, so reopening a request never vibrates again.
    func takeTriggerFeedback(for request: AssistanceRequest) -> Bool {
        hasTriggered(for: request) && announcedTriggers.insert(request.id).inserted
    }

    func busIsAtStop(for request: AssistanceRequest) -> Bool {
        guard hasTriggered(for: request), let session = sessions[request.context.id],
              session.hubFeedback != .cancelling, !failedCancellations.contains(request.id),
              session.busAtStop == true else { return false }
        if case .unavailable = session.hubFeedback { return false }
        return true
    }

    func takeBoardingFeedback(for request: AssistanceRequest) -> HubResult? {
        guard busIsAtStop(for: request) || hasExitTriggered(for: request), let result = sessions[request.context.id]?.hubFeedback?.result,
              result.passengerMessage != nil else { return nil }
        let key = "boarding-\(request.id)-\(hasExitTriggered(for: request))-\(result.request_id)-\(result.passengerMessage ?? "")"
        guard announcedResults.insert(key).inserted else { return nil }
        return result
    }

    func takeReceiptFeedback(for request: AssistanceRequest) -> Bool {
        guard isCurrent(request), sessions[request.context.id]?.receipt != nil else { return false }
        return announcedResults.insert("receipt-\(request.id)").inserted
    }

    /// A result can appear on more than one view, and polling repeats it.
    func takeAudioFeedback(for request: AssistanceRequest) -> HubResult? {
        guard isCurrent(request), request.preferredInteraction != .visual,
              let result = sessions[request.context.id]?.hubFeedback?.result,
              let text = result.passenger_communication.audio_text, !text.isEmpty else { return nil }
        let key = "\(request.id)-\(result.request_id)"
        guard announcedResults.insert(key).inserted else { return nil }
        return result
    }

    func complete(_ request: AssistanceRequest) { update(request, phase: .completed) }

    private func isCurrent(_ request: AssistanceRequest) -> Bool {
        sessions[request.context.id]?.request.id == request.id
    }

    private func setFeedback(_ feedback: HubFeedback, for request: AssistanceRequest) {
        guard isCurrent(request) else { return }
        sessions[request.context.id]?.hubFeedback = feedback
    }

    private func update(_ request: AssistanceRequest, phase: AssistanceRequestPhase,
                        receipt: VehicleSubmissionReceipt? = nil, acknowledgement: VehicleAcknowledgement? = nil) {
        guard var session = sessions[request.context.id], session.request.id == request.id else { return }
        session.phase = phase
        if let receipt { session.receipt = receipt }
        if let acknowledgement { session.acknowledgement = acknowledgement }
        sessions[request.context.id] = session
    }
}
