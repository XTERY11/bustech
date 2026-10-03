import Foundation

actor LiveTransitProvider: TransitDataProviding {
    nonisolated let mode: DataMode = .live
    private let client: LTAAPIClient
    private var lastSnapshot: TransitSnapshot?

    init(accountKey: String) {
        client = LTAAPIClient(accountKey: accountKey)
    }

    func fetchStaticSnapshot() async throws -> TransitSnapshot {
        async let stopDTOs = client.allBusStops()
        async let routeDTOs = client.allBusRoutes()
        async let serviceDTOs = client.allBusServices()
        let (rawStops, rawRoutes, rawServices) = try await (stopDTOs, routeDTOs, serviceDTOs)
        let now = Date()

        let snapshot = TransitSnapshot(
            version: "lta-\(Int(now.timeIntervalSince1970))",
            fetchedAt: now,
            stops: rawStops.map {
                BusStop(
                    code: $0.busStopCode,
                    roadName: $0.roadName,
                    name: $0.description,
                    latitude: $0.latitude,
                    longitude: $0.longitude
                )
            },
            routes: rawRoutes.map {
                BusRoute(
                    serviceNo: $0.serviceNo,
                    operatorCode: $0.operatorCode,
                    direction: $0.direction,
                    stopSequence: $0.stopSequence,
                    busStopCode: $0.busStopCode,
                    distance: $0.distance,
                    weekdayFirstBus: $0.weekdayFirstBus,
                    weekdayLastBus: $0.weekdayLastBus,
                    saturdayFirstBus: $0.saturdayFirstBus,
                    saturdayLastBus: $0.saturdayLastBus,
                    sundayFirstBus: $0.sundayFirstBus,
                    sundayLastBus: $0.sundayLastBus
                )
            },
            services: rawServices.map {
                BusServiceInfo(
                    serviceNo: $0.serviceNo,
                    operatorCode: $0.operatorCode,
                    direction: $0.direction,
                    category: $0.category,
                    originCode: $0.originCode,
                    destinationCode: $0.destinationCode,
                    amPeakFrequency: $0.amPeakFrequency,
                    amOffPeakFrequency: $0.amOffPeakFrequency,
                    pmPeakFrequency: $0.pmPeakFrequency,
                    pmOffPeakFrequency: $0.pmOffPeakFrequency,
                    loopDescription: $0.loopDescription
                )
            }
        )

        try TransitSnapshotValidator.validate(
            snapshot,
            minimumStops: 1_000,
            minimumRoutes: 5_000,
            minimumServices: 100
        )
        lastSnapshot = snapshot
        return snapshot
    }

    func fetchArrivals(stopCode: String) async throws -> ArrivalBoard {
        let response = try await client.arrivals(stopCode: stopCode)
        let fetchedAt = Date()
        let routes = lastSnapshot?.routes ?? []
        let services = response.services.map { service in
            let estimates = service.buses.enumerated().compactMap { index, bus -> ArrivalEstimate? in
                guard !bus.estimatedArrival.isEmpty else { return nil }
                return ArrivalEstimate(
                    serviceNo: service.serviceNo,
                    slot: index,
                    originCode: bus.originCode,
                    destinationCode: bus.destinationCode,
                    estimatedArrival: Self.parseDate(bus.estimatedArrival),
                    monitored: bus.monitored == 1,
                    latitude: Double(bus.latitude),
                    longitude: Double(bus.longitude),
                    visitNumber: Int(bus.visitNumber),
                    occupancy: Occupancy(code: bus.load),
                    wheelchairAccessible: bus.feature == "WAB",
                    vehicleType: VehicleType(code: bus.type)
                )
            }
            let direction = Self.inferDirection(
                serviceNo: service.serviceNo,
                stopCode: stopCode,
                destinationCode: estimates.first?.destinationCode,
                routes: routes
            )
            return ServiceArrivals(
                serviceNo: service.serviceNo,
                operatorCode: service.operatorCode,
                direction: direction,
                estimates: estimates
            )
        }
        return ArrivalBoard(
            stopCode: response.busStopCode.isEmpty ? stopCode : response.busStopCode,
            services: services,
            fetchedAt: fetchedAt,
            mode: .live
        )
    }

    private nonisolated static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private nonisolated static func inferDirection(
        serviceNo: String,
        stopCode: String,
        destinationCode: String?,
        routes: [BusRoute]
    ) -> Int? {
        let candidates = routes.filter { $0.serviceNo == serviceNo && $0.busStopCode == stopCode }
        guard candidates.count > 1, let destinationCode else { return candidates.first?.direction }
        return candidates.first { candidate in
            routes.contains {
                $0.serviceNo == serviceNo
                    && $0.direction == candidate.direction
                    && $0.busStopCode == destinationCode
            }
        }?.direction ?? candidates.first?.direction
    }
}
