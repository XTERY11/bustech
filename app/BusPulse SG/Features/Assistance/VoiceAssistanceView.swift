import SwiftUI

struct VoiceAssistanceView: View {
    let context: AssistanceContext?
    let onConfirm: (AssistanceRequest) -> Void
    let onEdit: (AssistanceRequest) -> Void
    let onSelectManually: () -> Void

    @Environment(SpeechRecognitionService.self) private var speechRecognition
    @Environment(LocalAccessibilityAssistantService.self) private var assistant
    @Environment(PassengerFeedbackService.self) private var feedback
    @Environment(AssistanceJourneyResolver.self) private var journeyResolver
    @Environment(LocationService.self) private var location
    @State private var interpretation: AssistantInterpretation?
    @State private var isProcessing = false
    @State private var isStartingRecognition = false
    @State private var recovery: AssistanceRecovery?
    @State private var lastProcessedTranscript = ""
    @State private var journeyConversation = JourneyConversation()

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        if preferences.conversationalAssistantEnabled {
            ConversationalAssistanceView(context: context, onSelectManually: onSelectManually)
        } else {
            legacyBody
        }
    }

    private var legacyBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let context {
                    AssistanceJourneyHeader(context: context, compact: true)
                } else if interpretation == nil {
                    globalVoicePrompt
                }

                if assistant.availability.isAvailable {
                    if context == nil {
                        if interpretation == nil {
                            microphoneControl
                        }
                        transcriptCard
                    } else {
                        transcriptCard
                        microphoneControl
                    }

                    if isProcessing {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Understanding your request on this device…")
                                .font(.subheadline.weight(.medium))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Color.pulseTeal.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityIdentifier("assistance.voice.processing")
                    }

                    if let recovery {
                        AssistanceRecoveryCard(
                            title: recovery.title,
                            message: recovery.message,
                            onTryAgain: startListening,
                            onSelectManually: onSelectManually,
                            fallbackTitle: context == nil ? "Choose Bus on Map" : "Select Assistance"
                        )
                    }

                    if let interpretation {
                        if context == nil {
                            AssistanceJourneyHeader(context: interpretation.request.context, compact: true)
                        }
                        assistantResponse(interpretation)
                        AssistanceRequestSummaryCard(request: interpretation.request)

                        if context != nil {
                            contextualConfirmationControls(for: interpretation)
                        }
                    }
                } else {
                    unavailableCard
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, context == nil ? 100 : 20)
        }
        .background(Color(.systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if context == nil, let interpretation {
                globalConfirmationControls(for: interpretation)
            }
        }
        .task {
            guard context == nil else { return }
            location.requestLocation()
        }
        .onChange(of: speechRecognition.state) { _, state in
            guard state == .finished else { return }
            processTranscript()
        }
        .onDisappear {
            speechRecognition.cancelListening()
            feedback.stopSpeaking()
        }
    }

    private var globalVoicePrompt: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tell me your journey")
                .font(.title2.bold())
                .foregroundStyle(Color.pulseNavy)
            Text("Say where you want to board, which bus you need, and how the bus can help.")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Label(
                location.coordinate == nil ? "Say your stop name or code" : "Current location ready",
                systemImage: location.coordinate == nil ? "mappin.and.ellipse" : "location.fill"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.pulseTeal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.voice.prompt")
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Conversation", systemImage: "captions.bubble")
                .font(.headline)
            Text(displayedTranscript.isEmpty ? "Your English transcript will appear here." : displayedTranscript)
                .font(.body)
                .foregroundStyle(displayedTranscript.isEmpty ? .secondary : .primary)
                .frame(maxWidth: .infinity, minHeight: 68, alignment: .topLeading)
                .accessibilityLabel("Your transcript")
                .accessibilityValue(displayedTranscript.isEmpty ? "No speech yet" : displayedTranscript)
                .accessibilityIdentifier("assistance.voice.transcript")
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var microphoneControl: some View {
        VStack(spacing: 10) {
            Button {
                if speechRecognition.state == .listening {
                    speechRecognition.finishListening()
                } else {
                    startListening()
                }
            } label: {
                ZStack {
                    Circle()
                        .stroke(
                            speechRecognition.state == .listening
                                ? Color.pulseRed.opacity(0.22)
                                : Color.pulseTeal.opacity(0.2),
                            lineWidth: context == nil ? 10 : 0
                        )
                    Circle()
                        .fill(speechRecognition.state == .listening ? Color.pulseRed : Color.pulseNavy)
                        .padding(context == nil ? 12 : 0)
                    Image(systemName: speechRecognition.state == .listening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 35, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: context == nil ? 116 : 88, height: context == nil ? 116 : 88)
            }
            .buttonStyle(.plain)
            .disabled(
                isStartingRecognition
                    || speechRecognition.state == .requestingPermission
                    || speechRecognition.state == .finishing
                    || isProcessing
            )
            .accessibilityLabel(speechRecognition.state == .listening ? "Stop listening" : "Start listening")
            .accessibilityHint(microphoneHint)
            .accessibilityIdentifier("assistance.voice.microphone")

            Text(microphoneStatus)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("assistance.voice.state")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }

    private var microphoneStatus: String {
        if isStartingRecognition { return "Preparing microphone…" }
        return switch speechRecognition.state {
        case .idle: "Tap to speak"
        case .requestingPermission: "Preparing microphone…"
        case .listening: "Listening · tap again when done"
        case .finishing: "Finishing transcript…"
        case .finished: "Transcript ready"
        case .failed: "Speech recognition needs attention"
        }
    }

    private var microphoneHint: String {
        if let context {
            return "Speak in English about the help you need for Bus \(context.busService)"
        }
        return "Speak in English and include your boarding location, bus service, and the help you need"
    }

    private func assistantResponse(_ interpretation: AssistantInterpretation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Assistant", systemImage: "apple.intelligence")
                .font(.headline)
                .foregroundStyle(Color.pulseTeal)
            Text(interpretation.passengerResponse)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pulseTeal.opacity(0.09), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistance.voice.response")
    }

    private func contextualConfirmationControls(
        for interpretation: AssistantInterpretation
    ) -> some View {
        VStack(spacing: 10) {
            confirmButton(for: interpretation)
            editButton(for: interpretation)
        }
    }

    private func globalConfirmationControls(
        for interpretation: AssistantInterpretation
    ) -> some View {
        HStack(spacing: 10) {
            confirmButton(for: interpretation)
            editButton(for: interpretation)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    private func confirmButton(for interpretation: AssistantInterpretation) -> some View {
        Button("Send Request", systemImage: "paperplane.fill") {
            onConfirm(interpretation.request)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(Color.pulseNavy)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("assistance.voice.confirm")
    }

    private func editButton(for interpretation: AssistantInterpretation) -> some View {
        Button("Edit", systemImage: "slider.horizontal.3") {
            onEdit(interpretation.request)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityHint("Opens the manual selection screen with this interpretation")
        .accessibilityIdentifier("assistance.voice.edit")
    }

    private var unavailableCard: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label("Voice assistant unavailable", systemImage: "waveform.slash")
                .font(.headline)
            Text("\(assistant.availability.guidance) You can still request the same actions manually.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button(
                context == nil ? "Choose Bus on Map" : "Select Assistance",
                systemImage: context == nil ? "map" : "checklist",
                action: onSelectManually
            )
                .buttonStyle(.borderedProminent)
                .tint(Color.pulseNavy)
                .accessibilityIdentifier("assistance.voice.fallback")
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier("assistance.voice.unavailable")
    }

    private func startListening() {
        guard !isStartingRecognition else { return }
        isStartingRecognition = true
        interpretation = nil
        recovery = nil
        lastProcessedTranscript = ""
        Task {
            await speechRecognition.startListening()
            isStartingRecognition = false
        }
    }

    private func processTranscript() {
        let transcript = speechRecognition.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty, transcript != lastProcessedTranscript else { return }
        lastProcessedTranscript = transcript
        isProcessing = true
        recovery = nil
        Task {
            do {
                let result: AssistantInterpretation
                if let context {
                    result = try await assistant.interpret(transcript: transcript, context: context)
                } else {
                    let journeyTranscript = journeyConversation.append(transcript)
                    let nearbyStops = await journeyResolver.nearbyCandidates(
                        to: location.effectiveCoordinate
                    )
                    let draft = try await assistant.interpretJourney(
                        transcript: journeyTranscript,
                        nearbyStops: nearbyStops,
                        currentLocationIsAvailable: location.coordinate != nil
                    )
                    result = try await journeyResolver.resolve(
                        draft,
                        coordinate: location.coordinate
                    )
                }
                interpretation = result
                feedback.speak(result.passengerResponse)
            } catch {
                let nextRecovery = AssistanceRecovery(error: error)
                recovery = nextRecovery
                feedback.speak(nextRecovery.message)
            }
            isProcessing = false
        }
    }

    private var displayedTranscript: String {
        let current = speechRecognition.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard context == nil else { return current }
        let priorJourneyTranscript = journeyConversation.transcript
        guard !priorJourneyTranscript.isEmpty else { return current }
        guard !current.isEmpty,
              current != priorJourneyTranscript,
              !priorJourneyTranscript.hasSuffix(current) else { return priorJourneyTranscript }
        return "\(priorJourneyTranscript)\n\(current)"
    }

}

private struct AssistanceRecoveryCard: View {
    let title: String
    let message: String
    let onTryAgain: () -> Void
    let onSelectManually: () -> Void
    let fallbackTitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: "exclamationmark.bubble")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack {
                    recoveryButtons
                }
                VStack(alignment: .leading) {
                    recoveryButtons
                }
            }
        }
        .padding(16)
        .background(Color.pulseAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private var recoveryButtons: some View {
        Button("Try Again", systemImage: "mic", action: onTryAgain)
            .buttonStyle(.bordered)
        Button(
            fallbackTitle,
            systemImage: fallbackTitle == "Choose Bus on Map" ? "map" : "checklist",
            action: onSelectManually
        )
            .buttonStyle(.borderedProminent)
            .tint(Color.pulseNavy)
    }
}

private struct AssistanceRecovery {
    let title: String
    let message: String

    init(error: any Error) {
        message = error.localizedDescription
        switch error {
        case JourneyAssistanceResolutionError.missingBusService,
             JourneyAssistanceResolutionError.missingBoardingStop,
             JourneyAssistanceResolutionError.currentLocationUnavailable:
            title = "One more journey detail"
        case JourneyAssistanceResolutionError.stopNotFound(_),
             JourneyAssistanceResolutionError.serviceNotAtStop(_, _),
             JourneyAssistanceResolutionError.noUpcomingArrival(_, _):
            title = "Journey not found"
        case JourneyAssistanceResolutionError.arrivalLookupFailed(_):
            title = "Live arrivals unavailable"
        case is AssistanceValidationError:
            title = "Request needs clarification"
        case is LocalAccessibilityAssistantService.AssistantError:
            title = "Assistant could not complete the request"
        default:
            title = "Something went wrong"
        }
    }
}
