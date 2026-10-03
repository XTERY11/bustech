import AVFoundation
import Foundation
import Observation
import Speech

enum SpeechRecognitionState: Equatable, Sendable {
    case idle
    case requestingPermission
    case listening
    case finishing
    case finished
    case failed(String)

    var isListening: Bool { self == .listening || self == .finishing }
}

@MainActor
@Observable
final class SpeechRecognitionService {
    enum RecognitionError: Error, LocalizedError, Sendable {
        case speechPermissionDenied
        case microphonePermissionDenied
        case recognizerUnavailable
        case audioInputUnavailable
        case noSpeechDetected
        case recognitionFailed(String)

        var errorDescription: String? {
            switch self {
            case .speechPermissionDenied:
                "Speech recognition permission is off. Enable it in Settings or select assistance manually."
            case .microphonePermissionDenied:
                "Microphone permission is off. Enable it in Settings or select assistance manually."
            case .recognizerUnavailable:
                "English speech recognition is unavailable right now. Try again or select assistance manually."
            case .audioInputUnavailable:
                "The microphone could not start. Check the current audio input and try again."
            case .noSpeechDetected:
                "No speech was detected. Tap the microphone and try again."
            case let .recognitionFailed(message):
                "Speech recognition stopped: \(message) Try again or select assistance manually."
            }
        }
    }

    private(set) var state: SpeechRecognitionState = .idle
    private(set) var transcript = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private let usesDeterministicUITestTranscript: Bool
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var hasInstalledTap = false
    private var isAudioSessionActive = false
    private var completionTask: Task<Void, Never>?

    init(usesDeterministicUITestTranscript: Bool = false) {
        self.usesDeterministicUITestTranscript = usesDeterministicUITestTranscript
    }

    func startListening() async {
        cancelListening(resetTranscript: true)
        transcript = ""
        state = .requestingPermission

        if usesDeterministicUITestTranscript {
            state = .listening
            completionTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(550))
                guard let self, !Task.isCancelled else { return }
                transcript = "I'm at stop 01012 waiting for Bus 191. I'm visually impaired. Can the bus tell me when it arrives and guide me to the entrance? I may need a little more time to board."
                state = .finished
            }
            return
        }

        let speechStatus = await requestSpeechAuthorization()
        guard speechStatus == .authorized else {
            fail(RecognitionError.speechPermissionDenied)
            return
        }
        let microphoneGranted = await requestMicrophoneAuthorization()
        guard microphoneGranted else {
            fail(RecognitionError.microphonePermissionDenied)
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            fail(RecognitionError.recognizerUnavailable)
            return
        }

        do {
            try await Self.configureAudioSession()
            isAudioSessionActive = true
            try beginRecognition(using: recognizer)
            state = .listening
        } catch let error as RecognitionError {
            fail(error)
        } catch {
            fail(RecognitionError.recognitionFailed(error.localizedDescription))
        }
    }

    func finishListening() {
        guard state == .listening else { return }
        if usesDeterministicUITestTranscript {
            completionTask?.cancel()
            if transcript.isEmpty {
                transcript = "I'm at stop 01012 waiting for Bus 191. I'm visually impaired. Can the bus tell me when it arrives and guide me to the entrance? I may need a little more time to board."
            }
            state = .finished
            return
        }

        state = .finishing
        audioEngine.stop()
        recognitionRequest?.endAudio()
        recognitionTask?.finish()
        completionTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(900))
            guard let self, !Task.isCancelled, state == .finishing else { return }
            completeRecognition()
        }
    }

    func cancelListening(resetTranscript: Bool = false) {
        completionTask?.cancel()
        completionTask = nil
        cleanupRecognition(cancelTask: true)
        if resetTranscript { transcript = "" }
        state = .idle
    }

    private func beginRecognition(using recognizer: SFSpeechRecognizer) throws {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RecognitionError.audioInputUnavailable
        }
        Self.installAudioTap(on: inputNode, format: format, request: request)
        hasInstalledTap = true
        recognitionRequest = request

        recognitionTask = recognizer.recognitionTask(
            with: request,
            resultHandler: Self.makeRecognitionHandler(for: self)
        )

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            cleanupRecognition(cancelTask: true)
            throw RecognitionError.audioInputUnavailable
        }
    }

    /// AVAudioEngine invokes tap blocks on a real-time audio queue. Creating
    /// this block inside a MainActor-isolated method makes Swift 6 attach a
    /// main-executor precondition to it, which iOS 27 correctly traps as soon
    /// as the first audio buffer arrives. Build the callback from a
    /// nonisolated context so it can run on AVFAudio's queue.
    private nonisolated static func installAudioTap(
        on inputNode: AVAudioInputNode,
        format: AVAudioFormat,
        request: SFSpeechAudioBufferRecognitionRequest
    ) {
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    /// Speech recognition results are also delivered on a framework-owned
    /// queue. Keep that callback nonisolated, then explicitly hop to the main
    /// actor before changing observable UI state.
    private nonisolated static func makeRecognitionHandler(
        for service: SpeechRecognitionService
    ) -> (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { [weak service] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal == true
            let errorMessage = error?.localizedDescription
            Task { @MainActor [weak service, text, errorMessage] in
                guard let service else { return }
                if let text, !text.isEmpty { service.transcript = text }
                if isFinal {
                    service.completeRecognition()
                } else if let errorMessage, service.state.isListening {
                    if service.state == .finishing, !service.transcript.isEmpty {
                        service.completeRecognition()
                    } else {
                        service.fail(RecognitionError.recognitionFailed(errorMessage))
                    }
                }
            }
        }
    }

    private func completeRecognition() {
        completionTask?.cancel()
        completionTask = nil
        cleanupRecognition(cancelTask: false)
        if transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fail(RecognitionError.noSpeechDetected)
        } else {
            state = .finished
        }
    }

    private func fail(_ error: RecognitionError) {
        cleanupRecognition(cancelTask: true)
        state = .failed(error.localizedDescription)
    }

    private func cleanupRecognition(cancelTask: Bool) {
        if audioEngine.isRunning { audioEngine.stop() }
        if hasInstalledTap {
            audioEngine.inputNode.removeTap(onBus: 0)
            hasInstalledTap = false
        }
        if cancelTask { recognitionTask?.cancel() }
        recognitionTask = nil
        recognitionRequest = nil
        if isAudioSessionActive {
            isAudioSessionActive = false
            Task.detached(priority: .utility) {
                try? AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
            }
        }
    }

    private nonisolated static func configureAudioSession() async throws {
        try await Task.detached(priority: .userInitiated) {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        }.value
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        if SFSpeechRecognizer.authorizationStatus() != .notDetermined {
            return SFSpeechRecognizer.authorizationStatus()
        }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func requestMicrophoneAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
