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
    /// The paired 9.7-inch iPad's native landscape point size. The activity
    /// regression is relative geometry rather than a screenshot-spec test, so
    /// it deliberately runs at both real device sizes.
    private static let pairedIPadSize = CGSize(width: 1024, height: 768)

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

    func testCompletedActivityTrailOpensSearchesAndClosesAgain() {
        let app = launch(
            [
                "--ui-state", "docked-active", "--ui-activity-fixture",
                "--ui-activity-anchor-logs"
            ],
            acceptedWindowSizes: [Self.designSize, Self.pairedIPadSize]
        )

        let summary = app.buttons["Worked for 30s"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Searched 5 websites"].isHittable)
        let collapsedSummaryY = summary.frame.midY
        let messageAbove = app.staticTexts["Is my vector label right?"]
        let messageBelow = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Your label is right"))
            .firstMatch
        XCTAssertTrue(messageAbove.waitForExistence(timeout: 2))
        XCTAssertTrue(messageBelow.waitForExistence(timeout: 2))
        let collapsedAboveY = messageAbove.frame.midY
        let collapsedBelowY = messageBelow.frame.midY
        let allAboveFrames = absoluteFrames(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Earlier vector discussion"))
                .allElementsBoundByIndex
                .filter { $0.exists && $0.frame.maxY <= summary.frame.minY }
            + [messageAbove]
        )
        logActivityFrames("collapsed", summary, messageAbove, messageBelow)

        summary.tap()
        let search = app.buttons["Searched 5 websites"]
        XCTAssertTrue(search.waitForExistence(timeout: 2))
        XCTContext.runActivity(named: "Activity diagnostics: \(summary.value as? String ?? "missing")") { _ in }
        XCTAssertEqual(
            summary.frame.midY, collapsedSummaryY, accuracy: 2,
            "Opening activity reveals rows below the summary without moving the summary itself"
        )
        assertActivityAnchorDidNotDrift(summary)
        logActivityFrames("trail expanded", summary, messageAbove, search, messageBelow)
        XCTAssertEqual(
            messageAbove.frame.midY, collapsedAboveY, accuracy: 2,
            "A message above the activity does not move"
        )
        assertAbsoluteFramesUnchanged(allAboveFrames)
        XCTAssertEqual(
            messageBelow.frame.midY, collapsedBelowY + 120, accuracy: 2,
            "The message below moves by the three revealed 40-point operation rows"
        )
        XCTAssertGreaterThan(
            search.frame.midY, summary.frame.midY,
            "Revealed operations are laid out below the stationary worked-for marker"
        )
        let reasoning = app.staticTexts["Reviewed the question and identified the relevant definition"]
        let tool = app.staticTexts["Compared the definition with the learner's drawing"]
        XCTAssertTrue(reasoning.exists)
        XCTAssertTrue(tool.exists)
        logActivityFrames("complete expanded hierarchy", summary, reasoning, search, tool, messageBelow)
        assertOrderedWithoutOverlap([summary, reasoning, search, tool, messageBelow])

        let collapsedSearchY = search.frame.midY
        search.tap()
        var firstSource = app.descendants(matching: .any)["Vector analysis, britannica.com"]
        XCTAssertTrue(firstSource.waitForExistence(timeout: 2))
        XCTAssertEqual(
            summary.frame.midY, collapsedSummaryY, accuracy: 2,
            "Opening a nested search keeps the trail summary anchored too"
        )
        XCTAssertEqual(
            search.frame.midY, collapsedSearchY, accuracy: 2,
            "The clicked search row stays at the same absolute screen position"
        )
        assertActivityAnchorDidNotDrift(summary)
        XCTAssertTrue(firstSource.isHittable)
        logActivityFrames("search expanded", summary, search, firstSource, messageBelow)
        let expandedAttachment = XCTAttachment(screenshot: app.screenshot())
        expandedAttachment.name = "Activity trail fully expanded"
        expandedAttachment.lifetime = .keepAlways
        add(expandedAttachment)
        XCTAssertGreaterThanOrEqual(
            firstSource.frame.minY, search.frame.maxY - 1,
            "Sources begin below their search row instead of painting over it"
        )

        search.tap()
        XCTAssertEqual(
            summary.frame.midY, collapsedSummaryY, accuracy: 2,
            "Closing a nested search keeps the trail summary anchored"
        )
        XCTAssertEqual(search.frame.midY, collapsedSearchY, accuracy: 2)
        assertActivityAnchorDidNotDrift(summary)

        // Collapse the outer trail while the nested row is closed. That keeps the
        // next chat message visible throughout the transition, so the frame probe
        // verifies the complete lower sibling group moving upward coherently.
        let expandedSummary = app.buttons["Worked for 30s"]
        XCTAssertTrue(expandedSummary.waitForExistence(timeout: 2))
        expandedSummary.tap()
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertFalse(app.buttons["Searched 5 websites"].isHittable)
        let collapsedAgain = app.buttons["Worked for 30s"]
        XCTAssertTrue(collapsedAgain.waitForExistence(timeout: 2))
        XCTAssertEqual(
            collapsedAgain.frame.midY, collapsedSummaryY, accuracy: 2,
            "Closing activity returns the lower content without moving the summary itself"
        )
        assertActivityAnchorDidNotDrift(collapsedAgain)
        XCTAssertEqual(messageAbove.frame.midY, collapsedAboveY, accuracy: 2)
        XCTAssertEqual(messageBelow.frame.midY, collapsedBelowY, accuracy: 2)

        collapsedAgain.tap()
        XCTAssertTrue(app.buttons["Searched 5 websites"].waitForExistence(timeout: 2))
        XCTAssertEqual(
            collapsedAgain.frame.midY, collapsedSummaryY, accuracy: 2,
            "Reopening after a collapse does not retain a stale scroll offset"
        )
        assertActivityAnchorDidNotDrift(collapsedAgain)

        let reopenedSearch = app.buttons["Searched 5 websites"]
        reopenedSearch.tap()
        firstSource = app.descendants(matching: .any)["Vector analysis, britannica.com"]
        XCTAssertTrue(firstSource.waitForExistence(timeout: 2))
        XCTAssertTrue(firstSource.isHittable)
        let chat = app.descendants(matching: .any)["chat-scroll"]
        XCTAssertTrue(chat.exists)

        // This regression used to pass a single tap and still fail immediately
        // afterward. Exercise three complete nested + outer cycles before the
        // scroll round-trip. Every transition is sampled by the in-app
        // CADisplayLink probe, not only checked after it settles.
        for cycle in 1...3 {
            XCTAssertTrue(summary.isHittable, "Cycle \(cycle): worked-for row must remain reachable")
            XCTAssertTrue(search.isHittable, "Cycle \(cycle): expanded search row must be reachable")

            var summaryY = summary.frame.midY
            var searchY = search.frame.midY
            var lowerY = messageBelow.frame.midY
            search.tap()
            XCTAssertEqual(summary.frame.midY, summaryY, accuracy: 0.75)
            XCTAssertEqual(search.frame.midY, searchY, accuracy: 0.75)
            XCTAssertEqual(messageBelow.frame.midY, lowerY - 150, accuracy: 1)
            assertActivityAnchorDidNotDrift(summary)

            summaryY = summary.frame.midY
            lowerY = messageBelow.frame.midY
            summary.tap()
            XCTAssertFalse(search.isHittable)
            XCTAssertEqual(summary.frame.midY, summaryY, accuracy: 0.75)
            XCTAssertEqual(messageBelow.frame.midY, lowerY - 120, accuracy: 1)
            assertActivityAnchorDidNotDrift(summary)

            summaryY = summary.frame.midY
            lowerY = messageBelow.frame.midY
            summary.tap()
            XCTAssertTrue(search.waitForExistence(timeout: 2))
            XCTAssertTrue(search.isHittable)
            XCTAssertEqual(summary.frame.midY, summaryY, accuracy: 0.75)
            XCTAssertEqual(messageBelow.frame.midY, lowerY + 120, accuracy: 1)
            assertActivityAnchorDidNotDrift(summary)

            summaryY = summary.frame.midY
            searchY = search.frame.midY
            lowerY = messageBelow.frame.midY
            search.tap()
            firstSource = app.descendants(matching: .any)["Vector analysis, britannica.com"]
            XCTAssertTrue(firstSource.waitForExistence(timeout: 2))
            XCTAssertTrue(firstSource.isHittable)
            XCTAssertEqual(summary.frame.midY, summaryY, accuracy: 0.75)
            XCTAssertEqual(search.frame.midY, searchY, accuracy: 0.75)
            XCTAssertEqual(messageBelow.frame.midY, lowerY + 150, accuracy: 1)
            assertActivityAnchorDidNotDrift(summary)
            assertOrderedWithoutOverlap([summary, reasoning, search, firstSource, tool, messageBelow])
        }

        for _ in 0..<4 where messageBelow.frame.maxY > chat.frame.maxY {
            chat.swipeUp()
        }
        XCTAssertGreaterThanOrEqual(messageBelow.frame.minY, chat.frame.minY)
        XCTAssertLessThanOrEqual(
            messageBelow.frame.maxY, chat.frame.maxY,
            "The newest tutor answer must remain reachable after repeated disclosure cycles"
        )

        // Exercise the reverse scroll direction as well, then return to the
        // newest answer a second time. No disclosure is toggled at the hard
        // scroll boundary because preserving a point there would require
        // visible overscroll whitespace.
        chat.swipeDown()
        XCTAssertTrue(summary.isHittable, "The activity summary must remain reachable when scrolling into history")
        for _ in 0..<4 where messageBelow.frame.maxY > chat.frame.maxY {
            chat.swipeUp()
        }
        XCTAssertLessThanOrEqual(messageBelow.frame.maxY, chat.frame.maxY)
    }

    /// The app samples the marker's presentation layer on every display frame.
    /// XCUITest itself waits for animations to become idle after a tap, so a
    /// settled-frame assertion alone cannot catch the one-frame jump this
    /// regression originally had.
    private func assertActivityAnchorDidNotDrift(
        _ summary: XCUIElement,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let value = summary.value as? String ?? ""
        XCTContext.runActivity(named: "Raw frame diagnostics: \(value)") { _ in }
        guard let drift = activityMetric("anchor drift", in: value),
              let aboveDrift = activityMetric("above drift", in: value),
              let belowSpread = activityMetric("below spread", in: value),
              let reversals = activityMetric("reversals", in: value),
              let maxStep = activityMetric("max step", in: value),
              let samples = activityMetric("samples", in: value)
        else {
            XCTFail("Missing activity anchor drift measurement in accessibility value: \(value)", file: file, line: line)
            return
        }
        XCTContext.runActivity(
            named: "Frame diagnostics: anchor=\(drift), above=\(aboveDrift), spread=\(belowSpread), reversals=\(reversals), maxStep=\(maxStep), samples=\(samples)"
        ) { _ in }
        XCTAssertLessThanOrEqual(
            drift, 0.75,
            "Worked-for marker moved \(drift) points during the rendered transition",
            file: file,
            line: line
        )
        XCTAssertLessThanOrEqual(
            aboveDrift, 0.75,
            "At least one visible row above the clicked disclosure moved in absolute window coordinates: \(value)",
            file: file,
            line: line
        )
        XCTAssertLessThanOrEqual(
            belowSpread, 0.75,
            "Rows below the disclosure did not translate as one coherent group",
            file: file,
            line: line
        )
        XCTAssertEqual(
            reversals, 0,
            "Rows below the disclosure reversed direction during a single transition",
            file: file,
            line: line
        )
        XCTAssertLessThanOrEqual(
            maxStep, 40,
            "A lower row jumped more than 40 points in one rendered frame",
            file: file,
            line: line
        )
        XCTAssertGreaterThanOrEqual(
            samples, 5,
            "The transition was not sampled across enough rendered frames",
            file: file,
            line: line
        )
    }

    private func activityMetric(_ name: String, in value: String) -> Double? {
        value.components(separatedBy: "; ")
            .first { $0.hasPrefix("\(name) ") }
            .flatMap { Double($0.dropFirst(name.count + 1)) }
    }

    private func absoluteFrames(_ elements: [XCUIElement]) -> [String: CGRect] {
        Dictionary(uniqueKeysWithValues: elements.map { ($0.label, $0.frame) })
    }

    private func assertAbsoluteFramesUnchanged(
        _ baseline: [String: CGRect],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (label, frame) in baseline {
            let element = XCUIApplication().staticTexts[label]
            XCTAssertTrue(element.exists, "Missing stationary row \(label)", file: file, line: line)
            XCTAssertEqual(
                element.frame.midY, frame.midY, accuracy: 0.75,
                "\(label) changed absolute screen position",
                file: file,
                line: line
            )
        }
    }

    private func logActivityFrames(_ state: String, _ elements: XCUIElement...) {
        let frames = elements.map {
            $0.exists ? "\($0.label)=\($0.frame)" : "offscreen element"
        }.joined(separator: "; ")
        XCTContext.runActivity(named: "Activity frames [\(state)]: \(frames)") { _ in }
    }

    private func assertOrderedWithoutOverlap(
        _ elements: [XCUIElement],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (upper, lower) in zip(elements, elements.dropFirst()) {
            XCTAssertGreaterThanOrEqual(
                lower.frame.minY, upper.frame.maxY - 1,
                "\(lower.label) must be below \(upper.label), not overlap it",
                file: file,
                line: line
            )
        }
    }

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
        // The column is centred on the screen itself: `(1376 − 740) ÷ 2 = 318`.
        assertFrame(
            app.buttons["Explain this concept"],
            CGRect(x: 318, y: 604, width: 360, height: 74),
            "`Suggestion grid` at 318, 604, in a 2-up of 360 × 74"
        )
        assertFrame(
            app.buttons["Give me an example"],
            CGRect(x: 698, y: 604, width: 360, height: 74),
            "the second chip is 360 + 20 along"
        )
        assertFrame(
            app.buttons["Create an exercise"],
            CGRect(x: 318, y: 698, width: 360, height: 74),
            "the second row is 74 + 20 down"
        )
        // The wide composer: a 740pt pill at x 318 whose bottom is the content band's 1004.
        // At the stepped-down 68pt pill, `318 + 740 − 8 − 52 = 998` puts the send disc there
        // and `(68 − 52) ÷ 2 = 8` at 944 — the disc keeps an even 8pt inset on all three sides.
        assertFrame(
            app.buttons["Send message"],
            CGRect(x: 998, y: 944, width: 52, height: 52),
            "`Composer · wide` is 740 wide at 318, not 740 wide somewhere else"
        )
        // The peek is the full band, flush to the trailing edge — *"the one panel that touches
        // a screen edge."* 45 wide now: `1376 − 45 = 1331`.
        assertFrame(
            app.buttons["Back to the board"],
            CGRect(x: 1331, y: 28, width: 45, height: 976),
            "`Board peek` at 1331, 28"
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

    /// A dock transition may keep both surfaces mounted while its spring finishes, but the
    /// surface it has just arrived at must already accept the learner's next touch. This is the
    /// device sequence that exposed the distinction: collapse the whole panel, reopen it, reveal
    /// Sessions, then press a control there. The drawer swipe is driven by its UIKit ancestor and
    /// therefore still worked when the reopened SwiftUI panel itself was incorrectly inert.
    func testReopenedDockAcceptsTouchesAfterRevealingSessions() {
        let app = launch([
            "--ui-state", "docked-active", "--ui-fixture",
            "--e2e-seed-radical-attempt"
        ])

        let panel = app.otherElements["tutor-panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        panel.swipeLeft()

        let orb = app.buttons["Open the tutor"]
        XCTAssertTrue(orb.waitForExistence(timeout: 5), "the panel swipe must collapse the dock")
        orb.tap()

        let reopenedPanel = app.otherElements["tutor-panel"]
        XCTAssertTrue(reopenedPanel.waitForExistence(timeout: 5), "the orb must restore the panel")
        reopenedPanel.swipeRight()

        let recent = app.staticTexts["RECENT"]
        XCTAssertTrue(recent.waitForExistence(timeout: 5), "the reopened panel must reveal Sessions")
        let newChat = app.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5))
        newChat.tap()
        XCTAssertTrue(
            app.staticTexts["Hi! I'm your AI Tutor"].waitForExistence(timeout: 5),
            "New chat must be actionable after the dock is reopened and Sessions is revealed"
        )
    }

    /// **The recent-session tap regression, in the exact device sequence.**
    ///
    /// The user's repro: swipe the docked chat fully away, restore it from the orb, open
    /// Sessions, and press a non-current recent session — on a physical iPad the press
    /// sometimes does nothing. Two independent holes existed in that path: the old 10–12 pt
    /// tap/pan dead zone, and a row tap owned by hosted SwiftUI content whose root can be
    /// replaced by a parent update while the finger is down. The row's stable UIKit control
    /// now owns the complete touch sequence and accepts every touch the pan has not taken.
    ///
    /// This test drives that dead zone on purpose — a controlled 11 pt press-drag on the
    /// non-current row — and asserts the actual outcome: the chat content becomes the pressed
    /// session's. It runs the exact hide → restore → open → press cycle against the seeded
    /// non-current row. The resulting content assertion also proves the UIKit control's action
    /// survives the session switch rebuilding its hosted label and dismisses the drawer through
    /// the ordinary `onOpen` path.
    func testRecentSessionSwitchesAfterDockHideRestoreAndSessionsOpen() {
        let app = launch([
            "--ui-state", "docked-active",
            "--e2e-seed-recent-sessions"
        ])

        let radicalContent = "Radical equations: square both sides, then check each candidate in the original equation."
        let vectorsContent = "Vectors in 2D: resolve the 60 N force into x and y components."
        XCTAssertTrue(
            app.staticTexts[radicalContent].waitForExistence(timeout: 5),
            "the seeded radical session must be open with its own thread content"
        )

        let panel = app.otherElements["tutor-panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        panel.swipeLeft()

        let orb = app.buttons["Open the tutor"]
        XCTAssertTrue(orb.waitForExistence(timeout: 5), "swiping the panel left must collapse the dock")
        orb.tap()

        let reopenedPanel = app.otherElements["tutor-panel"]
        XCTAssertTrue(reopenedPanel.waitForExistence(timeout: 5), "the orb must restore the panel")
        reopenedPanel.swipeRight()

        let recent = app.staticTexts["RECENT"]
        XCTAssertTrue(recent.waitForExistence(timeout: 5), "the restored panel must reveal Sessions")

        let row = app.buttons["Vectors in 2D"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the non-current Vectors in 2D row must be listed")
        pressWithDrift(row, points: 30, "a committed drawer pan must not open its row")
        XCTAssertTrue(
            app.staticTexts[radicalContent].exists,
            "a committed horizontal pan across a row must cancel that row's activation"
        )
        pressWithDrift(row, points: 11, "an 11 pt drift is inside the old 10–12 pt dead zone")

        XCTAssertTrue(
            app.staticTexts[vectorsContent].waitForExistence(timeout: 5),
            "pressing Vectors in 2D with the controlled drift must open that session's thread"
        )
    }

    /// SwiftUI clips the translated chat visually but does not implicitly clip its hit-test
    /// rectangle. At full drawer travel that invisible rectangle reaches across the complete
    /// tool rail, so this presses the rail while Sessions is open and verifies the tap reaches
    /// the visible control rather than the hidden part of the chat pane.
    func testSessionsDrawerDoesNotCoverBoardOrToolRailHitAreas() {
        let app = launch([
            "--ui-state", "docked-active", "--ui-fixture",
            "--e2e-seed-radical-attempt", "--ui-freeze"
        ], resetting: false)

        let toggle = app.buttons["Show sessions"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        toggle.tap()

        let board = app.otherElements["whiteboard"]
        XCTAssertTrue(board.waitForExistence(timeout: 5))
        let boardScroller = board.scrollViews.firstMatch
        XCTAssertTrue(boardScroller.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        let chat = app.descendants(matching: .any)["chat-scroll"]
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        let chatBefore = chat.screenshot().pngRepresentation
        boardScroller.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.25))
            .press(
                forDuration: 0.1,
                thenDragTo: boardScroller.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.75))
            )
        XCTAssertLessThan(
            changedPixelCount(
                from: chatBefore,
                to: chat.screenshot(),
                maxWidthFraction: 0.22
            ),
            500,
            "a board pan must not scroll the chat strip"
        )
        let eraser = app.buttons["Eraser"]
        XCTAssertTrue(eraser.waitForExistence(timeout: 5))
        eraser.tap()
        XCTAssertTrue(eraser.isSelected, "the visible tool rail must remain tappable beside Sessions")

        tap(
            app.buttons["Close sessions"],
            untilExists: toggle,
            "the fixed visible chat strip must still close Sessions"
        )
    }

    func testBoardPanDoesNotScrollDockedChat() {
        let app = launch([
            "--ui-state", "docked-active", "--ui-fixture",
            "--e2e-seed-radical-attempt", "--ui-freeze"
        ], resetting: false)
        let chat = app.descendants(matching: .any)["chat-scroll"]
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        let board = app.otherElements["whiteboard"]
        XCTAssertTrue(board.waitForExistence(timeout: 5))
        let before = chat.screenshot().pngRepresentation
        board.swipeUp()
        let after = chat.screenshot().pngRepresentation
        XCTAssertEqual(after, before, "a board pan must not scroll the docked chat")
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

    /// Arming `btn/select` and sending without drawing anything still evaluates the whole
    /// board — the zero-effort path this control had before it could pick a region, kept
    /// exactly as it was so nobody has to learn a gesture to ask for help.
    func testDockSelectionArmedButUndrawnStillEvaluatesTheWholeBoard() {
        // The seed puts real ink on the board; an empty board has nothing to attach.
        let app = launch(["--ui-test-reset", "--e2e-seed-radical-attempt"], resetting: false)

        armBoardSelection(in: app)

        // Watched on the thread rather than on the composer: arming draws no
        // `Selection attached` card, so there is no card for the send to consume and an
        // `untilGone:` on one would be satisfied before Send was ever tapped.
        tap(app.buttons["Send message"], untilExists: app.staticTexts["Selection"],
            "Sending an armed marquee must evaluate the board")
        XCTAssertTrue(
            staticText(containing: "looking at the whole board", in: app, timeout: 10),
            "An armed but undrawn marquee must still be described as the whole board"
        )
    }

    /// The docked composer's own `btn/select`, and the pencil drag that picks a region.
    ///
    /// This is the reported bug end to end. The composer's dashed-square glyph was an
    /// `IconView` with `accessibilityHidden(true)` — it looked exactly like a button, did
    /// nothing, and never changed colour — while the only working control lived in the
    /// collapsed dock, which the docked screen does not draw. So on the screen the app
    /// launches in there was no way to hand the board to the tutor at all, and no way at all
    /// to hand it *part* of the board.
    ///
    /// The drag is what proves the region, not just the button: sending an armed-but-undrawn
    /// marquee still evaluates the whole board, so a test that only tapped would pass
    /// against a marquee that never worked.
    func testTheComposerSelectButtonArmsAMarqueeAndAPencilDragPicksTheRegion() {
        // Ink on the board — an empty one has nothing to select, and btn/select says so.
        let app = launch(["--ui-test-reset", "--e2e-seed-radical-attempt"], resetting: false)

        let selectButton = app.buttons["Select an area of the board"]
        XCTAssertTrue(
            selectButton.waitForExistence(timeout: 10),
            "btn/select must be reachable from the docked screen, not only from the dock"
        )

        // The first synthesized tap after launch is lossy often enough to matter, so this
        // retries on the button's own reported state rather than on a longer timeout.
        for attempt in 1...3 {
            if isAttached(selectButton) { break }
            selectButton.tap()
            if waitUntilAttached(selectButton, timeout: 3) { break }
            noteDroppedTap(attempt: attempt, of: 3, message: "the composer's btn/select did not arm the marquee")
        }
        XCTAssertTrue(
            isAttached(selectButton),
            "Tapping the composer's marquee glyph must visibly arm the selection"
        )

        let board = app.otherElements["whiteboard"]
        XCTAssertTrue(board.waitForExistence(timeout: 5))
        board.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.3))
            .press(
                forDuration: 0.1,
                thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.75))
            )

        XCTAssertTrue(
            app.staticTexts["Selection attached"].waitForExistence(timeout: 5),
            "A finished marquee drag must attach its region to the composer"
        )

        tap(app.buttons["Send message"], untilGone: app.staticTexts["Selection attached"],
            "Sending must consume the attachment")
        XCTAssertTrue(
            staticText(containing: "the area selected on the board", in: app, timeout: 10),
            "The tutor must be told it was sent a picked region, not the whole board"
        )
    }

    func testSeededTutorSceneRemainsVisibleAcrossBoardPanAndPinch() {
        let baselineApp = launch(["--ui-test-reset"], resetting: false)
        let baselineBoard = baselineApp.otherElements["whiteboard"]
        XCTAssertTrue(baselineBoard.waitForExistence(timeout: 10))
        let baselinePixelCount = saturatedPixelCount(in: baselineBoard.screenshot())
        baselineApp.terminate()

        let app = launch(["--ui-test-reset", "--e2e-seed-tutor-scene"], resetting: false)
        let board = app.otherElements["whiteboard"]
        XCTAssertTrue(board.waitForExistence(timeout: 10))

        XCTAssertGreaterThan(
            saturatedPixelCount(in: board.screenshot()),
            baselinePixelCount + 1_000,
            "The seeded tutor scene must add visible colored pixels beyond the board controls"
        )

        board.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.52))
            .press(
                forDuration: 0.1,
                thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.28, dy: 0.62))
            )
        XCTAssertGreaterThan(
            saturatedPixelCount(in: board.screenshot()),
            baselinePixelCount + 1_000,
            "The seeded tutor scene must remain visible after a board pan"
        )

        board.pinch(withScale: 1.35, velocity: 1)
        XCTAssertGreaterThan(
            saturatedPixelCount(in: board.screenshot()),
            baselinePixelCount + 1_000,
            "The seeded tutor scene must remain visible after a board pinch"
        )
    }

    /// Collapse and arm `btn/select` from the dock.
    ///
    /// **`btn/select` has a visible result of its own**, which is what this helper used to
    /// say it lacked: the dock draws the design's live/idle colour states for
    /// `ui/selection-marker`, so the control reports its own state and the retry can watch
    /// *it* rather than a card three views away. That matters for more than tidiness — the
    /// button is a toggle, so a retry that re-taps a tap which actually landed would disarm
    /// the marquee it had just armed. Only a tap that left the button idle is repeated.
    ///
    /// It stops at armed, and deliberately does not reopen the panel to look for a
    /// `Selection attached` card: arming picks no region, so there is nothing attached for a
    /// card to describe. The drag that does attach one is
    /// `testTheComposerSelectButtonArmsAMarqueeAndAPencilDragPicksTheRegion`.
    private func armBoardSelection(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let selectButton = app.buttons["Select an area of the board"]
        if !app.buttons["Open the tutor"].exists {
            tap(app.buttons["Collapse tutor to the dock"], untilExists: selectButton,
                "btn/dock must collapse the panel to the dock")
        }
        for attempt in 1...3 {
            if isAttached(selectButton) { break }
            selectButton.tap()
            if waitUntilAttached(selectButton, timeout: 3) { break }
            noteDroppedTap(attempt: attempt, of: 3, message: "btn/select did not arm the marquee")
        }
        XCTAssertTrue(isAttached(selectButton),
                      "btn/select never reported an armed selection", file: file, line: line)

        tap(app.buttons["Open the tutor"], untilExists: app.textFields["Ask anything..."],
            "The dock's orb must bring the panel back")
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

    // MARK: - No setup state

    /// There is no first-run setup screen any more, and this is the launch that used to get
    /// one: `--ui-test-reset` clears the device token and there is no demo service, so the app
    /// genuinely cannot reach a tutor. Board 11 answered that with its own screen — a block,
    /// a pointer to platform.openai.com, and `btn/primary` in place of the composer. The app
    /// has no credential a student could supply, so there is nothing to ask for and nothing to
    /// send them to: the panel is the ordinary start state, and a send fails in the thread.
    func testThereIsNoFirstRunSetupStateWithoutAToken() {
        let app = launch(["--live-e2e-reset"], resetting: false)

        XCTAssertFalse(app.staticTexts["One thing before we start"].exists)
        XCTAssertFalse(app.buttons["add-api-key"].exists)
        XCTAssertTrue(app.textFields["Ask anything..."].exists,
                      "the composer is the panel's only bottom-slot occupant now")
        XCTAssertTrue(app.buttons["Pen"].exists, "The board and rail stay live: nothing is blocked")
        // No `--ui-fixture` here, so the band is the device's and only the width is the
        // design's.
        assertMeasuredBoard(app, isWide: false)
    }

    /// The settings window has two panes and neither is a credential pane.
    func testSettingsHasNoCredentialPane() {
        let app = launch(["--ui-state", "docked-start", "--ui-freeze"])

        tap(app.buttons["Tutor settings"], untilExists: app.descendants(matching: .any)["settings-window"],
            "The panel controls' settings button must open the settings window")

        XCTAssertFalse(app.buttons["API key"].exists)
        XCTAssertFalse(app.secureTextFields["api-key-field"].exists)
        XCTAssertFalse(app.textFields["base-url-field"].exists)
        XCTAssertFalse(app.buttons["remove-api-key"].exists)
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
    /// and a real device token. It deliberately uses no reset, demo or seed argument, so a
    /// missing board is reported as evidence rather than papered over by test setup.
    func testLiveBoardEvaluationSeesPersistedAttempt() throws {
        guard ProcessInfo.processInfo.environment["RUN_LIVE_BOARD_E2E"] == "1" else {
            throw XCTSkip("Set RUN_LIVE_BOARD_E2E=1 to run the live-device board test")
        }

        let app = launch([], resetting: false)

        armBoardSelection(in: app)
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

    /// The real Luna internet-image flow, against a real backend.
    ///
    /// Runs only when explicitly requested (`MATHTUTOR_LIVE_IMAGE_E2E=1`), because it bills a
    /// real account on the configured key: the app launches with no demo service and no reset
    /// so the compiled-in token reaches the backend named in `MATHTUTOR_BACKEND_URL`, and the
    /// prompt asks the model to search the web, fetch a real photograph, and place it on the
    /// board. It is a progress/result check, not a pixel check: the turn must visibly start
    /// (the learner's message lands), and it must visibly complete (a substantive tutor reply
    /// appears) without surfacing the network-failure state.
    func testLiveLunaInternetImageOnBoard() throws {
        guard ProcessInfo.processInfo.environment["MATHTUTOR_LIVE_IMAGE_E2E"] == "1" else {
            throw XCTSkip("Set MATHTUTOR_LIVE_IMAGE_E2E=1 to run the live Luna image E2E")
        }

        // No `--ui-test-reset` (it makes `BackendConfiguration.load()` return nil) and no
        // `--ui-test-demo-service`. `MATHTUTOR_BACKEND_URL` is the DEBUG-only base-url override
        // read fresh per request; pointing it at the simulator host reaches the local backend.
        let app = launch(
            [],
            resetting: false,
            environment: ["MATHTUTOR_BACKEND_URL": "http://127.0.0.1:8080"]
        )

        // Start a genuinely new persisted session without the credential-clearing UI-test
        // reset. `LearningSession.empty` defaults to Luna, and the clean thread also makes the
        // completion signal below belong unambiguously to this request.
        startFreshLunaSession(in: app)

        // The composer may be the docked or full-screen placeholder depending on the persisted
        // presentation. Reach whichever is present.
        let anchoredField = app.textFields["Ask anything..."].exists
            ? app.textFields["Ask anything..."]
            : app.textFields["Ask me anything..."]
        XCTAssertTrue(
            anchoredField.waitForExistence(timeout: 15),
            "The composer must be reachable to ask the tutor (visible: \(sanitized(visibleStaticTextLabels(in: app).joined(separator: " | "))))"
        )
        let completedTurnsBefore = completedTurnCount(in: app)
        let prompt = "Teach me why soap bubbles show rainbow colors. Search the internet for a high-contrast real photograph, place it on the board, and explain what the colors show."
        tap(anchoredField, untilExists: app.keyboards.element,
            "Tapping the composer must raise the keyboard")
        anchoredField.typeText(prompt)
        app.buttons["Send message"].tap()
        let hideKeyboard = app.keyboards.buttons["Hide keyboard"]
        if hideKeyboard.waitForExistence(timeout: 3) {
            hideKeyboard.tap()
        }

        // Progress, not completion: the learner's own turn entering the thread is the signal
        // the send landed and the reply is streaming.
        XCTAssertTrue(
            staticText(containing: prompt, in: app, timeout: 30),
            "The composer must hand the prompt into the thread; visible: \(sanitized(visibleStaticTextLabels(in: app).joined(separator: " | ")))"
        )

        // Completion, up to the 240s budget. A finished turn collapses its activity trail to a
        // "Worked for Xs" button only on `.done`, which is the least brittle completion signal
        // in this app — and the network-failure state is asserted away explicitly. A substantive
        // reply is then checked as the result, independent of the learner's own prompt.
        let completed = waitForTurnCompletion(
            in: app,
            after: completedTurnsBefore,
            timeout: 240
        )
        let evidence = sanitized(visibleStaticTextLabels(in: app).joined(separator: " | "))
        XCTAssertFalse(
            evidence.lowercased().contains("couldn't reach the tutor service"),
            "The turn hit the network-failure state rather than completing: \(evidence)"
        )
        XCTAssertTrue(
            completed,
            "The turn did not finish within 240s. Visible: \(evidence)"
        )
        let replyText = scienceReplyText(in: app)
        XCTAssertFalse(replyText.isEmpty, "The finished turn produced no reply; visible: \(evidence)")

        // A visual record of the finished board + thread for the parent/Luna review. Not an
        // assertion source, so it cannot make the test flaky.
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "luna-image-board-final"
        attachment.lifetime = .keepAlways
        add(attachment)

        print("LIVE_IMAGE_E2E_REPLY: \(sanitized(replyText))")
    }

    private func startFreshLunaSession(in app: XCUIApplication) {
        let panel = app.otherElements["tutor-panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 10), "The tutor panel must be present")
        panel.swipeRight()
        XCTAssertTrue(
            app.staticTexts["RECENT"].waitForExistence(timeout: 8),
            "Swiping the panel must reveal Sessions"
        )
        let newChat = app.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5), "Sessions must offer New chat")
        newChat.tap()
        XCTAssertTrue(
            app.staticTexts["Hi! I'm your AI Tutor"].waitForExistence(timeout: 8),
            "A new live Luna session must open on the greeting"
        )
    }

    /// Waits for the running turn to finish, and only then returns.
    ///
    /// A finished turn collapses its activity trail to a "Worked for Xs" button — `duration`
    /// is set on `.done` and on no earlier event, so this is a true completion signal rather
    /// than a heuristic on prose. Polls up to `timeout`; still streaming returns `false`.
    private func completedTurnCount(in app: XCUIApplication) -> Int {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked for")).count
    }

    private func waitForTurnCompletion(
        in app: XCUIApplication,
        after previousCount: Int,
        timeout: TimeInterval
    ) -> Bool {
        let completed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked for"))
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "count > %d", previousCount),
            object: completed
        )
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        return result == .completed
    }

    /// The tutor's own reply text, or empty if none can be told apart from the learner's prompt.
    ///
    /// The prompt itself contains "colors", so a bare keyword match would return the learner's
    /// own message. Every static text that exactly equals the sent prompt is excluded, and the
    /// reply is preferred when it carries one of the explanation's signal words; otherwise the
    /// longest non-prompt tutor prose is returned as a fallback.
    private func scienceReplyText(in app: XCUIApplication) -> String {
        let signalWords = ["interference", "wavelength", "thin-film", "film", "light"]
        let labels = visibleStaticTextLabels(in: app)
        let promptExact = "Teach me why soap bubbles show rainbow colors. Search the internet for a high-contrast real photograph, place it on the board, and explain what the colors show."
        let candidates = labels.filter { $0 != promptExact }
        if let match = candidates.first(where: {
            let lower = $0.lowercased()
            return signalWords.contains { lower.contains($0) }
        }) {
            return match
        }
        return candidates.max(by: { $0.count < $1.count }) ?? ""
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
        environment: [String: String] = [:],
        acceptedWindowSizes requestedWindowSizes: [CGSize]? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIApplication {
        let acceptedWindowSizes = requestedWindowSizes ?? [Self.designSize]
        var lastFrame: CGRect = .zero
        for attempt in 1...3 {
            XCUIDevice.shared.orientation = .landscapeLeft

            let app = XCUIApplication()
            app.launchArguments = (resetting ? Self.designedScreenLaunch : []) + arguments
            if !environment.isEmpty {
                app.launchEnvironment = environment
            }
            app.launch()

            // Three bundled fonts make a cold launch slow, so the first assertion in every
            // test waits here rather than in the test body.
            _ = app.wait(for: .runningForeground, timeout: 30)

            // The *window's* frame, not `app.frame`: a landscape-only app always reports its
            // own 1376 × 1032 coordinate space from `app.frame`, even when iOS has letterboxed
            // it. Measured on a portrait device the window is (0, 301, 1032, 774) — the
            // rectangle between two 301pt black bars — which is what this catches.
            lastFrame = app.windows.firstMatch.frame
            if acceptedWindowSizes.contains(where: { Self.frame(lastFrame, matches: $0) }) {
                return app
            }

            XCTContext.runActivity(named: "Launch \(attempt) came up at \(lastFrame.size), rotating again") { _ in }
            app.terminate()
        }

        XCTFail(
            """
            The device did not rotate to landscape: the app came up at \(lastFrame.size) \
            rather than one of the accepted landscape sizes \(acceptedWindowSizes). Every geometry assertion in this \
            suite measures against that frame, so the run is stopped rather than reported \
            against a letterboxed screen.
            """,
            file: file,
            line: line
        )
        return XCUIApplication()
    }

    private static func frame(_ frame: CGRect, matches size: CGSize) -> Bool {
        abs(frame.width - size.width) < 1 && abs(frame.height - size.height) < 1
    }

    private static func isDesignSized(_ frame: CGRect) -> Bool {
        self.frame(frame, matches: designSize)
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

    private func saturatedPixelCount(in screenshot: XCUIScreenshot) -> Int {
        guard let image = UIImage(data: screenshot.pngRepresentation)?.cgImage else { return 0 }
        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        guard let context = CGContext(
            data: &bytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return 0 }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        var count = 0
        for y in 0..<height {
            for x in 0..<width {
                let index = y * bytesPerRow + x * 4
                let red = Int(bytes[index])
                let green = Int(bytes[index + 1])
                let blue = Int(bytes[index + 2])
                let maximum = max(red, green, blue)
                let minimum = min(red, green, blue)
                if maximum - minimum >= 30 && maximum < 250 {
                    count += 1
                }
            }
        }
        return count
    }

    /// PNG bytes are not a stable screenshot identity: CoreGraphics may choose a different
    /// ancillary chunk or antialias one edge on the next frame even when the visible content is
    /// unchanged. Count material pixel changes instead, so this regression catches a translated
    /// chat (thousands of changed pixels) without failing on that encoding noise.
    private func changedPixelCount(
        from before: Data,
        to after: XCUIScreenshot,
        maxWidthFraction: CGFloat = 1
    ) -> Int {
        guard
            let beforeImage = UIImage(data: before)?.cgImage,
            let afterImage = UIImage(data: after.pngRepresentation)?.cgImage,
            beforeImage.width == afterImage.width,
            beforeImage.height == afterImage.height
        else { return .max }

        let width = beforeImage.width
        let height = beforeImage.height
        let comparedWidth = min(width, max(1, Int(CGFloat(width) * maxWidthFraction)))
        let bytesPerRow = width * 4
        var beforeBytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        var afterBytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        guard
            let beforeContext = CGContext(
                data: &beforeBytes,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ),
            let afterContext = CGContext(
                data: &afterBytes,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return .max }

        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        beforeContext.draw(beforeImage, in: bounds)
        afterContext.draw(afterImage, in: bounds)

        var changed = 0
        for y in 0..<height {
            for x in 0..<comparedWidth {
                let index = y * bytesPerRow + x * 4
                let maxDelta = max(
                    abs(Int(beforeBytes[index]) - Int(afterBytes[index])),
                    abs(Int(beforeBytes[index + 1]) - Int(afterBytes[index + 1])),
                    abs(Int(beforeBytes[index + 2]) - Int(afterBytes[index + 2]))
                )
                if maxDelta > 4 { changed += 1 }
            }
        }
        return changed
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

    /// Presses `element` and drags the finger `points` horizontally before lifting — a
    /// controlled micro-drift that reproduces the 10–12 pt dead zone between the row's old
    /// tap slop and the drawer pan's commit threshold.
    private func pressWithDrift(_ element: XCUIElement, points: CGFloat, _ message: String) {
        XCTAssertTrue(element.exists, message)
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: points, dy: 0))
        start.press(forDuration: 0.08, thenDragTo: end)
    }

    /// Records dropped taps in the test report so a rising rate stays visible instead of
    /// being silently absorbed by the retry.
    private func noteDroppedTap(attempt: Int, of attempts: Int, message: String) {
        XCTContext.runActivity(named: "Tap \(attempt) of \(attempts) was not delivered, retrying — \(message)") { _ in }
    }
}
