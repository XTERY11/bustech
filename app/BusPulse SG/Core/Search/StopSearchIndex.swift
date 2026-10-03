import CoreLocation
import Foundation

actor StopSearchIndex {
    private struct Entry: Sendable {
        let stop: BusStop
        let code: String
        let name: String
        let road: String
        let combined: String
    }

    private var entries: [Entry] = []

    func rebuild(with stops: [BusStop]) {
        PerformanceTrace.measure("Search indexing") {
            entries = stops.map { stop in
                let code = Self.normalize(stop.code)
                let name = Self.normalize(stop.name)
                let road = Self.normalize(stop.roadName)
                return Entry(
                    stop: stop,
                    code: code,
                    name: name,
                    road: road,
                    combined: "\(code) \(name) \(road)"
                )
            }
        }
    }

    func search(_ query: String, limit: Int = 40) -> [BusStop] {
        let normalized = Self.normalize(query)
        guard !normalized.isEmpty else { return [] }

        return entries
            .compactMap { entry -> (Int, String, BusStop)? in
                let rank: Int
                if entry.code == normalized { rank = 0 }
                else if entry.code.hasPrefix(normalized) { rank = 1 }
                else if entry.name == normalized { rank = 2 }
                else if entry.name.hasPrefix(normalized) { rank = 3 }
                else if entry.road.hasPrefix(normalized) { rank = 4 }
                else if entry.combined.split(separator: " ").contains(where: { $0.hasPrefix(normalized) }) { rank = 5 }
                else if entry.combined.contains(normalized) { rank = 6 }
                else { return nil }
                return (rank, entry.stop.displayName, entry.stop)
            }
            .sorted {
                if $0.0 == $1.0 { return $0.1.localizedStandardCompare($1.1) == .orderedAscending }
                return $0.0 < $1.0
            }
            .prefix(limit)
            .map(\.2)
    }

    // Conversational lookup is deliberately broader than map search. Matches are
    // suggestions only: the passenger must confirm a named stop before booking.
    func conversationSearch(_ query: String, limit: Int = 24) -> [BusStop] {
        let words = Self.stopWords(query)
        guard !words.isEmpty else { return [] }
        let direction = Set(words).intersection(["before", "after", "opposite"])
        let numeric = words.allSatisfy { $0.allSatisfy(\.isNumber) }
        return entries.compactMap { entry -> (Int, BusStop)? in
            if numeric { return entry.code == words.joined() ? (0, entry.stop) : nil }
            let name = Self.stopWords(entry.name)
            // Never turn a stated side of the road into the opposite side.
            guard direction.isEmpty || direction.isSubset(of: Set(name)) else { return nil }
            let target = name + Self.stopWords(entry.road)
            var score = 0
            for word in words {
                if target.contains(word) { continue }
                guard word.count >= 4, !word.allSatisfy(\.isNumber) else { return nil }
                let best = target.map { Self.editDistance(word, $0) }.min() ?? 99
                guard best <= (word.count >= 8 ? 2 : 1) else { return nil }
                score += best * 10
            }
            if words != name { score += 2 }
            return (score, entry.stop)
        }.sorted {
            if $0.0 != $1.0 { return $0.0 < $1.0 }
            return $0.1.code < $1.1.code
        }.prefix(limit).map(\.1)
    }

    private static func stopWords(_ value: String) -> [String] {
        let aliases = ["bef": "before", "b4": "before", "aft": "after", "opp": "opposite",
                       "rd": "road", "st": "street", "ave": "avenue", "av": "avenue",
                       "ctrl": "central", "ctr": "centre", "center": "centre",
                       "stn": "station", "int": "interchange", "ter": "terminal",
                       "blk": "block", "bt": "bukit", "jln": "jalan"]
        return normalize(value).replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .split(separator: " ").map { aliases[String($0)] ?? String($0) }
            .filter { !["the", "bus", "stop"].contains($0) }
    }

    private static func editDistance(_ lhs: String, _ rhs: String) -> Int {
        let a = Array(lhs), b = Array(rhs)
        guard abs(a.count - b.count) <= 2 else { return 99 }
        var previous = Array(0...b.count)
        for (i, x) in a.enumerated() {
            var row = [i + 1]
            for (j, y) in b.enumerated() {
                row.append(min(row[j] + 1, previous[j + 1] + 1, previous[j] + (x == y ? 0 : 1)))
            }
            previous = row
        }
        return previous[b.count]
    }

    func nearest(to coordinate: CLLocationCoordinate2D, limit: Int = 8) -> [BusStop] {
        entries
            .map { entry in
                let latitudeDelta = entry.stop.latitude - coordinate.latitude
                let longitudeDelta = entry.stop.longitude - coordinate.longitude
                return (latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta, entry.stop)
            }
            .sorted { $0.0 < $1.0 }
            .prefix(limit)
            .map(\.1)
    }

    private static func normalize(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_SG"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .lowercased()
    }
}
