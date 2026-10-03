import Foundation
import Security

actor AssistantCredentialStore {
    static let shared = AssistantCredentialStore(service: ProcessInfo.processInfo.arguments.contains("-ui-testing")
        ? "sg.buspulse.assistant.uitests.v1" : "sg.buspulse.assistant.credentials.v1")
    private let service: String
    private var prepared = false
    init(service: String) { self.service = service }

    private struct Stored: Codable {
        let version: Int
        let groq: String
        let deepSeek: String
    }
    enum StoreError: LocalizedError {
        case invalidKeys, unavailable
        var errorDescription: String? {
            switch self {
            case .invalidKeys: "Enter both API keys. Check that each key was copied in full without spaces."
            case .unavailable: "Couldn't access the saved keys. Unlock your iPhone and try again."
            }
        }
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "providers-v1", kSecAttrSynchronizable as String: false]
    }
    func load() throws -> AssistantProviderConfiguration {
        #if DEBUG
        if !prepared, service == "sg.buspulse.assistant.uitests.v1",
           ProcessInfo.processInfo.arguments.contains("-reset-assistant-keys") { try remove() }
        #endif
        prepared = true
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecItemNotFound { return AssistantProviderConfiguration(groqKey: "", deepSeekKey: "") }
        guard status == errSecSuccess, let data = result as? Data,
              let stored = try? JSONDecoder().decode(Stored.self, from: data), stored.version == 1 else { throw StoreError.unavailable }
        return AssistantProviderConfiguration(groqKey: stored.groq, deepSeekKey: stored.deepSeek)
    }
    func save(groq: String, deepSeek: String) throws {
        let g = groq.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = deepSeek.trimmingCharacters(in: .whitespacesAndNewlines)
        guard [g,d].allSatisfy({ !$0.isEmpty && $0.count <= 4096 && $0.rangeOfCharacter(from: .whitespacesAndNewlines) == nil }) else { throw StoreError.invalidKeys }
        let data = try JSONEncoder().encode(Stored(version: 1, groq: g, deepSeek: d))
        let updates: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if status == errSecItemNotFound {
            let add = query.merging(updates) { _, value in value }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw StoreError.unavailable }
        } else if status != errSecSuccess { throw StoreError.unavailable }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.unavailable }
    }
}
