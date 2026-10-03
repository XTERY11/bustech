import SwiftUI

enum AppTab: Hashable {
    case map
    case favourites
    case assistant
    case search
    case settings
}

struct RootTabView: View {
    @Environment(PreferencesStore.self) private var preferences
    @State private var selection: AppTab = .map
    @State private var focusedStopCode: String?
    @State private var hasAppliedLaunchPreference = false

    var body: some View {
        TabView(selection: $selection) {
            MapFeatureView(
                focusedStopCode: $focusedStopCode,
                isActive: selection == .map
            )
                .tabItem { Label("Map", systemImage: "map.fill") }
                .environment(\.assistanceFeedbackVisible, selection == .map)
                .tag(AppTab.map)
                .accessibilityIdentifier("tab.map")

            FavouritesView(
                isActive: selection == .favourites,
                onSelectStop: showOnMap
            )
                .tabItem { Label("Favourites", systemImage: "star.fill") }
                .tag(AppTab.favourites)
                .accessibilityIdentifier("tab.favourites")

            AssistantFeatureView(onChooseBusOnMap: {
                selection = .map
            })
                .tabItem { Label("Assistant", systemImage: "waveform.circle.fill") }
                .environment(\.assistanceFeedbackVisible, selection == .assistant)
                .tag(AppTab.assistant)
                .accessibilityIdentifier("tab.assistant")

            SearchFeatureView(onSelectStop: showOnMap)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(AppTab.search)
                .accessibilityIdentifier("tab.search")

            SettingsFeatureView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
                .accessibilityIdentifier("tab.settings")
        }
        .tint(Color.pulseTeal)
        .task {
            await preferences.bootstrap()
            guard !hasAppliedLaunchPreference else { return }
            hasAppliedLaunchPreference = true
            selection = switch preferences.defaultLaunchTab {
            case .map: .map
            case .favourites: .favourites
            case .assistant: .assistant
            }
        }
    }

    private func showOnMap(_ stop: BusStop) {
        focusedStopCode = stop.code
        selection = .map
    }
}
