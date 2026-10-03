import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var assistanceFeedbackVisible = true
}

struct AssistanceStatusView: View {
    let request: AssistanceRequest
    let onEdit: () -> Void
    let onDone: () -> Void
    var embedded = false

    @Environment(PreferencesStore.self) private var conversationPreferences
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.assistanceFeedbackVisible) private var feedbackVisible
    @Environment(AssistanceRequestService.self) private var requestService
    @Environment(TransitDataStore.self) private var dataStore
    @State private var arrival: Date?
    @State private var arrivalUpdatedAt: Date?
    @Environment(PassengerFeedbackService.self) private var feedback
    @State private var operationTask: Task<Void, Never>?
    @State private var hasAnnouncedAcknowledgement = false

    var body: some View {
        Group {
            if embedded { statusBody.accessibilityElement(children: .contain) }
            else { ScrollView { statusBody.padding(20) } }
        }
        .background(Color(.systemGroupedBackground))
        .onChange(of: phase) { _, newPhase in
            handleFeedback(for: newPhase)
        }
        .task { handleFeedback(for: phase) }
        .task(id: scenePhase == .active && feedbackVisible) {
            guard scenePhase == .active, feedbackVisible else { return }
            while !Task.isCancelled {
                await requestService.refreshFeedback(for: request)
                guard !Task.isCancelled else { return }
                announceHubFeedback()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
        .task(id: canObserve) {
            guard canObserve else { return }
            await requestService.observeTriggers(for: request)
        }
        .task(id: canObserve && hasReceipt) {
            guard canObserve, hasReceipt else { return }
            while !Task.isCancelled {
                do {
                    let board = try await dataStore.arrivals(for: request.context.stopCode)
                    try Task.checkCancellation()
                    arrival = board.services.first { $0.serviceNo == request.busService }?
                        .estimates.first { $0.slot == request.context.arrivalSlot }?.estimatedArrival
                    arrivalUpdatedAt = board.fetchedAt
                } catch {
                    if Task.isCancelled { return }
                    arrival = nil
                    arrivalUpdatedAt = .now
                }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .onChange(of: hasTriggered) { _, triggered in
            if triggered && canObserve { announceHubFeedback() }
        }
        .onChange(of: hasExitTriggered) { _, triggered in
            if triggered && canObserve { announceHubFeedback() }
        }
        .onChange(of: hubFeedback) { _, _ in
            if hubFeedback?.isTerminal == true { feedback.stopSpeaking() }
            if scenePhase == .active && feedbackVisible { announceHubFeedback() }
        }
        .onDisappear {
            operationTask?.cancel()
            feedback.stopSpeaking()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { operationTask?.cancel() }
        }
        .accessibilityIdentifier("assistance.status")
    }

    private var statusBody: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !embedded { AssistanceJourneyHeader(context: request.context) }
            if let hubFeedback {
                hubCard(hubFeedback)
                if case let .failed(message) = phase { failedCard(message) }
            } else {
                if !embedded {
                    Label("Service not connected", systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary)
                    AssistanceStatusRail(phase: phase)
                }
                statusContent
            }
            if embedded {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Help requested").font(.headline)
                    ForEach(request.assistanceRequested, id: \.self) { action in
                        Label(preparation(action), systemImage: action.symbolName)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("These are the preparations you've asked for. Follow the bus's guidance when it arrives.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversation.preparations")
            } else {
                AssistanceRequestSummaryCard(request: request, showsJourney: false)
            }
        }
    }

    private func preparation(_ action: AssistanceAction) -> String {
        switch action {
        case .deployWheelchairRamp: "A ramp for boarding"
        case .additionalBoardingTime: "More time to board"
        case .confirmBusArrivalIdentity: "Help identifying the bus"
        case .audioBoardingInstruction: "Spoken boarding guidance"
        case .visualBoardingConfirmation: "A visible boarding confirmation"
        case .visualServiceStopInformation: "Visible journey information"
        }
    }

    private var hubFeedback: HubFeedback? {
        guard let session = requestService.session(for: request.context) else { return nil }
        return session.request.id == request.id ? session.hubFeedback : .replaced
    }

    private var hasExitTriggered: Bool { requestService.hasExitTriggered(for: request) }
    private var boardingTitle: String { hasExitTriggered ? "Please board the bus" : "The bus is here" }
    private var hasTriggered: Bool { requestService.hasTriggered(for: request) }
    private var canObserve: Bool {
        scenePhase == .active && feedbackVisible && hubFeedback?.isTerminal != true
            && phase != .cancelled && phase != .completed
    }
    private var hasReceipt: Bool { requestService.session(for: request.context)?.receipt != nil }

    private func hubCard(_ state: HubFeedback) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(state.isTerminal || state == .cancelling ? state.title
                 : phase == .sending ? "Sending request…"
                 : hasReceipt ? "Request received by bus" : "Request not sent")
                .font(.title3.bold())
                .accessibilityIdentifier("assistance.hub.status")
            if state.isTerminal || state == .cancelling {
                Text(state.message).accessibilityIdentifier("assistance.hub.message")
            } else if hasExitTriggered || requestService.busIsAtStop(for: request) {
                VStack(alignment: .leading, spacing: 12) {
                    Label(boardingTitle, systemImage: "bus.fill")
                        .font(.title2.bold())
                        .foregroundStyle(Color.pulseGreen)
                        .accessibilityIdentifier("assistance.boarding.arrived")
                    Text(state.result?.passengerMessage ?? "Preparing your boarding guidance…")
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("assistance.boarding.message")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color.pulseGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            } else if hasTriggered {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 38)).foregroundStyle(Color.pulseGreen)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("You're all set!").font(.title2.bold()).foregroundStyle(Color.pulseGreen)
                            .accessibilityIdentifier("assistance.trigger.confirmed")
                        TimelineView(.periodic(from: .now, by: 15)) { timeline in
                            Text(arrivalMessage(now: timeline.date))
                                .accessibilityIdentifier("assistance.trigger.arrival")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color.pulseGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            } else if hasReceipt {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Please proceed to").font(.body)
                    AssistanceStopSign(context: request.context)
                    receiptArrival
                }
                .accessibilityIdentifier("assistance.proceed")
            } else {
                Text(phase == .sending ? "Sending your assistance request." : "Try sending your request again.")
            }
            if case .unavailable = state {
                Text("Connection interrupted. Reconnecting…").font(.footnote).foregroundStyle(.secondary)
            }
            if state.isTerminal {
                Button("New Request", systemImage: "plus", action: onEdit).buttonStyle(.borderedProminent)
            } else {
                Button("Cancel Request", role: .destructive) {
                    operationTask = Task { await requestService.cancel(request) }
                }
                .buttonStyle(.bordered)
                .disabled(requestService.isUpdating || !hasReceipt)
                .accessibilityIdentifier("assistance.status.cancel")
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 17))
    }

    private var receiptArrival: some View {
        TimelineView(.periodic(from: .now, by: 15)) { timeline in
            Text(arrivalMessage(now: timeline.date).replacingOccurrences(of: "The bus", with: "Bus \(request.busService)"))
                .font(.subheadline)
                .accessibilityIdentifier("assistance.receipt.arrival")
        }
    }

    private func arrivalMessage(now: Date = .now) -> String {
        let fetchedAt = arrivalUpdatedAt ?? request.createdAt
        let estimate = arrivalUpdatedAt == nil ? request.context.estimatedArrival : arrival
        return AssistanceRequest.arrivalMessage(
            estimatedArrival: now.timeIntervalSince(fetchedAt) <= 90 ? estimate : nil, now: now)
    }

    private func announceHubFeedback() {
        if let result = requestService.takeBoardingFeedback(for: request) {
            _ = requestService.takeTriggerFeedback(for: request)
            feedback.announceTrigger(boardingTitle + ". " + (result.passengerMessage ?? ""),
                spoken: request.preferredInteraction != .visual && !UIAccessibility.isVoiceOverRunning)
        } else if hasExitTriggered || requestService.busIsAtStop(for: request) {
            // Do not replay the earlier stage while guidance is being prepared.
            return
        } else if requestService.takeTriggerFeedback(for: request) {
            feedback.announceTrigger("You're all set! " + arrivalMessage(), spoken: conversationPreferences.conversationalAssistantEnabled ? (request.preferredInteraction != .visual && !UIAccessibility.isVoiceOverRunning) : request.need == .visualAccessibility)
        } else if !hasTriggered, request.need == .visualAccessibility,
                  requestService.takeReceiptFeedback(for: request) {
            feedback.speak("Request received by bus. Please proceed to bus stop \(request.context.stopCode), \(request.context.stopName).")
        }
    }

    private var phase: AssistanceRequestPhase {
        requestService.session(for: request.context)?.phase ?? .readyToSend
    }

    @ViewBuilder
    private var statusContent: some View {
        switch phase {
        case .draft, .readyToSend:
            statusCard(
                title: "Ready to send",
                detail: "Review the structured request before it is sent.",
                symbol: "checkmark.circle"
            )
        case .sending:
            progressCard(title: "Sending request…", detail: "Connecting this request to Bus \(request.busService).")
        case .sent:
            progressCard(title: "Waiting for bus confirmation…", detail: "The request was sent. It is not confirmed until the bus acknowledges it.")
        case .received, .active:
            activeCard
        case let .failed(message):
            failedCard(message)
        case .cancelled:
            statusCard(
                title: "Request cancelled",
                detail: "Bus \(request.busService) will no longer treat this assistance request as active.",
                symbol: "xmark.circle"
            )
            Button("Done", action: onDone)
                .buttonStyle(.borderedProminent)
                .tint(Color.pulseNavy)
        case .completed:
            statusCard(
                title: "Assistance completed",
                detail: "This request is no longer active.",
                symbol: "checkmark.seal"
            )
        }
    }

    private var activeCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Request received by bus")
                .font(.title3.bold())
                .accessibilityIdentifier("assistance.status.received")
            Text("Please proceed to")
            AssistanceStopSign(context: request.context)
            receiptArrival

            Button("Cancel Request", role: .destructive) {
                operationTask = Task { await requestService.cancel(request) }
            }
            .buttonStyle(.bordered)
            .tint(Color.pulseRed)
            .accessibilityHint("Stops this active assistance request")
            .accessibilityIdentifier("assistance.status.cancel")
        }
        .padding(18)
        .background(Color.pulseGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private func failedCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Request not confirmed", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(Color.pulseRed)
            Text(message)
                .font(.subheadline)
            ViewThatFits(in: .horizontal) {
                HStack {
                    failureButtons
                }
                VStack(alignment: .leading) {
                    failureButtons
                }
            }
        }
        .padding(16)
        .background(Color.pulseRed.opacity(0.09), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistance.status.failed")
    }

    @ViewBuilder
    private var failureButtons: some View {
        Button("Try Again", systemImage: "arrow.clockwise") {
            operationTask = Task { await requestService.retry(request) }
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.pulseNavy)
        .disabled(requestService.isUpdating)
        .accessibilityIdentifier("assistance.status.retry")
        Button("Edit", systemImage: "slider.horizontal.3", action: onEdit)
            .buttonStyle(.bordered)
    }

    private func progressCard(title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 13) {
            ProgressView().controlSize(.large)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(phase == .sending ? "assistance.status.sending" : "assistance.status.sent")
    }

    private func statusCard(title: String, detail: String, symbol: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: symbol).font(.title2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func handleFeedback(for phase: AssistanceRequestPhase) {
        guard hubFeedback == nil else { return }
        switch phase {
        case .received where !hasAnnouncedAcknowledgement:
            hasAnnouncedAcknowledgement = true
            feedback.announceAcknowledgement(for: request.busService, spoken: conversationPreferences.conversationalAssistantEnabled ? (request.preferredInteraction != .visual && !UIAccessibility.isVoiceOverRunning) : request.need == .visualAccessibility)
        case let .failed(message):
            feedback.announceFailure(message)
        default:
            break
        }
    }
}

private extension String {
    var capitalizedSentence: String {
        guard let first else { return self }
        return first.uppercased() + String(dropFirst())
    }
}
