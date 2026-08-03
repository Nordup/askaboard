import XCTest

final class MathTutorUITests: XCTestCase {
    func testLaunchShowsTutorOnboarding() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-reset"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Math Tutor"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["Message your math tutor"].exists)
        XCTAssertTrue(app.staticTexts["Setup required · add API key in Settings"].exists)
        XCTAssertTrue(app.buttons["open-api-key-settings"].exists)
        XCTAssertFalse(app.staticTexts["Demo tutor · works offline"].exists)
    }

    func testGenericAlgebraPromptStaysInChatWithoutInventedWorkspace() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-reset"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Connect your tutor"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["I want to get better at algebra"].exists)
        XCTAssertFalse(app.buttons["start-working"].exists)
        XCTAssertFalse(app.staticTexts["Apple Pencil workspace"].exists)
    }

    func testSettingsSubmitSavesPlaceholderViaKeyboard() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-reset"]
        app.launch()

        let settings = app.buttons["Tutor settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()

        let keyField = app.secureTextFields.firstMatch
        XCTAssertTrue(keyField.waitForExistence(timeout: 5))
        keyField.tap()
        keyField.typeText("ui-test-placeholder-key")
        let keyboardSave = app.buttons["save-key-keyboard"]
        XCTAssertTrue(keyboardSave.waitForExistence(timeout: 3))
        keyboardSave.tap()

        // Dismiss the keyboard before checking the form status; the keyboard and
        // navigation bar both expose a Done button in the accessibility tree.
        dismissKeyboardIfPresent(in: app)
        let savedConfirmation = app.staticTexts["Saved securely in this device’s Keychain."]
        XCTAssertTrue(revealInSettings(savedConfirmation, in: app))
        dismissSettings(in: app)
        XCTAssertTrue(app.staticTexts["Live tutor · Luna · high reasoning"].waitForExistence(timeout: 5))

        // Leave the simulator's Keychain in the same setup-required state as the test began.
        // The DEBUG --ui-test-reset launch behavior also clears inherited credentials
        // before each test process starts; this explicit removal is test teardown.
        settings.tap()
        let remove = app.buttons["Remove saved key"]
        XCTAssertTrue(revealInSettings(remove, in: app))
        remove.tap()
        let removedConfirmation = app.staticTexts["Key removed. Add a key to resume live tutoring."]
        XCTAssertTrue(revealInSettings(removedConfirmation, in: app))
        dismissSettings(in: app)
        XCTAssertTrue(app.staticTexts["Setup required · add API key in Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect your tutor"].exists)
        XCTAssertFalse(app.textFields["Message your math tutor"].exists)
    }

    func testE2ESeedLaunchOpensRadicalWorkspace() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-reset", "--ui-test-demo-service", "--e2e-seed-radical-attempt"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Apple Pencil workspace"].waitForExistence(timeout: 8))

        // The full-screen chat is an overlay over the same workspace view. Going
        // there and back must preserve the board/session route rather than
        // constructing a second store or losing the floating panel state.
        let expandChat = app.buttons["expand-full-chat"]
        XCTAssertTrue(expandChat.waitForExistence(timeout: 3))
        expandChat.tap()
        let backToWhiteboard = app.buttons["back-to-whiteboard"]
        XCTAssertTrue(backToWhiteboard.waitForExistence(timeout: 5))
        backToWhiteboard.tap()
        XCTAssertTrue(app.staticTexts["Apple Pencil workspace"].waitForExistence(timeout: 5))

        let evaluate = app.buttons["Evaluate board"]
        XCTAssertTrue(evaluate.waitForExistence(timeout: 3))
        evaluate.tap()
        XCTAssertTrue(app.staticTexts["Feedback"].waitForExistence(timeout: 8))
        guard let expectedReply = firstStaticTextLabel(containing: "I’m looking at", in: app) else {
            XCTFail("The seeded evaluation reply should be visible in the highlighted panel feedback")
            return
        }

        let expandAfterEvaluation = app.buttons["expand-full-chat"]
        XCTAssertTrue(expandAfterEvaluation.waitForExistence(timeout: 3))
        expandAfterEvaluation.tap()
        let fullChatReply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expectedReply)).firstMatch
        XCTAssertTrue(fullChatReply.waitForExistence(timeout: 5), "The exact evaluation reply must be present in full chat history")

        let returnToWhiteboard = app.buttons["back-to-whiteboard"]
        XCTAssertTrue(returnToWhiteboard.waitForExistence(timeout: 5))
        returnToWhiteboard.tap()
        XCTAssertTrue(app.staticTexts["Apple Pencil workspace"].waitForExistence(timeout: 5))

        let dismissFeedback = app.buttons["Dismiss feedback"]
        XCTAssertTrue(dismissFeedback.waitForExistence(timeout: 5))
        dismissFeedback.tap()
        let returnedPanelReply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expectedReply)).firstMatch
        XCTAssertTrue(returnedPanelReply.waitForExistence(timeout: 5), "Dismissing the highlight must leave the evaluation reply in panel history")
    }

    /// Runs only when explicitly requested against a device with the real,
    /// persisted workspace and API key. This deliberately does not use any
    /// reset/demo/seed launch arguments, so a missing workspace or key is
    /// reported as evidence instead of being papered over by test setup.
    func testLiveBoardEvaluationSeesPersistedAttempt() throws {
        guard ProcessInfo.processInfo.environment["RUN_LIVE_BOARD_E2E"] == "1" else {
            throw XCTSkip("Set RUN_LIVE_BOARD_E2E=1 to run the live-device board test")
        }

        let app = XCUIApplication()
        app.launch()

        let workspace = app.staticTexts["Apple Pencil workspace"]
        guard workspace.waitForExistence(timeout: 20) else {
            let labels = visibleStaticTextLabels(in: app)
            let evidence = sanitized(labels.joined(separator: " | "))
            if app.staticTexts["Setup required · add API key in Settings"].exists {
                XCTFail("Live board E2E could not enter the workspace: persisted API key is unavailable. Visible labels: \(evidence)")
            } else {
                XCTFail("Live board E2E could not enter the persisted workspace. Visible labels: \(evidence)")
            }
            return
        }

        let evaluate = app.buttons["Evaluate board"]
        guard evaluate.waitForExistence(timeout: 10) else {
            let evidence = sanitized(visibleStaticTextLabels(in: app).joined(separator: " | "))
            XCTFail("Live board E2E found the workspace but not Evaluate board. Visible labels: \(evidence)")
            return
        }
        evaluate.tap()

        let feedback = app.staticTexts["Feedback"]
        guard feedback.waitForExistence(timeout: 90) else {
            let evidence = sanitized(visibleStaticTextLabels(in: app).joined(separator: " | "))
            XCTFail("Live board E2E did not receive Feedback within 90 seconds. Visible labels: \(evidence)")
            return
        }

        let labels = visibleStaticTextLabels(in: app)
        let feedbackIndex = labels.firstIndex { $0.caseInsensitiveCompare("Feedback") == .orderedSame } ?? labels.count
        let feedbackLabels = Array(labels.dropFirst(feedbackIndex + (feedbackIndex < labels.count ? 1 : 0)))
            .filter { $0.caseInsensitiveCompare("Dismiss feedback") != .orderedSame }
        let feedbackText = sanitized(feedbackLabels.joined(separator: " | "))
        print("LIVE_BOARD_E2E_FEEDBACK: \(feedbackText)")

        XCTAssertFalse(feedbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Live Feedback text was empty")

        let lowercasedFeedback = feedbackText.lowercased()
        let emptyBoardClaims = [
            "image is empty", "image appears empty", "image looks empty",
            "board is empty", "board appears empty", "board looks empty",
            "image is blank", "image appears blank", "image looks blank",
            "board is blank", "board appears blank", "board looks blank",
            "nothing is visible", "nothing visible", "no visible work",
            "no handwriting is visible", "no writing is visible",
            "i can't see anything", "i cannot see anything",
            "i can't see the board", "i cannot see the board",
            "i can't see any writing", "i cannot see any writing",
            "unable to see the board", "unseen image", "unseen board"
        ]
        XCTAssertFalse(
            emptyBoardClaims.contains(where: lowercasedFeedback.contains),
            "Live Feedback claimed the board/image was empty, blank, or unseen: \(feedbackText)"
        )

        let boardTokens = ["18", "27", "45", "3/4", "1/2", "1.25", "2x", "17", "x", "6"]
        XCTAssertTrue(
            boardTokens.contains(where: { containsBoardToken($0, in: feedbackText) }),
            "Live Feedback did not reference a visible saved-board token (expected one of \(boardTokens)): \(feedbackText)"
        )
    }

    private func dismissKeyboardIfPresent(in app: XCUIApplication) {
        let keyboardDone = app.keyboards.buttons["Done"]
        if keyboardDone.waitForExistence(timeout: 2) { keyboardDone.tap() }
    }

    private func dismissSettings(in app: XCUIApplication) {
        dismissKeyboardIfPresent(in: app)
        let done = app.navigationBars["Settings"].buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
    }

    private func revealInSettings(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        if element.waitForExistence(timeout: 2) { return true }
        for _ in 0..<5 {
            app.swipeUp()
            if element.waitForExistence(timeout: 1) { return true }
        }
        return element.exists
    }

    private func firstStaticTextLabel(containing fragment: String, in app: XCUIApplication) -> String? {
        for element in app.staticTexts.allElementsBoundByIndex where element.exists {
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if label.contains(fragment) { return label }
        }
        return nil
    }

    private func visibleStaticTextLabels(in app: XCUIApplication) -> [String] {
        app.staticTexts.allElementsBoundByIndex.compactMap { element in
            guard element.exists else { return nil }
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return label.isEmpty ? nil : label
        }
    }

    private func sanitized(_ text: String) -> String {
        var result = text.replacingOccurrences(
            of: "sk-[A-Za-z0-9_-]+",
            with: "[REDACTED_API_KEY]",
            options: .regularExpression
        )
        result = result.replacingOccurrences(
            of: "(?i)bearer\\s+[A-Za-z0-9._-]+",
            with: "Bearer [REDACTED_TOKEN]",
            options: .regularExpression
        )
        return result
    }

    private func containsBoardToken(_ token: String, in text: String) -> Bool {
        if token == "x" {
            return text.range(of: "(?i)(?<![A-Za-z0-9])x(?![A-Za-z0-9])", options: .regularExpression) != nil
        }

        if token == "3/4" || token == "1/2" {
            let compact = text.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression).lowercased()
            return compact.contains(token)
        }

        let escapedToken = NSRegularExpression.escapedPattern(for: token)
        return text.range(of: "(?<![A-Za-z0-9])\(escapedToken)(?![A-Za-z0-9])", options: .regularExpression) != nil
    }
}
