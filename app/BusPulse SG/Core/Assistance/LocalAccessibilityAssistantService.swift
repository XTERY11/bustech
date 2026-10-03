import Foundation
import Observation

#if canImport(FoundationModels)
import FoundationModels

@available(iOS 26.0, *)
@Generable(description: "A constrained accessibility request for one selected bus journey")
private struct FoundationModelAssistanceOutput {
    @Guide(description: "A concise, respectful response that says the request is prepared but never claims the bus has received it")
    var passengerResponse: String

    @Guide(description: "The passenger's immediate travel intent", .anyOf(["boarding", "alighting"]))
    var intent: String

    @Guide(
        description: "The assistance category best supported by the passenger's request",
        .anyOf(["wheelchair", "crutch", "cane", "walker", "stroller", "mobility", "visual_accessibility", "hearing_accessibility", "none", "unknown"])
    )
    var need: String

    @Guide(description: "REQUESTED only if the passenger asks for a ramp; DECLINED if they refuse one; otherwise UNSPECIFIED. A wheelchair alone is not consent.", .anyOf(["REQUESTED", "DECLINED", "UNSPECIFIED"]))
    var rampPreference: String

    @Guide(description: "How the passenger should receive information", .anyOf(["audio", "visual", "both"]))
    var preferredInteraction: String

    @Guide(
        description: "Only actions explicitly supported by the passenger's request",
        .minimumCount(1),
        .maximumCount(6),
        .element(.anyOf([
            "deploy_wheelchair_ramp",
            "additional_boarding_time",
            "confirm_bus_arrival_identity",
            "audio_boarding_instruction",
            "visual_boarding_confirmation",
            "visual_service_stop_information"
        ]))
    )
    var assistanceRequested: [String]
}

@available(iOS 26.0, *)
@Generable(description: "A journey and accessibility request expressed before a bus has been selected")
private struct FoundationModelJourneyAssistanceOutput {
    @Guide(description: "A concise respectful response saying the request is prepared for review; never claim it was sent or received")
    var passengerResponse: String

    @Guide(description: "The bus service number or code the passenger named; use an empty string if missing")
    var busService: String

    @Guide(description: "True only when the passenger explicitly wants to board near their current location")
    var usesCurrentLocation: Bool

    @Guide(description: "An exact five-digit stop code from the supplied nearby-stop list, or an explicitly spoken stop code; otherwise empty")
    var boardingStopCode: String

    @Guide(description: "The spoken stop name, road, landmark, or area when no exact stop code is known; otherwise empty")
    var boardingStopReference: String

    @Guide(description: "The passenger's immediate travel intent", .anyOf(["boarding", "alighting"]))
    var intent: String

    @Guide(
        description: "The assistance category best supported by the passenger's request",
        .anyOf(["wheelchair", "crutch", "cane", "walker", "stroller", "mobility", "visual_accessibility", "hearing_accessibility", "none", "unknown"])
    )
    var need: String

    @Guide(description: "REQUESTED only if the passenger asks for a ramp; DECLINED if they refuse one; otherwise UNSPECIFIED. A wheelchair alone is not consent.", .anyOf(["REQUESTED", "DECLINED", "UNSPECIFIED"]))
    var rampPreference: String

    @Guide(description: "How the passenger should receive information", .anyOf(["audio", "visual", "both"]))
    var preferredInteraction: String

    @Guide(
        description: "Only actions explicitly supported by the passenger's request",
        .minimumCount(1),
        .maximumCount(6),
        .element(.anyOf([
            "deploy_wheelchair_ramp",
            "additional_boarding_time",
            "confirm_bus_arrival_identity",
            "audio_boarding_instruction",
            "visual_boarding_confirmation",
            "visual_service_stop_information"
        ]))
    )
    var assistanceRequested: [String]
}
#endif

@MainActor
@Observable
final class LocalAccessibilityAssistantService {
    enum AssistantError: Error, LocalizedError, Equatable, Sendable {
        case unavailable(LocalAssistantAvailability)
        case generationFailed(String)

        var errorDescription: String? {
            switch self {
            case let .unavailable(availability):
                "\(availability.guidance) You can still select assistance manually."
            case .generationFailed:
                "The assistant could not understand that reliably. Try speaking again or select assistance manually."
            }
        }
    }

    private struct Payload: Sendable {
        let passengerResponse: String
        let intent: String
        let need: String
        let preferredInteraction: String
        let assistanceRequested: [String]
        var rampPreference: String = "UNSPECIFIED"
    }

    private struct JourneyPayload: Sendable {
        let passengerResponse: String
        let busService: String
        let usesCurrentLocation: Bool
        let boardingStopCode: String
        let boardingStopReference: String
        let intent: String
        let need: String
        let preferredInteraction: String
        let assistanceRequested: [String]
        var rampPreference: String = "UNSPECIFIED"
    }

    private let usesDeterministicUITestResponse: Bool

    init(usesDeterministicUITestResponse: Bool = false) {
        self.usesDeterministicUITestResponse = usesDeterministicUITestResponse
    }

    var availability: LocalAssistantAvailability {
        if usesDeterministicUITestResponse { return .available }
#if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return .available
            case let .unavailable(reason):
                switch reason {
                case .deviceNotEligible: return .deviceNotEligible
                case .appleIntelligenceNotEnabled: return .appleIntelligenceDisabled
                case .modelNotReady: return .modelNotReady
                @unknown default: return .modelNotReady
                }
            }
        }
#endif
        return .unsupportedSystem
    }

    func interpret(
        transcript: String,
        context: AssistanceContext
    ) async throws -> AssistantInterpretation {
        let cleanedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedTranscript.isEmpty else {
            throw AssistantError.generationFailed("No speech detected")
        }

        if usesDeterministicUITestResponse {
            return try interpretation(
                from: Payload(
                    passengerResponse: "Of course. I've prepared a request for Bus \(context.busService) to identify itself, provide audio boarding guidance, and allow extra time to board.",
                    intent: TravelIntent.boarding.rawValue,
                    need: AccessibilityNeed.visualAccessibility.rawValue,
                    preferredInteraction: InteractionMode.audio.rawValue,
                    assistanceRequested: [
                        AssistanceAction.confirmBusArrivalIdentity.rawValue,
                        AssistanceAction.audioBoardingInstruction.rawValue,
                        AssistanceAction.additionalBoardingTime.rawValue
                    ]
                ),
                context: context
            )
        }

        let currentAvailability = availability
        guard currentAvailability.isAvailable else {
            throw AssistantError.unavailable(currentAvailability)
        }

#if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            do {
                let session = LanguageModelSession(instructions: Self.instructions)
                let response = try await session.respond(
                    to: Self.prompt(transcript: cleanedTranscript, context: context),
                    generating: FoundationModelAssistanceOutput.self
                )
                let output = response.content
                return try interpretation(
                    from: Payload(
                        passengerResponse: output.passengerResponse,
                        intent: output.intent,
                        need: output.need,
                        preferredInteraction: output.preferredInteraction,
                        assistanceRequested: output.assistanceRequested,
                    rampPreference: output.rampPreference
                    ),
                    context: context
                )
            } catch let error as AssistanceValidationError {
                throw error
            } catch {
                throw AssistantError.generationFailed(error.localizedDescription)
            }
        }
#endif
        throw AssistantError.unavailable(.unsupportedSystem)
    }

    func interpretJourney(
        transcript: String,
        nearbyStops: [JourneyStopCandidate],
        currentLocationIsAvailable: Bool
    ) async throws -> JourneyAssistanceDraft {
        let cleanedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedTranscript.isEmpty else {
            throw AssistantError.generationFailed("No speech detected")
        }

        if usesDeterministicUITestResponse {
            return try journeyDraft(from: JourneyPayload(
                passengerResponse: "Of course. I've prepared a request to identify the bus, provide audio boarding guidance, and allow extra time to board.",
                busService: "191",
                usesCurrentLocation: false,
                boardingStopCode: nearbyStops.first(where: { $0.stopCode == "01012" })?.stopCode ?? "01012",
                boardingStopReference: "Hotel Grand Pacific",
                intent: TravelIntent.boarding.rawValue,
                need: AccessibilityNeed.visualAccessibility.rawValue,
                preferredInteraction: InteractionMode.audio.rawValue,
                assistanceRequested: [
                    AssistanceAction.confirmBusArrivalIdentity.rawValue,
                    AssistanceAction.audioBoardingInstruction.rawValue,
                    AssistanceAction.additionalBoardingTime.rawValue
                ]
            ))
        }

        let currentAvailability = availability
        guard currentAvailability.isAvailable else {
            throw AssistantError.unavailable(currentAvailability)
        }

#if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            do {
                let session = LanguageModelSession(instructions: Self.journeyInstructions)
                let response = try await session.respond(
                    to: Self.journeyPrompt(
                        transcript: cleanedTranscript,
                        nearbyStops: nearbyStops,
                        currentLocationIsAvailable: currentLocationIsAvailable
                    ),
                    generating: FoundationModelJourneyAssistanceOutput.self
                )
                let output = response.content
                let payload = JourneyPayload(
                    passengerResponse: output.passengerResponse,
                    busService: output.busService,
                    usesCurrentLocation: output.usesCurrentLocation,
                    boardingStopCode: output.boardingStopCode,
                    boardingStopReference: output.boardingStopReference,
                    intent: output.intent,
                    need: output.need,
                    preferredInteraction: output.preferredInteraction,
                    assistanceRequested: output.assistanceRequested,
                    rampPreference: output.rampPreference
                )
                return try journeyDraft(from: payload)
            } catch let error as AssistanceValidationError {
                throw error
            } catch {
                throw AssistantError.generationFailed(error.localizedDescription)
            }
        }
#endif
        throw AssistantError.unavailable(.unsupportedSystem)
    }

    private func interpretation(
        from payload: Payload,
        context: AssistanceContext
    ) throws -> AssistantInterpretation {
        guard let intent = TravelIntent(rawValue: payload.intent),
              let need = AccessibilityNeed(rawValue: payload.need),
              let interaction = InteractionMode(rawValue: payload.preferredInteraction) else {
            throw AssistanceValidationError.malformedModelOutput
        }

        let parsedActions = payload.assistanceRequested.compactMap(AssistanceAction.init(rawValue:))
        guard parsedActions.count == payload.assistanceRequested.count else {
            throw AssistanceValidationError.malformedModelOutput
        }
        let actions = AssistanceModelNormalization.actions(parsedActions, for: need)
            .filter { payload.rampPreference == "REQUESTED" || $0 != .deployWheelchairRamp }
        let normalizedInteraction = AssistanceModelNormalization.interaction(interaction, for: need)
        let request = try AssistanceRequest(
            context: context,
            intent: intent,
            need: need,
            preferredInteraction: normalizedInteraction,
            assistanceRequested: actions,
            rampPreference: RampPreference(rawValue: payload.rampPreference) ?? .unspecified
        ).validated()

        let cleanedResponse = payload.passengerResponse.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedResponse.isEmpty else {
            throw AssistanceValidationError.malformedModelOutput
        }
        let passengerResponse = Self.isPreAcknowledgementSafe(cleanedResponse)
            ? cleanedResponse
            : Self.safePreparedResponse(for: request)
        return AssistantInterpretation(passengerResponse: passengerResponse, request: request)
    }

    private func journeyDraft(from payload: JourneyPayload) throws -> JourneyAssistanceDraft {
        guard let intent = TravelIntent(rawValue: payload.intent),
              let need = AccessibilityNeed(rawValue: payload.need),
              let interaction = InteractionMode(rawValue: payload.preferredInteraction) else {
            throw AssistanceValidationError.malformedModelOutput
        }
        let parsedActions = payload.assistanceRequested.compactMap(AssistanceAction.init(rawValue:))
        guard parsedActions.count == payload.assistanceRequested.count else {
            throw AssistanceValidationError.malformedModelOutput
        }
        let actions = AssistanceModelNormalization.actions(parsedActions, for: need)
            .filter { payload.rampPreference == "REQUESTED" || $0 != .deployWheelchairRamp }
        let normalizedInteraction = AssistanceModelNormalization.interaction(interaction, for: need)

        let cleanedResponse = payload.passengerResponse.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedResponse.isEmpty else {
            throw AssistanceValidationError.malformedModelOutput
        }
        let safeResponse = Self.isPreAcknowledgementSafe(cleanedResponse)
            ? cleanedResponse
            : "Of course. I've prepared your assistance request for review."

        return JourneyAssistanceDraft(
            passengerResponse: safeResponse,
            busService: payload.busService.trimmingCharacters(in: .whitespacesAndNewlines),
            usesCurrentLocation: payload.usesCurrentLocation,
            boardingStopCode: Self.optionalText(payload.boardingStopCode),
            boardingStopReference: Self.optionalText(payload.boardingStopReference),
            intent: intent,
            need: need,
            preferredInteraction: normalizedInteraction,
            assistanceRequested: actions,
            rampPreference: RampPreference(rawValue: payload.rampPreference) ?? .unspecified
        )
    }

    static func isPreAcknowledgementSafe(_ response: String) -> Bool {
        let value = response
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
        let describesPreparation = value.contains("prepared")
            || value.contains("ready for you to review")
        let acknowledgementTerms = [
            "received",
            "sent",
            "confirmed",
            "acknowledged",
            "accepted",
            "submitted",
            "delivered",
            "forwarded",
            "notified",
            "contacted",
            "bus is aware",
            "bus knows",
            "driver knows"
        ]
        return describesPreparation && !acknowledgementTerms.contains(where: value.contains)
    }

    private static func safePreparedResponse(for request: AssistanceRequest) -> String {
        let actions = request.assistanceRequested.map { $0.title.lowercased() }
        let actionText = ListFormatter.localizedString(byJoining: actions)
        return "Of course. I've prepared a request for \(actionText). Please review it before sending."
    }

    private static let instructions = """
    You are BusPulse SG's on-device Accessibility Request Assistant. Your only task is to understand
    the assistance needed for the selected upcoming bus and produce the requested structured fields.
    Be concise, reassuring, respectful, and adult-to-adult. Do not diagnose or infantilise the passenger.
    Never claim that a request was sent, received, acknowledged, or accepted. At this stage it is only
    prepared for the passenger to review. Select only actions supported by the passenger's words.
    Distinguish wheelchair, crutch, cane, walker and stroller when explicitly stated.
    A wheelchair alone does not request a ramp. Never infer ramp consent from an aid.
    Only include deploy_wheelchair_ramp when explicitly requested. Respect an explicit ramp refusal.
    """

    private static let journeyInstructions = """
    You are BusPulse SG's on-device Accessibility Request Assistant. Understand both the passenger's
    boarding journey and the concrete assistance the bus should provide. Do not invent a bus service,
    stop, arrival, or location. Distinguish wheelchair, crutch, cane, walker and stroller when stated.
    Never infer ramp consent from a mobility aid. Use DECLINED for an explicit ramp refusal and
    include deploy_wheelchair_ramp only when explicitly requested. Use an empty field when the passenger did not provide enough journey
    information. A nearby stop code may be selected only when the passenger explicitly refers to their
    current location and current location is available. Be concise, reassuring, respectful, and
    adult-to-adult. Never claim a request was sent, received, acknowledged, or accepted. It is only
    prepared for the passenger to review. Select only assistance actions supported by their words.
    For a visually impaired passenger, use visual_accessibility with audio interaction; use
    confirm_bus_arrival_identity and audio_boarding_instruction as applicable. Never use
    visual_boarding_confirmation for a visually impaired passenger: that visual cue belongs to
    hearing_accessibility. When location is available and the passenger says they are waiting for a
    named bus without naming another boarding place, treat their current location as the boarding place.
    """

    private static func prompt(transcript: String, context: AssistanceContext) -> String {
        """
        Current stop: \(context.stopName) (\(context.stopCode)), \(context.roadName)
        Selected service: \(context.busService)
        Selected upcoming bus: arrival slot \(context.arrivalSlot + 1)
        Estimated arrival: \(context.etaDescription())

        Passenger said:
        \(transcript)

        Understand the assistance needed for this journey. Use the fixed structured schema. The
        passenger-facing response may say the request is prepared, but it must not imply vehicle ACK.
        """
    }

    private static func journeyPrompt(
        transcript: String,
        nearbyStops: [JourneyStopCandidate],
        currentLocationIsAvailable: Bool
    ) -> String {
        let stopLines = nearbyStops.map { stop in
            let services = stop.services.isEmpty ? "services unavailable" : stop.services.joined(separator: ", ")
            return "- \(stop.stopCode): \(stop.stopName), \(stop.roadName); services: \(services)"
        }.joined(separator: "\n")
        return """
        Current device location available: \(currentLocationIsAvailable ? "yes" : "no")
        Nearby stops, closest first:
        \(stopLines.isEmpty ? "- none available" : stopLines)

        Passenger said:
        \(transcript)

        Extract the journey and assistance into the fixed schema. If the passenger says "here", "near
        me", or "my current location" and device location is available, select the closest supplied stop
        that serves the named bus. Otherwise retain their stop words in boardingStopReference. Do not
        infer a bus number that was not spoken. The response may say a request is prepared for review,
        but must not imply vehicle acknowledgement.
        """
    }

    private static func optionalText(_ value: String) -> String? {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}
