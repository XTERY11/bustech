import CoreLocation
import MapKit
import OSLog
import SwiftUI

struct BusRoutePresentation: Identifiable, Hashable {
    let serviceNo: String
    let direction: Int
    let stops: [BusStop]
    let currentStopCode: String?

    var id: String { "\(serviceNo)-\(direction)" }
    var origin: BusStop? { stops.first }
    var destination: BusStop? { stops.last }
}

struct BusRouteView: View {
    let presentation: BusRoutePresentation
    let onShowOnMainMap: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(PreferencesStore.self) private var preferences
    @Environment(RouteGeometryService.self) private var routeGeometry
    @State private var cameraPosition: MapCameraPosition
    @State private var geometry: RouteGeometrySnapshot
    @State private var selectedStopCode: String?
    @State private var selectionRevision = 0
    @State private var hasLoadedSavedGeometry = false
    @State private var isGeometryRefreshing = false
    @State private var geometryRefreshRevision = 0
    @State private var visibleLatitudeDelta: CLLocationDegrees

    init(
        presentation: BusRoutePresentation,
        onShowOnMainMap: @escaping (String) -> Void = { _ in }
    ) {
        self.presentation = presentation
        self.onShowOnMainMap = onShowOnMainMap
        let coordinates = presentation.stops.map(\.coordinate).filter(Self.isUsableCoordinate)
        _geometry = State(initialValue: Self.emptyGeometry(for: presentation.stops))
        let initialRegion = Self.region(for: coordinates)
        _cameraPosition = State(initialValue: .region(initialRegion))
        _visibleLatitudeDelta = State(initialValue: initialRegion.span.latitudeDelta)
        _selectedStopCode = State(initialValue: presentation.currentStopCode ?? presentation.stops.first?.code)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if presentation.stops.count > 1 {
                    routeMap
                    routeSummary
                    Divider()
                    stopList
                } else {
                    ContentUnavailableView {
                        Label("Route unavailable", systemImage: "map")
                    } description: {
                        Text("The cached LTA stop sequence is incomplete for this service and direction.")
                    }
                }
            }
            .background(Color(.systemBackground))
            .navigationTitle("Service \(presentation.serviceNo)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: "\(presentation.id)-\(geometryRefreshRevision)") {
            await loadRoadGeometry(forceRefresh: geometryRefreshRevision > 0)
        }
        .accessibilityIdentifier("route.view.\(presentation.serviceNo).\(presentation.direction)")
    }

    private var routeMap: some View {
        Map(position: $cameraPosition, interactionModes: [.pan, .zoom]) {
            ForEach(Array(geometry.segments.enumerated()), id: \.offset) { _, segment in
                let coordinates = segment.coordinates.map(\.coordinate)
                if coordinates.count > 1 {
                    MapPolyline(coordinates: coordinates)
                        .stroke(
                            segment.isRoadAligned ? Color.pulseTeal : Color.secondary.opacity(0.5),
                            style: StrokeStyle(
                                lineWidth: segment.isRoadAligned ? 4.5 : 2,
                                lineCap: .round,
                                lineJoin: .round,
                                dash: segment.isRoadAligned ? [] : [4, 5]
                            )
                        )
                }
            }

            ForEach(presentation.stops) { stop in
                Annotation("", coordinate: stop.coordinate) {
                    Button {
                        select(stop)
                    } label: {
                        RouteStopMapMarker(
                            stop: stop,
                            presentation: stopPresentation,
                            isSelected: selectedStopCode == stop.code,
                            isCurrent: presentation.currentStopCode == stop.code
                        )
                    }
                    .buttonStyle(.plain)
                    .frame(width: stopPresentation == .sign ? 72 : 44, height: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Select bus stop \(stop.code), \(stop.displayName)")
                    .accessibilityValue(selectedStopCode == stop.code ? "Selected" : "Not selected")
                    .accessibilityIdentifier("route.mapStop.\(stop.code)")
                }
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .onMapCameraChange(frequency: .onEnd) { context in
            visibleLatitudeDelta = context.region.span.latitudeDelta
        }
        .frame(height: 265)
        .accessibilityLabel("Map of service \(presentation.serviceNo), direction \(presentation.direction)")
        .accessibilityIdentifier("route.map")
        .overlay(alignment: .bottomLeading) {
            if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
                Text(stopPresentation.rawValue)
                    .font(.system(size: 1))
                    .foregroundStyle(.clear)
                    .frame(width: 1, height: 1)
                    .accessibilityIdentifier("route.stopPresentation")
            }
        }
    }

    private var stopPresentation: StopMarkerPresentation {
        StopMarkerPresentation(latitudeDelta: visibleLatitudeDelta)
    }

    private var routeSummary: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(presentation.serviceNo)
                .font(TransitTypography.serviceNumber(enabled: preferences.useLTAIdentityTypography))
                .foregroundStyle(Color.black.opacity(0.82))
                .frame(width: 58, height: 38)
                .background(Color.pulseServiceGreen, in: RoundedRectangle(cornerRadius: 7, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(routeTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                HStack(spacing: 5) {
                    if isGeometryRefreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: geometry.isFullyRoadAligned
                              ? "point.topleft.down.to.point.bottomright.curvepath"
                              : "point.3.connected.trianglepath.dotted")
                    }
                    Text(geometryStatusLabel)
                        .lineLimit(1)
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(geometry.roadAlignedSegmentCount > 0 ? Color.pulseTeal : .secondary)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("route.geometryStatus")
            }

            Spacer(minLength: 4)

            Button {
                geometryRefreshRevision += 1
            } label: {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.borderless)
            .disabled(isGeometryRefreshing)
            .accessibilityLabel("Refresh this cached route map")
            .accessibilityHint("Road geometry is otherwise refreshed automatically every 30 days")
            .accessibilityIdentifier("route.refreshGeometry")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
    }

    private var stopList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(presentation.stops.enumerated()), id: \.element.code) { index, stop in
                        RouteStopRow(
                            stop: stop,
                            sequence: index + 1,
                            isLast: index == presentation.stops.count - 1,
                            isCurrent: stop.code == presentation.currentStopCode,
                            isSelected: stop.code == selectedStopCode,
                            onSelect: { select(stop) },
                            onShowOnMainMap: { onShowOnMainMap(stop.code) }
                        )
                        .id(stop.code)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
            .task(id: presentation.id) {
                guard let currentStopCode = presentation.currentStopCode else { return }
                await Task.yield()
                proxy.scrollTo(currentStopCode, anchor: UnitPoint(x: 0.5, y: 0.28))
            }
            .onChange(of: selectionRevision) { _, _ in
                guard let selectedStopCode else { return }
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) {
                    proxy.scrollTo(selectedStopCode, anchor: .center)
                }
            }
        }
        .accessibilityIdentifier("route.stopList")
    }

    private var routeTitle: String {
        guard let origin = presentation.origin, let destination = presentation.destination else {
            return "Direction \(presentation.direction)"
        }
        return "\(origin.displayName) to \(destination.displayName)"
    }

    private var geometryStatusLabel: String {
        if !hasLoadedSavedGeometry {
            return "Loading saved route…"
        }
        if isGeometryRefreshing, geometry.roadAlignedSegmentCount == 0 {
            return "Building monthly road cache…"
        }
        if geometry.isFullyRoadAligned {
            return "Cached road preview · 30-day refresh"
        }
        if geometry.roadAlignedSegmentCount > 0 {
            return "Cached \(geometry.roadAlignedSegmentCount) of \(geometry.totalSegmentCount) road sections"
        }
        if geometry.deferredSegmentCount > 0 {
            return "Road preview unavailable · retry later"
        }
        return "LTA stop sequence · road cache pending"
    }

    private func loadRoadGeometry(forceRefresh: Bool) async {
        guard presentation.stops.count > 1 else { return }
        let trace = PerformanceTrace.signposter.beginInterval("Route geometry refinement")
        defer { PerformanceTrace.signposter.endInterval("Route geometry refinement", trace) }

        if !forceRefresh {
            let cached = await routeGeometry.cachedGeometry(for: presentation.stops)
            guard !Task.isCancelled else { return }
            geometry = cached
            hasLoadedSavedGeometry = true
            guard cached.needsRefresh else { return }
        } else {
            hasLoadedSavedGeometry = true
        }

        isGeometryRefreshing = true
        defer { isGeometryRefreshing = false }
        let refined = await routeGeometry.geometry(
            for: presentation.stops,
            forceRefresh: forceRefresh
        )
        guard !Task.isCancelled else { return }
        geometry = refined
    }

    private func select(_ stop: BusStop) {
        selectedStopCode = stop.code
        selectionRevision += 1
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.28)) {
            cameraPosition = .region(Self.focusRegion(for: stop.coordinate))
        }
    }

    private static func emptyGeometry(for stops: [BusStop]) -> RouteGeometrySnapshot {
        let segmentCount = max(stops.count - 1, 0)
        return RouteGeometrySnapshot(
            segments: [],
            roadAlignedSegmentCount: 0,
            totalSegmentCount: segmentCount,
            deferredSegmentCount: 0,
            needsRefresh: segmentCount > 0,
            newestUpdate: nil
        )
    }

    private static func focusRegion(for coordinate: CLLocationCoordinate2D) -> MKCoordinateRegion {
        MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.0035, longitudeDelta: 0.0035)
        )
    }

    private static func region(for coordinates: [CLLocationCoordinate2D]) -> MKCoordinateRegion {
        guard let first = coordinates.first else {
            return MKCoordinateRegion(
                center: LocationService.singaporeCentre,
                span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
            )
        }
        let minimumLatitude = coordinates.map(\.latitude).min() ?? first.latitude
        let maximumLatitude = coordinates.map(\.latitude).max() ?? first.latitude
        let minimumLongitude = coordinates.map(\.longitude).min() ?? first.longitude
        let maximumLongitude = coordinates.map(\.longitude).max() ?? first.longitude
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: (minimumLatitude + maximumLatitude) / 2,
                longitude: (minimumLongitude + maximumLongitude) / 2
            ),
            span: MKCoordinateSpan(
                latitudeDelta: max((maximumLatitude - minimumLatitude) * 1.35, 0.006),
                longitudeDelta: max((maximumLongitude - minimumLongitude) * 1.35, 0.006)
            )
        )
    }

    private static func isUsableCoordinate(_ coordinate: CLLocationCoordinate2D) -> Bool {
        coordinate.latitude.isFinite
            && coordinate.longitude.isFinite
            && CLLocationCoordinate2DIsValid(coordinate)
    }
}

private struct RouteStopMapMarker: View {
    let stop: BusStop
    let presentation: StopMarkerPresentation
    let isSelected: Bool
    let isCurrent: Bool

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        ZStack {
            switch presentation {
            case .sign:
                HStack(spacing: 0) {
                    Image(systemName: "bus.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Color.pulseNavy)
                        .frame(width: 20, height: 20)
                        .background(Color.pulseServiceGreen)
                    Text(stop.code)
                        .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))
                        .foregroundStyle(Color.black.opacity(0.84))
                        .frame(width: 41, height: 18)
                        .background(.white)
                        .padding(1)
                }
                .background(Color.pulseServiceGreen)
                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(isSelected ? Color.pulseNavy : .white, lineWidth: isSelected ? 2.5 : 1)
                }
                .shadow(color: .black.opacity(isSelected ? 0.24 : 0.14), radius: 2, y: 1)

            case .dot:
                stopDot(diameter: isSelected ? 17 : 10)

            case .overview:
                if stop.kind == .interchange {
                    Circle()
                        .fill(Color.pulseServiceGreen)
                        .frame(width: isSelected ? 25 : 21, height: isSelected ? 25 : 21)
                        .overlay {
                            Image(systemName: "bus.fill")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Color.pulseNavy)
                        }
                        .overlay {
                            Circle().stroke(isSelected ? Color.pulseNavy : .white, lineWidth: isSelected ? 2.5 : 1.5)
                        }
                        .shadow(color: .black.opacity(0.14), radius: 1.5, y: 1)
                } else {
                    stopDot(diameter: isSelected ? 13 : 6)
                }
            }
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .animation(.snappy(duration: 0.2), value: isSelected)
    }

    private func stopDot(diameter: CGFloat) -> some View {
        Circle()
            .fill(Color.pulseServiceGreen)
            .frame(width: diameter, height: diameter)
            .overlay {
                Circle().stroke(isSelected ? Color.pulseNavy : .white, lineWidth: isSelected ? 2.5 : 1)
            }
            .shadow(color: .black.opacity(isSelected ? 0.20 : 0.10), radius: 1.5, y: 1)
    }
}

private struct RouteStopRow: View {
    let stop: BusStop
    let sequence: Int
    let isLast: Bool
    let isCurrent: Bool
    let isSelected: Bool
    let onSelect: () -> Void
    let onShowOnMainMap: () -> Void

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button(action: onSelect) {
                HStack(alignment: .top, spacing: 9) {
                    routeRail
                    stopIdentity
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("route.selectStop.\(stop.code)")

            Spacer(minLength: 4)

            Button { } label: {
                Image(systemName: "bell")
                    .frame(width: 28, height: 34)
            }
            .buttonStyle(.borderless)
            .disabled(true)
            .accessibilityLabel("Alight reminder")
            .accessibilityHint("Coming in a later release")
            .accessibilityIdentifier("route.alightReminder.\(stop.code)")
            .foregroundStyle(.secondary)

            Button(action: onShowOnMainMap) {
                Image(systemName: "map")
                    .frame(width: 30, height: 34)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Show stop \(stop.code) on main map")
            .accessibilityIdentifier("route.showOnMap.\(stop.code)")
            .foregroundStyle(Color.pulseTeal)
        }
        .padding(.horizontal, 8)
        .background {
            if isCurrent || isSelected {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isCurrent ? Color.pulseServiceGreen.opacity(0.24) : Color.pulseTeal.opacity(0.10))
            }
        }
        .animation(.snappy(duration: 0.2), value: isSelected)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("route.stop.\(stop.code)")
    }

    private var stopIdentity: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(stop.code)
                    .font(TransitTypography.stopMetadata(enabled: preferences.useLTAIdentityTypography))
                    .foregroundStyle(Color.pulseTeal)
                Text("· \(sequence)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(stop.displayName)
                .font(TransitTypography.stopName(enabled: preferences.useLTAIdentityTypography))
                .foregroundStyle(Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            Text(stop.roadName)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stop \(sequence), \(stop.code), \(stop.displayName), \(stop.roadName)\(isCurrent ? ", current stop" : "")")
    }

    private var routeRail: some View {
        VStack(spacing: 3) {
            Circle()
                .fill(isCurrent || sequence == 1 || isLast ? Color.pulseServiceGreen : Color(.systemBackground))
                .frame(width: isCurrent ? 15 : 12, height: isCurrent ? 15 : 12)
                .overlay { Circle().stroke(Color.pulseTeal, lineWidth: 2.5) }

            if !isLast {
                VStack(spacing: 3) {
                    ForEach(0 ..< 8, id: \.self) { _ in
                        Capsule()
                            .fill(Color.pulseTeal.opacity(0.72))
                            .frame(width: 2.5, height: 4)
                    }
                }
            }
        }
        .frame(width: 18)
        .padding(.top, 7)
        .accessibilityHidden(true)
    }
}
