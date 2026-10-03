import Foundation

struct LTACollectionResponse<Element: Decodable & Sendable>: Decodable, Sendable {
    let value: [Element]
}

struct LTAArrivalResponse: Decodable, Sendable {
    let busStopCode: String
    let services: [LTAServiceArrival]

    enum CodingKeys: String, CodingKey {
        case busStopCode = "BusStopCode"
        case services = "Services"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        busStopCode = try container.decodeIfPresent(String.self, forKey: .busStopCode) ?? ""
        services = try container.decodeIfPresent([LTAServiceArrival].self, forKey: .services) ?? []
    }
}

struct LTAServiceArrival: Decodable, Sendable {
    let serviceNo: String
    let operatorCode: String
    let buses: [LTANextBus]

    enum CodingKeys: String, CodingKey {
        case serviceNo = "ServiceNo"
        case operatorCode = "Operator"
        case nextBus = "NextBus"
        case nextBus2 = "NextBus2"
        case nextBus3 = "NextBus3"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serviceNo = try container.decodeIfPresent(String.self, forKey: .serviceNo) ?? ""
        operatorCode = try container.decodeIfPresent(String.self, forKey: .operatorCode) ?? ""
        buses = [
            try container.decodeIfPresent(LTANextBus.self, forKey: .nextBus),
            try container.decodeIfPresent(LTANextBus.self, forKey: .nextBus2),
            try container.decodeIfPresent(LTANextBus.self, forKey: .nextBus3)
        ].compactMap { $0 }
    }
}

struct LTANextBus: Decodable, Sendable {
    let originCode: String
    let destinationCode: String
    let estimatedArrival: String
    let monitored: Int
    let latitude: String
    let longitude: String
    let visitNumber: String
    let load: String
    let feature: String
    let type: String

    enum CodingKeys: String, CodingKey {
        case originCode = "OriginCode"
        case destinationCode = "DestinationCode"
        case estimatedArrival = "EstimatedArrival"
        case monitored = "Monitored"
        case latitude = "Latitude"
        case longitude = "Longitude"
        case visitNumber = "VisitNumber"
        case load = "Load"
        case feature = "Feature"
        case type = "Type"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        originCode = container.decodeFlexibleString(forKey: .originCode)
        destinationCode = container.decodeFlexibleString(forKey: .destinationCode)
        estimatedArrival = container.decodeFlexibleString(forKey: .estimatedArrival)
        monitored = (try? container.decodeIfPresent(Int.self, forKey: .monitored)) ?? 0
        latitude = container.decodeFlexibleString(forKey: .latitude)
        longitude = container.decodeFlexibleString(forKey: .longitude)
        visitNumber = container.decodeFlexibleString(forKey: .visitNumber)
        load = container.decodeFlexibleString(forKey: .load)
        feature = container.decodeFlexibleString(forKey: .feature)
        type = container.decodeFlexibleString(forKey: .type)
    }
}

struct LTABusStopDTO: Decodable, Sendable {
    let busStopCode: String
    let roadName: String
    let description: String
    let latitude: Double
    let longitude: Double

    enum CodingKeys: String, CodingKey {
        case busStopCode = "BusStopCode"
        case roadName = "RoadName"
        case description = "Description"
        case latitude = "Latitude"
        case longitude = "Longitude"
    }
}

struct LTABusRouteDTO: Decodable, Sendable {
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

    enum CodingKeys: String, CodingKey {
        case serviceNo = "ServiceNo"
        case operatorCode = "Operator"
        case direction = "Direction"
        case stopSequence = "StopSequence"
        case busStopCode = "BusStopCode"
        case distance = "Distance"
        case weekdayFirstBus = "WD_FirstBus"
        case weekdayLastBus = "WD_LastBus"
        case saturdayFirstBus = "SAT_FirstBus"
        case saturdayLastBus = "SAT_LastBus"
        case sundayFirstBus = "SUN_FirstBus"
        case sundayLastBus = "SUN_LastBus"
    }
}

struct LTABusServiceDTO: Decodable, Sendable {
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

    enum CodingKeys: String, CodingKey {
        case serviceNo = "ServiceNo"
        case operatorCode = "Operator"
        case direction = "Direction"
        case category = "Category"
        case originCode = "OriginCode"
        case destinationCode = "DestinationCode"
        case amPeakFrequency = "AM_Peak_Freq"
        case amOffPeakFrequency = "AM_Offpeak_Freq"
        case pmPeakFrequency = "PM_Peak_Freq"
        case pmOffPeakFrequency = "PM_Offpeak_Freq"
        case loopDescription = "LoopDesc"
    }
}

private extension KeyedDecodingContainer {
    func decodeFlexibleString(forKey key: Key) -> String {
        if let value = try? decode(String.self, forKey: key) { return value }
        if let value = try? decode(Double.self, forKey: key) { return String(value) }
        if let value = try? decode(Int.self, forKey: key) { return String(value) }
        return ""
    }
}
