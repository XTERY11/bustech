import Foundation

struct AppConfiguration: Sendable {
    let accountKey: String?
    let isUITesting: Bool

    static func current(
        bundle: Bundle = .main,
        processInfo: ProcessInfo = .processInfo
    ) -> AppConfiguration {
        let arguments = processInfo.arguments
        let isUITesting = arguments.contains("-ui-testing")
        let forcesMock = arguments.contains("-mock-data")
        let rawKey = (bundle.object(forInfoDictionaryKey: "LTAAccountKey") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let validKey = rawKey.flatMap { value -> String? in
            guard !value.isEmpty,
                  !value.contains("replace_with"),
                  !value.contains("$(") else { return nil }
            return value
        }
        return AppConfiguration(
            accountKey: forcesMock ? nil : validKey,
            isUITesting: isUITesting
        )
    }
}

/// Distribution gateway credentials, never Groq or DeepSeek provider keys.
struct BundledAssistantConfiguration {
    static func value(_ key: String, bundle: Bundle = .main) -> String {
        clean(bundle.object(forInfoDictionaryKey: key) as? String)
    }

    static func clean(_ raw: String?) -> String {
        let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.contains("$(") ? "" : value
    }

    static func runtimeValue(_ key: String) -> String {
        // UI fixtures and missing-configuration tests must remain isolated.
        ProcessInfo.processInfo.arguments.contains("-ui-testing") ? "" : value(key)
    }
}
