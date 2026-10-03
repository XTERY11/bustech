import AVFoundation
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class PassengerFeedbackService {
    private let speechSynthesizer = AVSpeechSynthesizer()
    private let suppressesOutput: Bool

    init(suppressesOutput: Bool = false) {
        self.suppressesOutput = suppressesOutput
    }

    func speak(_ text: String, language: String = "en-SG") {
        guard !suppressesOutput else { return }
        speechSynthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: language)
            ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.48
        speechSynthesizer.speak(utterance)
    }

    func announceAcknowledgement(for service: String, spoken: Bool = true) {
        let message = "Your request has been received by Bus \(service). I'll let you know when it is arriving."
        UIAccessibility.post(notification: .announcement, argument: message)
        guard !suppressesOutput else { return }
        if spoken { speak(message) }
    }

    func announceFailure(_ message: String) {
        UIAccessibility.post(notification: .announcement, argument: message)
        guard !suppressesOutput else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    func announceTrigger(_ message: String, spoken: Bool) {
        guard !suppressesOutput else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        if spoken { speak(message) }
        else { UIAccessibility.post(notification: .announcement, argument: message) }
    }

    func stopSpeaking() {
        speechSynthesizer.stopSpeaking(at: .immediate)
    }
}
