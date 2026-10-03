import CoreLocation
import Foundation

enum DataMode: String, Codable, Sendable {
    case mock
    case live

    var title: String {
        switch self {
        case .mock: "Deterministic mock data"
        case .live: "Live LTA DataMall"
        }
    }
}

struct BusStop: Identifiable, Codable, Hashable, Sendable {
    let code: String
    let roadName: String
    let name: String
    let latitude: Double
    let longitude: Double

    var id: String { code }
    var displayName: String { name.isEmpty ? roadName : name }
    var kind: BusStopKind { BusStopKind(description: name) }
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

/// LTA's BusStops response does not include a stop-type field. This derived
/// value intentionally recognises only the conventional terminal words found
/// in LTA's own stop descriptions; ambiguous names remain regular stops.
enum BusStopKind: String, Codable, Hashable, Sendable {
    case regular
    case interchange

    init(description: String) {
        let words = description
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
            .split(whereSeparator: { !$0.isLetter })
        let relativeLandmarkPrefixes: Set<Substring> = [
            "aft", "after", "bef", "before", "near", "opp", "opposite"
        ]
        guard !words.isEmpty,
              !relativeLandmarkPrefixes.contains(words[0]) else {
            self = .regular
            return
        }
        let terminalWord = words.last
        self = terminalWord == "int"
            || terminalWord == "interchange"
            || terminalWord == "ter"
            || terminalWord == "terminal"
            ? .interchange
            : .regular
    }
}

struct BusRoute: Identifiable, Codable, Hashable, Sendable {
    let serviceNo: String
    let operatorCode: String
    let direction: Int
    let stopSequence: Int
    let busStopCode: String
    let distance: Double
    let weekdayFirstBus: String
    let weekdayLastBus: String
    let saturdayFirstBus: String
    let saturdayLastBus: String
    let sundayFirstBus: String
    let sundayLastBus: String

    var id: String { "\(serviceNo)-\(direction)-\(stopSequence)" }
}

struct BusServiceInfo: Identifiable, Codable, Hashable, Sendable {
    let serviceNo: String
    let operatorCode: String
    let direction: Int
    let category: String
    let originCode: String
    let destinationCode: String
    let amPeakFrequency: String
    let amOffPeakFrequency: String
    let pmPeakFrequency: String
    let pmOffPeakFrequency: String
    let loopDescription: String

    var id: String { "\(serviceNo)-\(direction)" }
}

enum Occupancy: String, Codable, Sendable {
    case seatsAvailable = "SEA"
    case standingAvailable = "SDA"
    case limitedStanding = "LSD"
    case unknown = ""

    init(code: String) {
        self = Occupancy(rawValue: code) ?? .unknown
    }

    var title: String {
        switch self {
        case .seatsAvailable: "Seats available"
        case .standingAvailable: "Standing available"
        case .limitedStanding: "Limited standing"
        case .unknown: "Occupancy unavailable"
        }
    }
}

enum VehicleType: String, Codable, Sendable {
    case singleDeck = "SD"
    case doubleDeck = "DD"
    case bendy = "BD"
    case unknown = ""

    init(code: String) {
        self = VehicleType(rawValue: code) ?? .unknown
    }

    var title: String {
        switch self {
        case .singleDeck: "Single deck"
        case .doubleDeck: "Double deck"
        case .bendy: "Bendy bus"
        case .unknown: "Bus type unavailable"
        }
    }
}

struct ArrivalEstimate: Identifiable, Codable, Hashable, Sendable {
    let serviceNo: String
    let slot: Int
    let originCode: String
    let destinationCode: String
    let estimatedArrival: Date?
    let monitored: Bool
    let latitude: Double?
    let longitude: Double?
    let visitNumber: Int?
    let occupancy: Occupancy
    let wheelchairAccessible: Bool
    let vehicleType: VehicleType

    var id: String { "\(serviceNo)-\(slot)" }

    var reportedCoordinate: CLLocationCoordinate2D? {
        guard monitored,
              let latitude,
              let longitude,
              abs(latitude) > 0.000_001,
              abs(longitude) > 0.000_001 else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

struct ServiceArrivals: Identifiable, Codable, Hashable, Sendable {
    let serviceNo: String
    let operatorCode: String
    let direction: Int?
    let estimates: [ArrivalEstimate]

    var id: String { "\(serviceNo)-\(direction ?? 0)" }
    var destinationCode: String? {
        estimates.lazy.map(\.destinationCode).first(where: { !$0.isEmpty })
    }
}

struct ArrivalBoard: Codable, Hashable, Sendable {
    let stopCode: String
    let services: [ServiceArrivals]
    let fetchedAt: Date
    let mode: DataMode
}

struct TransitSnapshot: Codable, Hashable, Sendable {
    let version: String
    let fetchedAt: Date
    let stops: [BusStop]
    let routes: [BusRoute]
    let services: [BusServiceInfo]
}

enum TransitDataError: Error, LocalizedError, Sendable, Equatable {
    case missingAccountKey
    case invalidURL
    case invalidResponse
    case httpStatus(Int)
    case incompleteSnapshot(String)
    case cacheWriteFailed

    var errorDescription: String? {
        switch self {
        case .missingAccountKey: "An LTA AccountKey is not configured."
        case .invalidURL: "The LTA request URL could not be created."
        case .invalidResponse: "LTA returned an unreadable response."
        case let .httpStatus(status): "LTA returned HTTP \(status)."
        case let .incompleteSnapshot(reason): "The transit update was not installed: \(reason)"
        case .cacheWriteFailed: "The transit cache could not be saved."
        }
    }
}
