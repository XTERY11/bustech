import Foundation
import OSLog

enum PerformanceTrace {
    static let signposter = OSSignposter(
        subsystem: "sg.buspulse.app",
        category: "Performance"
    )

    static func measure<T>(
        _ name: StaticString,
        operation: () throws -> T
    ) rethrows -> T {
        let state = signposter.beginInterval(name)
        defer { signposter.endInterval(name, state) }
        return try operation()
    }
}
