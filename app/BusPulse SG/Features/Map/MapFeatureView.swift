import CoreLocation
import Foundation
import MapKit
import OSLog
import SwiftUI

private enum MapCameraDefaults {
    static let nearbyLatitudeDelta: CLLocationDegrees = 0.006
    static let locationLatitudeDelta: CLLocationDegrees = 0.005

    static var nearbySpan: MKCoordinateSpan {
        MKCoordinateSpan(
            latitudeDelta: nearbyLatitudeDelta,
            longitudeDelta: nearbyLatitudeDelta
        )
    }

    static var locationSpan: MKCoordinateSpan {
        MKCoordinateSpan(
            latitudeDelta: locationLatitudeDelta,
            longitudeDelta: locationLatitudeDelta
        )
    }
}

struct MapFeatureView: View {
    @Binding var focusedStopCode: String?
    let isActive: Bool

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(TransitDataStore.self) private var dataStore
    @Environment(LocationService.self) private var location
    @Environment(RouteGeometryService.self) private var routeGeometry
    @Environment(AssistanceRequestService.self) private var assistanceRequests
    @State private var nearbyStops: [BusStop] = []
    @State private var mapCentre = LocationService.singaporeCentre
    @State private var visibleMapLatitudeDelta: CLLocationDegrees = MapCameraDefaults.nearbyLatitudeDelta
    @State private var recenterToken = 0
    @State private var nearbyResetToken = 0
    @State private var expandedNearbyStopCode: String?
    @State private var focusScrollTarget: String?
    @State private var focusScrollRevision = 0
    @State private var nearbyRefreshToken = 0
    @State private var hasEstablishedInitialFocus = false
    @State private var selectedService: ServiceArrivals?
    @State private var presentedRoute: BusRoutePresentation?
    @State private var presentedAssistanceContext: AssistanceContext?
    @State private var pendingRouteStopCode: String?
    @State private var selectedRouteGeometry: [RouteGeometrySegment] = []
    @State private var selectedRouteGeometryOwner = "none"
    @State private var arrivalBoardModels = StopArrivalBoardModelStore()

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                VStack(spacing: 0) {
                    mapStage(topInset: proxy.safeAreaInsets.top)
                        .frame(height: mapHeight(in: proxy.size.height) + proxy.safeAreaInsets.top)

                    if nearbyStops.isEmpty {
                        ContentUnavailableView {
                            Label("Finding nearby stops", systemImage: "location.magnifyingglass")
                        } description: {
                            Text("Cached stop information will appear here first.")
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        nearbyStopList
                    }
                }
                .ignoresSafeArea(edges: .top)
            }
            .toolbarVisibility(.hidden, for: .navigationBar)
        }
        .task { location.requestLocation() }
        .task(id: nearbyTaskID) {
            do { try await Task.sleep(for: .milliseconds(120)) }
            catch { return }
            let nearest = await dataStore.nearest(to: mapCentre, limit: 7)
            guard !Task.isCancelled else { return }
            var updatedStops = nearest
            if let expandedNearbyStopCode,
               !updatedStops.contains(where: { $0.code == expandedNearbyStopCode }),
               let focusedStop = dataStore.stop(code: expandedNearbyStopCode) {
                let previousIndex = nearbyStops.firstIndex(where: { $0.code == expandedNearbyStopCode }) ?? 0
                updatedStops.insert(focusedStop, at: min(previousIndex, updatedStops.count))
            }
            nearbyStops = updatedStops
            if !hasEstablishedInitialFocus, let focusedStopCode {
                hasEstablishedInitialFocus = true
                focusStop(focusedStopCode)
            } else if !hasEstablishedInitialFocus, let first = updatedStops.first {
                hasEstablishedInitialFocus = true
                focusedStopCode = first.code
                focusStop(first.code)
            }
        }
        .onChange(of: location.coordinate?.latitude) { _, latitude in
            guard latitude != nil else { return }
            recenterToken += 1
        }
        .onChange(of: location.authorizationStatus) { _, status in
            guard status == .denied || status == .restricted else { return }
            recenterToken += 1
        }
        .onChange(of: focusedStopCode) { _, stopCode in
            selectedService = nil
            guard let stopCode, stopCode != expandedNearbyStopCode else { return }
            focusStop(stopCode)
        }
        .task(id: selectedRouteGeometryTaskID) {
            await loadSelectedRouteGeometry()
        }
        .sheet(item: $presentedRoute, onDismiss: showPendingRouteStop) { route in
            BusRouteView(presentation: route) { stopCode in
                pendingRouteStopCode = stopCode
                presentedRoute = nil
            }
        }
        .sheet(item: $presentedAssistanceContext) { context in
            AssistanceFlowView(context: context)
        }
    }

    private func mapStage(topInset: CGFloat) -> some View {
        ContinuousTransitMap(
            stops: dataStore.stops,
            stopsVersion: dataStore.snapshot?.version ?? "empty",
            selectedStopCode: $focusedStopCode,
            selectedService: selectedService,
            selectedRouteSegments: displayedSelectedRouteGeometry,
            mapCentre: $mapCentre,
            visibleLatitudeDelta: $visibleMapLatitudeDelta,
            userCoordinate: location.coordinate,
            recenterToken: recenterToken,
            nearbyResetToken: nearbyResetToken,
            reduceMotion: reduceMotion,
            onSelectStop: selectStopFromMap
        )
        .overlay(alignment: .topLeading) {
            if selectedService != nil {
                returnToStopMapButton
                    .padding(.horizontal, 10)
                    .padding(.top, topInset + 10)
            } else {
                nearbyButton
                    .padding(.horizontal, 10)
                    .padding(.top, topInset + 10)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let selectedService {
                selectedRouteLabel(selectedService)
                    .padding(.horizontal, 10)
                    .padding(.top, topInset + 10)
            } else {
                standardMapControls
                    .padding(.top, topInset)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let selectedService {
                selectedServiceLocationStatus(selectedService)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let context = selectedAssistanceContext {
                AssistanceMapControl(
                    context: context,
                    session: assistanceRequests.session(for: context),
                    action: { presentedAssistanceContext = context }
                )
                .padding(8)
            }
        }
        .overlay(alignment: .top) {
            Text(selectedService == nil ? "Bus stop map" : "Reported bus locations")
                .font(.system(size: 1))
                .foregroundStyle(.clear)
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
                .accessibilityIdentifier(mapAccessibilityIdentifier)
        }
        .overlay(alignment: .bottomLeading) {
            if isUITesting {
                VStack {
                    Text(visibleMapLatitudeDelta.formatted(.number.precision(.fractionLength(6))))
                        .accessibilityIdentifier("map.visibleLatitudeDelta")
                    Text(nearbyStops.map(\.code).joined(separator: ","))
                        .accessibilityIdentifier("map.nearbyStopOrder")
                    Text(testStopPresentation)
                        .accessibilityIdentifier("map.stopPresentation")
                }
                .font(.system(size: 1))
                .foregroundStyle(.clear)
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
            }
        }
    }

    private var standardMapControls: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if dataStore.mode == .mock, !dynamicTypeSize.isAccessibilitySize {
                Label("Mock", systemImage: "testtube.2")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(.regularMaterial, in: Capsule())
                    .accessibilityLabel("Mock data")
                    .accessibilityIdentifier("map.mockBadge")
            }

            Button {
                location.requestLocation()
                if location.coordinate != nil
                    || location.authorizationStatus == .denied
                    || location.authorizationStatus == .restricted {
                    recenterToken += 1
                }
            } label: {
                Image(systemName: location.coordinate == nil ? "scope" : "location.fill")
                    .font(.subheadline.weight(.bold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .tint(Color.pulseNavy)
            .accessibilityLabel(location.coordinate == nil ? "Centre on Singapore" : "Centre on my location")
            .accessibilityIdentifier("map.recenter")
        }
        .padding(10)
    }

    private var returnToStopMapButton: some View {
        Button {
            selectedService = nil
        } label: {
            Label("Stops", systemImage: "chevron.left")
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.pulseNavy)
        .accessibilityLabel("Return to bus stop map")
        .accessibilityIdentifier("map.stopMap")
    }

    private func selectedRouteLabel(_ service: ServiceArrivals) -> some View {
        Label("Service \(service.serviceNo)", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
            .font(.caption.weight(.bold))
            .foregroundStyle(Color.pulseNavy)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(.regularMaterial, in: Capsule())
            .accessibilityLabel("Service \(service.serviceNo) stop sequence shown on map")
            .accessibilityIdentifier("service.routeOverlay.\(service.serviceNo)")
    }

    private func selectedServiceLocationStatus(_ service: ServiceArrivals) -> some View {
        let nextEstimates = Array(service.estimates.prefix(3))
        let reportedCount = nextEstimates.compactMap(\.reportedCoordinate).count
        return Group {
            if reportedCount == 0 {
                Label("No bus locations reported", systemImage: "location.slash")
                    .font(.footnote.weight(.semibold))
            } else {
                Text("\(reportedCount) of \(nextEstimates.count) locations reported")
                    .font(.caption2.weight(.semibold))
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule())
        .padding(8)
        .accessibilityIdentifier("map.busLocationCount")
    }

    private var nearbyButton: some View {
        Button {
            selectedService = nil
            if expandedNearbyStopCode != nil {
                collapseFocusedStop()
            }
            nearbyResetToken += 1
        } label: {
            Label("Nearby stops", systemImage: "bus.doubledecker")
                .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.pulseNavy)
        .accessibilityLabel(expandedNearbyStopCode == nil ? "Nearby stops shown" : "Show all nearby stops")
        .accessibilityIdentifier("map.nearbyStops")
    }

    private var nearbyStopList: some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(nearbyStops) { stop in
                        let isExpanded = expansionBinding(for: stop.code)
                        let model = arrivalBoardModels.model(for: stop.code)
                        Section {
                            if isExpanded.wrappedValue {
                                StopArrivalSectionContent(
                                    stop: stop,
                                    isActive: isActive,
                                    selectedService: $selectedService,
                                    refreshToken: nearbyRefreshToken,
                                    model: model,
                                    onShowRoute: presentRoute
                                )
                            }
                        } header: {
                            StopArrivalSectionHeader(
                                stop: stop,
                                isExpanded: isExpanded,
                                selectedService: $selectedService,
                                model: model
                            )
                            .id(stop.code)
                        }
                    }
                }
                .scrollTargetLayout()
            }
            .scrollBounceBehavior(.basedOnSize)
            .refreshable { nearbyRefreshToken += 1 }
            .accessibilityIdentifier("map.nearbyStopsList")
            .background(Color(.systemBackground))
            .task {
                await Task.yield()
                scrollToRequestedStop(using: scrollProxy, animated: false)
            }
            .onChange(of: focusScrollRevision) { _, _ in
                Task { @MainActor in
                    await Task.yield()
                    scrollToRequestedStop(using: scrollProxy, animated: true)
                }
            }
        }
    }

    private func expansionBinding(for stopCode: String) -> Binding<Bool> {
        Binding(
            get: { expandedNearbyStopCode == stopCode },
            set: { isExpanded in
                if isExpanded {
                    focusStop(stopCode)
                } else if expandedNearbyStopCode == stopCode {
                    collapseFocusedStop()
                }
            }
        )
    }

    private func selectStopFromMap(_ code: String) {
        focusStop(code)
    }

    private func focusStop(_ code: String) {
        hasEstablishedInitialFocus = true
        selectedService = nil
        if !nearbyStops.contains(where: { $0.code == code }),
           let stop = dataStore.stop(code: code) {
            nearbyStops.append(stop)
        }
        setFocusedStop(code)
        requestListFocus(on: code)
    }

    private func setFocusedStop(_ stopCode: String?) {
        selectedService = nil
        expandedNearbyStopCode = stopCode
        focusedStopCode = stopCode
    }

    private func collapseFocusedStop() {
        setFocusedStop(nil)
        requestListFocus(on: nearbyStops.first?.code)
    }

    private func requestListFocus(on stopCode: String?) {
        focusScrollTarget = stopCode
        focusScrollRevision += 1
    }

    private func scrollToRequestedStop(using proxy: ScrollViewProxy, animated: Bool) {
        guard let target = focusScrollTarget ?? expandedNearbyStopCode ?? nearbyStops.first?.code else { return }
        if animated, !reduceMotion {
            withAnimation(.smooth(duration: 0.28)) {
                proxy.scrollTo(target, anchor: .top)
            }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }

    private var selectedRouteStops: [BusStop] {
        guard let selectedService else { return [] }
        return dataStore.route(serviceNo: selectedService.serviceNo, direction: selectedService.direction)
    }

    private var selectedAssistanceContext: AssistanceContext? {
        guard let selectedService,
              let estimate = selectedService.estimates.first,
              let stopCode = expandedNearbyStopCode ?? focusedStopCode,
              let stop = dataStore.stop(code: stopCode) else { return nil }
        return AssistanceContext(stop: stop, service: selectedService, estimate: estimate)
    }

    private func presentRoute(serviceNo: String, direction: Int?) {
        let stops = dataStore.route(serviceNo: serviceNo, direction: direction)
        let resolvedDirection = direction
            ?? dataStore.routes(at: expandedNearbyStopCode ?? "")
                .first(where: { $0.serviceNo == serviceNo })?.direction
            ?? 1
        presentedRoute = BusRoutePresentation(
            serviceNo: serviceNo,
            direction: resolvedDirection,
            stops: stops,
            currentStopCode: expandedNearbyStopCode
        )
    }

    private var selectedRouteGeometryTaskID: String {
        guard let selectedService else { return "none" }
        return "\(selectedService.id):\(selectedRouteStops.map(\.code).joined(separator: ">"))"
    }

    private func loadSelectedRouteGeometry() async {
        guard selectedService != nil, selectedRouteStops.count > 1 else {
            selectedRouteGeometry = []
            selectedRouteGeometryOwner = "none"
            return
        }
        let taskID = selectedRouteGeometryTaskID
        selectedRouteGeometryOwner = taskID
        selectedRouteGeometry = []
        let stops = selectedRouteStops
        let cached = await routeGeometry.cachedGeometry(for: stops)
        guard !Task.isCancelled, taskID == selectedRouteGeometryTaskID else { return }
        selectedRouteGeometry = cached.segments.filter(\.isRoadAligned)
        guard cached.needsRefresh else { return }

        let refined = await routeGeometry.geometry(for: stops)
        guard !Task.isCancelled, taskID == selectedRouteGeometryTaskID else { return }
        selectedRouteGeometry = refined.segments.filter(\.isRoadAligned)
    }

    private var displayedSelectedRouteGeometry: [RouteGeometrySegment] {
        selectedRouteGeometryOwner == selectedRouteGeometryTaskID ? selectedRouteGeometry : []
    }

    private func showPendingRouteStop() {
        guard let stopCode = pendingRouteStopCode else { return }
        pendingRouteStopCode = nil
        focusStop(stopCode)
    }

    private var mapAccessibilityIdentifier: String {
        if let selectedService { return "map.arrivalLocations.\(selectedService.serviceNo)" }
        return "map.busStops"
    }

    private func mapHeight(in availableHeight: CGFloat) -> CGFloat {
        let proportion = dynamicTypeSize.isAccessibilitySize ? 0.20 : 0.34
        let minimum: CGFloat = dynamicTypeSize.isAccessibilitySize ? 118 : 170
        return min(max(availableHeight * proportion, minimum), 270)
    }

    private var nearbyTaskID: String {
        let latitudeBucket = Int((mapCentre.latitude * 10_000).rounded())
        let longitudeBucket = Int((mapCentre.longitude * 10_000).rounded())
        return "\(dataStore.stops.count)-\(latitudeBucket)-\(longitudeBucket)"
    }

    private var isUITesting: Bool {
        ProcessInfo.processInfo.arguments.contains("-ui-testing")
    }

    private var testStopPresentation: String {
        StopMarkerPresentation(latitudeDelta: visibleMapLatitudeDelta).rawValue
    }
}

private struct ContinuousTransitMap: UIViewRepresentable {
    let stops: [BusStop]
    let stopsVersion: String
    @Binding var selectedStopCode: String?
    let selectedService: ServiceArrivals?
    let selectedRouteSegments: [RouteGeometrySegment]
    @Binding var mapCentre: CLLocationCoordinate2D
    @Binding var visibleLatitudeDelta: CLLocationDegrees
    let userCoordinate: CLLocationCoordinate2D?
    let recenterToken: Int
    let nearbyResetToken: Int
    let reduceMotion: Bool
    let onSelectStop: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> MKMapView {
        // MapKit can briefly lay out a representable at zero size during SwiftUI
        // transitions. A minimal valid initial surface avoids handing Metal a
        // 0 x 0 drawable before the real constraints arrive.
        let mapView = MKMapView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        let isUITesting = ProcessInfo.processInfo.arguments.contains("-ui-testing")
        mapView.delegate = context.coordinator
        mapView.accessibilityIdentifier = "map.continuousSurface"
        mapView.accessibilityLabel = "Interactive transit map"
        mapView.showsCompass = true
        mapView.showsScale = false
        mapView.isZoomEnabled = true
        mapView.isScrollEnabled = true
        mapView.isRotateEnabled = true
        mapView.isPitchEnabled = true
        mapView.showsUserLocation = !isUITesting
        mapView.pointOfInterestFilter = .excludingAll
        mapView.register(
            BusStopCodeAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: Coordinator.stopReuseIdentifier
        )
        mapView.register(
            MKMarkerAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: Coordinator.busReuseIdentifier
        )
        let overviewTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleOverviewTap(_:))
        )
        overviewTap.cancelsTouchesInView = false
        overviewTap.delegate = context.coordinator
        mapView.addGestureRecognizer(overviewTap)
        let initialRegion = MKCoordinateRegion(
            center: userCoordinate ?? LocationService.singaporeCentre,
            span: MapCameraDefaults.nearbySpan
        )
        DispatchQueue.main.async {
            context.coordinator.establishInitialRegion(initialRegion, on: mapView)
            context.coordinator.refreshVisibleStopAnnotations(on: mapView)
        }
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.synchronize(on: mapView)
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        static let stopReuseIdentifier = "bus-stop"
        static let busReuseIdentifier = "reported-bus"
        var parent: ContinuousTransitMap
        var lastRecenterToken = 0
        var lastNearbyResetToken = 0
        var lastFocusedStopCode: String?
        private var stopMapRegionBeforeService: MKCoordinateRegion?
        private var displayedServiceID: String?
        private var displayedBusSignature = ""
        private var displayedRouteSignature = ""
        private var routeOverlays: [MKPolyline] = []
        private var overviewOverlay: StopOverviewOverlay?
        private var pendingUpdate: DispatchWorkItem?
        private var suppressNextCentrePublish = false
        private var lastStopPresentation: StopMarkerPresentation?
        private var didEstablishInitialRegion = false

        init(parent: ContinuousTransitMap) {
            self.parent = parent
        }

        func establishInitialRegion(_ region: MKCoordinateRegion, on mapView: MKMapView) {
            guard !didEstablishInitialRegion else { return }
            guard mapView.bounds.width > 1, mapView.bounds.height > 1 else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self, weak mapView] in
                    guard let self, let mapView else { return }
                    self.establishInitialRegion(region, on: mapView)
                }
                return
            }
            didEstablishInitialRegion = true
            suppressNextCentrePublish = true
            mapView.setRegion(region, animated: false)
        }

        func synchronize(on mapView: MKMapView) {
            let nextServiceID = parent.selectedService?.id
            if displayedServiceID != nextServiceID {
                displayedServiceID = nextServiceID
                if let service = parent.selectedService {
                    stopMapRegionBeforeService = mapView.region
                    removeOverviewOverlay(from: mapView)
                    synchronizeRouteOverlay(on: mapView)
                    showReportedBuses(for: service, on: mapView, moveCamera: true)
                } else {
                    displayedBusSignature = ""
                    removeRouteOverlay(from: mapView)
                    mapView.removeAnnotations(mapView.annotations.compactMap { $0 as? ReportedBusAnnotation })
                    refreshVisibleStopAnnotations(on: mapView)
                    if let stopMapRegionBeforeService {
                        setRegion(stopMapRegionBeforeService, on: mapView)
                        self.stopMapRegionBeforeService = nil
                    } else {
                        moveToFocusedStop(on: mapView)
                    }
                }
            } else if let service = parent.selectedService {
                synchronizeRouteOverlay(on: mapView)
                showReportedBuses(for: service, on: mapView, moveCamera: false)
            } else {
                if parent.selectedStopCode == nil {
                    lastFocusedStopCode = nil
                }
                refreshVisibleStopAnnotations(on: mapView)
                moveToFocusedStop(on: mapView)

                if lastRecenterToken != parent.recenterToken {
                    lastRecenterToken = parent.recenterToken
                    setRegion(
                        MKCoordinateRegion(
                            center: parent.userCoordinate ?? LocationService.singaporeCentre,
                            span: MapCameraDefaults.locationSpan
                        ),
                        on: mapView
                    )
                }
                if lastNearbyResetToken != parent.nearbyResetToken {
                    lastNearbyResetToken = parent.nearbyResetToken
                    setRegion(
                        MKCoordinateRegion(
                            center: mapView.centerCoordinate,
                            span: MapCameraDefaults.nearbySpan
                        ),
                        on: mapView
                    )
                }
                refreshSelectionAppearance(on: mapView)
            }
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            parent.visibleLatitudeDelta = mapView.region.span.latitudeDelta
            let shouldPublishCentre = !suppressNextCentrePublish
            suppressNextCentrePublish = false
            pendingUpdate?.cancel()
            let work = DispatchWorkItem { [weak self, weak mapView] in
                guard let self, let mapView else { return }
                guard self.parent.selectedService == nil else { return }
                if shouldPublishCentre {
                    self.parent.mapCentre = mapView.centerCoordinate
                }
                self.refreshVisibleStopAnnotations(on: mapView)
            }
            pendingUpdate = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        }

        func mapView(
            _ mapView: MKMapView,
            viewFor annotation: any MKAnnotation
        ) -> MKAnnotationView? {
            if annotation is MKUserLocation { return nil }
            if let busAnnotation = annotation as? ReportedBusAnnotation,
               let view = mapView.dequeueReusableAnnotationView(
                   withIdentifier: Self.busReuseIdentifier,
                   for: busAnnotation
               ) as? MKMarkerAnnotationView {
                view.annotation = busAnnotation
                view.clusteringIdentifier = nil
                view.displayPriority = .required
                view.markerTintColor = UIColor(Color.pulseNavy)
                view.glyphText = busAnnotation.markerText
                view.glyphImage = nil
                view.titleVisibility = .hidden
                view.subtitleVisibility = .hidden
                view.canShowCallout = false
                view.accessibilityIdentifier = "map.busLocation.\(busAnnotation.serviceNo).\(busAnnotation.arrivalIndex)"
                view.accessibilityLabel = busAnnotation.title
                view.accessibilityValue = busAnnotation.markerText
                return view
            }
            guard let stopAnnotation = annotation as? BusStopAnnotation,
                  let view = mapView.dequeueReusableAnnotationView(
                    withIdentifier: Self.stopReuseIdentifier,
                    for: stopAnnotation
                  ) as? BusStopCodeAnnotationView else { return nil }
            let selected = parent.selectedStopCode == stopAnnotation.stop.code
            configureStopView(view, for: stopAnnotation, selected: selected, on: mapView)
            view.accessibilityIdentifier = "map.stop.\(stopAnnotation.stop.code)"
            view.accessibilityLabel = "Bus stop \(stopAnnotation.stop.code), \(stopAnnotation.stop.displayName)"
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            guard let stopAnnotation = view.annotation as? BusStopAnnotation else { return }
            lastFocusedStopCode = stopAnnotation.stop.code
            suppressNextCentrePublish = true
            mapView.setCenter(stopAnnotation.stop.coordinate, animated: !parent.reduceMotion)
            parent.onSelectStop(stopAnnotation.stop.code)
            mapView.deselectAnnotation(stopAnnotation, animated: false)
        }

        @objc func handleOverviewTap(_ recognizer: UITapGestureRecognizer) {
            guard recognizer.state == .ended,
                  let mapView = recognizer.view as? MKMapView,
                  parent.selectedService == nil,
                  stopPresentation(on: mapView) == .overview,
                  mapView.bounds.width > 0 else { return }

            let tappedPoint = MKMapPoint(mapView.convert(recognizer.location(in: mapView), toCoordinateFrom: mapView))
            let mapPointsPerScreenPoint = mapView.visibleMapRect.size.width / mapView.bounds.width
            let maximumDistance = mapPointsPerScreenPoint * 22
            let maximumDistanceSquared = maximumDistance * maximumDistance
            var nearestStop: BusStop?
            var nearestDistanceSquared = maximumDistanceSquared

            for stop in parent.stops {
                let stopPoint = MKMapPoint(stop.coordinate)
                let distance = Self.distanceSquared(stopPoint, tappedPoint)
                guard distance <= nearestDistanceSquared else { continue }
                nearestStop = stop
                nearestDistanceSquared = distance
            }
            guard let nearestStop else { return }
            lastFocusedStopCode = nearestStop.code
            suppressNextCentrePublish = true
            mapView.setCenter(nearestStop.coordinate, animated: !parent.reduceMotion)
            parent.onSelectStop(nearestStop.code)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            if let overviewOverlay = overlay as? StopOverviewOverlay {
                return StopOverviewRenderer(overlay: overviewOverlay)
            }
            guard routeOverlays.contains(where: { overlay === $0 }) else {
                return MKOverlayRenderer(overlay: overlay)
            }
            let renderer = MKPolylineRenderer(overlay: overlay)
            renderer.strokeColor = UIColor(Color.pulseTeal)
            renderer.lineWidth = 4
            renderer.lineCap = .round
            renderer.lineJoin = .round
            renderer.alpha = 0.9
            return renderer
        }

        func refreshVisibleStopAnnotations(on mapView: MKMapView) {
            guard parent.selectedService == nil else { return }
            let state = PerformanceTrace.signposter.beginInterval("Map viewport update")
            defer { PerformanceTrace.signposter.endInterval("Map viewport update", state) }

            let visibleRect = mapView.visibleMapRect
            let expandedRect = visibleRect.insetBy(
                dx: -visibleRect.size.width * 0.25,
                dy: -visibleRect.size.height * 0.25
            )
            let centre = MKMapPoint(mapView.centerCoordinate)
            let presentation = stopPresentation(on: mapView)
            var current = mapView.annotations.compactMap { $0 as? BusStopAnnotation }

            if presentation == .overview {
                if lastStopPresentation != presentation {
                    mapView.removeAnnotations(current)
                    current = []
                    lastStopPresentation = presentation
                }
                installOverviewOverlay(on: mapView)

                let selectedStop = parent.selectedStopCode
                    .flatMap { code in parent.stops.first(where: { $0.code == code }) }
                mapView.removeAnnotations(current.filter { $0.stop.code != selectedStop?.code })
                if let selectedStop,
                   !current.contains(where: { $0.stop.code == selectedStop.code }) {
                    mapView.addAnnotation(BusStopAnnotation(stop: selectedStop))
                }
                if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
                    mapView.accessibilityValue = "Overview overlay"
                }
                refreshSelectionAppearance(on: mapView)
                return
            }

            removeOverviewOverlay(from: mapView)
            let maximumVisibleStops: Int = switch presentation {
            case .sign: 400
            case .dot: 600
            case .overview: 0
            }
            let visibleStops = parent.stops
                .filter { expandedRect.contains(MKMapPoint($0.coordinate)) }
                .sorted { lhs, rhs in
                    let left = MKMapPoint(lhs.coordinate)
                    let right = MKMapPoint(rhs.coordinate)
                    return Self.distanceSquared(left, centre) < Self.distanceSquared(right, centre)
                }
                .prefix(maximumVisibleStops)

            let desiredCodes = Set(visibleStops.map(\.code))
            if lastStopPresentation != presentation {
                mapView.removeAnnotations(current)
                current = []
                lastStopPresentation = presentation
            }
            let currentCodes = Set(current.map { $0.stop.code })

            mapView.removeAnnotations(current.filter { !desiredCodes.contains($0.stop.code) })
            let newAnnotations = visibleStops
                .filter { !currentCodes.contains($0.code) }
                .map(BusStopAnnotation.init)
            mapView.addAnnotations(newAnnotations)
            if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
                mapView.accessibilityValue = "Annotation views"
            }
            refreshSelectionAppearance(on: mapView)
        }

        private func installOverviewOverlay(on mapView: MKMapView) {
            if overviewOverlay?.version != parent.stopsVersion {
                removeOverviewOverlay(from: mapView)
                let overlay = StopOverviewOverlay(version: parent.stopsVersion, stops: parent.stops)
                overviewOverlay = overlay
                mapView.addOverlay(overlay, level: .aboveLabels)
            }
            guard let overviewOverlay else { return }
            let selectedCode = parent.selectedStopCode
            guard overviewOverlay.selectedStopCode != selectedCode else { return }
            overviewOverlay.selectedStopCode = selectedCode
            mapView.renderer(for: overviewOverlay)?.setNeedsDisplay()
        }

        private func removeOverviewOverlay(from mapView: MKMapView) {
            guard let overviewOverlay else { return }
            mapView.removeOverlay(overviewOverlay)
            self.overviewOverlay = nil
        }

        private func moveToFocusedStop(on mapView: MKMapView) {
            guard let selectedStopCode = parent.selectedStopCode,
                  lastFocusedStopCode != selectedStopCode,
                  let selectedStop = parent.stops.first(where: { $0.code == selectedStopCode }) else { return }
            lastFocusedStopCode = selectedStopCode
            suppressNextCentrePublish = true
            mapView.setCenter(selectedStop.coordinate, animated: !parent.reduceMotion)
        }

        private func showReportedBuses(
            for service: ServiceArrivals,
            on mapView: MKMapView,
            moveCamera: Bool
        ) {
            let estimates = Array(service.estimates.prefix(3))
            let buses = estimates.enumerated().compactMap { index, estimate -> ReportedBusAnnotation? in
                guard let coordinate = estimate.reportedCoordinate else { return nil }
                return ReportedBusAnnotation(
                    estimate: estimate,
                    serviceNo: service.serviceNo,
                    arrivalIndex: index + 1,
                    coordinate: coordinate
                )
            }
            let signature = buses
                .map { "\($0.estimateID):\($0.coordinate.latitude):\($0.coordinate.longitude):\($0.markerText)" }
                .joined(separator: "|")
            guard moveCamera || displayedBusSignature != signature else { return }
            displayedBusSignature = signature

            mapView.removeAnnotations(mapView.annotations.filter { !($0 is MKUserLocation) })
            mapView.addAnnotations(buses)
            let focusedStop = parent.selectedStopCode
                .flatMap { code in parent.stops.first(where: { $0.code == code }) }
            if let focusedStop {
                mapView.addAnnotation(BusStopAnnotation(stop: focusedStop))
            }
            let fallback = focusedStop?.coordinate ?? LocationService.singaporeCentre
            let cameraCoordinates = buses.map(\.coordinate) + [fallback]
            setRegion(Self.region(for: cameraCoordinates, fallback: fallback), on: mapView)
        }

        private func setRegion(_ region: MKCoordinateRegion, on mapView: MKMapView) {
            mapView.setRegion(region, animated: !parent.reduceMotion)
        }

        func refreshSelectionAppearance(on mapView: MKMapView) {
            for annotation in mapView.annotations.compactMap({ $0 as? BusStopAnnotation }) {
                guard let view = mapView.view(for: annotation) as? BusStopCodeAnnotationView else { continue }
                let selected = parent.selectedStopCode == annotation.stop.code
                configureStopView(view, for: annotation, selected: selected, on: mapView)
            }
        }

        private func configureStopView(
            _ view: BusStopCodeAnnotationView,
            for annotation: BusStopAnnotation,
            selected: Bool,
            on mapView: MKMapView
        ) {
            view.annotation = annotation
            let presentation = stopPresentation(on: mapView)
            view.configure(
                stopCode: annotation.stop.code,
                kind: annotation.stop.kind,
                selected: selected,
                presentation: presentation
            )
            view.canShowCallout = false
            view.clusteringIdentifier = nil
            // Close and medium markers stay individually selectable. Overview
            // stops are drawn by one overlay renderer, leaving only the selected
            // stop as an annotation view.
            view.displayPriority = .required
            view.collisionMode = presentation == .sign ? .rectangle : .circle
        }

        private func stopPresentation(on mapView: MKMapView) -> StopMarkerPresentation {
            StopMarkerPresentation(latitudeDelta: mapView.region.span.latitudeDelta)
        }

        private func synchronizeRouteOverlay(on mapView: MKMapView) {
            let signature = parent.selectedRouteSegments.map { segment in
                "\(segment.id):\(segment.coordinates.count):\(segment.coordinates.first?.latitude ?? 0):\(segment.coordinates.last?.longitude ?? 0)"
            }.joined(separator: "|")
            guard signature != displayedRouteSignature else { return }
            removeRouteOverlay(from: mapView)
            displayedRouteSignature = signature
            routeOverlays = parent.selectedRouteSegments.compactMap { segment in
                let coordinates = segment.coordinates.map(\.coordinate).filter(Self.isUsableCoordinate)
                guard coordinates.count > 1,
                      Set(coordinates.map { "\($0.latitude),\($0.longitude)" }).count > 1 else { return nil }
                return MKPolyline(coordinates: coordinates, count: coordinates.count)
            }
            mapView.addOverlays(routeOverlays, level: .aboveRoads)
        }

        private func removeRouteOverlay(from mapView: MKMapView) {
            mapView.removeOverlays(routeOverlays)
            routeOverlays = []
            displayedRouteSignature = ""
        }

        private static func distanceSquared(_ lhs: MKMapPoint, _ rhs: MKMapPoint) -> Double {
            let dx = lhs.x - rhs.x
            let dy = lhs.y - rhs.y
            return dx * dx + dy * dy
        }

        private static func isUsableCoordinate(_ coordinate: CLLocationCoordinate2D) -> Bool {
            coordinate.latitude.isFinite
                && coordinate.longitude.isFinite
                && CLLocationCoordinate2DIsValid(coordinate)
        }

        private static func region(
            for coordinates: [CLLocationCoordinate2D],
            fallback: CLLocationCoordinate2D
        ) -> MKCoordinateRegion {
            guard let first = coordinates.first else {
                return MKCoordinateRegion(
                    center: fallback,
                    span: MKCoordinateSpan(latitudeDelta: 0.018, longitudeDelta: 0.018)
                )
            }

            let latitudes = coordinates.map(\.latitude)
            let longitudes = coordinates.map(\.longitude)
            let minimumLatitude = latitudes.min() ?? first.latitude
            let maximumLatitude = latitudes.max() ?? first.latitude
            let minimumLongitude = longitudes.min() ?? first.longitude
            let maximumLongitude = longitudes.max() ?? first.longitude
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(
                    latitude: (minimumLatitude + maximumLatitude) / 2,
                    longitude: (minimumLongitude + maximumLongitude) / 2
                ),
                span: MKCoordinateSpan(
                    latitudeDelta: max((maximumLatitude - minimumLatitude) * 1.8, 0.008),
                    longitudeDelta: max((maximumLongitude - minimumLongitude) * 1.8, 0.008)
                )
            )
        }
    }
}

private final class ReportedBusAnnotation: NSObject, MKAnnotation {
    let estimateID: String
    let serviceNo: String
    let arrivalIndex: Int
    let coordinate: CLLocationCoordinate2D
    let markerText: String
    let title: String?

    init(
        estimate: ArrivalEstimate,
        serviceNo: String,
        arrivalIndex: Int,
        coordinate: CLLocationCoordinate2D
    ) {
        estimateID = estimate.id
        self.serviceNo = serviceNo
        self.arrivalIndex = arrivalIndex
        self.coordinate = coordinate
        markerText = ArrivalFormatting.mapMarkerCountdown(to: estimate.estimatedArrival, now: .now)
        title = "Bus \(arrivalIndex), \(ArrivalFormatting.countdown(to: estimate.estimatedArrival, now: .now))"
    }
}

private final class BusStopAnnotation: NSObject, MKAnnotation {
    let stop: BusStop
    dynamic var coordinate: CLLocationCoordinate2D { stop.coordinate }
    var title: String? { stop.displayName }
    var subtitle: String? { stop.code }

    init(stop: BusStop) {
        self.stop = stop
    }
}

/// A single MapKit overlay replaces hundreds of annotation views at broad
/// overview spans. MapKit clips renderer work to the invalidated map rect, so
/// panning does not require annotation collision, reuse, or accessibility
/// layout for every stop.
private final class StopOverviewOverlay: NSObject, MKOverlay {
    struct Point {
        let code: String
        let kind: BusStopKind
        let mapPoint: MKMapPoint
    }

    let version: String
    let points: [Point]
    var selectedStopCode: String?
    let coordinate: CLLocationCoordinate2D
    let boundingMapRect = MKMapRect.world

    init(version: String, stops: [BusStop]) {
        self.version = version
        coordinate = stops.first?.coordinate
            ?? CLLocationCoordinate2D(latitude: 1.3521, longitude: 103.8198)
        points = stops.map { stop in
            Point(code: stop.code, kind: stop.kind, mapPoint: MKMapPoint(stop.coordinate))
        }
        super.init()
    }
}

private final class StopOverviewRenderer: MKOverlayRenderer {
    private let regularFill = UIColor(Color.pulseServiceGreen).cgColor
    private let outline = UIColor.white.withAlphaComponent(0.92).cgColor
    private let busFill = UIColor(Color.pulseNavy).cgColor

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let overview = overlay as? StopOverviewOverlay, zoomScale > 0 else { return }
        let trace = PerformanceTrace.signposter.beginInterval("Overview stop overlay draw")
        defer { PerformanceTrace.signposter.endInterval("Overview stop overlay draw", trace) }

        let pointScale = 1 / zoomScale
        let regularDiameter = 6 * pointScale
        let interchangeDiameter = 21 * pointScale
        let expandedRect = mapRect.insetBy(
            dx: -interchangeDiameter,
            dy: -interchangeDiameter
        )
        let regularPath = CGMutablePath()
        var interchangePoints: [MKMapPoint] = []
        interchangePoints.reserveCapacity(16)

        for point in overview.points {
            guard point.code != overview.selectedStopCode,
                  expandedRect.contains(point.mapPoint) else { continue }
            switch point.kind {
            case .regular:
                regularPath.addEllipse(in: CGRect(
                    x: point.mapPoint.x - regularDiameter / 2,
                    y: point.mapPoint.y - regularDiameter / 2,
                    width: regularDiameter,
                    height: regularDiameter
                ))
            case .interchange:
                interchangePoints.append(point.mapPoint)
            }
        }

        context.addPath(regularPath)
        context.setFillColor(regularFill)
        context.fillPath()
        context.addPath(regularPath)
        context.setStrokeColor(outline)
        context.setLineWidth(pointScale)
        context.strokePath()

        for point in interchangePoints {
            drawInterchange(at: point, diameter: interchangeDiameter, pointScale: pointScale, in: context)
        }
    }

    private func drawInterchange(
        at point: MKMapPoint,
        diameter: CGFloat,
        pointScale: CGFloat,
        in context: CGContext
    ) {
        let markerRect = CGRect(
            x: point.x - diameter / 2,
            y: point.y - diameter / 2,
            width: diameter,
            height: diameter
        )
        context.setFillColor(regularFill)
        context.fillEllipse(in: markerRect)
        context.setStrokeColor(outline)
        context.setLineWidth(1.5 * pointScale)
        context.strokeEllipse(in: markerRect.insetBy(dx: 0.75 * pointScale, dy: 0.75 * pointScale))

        // A deliberately simple vector bus remains crisp at any map scale.
        let busBody = CGRect(
            x: point.x - 4.5 * pointScale,
            y: point.y - 5 * pointScale,
            width: 9 * pointScale,
            height: 9 * pointScale
        )
        let bodyPath = CGPath(
            roundedRect: busBody,
            cornerWidth: 1.5 * pointScale,
            cornerHeight: 1.5 * pointScale,
            transform: nil
        )
        context.addPath(bodyPath)
        context.setFillColor(busFill)
        context.fillPath()
        context.setFillColor(outline)
        context.fill(CGRect(
            x: busBody.minX + 1.5 * pointScale,
            y: busBody.minY + 1.5 * pointScale,
            width: busBody.width - 3 * pointScale,
            height: 2.5 * pointScale
        ))
        context.setFillColor(busFill)
        let wheelDiameter = 1.8 * pointScale
        context.fillEllipse(in: CGRect(
            x: busBody.minX + pointScale,
            y: busBody.maxY - 0.3 * pointScale,
            width: wheelDiameter,
            height: wheelDiameter
        ))
        context.fillEllipse(in: CGRect(
            x: busBody.maxX - 2.8 * pointScale,
            y: busBody.maxY - 0.3 * pointScale,
            width: wheelDiameter,
            height: wheelDiameter
        ))
    }
}

private final class BusStopCodeAnnotationView: MKAnnotationView {
    private let signBody = UIView()
    private let codePanel = UIView()
    private let codeLabel = UILabel()
    private let busImageView = UIImageView()
    private let poleView = UIView()
    private let poleCapView = UIView()
    private let dotView = UIView()
    private let interchangeView = UIView()
    private let interchangeBusImageView = UIImageView()

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        frame = CGRect(x: 0, y: 0, width: 66, height: 24)
        centerOffset = CGPoint(x: 0, y: -12)
        backgroundColor = .clear
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.2
        layer.shadowRadius = 2.5
        layer.shadowOffset = CGSize(width: 0, height: 1)

        signBody.backgroundColor = UIColor(Color.pulseServiceGreen)
        signBody.layer.cornerRadius = 6
        signBody.layer.cornerCurve = .continuous
        signBody.layer.borderColor = UIColor.white.withAlphaComponent(0.94).cgColor
        signBody.layer.borderWidth = 1
        addSubview(signBody)

        codePanel.backgroundColor = .white
        codePanel.layer.cornerRadius = 4
        codePanel.layer.cornerCurve = .continuous
        signBody.addSubview(codePanel)

        codeLabel.textAlignment = .center
        codeLabel.textColor = UIColor.black.withAlphaComponent(0.86)
        codeLabel.adjustsFontSizeToFitWidth = true
        codeLabel.minimumScaleFactor = 0.8
        codePanel.addSubview(codeLabel)

        busImageView.image = UIImage(
            systemName: "bus.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)
        )
        busImageView.contentMode = .scaleAspectFit
        busImageView.tintColor = UIColor.black.withAlphaComponent(0.82)
        signBody.addSubview(busImageView)

        poleView.backgroundColor = UIColor.black.withAlphaComponent(0.82)
        poleCapView.backgroundColor = UIColor.black.withAlphaComponent(0.82)
        signBody.addSubview(poleView)
        signBody.addSubview(poleCapView)

        dotView.backgroundColor = UIColor(Color.pulseServiceGreen)
        addSubview(dotView)

        interchangeView.backgroundColor = UIColor(Color.pulseServiceGreen)
        interchangeView.layer.borderColor = UIColor.white.withAlphaComponent(0.95).cgColor
        interchangeView.layer.borderWidth = 1.5
        addSubview(interchangeView)

        interchangeBusImageView.image = UIImage(
            systemName: "bus.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold)
        )
        interchangeBusImageView.tintColor = UIColor(Color.pulseNavy)
        interchangeBusImageView.contentMode = .scaleAspectFit
        interchangeView.addSubview(interchangeBusImageView)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        signBody.frame = bounds
        codePanel.frame = CGRect(x: 24, y: 2, width: bounds.width - 26, height: bounds.height - 4)
        codeLabel.frame = codePanel.bounds.insetBy(dx: 3, dy: 1)
        busImageView.frame = CGRect(x: 4, y: 6, width: 12, height: 12)
        poleView.frame = CGRect(x: 19, y: 5, width: 1.5, height: 14)
        poleCapView.frame = CGRect(x: 17.5, y: 4, width: 4.5, height: 2)
        interchangeBusImageView.frame = interchangeView.bounds.insetBy(dx: 4.5, dy: 4.5)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        codeLabel.text = nil
        transform = .identity
        dotView.isHidden = true
        interchangeView.isHidden = true
    }

    func configure(
        stopCode: String,
        kind: BusStopKind,
        selected: Bool,
        presentation: StopMarkerPresentation
    ) {
        codeLabel.text = stopCode
        codeLabel.font = UIFont(name: TransitTypography.postScriptName, size: 11)
            ?? UIFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        let usesSign = presentation == .sign
        signBody.isHidden = !usesSign
        dotView.isHidden = usesSign || (presentation == .overview && kind == .interchange)
        interchangeView.isHidden = presentation != .overview || kind != .interchange
        if usesSign {
            bounds.size = CGSize(width: 66, height: 24)
            centerOffset = CGPoint(x: 0, y: -12)
            backgroundColor = .clear
            layer.cornerRadius = 0
            layer.borderWidth = 0
            layer.shadowOpacity = 0.2
            signBody.layer.borderColor = selected
                ? UIColor(Color.pulseNavy).cgColor
                : UIColor.white.withAlphaComponent(0.94).cgColor
            signBody.layer.borderWidth = selected ? 2.25 : 1
        } else {
            bounds.size = CGSize(width: 28, height: 28)
            centerOffset = .zero
            backgroundColor = .clear
            layer.cornerRadius = 0
            layer.borderWidth = 0
            layer.shadowOpacity = 0

            if !dotView.isHidden {
                let diameter: CGFloat = presentation == .overview
                    ? (selected ? 13 : 6)
                    : (selected ? 16 : 9)
                dotView.frame = CGRect(
                    x: (bounds.width - diameter) / 2,
                    y: (bounds.height - diameter) / 2,
                    width: diameter,
                    height: diameter
                )
                dotView.layer.cornerRadius = diameter / 2
                dotView.layer.borderColor = selected
                    ? UIColor(Color.pulseNavy).cgColor
                    : UIColor.white.withAlphaComponent(0.9).cgColor
                dotView.layer.borderWidth = selected ? 2.5 : 1
            }

            if !interchangeView.isHidden {
                let diameter: CGFloat = selected ? 25 : 21
                interchangeView.frame = CGRect(
                    x: (bounds.width - diameter) / 2,
                    y: (bounds.height - diameter) / 2,
                    width: diameter,
                    height: diameter
                )
                interchangeView.layer.cornerRadius = diameter / 2
                interchangeView.layer.borderColor = selected
                    ? UIColor(Color.pulseNavy).cgColor
                    : UIColor.white.withAlphaComponent(0.95).cgColor
                interchangeView.layer.borderWidth = selected ? 2.5 : 1.5
            }
        }
        displayPriority = selected ? .required : .defaultHigh
        zPriority = selected ? .max : .defaultUnselected
        setNeedsLayout()
    }
}
