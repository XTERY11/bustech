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
    /// After "Finish": open a fresh category selection. Falls back to `onDone`.
    var onNextPassenger: (() -> Void)? = nil

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
    @State private var twinFailed = false

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
        .onChange(of: journey?.announcementKey) { _, _ in
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

    /// v0.5 hub journey for this booking; nil for an older hub, which keeps the legacy trigger path below.
    private var journey: HubJourney? { requestService.journey(for: request) }
    private var navigation: HubNavigation? { requestService.navigation(for: request) }

    private func hubCard(_ state: HubFeedback) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if let journey, !state.isTerminal, state != .cancelling {
                AssistanceJourneyProgress(stage: journey.journeyStage, matched: journey.isMatched)
                Text(journey.guidanceTitle ?? state.title)
                    .font(.title3.bold())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("assistance.hub.status")
                journeyContent(journey)
            } else {
                Text(hubTitle(state))
                    .font(.title3.bold())
                    .accessibilityIdentifier("assistance.hub.status")
                legacyHubContent(state)
            }
            if case .unavailable = state {
                Text("Connection interrupted. Reconnecting…").font(.footnote).foregroundStyle(.secondary)
            }
            if state == .finished {
                Button("Finish", systemImage: "checkmark.circle.fill") {
                    requestService.finish(request) // Local reset only: the hub has already ended it.
                    (onNextPassenger ?? onEdit)()
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.pulseNavy)
                .accessibilityIdentifier("assistance.status.next")
            } else if state.isTerminal {
                Button("New Request", systemImage: "plus", action: onEdit).buttonStyle(.borderedProminent)
            } else if journey?.isCompleted == true {
                // Directly under the step-by-step guidance: one phone plays one passenger after another.
                Button("Finish", systemImage: "checkmark.circle.fill") {
                    feedback.stopSpeaking()
                    requestService.finish(request)
                    (onNextPassenger ?? onDone)()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(Color.pulseNavy)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Finish journey, next passenger")
                .accessibilityHint("Ends this journey and opens a new assistance request")
                .accessibilityIdentifier("assistance.status.done")
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

    private func hubTitle(_ state: HubFeedback) -> String {
        if state == .finished { return state.title }
        if state.isTerminal || state == .cancelling {
            // The hub's own wording for a cancelled or expired journey, so phone and dashboard agree.
            if journey?.journeyStage == .idle, let title = journey?.guidanceTitle { return title }
            return state.title
        }
        return phase == .sending ? "Sending request…" : hasReceipt ? "Request received by bus" : "Request not sent"
    }

    private func hubMessage(_ state: HubFeedback) -> String {
        if state == .finished { return state.message }
        if journey?.journeyStage == .idle, let text = journey?.guidanceText { return text }
        return state.message
    }

    // MARK: Hub journey (three rounds)

    @ViewBuilder
    private func journeyContent(_ journey: HubJourney) -> some View {
        let stage = journey.journeyStage
        switch stage {
        case .atStop?:
            journeyCallout(journey.guidanceText,
                           symbol: journey.isMatched ? "bus.fill" : "exclamationmark.triangle.fill",
                           tint: journey.isMatched ? Color.pulseGreen : Color.pulseAmber)
        case .onBoard?:
            if let place = journey.boarding_target?.title ?? navigation?.destination?.title {
                placeBadge(place, wheelchair: journey.boarding_target?.isWheelchairBay
                           ?? navigation?.destination?.isWheelchairBay ?? false)
            }
        case .booked?, .idle?, nil:
            if journey.isHeldAtStop {
                // waiting_turn: recognised at the stop while another passenger boards; no_place: the bus
                // has no accessible place left. The hub's words, in the amber waiting style.
                journeyCallout(journey.guidanceText,
                               symbol: journey.reason == "no_place" ? "exclamationmark.triangle.fill" : "hourglass",
                               tint: Color.pulseAmber)
            } else if let text = journey.guidanceText {
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("assistance.journey.message")
            }
            if let queueText = journey.queueText {
                Label(queueText, systemImage: "person.2.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Waiting list: \(queueText)")
                    .accessibilityIdentifier("assistance.journey.queue")
            }
            if journey.reason == "not_boarding" {
                Label("You left the boarding point, so the bus will wait for you to come back.",
                      systemImage: "arrow.uturn.backward")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // One position for the twin in both rounds, so the web view is not reloaded between them.
        // The twin shows whoever is boarding now, so a passenger still in the waiting list does not see it.
        if !journey.isQueued, stage == .onBoard || (stage == .atStop && journey.isMatched) {
            twinView
        }
        if stage == .onBoard {
            navigationSteps(journey)
        }
        if stage == .booked {
            if let place = journey.boarding_target?.title {
                Label("Reserved for you: \(place)", systemImage: journey.boarding_target?.isWheelchairBay == true ? "figure.roll" : "chair.fill")
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("assistance.journey.reserved")
            }
            VStack(alignment: .leading, spacing: 12) {
                AssistanceStopSign(context: request.context)
                receiptArrival
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("assistance.proceed")
        }
    }

    private func journeyCallout(_ text: String?, symbol: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text ?? "Please wait for the safety operator.")
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistance.journey.message")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
    }

    private func placeBadge(_ place: String, wheelchair: Bool) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: wheelchair ? "figure.roll" : "chair.fill")
                .font(.largeTitle)
                .foregroundStyle(Color.pulseGreen)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your place").font(.subheadline).foregroundStyle(.secondary)
                Text(place)
                    .font(.largeTitle.bold())
                    .foregroundStyle(Color.pulseGreen)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.pulseGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your place: \(place)")
        .accessibilityIdentifier("assistance.journey.place")
    }

    @ViewBuilder
    private func navigationSteps(_ journey: HubJourney) -> some View {
        let steps = navigation?.visibleSteps ?? []
        if steps.isEmpty {
            if let text = journey.guidanceText {
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("assistance.journey.message")
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Step by step")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                ForEach(steps.indices, id: \.self) { index in
                    let step = steps[index]
                    let number = step.step ?? index + 1
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(number)")
                            .font(.subheadline.bold().monospacedDigit())
                            .frame(minWidth: 28, minHeight: 28)
                            .background(Color.pulseTeal.opacity(0.18), in: Circle())
                        Image(systemName: maneuverSymbol(step.maneuver))
                            .font(.headline)
                            .foregroundStyle(Color.pulseTeal)
                            .frame(minWidth: 24, minHeight: 28)
                        Text(step.text ?? "")
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Step \(number). \(step.text ?? "")")
                }
                Text("Distances are approximate. The safety operator confirms your position.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("assistance.journey.steps")
        }
    }

    private func maneuverSymbol(_ maneuver: String?) -> String {
        switch maneuver {
        case "START": "door.left.hand.open"
        case "TURN_LEFT": "arrow.turn.up.left"
        case "TURN_RIGHT": "arrow.turn.up.right"
        case "ARRIVE": "mappin.circle.fill"
        default: "arrow.up"
        }
    }

    private var twinURL: URL? {
        let receiver = conversationPreferences.assistanceReceiver
        guard receiver.isEnabled else { return nil }
        return try? receiver.passengerTwinURL(token: conversationPreferences.bridgeToken)
    }

    @ViewBuilder
    private var twinView: some View {
        if let twinURL, !twinFailed {
            PassengerTwinWebView(url: twinURL) { twinFailed = true }
                .frame(height: 260)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Animation of the bus and your boarding route. The same guidance is written on this screen.")
                .accessibilityIdentifier("assistance.journey.twin")
        } else if twinURL != nil {
            Label("The live bus view is unavailable. Follow the written guidance.", systemImage: "eye.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistance.journey.twinUnavailable")
        }
    }

    // MARK: Legacy hub (no journey)

    @ViewBuilder
    private func legacyHubContent(_ state: HubFeedback) -> some View {
        if state.isTerminal || state == .cancelling {
            Text(hubMessage(state)).accessibilityIdentifier("assistance.hub.message")
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
        if requestService.journey(for: request) != nil {
            // Exactly the hub's guidance, once per journey revision; the legacy cues below would contradict it.
            if let journey = requestService.takeJourneyFeedback(for: request) {
                let message = [journey.guidanceTitle, journey.spokenText].compactMap { $0 }.joined(separator: ". ")
                feedback.announceTrigger(message,
                    spoken: request.preferredInteraction != .visual && !UIAccessibility.isVoiceOverRunning)
            }
            return
        }
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
        // A refused hub booking (e.g. this need is already booked) is announced like any failure.
        if hubFeedback != nil, case let .failed(message) = phase, !hasReceipt {
            feedback.announceFailure(message)
            return
        }
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
