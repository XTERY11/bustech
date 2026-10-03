import CoreLocation

enum StopMarkerPresentation: String, Equatable, Sendable {
    case overview
    case dot
    case sign

    init(latitudeDelta: CLLocationDegrees) {
        if latitudeDelta > 0.032 {
            self = .overview
        } else if latitudeDelta > 0.006 {
            self = .dot
        } else {
            self = .sign
        }
    }
}
