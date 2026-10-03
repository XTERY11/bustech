import SwiftUI

struct AssistantKeysView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var groq = ""
    @State private var deepSeek = ""
    @State private var hasSavedKeys = false
    @State private var isSaving = false
    @State private var error: String?
    let onSaved: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Add your keys once. They stay in this iPhone’s Keychain and are used automatically when you reopen the app.")
                    SecureField(hasSavedKeys ? "Groq key (leave blank to keep)" : "Groq API key", text: $groq)
                        .accessibilityIdentifier("assistantKeys.groq")
                    SecureField(hasSavedKeys ? "DeepSeek key (leave blank to keep)" : "DeepSeek API key", text: $deepSeek)
                        .accessibilityIdentifier("assistantKeys.deepSeek")
                } footer: {
                    Text("Groq handles speech recognition. DeepSeek understands your request. Keys are not synced to other devices or included in the installation package.")
                }
                .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                if let error { Text(error).foregroundStyle(.red).accessibilityIdentifier("assistantKeys.error") }
                Button(isSaving ? "Saving…" : "Save keys") {
                    isSaving = true
                    Task {
                        do {
                            let old = try await AssistantCredentialStore.shared.load()
                            try await AssistantCredentialStore.shared.save(
                                groq: groq.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? old.groqKey : groq,
                                deepSeek: deepSeek.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? old.deepSeekKey : deepSeek)
                            groq = ""; deepSeek = ""
                            onSaved(); dismiss()
                        } catch { self.error = error.localizedDescription }
                        isSaving = false
                    }
                }
                .disabled(isSaving || (!hasSavedKeys && (groq.isEmpty || deepSeek.isEmpty)))
                .accessibilityIdentifier("assistantKeys.save")
            }
            .navigationTitle("Assistant API keys")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSaving) } }
            .interactiveDismissDisabled(isSaving)
            .task {
                do {
                    let saved = try await AssistantCredentialStore.shared.load()
                    hasSavedKeys = !saved.groqKey.isEmpty && !saved.deepSeekKey.isEmpty
                } catch { self.error = error.localizedDescription }
            }
        }
    }
}
