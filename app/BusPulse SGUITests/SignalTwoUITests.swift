import XCTest

final class SignalTwoUITests: XCTestCase {
    @MainActor
    func testExitShowsBoardingPromptAndKeepsGuidance() async throws {
        continueAfterFailure = false
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
        XCTAssertTrue(app.descendants(matching: .any)["assistance.proceed"].waitForExistence(timeout: 5))
        let heading = app.staticTexts["assistance.boarding.arrived"]
        let message = app.staticTexts["assistance.boarding.message"]
        let guidance = "Please board through the open entrance and take seat S03 on your left."
        for stage in [2, 3, 4, 1] {
            var command = URLRequest(url: URL(string: address + "/test/stage")!)
            command.httpMethod = "POST"
            command.httpBody = try JSONSerialization.data(withJSONObject: ["stage": stage])
            let (_, response) = try await URLSession.shared.data(for: command)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if stage == 2 {
                XCTAssertTrue(app.staticTexts["assistance.trigger.confirmed"].waitForExistence(timeout: 5))
            } else {
                let title = stage == 3 ? "The bus is here" : "Please board the bus"
                let expected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", title), object: heading)
                await fulfillment(of: [expected], timeout: 5)
                XCTAssertEqual(message.label, guidance)
            }
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Signal 2 boarding prompt with preserved guidance"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["assistance.status.cancel"].tap()
        let cancelled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Booking cancelled"),
                                                object: app.staticTexts["assistance.hub.status"])
        await fulfillment(of: [cancelled], timeout: 5)
        XCTAssertFalse(heading.exists)
    }
}
