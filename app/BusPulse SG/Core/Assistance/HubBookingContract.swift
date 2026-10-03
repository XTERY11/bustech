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
        /// Cancellation only: the event id of the booking to cancel. Omitted from bookings; an older hub
        /// accepts and drops it (its request schema allows extra properties and projects them away).
        var cancels: String? = nil
    }

    init(request: AssistanceRequest, active: Bool = true, observedAt: Date = .now, eventID: String? = nil,
         cancels: String? = nil) {
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
            language: request.language,
            cancels: active ? nil : cancels
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

enum HubJourneyStage: String, Codable, Hashable, Sendable {
    case idle = "IDLE"
    case booked = "BOOKED"
    case atStop = "AT_STOP"
    case onBoard = "ON_BOARD"
}

struct HubBoardingTarget: Codable, Hashable, Sendable {
    let type: String?
    let id: String?

    var isWheelchairBay: Bool { type == "WHEELCHAIR_BAY" }

    /// "Wheelchair bay" or "Seat S03", as the dashboard labels the assigned place; nil for a bus stop.
    var title: String? {
        if isWheelchairBay { return "Wheelchair bay" }
        guard type == "SEAT", let id, !id.isEmpty else { return nil }
        return "Seat \(id)"
    }
}

/// The hub's single passenger journey (dashboard/backend/journey.mjs). Every field is optional so
/// an older or newer hub still decodes; `guidance` is the exact English text the dashboard shows.
struct HubJourney: Codable, Hashable, Sendable {
    var journey_id: String? = nil
    var revision: Int? = nil
    var stage: String? = nil
    var matched: Bool? = nil
    var pending_exit: Bool? = nil
    var completed: Bool? = nil
    var reason: String? = nil
    var need: String? = nil
    var labels: [String]? = nil
    var seat: String? = nil
    var boarding_target: HubBoardingTarget? = nil
    var animation: Animation? = nil
    var guidance: Guidance? = nil
    /// `journeys[]` entries only (waiting list): waiting for an earlier passenger, and how many bookings are ahead.
    var queued: Bool? = nil
    var position: Int? = nil
    var plan_status: String? = nil

    struct Animation: Codable, Hashable, Sendable {
        let id: String?
        let phase: String?
        let aid: String?
        let started_at: Double?
        let duration_ms: Double?
    }

    struct Guidance: Codable, Hashable, Sendable {
        let title: String?
        let display_text: String?
        let audio_text: String?
    }

    var journeyStage: HubJourneyStage? { stage.flatMap(HubJourneyStage.init(rawValue:)) }
    var isMatched: Bool { matched == true }
    var isCompleted: Bool { completed == true }
    /// Another passenger is being served first; the shared twin is not this passenger's bus yet.
    var isQueued: Bool { queued == true || (position ?? 0) > 0 }
    /// Bookings ahead of this one in the hub's waiting list, when there are any.
    var bookingsAhead: Int? { position.flatMap { $0 > 0 ? $0 : nil } }
    /// Supplement to the hub's guidance for a waiting passenger; nil when not waiting.
    var queueText: String? {
        // no_place: nobody is ahead, the bus is full; the hub's guidance says what happens next.
        guard isQueued, reason != "no_place" else { return nil }
        guard let ahead = bookingsAhead else { return "You are next." }
        return ahead == 1 ? "1 passenger ahead of you" : "\(ahead) passengers ahead of you"
    }
    /// The hub holds this passenger at the stop: another passenger is boarding, or no accessible place is left.
    var isHeldAtStop: Bool { reason == "waiting_turn" || reason == "no_place" }

    var guidanceTitle: String? { guidance?.title?.nonEmptyTrimmed }
    var guidanceText: String? { guidance?.display_text?.nonEmptyTrimmed ?? guidance?.audio_text?.nonEmptyTrimmed }
    var spokenText: String? { guidance?.audio_text?.nonEmptyTrimmed ?? guidance?.display_text?.nonEmptyTrimmed }

    /// What the passenger is currently told. The arrival guidance ("Bus arriving" → "Preparing to board"
    /// → "Ready to board") changes on hub timers without a new revision, and a new revision can repeat
    /// the same words, so announcements compare this rather than the revision alone.
    var announcementKey: String {
        "\(journey_id ?? "")|\(stage ?? "")|\(guidanceTitle ?? "")|\(guidanceText ?? "")"
    }

    /// Hub-side outcome for the booking that `eventID` identifies. The journey replaces the
    /// App's own trigger latching, vehicle telemetry check and local freshness window.
    func feedback(eventID: String, source: String, running: String?, result: HubResult?) -> HubFeedback {
        guard source == "external", journey_id == eventID else { return .replaced }
        switch journeyStage {
        case .idle?:
            switch reason {
            case "expired": return .expired
            case "cancelled": return .cancelled
            // The passenger boarded and the journey was closed (the finish button, or the operator's reset).
            case "completed": return .finished
            default: return .replaced
            }
        case .booked?, .atStop?, .onBoard?, nil:
            if !isCompleted, running != nil { return .planning }
            guard let result else { return .waiting }
            return .result(result)
        }
    }
}

/// One booking in the hub's waiting list with that booking's own navigation (null while it waits).
struct HubJourneyEntry: Hashable, Sendable {
    let journey: HubJourney
    let navigation: HubNavigation?

    /// Never throws, so one odd entry cannot hide the others. An entry whose optional fields do not
    /// decode keeps its id and stage, so this booking is not mistaken for one the hub dropped.
    struct Lossy: Decodable {
        let entry: HubJourneyEntry?

        private enum CodingKeys: String, CodingKey { case journey_id, stage, navigation }

        init(from decoder: any Decoder) throws {
            guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
                entry = nil
                return
            }
            let navigation = try? container.decodeIfPresent(HubNavigation.self, forKey: .navigation)
            if let journey = try? HubJourney(from: decoder), journey.journey_id != nil {
                entry = HubJourneyEntry(journey: journey, navigation: navigation)
            } else if let id = try? container.decodeIfPresent(String.self, forKey: .journey_id) {
                let stage = try? container.decodeIfPresent(String.self, forKey: .stage)
                entry = HubJourneyEntry(journey: HubJourney(journey_id: id, stage: stage), navigation: navigation)
            } else {
                entry = nil
            }
        }
    }
}

struct HubNavigation: Codable, Hashable, Sendable {
    var phase: String? = nil
    var destination: HubBoardingTarget? = nil
    var instruction: String? = nil
    var steps: [Step]? = nil
    var cabin_route: CabinRoute? = nil

    struct Step: Codable, Hashable, Sendable {
        let step: Int?
        let maneuver: String?
        let distance_m: Double?
        let text: String?
    }

    struct CabinRoute: Codable, Hashable, Sendable {
        let steps: [Step]?
    }

    /// Steps that carry text, in hub order.
    var visibleSteps: [Step] { (steps ?? []).filter { $0.text?.nonEmptyTrimmed != nil } }
}

extension String {
    var nonEmptyTrimmed: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

struct HubSnapshot: Decodable, Sendable {
    let source: String
    let channels: [String: Channel]
    let running: String?
    let result: HubResult?
    let context: Context
    /// v0.5+: absent on older hubs and null for dashboard demo presets.
    let journey: HubJourney?
    let navigation: HubNavigation?
    /// Waiting-list hubs: one entry per known booking, oldest first (waiting, in progress, recently finished).
    /// nil on hubs that keep a single journey; then `journey` alone decides.
    let journeys: [HubJourneyEntry]?

    private enum CodingKeys: String, CodingKey {
        case source, channels, running, result, context, journey, navigation, journeys
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        channels = try container.decode([String: Channel].self, forKey: .channels)
        running = try container.decodeIfPresent(String.self, forKey: .running)
        result = try container.decodeIfPresent(HubResult.self, forKey: .result)
        context = try container.decode(Context.self, forKey: .context)
        // A malformed journey must not break the legacy fields; fall back to the older path instead.
        journey = try? container.decodeIfPresent(HubJourney.self, forKey: .journey)
        navigation = try? container.decodeIfPresent(HubNavigation.self, forKey: .navigation)
        journeys = (try? container.decodeIfPresent([HubJourneyEntry.Lossy].self, forKey: .journeys))?
            .flatMap { $0.compactMap(\.entry) }
    }

    /// True when the hub publishes its waiting list; this booking is then looked up there only.
    var listsJourneys: Bool { journeys != nil }

    /// This booking's entry in the waiting list (or, on a single-journey hub, the journey when it is
    /// this booking's); nil for another booking, an older hub, or a booking the hub no longer lists.
    func ownEntry(eventID: String) -> HubJourneyEntry? {
        guard source == "external" else { return nil }
        if let journeys { return journeys.first { $0.journey.journey_id == eventID } }
        guard let journey, journey.journey_id == eventID else { return nil }
        return HubJourneyEntry(journey: journey, navigation: navigation)
    }

    func ownJourney(eventID: String) -> HubJourney? { ownEntry(eventID: eventID)?.journey }

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
        if journeys != nil {
            // The hub lists every booking it still knows; one it no longer lists has ended there.
            guard source == "external", let own = ownJourney(eventID: eventID) else {
                return source == "external" ? .expired : .replaced
            }
            // `running` and `result` describe the journey in progress, which may be another passenger's.
            let inProgress = journey?.journey_id == eventID && !own.isQueued
            return own.feedback(eventID: eventID, source: source,
                                running: inProgress ? running : nil, result: inProgress ? result : nil)
        }
        if let journey {
            return journey.feedback(eventID: eventID, source: source, running: running, result: result)
        }
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
    /// Normal end after boarding: never shown as cancelled or expired.
    case finished
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
        case .finished: "Journey finished"
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
        case .finished: "This passenger is on board and the journey is complete. You can book assistance for the next passenger."
        case let .unavailable(message): message
        case let .result(result):
            result.passenger_communication.display_text
                ?? result.passenger_communication.audio_text
                ?? "The hub has not provided a passenger message."
        }
    }

    var isTerminal: Bool { self == .expired || self == .replaced || self == .cancelled || self == .finished }
}
