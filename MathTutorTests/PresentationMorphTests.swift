import XCTest
@testable import MathTutor

/// The container morph's arithmetic, pinned the way `DrawerReveal`'s and `DockReveal`'s are:
/// endpoints exactly, curves by their stated bands, and the release rule as a delegation
/// rather than a re-implementation.
///
/// **Endpoint pixel-parity is these tests' whole job.** `PresentationMorphLayer` renders the
/// two settled screens through the same functions a gesture frame uses, so "progress 0 draws
/// the docked screen and progress 1 draws the full-screen one" is not a rendering promise —
/// it is these equalities.
final class PresentationMorphTests: XCTestCase {

    private let layout = ScreenLayout.reference

    private var closed: PresentationMorph { PresentationMorph(layout: layout, isSidebarOpen: false) }
    private var open: PresentationMorph { PresentationMorph(layout: layout, isSidebarOpen: true) }

    // MARK: - Endpoints

    func testContainerStartsOnThePanelFrame() {
        let frame = closed.containerFrame(at: 0)
        XCTAssertEqual(frame.origin.x, layout.panelX)
        XCTAssertEqual(frame.origin.y, layout.contentTop)
        XCTAssertEqual(frame.width, layout.panelWidth)
        XCTAssertEqual(frame.height, layout.contentHeightAboveKeyboard)
    }

    func testContainerEndsOnTheChatPane() {
        // Sidebar shut: screen 07's full-bleed white — the whole screen.
        XCTAssertEqual(
            closed.containerFrame(at: 1),
            CGRect(x: 0, y: 0, width: layout.screenWidth, height: layout.screenHeight)
        )
        // Sidebar open: the pane board 19 leaves beside it, exactly as
        // `TutorFullScreen.chatSurface` frames it.
        XCTAssertEqual(
            open.containerFrame(at: 1),
            CGRect(
                x: layout.sessionsSidebarWidth,
                y: 0,
                width: layout.screenWidth - layout.sessionsSidebarWidth,
                height: layout.screenHeight
            )
        )
    }

    func testCornersRunPanelRadiusToPaneRadius() {
        let start = closed.containerRadii(at: 0)
        XCTAssertEqual(start.topLeading, TutorPanelMetrics.cornerRadius)
        XCTAssertEqual(start.topTrailing, TutorPanelMetrics.cornerRadius)
        XCTAssertEqual(start.bottomLeading, TutorPanelMetrics.cornerRadius)
        XCTAssertEqual(start.bottomTrailing, TutorPanelMetrics.cornerRadius)

        // Sidebar shut: no corners at all — the pane is the screen.
        let flat = closed.containerRadii(at: 1)
        XCTAssertEqual(flat.topLeading, 0)
        XCTAssertEqual(flat.bottomTrailing, 0)

        // Sidebar open: board 19's rounded leading seam, square trailing.
        let seam = open.containerRadii(at: 1)
        XCTAssertEqual(seam.topLeading, SessionsDrawerMetrics.chatCornerRadius)
        XCTAssertEqual(seam.bottomLeading, SessionsDrawerMetrics.chatCornerRadius)
        XCTAssertEqual(seam.topTrailing, 0)
        XCTAssertEqual(seam.bottomTrailing, 0)
    }

    /// The clip's far end is the screen even with the sidebar open — the looseness that
    /// keeps the resting sidebar toggle from snapping the chat's edge. See
    /// `PresentationMorph.clipFrame(at:)`.
    func testClipStartsOnThePanelAndEndsOnTheScreen() {
        XCTAssertEqual(open.clipFrame(at: 0), open.containerFrame(at: 0))
        XCTAssertEqual(
            open.clipFrame(at: 1),
            CGRect(x: 0, y: 0, width: layout.screenWidth, height: layout.screenHeight)
        )
        XCTAssertEqual(open.clipRadii(at: 0).topLeading, TutorPanelMetrics.cornerRadius)
        XCTAssertEqual(open.clipRadii(at: 1).topLeading, 0)
    }

    // MARK: - Travel

    func testTravelIsTheTrailingEdgesDistance() {
        // `1376 − 365 = 1011` on the reference screen, and independent of the sidebar:
        // both ends of the travel finish on the same trailing edge either way.
        XCTAssertEqual(closed.travel, layout.screenWidth - layout.dockTravel)
        XCTAssertEqual(open.travel, closed.travel)
        XCTAssertEqual(PresentationMorph.travel(in: layout), closed.travel)
        XCTAssertEqual(closed.travel, 1011)
    }

    func testProgressTracksTheFingerAndClampsBothEnds() {
        // One-to-one inside the travel, anchored at either end.
        XCTAssertEqual(PresentationMorph.progress(from: 0, translation: 505.5, travel: 1011), 0.5)
        XCTAssertEqual(PresentationMorph.progress(from: 1, translation: -1011, travel: 1011), 0)
        // Clamped — there is nothing past either end to reveal; see the doc for why this is
        // the drawer's rule and not the dock's rubber band.
        XCTAssertEqual(PresentationMorph.progress(from: 0, translation: 2000, travel: 1011), 1)
        XCTAssertEqual(PresentationMorph.progress(from: 1, translation: 200, travel: 1011), 1)
        XCTAssertEqual(PresentationMorph.progress(from: 0, translation: -50, travel: 1011), 0)
    }

    /// The release rule is `DrawerReveal.settlesOpen`, delegated — one thumb, one feel.
    func testReleaseRuleIsTheSharedOne() {
        for progress in stride(from: CGFloat(0), through: 1, by: 0.25) {
            for velocity in [CGFloat(-800), -300, -100, 0, 100, 300, 800] {
                XCTAssertEqual(
                    PresentationMorph.settlesFullScreen(progress: progress, velocity: velocity),
                    DrawerReveal.settlesOpen(progress: progress, velocity: velocity)
                )
            }
        }
    }

    // MARK: - The content crossfade

    func testOutgoingContentHoldsThenLeaves() {
        let morph = closed
        // Crisp for most of the travel — the stated band.
        XCTAssertEqual(morph.dockedContentOpacity(at: 0), 1)
        XCTAssertEqual(morph.dockedContentOpacity(at: 0.60), 1)
        // Gone by the band's end, and at the far endpoint exactly.
        XCTAssertEqual(morph.dockedContentOpacity(at: 0.90), 0)
        XCTAssertEqual(morph.dockedContentOpacity(at: 1), 0)
        // Monotonic in between — a crossfade that backtracks reads as a flicker.
        var last = 1.0
        for step in stride(from: CGFloat(0), through: 1, by: 0.05) {
            let value = morph.dockedContentOpacity(at: step)
            XCTAssertLessThanOrEqual(value, last + 1e-9)
            last = value
        }
    }

    func testIncomingContentArrivesLate() {
        let morph = closed
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 0), 0)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 0.55), 0)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 0.85), 1)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 1), 1)
        var last = 0.0
        for step in stride(from: CGFloat(0), through: 1, by: 0.05) {
            let value = morph.fullScreenContentOpacity(at: step)
            XCTAssertGreaterThanOrEqual(value, last - 1e-9)
            last = value
        }
    }

    /// No blank moment and no full double exposure: across the crossfade band the two
    /// opacities always sum to at least one side's full presence, and never to two.
    func testCrossfadeTradesRatherThanBlanksOrDoubles() {
        let morph = closed
        for step in stride(from: CGFloat(0), through: 1, by: 0.01) {
            let sum = morph.dockedContentOpacity(at: step) + morph.fullScreenContentOpacity(at: step)
            XCTAssertGreaterThanOrEqual(sum, 0.99, "blank frame at \(step)")
            XCTAssertLessThanOrEqual(sum, 1.75, "double exposure at \(step)")
        }
    }

    // MARK: - Shadow, board, sidebar

    func testShadowDissolvesEarly() {
        let morph = closed
        XCTAssertEqual(morph.panelShadowOpacity(at: 0), 1)
        XCTAssertEqual(morph.panelShadowOpacity(at: PresentationMorph.shadowGoneBy), 0)
        XCTAssertEqual(morph.panelShadowOpacity(at: 1), 0)
        // Still leading the content fade by a wide margin: the panel must not float
        // shadowless *and* faded at the same moment it is supposed to be crisp.
        XCTAssertEqual(morph.dockedContentOpacity(at: PresentationMorph.shadowGoneBy), 1)
    }

    func testBoardRidesTheContainersEdge() {
        let morph = closed
        // The board's shift is the container's own trailing-edge travel, so the gap between
        // the sheet's edge and the card's is constant through the drag.
        XCTAssertEqual(morph.boardShift(at: 0), 0)
        XCTAssertEqual(morph.boardShift(at: 1), morph.travel)
        let mid = morph.boardShift(at: 0.5)
        XCTAssertEqual(mid, DrawerReveal.wholePoints(morph.travel * 0.5))
        // Whole points: the card is a rasterised composite, and fractional travel shimmers.
        XCTAssertEqual(mid, mid.rounded())
        // At the far end the card has fully cleared the screen: its leading edge starts at
        // `boardX` and lands past the screen's own trailing edge.
        XCTAssertGreaterThanOrEqual(layout.boardX + morph.boardShift(at: 1), layout.screenWidth)
    }

    func testBoardAndPeekTradeOnTheContentCurves() {
        let morph = closed
        // The card is the docked half of the crossfade and the peek the full-screen half,
        // so the two ends are exactly today's two screens: card shown/peek absent at rest
        // docked, card invisible/peek full at rest full screen.
        XCTAssertEqual(morph.dockedContentOpacity(at: 0), 1)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 0), 0)
        XCTAssertEqual(morph.dockedContentOpacity(at: 1), 0)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 1), 1)
    }

    func testSidebarFoldsItsOwnWidthAlongTheProgress() {
        let morph = open
        // At rest in full screen the sidebar is home.
        XCTAssertEqual(morph.sidebarShift(at: 1), 0)
        // At docked it has folded its whole width off the leading edge.
        XCTAssertEqual(morph.sidebarShift(at: 0), -layout.sessionsSidebarWidth)
        // Whole points, monotonic.
        let mid = morph.sidebarShift(at: 0.5)
        XCTAssertEqual(mid, mid.rounded())
        XCTAssertLessThan(mid, 0)
        XCTAssertGreaterThan(mid, -layout.sessionsSidebarWidth)
    }

    func testContainerFillCrossesFromPanelToSurface() {
        let morph = closed
        XCTAssertEqual(morph.panelFillOpacity(at: 0), 1)
        XCTAssertEqual(morph.panelFillOpacity(at: 1), 0)
        XCTAssertEqual(morph.panelFillOpacity(at: 0.5), 0.5, accuracy: 1e-9)
    }

    /// Out-of-range progress — a defensive caller, an overshooting spring — renders as the
    /// nearer endpoint rather than extrapolating a frame nothing designed.
    func testCurvesClampOutsideTheTravel() {
        let morph = closed
        XCTAssertEqual(morph.containerFrame(at: -0.5), morph.containerFrame(at: 0))
        XCTAssertEqual(morph.containerFrame(at: 1.5), morph.containerFrame(at: 1))
        XCTAssertEqual(morph.dockedContentOpacity(at: -1), 1)
        XCTAssertEqual(morph.fullScreenContentOpacity(at: 2), 1)
        XCTAssertEqual(morph.boardShift(at: 2), morph.travel)
        XCTAssertEqual(morph.sidebarShift(at: -1), -layout.sessionsSidebarWidth)
    }
}
