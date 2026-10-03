import Foundation

enum RampPreference: String, Codable, CaseIterable, Sendable {
    case requested = "REQUESTED"
    case declined = "DECLINED"
    case unspecified = "UNSPECIFIED"

    var title: String {
        switch self {
        case .requested: "Request ramp"
        case .declined: "No ramp"
        case .unspecified: "Ask me first"
        }
    }
}

enum PassengerLanguage: String, Codable, CaseIterable, Sendable {
    case english = "en-SG"
    case chinese = "zh-CN"
    var title: String { self == .english ? "English" : "Chinese" }
}

/// BusTech PROMPT.md v0.3, section 2.4. No transcript, names or vehicle commands.
struct HubBookingEnvelope: Codable, Equatable, Sendable {
    let event_id: String
    let observed_at: String
    let payload: Payload

    struct Payload: Codable, Equatable, Sendable {
        let active: Bool
        let intent: String
        let route_id: String
        let stop_id: String
        let accessibility_need: String
        let ramp_preference: RampPreference
        let assistance_requested: [String]
        let preferred_interaction: String
        let language: PassengerLanguage
    }

    init(request: AssistanceRequest, active: Bool = true, observedAt: Date = .now, eventID: String? = nil) {
        event_id = eventID ?? "app-booking-\(request.id.uuidString)"
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        observed_at = formatter.string(from: observedAt)
        payload = Payload(
            active: active,
            intent: request.intent.rawValue.uppercased(),
            route_id: request.busService,
            stop_id: request.context.stopCode,
            accessibility_need: request.need.hubValue,
            ramp_preference: request.rampPreference,
            assistance_requested: request.assistanceRequested.reduce(into: []) { values, action in
                if !values.contains(action.hubValue) { values.append(action.hubValue) }
            },
            preferred_interaction: request.preferredInteraction.rawValue.uppercased(),
            language: request.language
        )
    }

    static func isValidID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_.:-]{1,80}$", options: .regularExpression) != nil
    }
}

extension AccessibilityNeed {
    var hubValue: String {
        switch self {
        case .visualAccessibility: "VISUAL_ASSISTANCE"
        case .hearingAccessibility: "HEARING_ASSISTANCE"
        case .mobility: "MOBILITY_ASSISTANCE"
        default: rawValue.uppercased()
        }
    }
}

extension AssistanceAction {
    var hubValue: String {
        switch self {
        case .deployWheelchairRamp: "WHEELCHAIR_RAMP"
        case .additionalBoardingTime: "ADDITIONAL_BOARDING_TIME"
        case .confirmBusArrivalIdentity: "CONFIRM_BUS_IDENTITY"
        case .audioBoardingInstruction: "AUDIO_BOARDING_GUIDANCE"
        case .visualBoardingConfirmation, .visualServiceStopInformation: "VISUAL_BOARDING_GUIDANCE"
        }
    }
}

enum HubPlanStatus: String, Codable, Sendable {
    case ready = "READY"
    case needsConfirmation = "NEEDS_CONFIRMATION"
    case cannotExecute = "CANNOT_EXECUTE"

    var title: String {
        switch self {
        case .ready: "Assistance plan ready"
        case .needsConfirmation: "Safety operator confirmation needed"
        case .cannotExecute: "Assistance cannot proceed"
        }
    }
}

struct HubResult: Codable, Hashable, Sendable {
    let request_id: String
    let plan_status: HubPlanStatus
    let simulated: Bool
    let execution_authorized: Bool
    let passenger_communication: Communication

    var passengerMessage: String? {
        [passenger_communication.display_text, passenger_communication.audio_text]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    struct Communication: Codable, Hashable, Sendable {
        let channel: String
        let language: String
        let audio_text: String?
        let display_text: String?
    }
}

struct HubSnapshot: Decodable, Sendable {
    let source: String
    let channels: [String: Channel]
    let running: String?
    let result: HubResult?
    let context: Context

    struct Channel: Decodable, Sendable {
        let event_id: String
        let observed_at: Double
    }

    struct Context: Decodable, Sendable {
        let request: Booking?
        var perception: Perception? = nil
        var vehicle_context: VehicleContext? = nil
    }

    struct VehicleContext: Decodable, Sendable {
        let route_id: String?
        let stop_id: String?
        let motion_state: String?
        let parking_brake_engaged: Bool?
        let observation_age_ms: Double?
    }

    /// This describes arrival only, never permission to board or execute a plan.
    func busIsAtStop(for request: AssistanceRequest, eventID: String, now: Date = .now) -> Bool {
        guard !feedback(for: request, eventID: eventID, now: now).isTerminal,
              let vehicle = context.vehicle_context,
              vehicle.route_id == request.busService,
              vehicle.stop_id == request.context.stopCode,
              vehicle.motion_state == "STOPPED", vehicle.parking_brake_engaged == true,
              let age = vehicle.observation_age_ms, age.isFinite, (0...1500).contains(age) else { return false }
        return true
    }

    struct Perception: Decodable, Sendable {
        let zone: Zone?
        struct Zone: Decodable, Sendable {
            let triggered: Bool?
            let event: String?
            let roi_id: String?
        }
    }

    struct Booking: Decodable, Sendable {
        let active: Bool?
        let route_id: String?
        let stop_id: String?
    }

    func hasTrigger(for request: AssistanceRequest, receipt: VehicleSubmissionReceipt, now: Date = .now) -> Bool {
        context.perception?.zone?.triggered == true
            && hasCurrentPerception(for: request, receipt: receipt, now: now)
    }

    var perceptionObservedAt: Date? {
        channels["perception"].map { Date(timeIntervalSince1970: $0.observed_at / 1000) }
    }

    func hasExitTrigger(for request: AssistanceRequest, receipt: VehicleSubmissionReceipt,
                        enteredAt: Date, roiID: String?, now: Date = .now) -> Bool {
        guard context.perception?.zone?.event == "exit",
              context.perception?.zone?.triggered == false,
              let roiID, !roiID.isEmpty, context.perception?.zone?.roi_id == roiID,
              let observed = perceptionObservedAt, observed >= enteredAt else { return false }
        return hasCurrentPerception(for: request, receipt: receipt, now: now)
    }

    private func hasCurrentPerception(for request: AssistanceRequest, receipt: VehicleSubmissionReceipt,
                                      now: Date) -> Bool {
        guard source == "external", context.request?.active == true,
              channels["booking"]?.event_id == receipt.providerReference,
              context.request?.route_id == request.busService,
              context.request?.stop_id == request.context.stopCode,
              let observed = channels["perception"]?.observed_at else { return false }
        let date = Date(timeIntervalSince1970: observed / 1000)
        return date >= receipt.submittedAt && date <= now.addingTimeInterval(5)
            && now.timeIntervalSince(date) <= 10
    }

    func feedback(for request: AssistanceRequest, eventID: String, now: Date = .now) -> HubFeedback {
        guard source == "external", channels["booking"]?.event_id == eventID,
              context.request?.route_id == request.busService,
              context.request?.stop_id == request.context.stopCode else { return .replaced }
        guard context.request?.active == true else { return .cancelled }
        guard let channel = channels["booking"],
              now.timeIntervalSince1970 * 1000 - channel.observed_at < 300_000 else { return .expired }
        if running != nil { return .planning }
        guard let result else { return .waiting }
        return .result(result)
    }
}

enum HubFeedback: Codable, Hashable, Sendable {
    case waiting, planning, cancelling, expired, replaced, cancelled
    case result(HubResult)
    case unavailable(String)

    var result: HubResult? {
        if case let .result(value) = self { return value }
        return nil
    }

    var title: String {
        switch self {
        case .waiting: "Request received by bus"
        case .planning: "Preparing assistance plan"
        case .cancelling: "Cancelling booking"
        case .expired: "Booking expired"
        case .replaced: "Booking is no longer current"
        case .cancelled: "Booking cancelled"
        case let .result(result): result.plan_status.title
        case .unavailable: "Feedback unavailable"
        }
    }

    var message: String {
        switch self {
        case .waiting: "Waiting for a response to your request."
        case .planning: "The hub is checking the current inputs. Please wait for updated guidance."
        case .cancelling: "Waiting for the hub to accept the cancellation."
        case .expired: "Bookings last five minutes. Submit a new booking to continue."
        case .replaced: "The demo keeps one booking. Another booking or scenario has replaced this one."
        case .cancelled: "This booking is no longer active."
        case let .unavailable(message): message
        case let .result(result):
            result.passenger_communication.display_text
                ?? result.passenger_communication.audio_text
                ?? "The hub has not provided a passenger message."
        }
    }

    var isTerminal: Bool { self == .expired || self == .replaced || self == .cancelled }
}
