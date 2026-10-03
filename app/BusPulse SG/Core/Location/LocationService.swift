import CoreLocation
import Observation

@MainActor
@Observable
final class LocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let singaporeCentre = CLLocationCoordinate2D(latitude: 1.2966, longitude: 103.8550)

    private let manager = CLLocationManager()
    private let disablesPermissionRequest: Bool
    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var coordinate: CLLocationCoordinate2D?
    private(set) var errorMessage: String?

    init(disablesPermissionRequest: Bool = false) {
        self.disablesPermissionRequest = disablesPermissionRequest
        authorizationStatus = disablesPermissionRequest ? .denied : .notDetermined
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var effectiveCoordinate: CLLocationCoordinate2D {
        coordinate ?? Self.singaporeCentre
    }

    var permissionSummary: String {
        switch authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: "Location available"
        case .denied: "Location denied — using Singapore"
        case .restricted: "Location restricted — using Singapore"
        case .notDetermined: "Location not requested"
        @unknown default: "Location unavailable — using Singapore"
        }
    }

    func requestLocation() {
        guard !disablesPermissionRequest else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            coordinate = nil
        @unknown default:
            coordinate = nil
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        guard !disablesPermissionRequest else {
            coordinate = nil
            return
        }
        if manager.authorizationStatus == .authorizedAlways
            || manager.authorizationStatus == .authorizedWhenInUse {
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        coordinate = locations.last?.coordinate
        errorMessage = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code != .denied {
            errorMessage = "Your location could not be updated. The Singapore map is still available."
        }
    }
}
