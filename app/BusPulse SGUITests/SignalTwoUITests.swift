import XCTest

/// Drives scripts/boarding_ui_fixture.py through the hub journey's three rounds.
final class SignalTwoUITests: XCTestCase {
    @MainActor
    func testJourneyRoundsFollowTheHub() async throws {
        continueAfterFailure = false
        let (app, address) = try launchAndBook()
        let title = app.staticTexts["assistance.hub.status"]
        XCTAssertTrue(app.descendants(matching: .any)["assistance.proceed"].waitForExistence(timeout: 5))
        await expectLabel(title, "Go to the bus stop")
        // A mismatching aid is a wait, and leaving returns to round 1 instead of latching.
        for (stage, expected) in [(5, "Please wait at the stop"), (1, "Go to the bus stop"),
                                  (2, "Bus arriving"), (3, "Ready to board"), (4, "Follow guidance to seat S03")] {
            try await setStage(stage, address: address)
            await expectLabel(title, expected)
        }
        XCTAssertFalse(app.staticTexts["assistance.boarding.arrived"].exists)
        XCTAssertEqual(app.descendants(matching: .any)["assistance.journey.place"].label, "Your place: Seat S03")
        XCTAssertTrue(app.descendants(matching: .any)["assistance.journey.steps"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Round 3: assigned seat and cabin steps"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(app.buttons["assistance.status.done"].exists)
        XCTAssertFalse(app.buttons["assistance.status.cancel"].exists)
    }

    @MainActor
    func testCancelEndsTheJourney() async throws {
        continueAfterFailure = false
        let (app, _) = try launchAndBook()
        XCTAssertTrue(app.descendants(matching: .any)["assistance.proceed"].waitForExistence(timeout: 5))
        app.buttons["assistance.status.cancel"].tap()
        await expectLabel(app.staticTexts["assistance.hub.status"], "Booking cancelled")
    }

    @MainActor
    private func launchAndBook() throws -> (XCUIApplication, String) {
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
        for _ in 0..<6 where !send.isHittable { app.swipeUp() }
        send.tap()
        return (app, address)
    }

    private func setStage(_ stage: Int, address: String) async throws {
        var command = URLRequest(url: URL(string: address + "/test/stage")!)
        command.httpMethod = "POST"
        command.setValue("application/json", forHTTPHeaderField: "Content-Type")
        command.httpBody = try JSONSerialization.data(withJSONObject: ["stage": stage])
        let (_, response) = try await URLSession.shared.data(for: command)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    @MainActor
    private func expectLabel(_ element: XCUIElement, _ label: String) async {
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: element)
        await fulfillment(of: [expected], timeout: 5)
    }
}
