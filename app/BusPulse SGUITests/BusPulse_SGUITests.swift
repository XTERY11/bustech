import XCTest

final class BusPulseSGUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testMockLaunchAndArrivals() throws {
        let app = launchApp()
        XCTAssertTrue(app.descendants(matching: .any)["map.mockBadge"].waitForExistence(timeout: 5))
        chooseNearbyStop("01012", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["stop.lastUpdated"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.sheets.count, 0)
        let continuousMap = app.descendants(matching: .any)["map.continuousSurface"]
        XCTAssertTrue(continuousMap.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(continuousMap.frame.minY, app.frame.minY + 1)
        XCTAssertFalse(app.navigationBars["BusPulse SG"].exists)

        let focusedStop = app.descendants(matching: .any)
            .matching(NSPredicate(
                format: "identifier BEGINSWITH %@ AND value == %@",
                "map.nearbyStop.",
                "Expanded"
            ))
            .firstMatch
        XCTAssertTrue(focusedStop.waitForExistence(timeout: 3))
        let focusedStopCode = focusedStop.identifier.replacingOccurrences(of: "map.nearbyStop.", with: "")
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.0"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.1"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.2"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["stop.serviceMenu"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["service.destination.7"].exists)

        let service = app.buttons["service.select.7"]
        XCTAssertTrue(service.label.contains("show next bus locations"))

        let firstArrival = app.descendants(matching: .any)["arrival.eta.7.0"]
        XCTAssertTrue(firstArrival.label.contains("Seats available"))
        XCTAssertTrue(firstArrival.label.contains("Single deck"))
        XCTAssertTrue(firstArrival.label.contains("wheelchair accessible"))
        let secondArrival = app.descendants(matching: .any)["arrival.eta.7.1"]
        XCTAssertTrue(secondArrival.label.contains("Standing available"))
        XCTAssertTrue(secondArrival.label.contains("Double deck"))
        XCTAssertTrue(secondArrival.label.contains("not wheelchair accessible"))

        let boardScreenshot = XCTAttachment(screenshot: app.screenshot())
        boardScreenshot.name = "Compact identity tiles and status icons"
        boardScreenshot.lifetime = .keepAlways
        add(boardScreenshot)

        service.tap()
        assertRemainsVisible(continuousMap, duration: 0.7)

        XCTAssertTrue(app.descendants(matching: .any)["map.arrivalLocations.7"].waitForExistence(timeout: 3))
        let locationCount = app.descendants(matching: .any)["map.busLocationCount"]
        XCTAssertTrue(locationCount.waitForExistence(timeout: 3))
        XCTAssertTrue(locationCount.label.contains("3 of 3 locations reported"))
        for index in 1 ... 3 {
            let marker = app.descendants(matching: .any)["map.busLocation.7.\(index)"]
            XCTAssertTrue(marker.waitForExistence(timeout: 3))
            let markerValue = marker.value as? String
            XCTAssertTrue(markerValue == "Now" || markerValue?.hasSuffix("'") == true)
            XCTAssertNotEqual(markerValue, String(index))
        }
        XCTAssertFalse(app.descendants(matching: .any)["map.busStops"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["service.inline.7"].exists)

        let locationScreenshot = XCTAttachment(screenshot: app.screenshot())
        locationScreenshot.name = "Next three bus locations"
        locationScreenshot.lifetime = .keepAlways
        add(locationScreenshot)

        XCTAssertTrue(app.descendants(matching: .any)["service.routeOverlay.7"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["map.stop.\(focusedStopCode)"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.navigationBars.count, 0, "Selecting a service must keep the route on the main map")
    }

    @MainActor
    func testRepeatedNearbyStopSwitchingAlwaysShowsArrivals() throws {
        let app = launchApp()
        XCTAssertTrue(app.buttons["map.nearbyStops"].waitForExistence(timeout: 5))

        chooseNearbyStop("01013", in: app)
        XCTAssertTrue(waitForStop("01013", expanded: true, in: app))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.0"].waitForExistence(timeout: 3))

        chooseNearbyStop("04167", in: app)
        XCTAssertTrue(waitForStop("01013", expanded: false, in: app))
        XCTAssertTrue(waitForStop("04167", expanded: true, in: app))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.14.0"].waitForExistence(timeout: 3))

        chooseNearbyStop("01012", in: app)
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.0"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testNearbyStopsExpandInPlace() throws {
        let app = launchApp()
        chooseNearbyStop("01012", in: app)
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.0"].waitForExistence(timeout: 5))

        app.buttons["map.nearbyStops"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["map.nearbyStopsList"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["map.nearbyStop.01012"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["service.select.7"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["arrival.eta.7.0"].waitForNonExistence(timeout: 3))
        XCTAssertFalse(app.buttons["stop.refresh"].exists)
        XCTAssertFalse(app.buttons["stop.favorite"].exists)

        let nearbyScreenshot = XCTAttachment(screenshot: app.screenshot())
        nearbyScreenshot.name = "Nearby stops top-level list"
        nearbyScreenshot.lifetime = .keepAlways
        add(nearbyScreenshot)

        tapStopLabel(app.buttons["map.nearbyStop.01012"])
        XCTAssertTrue(app.descendants(matching: .any)["map.nearbyStopsList"].exists)
        XCTAssertTrue(app.buttons["map.nearbyStop.01013"].exists)
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 3))
        let refresh = app.buttons["stop.refresh"]
        let favourite = app.buttons["stop.favorite"]
        let disclosure = app.buttons["stop.disclosure.01012"]
        XCTAssertTrue(refresh.isHittable)
        XCTAssertTrue(favourite.isHittable)
        XCTAssertTrue(disclosure.isHittable)
        XCTAssertLessThanOrEqual(abs(refresh.frame.midY - favourite.frame.midY), 1)
        XCTAssertLessThanOrEqual(abs(refresh.frame.midY - disclosure.frame.midY), 1)
        XCTAssertGreaterThanOrEqual(app.frame.maxX - disclosure.frame.maxX, 8)
        let updated = app.staticTexts["stop.lastUpdated"]
        let stopName = app.staticTexts["stop.name"]
        XCTAssertTrue(updated.waitForExistence(timeout: 3))
        XCTAssertTrue(stopName.waitForExistence(timeout: 3))
        XCTAssertLessThan(updated.frame.midY, stopName.frame.midY, "Update time should occupy the metadata line above the stop name")
        XCTAssertLessThanOrEqual(
            app.frame.maxX - updated.frame.maxX,
            16,
            "Update time should align to the stop bar's top-right edge"
        )

        refresh.tap()
        XCTAssertFalse(refresh.isEnabled, "Refresh should stay active for at least one visible rotation")
        XCTAssertTrue(waitForEnabled(refresh, timeout: 3))
        XCTAssertTrue(waitForValue(refresh, equalTo: "Idle"), "Refresh indicator did not stop after the request completed")

        let expandedScreenshot = XCTAttachment(screenshot: app.screenshot())
        expandedScreenshot.name = "Nearby stop expanded in place"
        expandedScreenshot.lifetime = .keepAlways
        add(expandedScreenshot)

        app.buttons["map.nearbyStops"].tap()
        XCTAssertTrue(waitForStop("01012", expanded: false, in: app))
        XCTAssertTrue(app.descendants(matching: .any)["map.nearbyStopsList"].exists)
        XCTAssertTrue(app.buttons["map.nearbyStop.01013"].exists)
        XCTAssertFalse(app.buttons["stop.refresh"].exists)
        XCTAssertFalse(app.buttons["stop.favorite"].exists)
    }

    @MainActor
    func testNearbyStopRowsStayOrderedWithoutOverlapWhileSwitching() throws {
        let app = launchApp()
        let nearby = app.buttons["map.nearbyStops"]
        XCTAssertTrue(nearby.waitForExistence(timeout: 5))
        nearby.tap()

        let first = app.buttons["map.nearbyStop.01012"]
        let second = app.buttons["map.nearbyStop.01013"]
        let third = app.buttons["map.nearbyStop.02049"]
        let nearbyList = app.descendants(matching: .any)["map.nearbyStopsList"]
        XCTAssertTrue(nearbyList.waitForExistence(timeout: 3))
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        XCTAssertTrue(second.waitForExistence(timeout: 3))
        XCTAssertTrue(third.waitForExistence(timeout: 3))
        let renderedOrder = [first, second, third].sorted { $0.frame.minY < $1.frame.minY }
        assertRowsRemainOrdered(renderedOrder, duration: 0.35)

        tapStopLabel(first)
        let firstFocusedHeader = app.buttons["map.nearbyStop.01012"]
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 3))
        XCTAssertLessThan(
            firstFocusedHeader.frame.minY,
            nearbyList.frame.midY,
            "A focused stop should move into the upper portion without inventing blank tail content"
        )
        assertRowsRemainOrdered(renderedOrder, duration: 0.6)

        chooseNearbyStop("01013", in: app)
        XCTAssertTrue(waitForStop("01012", expanded: false, in: app))
        let secondFocusedHeader = app.buttons["map.nearbyStop.01013"]
        XCTAssertTrue(waitForStop("01013", expanded: true, in: app))
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 3))
        XCTAssertLessThan(
            secondFocusedHeader.frame.minY,
            nearbyList.frame.midY,
            "A focused stop should move into the upper portion without inventing blank tail content"
        )
        assertRowsRemainOrdered(renderedOrder, duration: 0.6)

        let alignedScreenshot = XCTAttachment(screenshot: app.screenshot())
        alignedScreenshot.name = "Selected nearby stop focused in list"
        alignedScreenshot.lifetime = .keepAlways
        add(alignedScreenshot)

        nearby.tap()
        assertRowsRemainOrdered(renderedOrder, duration: 0.6)
        XCTAssertTrue(waitForStop("01013", expanded: false, in: app))
        XCTAssertTrue(
            waitForRowAtTop(renderedOrder[0], in: nearbyList, tolerance: 16),
            "Collapsed list did not return to its native top inset: row y \(renderedOrder[0].frame.minY), list y \(nearbyList.frame.minY)"
        )
        XCTAssertFalse(app.buttons["stop.refresh"].exists)
        XCTAssertFalse(app.buttons["stop.favorite"].exists)

        chooseNearbyStop("01012", in: app)
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        let returnedFocusedHeader = app.buttons["map.nearbyStop.01012"]
        XCTAssertLessThan(
            returnedFocusedHeader.frame.minY,
            nearbyList.frame.midY,
            "Returning to a short-list stop should focus it without adding blank tail content"
        )
        assertRowsRemainOrdered(renderedOrder, duration: 0.6)
    }

    @MainActor
    func testRouteSelectionShowsNextThreeBusLocations() throws {
        let app = launchApp()
        chooseNearbyStop("01012", in: app)
        let continuousMap = app.descendants(matching: .any)["map.continuousSurface"]
        XCTAssertTrue(continuousMap.waitForExistence(timeout: 5))
        let service = app.buttons["service.select.7"]
        XCTAssertTrue(service.waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["service.destination.7"].exists)
        let focusedIdentity = app.descendants(matching: .any)
            .matching(NSPredicate(
                format: "identifier BEGINSWITH %@ AND value == %@",
                "map.nearbyStop.",
                "Expanded"
            ))
            .firstMatch
        XCTAssertTrue(focusedIdentity.waitForExistence(timeout: 3))
        let focusedIdentityIdentifier = focusedIdentity.identifier
        service.tap()
        assertRemainsVisible(continuousMap, duration: 0.7)

        let locationMap = app.descendants(matching: .any)["map.arrivalLocations.7"]
        XCTAssertTrue(locationMap.waitForExistence(timeout: 3))
        let locationCount = app.descendants(matching: .any)["map.busLocationCount"]
        XCTAssertTrue(locationCount.waitForExistence(timeout: 3))
        XCTAssertEqual(locationCount.label, "3 of 3 locations reported")
        XCTAssertTrue(app.buttons["map.stopMap"].isHittable)
        XCTAssertTrue(app.descendants(matching: .any)["service.routeOverlay.7"].exists)
        XCTAssertTrue(
            waitForValue(
                app.descendants(matching: .any)[focusedIdentityIdentifier],
                equalTo: "Expanded"
            )
        )
        XCTAssertTrue(app.staticTexts["stop.name"].isHittable)
        XCTAssertTrue(app.buttons["stop.favorite"].isHittable)
        XCTAssertFalse(app.buttons["stop.serviceMenu"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["service.inline.7"].exists)
        XCTAssertFalse(app.segmentedControls["service.arrivalPicker"].exists)

        let routeScreenshot = XCTAttachment(screenshot: app.screenshot())
        routeScreenshot.name = "Inline service route and reported buses"
        routeScreenshot.lifetime = .keepAlways
        add(routeScreenshot)

        service.tap()
        assertRemainsVisible(continuousMap, duration: 0.7)
        XCTAssertTrue(app.descendants(matching: .any)["map.busStops"].waitForExistence(timeout: 3))
        XCTAssertTrue(locationMap.waitForNonExistence(timeout: 3))

        chooseNearbyStop("04167", in: app)
        let partiallyReportedService = app.buttons["service.select.14"]
        XCTAssertTrue(partiallyReportedService.waitForExistence(timeout: 3))
        partiallyReportedService.tap()
        assertRemainsVisible(continuousMap, duration: 0.7)
        let partialCount = app.descendants(matching: .any)["map.busLocationCount"]
        XCTAssertTrue(partialCount.waitForExistence(timeout: 3))
        XCTAssertEqual(partialCount.label, "2 of 3 locations reported")
        app.buttons["map.stopMap"].tap()
        assertRemainsVisible(continuousMap, duration: 0.7)
        XCTAssertTrue(app.descendants(matching: .any)["map.busStops"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testRecenterAndMapStopSelectionKeepOneMapSurface() throws {
        let app = launchApp()
        let continuousMap = app.descendants(matching: .any)["map.continuousSurface"]
        XCTAssertTrue(continuousMap.waitForExistence(timeout: 5))

        let zoomLevel = app.descendants(matching: .any)["map.visibleLatitudeDelta"]
        XCTAssertTrue(zoomLevel.waitForExistence(timeout: 3))
        let initialZoomLabel = zoomLevel.label
        let initialLatitudeDelta = try XCTUnwrap(Double(initialZoomLabel))
        XCTAssertLessThanOrEqual(initialLatitudeDelta, 0.0066, "Default stop-map zoom is still too broad")
        continuousMap.pinch(withScale: 2, velocity: 2)
        let zoomChanged = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", initialZoomLabel),
            object: zoomLevel
        )
        XCTAssertEqual(XCTWaiter.wait(for: [zoomChanged], timeout: 3), .completed)
        let zoomedLatitudeDelta = try XCTUnwrap(Double(zoomLevel.label))
        XCTAssertLessThan(zoomedLatitudeDelta, initialLatitudeDelta)

        let zoomedInLabel = zoomLevel.label
        continuousMap.pinch(withScale: 0.5, velocity: -2)
        let zoomedOut = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", zoomedInLabel),
            object: zoomLevel
        )
        XCTAssertEqual(XCTWaiter.wait(for: [zoomedOut], timeout: 3), .completed)
        let zoomedOutLatitudeDelta = try XCTUnwrap(Double(zoomLevel.label))
        XCTAssertGreaterThan(zoomedOutLatitudeDelta, zoomedLatitudeDelta)

        let recenter = app.buttons["map.recenter"]
        XCTAssertTrue(recenter.waitForExistence(timeout: 3))
        continuousMap.pinch(withScale: 0.45, velocity: -2)
        recenter.tap()
        assertRemainsVisible(continuousMap, duration: 0.7)
        XCTAssertTrue(
            waitForLatitudeDelta(zoomLevel, near: 0.005, relativeTolerance: 0.18),
            "Locate did not apply the closer default span: \(zoomLevel.label)"
        )

        chooseNearbyStop("01013", in: app)
        XCTAssertTrue(waitForStop("01013", expanded: true, in: app))
        continuousMap.pinch(withScale: 2, velocity: 2)
        let zoomBeforeMapSelection = try XCTUnwrap(Double(zoomLevel.label))

        let mapStop = app.descendants(matching: .any)["map.stop.01012"]
        XCTAssertTrue(mapStop.waitForExistence(timeout: 3))
        let selectionStarted = Date()
        mapStop.tap()
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertLessThan(
            Date().timeIntervalSince(selectionStarted),
            3.0,
            "Map-stop selection took too long to update the map and focused list"
        )
        assertRemainsVisible(continuousMap, duration: 0.7)
        XCTAssertTrue(
            waitForLatitudeDelta(zoomLevel, near: zoomBeforeMapSelection, relativeTolerance: 0.08),
            "Selecting a map stop changed zoom from \(zoomBeforeMapSelection) to \(zoomLevel.label)"
        )
        XCTAssertTrue(app.descendants(matching: .any)["map.nearbyStopsList"].exists)

        let zoomBeforeListSelection = try XCTUnwrap(Double(zoomLevel.label))
        let nextListStop = app.buttons
            .matching(NSPredicate(
                format: "identifier BEGINSWITH %@ AND value == %@",
                "map.nearbyStop.",
                "Collapsed"
            ))
            .firstMatch
        XCTAssertTrue(nextListStop.waitForExistence(timeout: 3))
        let nextStopCode = nextListStop.identifier.replacingOccurrences(of: "map.nearbyStop.", with: "")
        tapStopLabel(nextListStop)
        XCTAssertTrue(waitForStop(nextStopCode, expanded: true, in: app))
        XCTAssertTrue(
            waitForLatitudeDelta(zoomLevel, near: zoomBeforeListSelection, relativeTolerance: 0.08),
            "Selecting a list stop changed zoom from \(zoomBeforeListSelection) to \(zoomLevel.label)"
        )

        app.buttons["map.nearbyStops"].tap()
        XCTAssertTrue(
            waitForLatitudeDelta(zoomLevel, near: 0.006, relativeTolerance: 0.18),
            "Nearby Stops did not restore the standard span: \(zoomLevel.label)"
        )
    }

    @MainActor
    func testNearbyStopResultsFollowMapMovement() throws {
        let app = launchApp()
        let map = app.descendants(matching: .any)["map.continuousSurface"]
        let order = app.staticTexts["map.nearbyStopOrder"]
        XCTAssertTrue(map.waitForExistence(timeout: 5))
        XCTAssertTrue(order.waitForExistence(timeout: 3))
        let initialOrder = order.label

        var didChange = false
        for _ in 0 ..< 3 where !didChange {
            map.swipeLeft()
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label != %@", initialOrder),
                object: order
            )
            didChange = XCTWaiter.wait(for: [changed], timeout: 2) == .completed
        }
        XCTAssertTrue(didChange, "Nearby stops stayed fixed after three visible map pans")
    }

    @MainActor
    func testThreeLevelStopMarkersKeepIndividualStopsVisible() throws {
        let app = launchApp()
        let map = app.descendants(matching: .any)["map.continuousSurface"]
        let zoomLevel = app.staticTexts["map.visibleLatitudeDelta"]
        let stopPresentation = app.staticTexts["map.stopPresentation"]
        XCTAssertTrue(map.waitForExistence(timeout: 5))
        XCTAssertTrue(zoomLevel.waitForExistence(timeout: 3))
        XCTAssertTrue(stopPresentation.waitForExistence(timeout: 3))

        let stopMarker = app.descendants(matching: .any)["map.stop.01012"]
        XCTAssertTrue(stopMarker.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(stopMarker.frame.height, 28, "Stop-code marker should stay compact")
        let oppositeStopMarker = app.descendants(matching: .any)["map.stop.01013"]
        XCTAssertTrue(
            oppositeStopMarker.waitForExistence(timeout: 3),
            "Street-level individual mode suppressed the opposite-side stop"
        )

        for _ in 0 ..< 3 where stopPresentation.label != "dot" {
            map.pinch(withScale: 0.6, velocity: -1)
        }
        XCTAssertEqual(stopPresentation.label, "dot", "Medium map spans should replace labels with lightweight dots")
        let dotMarker = app.descendants(matching: .any)["map.stop.01012"]
        XCTAssertTrue(dotMarker.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(dotMarker.frame.height, 30, "Dot visuals should retain a practical invisible hit target without becoming stop-code signs")

        for _ in 0 ..< 3 where stopPresentation.label != "overview" {
            map.pinch(withScale: 0.25, velocity: -2)
        }
        XCTAssertEqual(stopPresentation.label, "overview")
        XCTAssertTrue(
            waitForValue(map, equalTo: "Overview overlay"),
            "Overview should use one renderer instead of hundreds of annotation views"
        )
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "map.stopCluster").count, 0)
        let overviewStop = app.descendants(matching: .any)["map.stop.01012"]
        XCTAssertTrue(overviewStop.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(overviewStop.frame.height, 30)

        let markerScreenshot = XCTAttachment(screenshot: app.screenshot())
        markerScreenshot.name = "Compact stop-code map markers"
        markerScreenshot.lifetime = .keepAlways
        add(markerScreenshot)
    }

    @MainActor
    func testFocusedStopHeaderStaysPinnedWhileDenseRoutesScroll() throws {
        let app = launchApp(additionalArguments: ["-dense-mock-arrivals"])
        chooseNearbyStop("01012", in: app)

        let list = app.descendants(matching: .any)["map.nearbyStopsList"]
        let header = app.buttons["map.nearbyStop.01012"]
        let finalDenseService = app.buttons["service.select.190"]
        XCTAssertTrue(list.waitForExistence(timeout: 3))
        XCTAssertTrue(header.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["service.select.36"].waitForExistence(timeout: 3))
        let pinnedY = header.frame.minY

        for _ in 0 ..< 4 where !finalDenseService.exists {
            list.swipeUp()
            XCTAssertLessThanOrEqual(
                abs(header.frame.minY - pinnedY),
                2,
                "The focused stop header moved instead of pinning to the list top"
            )
        }
        XCTAssertTrue(finalDenseService.waitForExistence(timeout: 3))
        assertVerticalPositionRemainsStable(header, expectedY: pinnedY, duration: 0.8)

        list.swipeDown()
        for _ in 0 ..< 3 where !header.exists {
            list.swipeDown()
        }
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "value == %@", "Collapsed")).firstMatch.exists,
            "Scrolling above the focused section should reveal the preceding stops"
        )
    }

    @MainActor
    func testFocusedStopCanScrollBackToEarlierStopsWithoutRefreshing() throws {
        let app = launchApp(additionalArguments: ["-dense-mock-arrivals"])
        chooseNearbyStop("01013", in: app)

        let list = app.descendants(matching: .any)["map.nearbyStopsList"]
        let refresh = app.buttons["stop.refresh"]
        let finalDenseService = app.buttons["service.select.190"]
        XCTAssertTrue(list.waitForExistence(timeout: 3))
        XCTAssertTrue(refresh.waitForExistence(timeout: 3))

        for _ in 0 ..< 5 where !finalDenseService.exists {
            list.swipeUp()
        }
        XCTAssertTrue(finalDenseService.waitForExistence(timeout: 3))

        let earlierStop = app.buttons["map.nearbyStop.01012"]
        for _ in 0 ..< 6 where !earlierStop.exists || !earlierStop.isHittable {
            list.swipeDown()
        }
        XCTAssertTrue(earlierStop.waitForExistence(timeout: 3), "The focused list discarded stops before the selection")
        XCTAssertTrue(earlierStop.isHittable, "An upward scroll could not reach the preceding stop")
        XCTAssertTrue(waitForValue(refresh, equalTo: "Idle"), "Navigating to an earlier stop incorrectly triggered refresh")
        XCTAssertTrue(waitForStop("01013", expanded: true, in: app))
    }

    @MainActor
    func testFocusedListStopsAtItsRealContentEnd() throws {
        let app = launchApp(additionalArguments: ["-dense-mock-arrivals"])
        chooseNearbyStop("01012", in: app)

        let list = app.descendants(matching: .any)["map.nearbyStopsList"]
        let lastStop = app.buttons["map.nearbyStop.83139"]
        XCTAssertTrue(list.waitForExistence(timeout: 3))

        for _ in 0 ..< 12 where !lastStop.exists || lastStop.frame.maxY > list.frame.maxY {
            list.swipeUp()
        }
        XCTAssertTrue(lastStop.waitForExistence(timeout: 3))

        for _ in 0 ..< 3 {
            list.swipeUp()
        }
        XCTAssertLessThanOrEqual(
            list.frame.maxY - lastStop.frame.maxY,
            120,
            "The list exposes an artificial blank scroll range after its final stop"
        )

        let endScreenshot = XCTAttachment(screenshot: app.screenshot())
        endScreenshot.name = "Focused list bounded at final stop"
        endScreenshot.lifetime = .keepAlways
        add(endScreenshot)
    }

    @MainActor
    func testMixedOperatingStatusKeepsInactiveServicesVisible() throws {
        let app = launchApp(additionalArguments: ["-mixed-operation-mock"])
        chooseNearbyStop("01012", in: app)

        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 5))
        let inactive = app.descendants(matching: .any)["service.inactive.36"]
        XCTAssertTrue(inactive.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Resumes 5:30 AM"].exists)
        XCTAssertGreaterThan(inactive.frame.minY, app.buttons["service.select.16"].frame.minY)

        let mixedStatusScreenshot = XCTAttachment(screenshot: app.screenshot())
        mixedStatusScreenshot.name = "Live services followed by scheduled resumptions"
        mixedStatusScreenshot.lifetime = .keepAlways
        add(mixedStatusScreenshot)
    }

    @MainActor
    func testSearchAndFavouriteFlow() throws {
        let app = launchApp()
        app.tabBars.buttons["Search"].tap()
        let field = app.textFields["search.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("01012")

        let result = app.buttons["search.result.01012"]
        XCTAssertTrue(result.waitForExistence(timeout: 3))
        result.tap()

        let nearbyList = app.descendants(matching: .any)["map.nearbyStopsList"]
        let focusedStop = app.buttons["map.nearbyStop.01012"]
        XCTAssertTrue(nearbyList.waitForExistence(timeout: 3))
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
        XCTAssertLessThan(
            focusedStop.frame.minY,
            nearbyList.frame.midY,
            "Search should focus the canonical stop row near the top without adding fake scroll extent"
        )

        let favourite = app.buttons["stop.favorite"]
        XCTAssertTrue(favourite.waitForExistence(timeout: 3))
        favourite.tap()

        app.tabBars.buttons["Favourites"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["favourite.stop.01012"].waitForExistence(timeout: 3))

        app.terminate()
        app.launchArguments = ["-ui-testing", "-mock-data"]
        app.launch()
        app.tabBars.buttons["Search"].tap()
        let recent = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Recent,"))
            .firstMatch
        XCTAssertTrue(recent.waitForExistence(timeout: 5))
        XCTAssertEqual(recent.identifier, "search.result.01012")
        XCTAssertTrue(recent.label.contains("Recent"))
    }

    @MainActor
    func testSearchByRoadOpensStop() throws {
        let app = launchApp()
        app.tabBars.buttons["Search"].tap()
        let field = app.textFields["search.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("Bras Basah")

        let result = app.buttons["search.result.02049"]
        XCTAssertTrue(result.waitForExistence(timeout: 3))
        result.tap()
        XCTAssertTrue(waitForStop("02049", expanded: true, in: app))
    }

    @MainActor
    func testFavouriteRenamePinningAndRemoval() throws {
        let app = launchApp()
        app.tabBars.buttons["Search"].tap()
        let field = app.textFields["search.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("01012")
        let result = app.buttons["search.result.01012"]
        XCTAssertTrue(result.waitForExistence(timeout: 3))
        result.tap()

        let favourite = app.buttons["stop.favorite"]
        XCTAssertTrue(favourite.waitForExistence(timeout: 3))
        favourite.tap()

        selectTab("Favourites", screenIdentifier: "tab.favourites", in: app)
        let favouriteRow = app.descendants(matching: .any)["favourite.stop.01012"]
        XCTAssertTrue(favouriteRow.waitForExistence(timeout: 3))
        favouriteRow.press(forDuration: 1)
        let rename = app.buttons["Rename"]
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        rename.tap()
        let renameField = app.textFields["Custom stop name"]
        XCTAssertTrue(renameField.waitForExistence(timeout: 3))
        renameField.tap()
        renameField.typeText("Home")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Home"].waitForExistence(timeout: 3))
        favouriteRow.tap()
        let stopName = app.staticTexts["stop.name"]
        XCTAssertTrue(stopName.waitForExistence(timeout: 3))
        XCTAssertEqual(stopName.label, "Home")

        let manageService = app.buttons["service.manage.7"]
        XCTAssertTrue(manageService.waitForExistence(timeout: 3))
        manageService.tap()
        let pin = app.buttons["Pin service"]
        XCTAssertTrue(pin.waitForExistence(timeout: 3))
        XCTAssertTrue(waitForHittable(pin))
        pin.tap()
        let pinnedService = app.buttons["service.select.7"]
        XCTAssertTrue(waitForLabel(pinnedService, containing: "pinned"))
        XCTAssertTrue(pin.waitForNonExistence(timeout: 3))

        selectTab("Favourites", screenIdentifier: "tab.favourites", in: app)
        let pinnedETA = app.descendants(matching: .any)["arrival.eta.7.0"]
        XCTAssertTrue(
            pinnedETA.waitForExistence(timeout: 5),
            "A pinned service should expose its ETA cells directly under the favourite stop"
        )
        let pinnedFavouriteRow = app.descendants(matching: .any)["favourite.stop.01012"]
        XCTAssertTrue(pinnedFavouriteRow.isHittable)
        XCTAssertGreaterThanOrEqual(pinnedETA.frame.minY, pinnedFavouriteRow.frame.maxY - 2)
        let pinnedScreenshot = XCTAttachment(screenshot: app.screenshot())
        pinnedScreenshot.name = "Pinned favourite ETAs"
        pinnedScreenshot.lifetime = .keepAlways
        add(pinnedScreenshot)
        pinnedFavouriteRow.tap()

        let pinnedManageService = app.buttons["service.manage.7"]
        waitUntilHittable(
            pinnedManageService,
            in: app.descendants(matching: .any)["map.nearbyStopsList"]
        )
        pinnedManageService.tap()
        let unpin = app.buttons["Unpin service"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 3))
        XCTAssertTrue(waitForHittable(unpin))
        XCTAssertFalse(app.buttons["Hide service"].exists)
        XCTAssertFalse(app.buttons["Restore service"].exists)
        unpin.tap()
        XCTAssertTrue(waitForLabel(pinnedService, containing: "show next bus locations"))

        selectTab("Favourites", screenIdentifier: "tab.favourites", in: app)
        let row = app.descendants(matching: .any)["favourite.stop.01012"]
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Home"].exists)
        row.tap()
        XCTAssertTrue(app.buttons["stop.favorite"].waitForExistence(timeout: 3))
        app.buttons["stop.favorite"].tap()
        selectTab("Favourites", screenIdentifier: "tab.favourites", in: app)
        XCTAssertTrue(row.waitForNonExistence(timeout: 3))
    }

    @MainActor
    func testDarkLaunchRemainsUsable() throws {
        let app = launchApp()
        XCTAssertTrue(app.descendants(matching: .any)["map.busStops"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Map"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Search"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Favourites"].isHittable)
        XCTAssertTrue(app.tabBars.buttons["Settings"].isHittable)

        app.tabBars.buttons["Settings"].tap()
        let appearance = app.descendants(matching: .any)["settings.appearance"]
        for _ in 0 ..< 5 where !appearance.exists {
            app.swipeUp()
        }
        XCTAssertTrue(appearance.waitForExistence(timeout: 3))
        appearance.tap()
        let dark = app.buttons["Dark"]
        XCTAssertTrue(dark.waitForExistence(timeout: 3))
        dark.tap()
        app.tabBars.buttons["Map"].tap()

        chooseNearbyStop("01012", in: app)
        let firstArrival = app.descendants(matching: .any)["arrival.eta.7.0"]
        XCTAssertTrue(firstArrival.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["stop.favorite"].isHittable)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Dark-mode arrival board"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let manageService = app.buttons["service.manage.7"]
        XCTAssertTrue(manageService.isHittable)
        manageService.tap()
        let busRoute = app.buttons["Bus route"]
        XCTAssertTrue(busRoute.waitForExistence(timeout: 3))
        busRoute.tap()
        let currentRouteStop = app.descendants(matching: .any)["route.stop.01012"]
        XCTAssertTrue(currentRouteStop.waitForExistence(timeout: 3))
        XCTAssertTrue(currentRouteStop.isHittable)
        XCTAssertFalse(app.staticTexts["CURRENT STOP"].exists)

        let routeScreenshot = XCTAttachment(screenshot: app.screenshot())
        routeScreenshot.name = "Dark-mode current route stop"
        routeScreenshot.lifetime = .keepAlways
        add(routeScreenshot)
    }

    @MainActor
    func testAccessibilityDynamicTypeKeepsPrimaryTransitActionsUsable() throws {
        let app = launchApp(additionalArguments: [
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge"
        ])
        chooseNearbyStop("01012", in: app)

        let stopName = app.staticTexts["stop.name"]
        XCTAssertTrue(stopName.waitForExistence(timeout: 5))
        XCTAssertTrue(stopName.isHittable)

        let firstService = app.buttons["service.select.7"]
        XCTAssertTrue(firstService.waitForExistence(timeout: 3))
        XCTAssertTrue(firstService.isHittable)
        XCTAssertTrue(app.buttons["stop.favorite"].isHittable)
        XCTAssertFalse(app.buttons["stop.serviceMenu"].exists)

        firstService.tap()
        XCTAssertTrue(app.descendants(matching: .any)["map.arrivalLocations.7"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["map.stopMap"].isHittable)
    }

    @MainActor
    func testPullToRefreshKeepsArrivalRowsStable() throws {
        let app = launchApp()
        app.tabBars.buttons["Search"].tap()
        let field = app.textFields["search.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("01012")
        let result = app.buttons["search.result.01012"]
        XCTAssertTrue(result.waitForExistence(timeout: 3))
        result.tap()

        let first = app.descendants(matching: .any)["arrival.eta.7.0"]
        let second = app.descendants(matching: .any)["arrival.eta.7.1"]
        let third = app.descendants(matching: .any)["arrival.eta.7.2"]
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        XCTAssertTrue(second.exists)
        XCTAssertTrue(third.exists)
        let status = app.descendants(matching: .any)["stop.lastUpdated"]
        XCTAssertTrue(status.waitForExistence(timeout: 3))
        let previousValue = String(describing: status.value)

        Thread.sleep(forTimeInterval: 1.1)
        let scroll = app.descendants(matching: .any)["map.nearbyStopsList"]
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.82))
        start.press(forDuration: 0.1, thenDragTo: end)

        let changed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value != %@", previousValue),
            object: status
        )
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        XCTAssertTrue(first.exists)
        XCTAssertTrue(second.exists)
        XCTAssertTrue(third.exists)
        XCTAssertTrue(waitForStop("01012", expanded: true, in: app))
    }

    @MainActor
    func testLTAIdentityTypographyCanBeDisabledAndReenabled() throws {
        let app = launchApp()
        app.tabBars.buttons["Settings"].tap()

        let toggle = app.switches["settings.ltaTypography"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 3))
        XCTAssertEqual(toggle.value as? String, "1")

        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitForValue(toggle, equalTo: "0"))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertTrue(waitForValue(toggle, equalTo: "1"))
    }

    @MainActor
    func testDefaultStartScreenPreferenceAppliesOnNextLaunch() throws {
        let app = launchApp()
        selectTab("Settings", screenIdentifier: "tab.settings", in: app)
        let picker = app.descendants(matching: .any)["settings.defaultLaunchTab"]
        for _ in 0 ..< 5 where !picker.exists {
            app.swipeUp()
        }
        XCTAssertTrue(picker.waitForExistence(timeout: 3))
        picker.tap()
        let assistantOption = app.buttons["settings.defaultLaunchTab.assistant"]
        XCTAssertTrue(assistantOption.waitForExistence(timeout: 3))
        assistantOption.tap()

        RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        app.terminate()
        app.launchArguments = ["-ui-testing", "-mock-data"]
        app.launch()

        let assistantTab = app.tabBars.buttons["Assistant"]
        XCTAssertTrue(assistantTab.waitForExistence(timeout: 5))
        XCTAssertTrue(assistantTab.isSelected)
        XCTAssertTrue(app.navigationBars["Assistant"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["assistant.voice.prompt"].exists)
    }

    @MainActor
    func testBusRouteMenuShowsMapAndConnectedStopList() throws {
        let app = launchApp()
        XCTAssertTrue(app.descendants(matching: .any)["map.mockBadge"].waitForExistence(timeout: 8))
        chooseNearbyStop("01013", in: app)
        XCTAssertTrue(app.buttons["service.select.7"].waitForExistence(timeout: 8))
        let manageService = app.buttons["service.manage.7"]
        XCTAssertTrue(manageService.waitForExistence(timeout: 3))
        manageService.tap()

        let pinService = app.buttons["Pin service"]
        let busRoute = app.buttons["Bus route"]
        XCTAssertTrue(pinService.waitForExistence(timeout: 3))
        XCTAssertTrue(busRoute.waitForExistence(timeout: 3))
        XCTAssertTrue(busRoute.isHittable)
        busRoute.tap()

        let routeView = app.descendants(matching: .any)["route.view.7.1"]
        let routeMap = app.descendants(matching: .any)["route.map"]
        let stopList = app.descendants(matching: .any)["route.stopList"]
        XCTAssertTrue(routeView.waitForExistence(timeout: 4))
        XCTAssertTrue(routeMap.waitForExistence(timeout: 3))
        XCTAssertTrue(stopList.waitForExistence(timeout: 3))
        XCTAssertTrue(app.navigationBars["Service 7"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["route.geometryStatus"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["route.refreshGeometry"].isHittable)
        XCTAssertTrue(app.buttons["route.mapStop.01013"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["route.mapStop.01013"].value as? String, "Selected")
        XCTAssertTrue(app.descendants(matching: .any)["route.stop.01012"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["route.stop.01013"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["route.stop.02049"].exists)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Bus route map and connected stop sequence"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let currentRow = app.descendants(matching: .any)["route.stop.01013"]
        XCTAssertTrue(currentRow.isHittable)
        XCTAssertFalse(app.staticTexts["CURRENT STOP"].exists)

        let finalStop = app.descendants(matching: .any)["route.stop.04167"]
        let finalMapStop = app.buttons["route.mapStop.04167"]
        XCTAssertTrue(finalMapStop.isHittable, "Route stop markers need a practical tap target")
        XCTAssertGreaterThanOrEqual(finalMapStop.frame.width, 40)
        XCTAssertGreaterThanOrEqual(finalMapStop.frame.height, 40)
        finalMapStop.tap()
        XCTAssertTrue(
            finalStop.waitForExistence(timeout: 3) && finalStop.isHittable,
            "Selecting a map stop did not scroll the route list to the same stop"
        )
        XCTAssertEqual(app.buttons["route.mapStop.04167"].value as? String, "Selected")
        XCTAssertTrue(app.buttons["route.alightReminder.04167"].exists)

        let selectPreviousStop = app.buttons["route.selectStop.02049"]
        XCTAssertTrue(selectPreviousStop.isHittable)
        selectPreviousStop.tap()
        let previousMapStop = app.buttons["route.mapStop.02049"]
        XCTAssertEqual(previousMapStop.value as? String, "Selected")
        XCTAssertLessThan(abs(previousMapStop.frame.midX - routeMap.frame.midX), 75)
        XCTAssertLessThan(abs(previousMapStop.frame.midY - routeMap.frame.midY), 75)

        for _ in 0 ..< 2 where !finalStop.isHittable {
            stopList.swipeUp()
        }
        let showOnMap = app.buttons["route.showOnMap.04167"]
        XCTAssertTrue(showOnMap.isHittable)
        showOnMap.tap()
        XCTAssertTrue(routeView.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["map.continuousSurface"].exists)
        XCTAssertTrue(waitForStop("04167", expanded: true, in: app))
    }

    @MainActor
    func testVoiceAssistanceProducesStructuredRequestAndVehicleACK() throws {
        let app = launchApp()
        openAssistanceForBus191(in: app)

        let voiceEntry = app.buttons["assistance.chooseVoice"]
        XCTAssertTrue(voiceEntry.waitForExistence(timeout: 3))
        voiceEntry.tap()

        let microphone = app.buttons["assistance.voice.microphone"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 3))
        microphone.tap()

        let transcript = app.staticTexts["assistance.voice.transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 3))
        XCTAssertTrue(waitForValue(transcript, containing: "visually impaired", timeout: 4))

        let response = app.descendants(matching: .any)["assistance.voice.response"]
        XCTAssertTrue(response.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(response, containing: "prepared", timeout: 3))
        XCTAssertFalse(response.label.localizedCaseInsensitiveContains("received your request"))

        let summary = app.descendants(matching: .any)["assistance.summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Vision support"].exists)
        XCTAssertFalse(app.staticTexts["Language"].exists)
        XCTAssertTrue(app.staticTexts["Confirm bus arrival / identity"].exists)
        XCTAssertTrue(app.staticTexts["Audio boarding instruction"].exists)
        XCTAssertTrue(app.staticTexts["Additional boarding time"].exists)

        app.buttons["assistance.voice.confirm"].tap()
        let received = app.descendants(matching: .any)["assistance.status.received"]
        XCTAssertTrue(received.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(received, containing: "Request received by bus"))

        let acknowledgementScreenshot = XCTAttachment(screenshot: app.screenshot())
        acknowledgementScreenshot.name = "Voice assistance vehicle acknowledgement"
        acknowledgementScreenshot.lifetime = .keepAlways
        add(acknowledgementScreenshot)

        app.buttons["Close"].tap()
        let activeControl = app.buttons["assistance.mapControl.191"]
        XCTAssertTrue(activeControl.waitForExistence(timeout: 3))
        XCTAssertTrue(waitForLabel(activeControl, containing: "Assistance requested"))

        activeControl.tap()
        XCTAssertTrue(received.waitForExistence(timeout: 3))
        app.buttons["assistance.status.cancel"].tap()
        XCTAssertTrue(app.staticTexts["Request cancelled"].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
        XCTAssertTrue(waitForLabel(activeControl, containing: "Request Assistance"))
    }

    @MainActor
    func testAssistantTabStartsVoiceFirstAndResolvesTheJourney() throws {
        let app = launchApp()
        selectTab("Assistant", screenIdentifier: "tab.assistant", in: app)

        XCTAssertTrue(app.descendants(matching: .any)["assistant.voice.prompt"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["assistance.chooseVoice"].exists)

        let microphone = app.buttons["assistance.voice.microphone"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(microphone.frame.width, 100)
        microphone.tap()

        let transcript = app.staticTexts["assistance.voice.transcript"]
        XCTAssertTrue(waitForValue(transcript, containing: "stop 01012", timeout: 4))
        let journey = app.descendants(matching: .any)["assistance.journey"]
        XCTAssertTrue(journey.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(journey, containing: "Bus 191"))
        XCTAssertTrue(app.descendants(matching: .any)["assistance.summary"].exists)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Global voice-first Assistant request"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.buttons["assistance.voice.confirm"].tap()
        let received = app.descendants(matching: .any)["assistance.status.received"]
        XCTAssertTrue(received.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(received, containing: "Request received by bus"))
    }

    @MainActor
    func testManualAssistanceUsesTheSameDeliveryStatusFlow() throws {
        let app = launchApp()
        openAssistanceForBus191(in: app)

        app.buttons["assistance.chooseManual"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.manual"].waitForExistence(timeout: 3))

        app.buttons["assistance.action.confirm_bus_arrival_identity"].tap()
        app.buttons["assistance.action.audio_boarding_instruction"].tap()
        app.buttons["assistance.action.additional_boarding_time"].tap()
        let send = app.buttons["assistance.manual.send"]
        XCTAssertTrue(send.isEnabled)
        scrollToElement(send, in: app.scrollViews.firstMatch)
        send.tap()

        let received = app.descendants(matching: .any)["assistance.status.received"]
        XCTAssertTrue(received.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(received, containing: "Request received by bus"))
        XCTAssertFalse(app.descendants(matching: .any)["assistance.voice.response"].exists)
    }

    @MainActor
    func testBoardingGuidanceThirdStage() async throws {
        guard let address = ProcessInfo.processInfo.environment["BOARDING_FIXTURE_URL"] else {
            throw XCTSkip("Start scripts/boarding_ui_fixture.py and set BOARDING_FIXTURE_URL")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-mock-data", "-reset-preferences"]
        app.launchEnvironment["BUSTECH_HUB_URL"] = address
        app.launchEnvironment["BUSTECH_HUB_TOKEN"] = "fixture"
        app.launch()
        app.tabBars.buttons["Assistant"].tap()
        app.buttons["assistant.demoBooking"].tap()
        let send = app.buttons["assistance.manual.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        scrollToElement(send, in: app.scrollViews.firstMatch)
        send.tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.proceed"].waitForExistence(timeout: 5))
        for stage in [2, 3] {
            var command = URLRequest(url: URL(string: address + "/test/stage")!)
            command.httpMethod = "POST"
            command.httpBody = try JSONSerialization.data(withJSONObject: ["stage": stage])
            let (_, response) = try await URLSession.shared.data(for: command)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let identifier = stage == 2 ? "assistance.trigger.confirmed" : "assistance.boarding.arrived"
            XCTAssertTrue(app.staticTexts[identifier].waitForExistence(timeout: 5))
        }
        XCTAssertEqual(app.staticTexts["assistance.boarding.arrived"].label, "The bus is here")
        XCTAssertEqual(app.staticTexts["assistance.boarding.message"].label,
            "Please board through the open entrance and take seat S03 on your left.")
        XCTAssertFalse(app.staticTexts["assistance.trigger.confirmed"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "The bus is here with upstream boarding guidance"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let cancel = app.buttons["assistance.status.cancel"]
        scrollToElement(cancel, in: app.scrollViews.firstMatch)
        cancel.tap()
        XCTAssertTrue(waitForLabel(app.staticTexts["assistance.hub.status"], containing: "Booking cancelled"))
        XCTAssertFalse(app.staticTexts["assistance.boarding.arrived"].exists)
    }

    @MainActor
    func testBusTechBookingAndCancellationWithRealHub() async throws {
        guard let address = ProcessInfo.processInfo.environment["BUSTECH_HUB_URL"],
              let token = ProcessInfo.processInfo.environment["BUSTECH_HUB_TOKEN"] else {
            throw XCTSkip("Run scripts/test-bustech-integration.mjs to start the actual hub")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-mock-data", "-reset-preferences"]
        app.launchEnvironment["BUSTECH_HUB_URL"] = address
        app.launchEnvironment["BUSTECH_HUB_TOKEN"] = token
        app.launch()
        app.tabBars.buttons["Assistant"].tap()
        app.buttons["assistant.demoBooking"].tap()
        let ramp = app.buttons["assistance.action.deploy_wheelchair_ramp"]
        XCTAssertTrue(ramp.waitForExistence(timeout: 5))
        ramp.tap()
        let send = app.buttons["assistance.manual.send"]
        scrollToElement(send, in: app.scrollViews.firstMatch)
        send.tap()
        let status = app.staticTexts["assistance.hub.status"]
        XCTAssertTrue(waitForLabel(status, containing: "Request received by bus"))
        XCTAssertTrue(app.descendants(matching: .any)["assistance.proceed"].exists)
        XCTAssertFalse(app.staticTexts["assistance.trigger.confirmed"].exists)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for triggered in [true, false, true, false] {
            var signal = URLRequest(url: URL(string: address + "/api/perception")!)
            signal.httpMethod = "POST"
            signal.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            signal.setValue("application/json", forHTTPHeaderField: "Content-Type")
            signal.httpBody = try JSONSerialization.data(withJSONObject: [
                "event_id": "ui-trigger-" + UUID().uuidString,
                "observed_at": formatter.string(from: Date()),
                "payload": ["zone": ["triggered": triggered, "roi_id": "test-zone"], "yolo_detections": []]
            ])
            let (_, response) = try await URLSession.shared.data(for: signal)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 202)
            XCTAssertTrue(app.staticTexts["assistance.trigger.confirmed"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.descendants(matching: .any)["assistance.proceed"].exists)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "BusTech real hub passenger feedback"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let cancel = app.buttons["assistance.status.cancel"]
        scrollToElement(cancel, in: app.scrollViews.firstMatch)
        cancel.tap()
        XCTAssertTrue(waitForLabel(app.staticTexts["assistance.hub.status"], containing: "Booking cancelled"))
        XCTAssertFalse(app.staticTexts["assistance.trigger.confirmed"].exists)
    }

    @MainActor
    func testConversationFlagRoundTripAndPersistence() throws {
        let app = launchConversationApp()
        app.tabBars.buttons["Assistant"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation.screen"].waitForExistence(timeout: 5))
        app.terminate()
        app.launchArguments = ["-ui-testing", "-mock-data"]
        app.launch()
        app.tabBars.buttons["Assistant"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation.screen"].waitForExistence(timeout: 5))
        setConversationToggle(false, in: app)
        app.tabBars.buttons["Assistant"].tap()
        XCTAssertTrue(app.buttons["assistance.voice.microphone"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["conversation.screen"].exists)
    }

    @MainActor
    func testConversationChatEntryAndInputSwitch() throws {
        let app = launchConversationApp(arguments: ["-conversation-stop-fixtures"])
        app.tabBars.buttons["Assistant"].tap()
        let question = app.staticTexts["conversation.question"]
        XCTAssertTrue(question.waitForExistence(timeout: 8))
        XCTAssertTrue(question.label.contains("Hi! I can help"))
        XCTAssertLessThanOrEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "conversation.choice.stop_code.")).count, 2)
        let input = app.descendants(matching: .any)["conversation.input"]
        XCTAssertTrue(input.isHittable)
        app.buttons["conversation.inputMode"].tap()
        XCTAssertTrue(app.buttons["conversation.microphone"].isHittable)
        XCTAssertFalse(input.exists)
        app.buttons["conversation.inputMode"].tap()
        XCTAssertTrue(input.isHittable)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Chat entry with a fixed composer and two stop suggestions"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testConversationChoicesCorrectionAndSend() throws {
        let app = launchConversationApp()
        app.tabBars.buttons["Map"].tap()
        openAssistanceForBus191(in: app)
        app.buttons["assistance.chooseVoice"].tap()
        let moreTime = app.buttons["conversation.choice.add_actions.additional_boarding_time"]
        if !moreTime.waitForExistence(timeout: 8) { print(app.debugDescription) }
        XCTAssertTrue(moreTime.exists)
        XCTAssertTrue(waitForEnabled(moreTime))
        moreTime.tap()
        let spoken = app.buttons["conversation.choice.add_actions.audio_boarding_instruction"]
        spoken.tap()
        XCTAssertTrue(moreTime.isSelected)
        XCTAssertTrue(spoken.isSelected)
        app.buttons["conversation.help.continue"].tap()
        let received = app.descendants(matching: .any)["assistance.status.received"]
        if !received.waitForExistence(timeout: 12) { print(app.debugDescription) }
        XCTAssertTrue(received.exists)
        XCTAssertTrue(app.descendants(matching: .any)["conversation.screen"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["conversation.preparations"].exists)
        XCTAssertFalse(app.buttons["conversation.send"].exists)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Automatic submission with feedback inside the conversation"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testConversationFailedDeliveryStaysInChat() throws {
        let app = launchConversationApp(arguments: ["-assistance-send-failure"])
        app.tabBars.buttons["Map"].tap()
        openAssistanceForBus191(in: app)
        app.buttons["assistance.chooseVoice"].tap()
        let moreTime = app.buttons["conversation.choice.add_actions.additional_boarding_time"]
        XCTAssertTrue(moreTime.waitForExistence(timeout: 8))
        moreTime.tap()
        let spoken = app.buttons["conversation.choice.add_actions.audio_boarding_instruction"]
        spoken.tap()
        XCTAssertTrue(moreTime.isSelected)
        XCTAssertTrue(spoken.isSelected)
        app.buttons["conversation.help.continue"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.status.failed"].waitForExistence(timeout: 12))
        let retry = app.buttons["assistance.status.retry"]
        XCTAssertTrue(waitForEnabled(retry))
        retry.tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.status.failed"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.descendants(matching: .any)["assistance.status.received"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["conversation.screen"].exists)
        app.buttons["Edit"].tap()
        enterConversationText("I use a wheelchair", in: app)
        XCTAssertTrue(app.buttons["conversation.choice.ramp.declined"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["conversation.choice.stop_code.01012"].exists)
    }

    @MainActor
    func testConversationTextFollowUpAndLargeType() throws {
        let app = launchConversationApp(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        app.tabBars.buttons["Assistant"].tap()
        let input = app.descendants(matching: .any)["conversation.input"]
        for _ in 0..<6 where !input.isHittable { app.swipeUp() }
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("Bus 191 at stop 01012")
        app.buttons["conversation.addMessage"].tap()
        let stop = app.buttons["conversation.choice.stop_code.01012"]
        for _ in 0..<6 where !stop.isHittable { app.swipeDown() }
        XCTAssertTrue(stop.waitForExistence(timeout: 8)); stop.tap()
        let moreTime = app.buttons["conversation.choice.add_actions.additional_boarding_time"]
        XCTAssertTrue(moreTime.waitForExistence(timeout: 8))
        if !moreTime.isHittable { app.swipeUp() }
        moreTime.tap()
        let spoken = app.buttons["conversation.choice.add_actions.audio_boarding_instruction"]
        spoken.tap()
        XCTAssertTrue(moreTime.isSelected)
        XCTAssertTrue(spoken.isSelected)
        app.buttons["conversation.help.continue"].tap()
        let received = app.descendants(matching: .any)["assistance.status.received"]
        if !received.waitForExistence(timeout: 12) { print(app.debugDescription) }
        XCTAssertTrue(received.exists)
        XCTAssertTrue(app.buttons["conversation.reset"].isHittable)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Conversation with accessibility text size"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testConversationStopSearchThroughTextBox() throws {
        let app = launchConversationApp(arguments: ["-conversation-stop-fixtures"])
        app.tabBars.buttons["Assistant"].tap()
        enterConversationText("B4 the Synergy", in: app)
        let stop = app.buttons["conversation.choice.stop_code.11111"]
        for _ in 0..<6 where !stop.isHittable { app.swipeDown() }
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        XCTAssertTrue(stop.label.contains("Test Road"))
        XCTAssertTrue(app.staticTexts["conversation.question"].label.contains("Is this your stop"))
        XCTAssertFalse(app.buttons["conversation.choice.stop_code.11112"].exists)
        stop.tap()
        XCTAssertTrue(app.buttons["conversation.choice.bus_service.191"].waitForExistence(timeout: 10))
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Named stop resolved through text input"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testConversationOnPhoneTextDialogue() throws {
        let app = launchConversationApp(arguments: ["-conversation-stop-fixtures"])
        app.tabBars.buttons["Assistant"].tap()
        enterConversationText("bef the synergy", in: app)
        let stop = app.buttons["conversation.choice.stop_code.11111"]
        XCTAssertTrue(stop.waitForExistence(timeout: 45))
        enterConversationText("yes", in: app)
        XCTAssertTrue(app.buttons["conversation.choice.bus_service.191"].waitForExistence(timeout: 45))
        enterConversationText("Bus 191. I use a wheelchair and need more time to board.", in: app)
        XCTAssertTrue(app.buttons["conversation.choice.ramp.declined"].waitForExistence(timeout: 45))
        enterConversationText("No ramp, keep the extra time. Wait, I have more to add.", in: app)
        XCTAssertFalse(app.descendants(matching: .any)["assistance.status.received"].exists)
        enterConversationText("I also have difficulty seeing. Help me identify my bus.", in: app)
        XCTAssertFalse(app.descendants(matching: .any)["assistance.status.received"].exists)
        enterConversationText("send my request", in: app)
        // Search-only fixtures have routes but no upcoming arrivals; never invent one.
        let unavailable = app.descendants(matching: .any)["conversation.error"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 10))
        XCTAssertTrue(unavailable.label.contains("no upcoming arrival"))
        XCTAssertFalse(app.descendants(matching: .any)["assistance.status.received"].exists)
        enterConversationText("Bus 191 at stop 01012", in: app)
        let correctedStop = app.buttons["conversation.choice.stop_code.01012"]
        XCTAssertTrue(correctedStop.waitForExistence(timeout: 10))
        correctedStop.tap()
        let received = app.descendants(matching: .any)["assistance.status.received"]
        if !received.waitForExistence(timeout: 12) { print(app.debugDescription) }
        XCTAssertTrue(received.exists)
        XCTAssertTrue(app.descendants(matching: .any)["conversation.screen"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["conversation.preparations"].exists)
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "On-phone dialogue using explicit model fixtures, no server"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    private func enterConversationText(_ value: String, in app: XCUIApplication) {
        let input = app.descendants(matching: .any)["conversation.input"]
        for _ in 0..<8 where !input.isHittable { app.swipeUp() }
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: input)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 45), .completed)
        input.tap(); input.typeText(value)
        app.buttons["conversation.addMessage"].tap()
        let transcript = app.staticTexts["conversation.transcript"]
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", value), object: transcript)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 45), .completed)
    }

    @MainActor
    func testAssistantKeysSurviveColdLaunch() throws {
        let app = launchApp(additionalArguments: ["-reset-assistant-keys"])
        setConversationToggle(true, in: app)
        let setup = app.buttons["settings.assistantKeys"]
        for _ in 0..<5 where !setup.isHittable { app.swipeUp() }
        setup.tap()
        let groq = app.secureTextFields["assistantKeys.groq"]
        XCTAssertTrue(groq.waitForExistence(timeout: 5))
        groq.tap(); groq.typeText("synthetic-groq")
        let deepSeek = app.secureTextFields["assistantKeys.deepSeek"]
        deepSeek.tap(); deepSeek.typeText("synthetic-deepseek")
        app.buttons["assistantKeys.save"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings.assistantKeysSaved"].waitForExistence(timeout: 5))
        app.terminate()
        app.launchArguments = ["-ui-testing", "-mock-data"]
        app.launch()
        setConversationToggle(true, in: app)
        let saved = app.descendants(matching: .any).matching(identifier: "settings.assistantKeysSaved").firstMatch
        for _ in 0..<5 where !saved.isHittable { app.swipeUp() }
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Keys retained in Keychain after cold launch (synthetic keys)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testDirectAssistantSettingsWithoutCredentials() throws {
        let app = launchApp(additionalArguments: ["-reset-assistant-keys"])
        setConversationToggle(true, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["settings.assistantDirect"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["settings.assistantAddress"].exists)
        XCTAssertFalse(app.secureTextFields["settings.assistantAccessCode"].exists)
        let check = app.buttons["settings.checkAssistant"]
        for _ in 0..<5 where !check.isHittable { app.swipeUp() }
        check.tap()
        XCTAssertTrue(app.staticTexts["Add your API keys in Settings → Assistant → Add API keys, or choose help manually."].waitForExistence(timeout: 5))
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "Direct assistant without configured credentials or Mac address"
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testConversationMissingSetupOffersManualRecovery() throws {
        let app = launchApp(additionalArguments: ["-reset-assistant-keys"])
        setConversationToggle(true, in: app)
        app.tabBars.buttons["Assistant"].tap()
        let error = app.descendants(matching: .any)["conversation.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains("API keys"))
        XCTAssertFalse(app.buttons["conversation.send"].exists)
        let manual = app.buttons["conversation.manual"]
        for _ in 0..<5 where !manual.isHittable { app.swipeUp() }
        manual.tap()
        XCTAssertTrue(app.tabBars.buttons["Map"].isSelected)
    }

    @MainActor
    private func launchConversationApp(arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-mock-data", "-reset-preferences"] + arguments
        app.launchArguments.append("-direct-assistant-fixture")
        app.launchEnvironment["BUSTECH_HUB_URL"] = ""
        app.launch()
        setConversationToggle(true, in: app)
        return app
    }

    @MainActor
    private func setConversationToggle(_ enabled: Bool, in app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        let toggle = app.switches["settings.conversationalAssistant"]
        for _ in 0..<14 where !toggle.isHittable || toggle.frame.maxY > app.frame.maxY - 110 { app.swipeUp() }
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        if (toggle.value as? String == "1") != enabled {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        XCTAssertTrue(waitForValue(toggle, equalTo: enabled ? "1" : "0"))
    }

    @MainActor
    private func waitForEnabled(_ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 8) == .completed
    }

    @MainActor
    func testMockLaunchPerformance() throws {
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(
            metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)],
            options: options
        ) {
            let app = XCUIApplication()
            app.launchArguments = ["-ui-testing", "-mock-data", "-reset-preferences"]
            app.launch()
        }
    }

    @MainActor
    private func launchApp(additionalArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-mock-data", "-reset-preferences"] + additionalArguments
        app.launchEnvironment["BUSTECH_HUB_URL"] = ""
        app.launch()
        return app
    }

    @MainActor
    private func openAssistanceForBus191(in app: XCUIApplication) {
        chooseNearbyStop("01012", in: app)
        let list = app.descendants(matching: .any)["map.nearbyStopsList"]
        let service = app.buttons["service.select.191"]
        XCTAssertTrue(list.waitForExistence(timeout: 3))
        scrollToElement(service, in: list)
        XCTAssertTrue(service.waitForExistence(timeout: 3))
        XCTAssertTrue(service.isHittable)
        service.tap()

        let control = app.buttons["assistance.mapControl.191"]
        XCTAssertTrue(control.waitForExistence(timeout: 3))
        XCTAssertTrue(control.isHittable)
        control.tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.entry"].waitForExistence(timeout: 3))
    }

    @MainActor
    private func scrollToElement(_ element: XCUIElement, in scrollView: XCUIElement) {
        for _ in 0 ..< 6 where !element.isHittable {
            scrollView.swipeUp()
        }
    }

    @MainActor
    private func waitForLabel(
        _ element: XCUIElement,
        containing text: String,
        timeout: TimeInterval = 3
    ) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", text)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func waitForValue(
        _ element: XCUIElement,
        equalTo value: String,
        timeout: TimeInterval = 3
    ) -> Bool {
        let predicate = NSPredicate(format: "value == %@", value)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func waitForValue(
        _ element: XCUIElement,
        containing text: String,
        timeout: TimeInterval = 3
    ) -> Bool {
        let predicate = NSPredicate(format: "value CONTAINS[c] %@", text)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func chooseNearbyStop(_ code: String, in app: XCUIApplication) {
        let currentRow = app.buttons["map.nearbyStop.\(code)"]
        if currentRow.exists, currentRow.value as? String == "Expanded" {
            return
        }
        let nearbyList = app.descendants(matching: .any)["map.nearbyStopsList"]
        if !nearbyList.exists {
            let nearbyStops = app.buttons["map.nearbyStops"]
            XCTAssertTrue(nearbyStops.waitForExistence(timeout: 3))
            nearbyStops.tap()
        }
        XCTAssertTrue(nearbyList.waitForExistence(timeout: 3))
        let option = app.buttons["map.nearbyStop.\(code)"]
        if !option.exists || !option.isHittable, app.buttons["stop.refresh"].exists {
            let nearbyStops = app.buttons["map.nearbyStops"]
            XCTAssertTrue(nearbyStops.waitForExistence(timeout: 3))
            nearbyStops.tap()
        }
        for _ in 0 ..< 5 where !option.exists || !option.isHittable {
            nearbyList.swipeDown()
        }
        for _ in 0 ..< 10 where !option.exists || !option.isHittable {
            nearbyList.swipeUp()
        }
        XCTAssertTrue(option.waitForExistence(timeout: 3))
        XCTAssertTrue(option.isHittable)
        tapStopLabel(option)
    }

    @MainActor
    private func tapStopLabel(_ stopRow: XCUIElement) {
        stopRow.tap()
    }

    @MainActor
    private func waitForStop(
        _ code: String,
        expanded: Bool,
        in app: XCUIApplication,
        timeout: TimeInterval = 3
    ) -> Bool {
        let row = app.buttons["map.nearbyStop.\(code)"]
        if expanded {
            guard row.waitForExistence(timeout: timeout) else { return false }
            return waitForValue(row, equalTo: "Expanded", timeout: timeout)
        }

        // A collapsed lazy row may be outside the rendered viewport after a
        // different row moves to the top. Both absence and the explicit
        // collapsed state prove that it is no longer expanded.
        let predicate = NSPredicate(format: "exists == 0 OR value == %@", "Collapsed")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: row)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func assertRemainsVisible(_ element: XCUIElement, duration: TimeInterval) {
        let end = Date().addingTimeInterval(duration)
        while Date() < end {
            XCTAssertTrue(element.exists, "The persistent map surface disappeared during a camera transition")
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
    }

    @MainActor
    private func assertRowsRemainOrdered(_ rows: [XCUIElement], duration: TimeInterval) {
        let end = Date().addingTimeInterval(duration)
        while Date() < end {
            let renderedRows = rows.filter(\.exists)
            XCTAssertFalse(renderedRows.isEmpty)
            for row in renderedRows {
                XCTAssertGreaterThan(row.frame.height, 0)
            }
            for pair in zip(renderedRows, renderedRows.dropFirst()) {
                XCTAssertLessThanOrEqual(
                    pair.0.frame.maxY,
                    pair.1.frame.minY + 1,
                    "Nearby stop rows overlapped or changed order during selection"
                )
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.03))
        }
    }

    @MainActor
    private func waitUntilHittable(_ element: XCUIElement, in scrollView: XCUIElement) {
        let settled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == true"),
            object: element
        )
        if XCTWaiter.wait(for: [settled], timeout: 1) != .completed {
            scrollToElement(element, in: scrollView)
        }
        let visible = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == true"),
            object: element
        )
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 3), .completed)
    }

    @MainActor
    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == true"),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func waitForRowAtTop(
        _ row: XCUIElement,
        in scrollView: XCUIElement,
        tolerance: CGFloat = 8,
        timeout: TimeInterval = 3
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if row.exists,
               scrollView.exists,
               abs(row.frame.minY - scrollView.frame.minY) <= tolerance {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        return false
    }

    @MainActor
    private func waitForLatitudeDelta(
        _ element: XCUIElement,
        near expected: Double,
        relativeTolerance: Double,
        timeout: TimeInterval = 3
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = Double(element.label),
               abs(value - expected) <= expected * relativeTolerance {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        return false
    }

    @MainActor
    private func waitForLatitudeDeltaLessThan(
        _ element: XCUIElement,
        _ maximum: Double,
        timeout: TimeInterval = 4
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = Double(element.label), value < maximum {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        return false
    }

    @MainActor
    private func assertVerticalPositionRemainsStable(
        _ element: XCUIElement,
        expectedY: CGFloat,
        duration: TimeInterval
    ) {
        let end = Date().addingTimeInterval(duration)
        while Date() < end {
            XCTAssertTrue(element.exists)
            XCTAssertLessThanOrEqual(abs(element.frame.minY - expectedY), 2)
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
    }

    @MainActor
    private func waitForVerticalPosition(
        _ element: XCUIElement,
        near expectedY: CGFloat,
        tolerance: CGFloat = 2,
        timeout: TimeInterval = 3
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists, abs(element.frame.minY - expectedY) <= tolerance {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        }
        return false
    }

    @MainActor
    private func selectTab(
        _ label: String,
        screenIdentifier: String,
        in app: XCUIApplication
    ) {
        let tab = app.tabBars.buttons[label]
        XCTAssertTrue(tab.waitForExistence(timeout: 3))
        tab.tap()

        let screen = app.descendants(matching: .any)[screenIdentifier]
        if !screen.waitForExistence(timeout: 1) {
            tab.tap()
        }
        XCTAssertTrue(screen.waitForExistence(timeout: 3))
    }
}
