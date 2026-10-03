import SwiftUI
import UIKit

struct SettingsFeatureView: View {
    @State private var showsAssistantKeys = false
    @State private var assistantKeysSaved = false
    @State private var assistantConnectionMessage: String?
    @State private var connectionTask: Task<Void, Never>?
    @State private var isCheckingAssistant = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(TransitDataStore.self) private var dataStore
    @Environment(PreferencesStore.self) private var preferences
    @Environment(LocationService.self) private var location

    var body: some View {
        @Bindable var preferences = preferences

        NavigationStack {
            Form {
                Section("Data source") {
                    LabeledContent("Mode", value: dataStore.mode.title)
                        .accessibilityIdentifier("settings.dataMode")
                    if dataStore.mode == .mock {
                        Label(
                            "Add an LTA AccountKey to use live arrivals. Mock values are clearly labelled and are never presented as live.",
                            systemImage: "key.slash"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }

                Section("Offline transit data") {
                    LabeledContent("Version", value: dataStore.snapshot?.version ?? "Not loaded")
                    if let fetchedAt = dataStore.snapshot?.fetchedAt {
                        LabeledContent("Snapshot date") {
                            Text(fetchedAt, format: .dateTime.year().month().day().hour().minute())
                        }
                    }
                    Button {
                        Task { await dataStore.refreshStatic() }
                    } label: {
                        if dataStore.isRefreshing {
                            Label("Updating…", systemImage: "arrow.triangle.2.circlepath")
                        } else {
                            Label("Check for data update", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(dataStore.isRefreshing)
                    .accessibilityIdentifier("settings.refreshData")

                    if let error = dataStore.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Color.pulseRed)
                    }
                }

                Section("Appearance") {
                    Picker("App appearance", selection: $preferences.appearance) {
                        ForEach(AppAppearance.allCases) { appearance in
                            Text(appearance.title).tag(appearance)
                        }
                    }
                    .accessibilityIdentifier("settings.appearance")
                    Toggle(
                        "LTA Identity typography",
                        isOn: $preferences.useLTAIdentityTypography
                    )
                    .accessibilityHint("Applies to bus stop identities and service-number tiles")
                    .accessibilityIdentifier("settings.ltaTypography")
                    Label(
                        reduceMotion ? "Reduce Motion is on" : "Reduce Motion is off",
                        systemImage: reduceMotion ? "figure.walk.motion" : "figure.walk"
                    )
                        .accessibilityIdentifier("settings.reduceMotionStatus")
                    Text("The supplied LTA Identity font is optional. Both typefaces scale with Dynamic Type, and bus arrival boards avoid continuous ambient motion.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Toggle("Conversational assistant", isOn: $preferences.conversationalAssistantEnabled)
                        .accessibilityIdentifier("settings.conversationalAssistant")
                    Text("Describe what you need, add details as you go, and use simple choices to finish your request. Turn off to return to the original assistant.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if preferences.conversationalAssistantEnabled {
                        Label("Connects directly from your phone", systemImage: "iphone")
                            .accessibilityIdentifier("settings.assistantDirect")
                        Button(assistantKeysSaved ? "Update API keys" : "Add API keys") { showsAssistantKeys = true }
                            .accessibilityIdentifier("settings.assistantKeys")
                        if assistantKeysSaved {
                            Label("Keys saved on this iPhone", systemImage: "checkmark.shield")
                                .accessibilityElement(children: .combine)
                                .accessibilityIdentifier("settings.assistantKeysSaved")
                        }
                        Button(isCheckingAssistant ? "Checking…" : "Check assistant connection") {
                            isCheckingAssistant = true
                            assistantConnectionMessage = nil
                            connectionTask = Task {
                                do {
                                    let service = try DirectConversationProviders(configuration: try await .current())
                                    try await service.checkConnection()
                                    guard !Task.isCancelled else { return }
                                    assistantConnectionMessage = "Connected to Groq and DeepSeek."
                                } catch {
                                    guard !Task.isCancelled else { return }
                                    assistantConnectionMessage = (error as? ConversationError)?.localizedDescription ?? "Couldn't connect. Check your internet connection and try again."
                                }
                                isCheckingAssistant = false
                            }
                        }
                        .disabled(isCheckingAssistant)
                        .accessibilityIdentifier("settings.checkAssistant")
                        if let assistantConnectionMessage {
                            Text(assistantConnectionMessage).font(.footnote)
                        }
                        Text("No computer, service address, or access code is needed. Add your API keys once; they stay saved on this iPhone.")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("When you speak, audio is sent to Groq for transcription. Your words and selected journey are sent to DeepSeek to understand your request. Exact GPS coordinates are not sent. Internet is required.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } header: { Text("Assistant") }

                Section("Start screen") {
                    Picker("Open BusPulse to", selection: $preferences.defaultLaunchTab) {
                        ForEach(DefaultLaunchTab.allCases) { tab in
                            Text(tab.title)
                                .accessibilityIdentifier("settings.defaultLaunchTab.\(tab.rawValue)")
                                .tag(tab)
                        }
                    }
                    .accessibilityHint("Assistant opens directly to the voice-first journey screen")
                    .accessibilityIdentifier("settings.defaultLaunchTab")
                    Text("This changes the next app launch; it does not interrupt the screen you are using now.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("BusTech signal hub") {
                    Toggle(
                        "Send requests to a configured receiver",
                        isOn: Binding(
                            get: { preferences.assistanceReceiver.isEnabled },
                            set: { newValue in
                                var configuration = preferences.assistanceReceiver
                                configuration.isEnabled = newValue
                                preferences.assistanceReceiver = configuration
                            }
                        )
                    )
                    .accessibilityIdentifier("settings.assistanceReceiver.enabled")

                    if preferences.assistanceReceiver.isEnabled {
                        Picker(
                            "Protocol",
                            selection: receiverBinding(\.scheme, preferences: preferences)
                        ) {
                            ForEach(AssistanceReceiverScheme.allCases) { scheme in
                                Text(scheme.title).tag(scheme)
                            }
                        }
                        .pickerStyle(.segmented)

                        TextField(
                            "IP address or host",
                            text: receiverBinding(\.host, preferences: preferences),
                            prompt: Text("192.168.1.20")
                        )
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("settings.assistanceReceiver.host")

                        TextField(
                            "Port",
                            text: receiverBinding(\.port, preferences: preferences),
                            prompt: Text("8787")
                        )
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier("settings.assistanceReceiver.port")

                        LabeledContent("Booking API", value: "/api/booking")

                        SecureField("Bridge token", text: $preferences.bridgeToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("settings.assistanceReceiver.token")
                        Text("Token stays in memory for this app session. Enter the integration machine’s token again after relaunching.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        receiverEndpointStatus(preferences.assistanceReceiver)
                    }

                    Text("Enter the service address, port and access token. Changes apply to your next request.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Location") {
                    Label(location.permissionSummary, systemImage: location.coordinate == nil ? "location.slash" : "location.fill")
                    if location.authorizationStatus == .denied || location.authorizationStatus == .restricted {
                        Button("Open Location Settings", systemImage: "gear") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        }
                    } else {
                        Button("Update location", systemImage: "location") {
                            location.requestLocation()
                        }
                    }
                    Text("If location is unavailable, Map and Nearby use central Singapore. Search and favourites remain fully usable.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Privacy & security") {
                    Label("No analytics, ads, or accounts", systemImage: "hand.raised.fill")
                    Label("Favourites and preferences stay on device", systemImage: "iphone")
                    Text("An embedded LTA key is development-only. A production release requires a server-side proxy. BusTech bookings contain the selected route, stop and assistance choices; voice recordings and transcripts are not sent to the hub.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Phase 2") {
                    Label("Alight reminders", systemImage: "bell")
                    Label("Apple Watch and widgets", systemImage: "applewatch")
                    Label("MRT map", systemImage: "tram")
                    Text("These are documented backlog items and are not represented as available features.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    LabeledContent("Minimum iOS", value: "18")
                    LabeledContent("App version", value: "1.0 (1)")
                    Text("Arrival estimates come from LTA DataMall and are displayed without interpolation or smoothing.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showsAssistantKeys) {
                AssistantKeysView {
                    assistantKeysSaved = true
                    assistantConnectionMessage = "Saved. Tap Check assistant connection to verify your keys."
                }
            }
            .task {
                if let saved = try? await AssistantCredentialStore.shared.load() {
                    assistantKeysSaved = !saved.groqKey.isEmpty && !saved.deepSeekKey.isEmpty
                }
            }
            .onDisappear { connectionTask?.cancel(); isCheckingAssistant = false }
            .onChange(of: preferences.assistantAddress) { _, _ in
                connectionTask?.cancel(); isCheckingAssistant = false; assistantConnectionMessage = nil
            }
            .onChange(of: preferences.assistantAccessCode) { _, _ in
                connectionTask?.cancel(); isCheckingAssistant = false; assistantConnectionMessage = nil
            }
        }
    }

    private func receiverBinding<Value>(
        _ keyPath: WritableKeyPath<AssistanceReceiverConfiguration, Value>,
        preferences: PreferencesStore
    ) -> Binding<Value> {
        Binding(
            get: { preferences.assistanceReceiver[keyPath: keyPath] },
            set: { newValue in
                var configuration = preferences.assistanceReceiver
                configuration[keyPath: keyPath] = newValue
                preferences.assistanceReceiver = configuration
            }
        )
    }

    @ViewBuilder
    private func receiverEndpointStatus(_ configuration: AssistanceReceiverConfiguration) -> some View {
        if let endpoint = try? configuration.endpointURL() {
            LabeledContent("Endpoint", value: endpoint.absoluteString)
                .font(.footnote)
                .accessibilityIdentifier("settings.assistanceReceiver.endpoint")
        } else {
            Label(receiverValidationMessage(configuration), systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Color.pulseRed)
                .accessibilityIdentifier("settings.assistanceReceiver.error")
        }
    }

    private func receiverValidationMessage(
        _ configuration: AssistanceReceiverConfiguration
    ) -> String {
        do {
            _ = try configuration.endpointURL()
            return ""
        } catch {
            return error.localizedDescription
        }
    }
}
