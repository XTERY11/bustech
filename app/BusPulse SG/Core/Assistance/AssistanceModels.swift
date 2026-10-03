import Foundation

enum TravelIntent: String, Codable, CaseIterable, Hashable, Sendable {
    case boarding
    case alighting
    case unknown

    var title: String {
        switch self {
        case .boarding: "Boarding"
        case .alighting: "Alighting"
        case .unknown: "Not specified"
        }
    }

    var symbolName: String {
        switch self {
        case .boarding: "figure.walk.arrival"
        case .alighting: "figure.walk.departure"
        case .unknown: "questionmark.circle"
        }
    }
}

enum AccessibilityNeed: String, Codable, CaseIterable, Hashable, Sendable {
    case wheelchair, crutch, cane, walker, stroller
    case none, unknown
    case mobility
    case visualAccessibility = "visual_accessibility"
    case hearingAccessibility = "hearing_accessibility"

    var title: String {
        switch self {
        case .wheelchair: "Wheelchair"
        case .crutch: "Crutch"
        case .cane: "Cane"
        case .walker: "Walker"
        case .stroller: "Stroller"
        case .none: "No accessibility need"
        case .unknown: "Not specified"
        case .mobility: "Mobility"
        case .visualAccessibility: "Vision support"
        case .hearingAccessibility: "Hearing support"
        }
    }

    var prompt: String {
        switch self {
        case .wheelchair, .crutch, .cane, .walker, .stroller, .mobility: "Help me board or leave the bus safely"
        case .none: "Request journey information"
        case .unknown: "Ask the operator to confirm my needs"
        case .visualAccessibility: "Help me identify and enter the right bus"
        case .hearingAccessibility: "Show important boarding information"
        }
    }

    var symbolName: String {
        switch self {
        case .wheelchair, .mobility: "figure.roll"
        case .crutch, .cane, .walker: "figure.walk"
        case .stroller: "stroller"
        case .none, .unknown: "person.crop.circle"
        case .visualAccessibility: "eye.slash"
        case .hearingAccessibility: "ear.badge.waveform"
        }
    }

    // Needs inform the receiver; they do not restrict a passenger's other needs.
    var availableActions: [AssistanceAction] { AssistanceAction.allCases }
    var automaticInteraction: InteractionMode { self == .visualAccessibility ? .audio : .visual }

}

enum InteractionMode: String, Codable, CaseIterable, Hashable, Sendable {
    case audio
    case visual
    case both

    var title: String { rawValue.capitalized }

    var symbolName: String {
        switch self {
        case .audio: "speaker.wave.2"
        case .visual: "text.bubble"
        case .both: "speaker.wave.2.bubble"
        }
    }
}

enum AssistanceAction: String, Codable, CaseIterable, Hashable, Sendable {
    case deployWheelchairRamp = "deploy_wheelchair_ramp"
    case additionalBoardingTime = "additional_boarding_time"
    case confirmBusArrivalIdentity = "confirm_bus_arrival_identity"
    case audioBoardingInstruction = "audio_boarding_instruction"
    case visualBoardingConfirmation = "visual_boarding_confirmation"
    case visualServiceStopInformation = "visual_service_stop_information"

    var title: String {
        switch self {
        case .deployWheelchairRamp: "Deploy wheelchair ramp"
        case .additionalBoardingTime: "Additional boarding time"
        case .confirmBusArrivalIdentity: "Confirm bus arrival / identity"
        case .audioBoardingInstruction: "Audio boarding instruction"
        case .visualBoardingConfirmation: "Visual boarding confirmation"
        case .visualServiceStopInformation: "Visual service / stop information"
        }
    }

    static let passengerChoices: [Self] = [.deployWheelchairRamp, .additionalBoardingTime, .confirmBusArrivalIdentity,
                                         .audioBoardingInstruction, .visualBoardingConfirmation]
    var shortTitle: String {
        switch self {
        case .deployWheelchairRamp: "Need a ramp"
        case .additionalBoardingTime: "More dwell time"
        case .confirmBusArrivalIdentity: "Identify bus"
        case .audioBoardingInstruction: "Spoken guidance"
        case .visualBoardingConfirmation, .visualServiceStopInformation: "Written guidance"
        }
    }
    var symbolName: String {
        switch self {
        case .deployWheelchairRamp: "figure.roll"
        case .additionalBoardingTime: "clock"
        case .confirmBusArrivalIdentity: "bus"
        case .audioBoardingInstruction: "speaker.wave.2"
        case .visualBoardingConfirmation, .visualServiceStopInformation: "text.bubble"
        }
    }

    var activePromise: String {
        switch self {
        case .deployWheelchairRamp: "deploy the wheelchair ramp"
        case .additionalBoardingTime: "allow additional boarding time"
        case .confirmBusArrivalIdentity: "announce and identify itself on arrival"
        case .audioBoardingInstruction: "provide audio boarding guidance"
        case .visualBoardingConfirmation: "provide a visual boarding confirmation"
        case .visualServiceStopInformation: "show the service and stop information"
        }
    }
}

struct AssistanceContext: Identifiable, Codable, Hashable, Sendable {
    let stopCode: String
    let stopName: String
    let roadName: String
    let busService: String
    let arrivalSlot: Int
    let estimatedArrival: Date?

    init(stop: BusStop, service: ServiceArrivals, estimate: ArrivalEstimate) {
        stopCode = stop.code
        stopName = stop.displayName
        roadName = stop.roadName
        busService = service.serviceNo
        arrivalSlot = estimate.slot
        estimatedArrival = estimate.estimatedArrival
    }

    init(
        stopCode: String,
        stopName: String,
        roadName: String,
        busService: String,
        arrivalSlot: Int = 0,
        estimatedArrival: Date?
    ) {
        self.stopCode = stopCode
        self.stopName = stopName
        self.roadName = roadName
        self.busService = busService
        self.arrivalSlot = arrivalSlot
        self.estimatedArrival = estimatedArrival
    }

    var id: String { "\(stopCode)-\(busService)-\(arrivalSlot)" }

    func etaDescription(now: Date = .now) -> String {
        ArrivalFormatting.countdown(to: estimatedArrival, now: now)
    }
}

struct AssistanceRequest: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let context: AssistanceContext
    let intent: TravelIntent
    let need: AccessibilityNeed
    let preferredInteraction: InteractionMode
    let assistanceRequested: [AssistanceAction]
    let createdAt: Date
    let rampPreference: RampPreference
    let language: PassengerLanguage

    init(
        id: UUID = UUID(),
        context: AssistanceContext,
        intent: TravelIntent,
        need: AccessibilityNeed,
        preferredInteraction: InteractionMode,
        assistanceRequested: [AssistanceAction],
        createdAt: Date = .now,
        rampPreference: RampPreference? = nil,
        language: PassengerLanguage = .english
    ) {
        self.id = id
        self.context = context
        self.intent = intent
        self.need = need
        self.preferredInteraction = preferredInteraction
        self.assistanceRequested = assistanceRequested.reduce(into: []) { result, action in
            if !result.contains(action) { result.append(action) }
        }
        self.createdAt = createdAt
        self.rampPreference = rampPreference ?? (assistanceRequested.contains(.deployWheelchairRamp) ? .requested : .unspecified)
        self.language = language
    }

    var busService: String { context.busService }

    var withAutomaticFeedback: AssistanceRequest {
        AssistanceRequest(id: id, context: context, intent: intent, need: need,
            preferredInteraction: need.automaticInteraction, assistanceRequested: assistanceRequested,
            createdAt: createdAt, rampPreference: rampPreference, language: .english)
    }

    static func arrivalMessage(estimatedArrival: Date?, now: Date = .now) -> String {
        guard let estimatedArrival else { return "Arrival time unavailable." }
        let countdown = ArrivalFormatting.countdown(to: estimatedArrival, now: now)
        return countdown == "Arr" ? "The bus is arriving." : "The bus will arrive in \(countdown)."
    }

    func validated() throws -> AssistanceRequest {
        guard HubBookingEnvelope.isValidID(context.stopCode),
              HubBookingEnvelope.isValidID(context.busService) else {
            throw AssistanceValidationError.missingJourneyContext
        }
        guard rampPreference != .declined || !assistanceRequested.contains(.deployWheelchairRamp) else {
            throw AssistanceValidationError.conflictingRampPreference
        }
        let allowed = Set(need.availableActions)
        guard assistanceRequested.allSatisfy(allowed.contains) else {
            throw AssistanceValidationError.incompatibleAction
        }
        return self
    }
}

enum AssistanceValidationError: Error, LocalizedError, Equatable, Sendable {
    case missingJourneyContext
    case noAssistanceSelected
    case incompatibleAction
    case conflictingRampPreference
    case malformedModelOutput
    case unsafePassengerResponse

    var errorDescription: String? {
        switch self {
        case .missingJourneyContext:
            "The selected stop or bus is no longer available. Return to arrivals and choose it again."
        case .noAssistanceSelected:
            "Choose at least one action for the bus."
        case .conflictingRampPreference:
            "A declined ramp cannot also be requested. Review the ramp preference."
        case .incompatibleAction:
            "One or more actions do not match the selected assistance type. Review the request and try again."
        case .malformedModelOutput:
            "The assistant could not form a reliable request. You can still select assistance manually."
        case .unsafePassengerResponse:
            "The assistant response described a vehicle acknowledgement that has not happened yet."
        }
    }
}

enum AssistanceRequestPhase: Codable, Equatable, Hashable, Sendable {
    case draft
    case readyToSend
    case sending
    case sent
    case received
    case failed(String)
    case cancelled
    case active
    case completed

    var accessibilityLabel: String {
        switch self {
        case .draft: "Draft"
        case .readyToSend: "Ready to send"
        case .sending: "Sending request"
        case .sent: "Request sent; waiting for the bus"
        case .received: "Request received by bus"
        case let .failed(message): "Request failed. \(message)"
        case .cancelled: "Request cancelled"
        case .active: "Assistance active"
        case .completed: "Assistance completed"
        }
    }

    var isInFlight: Bool {
        self == .sending || self == .sent
    }

    var retainsInlineCard: Bool {
        switch self {
        case .sending, .sent, .received, .active, .failed:
            true
        case .draft, .readyToSend, .cancelled, .completed:
            false
        }
    }
}

struct VehicleSubmissionReceipt: Codable, Equatable, Hashable, Sendable {
    let requestID: UUID
    let providerReference: String
    let submittedAt: Date
    /// Bookings ahead at acceptance, from a hub that keeps a waiting list; nil from any other hub.
    var queuePosition: Int? = nil
}

struct VehicleAcknowledgement: Codable, Equatable, Hashable, Sendable {
    let requestID: UUID
    let providerReference: String
    let busService: String
    let receivedAt: Date
}

struct AssistanceSession: Codable, Equatable, Hashable, Sendable {
    let request: AssistanceRequest
    var phase: AssistanceRequestPhase
    var receipt: VehicleSubmissionReceipt?
    var acknowledgement: VehicleAcknowledgement?
    var hubFeedback: HubFeedback? = nil
    var triggeredAt: Date? = nil
    var triggerObservedAt: Date? = nil
    var triggerROI: String? = nil
    var exitTriggeredAt: Date? = nil
    var busAtStop: Bool? = nil
    /// v0.5 hub journey for this booking. When present it drives the status screen instead of the triggers above.
    var journey: HubJourney? = nil
    var navigation: HubNavigation? = nil
}

struct AssistantInterpretation: Equatable, Hashable, Sendable {
    let passengerResponse: String
    let request: AssistanceRequest
}

struct JourneyStopCandidate: Equatable, Hashable, Sendable {
    let stopCode: String
    let stopName: String
    let roadName: String
    let services: [String]
}

struct JourneyAssistanceDraft: Equatable, Hashable, Sendable {
    let passengerResponse: String
    let busService: String
    let usesCurrentLocation: Bool
    let boardingStopCode: String?
    let boardingStopReference: String?
    let intent: TravelIntent
    let need: AccessibilityNeed
    let preferredInteraction: InteractionMode
    let assistanceRequested: [AssistanceAction]
    var rampPreference: RampPreference? = nil

    func request(for context: AssistanceContext) throws -> AssistanceRequest {
        try AssistanceRequest(
            context: context,
            intent: intent,
            need: need,
            preferredInteraction: preferredInteraction,
            assistanceRequested: assistanceRequested,
            rampPreference: rampPreference
        ).validated()
    }
}

struct JourneyConversation: Equatable, Sendable {
    private(set) var transcript = ""

    @discardableResult
    mutating func append(_ utterance: String) -> String {
        let cleaned = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return transcript }
        guard transcript != cleaned, !transcript.hasSuffix(cleaned) else { return transcript }
        if transcript.isEmpty {
            transcript = cleaned
        } else {
            transcript += "\nPassenger added: \(cleaned)"
        }
        return transcript
    }
}

enum AssistanceModelNormalization {
    static func interaction(
        _ interaction: InteractionMode,
        for need: AccessibilityNeed
    ) -> InteractionMode {
        need.automaticInteraction
    }

    static func actions(
        _ actions: [AssistanceAction],
        for need: AccessibilityNeed
    ) -> [AssistanceAction] {
        let allowed = Set(need.availableActions)
        let compatible = actions.reduce(into: [AssistanceAction]()) { result, action in
            guard allowed.contains(action), !result.contains(action) else { return }
            result.append(action)
        }
        if !compatible.isEmpty { return compatible }

        return switch need {
        case .wheelchair, .crutch, .cane, .walker, .stroller, .mobility, .none, .unknown: [.additionalBoardingTime]
        case .visualAccessibility: [.confirmBusArrivalIdentity]
        case .hearingAccessibility: [.visualBoardingConfirmation]
        }
    }
}

enum JourneyAssistanceResolutionError: Error, LocalizedError, Equatable, Sendable {
    case missingBusService
    case missingBoardingStop
    case currentLocationUnavailable
    case stopNotFound(String)
    case serviceNotAtStop(service: String, stop: String)
    case noUpcomingArrival(service: String, stop: String)
    case arrivalLookupFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingBusService:
            "I still need the bus service. Tap the microphone and say the bus number, for example, Bus 191."
        case .missingBoardingStop:
            "I still need your boarding stop. Say its name or code, or say that you are boarding at your current location."
        case .currentLocationUnavailable:
            "Your current location is not available. Say the boarding stop name or code, or enable Location in Settings."
        case let .stopNotFound(reference):
            "I could not find a bus stop matching \(reference). Try the five-digit stop code or a nearby landmark."
        case let .serviceNotAtStop(service, stop):
            "Bus \(service) is not listed at \(stop). Check the stop or bus number and try again."
        case let .noUpcomingArrival(service, stop):
            "Bus \(service) has no upcoming arrival shown at \(stop) right now. Try again or choose the bus on Map."
        case let .arrivalLookupFailed(message):
            "Live arrivals could not be checked: \(message) Try again or choose the bus on Map."
        }
    }
}

enum LocalAssistantAvailability: Equatable, Hashable, Sendable {
    case available
    case unsupportedSystem
    case deviceNotEligible
    case appleIntelligenceDisabled
    case modelNotReady

    var isAvailable: Bool { self == .available }

    var guidance: String {
        switch self {
        case .available:
            "On-device assistant ready"
        case .unsupportedSystem:
            "The voice assistant needs a system version that supports Apple Foundation Models."
        case .deviceNotEligible:
            "Apple Foundation Models are not available on this device."
        case .appleIntelligenceDisabled:
            "Turn on Apple Intelligence to use the on-device assistant."
        case .modelNotReady:
            "The on-device model is still preparing. Try again later."
        }
    }
}
