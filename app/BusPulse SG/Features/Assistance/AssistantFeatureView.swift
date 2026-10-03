import SwiftUI

private enum AssistantFeatureScreen: Equatable {
    case voice
    case manual(AssistanceRequest)
    case status(AssistanceRequest)
}

struct AssistantFeatureView: View {
    let onChooseBusOnMap: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var deliveryTask: Task<Void, Never>?
    @Environment(PreferencesStore.self) private var preferences
    @Environment(AssistanceRequestService.self) private var requestService
    @Environment(SpeechRecognitionService.self) private var speechRecognition
    @State private var screen: AssistantFeatureScreen = .voice
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                switch screen {
                case .voice:
                    VoiceAssistanceView(
                        context: nil,
                        onConfirm: send,
                        onEdit: { screen = .manual($0) },
                        onSelectManually: onChooseBusOnMap
                    )
                case let .manual(request):
                    ManualAssistanceSelectionView(
                        context: request.context,
                        initialRequest: request,
                        onSend: send
                    )
                case let .status(request):
                    AssistanceStatusView(
                        request: request,
                        onEdit: { screen = .manual(request) },
                        onDone: startNewRequest,
                        // Same stop and route, no category chosen yet: the next passenger picks theirs.
                        onNextPassenger: {
                            screen = .manual(AssistanceRequest(context: request.context, intent: .boarding, need: .none,
                                                               preferredInteraction: .visual, assistanceRequested: []))
                        }
                    )
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !preferences.conversationalAssistantEnabled {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Demo Booking", systemImage: "list.clipboard") {
                            screen = .manual(AssistanceRequest(
                                context: AssistanceContext(stopCode: "DEMO_STOP", stopName: "Demo stop", roadName: "",
                                                           busService: "DEMO_ROUTE", estimatedArrival: nil),
                                intent: .boarding, need: .wheelchair, preferredInteraction: .visual,
                                assistanceRequested: [.additionalBoardingTime]
                            ))
                        }
                        .disabled(requestService.isUpdating)
                        .accessibilityIdentifier("assistant.demoBooking")
                    }
                }
                if screen != .voice {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("New Request", systemImage: "waveform") {
                            startNewRequest()
                        }
                    }
                }
            }
        }
        .onDisappear { deliveryTask?.cancel() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { deliveryTask?.cancel() }
        }
        .alert("Request not ready", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Review the request and try again.")
        }
        .accessibilityIdentifier("assistant.feature")
    }

    private var navigationTitle: String {
        switch screen {
        case .voice: "Assistant"
        case .manual: "Select Assistance"
        case .status: "Assistance Status"
        }
    }

    private func send(_ input: AssistanceRequest) {
        let request = preferences.conversationalAssistantEnabled ? input : input.withAutomaticFeedback
        do {
            guard !requestService.isUpdating else { return }
            try requestService.prepare(request)
            screen = .status(request)
            deliveryTask = Task { await requestService.send(request) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startNewRequest() {
        speechRecognition.cancelListening(resetTranscript: true)
        screen = .voice
    }
}
