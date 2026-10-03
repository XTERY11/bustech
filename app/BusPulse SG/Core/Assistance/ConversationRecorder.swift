import AVFoundation
import Observation

@MainActor @Observable
final class ConversationRecorder {
    private var recorder: AVAudioRecorder?
    private var limitTask: Task<Void, Never>?
    private var generation = UUID()
    private(set) var isRecording = false
    private(set) var isPreparing = false
    private(set) var completedURL: URL?
    private(set) var errorMessage: String?

    func start() async {
        cancel()
        let current = generation
        isPreparing = true
        let allowed = await AVAudioApplication.requestRecordPermission()
        guard current == generation else { return }
        isPreparing = false
        guard allowed else {
            errorMessage = "Microphone access is off. Enable it in iPhone Settings, or type your message below."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-\(UUID()).m4a")
            let capture = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 48000])
            recorder = capture
            guard capture.record() else { throw ConversationError.connection }
            isRecording = true
            limitTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                self?.finish()
            }
        } catch {
            cancel()
            errorMessage = "The microphone couldn't start. Try again, or type your message."
        }
    }
    func finish() {
        guard let recorder, isRecording else { return }
        limitTask?.cancel()
        recorder.stop()
        isRecording = false
        completedURL = recorder.url
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func cancel() {
        let hadRecorder = recorder != nil
        generation = UUID()
        limitTask?.cancel()
        if let recorder {
            recorder.stop()
            try? FileManager.default.removeItem(at: recorder.url)
        }
        if let completedURL { try? FileManager.default.removeItem(at: completedURL) }
        recorder = nil
        completedURL = nil
        isRecording = false
        isPreparing = false
        errorMessage = nil
        if hadRecorder { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
}
