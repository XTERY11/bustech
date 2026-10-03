import Foundation
import Observation

@MainActor
@Observable
final class AppContainer {
    let dataStore: TransitDataStore
    let preferences: PreferencesStore
    let location: LocationService
    let routeGeometry: RouteGeometryService
    let assistanceRequests: AssistanceRequestService
    let assistanceJourneyResolver: AssistanceJourneyResolver
    let speechRecognition: SpeechRecognitionService
    let localAccessibilityAssistant: LocalAccessibilityAssistantService
    let passengerFeedback: PassengerFeedbackService

    init(configuration: AppConfiguration = .current()) {
        let provider: any TransitDataProviding
        if let accountKey = configuration.accountKey {
            provider = LiveTransitProvider(accountKey: accountKey)
        } else {
            provider = MockTransitProvider()
        }

        let transitDataStore = TransitDataStore(provider: provider)
        dataStore = transitDataStore
        let preferencesStore = PreferencesStore(
            resetBeforeLoading: configuration.isUITesting
                && ProcessInfo.processInfo.arguments.contains("-reset-preferences")
        )
        preferences = preferencesStore
        location = LocationService(disablesPermissionRequest: configuration.isUITesting)
        routeGeometry = RouteGeometryService(isUITesting: configuration.isUITesting)

        let assistanceFailure: MockVehicleCloudService.FailureStage? = ProcessInfo.processInfo.arguments
            .contains("-assistance-send-failure") ? .submission : nil
        let vehicleCloud = MockVehicleCloudService(configuration: .init(
            failureStage: assistanceFailure
        ))
        assistanceRequests = AssistanceRequestService(vehicleCloudProvider: {
            if let endpoint = try preferencesStore.assistanceReceiverEndpoint() {
                return HTTPVehicleCloudService(endpoint: endpoint, token: preferencesStore.bridgeToken)
            }
            return vehicleCloud
        })
        assistanceJourneyResolver = AssistanceJourneyResolver(dataStore: transitDataStore)
        speechRecognition = SpeechRecognitionService(
            usesDeterministicUITestTranscript: configuration.isUITesting
        )
        localAccessibilityAssistant = LocalAccessibilityAssistantService(
            usesDeterministicUITestResponse: configuration.isUITesting
        )
        passengerFeedback = PassengerFeedbackService(suppressesOutput: configuration.isUITesting)
    }
}
