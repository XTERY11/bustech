import CoreLocation
import Foundation
import Observation

@MainActor
@Observable
final class AssistanceJourneyResolver {
    private let dataStore: TransitDataStore

    init(dataStore: TransitDataStore) {
        self.dataStore = dataStore
    }

    func nearbyCandidates(
        to coordinate: CLLocationCoordinate2D,
        limit: Int = 8
    ) async -> [JourneyStopCandidate] {
        let stops = await dataStore.nearest(to: coordinate, limit: limit)
        return stops.map { stop in
            JourneyStopCandidate(
                stopCode: stop.code,
                stopName: stop.displayName,
                roadName: stop.roadName,
                services: services(at: stop.code)
            )
        }
    }

    func resolve(
        _ draft: JourneyAssistanceDraft,
        coordinate: CLLocationCoordinate2D?
    ) async throws -> AssistantInterpretation {
        let service = Self.normalizedService(draft.busService)
        guard !service.isEmpty else {
            throw JourneyAssistanceResolutionError.missingBusService
        }

        let stop = try await resolveStop(
            for: draft,
            service: service,
            coordinate: coordinate
        )
        guard services(at: stop.code).contains(service) else {
            throw JourneyAssistanceResolutionError.serviceNotAtStop(
                service: service,
                stop: stop.displayName
            )
        }

        let board: ArrivalBoard
        do {
            board = try await dataStore.arrivals(for: stop.code)
        } catch {
            throw JourneyAssistanceResolutionError.arrivalLookupFailed(error.localizedDescription)
        }

        guard let arrivals = board.services.first(where: {
            Self.normalizedService($0.serviceNo) == service
        }), let estimate = arrivals.estimates.first else {
            throw JourneyAssistanceResolutionError.noUpcomingArrival(
                service: service,
                stop: stop.displayName
            )
        }

        let context = AssistanceContext(stop: stop, service: arrivals, estimate: estimate)
        let request = try draft.request(for: context)
        return AssistantInterpretation(
            passengerResponse: Self.resolvedResponse(
                draft.passengerResponse,
                context: context
            ),
            request: request
        )
    }

    private func resolveStop(
        for draft: JourneyAssistanceDraft,
        service: String,
        coordinate: CLLocationCoordinate2D?
    ) async throws -> BusStop {
        if let code = draft.boardingStopCode,
           let stop = dataStore.stop(code: Self.normalizedStopCode(code)) {
            return stop
        }

        if draft.usesCurrentLocation {
            guard let coordinate else {
                throw JourneyAssistanceResolutionError.currentLocationUnavailable
            }
            let nearest = await dataStore.nearest(to: coordinate, limit: 12)
            if let stop = nearest.first(where: { services(at: $0.code).contains(service) }) {
                return stop
            }
            throw JourneyAssistanceResolutionError.stopNotFound("your current location")
        }

        guard let reference = draft.boardingStopReference?.trimmingCharacters(in: .whitespacesAndNewlines),
              !reference.isEmpty else {
            throw JourneyAssistanceResolutionError.missingBoardingStop
        }
        let results = await dataStore.search(reference)
        guard let stop = results.first else {
            throw JourneyAssistanceResolutionError.stopNotFound(reference)
        }
        if let matching = results.first(where: { services(at: $0.code).contains(service) }) {
            return matching
        }
        return stop
    }

    private func services(at stopCode: String) -> [String] {
        Array(Set(dataStore.routes(at: stopCode).map { Self.normalizedService($0.serviceNo) }))
    }

    private static func normalizedService(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .uppercased()
    }

    private static func normalizedStopCode(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func resolvedResponse(
        _ modelResponse: String,
        context: AssistanceContext
    ) -> String {
        let cleaned = modelResponse.trimmingCharacters(in: .whitespacesAndNewlines)
        let prepared = LocalAccessibilityAssistantService.isPreAcknowledgementSafe(cleaned)
            ? cleaned
            : "I've prepared your assistance request for review."
        return "I found Bus \(context.busService) at \(context.stopName), arriving \(context.etaDescription()). \(prepared)"
    }
}
