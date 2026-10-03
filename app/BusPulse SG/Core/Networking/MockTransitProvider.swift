import Foundation

actor MockTransitProvider: TransitDataProviding {
    nonisolated let mode: DataMode = .mock
    private let snapshot: TransitSnapshot

    init() {
        snapshot = Self.makeSnapshot()
    }

    func fetchStaticSnapshot() async throws -> TransitSnapshot {
        try await Task.sleep(for: .milliseconds(90))
        return snapshot
    }

    func fetchArrivals(stopCode: String) async throws -> ArrivalBoard {
        try await Task.sleep(for: .milliseconds(120))
        let now = Date()
        guard snapshot.stops.contains(where: { $0.code == stopCode }) else {
            return ArrivalBoard(stopCode: stopCode, services: [], fetchedAt: now, mode: .mock)
        }

        let serviceNumbers: [String]
        if ProcessInfo.processInfo.arguments.contains("-dense-mock-arrivals"),
           stopCode == "01012" || stopCode == "01013" {
            serviceNumbers = ["7", "14", "16", "36", "111", "123", "147", "190"]
        } else {
            switch stopCode {
            case "01012": serviceNumbers = ["7", "14", "16", "191"]
            case "04167": serviceNumbers = ["14", "16"]
            default: serviceNumbers = ["7"]
            }
        }

        let services = serviceNumbers.enumerated().map { serviceIndex, serviceNo in
            let route = snapshot.services.first { $0.serviceNo == serviceNo && $0.direction == 1 }
            let offsets = serviceNo == "191"
                ? [245, 610, 980]
                : [95 + serviceIndex * 30, 430 + serviceIndex * 45, 820 + serviceIndex * 60]
            let loads: [Occupancy] = [.seatsAvailable, .standingAvailable, .limitedStanding]
            let estimates = offsets.enumerated().map { slot, seconds in
                let hasReportedLocation = serviceNo == "7" || slot < 2
                return ArrivalEstimate(
                    serviceNo: serviceNo,
                    slot: slot,
                    originCode: route?.originCode ?? "01012",
                    destinationCode: route?.destinationCode ?? "04167",
                    estimatedArrival: now.addingTimeInterval(TimeInterval(seconds)),
                    monitored: hasReportedLocation,
                    latitude: hasReportedLocation
                        ? 1.2992 + Double(serviceIndex) * 0.001 + Double(slot) * 0.0014
                        : nil,
                    longitude: hasReportedLocation
                        ? 103.8544 + Double(serviceIndex) * 0.001 - Double(slot) * 0.0012
                        : nil,
                    visitNumber: 1,
                    occupancy: loads[slot],
                    wheelchairAccessible: slot != 1,
                    vehicleType: slot == 1 ? .doubleDeck : .singleDeck
                )
            }
            return ServiceArrivals(
                serviceNo: serviceNo,
                operatorCode: "SBST",
                direction: 1,
                estimates: estimates
            )
        }
        return ArrivalBoard(stopCode: stopCode, services: services, fetchedAt: now, mode: .mock)
    }

    nonisolated static func makeSnapshot() -> TransitSnapshot {
        var stops = [
            BusStop(code: "01012", roadName: "Victoria St", name: "Hotel Grand Pacific", latitude: 1.29685, longitude: 103.85302),
            BusStop(code: "01013", roadName: "Victoria St", name: "St Joseph's Church", latitude: 1.29771, longitude: 103.85322),
            BusStop(code: "02049", roadName: "Bras Basah Rd", name: "Raffles Hotel", latitude: 1.29454, longitude: 103.85404),
            BusStop(code: "04167", roadName: "North Bridge Rd", name: "City Hall Stn Exit B", latitude: 1.29322, longitude: 103.85222),
            BusStop(code: "83139", roadName: "Joo Chiat Rd", name: "Aft Duku Rd", latitude: 1.31531, longitude: 103.90558)
        ]
        if ProcessInfo.processInfo.arguments.contains("-conversation-stop-fixtures") {
            stops += [
                BusStop(code: "11111", roadName: "Test Road", name: "Bef The Synergy", latitude: 1.30, longitude: 103.85),
                BusStop(code: "11112", roadName: "Test Road", name: "Opp The Synergy", latitude: 1.30, longitude: 103.85)
            ]
        }
        let serviceNumbers = ["7", "14", "16", "36", "111", "123", "147", "190", "191"]
        let routeStops = ["01012", "01013", "02049", "04167"] + (ProcessInfo.processInfo.arguments.contains("-conversation-stop-fixtures") ? ["11111", "11112"] : [])
        let routes = serviceNumbers.flatMap { serviceNo in
            routeStops.enumerated().map { index, stopCode in
                BusRoute(
                    serviceNo: serviceNo,
                    operatorCode: "SBST",
                    direction: 1,
                    stopSequence: index + 1,
                    busStopCode: stopCode,
                    distance: Double(index) * 0.7,
                    weekdayFirstBus: "0530",
                    weekdayLastBus: "2355",
                    saturdayFirstBus: "0530",
                    saturdayLastBus: "2355",
                    sundayFirstBus: "0600",
                    sundayLastBus: "2350"
                )
            }
        }
        let services = serviceNumbers.map { serviceNo in
            BusServiceInfo(
                serviceNo: serviceNo,
                operatorCode: "SBST",
                direction: 1,
                category: "TRUNK",
                originCode: "01012",
                destinationCode: "04167",
                amPeakFrequency: "8-12",
                amOffPeakFrequency: "10-15",
                pmPeakFrequency: "8-12",
                pmOffPeakFrequency: "12-16",
                loopDescription: ""
            )
        }
        return TransitSnapshot(
            version: "mock-v1",
            fetchedAt: Date(timeIntervalSince1970: 1_782_553_600),
            stops: stops,
            routes: routes,
            services: services
        )
    }
}
