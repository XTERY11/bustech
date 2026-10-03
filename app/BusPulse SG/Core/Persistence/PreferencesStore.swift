import Foundation
import Observation
import SwiftUI

enum AppAppearance: String, Codable, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum DefaultLaunchTab: String, Codable, CaseIterable, Identifiable, Sendable {
    case map
    case favourites
    case assistant

    var id: String { rawValue }

    var title: String {
        switch self {
        case .map: "Map"
        case .favourites: "Favourites"
        case .assistant: "Assistant"
        }
    }
}

enum AssistanceReceiverScheme: String, Codable, CaseIterable, Identifiable, Sendable {
    case http
    case https

    var id: String { rawValue }
    var title: String { rawValue.uppercased() }
}

struct AssistanceReceiverConfiguration: Codable, Equatable, Sendable {
    var isEnabled = false
    var scheme: AssistanceReceiverScheme = .http
    var host = ""
    var port = "8787"

    func endpointURL() throws -> URL {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty,
              !trimmedHost.contains(where: { "/?#@".contains($0) }),
              !trimmedHost.contains(where: \Character.isWhitespace) else {
            throw AssistanceReceiverConfigurationError.invalidHost
        }

        let trimmedPort = port.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let numericPort = Int(trimmedPort), (1...65_535).contains(numericPort) else {
            throw AssistanceReceiverConfigurationError.invalidPort
        }

        var components = URLComponents()
        components.scheme = scheme.rawValue
        components.host = trimmedHost
        components.port = numericPort
        components.path = "/api/booking"

        guard let url = components.url else {
            throw AssistanceReceiverConfigurationError.invalidHost
        }
        return url
    }

    /// The dashboard's passenger twin page (dashboard/app/passenger-twin) on the hub machine.
    /// It reaches the hub through the dashboard's same-origin /api proxy, so only the token is passed,
    /// in the fragment: browsers never send a fragment to a server or write it to access logs.
    func passengerTwinURL(token: String, dashboardPort: Int = 3000) throws -> URL {
        _ = try endpointURL()
        var components = URLComponents()
        components.scheme = scheme.rawValue
        components.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        components.port = dashboardPort
        components.path = "/passenger-twin"
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedToken.isEmpty {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            components.percentEncodedFragment = "token=" + (trimmedToken.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
        }
        guard let url = components.url else {
            throw AssistanceReceiverConfigurationError.invalidHost
        }
        return url
    }
}

enum AssistanceReceiverConfigurationError: Error, LocalizedError, Equatable, Sendable {
    case invalidHost
    case invalidPort

    var errorDescription: String? {
        switch self {
        case .invalidHost:
            "Enter a valid IP address or host name."
        case .invalidPort:
            "Enter a port from 1 to 65535."
        }
    }
}

struct FavouriteStopPreference: Identifiable, Codable, Hashable, Sendable {
    let stopCode: String
    var customName: String?
    var pinnedServices: [String]

    var id: String { stopCode }
}

private struct PreferencesPayload: Codable, Sendable {
    var favourites: [FavouriteStopPreference] = []
    var recentStopCodes: [String] = []
    var appearance: AppAppearance = .system
    var useLTAIdentityTypography = true
    var defaultLaunchTab: DefaultLaunchTab = .map
    var assistanceReceiver = AssistanceReceiverConfiguration()
    var conversationalAssistantEnabled = false
    var assistantAddress = ""

    private enum CodingKeys: String, CodingKey {
        case favourites
        case recentStopCodes
        case appearance
        case useLTAIdentityTypography
        case defaultLaunchTab
        case assistanceReceiver
        case conversationalAssistantEnabled, assistantAddress
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        favourites = try container.decodeIfPresent(
            [FavouriteStopPreference].self,
            forKey: .favourites
        ) ?? []
        recentStopCodes = try container.decodeIfPresent(
            [String].self,
            forKey: .recentStopCodes
        ) ?? []
        appearance = try container.decodeIfPresent(
            AppAppearance.self,
            forKey: .appearance
        ) ?? .system
        useLTAIdentityTypography = try container.decodeIfPresent(
            Bool.self,
            forKey: .useLTAIdentityTypography
        ) ?? true
        defaultLaunchTab = try container.decodeIfPresent(
            DefaultLaunchTab.self,
            forKey: .defaultLaunchTab
        ) ?? .map
        conversationalAssistantEnabled = try container.decodeIfPresent(Bool.self, forKey: .conversationalAssistantEnabled) ?? false
        assistantAddress = try container.decodeIfPresent(String.self, forKey: .assistantAddress) ?? ""
        assistanceReceiver = try container.decodeIfPresent(
            AssistanceReceiverConfiguration.self,
            forKey: .assistanceReceiver
        ) ?? AssistanceReceiverConfiguration()
    }
}

private actor PreferencesPersistence {
    func load(resetBeforeLoading: Bool) -> PreferencesPayload {
        let defaults = UserDefaults.standard
        if resetBeforeLoading {
            defaults.removeObject(forKey: PreferencesStore.storageKey)
        }
        guard let data = defaults.data(forKey: PreferencesStore.storageKey),
              let decoded = try? JSONDecoder().decode(PreferencesPayload.self, from: data) else {
            return PreferencesPayload()
        }
        return decoded
    }

    func save(_ payload: PreferencesPayload) {
        let defaults = UserDefaults.standard
        guard let data = try? JSONEncoder().encode(payload) else { return }
        defaults.set(data, forKey: PreferencesStore.storageKey)
    }
}

@MainActor
@Observable
final class PreferencesStore {
    nonisolated static let storageKey = "BusPulseSG.preferences.v1"

    private let persistence: PreferencesPersistence
    private let resetBeforeLoading: Bool
    private var payload = PreferencesPayload()
    private var hasLoaded = false
    private var pendingSave: Task<Void, Never>?

    init(resetBeforeLoading: Bool = false) {
        persistence = PreferencesPersistence()
        self.resetBeforeLoading = resetBeforeLoading
    }

    func bootstrap() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        payload = await persistence.load(resetBeforeLoading: resetBeforeLoading)
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"),
           let address = ProcessInfo.processInfo.environment["CONVERSATION_TEST_URL"] {
            payload.assistantAddress = address
            assistantAccessCode = "ui-fixture-token"
        }
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"),
           let address = ProcessInfo.processInfo.environment["BUSTECH_HUB_URL"],
           let url = URL(string: address), let host = url.host {
            payload.assistanceReceiver = AssistanceReceiverConfiguration(
                isEnabled: true, scheme: url.scheme == "https" ? .https : .http,
                host: host, port: String(url.port ?? 8787)
            )
            bridgeToken = ProcessInfo.processInfo.environment["BUSTECH_HUB_TOKEN"] ?? ""
        }
    }

    var favourites: [FavouriteStopPreference] { payload.favourites }
    var recentStopCodes: [String] { payload.recentStopCodes }
    var appearance: AppAppearance {
        get { payload.appearance }
        set {
            payload.appearance = newValue
            persist()
        }
    }
    var useLTAIdentityTypography: Bool {
        get { payload.useLTAIdentityTypography }
        set {
            payload.useLTAIdentityTypography = newValue
            persist()
        }
    }
    var defaultLaunchTab: DefaultLaunchTab {
        get { payload.defaultLaunchTab }
        set {
            payload.defaultLaunchTab = newValue
            persist()
        }
    }
    var conversationalAssistantEnabled: Bool {
        get { payload.conversationalAssistantEnabled }
        set { payload.conversationalAssistantEnabled = newValue; persist() }
    }
    var assistantAddress: String {
        get { payload.assistantAddress.isEmpty ? BundledAssistantConfiguration.runtimeValue("AssistantServiceURL") : payload.assistantAddress }
        set { payload.assistantAddress = newValue; persist() }
    }
    var assistantAccessCode = ProcessInfo.processInfo.environment["ASSISTANT_TOKEN"] ?? BundledAssistantConfiguration.runtimeValue("AssistantAccessCode")

    var bridgeToken = ProcessInfo.processInfo.environment["BRIDGE_TOKEN"] ?? BundledAssistantConfiguration.runtimeValue("BusTechBridgeToken")

    var assistanceReceiver: AssistanceReceiverConfiguration {
        get { payload.assistanceReceiver }
        set {
            payload.assistanceReceiver = newValue
            persist()
        }
    }

    func assistanceReceiverEndpoint() throws -> URL? {
        guard payload.assistanceReceiver.isEnabled else { return nil }
        return try payload.assistanceReceiver.endpointURL()
    }

    func favourite(for stopCode: String) -> FavouriteStopPreference? {
        payload.favourites.first { $0.stopCode == stopCode }
    }

    func isFavourite(_ stopCode: String) -> Bool {
        favourite(for: stopCode) != nil
    }

    func toggleFavourite(stopCode: String) {
        if let index = payload.favourites.firstIndex(where: { $0.stopCode == stopCode }) {
            payload.favourites.remove(at: index)
        } else {
            payload.favourites.append(
                FavouriteStopPreference(
                    stopCode: stopCode,
                    customName: nil,
                    pinnedServices: []
                )
            )
        }
        persist()
    }

    func rename(stopCode: String, to name: String) {
        guard let index = payload.favourites.firstIndex(where: { $0.stopCode == stopCode }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        payload.favourites[index].customName = trimmed.isEmpty ? nil : trimmed
        persist()
    }

    func togglePinned(serviceNo: String, at stopCode: String) {
        ensureFavourite(stopCode)
        guard let index = payload.favourites.firstIndex(where: { $0.stopCode == stopCode }) else { return }
        if let pinnedIndex = payload.favourites[index].pinnedServices.firstIndex(of: serviceNo) {
            payload.favourites[index].pinnedServices.remove(at: pinnedIndex)
        } else {
            payload.favourites[index].pinnedServices.append(serviceNo)
        }
        persist()
    }

    func movePinned(serviceNo: String, at stopCode: String, offset: Int) {
        guard let favouriteIndex = payload.favourites.firstIndex(where: { $0.stopCode == stopCode }),
              let oldIndex = payload.favourites[favouriteIndex].pinnedServices.firstIndex(of: serviceNo) else { return }
        let newIndex = min(
            max(0, oldIndex + offset),
            payload.favourites[favouriteIndex].pinnedServices.count - 1
        )
        guard oldIndex != newIndex else { return }
        let value = payload.favourites[favouriteIndex].pinnedServices.remove(at: oldIndex)
        payload.favourites[favouriteIndex].pinnedServices.insert(value, at: newIndex)
        persist()
    }

    func recordRecent(stopCode: String) {
        payload.recentStopCodes.removeAll { $0 == stopCode }
        payload.recentStopCodes.insert(stopCode, at: 0)
        payload.recentStopCodes = Array(payload.recentStopCodes.prefix(8))
        persist()
    }

    func flushPendingWrites() async {
        await pendingSave?.value
    }

    private func ensureFavourite(_ stopCode: String) {
        guard !isFavourite(stopCode) else { return }
        payload.favourites.append(
            FavouriteStopPreference(
                stopCode: stopCode,
                customName: nil,
                pinnedServices: []
            )
        )
    }

    private func persist() {
        let snapshot = payload
        let previousSave = pendingSave
        let persistence = persistence
        pendingSave = Task {
            await previousSave?.value
            await persistence.save(snapshot)
        }
    }
}
