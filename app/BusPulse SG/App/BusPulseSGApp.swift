import SwiftUI

@main
struct BusPulseSGApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var container = AppContainer()

    init() {
        TransitTypography.registerBundledFont()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(container.dataStore)
                .environment(container.preferences)
                .environment(container.location)
                .environment(container.routeGeometry)
                .environment(container.assistanceRequests)
                .environment(container.assistanceJourneyResolver)
                .environment(container.speechRecognition)
                .environment(container.localAccessibilityAssistant)
                .environment(container.passengerFeedback)
                .preferredColorScheme(container.preferences.appearance.colorScheme)
                .task {
                    await container.dataStore.bootstrap()
                }
                .onChange(of: scenePhase) { _, phase in
                    guard phase != .active else { return }
                    container.speechRecognition.cancelListening()
                    container.passengerFeedback.stopSpeaking()
                    Task { await container.dataStore.cancelArrivalRequests() }
                }
        }
    }

}
