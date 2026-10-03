import Foundation

actor LTAAPIClient {
    private let accountKey: String
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let baseURL = URL(string: "https://datamall2.mytransport.sg/ltaodataservice")!

    init(accountKey: String, session: URLSession = .shared) {
        self.accountKey = accountKey
        self.session = session
    }

    func arrivals(stopCode: String) async throws -> LTAArrivalResponse {
        try await request(
            path: "v3/BusArrival",
            queryItems: [URLQueryItem(name: "BusStopCode", value: stopCode)]
        )
    }

    func allBusStops() async throws -> [LTABusStopDTO] {
        try await paged(path: "BusStops")
    }

    func allBusRoutes() async throws -> [LTABusRouteDTO] {
        try await paged(path: "BusRoutes")
    }

    func allBusServices() async throws -> [LTABusServiceDTO] {
        try await paged(path: "BusServices")
    }

    private func paged<Element: Decodable & Sendable>(path: String) async throws -> [Element] {
        var all: [Element] = []
        var skip = 0
        let pageSize = 500

        while skip < 100_000 {
            let response: LTACollectionResponse<Element> = try await request(
                path: path,
                queryItems: [URLQueryItem(name: "$skip", value: String(skip))]
            )
            all.append(contentsOf: response.value)
            if response.value.count < pageSize { return all }
            skip += pageSize
        }
        throw TransitDataError.incompleteSnapshot("pagination exceeded its safety limit")
    }

    private func request<Response: Decodable & Sendable>(
        path: String,
        queryItems: [URLQueryItem]
    ) async throws -> Response {
        let endpoint = baseURL.appendingPathComponent(path)
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw TransitDataError.invalidURL
        }
        components.queryItems = queryItems
        guard let url = components.url else { throw TransitDataError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.setValue(accountKey, forHTTPHeaderField: "AccountKey")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TransitDataError.invalidResponse
        }
        guard (200 ... 299).contains(httpResponse.statusCode) else {
            throw TransitDataError.httpStatus(httpResponse.statusCode)
        }
        return try decoder.decode(Response.self, from: data)
    }
}
