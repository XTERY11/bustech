import SwiftUI
import UIKit

struct ConversationalAssistanceView: View {
    let context: AssistanceContext?
    let onSelectManually: () -> Void
    @Environment(AssistanceRequestService.self) private var requestService
    @Environment(PreferencesStore.self) private var preferences
    @Environment(TransitDataStore.self) private var dataStore
    @Environment(LocationService.self) private var location
    @Environment(AssistanceJourneyResolver.self) private var resolver
    @Environment(PassengerFeedbackService.self) private var feedback
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var service: (any ConversationServing)?
    @State private var recorder = ConversationRecorder()
    @State private var reply: ConversationReply?
    @State private var candidates: [ConversationStop] = []
    @State private var stopMatches: [String]?
    @State private var sessionId = UUID().uuidString
    @State private var pendingTurn: ConversationTurn?
    @State private var work: Task<Void, Never>?
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var text = ""
    @State private var messages: [ChatMessage] = []
    @State private var voiceInput = false
    @State private var sentRequest: AssistanceRequest?
    @State private var submissionTask: Task<Void, Never>?
    @State private var showAllStops = false
    @State private var selectedHelp: Set<AssistanceAction> = []
    private struct ChatMessage: Identifiable {
        let id = UUID()
        let text: String
        let isUser: Bool
    }
    @FocusState private var typing: Bool

    private var draft: ConversationDraft? { reply?.draft }
    private var question: String { reply?.question ?? (context == nil ? "stop" : "help") }
    private var canSend: Bool { question == "ready" && !busy && !recorder.isRecording && pendingTurn == nil }

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(messages) { item in
                        bubble(item)
                    }
                    if busy {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("One moment…").font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(14)
                        .accessibilityIdentifier("conversation.thinking")
                    }
                    if let error = errorMessage ?? recorder.errorMessage {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(error, systemImage: "exclamationmark.bubble")
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(error)
                                .accessibilityIdentifier("conversation.error")
                            if pendingTurn != nil {
                                Button("Try again", systemImage: "arrow.clockwise") { retry() }
                                    .disabled(busy)
                            } else if canSend {
                                Button("Try sending again") { submit() }
                            }
                            Button("Choose help manually", action: onSelectManually)
                                .accessibilityIdentifier("conversation.manual")
                        }
                        .padding(16)
                        .background(Color.pulseAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                    }
                    if let request = sentRequest {
                        AssistanceStatusView(request: request, onEdit: editRequest, onDone: reset, embedded: true)
                            .id("conversation.receipt")
                    } else if !busy && errorMessage == nil {
                        choices
                    }
                    Color.clear.frame(height: 1).id("conversation.bottom")
                }
                .padding(.horizontal, 16).padding(.vertical, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) { _, _ in scroll.scrollTo("conversation.bottom", anchor: .bottom) }
            .onChange(of: busy) { _, _ in
                if sentRequest != nil { scroll.scrollTo("conversation.receipt", anchor: .top) }
                else { scroll.scrollTo("conversation.bottom", anchor: .bottom) }
            }
            .onChange(of: typing) { _, focused in
                if focused { scroll.scrollTo("conversation.bottom", anchor: .bottom) }
            }
        }
        .background(Color(.systemGroupedBackground))
        .accessibilityIdentifier("conversation.screen")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if sentRequest == nil {
                inputControls
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.regularMaterial)
            } else {
                Button("New conversation", systemImage: "plus.bubble") { reset() }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(.regularMaterial)
                    .disabled(requestService.isUpdating)
                    .accessibilityIdentifier("conversation.reset")
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Choose bus on map", action: onSelectManually)
                    Button("Start again", action: reset).disabled(requestService.isUpdating)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Conversation options")
            }
        }
        .task {
            if messages.isEmpty { voiceInput = voiceOver; welcome() }
            if context == nil { location.requestLocation() }
            await refreshCandidates()
            if reply == nil && pendingTurn == nil { begin(ConversationEvent(kind: "start")) }
        }
        .onChange(of: recorder.completedURL) { _, url in
            guard let url else { return }
            busy = true
            work = Task {
                do {
                    let encoded = try await HTTPConversationService.encodedAudio(at: url)
                    guard !Task.isCancelled else { return }
                    recorder.cancel()
                    busy = false
                    begin(ConversationEvent(kind: "audio", audio: encoded))
                } catch {
                    guard !Task.isCancelled else { return }
                    busy = false
                    errorMessage = "The recording couldn't be opened. Please try again."
                    recorder.cancel()
                }
            }
        }
        .onChange(of: location.coordinate?.latitude) { _, _ in
            if question == "stop" && !busy { work = Task { await refreshCandidates() } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { pause() }
        }
        .onDisappear { pause() }
    }

    private func welcome() {
        let journey = context.map { "You're taking Bus \($0.busService) at \($0.stopName). " } ?? ""
        let question = context == nil ? "Where are you boarding, and what help do you need?" : "What help do you need to board?"
        messages = [ChatMessage(text: "Hi! I can help you board your bus. " + journey + question
            + " I'll ask if anything is missing, then send your request to the bus.", isUser: false)]
    }

    private func bubble(_ item: ChatMessage) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if item.isUser { Spacer(minLength: 32) }
            VStack(alignment: .leading, spacing: 5) {
                if !item.isUser {
                    Text("Assistant").font(.caption.weight(.semibold)).foregroundStyle(Color.pulseTeal)
                        .accessibilityHidden(true)
                }
                Text(item.text)
                    .font(.body).fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(item.isUser ? Color.white : Color.primary)
                    .accessibilityLabel((item.isUser ? "You: " : "Assistant: ") + item.text)
                    .accessibilityIdentifier(item.isUser
                        ? (item.id == messages.last(where: { $0.isUser })?.id ? "conversation.transcript" : "conversation.history.user")
                        : (item.id == messages.last(where: { !$0.isUser })?.id ? "conversation.question" : "conversation.history.assistant"))
            }
            .padding(15)
            .background(item.isUser ? Color.pulseNavy : Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 20))
            if !item.isUser { Spacer(minLength: 32) }
        }
    }

    @ViewBuilder private var choices: some View {
        VStack(alignment: .leading, spacing: 10) {
            if question == "stop" {
                if candidates.isEmpty {
                    Text("Say or type a stop name or code, or choose your bus on the map.")
                        .foregroundStyle(.secondary)
                }
                ForEach(candidates.filter { stopMatches == nil || stopMatches!.contains($0.stopCode) }.prefix(showAllStops ? 24 : 2)) { stop in
                    choice("\(stop.stopCode) · \(stop.stopName)\n\(stop.roadName)", symbol: "mappin.and.ellipse", field: "stop_code", value: stop.stopCode)
                }
                if candidates.filter({ stopMatches == nil || stopMatches!.contains($0.stopCode) }).count > 2 {
                    Button(showAllStops ? "Fewer stops" : "More stops") { showAllStops.toggle() }
                        .font(.subheadline).accessibilityIdentifier("conversation.moreStops")
                }
            } else if question == "bus" {
                if let stop = candidates.first(where: { $0.stopCode == draft?.stopCode }) {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(stop.services, id: \.self) { service in
                                Button("Bus \(service)") {
                                    messages.append(ChatMessage(text: "Bus \(service)", isUser: true))
                                    choose("bus_service", service)
                                }
                                .buttonStyle(.bordered).controlSize(.large)
                                .accessibilityIdentifier("conversation.choice.bus_service.\(service)")
                            }
                        }
                    }
                    Text("Or type your bus number below.").font(.footnote).foregroundStyle(.secondary)
                }
            } else if question == "ramp" {
                choice("Yes, I need a ramp", symbol: "figure.roll", field: "ramp", value: "requested")
                choice("No ramp", symbol: "xmark.circle", field: "ramp", value: "declined")
            } else if question == "help" {
                Text("Select all the help you need.").font(.subheadline).foregroundStyle(.secondary)
                ForEach(AssistanceAction.passengerChoices, id: \.self) { action in
                    Button {
                        if !selectedHelp.insert(action).inserted { selectedHelp.remove(action) }
                    } label: {
                        HStack(spacing: 12) {
                            Label(action.shortTitle, systemImage: action.symbolName)
                            Spacer()
                            Image(systemName: selectedHelp.contains(action) ? "checkmark.circle.fill" : "circle")
                        }
                        .foregroundStyle(selectedHelp.contains(action) ? Color.pulseTeal : Color.primary)
                        .padding(14).frame(maxWidth: .infinity, minHeight: 52)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selectedHelp.contains(action) ? .isSelected : [])
                    .accessibilityIdentifier("conversation.choice.add_actions.\(action.rawValue)")
                }
                Button("Continue") {
                    let selected = AssistanceAction.passengerChoices.filter(selectedHelp.contains)
                    messages.append(ChatMessage(text: selected.map(\.shortTitle).joined(separator: ", "), isUser: true))
                    begin(ConversationEvent(kind: "help",
                        actions: selected.filter { $0 != .deployWheelchairRamp },
                        ramp: selectedHelp.contains(.deployWheelchairRamp) ? "requested" : (draft?.ramp ?? "unspecified")))
                }
                .buttonStyle(.borderedProminent).tint(Color.pulseNavy)
                .disabled(selectedHelp.isEmpty)
                .accessibilityIdentifier("conversation.help.continue")
            }
        }
        .disabled(busy || pendingTurn != nil || recorder.isRecording)
    }

    private func choice(_ label: String, symbol: String, field: String, value: String) -> some View {
        Button {
            messages.append(ChatMessage(text: label.replacingOccurrences(of: "\n", with: ", "), isUser: true))
            choose(field, value)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 24)).frame(width: 28)
                    .foregroundStyle(Color.pulseTeal).accessibilityHidden(true)
                Text(label).foregroundStyle(.primary).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.left").font(.system(size: 22))
                    .foregroundStyle(Color.pulseTeal).accessibilityHidden(true)
            }
            .padding(14).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("conversation.choice.\(field).\(value)")
    }

    private var inputControls: some View {
        VStack(spacing: 8) {
            if recorder.isRecording {
                Text("Listening… Tap Done when you've finished.")
                    .font(.subheadline).accessibilityIdentifier("conversation.recording")
            }
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    typing = false
                    voiceInput.toggle()
                } label: {
                    Image(systemName: voiceInput ? "keyboard" : "mic.fill")
                        .font(.title3).frame(width: 44, height: 48)
                }
                .accessibilityLabel(voiceInput ? "Switch to typing" : "Switch to voice")
                .accessibilityIdentifier("conversation.inputMode")
                .disabled(recorder.isRecording || recorder.isPreparing)
                if voiceInput {
                    Button {
                        if recorder.isRecording { recorder.finish() }
                        else {
                            feedback.stopSpeaking()
                            work = Task { await recorder.start() }
                        }
                    } label: {
                        Label(recorder.isRecording ? "Done" : "Tap to speak",
                              systemImage: recorder.isRecording ? "stop.fill" : "waveform")
                            .font(.headline).frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(recorder.isRecording ? Color.pulseRed : Color.pulseNavy)
                    .disabled(busy || recorder.isPreparing || pendingTurn != nil)
                    .accessibilityHint("Tap to start recording. Tap Done to send your voice message.")
                    .accessibilityIdentifier("conversation.microphone")
                } else {
                    TextField("Message Assistant", text: $text, axis: .vertical)
                        .lineLimit(1...4).padding(12)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                        .focused($typing)
                        .disabled(busy || pendingTurn != nil)
                        .accessibilityIdentifier("conversation.input")
                    Button {
                        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        typing = false
                        begin(ConversationEvent(kind: "text", text: value))
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
                            .frame(width: 44, height: 48)
                    }
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("conversation.addMessage")
                    .disabled(busy || pendingTurn != nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .tint(Color.pulseNavy)
        }
    }

    private func title(_ action: AssistanceAction) -> String {
        switch action {
        case .deployWheelchairRamp: "Ramp"
        case .additionalBoardingTime: "More dwell time"
        case .confirmBusArrivalIdentity: "Identify my bus"
        case .audioBoardingInstruction: "Spoken guidance"
        case .visualBoardingConfirmation: "Written guidance"
        case .visualServiceStopInformation: "Journey information"
        }
    }

    private func choose(_ field: String, _ value: String) {
        begin(ConversationEvent(kind: "choice", field: field, value: value))
    }

    private func refreshCandidates() async {
        var stops: [ConversationStop] = []
        if let query = draft?.stopQuery, !query.isEmpty {
            let matches = await dataStore.conversationStops(matching: query)
            stops = matches.prefix(24).map(candidate)
            stopMatches = stops.map(\.stopCode)
        } else {
            stopMatches = nil
            if let coordinate = location.coordinate {
                stops = await dataStore.nearest(to: coordinate, limit: 8).map(candidate)
            }
        }
        for code in [context?.stopCode, draft?.stopCode].compactMap({ $0 }) {
            if !stops.contains(where: { $0.stopCode == code }), let stop = dataStore.stop(code: code) {
                stops.insert(candidate(stop), at: 0)
            }
        }
        if let context, !stops.contains(where: { $0.stopCode == context.stopCode }) {
            stops.insert(ConversationStop(stopCode: context.stopCode, stopName: context.stopName,
                roadName: context.roadName, services: [context.busService]), at: 0)
        }
        guard !Task.isCancelled else { return }
        candidates = stops
    }

    private func candidate(_ stop: BusStop) -> ConversationStop {
        ConversationStop(stopCode: stop.code, stopName: stop.displayName, roadName: stop.roadName,
                         services: Array(Set(dataStore.routes(at: stop.code).map(\.serviceNo))).sorted())
    }

    private func begin(_ event: ConversationEvent) {
        guard !busy, pendingTurn == nil, sentRequest == nil else { return }
        if event.kind == "text", let value = event.text {
            messages.append(ChatMessage(text: value, isUser: true))
            text = ""
        }
        showAllStops = false
        feedback.stopSpeaking()
        let input = ConversationTurn(version: 1, sessionId: sessionId, turnId: UUID().uuidString,
            revision: reply?.revision ?? 0,
            context: ConversationAppContext(candidates: candidates,
                selected: context.map { ConversationSelection(stopCode: $0.stopCode, busService: $0.busService) },
                stopMatches: stopMatches, locationAvailable: location.coordinate != nil), event: event)
        pendingTurn = input
        retry()
    }

    private func retry() {
        guard let input = pendingTurn, !busy else { return }
        busy = true
        errorMessage = nil
        work = Task {
            do {
                if service == nil { service = try await ConversationServiceFactory.make(preferences: preferences) }
                guard let service else { throw ConversationError.configuration }
                let next = try await service.turn(input)
                guard !Task.isCancelled, input.sessionId == sessionId else { return }
                reply = next
                pendingTurn = nil
                if !next.transcript.isEmpty {
                    if input.event.kind == "audio" { messages.append(ChatMessage(text: next.transcript, isUser: true)) }
                }
                await refreshCandidates()
                guard !Task.isCancelled else { return }
                busy = false
                if next.question == "stop", next.draft.stopQuery != nil, input.event.kind != "stops" {
                    // Complete retrieval in the same user turn, without another LLM call.
                    begin(ConversationEvent(kind: "stops"))
                } else {
                    if input.event.kind != "start" {
                        messages.append(ChatMessage(text: next.message, isUser: false))
                        announce(next.message)
                    }
                    if next.submissionReady == true || next.sendRequested { submit() }
                }
            } catch {
                guard !Task.isCancelled else { return }
                if case ConversationError.rejected(let code) = error,
                   !["session_expired", "revision_conflict", "turn_conflict"].contains(code) {
                    pendingTurn = nil
                }
                errorMessage = error.localizedDescription
                busy = false
                announce(error.localizedDescription)
            }
        }
    }

    private func submit() {
        guard canSend, let draft, sentRequest == nil else { return }
        busy = true
        work = Task {
            do {
                let resolved = try await resolver.resolve(draft.journeyDraft(), coordinate: nil)
                guard !Task.isCancelled else { return }
                // Existing booking service remains the only authority for receipt and vehicle status.
                guard !requestService.isUpdating else {
                    throw ConversationError.connection
                }
                try requestService.prepare(resolved.request)
                sentRequest = resolved.request
                submissionTask = Task { await requestService.send(resolved.request) }
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
                announce(error.localizedDescription)
            }
            busy = false
        }
    }

    private func announce(_ text: String) {
        if voiceOver { UIAccessibility.post(notification: .announcement, argument: text) }
        else if draft?.visionSupport == true { feedback.speak(text) }
    }

    private func pause() {
        if pendingTurn != nil { errorMessage = "The conversation was paused. Tap Try again to continue with your choices." }
        work?.cancel()
        busy = false
        recorder.cancel()
        submissionTask?.cancel()
        feedback.stopSpeaking()
    }

    private func editRequest() {
        guard !requestService.isUpdating else { return }
        sentRequest = nil
        errorMessage = nil
        let prompt = "Tell me what you'd like to change. I still have your journey and help details."
        messages.append(ChatMessage(text: prompt, isUser: false))
        announce(prompt)
    }

    private func reset() {
        pause()
        sessionId = UUID().uuidString
        service = nil
        pendingTurn = nil
        reply = nil
        errorMessage = nil
        sentRequest = nil
        showAllStops = false
        selectedHelp = []
        welcome()
        text = ""
        work = Task { await refreshCandidates(); begin(ConversationEvent(kind: "start")) }
    }
}
