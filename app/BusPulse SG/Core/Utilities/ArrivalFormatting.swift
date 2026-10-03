import Foundation

enum ArrivalFormatting {
    static func countdown(to arrival: Date?, now: Date = Date()) -> String {
        guard let arrival else { return "—" }
        let seconds = arrival.timeIntervalSince(now)
        guard seconds >= 60 else { return "Arr" }
        return "\(Int(floor(seconds / 60))) min"
    }

    static func compactCountdown(to arrival: Date?, now: Date = Date()) -> String {
        let value = countdown(to: arrival, now: now)
        guard value.hasSuffix(" min") else { return value }
        return value.dropLast(4) + "m"
    }

    static func mapMarkerCountdown(to arrival: Date?, now: Date = Date()) -> String {
        let value = countdown(to: arrival, now: now)
        guard value.hasSuffix(" min") else { return value == "Arr" ? "Now" : value }
        return value.dropLast(4) + "'"
    }

    static func isStale(fetchedAt: Date, now: Date = Date(), threshold: TimeInterval = 60) -> Bool {
        now.timeIntervalSince(fetchedAt) > threshold
    }

    static func relativeUpdate(fetchedAt: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(fetchedAt)))
        if seconds < 5 { return "Updated now" }
        if seconds < 60 { return "Updated \(seconds)s ago" }
        return "Updated \(seconds / 60)m ago"
    }
}

struct BackoffPolicy: Sendable {
    let baseDelay: TimeInterval
    let maximumDelay: TimeInterval

    init(baseDelay: TimeInterval = 2, maximumDelay: TimeInterval = 120) {
        self.baseDelay = baseDelay
        self.maximumDelay = maximumDelay
    }

    func delay(afterFailure attempt: Int) -> Duration {
        let exponent = min(max(attempt, 0), 8)
        let seconds = min(maximumDelay, baseDelay * pow(2, Double(exponent)))
        return .milliseconds(Int64(seconds * 1_000))
    }
}

enum OperatingHoursEvaluator {
    static func isAnyServiceOperating(
        routes: [BusRoute],
        at date: Date = Date(),
        calendar inputCalendar: Calendar? = nil
    ) -> Bool {
        let calendar = singaporeCalendar(from: inputCalendar)
        let weekday = calendar.component(.weekday, from: date)
        let currentMinutes = calendar.component(.hour, from: date) * 60
            + calendar.component(.minute, from: date)

        return routes.contains { route in
            let pair: (String, String)
            switch weekday {
            case 1: pair = (route.sundayFirstBus, route.sundayLastBus)
            case 7: pair = (route.saturdayFirstBus, route.saturdayLastBus)
            default: pair = (route.weekdayFirstBus, route.weekdayLastBus)
            }
            guard let first = minutes(pair.0), var last = minutes(pair.1) else { return false }
            var current = currentMinutes
            if last < first { last += 24 * 60 }
            if current < first, last >= 24 * 60 { current += 24 * 60 }
            return current >= first && current <= last
        }
    }

    static func nextServiceStart(
        routes: [BusRoute],
        after date: Date = Date(),
        calendar inputCalendar: Calendar? = nil
    ) -> Date? {
        let calendar = singaporeCalendar(from: inputCalendar)
        let startOfToday = calendar.startOfDay(for: date)
        var candidates: [Date] = []

        for dayOffset in 0 ... 7 {
            guard let serviceDay = calendar.date(byAdding: .day, value: dayOffset, to: startOfToday) else {
                continue
            }
            let weekday = calendar.component(.weekday, from: serviceDay)
            for route in routes {
                let firstBus: String
                switch weekday {
                case 1: firstBus = route.sundayFirstBus
                case 7: firstBus = route.saturdayFirstBus
                default: firstBus = route.weekdayFirstBus
                }
                guard let firstMinutes = minutes(firstBus),
                      let candidate = calendar.date(byAdding: .minute, value: firstMinutes, to: serviceDay),
                      candidate > date else { continue }
                candidates.append(candidate)
            }
        }
        return candidates.min()
    }

    static func resumeDescription(
        routes: [BusRoute],
        after date: Date = Date(),
        calendar inputCalendar: Calendar? = nil
    ) -> String {
        let calendar = singaporeCalendar(from: inputCalendar)
        guard let nextStart = nextServiceStart(routes: routes, after: date, calendar: calendar) else {
            return "Schedule unavailable"
        }

        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_SG")
        formatter.dateFormat = calendar.isDate(nextStart, inSameDayAs: date) ? "h:mm a" : "EEE h:mm a"
        return "Resumes \(formatter.string(from: nextStart))"
    }

    private static func singaporeCalendar(from inputCalendar: Calendar?) -> Calendar {
        var calendar = inputCalendar ?? Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Singapore") ?? .current
        return calendar
    }

    private static func minutes(_ value: String) -> Int? {
        let digits = value.filter(\.isNumber)
        guard digits.count == 4,
              let hour = Int(digits.prefix(2)),
              let minute = Int(digits.suffix(2)),
              hour <= 29,
              minute < 60 else { return nil }
        return hour * 60 + minute
    }
}
