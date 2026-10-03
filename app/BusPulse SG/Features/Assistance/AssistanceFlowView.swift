import SwiftUI

private enum AssistanceFlowScreen: Equatable {
    case entry
    case manual(AssistanceRequest?)
    case voice
    case status(AssistanceRequest)
}

struct AssistanceFlowView: View {
    let context: AssistanceContext

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var deliveryTask: Task<Void, Never>?
    @Environment(PreferencesStore.self) private var preferences
    @Environment(AssistanceRequestService.self) private var requestService
    @Environment(SpeechRecognitionService.self) private var speechRecognition
    @State private var screen: AssistanceFlowScreen = .entry
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                switch screen {
                case .entry:
                    AssistanceEntryView(
                        context: context,
                        onSelect: { screen = .manual(nil) },
                        onSpeak: { screen = .voice }
                    )
                case let .manual(initialRequest):
                    ManualAssistanceSelectionView(
                        context: context,
                        initialRequest: initialRequest,
                        onSend: send
                    )
                case .voice:
                    VoiceAssistanceView(
                        context: context,
                        onConfirm: send,
                        onEdit: { screen = .manual($0) },
                        onSelectManually: { screen = .manual(nil) }
                    )
                case let .status(request):
                    AssistanceStatusView(
                        request: request,
                        onEdit: { screen = .manual(request) },
                        onDone: { dismiss() },
                        onNextPassenger: { screen = .manual(nil) }
                    )
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if screen != .entry {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left") {
                            speechRecognition.cancelListening()
                            screen = .entry
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .presentationDetents([.large])
        .task {
            if let session = requestService.session(for: context),
               session.phase.retainsInlineCard {
                screen = .status(session.request)
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
    }

    private var navigationTitle: String {
        switch screen {
        case .entry: "Request Assistance"
        case .manual: "Select Assistance"
        case .voice: preferences.conversationalAssistantEnabled ? "Assistant" : "Speak to Assistant"
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
}

private struct AssistanceEntryView: View {
    @Environment(PreferencesStore.self) private var preferences
    let context: AssistanceContext
    let onSelect: () -> Void
    let onSpeak: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                AssistanceJourneyHeader(context: context)

                VStack(alignment: .leading, spacing: 5) {
                    Text("How would you like to request help?")
                        .font(.title3.bold())
                    Text("Choose the bus action you need, or describe it by voice.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    AssistanceEntryButton(
                        title: "Select Assistance",
                        detail: "Choose specific actions for this bus",
                        symbol: "checklist",
                        action: onSelect
                    )
                    AssistanceEntryButton(
                        title: preferences.conversationalAssistantEnabled ? "Chat with Assistant" : "Speak to Assistant",
                        detail: preferences.conversationalAssistantEnabled ? "Describe your needs, one step at a time" : "Use English with the on-device assistant",
                        symbol: "waveform.and.mic",
                        action: onSpeak
                    )
                }
            }
            .padding(20)
        }
        .background(Color(.systemGroupedBackground))
        .accessibilityIdentifier("assistance.entry")
    }
}

private struct AssistanceEntryButton: View {
    let title: String
    let detail: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 15) {
                Image(systemName: symbol)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.pulseTeal)
                    .frame(width: 44, height: 44)
                    .background(Color.pulseTeal.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.subheadline.bold())
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 82, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens \(title)")
        .accessibilityIdentifier(title == "Select Assistance" ? "assistance.chooseManual" : "assistance.chooseVoice")
    }
}
