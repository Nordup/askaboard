import XCTest

/// The four designed screens, the transitions between them, and the one state that is not a
/// screen at all.
///
/// Every test asserts what is on screen rather than what was tapped — see the tapping
/// helpers at the bottom for why.
final class MathTutorUITests: XCTestCase {
    /// The design's frame: iPad Pro 13-inch landscape. Hard-coded because a UI test bundle
    /// cannot import the app target to read `ScreenLayout`, and it is the number every
    /// geometry assertion below is measured against.
    private static let designSize = CGSize(width: 1376, height: 1032)

    /// The tutor has to be reachable for any of the four screens to be the thing on screen —
    /// without a key the panel is board 11 instead, which is its own test.
    private static let designedScreenLaunch = ["--ui-test-reset", "--ui-test-demo-service"]

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        // Deliberately left in landscape. The app is landscape-only and the whole design is
        // specified at 1376 × 1032, so this is the orientation every run of this suite and
        // every visual diff needs; rotating back would only mean the next launch has to
        // rotate again, mid-flight, which is exactly when it is unreliable.
        //
        // Note for whoever screenshots this: the simulator's framebuffer stays portrait
        // shaped whatever `XCUIDevice` is set to, so a `simctl io screenshot` comes out
        // rotated a quarter turn. The window underneath is genuinely the full 1376 × 1032 —
        // that is what `launch` asserts — so the image needs rotating, not the app.
        super.tearDown()
    }

    // MARK: - The four screens

    func testDockedStartRendersScreen05() {
        let app = launch(["--ui-state", "docked-start", "--ui-fixture", "--ui-freeze"])

        XCTAssertTrue(app.staticTexts["Hi! I'm your AI Tutor"].exists)
        for chip in ["Explain this concept", "Give me an example", "Create an exercise", "I don't understand this"] {
            XCTAssertTrue(app.buttons[chip].exists, "Screen 05 shows all four suggestion chips")
        }
        XCTAssertTrue(app.staticTexts["Selection attached"].exists, "Screen 05 has a selection waiting in the composer")
        XCTAssertTrue(app.textFields["Ask anything..."].exists)
        assertBoard(app, isWide: false)
        XCTAssertTrue(app.buttons["Pen"].exists, "The tool rail is present on screens 05, 06 and 08")
    }

    func testCollapsedRendersScreen06() {
        // `--ui-fixture` because this test measures the *reference* screen: `assertBoard`'s
        // 976 and 28 are the design's band, and only a fixture run is laid out from
        // `ScreenLayout.reference` rather than from the window's real insets. The same screen
        // measured on the device is `testEveryLaneFitsTheRealWindowItIsMeasuredIn`.
        let app = launch(["--ui-state", "collapsed", "--ui-fixture", "--ui-freeze"])

        XCTAssertTrue(app.buttons["Open the tutor"].exists)
        XCTAssertTrue(app.buttons["Select an area of the board"].exists)
        XCTAssertFalse(app.textFields["Ask anything..."].exists, "The collapsed dock replaces the whole panel")
        XCTAssertFalse(app.staticTexts["Hi! I'm your AI Tutor"].exists)
        assertBoard(app, isWide: true)
        XCTAssertTrue(app.buttons["Pen"].exists)
    }

    func testFullScreenStartRendersScreen07() {
        // Fixture for the same reason screen 06's test takes one: the geometry asserted below
        // is the board's, and the board's band is 40 + 28 where no real iPad's is.
        let app = launch(["--ui-state", "fullscreen-start", "--ui-fixture", "--ui-freeze"])

        XCTAssertTrue(app.staticTexts["Hi! I'm your AI Tutor"].exists)
        XCTAssertTrue(app.textFields["Ask me anything..."].exists, "The wide composer has its own placeholder")
        XCTAssertFalse(app.textFields["Ask anything..."].exists)
        XCTAssertTrue(app.buttons["Back to the board"].exists, "The peek is screen 07's only board affordance")
        XCTAssertFalse(app.buttons["Pen"].exists, "Screen 07 has no tool rail at all")

        // Board 07's own rhythm, on the board's own screen. The column's positions are derived
        // now — greeting and grid flow above a bottom-anchored composer instead of sitting at
        // two constants — so these are what says the derivation still lands on the drawing.
        assertFrame(
            app.buttons["Explain this concept"],
            CGRect(x: 352, y: 604, width: 360, height: 74),
            "`Suggestion grid` at 352, 604, in a 2-up of 360 × 74"
        )
        assertFrame(
            app.buttons["Give me an example"],
            CGRect(x: 732, y: 604, width: 360, height: 74),
            "the second chip is 360 + 20 along"
        )
        assertFrame(
            app.buttons["Create an exercise"],
            CGRect(x: 352, y: 698, width: 360, height: 74),
            "the second row is 74 + 20 down"
        )
        // The wide composer: a 740pt pill at x 352 whose bottom is the content band's 1004.
        // At the stepped-down 68pt pill, `740 − 8 − 52 = 680` puts the send disc at 1032 and
        // `(68 − 52) ÷ 2 = 8` at 944 — the disc keeps an even 8pt inset on all three sides.
        assertFrame(
            app.buttons["Send message"],
            CGRect(x: 1032, y: 944, width: 52, height: 52),
            "`Composer · wide` is 740 wide at 352, not 740 wide somewhere else"
        )
        // The peek is the full band, flush left — *"the one panel that touches a screen edge."*
        assertFrame(
            app.buttons["Back to the board"],
            CGRect(x: 0, y: 28, width: 68, height: 976),
            "`Board peek` at 0, 28"
        )
    }

    /// Screens 05 and 08's lanes, at the size the boards were drawn at.
    ///
    /// `assertBoard` covers the board itself in every test above; this is the other half of the
    /// row — the panel that was the actual regression. On the reference screen it is the
    /// board's own `1376 − 28 − 337 = 1011`, and the board beside it ends one `--space-gap`
    /// earlier.
    func testTheDockedRowIsTheBoardsOwnThreeLanes() {
        let app = launch(["--ui-state", "docked-start", "--ui-fixture", "--ui-freeze"])

        assertBoard(app, isWide: false)
        assertFrame(
            app.otherElements["tutor-panel"],
            CGRect(x: 1011, y: 28, width: 337, height: 976),
            "`Tutor panel` at 1011, 28 — 337 × 976"
        )

        let board = app.otherElements["whiteboard"].frame
        let panel = app.otherElements["tutor-panel"].frame
        XCTAssertEqual(panel.minX - board.maxX, 24, accuracy: 1, "one --space-gap between them")
        XCTAssertEqual(panel.minY, board.minY, accuracy: 1, "both lanes start at the content top")
        XCTAssertEqual(panel.height, board.height, accuracy: 1, "and both span the whole band")
    }

    // MARK: - The window the app is actually in

    /// The same screen measured rather than injected: no `--ui-fixture`, so every lane comes
    /// out of the real window and the real safe-area insets.
    ///
    /// The insets are the device's and a UI test cannot read them, so nothing here asserts an
    /// absolute `y`. What it asserts is the property that actually matters and that the shipped
    /// bug broke: every lane is inside the window, the row adds up across it, and the two lanes
    /// agree with each other because they were cut from one measurement.
    func testEveryLaneFitsTheRealWindowItIsMeasuredIn() {
        let app = launch(["--ui-state", "docked-start", "--ui-freeze"])
        let window = app.windows.firstMatch.frame

        let board = app.otherElements["whiteboard"].frame
        let panel = app.otherElements["tutor-panel"].frame

        XCTAssertTrue(window.contains(board), "the board is off the window: \(board) in \(window)")
        XCTAssertTrue(window.contains(panel), "the panel is off the window: \(panel) in \(window)")

        // 28 + 72 + 24 = 124 on the left, and the panel measured back from the right edge.
        XCTAssertEqual(board.minX, 124, accuracy: 1)
        XCTAssertEqual(window.maxX - panel.maxX, 28, accuracy: 1, "--space-edge from the right")
        XCTAssertEqual(panel.width, 337, accuracy: 1, "the panel is the one fixed-width surface")
        XCTAssertEqual(panel.minX - board.maxX, 24, accuracy: 1)

        // The band is inside the safe area at both ends, and both lanes share it.
        XCTAssertGreaterThanOrEqual(board.minY, 28)
        XCTAssertLessThanOrEqual(board.maxY, window.maxY - 28)
        XCTAssertEqual(panel.minY, board.minY, accuracy: 1)
        XCTAssertEqual(panel.height, board.height, accuracy: 1)
    }

    /// **The regression that started all of this.**
    ///
    /// The design declared itself a fixed 1376 × 1032 layout and the panel was drawn at an
    /// absolute `x 1011 … 1348`; installed on a 1024pt iPad that is a third of the tutor off
    /// the right-hand edge. A UI test cannot resize an iPad's window — there is no public API
    /// for it and this suite is pinned to one simulator — so `--ui-window` states the window
    /// the screen must lay itself out in, and this asserts every lane lands inside it.
    ///
    /// 1024 × 768 is the iPad 6th generation the bug was reported on. It is over
    /// `dockedMinimumWidth`, so the tutor still docks here and the board is what gives.
    func testTheTutorPanelIsWhollyOnScreenInASmallerWindow() {
        let app = launch(["--ui-state", "docked-start", "--ui-window", "1024x768", "--ui-freeze"])
        let window = CGRect(origin: .zero, size: CGSize(width: 1024, height: 768))

        let panel = app.otherElements["tutor-panel"].frame
        XCTAssertTrue(
            window.contains(panel),
            "the tutor panel must be inside the window it was laid out in: \(panel) in \(window)"
        )
        // `1024 − 28 − 337 = 659`, which is where the panel goes when the arithmetic is run on
        // the real width instead of on 1376.
        XCTAssertEqual(panel.minX, 659, accuracy: 1)
        XCTAssertEqual(panel.maxX, window.maxX - 28, accuracy: 1)

        // The board is the lane with give in it: `1024 − 28 − 72 − 24 − 337 − 24 − 28 = 511`.
        let board = app.otherElements["whiteboard"].frame
        XCTAssertTrue(window.contains(board), "\(board) in \(window)")
        XCTAssertEqual(board.width, 511, accuracy: 1)
        XCTAssertEqual(panel.minX - board.maxX, 24, accuracy: 1)

        // And the composer inside the panel came with it.
        XCTAssertTrue(app.textFields["Ask anything..."].exists)
        XCTAssertTrue(window.contains(app.textFields["Ask anything..."].frame))
    }

    /// Below `dockedMinimumWidth` the design's answer is screen 06, and the screen has to
    /// reconcile that with a `UIState` that still says `docked`.
    ///
    /// `700 − 28 − 72 − 24 − 337 − 24 − 28 = 187` of board beside a 337pt panel is the
    /// hierarchy the whole design is built on, inverted. So the panel is not drawn, the board
    /// takes the width, and the dock — which the design already draws and the student already
    /// reaches by hand — is what opens the tutor. It opens it full-screen, because that is the
    /// tutor state this width can host.
    func testAWindowThatCannotHostTheDockedPanelDrawsScreenSixInstead() {
        let app = launch(["--ui-state", "docked-start", "--ui-window", "700x768", "--ui-freeze"])
        let window = CGRect(origin: .zero, size: CGSize(width: 700, height: 768))

        XCTAssertFalse(app.otherElements["tutor-panel"].exists, "the panel cannot fit at 700")
        XCTAssertFalse(app.textFields["Ask anything..."].exists)
        XCTAssertTrue(app.buttons["Open the tutor"].exists, "screen 06's dock is the tutor here")
        XCTAssertTrue(app.buttons["Pen"].exists, "the rail stays: this is screen 06, not a new layout")

        // `700 − 28 − 72 − 24 − 28 = 548`: the board absorbs the panel and the gap it sat behind.
        let board = app.otherElements["whiteboard"].frame
        XCTAssertTrue(window.contains(board), "\(board) in \(window)")
        XCTAssertEqual(board.width, 548, accuracy: 1)

        // The dock is not a dead end: its orb opens the tutor full-screen, and the peek there
        // comes back to the board.
        tap(app.buttons["Open the tutor"], untilExists: app.textFields["Ask me anything..."],
            "the dock's orb must open the tutor at a width that cannot dock it")
        XCTAssertTrue(window.contains(app.textFields["Ask me anything..."].frame))
        tap(app.buttons["Back to the board"], untilExists: app.buttons["Open the tutor"],
            "and the peek must come back to the board, which is screen 06 again at this width")
    }

    /// A rotation is a new size on the same window, which is the same event a Split View drag
    /// is. The lanes have to be re-cut from it rather than latched at launch — the board's own
    /// `PKCanvasView` was bitten by exactly the opposite habit of trusting geometry read once,
    /// too early.
    ///
    /// The app is landscape-only, so iPadOS letterboxes it while the device is upright rather
    /// than reflowing it; what this drives is the pair of layout passes on the way out and
    /// back, which is where a latched measurement would be recorded. `ShellComponentTests`
    /// covers the in-process resize itself, insets included, by moving a host window.
    func testRotatingAwayAndBackRelaysOutRatherThanLatchingTheFirstWindow() {
        let app = launch(["--ui-state", "docked-start", "--ui-fixture", "--ui-freeze"])
        assertBoard(app, isWide: false)
        let before = app.otherElements["tutor-panel"].frame

        XCUIDevice.shared.orientation = .portrait
        _ = app.otherElements["whiteboard"].waitForExistence(timeout: 5)
        XCUIDevice.shared.orientation = .landscapeLeft

        XCTAssertTrue(
            waitForDesignSizedWindow(app),
            "the app must come back to the full \(Self.designSize) rather than staying letterboxed"
        )
        assertBoard(app, isWide: false, "the board is re-cut from the window it came back to")
        XCTAssertEqual(app.otherElements["tutor-panel"].frame, before, "and so is the panel")
    }

    func testDockedActiveRendersScreen08() {
        let app = launch(["--ui-state", "docked-active", "--ui-fixture", "--ui-freeze"])

        XCTAssertTrue(app.staticTexts["why does the arrow start at 0?"].exists, "The thread replaces the start state")
        XCTAssertTrue(app.staticTexts["Selection"].exists, "The eighth message carries a sent board selection")
        XCTAssertFalse(app.staticTexts["Hi! I'm your AI Tutor"].exists)
        XCTAssertTrue(app.textFields["Ask anything..."].exists)
        assertBoard(app, isWide: false)
    }

    // MARK: - Transitions

    func testDockControlCollapsesAndTheOrbBringsTheTutorBack() {
        let app = launch(["--ui-state", "docked-start", "--ui-fixture", "--ui-freeze"])

        let orb = app.buttons["Open the tutor"]
        tap(app.buttons["Collapse tutor to the dock"], untilExists: orb,
            "btn/dock must collapse the panel to the dock")
        assertBoard(app, isWide: true, "The board absorbs the panel and the gap it sat behind")

        tap(orb, untilExists: app.staticTexts["Hi! I'm your AI Tutor"],
            "The dock's orb must restore the panel in the conversation state it was left in")
        assertBoard(app, isWide: false)
    }

    func testFullScreenControlAndThePeekBack() {
        let app = launch(["--ui-state", "docked-start", "--ui-fixture", "--ui-freeze"])

        let wideComposer = app.textFields["Ask me anything..."]
        tap(app.buttons["Show tutor full screen"], untilExists: wideComposer,
            "btn/full-screen must open the 740pt column")
        XCTAssertFalse(app.buttons["Pen"].exists, "The rail goes with the board")

        tap(app.buttons["Back to the board"], untilExists: app.textFields["Ask anything..."],
            "The board peek must return the tutor to the docked panel")
        XCTAssertTrue(app.buttons["Pen"].exists)
    }

    /// Task 7's own addition, beyond what any task in the plan owned: the design spec requires
    /// the strip to be **absent** when collapsed or full screen, not merely invisible — an
    /// invisible-but-hittable strip left sitting over the board would be a control eating
    /// touches that nothing on screen explains. `BoardScreen` mounts `ResizeHandle` only inside
    /// `tutor`'s `.docked` case — see its own doc — so this drives the app through both of the
    /// other two states with the same real taps a student uses, and checks the accessibility
    /// element the handle's label identifies is gone in both.
    ///
    /// The docked assertion comes first and is not decoration: it is what proves the query can
    /// see the strip at all, so the two `XCTAssertFalse`s below are not passing because the
    /// query itself never matches anything — the failure mode a vacuous absence test would
    /// hide.
    func testTheResizeStripDoesNotExistWhenCollapsedOrFullScreen() {
        let app = launch(["--ui-state", "docked-start", "--ui-freeze"])
        let strip = app.descendants(matching: .any)["Resize the tutor panel"]
        XCTAssertTrue(strip.exists, "the strip must be reachable while the panel is docked")

        tap(app.buttons["Collapse tutor to the dock"], untilExists: app.buttons["Open the tutor"],
            "btn/dock must collapse the panel to the dock")
        XCTAssertFalse(strip.exists, "collapsed to the dock, there is no seam left to resize")

        tap(app.buttons["Open the tutor"], untilExists: app.staticTexts["Hi! I'm your AI Tutor"],
            "the dock's orb must restore the docked panel")
        tap(app.buttons["Show tutor full screen"], untilExists: app.textFields["Ask me anything..."],
            "btn/full-screen must open the 740pt column")
        XCTAssertFalse(
            strip.exists,
            "full screen, there is no board beside the panel for the strip to sit between"
        )
    }

    // MARK: - Sending

    func testSendingAMessageMovesTheTutorFromGreetingToThread() {
        // No `--ui-state`: this is the state a student actually launches into.
        let app = launch()

        let greeting = app.staticTexts["Hi! I'm your AI Tutor"]
        XCTAssertTrue(greeting.exists, "A fresh session opens on screen 05")

        let field = app.textFields["Ask anything..."]
        tap(field, untilExists: app.keyboards.element, "Tapping the composer must raise the keyboard")

        // Keyboard-up is undesigned — board 05 §12 — but a composer a student cannot see while
        // they type into it is not a reading of that the design would recognise. The keyboard
        // is a safe-area inset like any other, so the band it leaves is what the screen is laid
        // out in, and the composer stays where the eye is.
        XCTAssertLessThanOrEqual(
            field.frame.maxY,
            app.keyboards.element.frame.minY,
            "The composer must stay above the keyboard rather than behind it"
        )

        field.typeText("what is a vector")

        tap(app.buttons["Send message"], untilGone: greeting,
            "Sending must replace the start state with the thread")
        XCTAssertTrue(app.staticTexts["what is a vector"].waitForExistence(timeout: 5),
                      "The sent message must appear in the thread")
    }

    func testSuggestionChipStartsTheConversation() {
        let app = launch()

        let greeting = app.staticTexts["Hi! I'm your AI Tutor"]
        tap(app.buttons["Explain this concept"], untilGone: greeting,
            "A suggestion chip is a prompt: it must start the conversation")
        XCTAssertTrue(app.staticTexts["Explain this concept"].waitForExistence(timeout: 5),
                      "The chip's own copy is what gets sent")
    }

    // MARK: - The board selection, which is how work reaches the tutor

    func testDockSelectionAttachesTheBoardAndSendingEvaluatesIt() {
        // The seed puts real ink on the board; an empty board has nothing to attach.
        let app = launch(["--ui-test-reset", "--e2e-seed-radical-attempt"], resetting: false)

        attachBoardSelection(in: app)

        tap(app.buttons["Send message"], untilGone: app.staticTexts["Selection attached"],
            "Sending must consume the attachment")
        XCTAssertTrue(app.staticTexts["Selection"].waitForExistence(timeout: 8),
                      "The sent selection arrives in the thread as a capped bubble")
        XCTAssertTrue(
            staticText(containing: "looking at the whole board", in: app, timeout: 10),
            "The tutor must be told which part of the board it was sent"
        )
    }

    /// Collapse, attach, reopen — the design's only route from the board to the composer.
    ///
    /// **`btn/select` now has a visible result of its own**, which is what this helper used
    /// to say it lacked: the dock draws the design's live/idle colour states for
    /// `ui/selection-marker`, so the control reports its own state and the retry can watch
    /// *it* rather than a card three views away. That matters for more than tidiness — the
    /// button is a toggle now, so a retry that re-taps a tap which actually landed would
    /// detach the board it had just attached. Only a tap that left the button idle is
    /// repeated.
    private func attachBoardSelection(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let selectButton = app.buttons["Select an area of the board"]
        if !selectButton.exists {
            tap(app.buttons["Collapse tutor to the dock"], untilExists: selectButton,
                "btn/dock must collapse the panel to the dock")
        }
        for attempt in 1...3 {
            if isAttached(selectButton) { break }
            selectButton.tap()
            if waitUntilAttached(selectButton, timeout: 3) { break }
            noteDroppedTap(attempt: attempt, of: 3, message: "btn/select did not attach the board")
        }
        XCTAssertTrue(isAttached(selectButton),
                      "btn/select never reported an attached board", file: file, line: line)

        tap(app.buttons["Open the tutor"], untilExists: app.textFields["Ask anything..."],
            "The dock's orb must bring the panel back")
        XCTAssertTrue(app.staticTexts["Selection attached"].waitForExistence(timeout: 5),
                      "The attached board must reach the composer", file: file, line: line)
    }

    /// `btn/select`'s accessibility value, which is how the attached state leaves the app.
    private func isAttached(_ selectButton: XCUIElement) -> Bool {
        selectButton.exists && (selectButton.value as? String) == "Attached"
    }

    private func waitUntilAttached(_ selectButton: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isAttached(selectButton) { return true }
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "poll")], timeout: 0.2)
        }
        return isAttached(selectButton)
    }

    // MARK: - No key

    func testNoAPIKeyStateFillsThePanelWithoutAKey() {
        // No demo service: an absent key is the real first-run condition, not an error.
        let app = launch(["--ui-test-reset"], resetting: false)

        XCTAssertTrue(app.staticTexts["One thing before we start"].exists)
        XCTAssertTrue(app.buttons["add-api-key"].exists)
        XCTAssertFalse(app.textFields["Ask anything..."].exists,
                       "Board 11 removes the composer rather than disabling it")
        XCTAssertTrue(app.buttons["Pen"].exists, "The board and rail stay live: nothing is blocked")
        // No `--ui-fixture` here — an absent key is the real first-run condition — so the band
        // is the device's and only the width is the design's.
        assertMeasuredBoard(app, isWide: false)
    }

    /// Asserted on the window rather than on a heading, and that is a change worth naming:
    /// **the redesigned settings window nowhere says "Settings".** The old screen opened with
    /// a 40pt display title; the window opens on the Tutor pane, whose heading is "Tutor", so
    /// the only confirmation you landed in settings is the sidebar's three items. Waiting on
    /// the identifier is the honest assertion — waiting on a word the product no longer shows
    /// would be testing a string this suite invented.
    func testSettingsIsReachableFromThePanel() {
        let app = launch(["--ui-state", "docked-start", "--ui-freeze"])

        tap(app.buttons["Tutor settings"], untilExists: app.descendants(matching: .any)["settings-window"],
            "The panel controls' settings button must open the settings window")
    }

    /// The gear is the full-screen column's only chrome, and it did not used to be there.
    ///
    /// Board 07 drew no controls at all, so Settings was unreachable from the greeting — the
    /// student had to go back to the board first. Both full-screen states now carry the same
    /// gear in the same corner, and this is the state that had none.
    func testSettingsIsReachableFromTheFullScreenGreeting() {
        let app = launch(["--ui-state", "fullscreen-start", "--ui-freeze"])

        tap(app.buttons["Tutor settings"], untilExists: app.descendants(matching: .any)["settings-window"],
            "The full-screen column's gear must open the settings window")
    }


    // MARK: - Live device

    /// Runs only when explicitly requested against a device with the real, persisted session
    /// and API key. It deliberately uses no reset, demo or seed argument, so a missing board
    /// or key is reported as evidence rather than papered over by test setup.
    func testLiveBoardEvaluationSeesPersistedAttempt() throws {
        guard ProcessInfo.processInfo.environment["RUN_LIVE_BOARD_E2E"] == "1" else {
            throw XCTSkip("Set RUN_LIVE_BOARD_E2E=1 to run the live-device board test")
        }

        let app = launch([], resetting: false)
        guard !app.buttons["add-api-key"].exists else {
            XCTFail("Live board E2E needs a persisted API key: the panel is in its first-run state")
            return
        }

        attachBoardSelection(in: app)
        app.buttons["Send message"].tap()

        // The reply is a plain tutor message in the thread now, not a highlighted card, so
        // the evidence is the text itself.
        guard let reply = firstStaticTextLabel(containing: "looking at", in: app, timeout: 90) else {
            let evidence = sanitized(visibleStaticTextLabels(in: app).joined(separator: " | "))
            XCTFail("Live board E2E got no evaluation reply within 90 seconds. Visible labels: \(evidence)")
            return
        }
        print("LIVE_BOARD_E2E_FEEDBACK: \(sanitized(reply))")

        let lowercased = reply.lowercased()
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
            "unable to see the board", "unseen image", "unseen board",
        ]
        XCTAssertFalse(
            emptyBoardClaims.contains(where: lowercased.contains),
            "Live feedback claimed the board was empty, blank, or unseen: \(sanitized(reply))"
        )
    }

    private func firstStaticTextLabel(containing fragment: String, in app: XCUIApplication, timeout: TimeInterval) -> String? {
        guard staticText(containing: fragment, in: app, timeout: timeout) else { return nil }
        for element in app.staticTexts.allElementsBoundByIndex where element.exists {
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if label.contains(fragment) { return label }
        }
        return nil
    }

    private func staticText(containing fragment: String, in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let match = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
        return match.waitForExistence(timeout: timeout)
    }

    private func visibleStaticTextLabels(in app: XCUIApplication) -> [String] {
        app.staticTexts.allElementsBoundByIndex.compactMap { element in
            guard element.exists else { return nil }
            let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return label.isEmpty ? nil : label
        }
    }

    /// Live replies are printed as evidence, and a key must never be printed with them.
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

    // MARK: - Launching

    /// Launches the app on a genuinely landscape device and proves it got the whole screen.
    ///
    /// The app is landscape-only, so iOS draws it landscape whatever the device is doing —
    /// but on a portrait device that means a rotated, letterboxed window, and every geometry
    /// assertion below would then be measuring the wrong rectangle while still passing.
    /// Rotating is also unreliable while a process is mid-launch, so the device is turned
    /// first and the result is checked afterwards rather than assumed.
    @discardableResult
    private func launch(
        _ arguments: [String] = [],
        resetting: Bool = true,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIApplication {
        var lastFrame: CGRect = .zero
        for attempt in 1...3 {
            XCUIDevice.shared.orientation = .landscapeLeft

            let app = XCUIApplication()
            app.launchArguments = (resetting ? Self.designedScreenLaunch : []) + arguments
            app.launch()

            // Three bundled fonts make a cold launch slow, so the first assertion in every
            // test waits here rather than in the test body.
            _ = app.wait(for: .runningForeground, timeout: 30)

            // The *window's* frame, not `app.frame`: a landscape-only app always reports its
            // own 1376 × 1032 coordinate space from `app.frame`, even when iOS has letterboxed
            // it. Measured on a portrait device the window is (0, 301, 1032, 774) — the
            // rectangle between two 301pt black bars — which is what this catches.
            lastFrame = app.windows.firstMatch.frame
            if Self.isDesignSized(lastFrame) { return app }

            XCTContext.runActivity(named: "Launch \(attempt) came up at \(lastFrame.size), rotating again") { _ in }
            app.terminate()
        }

        XCTFail(
            """
            The device did not rotate to landscape: the app came up at \(lastFrame.size) \
            rather than the design's \(Self.designSize). Every geometry assertion in this \
            suite measures against that frame, so the run is stopped rather than reported \
            against a letterboxed screen.
            """,
            file: file,
            line: line
        )
        return XCUIApplication()
    }

    private static func isDesignSized(_ frame: CGRect) -> Bool {
        abs(frame.width - designSize.width) < 1 && abs(frame.height - designSize.height) < 1
    }

    /// The board on the **reference** screen — a `--ui-fixture` run, which is laid out from
    /// `ScreenLayout.reference` rather than from the window.
    ///
    /// Its width is the whole difference between the docked screens and the collapsed one —
    /// 863 with a panel beside it, 1224 without — and 936 / 68 are the design's band, which
    /// belongs to the 40pt status region no iPad actually reserves. Measured on a device those
    /// two numbers are different and correct; see `assertMeasuredBoard`.
    private func assertBoard(
        _ app: XCUIApplication,
        isWide: Bool,
        _ message: String = "The board's width is the collapsed state",
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let board = boardFrame(app, message, file: file, line: line) else { return }
        XCTAssertEqual(board.width, isWide ? 1224 : 863, accuracy: 1, message, file: file, line: line)
        XCTAssertEqual(board.height, 976, accuracy: 1, "The board's height never changes", file: file, line: line)
        XCTAssertEqual(board.minY, 28, accuracy: 1, "The content band starts at 28", file: file, line: line)
    }

    /// The board on the **real** screen, where the band is whatever the device reserves.
    ///
    /// A UI test cannot read a safe-area inset, so the vertical assertions are the rule rather
    /// than its result: `--space-edge` clear of both obstructions, and a band that is the rest.
    /// The width is still absolute because an iPad in landscape reserves nothing at its sides.
    private func assertMeasuredBoard(
        _ app: XCUIApplication,
        isWide: Bool,
        _ message: String = "The board's width is the collapsed state",
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let board = boardFrame(app, message, file: file, line: line) else { return }
        let window = app.windows.firstMatch.frame

        XCTAssertEqual(board.width, isWide ? 1224 : 863, accuracy: 1, message, file: file, line: line)
        XCTAssertEqual(board.minX, 124, accuracy: 1, "28 + 72 + 24", file: file, line: line)
        XCTAssertGreaterThanOrEqual(board.minY, 28, "--space-edge below the status bar", file: file, line: line)
        XCTAssertLessThanOrEqual(board.maxY, window.maxY - 28, "and clear of the bottom", file: file, line: line)
        XCTAssertLessThan(
            board.height, Self.designSize.height,
            "a real device reserves something at the top, so the band cannot be the full screen",
            file: file, line: line
        )
    }

    private func boardFrame(
        _ app: XCUIApplication,
        _ message: String,
        file: StaticString,
        line: UInt
    ) -> CGRect? {
        let board = app.otherElements["whiteboard"]
        guard board.waitForExistence(timeout: 5) else {
            XCTFail("\(message): the board is not on screen at all", file: file, line: line)
            return nil
        }
        return board.frame
    }

    /// One element, one rectangle. The message names the board's own region so a failure reads
    /// as "the suggestion grid moved" rather than as four numbers.
    private func assertFrame(
        _ element: XCUIElement,
        _ expected: CGRect,
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard element.waitForExistence(timeout: 5) else {
            XCTFail("\(message): the element is not on screen at all", file: file, line: line)
            return
        }
        let frame = element.frame
        XCTAssertEqual(frame.minX, expected.minX, accuracy: 1, "\(message) · x", file: file, line: line)
        XCTAssertEqual(frame.minY, expected.minY, accuracy: 1, "\(message) · y", file: file, line: line)
        XCTAssertEqual(frame.width, expected.width, accuracy: 1, "\(message) · width", file: file, line: line)
        XCTAssertEqual(frame.height, expected.height, accuracy: 1, "\(message) · height", file: file, line: line)
    }

    /// Waits for iPadOS to give the app the whole screen back after a rotation. The device
    /// reports its new orientation before the window has been resized to match it, so this is
    /// polled rather than assumed.
    private func waitForDesignSizedWindow(_ app: XCUIApplication, timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Self.isDesignSized(app.windows.firstMatch.frame) { return true }
            // A bare expectation rather than `expectation(description:)`: one created by the
            // test case and never fulfilled is an XCTest API violation at teardown, and all
            // this needs is a quarter second that does not block the run loop.
            _ = XCTWaiter().wait(for: [XCTestExpectation(description: "settling")], timeout: 0.25)
        }
        return Self.isDesignSized(app.windows.firstMatch.frame)
    }

    // MARK: - Tapping
    //
    // A synthesized tap on a screen that was just launched is intermittently dropped before
    // it reaches the view. Instrumenting the app showed the SwiftUI button's action never
    // running on roughly one launch in ten, while the element still reported `exists` and
    // `isHittable` at an unchanged frame, and the app state was correspondingly untouched.
    //
    // These helpers therefore assert on the outcome of a tap rather than assuming a single
    // tap lands. They do not hide a broken transition: a tap that is delivered but does not
    // produce the expected state fails immediately rather than being retried.

    /// Taps `element` until `expectation` appears.
    private func tap(
        _ element: XCUIElement,
        untilExists expectation: XCUIElement,
        _ message: String,
        attempts: Int = 3,
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("\(message): the control to tap never appeared", file: file, line: line)
            return
        }
        for attempt in 1...attempts {
            element.tap()
            if expectation.waitForExistence(timeout: timeout) { return }
            guard element.exists else {
                XCTFail("\(message): the tap was delivered but the expected state never appeared", file: file, line: line)
                return
            }
            noteDroppedTap(attempt: attempt, of: attempts, message: message)
        }
        XCTFail("\(message): \(attempts) taps never reached the app", file: file, line: line)
    }

    /// Taps `element` until `target` disappears.
    private func tap(
        _ element: XCUIElement,
        untilGone target: XCUIElement,
        _ message: String,
        attempts: Int = 3,
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("\(message): the control to tap never appeared", file: file, line: line)
            return
        }
        for attempt in 1...attempts {
            element.tap()
            if waitForDisappearance(target, timeout: timeout) { return }
            guard element.exists else {
                XCTFail("\(message): the tap was delivered but the expected state never appeared", file: file, line: line)
                return
            }
            noteDroppedTap(attempt: attempt, of: attempts, message: message)
        }
        XCTFail("\(message): \(attempts) taps never reached the app", file: file, line: line)
    }

    private func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    /// Records dropped taps in the test report so a rising rate stays visible instead of
    /// being silently absorbed by the retry.
    private func noteDroppedTap(attempt: Int, of attempts: Int, message: String) {
        XCTContext.runActivity(named: "Tap \(attempt) of \(attempts) was not delivered, retrying — \(message)") { _ in }
    }
}
