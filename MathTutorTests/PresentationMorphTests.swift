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

    /// The corners finish early — Material's shape-mask threshold. Entering they complete
    /// by 75% of the travel; returning they run 0.30 … 0.90, so the panel's corners are
    /// back before the box has finished shrinking onto them.
    func testCornersFinishEarlyOnBothLegs() {
        // Enter: flat by 0.75, and still flat at 1.
        XCTAssertEqual(closed.containerRadii(at: 0.75).topTrailing, 0)
        XCTAssertEqual(closed.containerRadii(at: 0.75).topLeading, 0)
        // Return: full radius held from 0.30 down, flat from 0.90 up.
        XCTAssertEqual(
            closed.containerRadii(at: 0.30, returnLeg: true).topLeading,
            TutorPanelMetrics.cornerRadius
        )
        XCTAssertEqual(closed.containerRadii(at: 0.90, returnLeg: true).topTrailing, 0)
        // Both legs agree exactly at the endpoints.
        XCTAssertEqual(
            closed.containerRadii(at: 0, returnLeg: true).topLeading,
            closed.containerRadii(at: 0).topLeading
        )
        XCTAssertEqual(
            closed.containerRadii(at: 1, returnLeg: true).topTrailing,
            closed.containerRadii(at: 1).topTrailing
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

    // MARK: - Shadow, board, peek, sidebar

    func testShadowDissolvesEarly() {
        let morph = closed
        XCTAssertEqual(morph.panelShadowOpacity(at: 0), 1)
        XCTAssertEqual(morph.panelShadowOpacity(at: PresentationMorph.shadowGoneBy), 0)
        XCTAssertEqual(morph.panelShadowOpacity(at: 1), 0)
        // The panel's fill dissolves over the same band — the two read as one event.
        XCTAssertEqual(morph.panelFillOpacity(at: PresentationMorph.shadowGoneBy), 0)
    }

    /// The card slides `peekX − boardX` — 846 on the reference screen — so its leading edge
    /// lands **exactly on the peek's leading edge** and the card becomes the hinge tab,
    /// instead of exiting past it while a separate silhouette faded up in its place.
    func testBoardLandsOnThePeeksOwnLine() {
        let morph = closed
        XCTAssertEqual(morph.boardShift(at: 0), 0)
        XCTAssertEqual(morph.boardTravel, layout.peekX - layout.boardX)
        XCTAssertEqual(morph.boardTravel, 846)
        XCTAssertEqual(layout.boardX + morph.boardShift(at: 1), layout.peekX)
        // Whole points: the card is a rasterised composite, and fractional travel shimmers.
        let mid = morph.boardShift(at: 0.5)
        XCTAssertEqual(mid, mid.rounded())
        // The card never fades; the peek artwork crossfades over its last 15%.
        XCTAssertEqual(morph.peekOpacity(at: 0), 0)
        XCTAssertEqual(morph.peekOpacity(at: PresentationMorph.peekArrivesFrom), 0)
        XCTAssertEqual(morph.peekOpacity(at: 1), 1)
    }

    /// The mask resolves over the last 45% of the travel — and, at these curves, its cut
    /// edge stays at or past the screen's trailing edge for the whole flight. This is the
    /// proof that lets the live canvas stay **unmasked** (PencilKit's fast stroke path)
    /// with zero visible difference: `BoardFlightMask` is the design of record, held in
    /// reserve for curves where the window would actually bite.
    func testBoardMaskWindowNeverCutsOnScreen() {
        let morph = closed
        XCTAssertEqual(morph.boardMaskProgress(at: PresentationMorph.boardMaskFrom), 0)
        XCTAssertEqual(morph.boardMaskProgress(at: 1), 1)
        let cardWidth = layout.boardWidthDocked
        for step in stride(from: CGFloat(0), through: 1, by: 0.02) {
            let leading = layout.boardX + morph.boardShift(at: step)
            let window = cardWidth + (BoardPeekMetrics.width - cardWidth) * morph.boardMaskProgress(at: step)
            XCTAssertGreaterThanOrEqual(
                leading + window, layout.screenWidth - 0.5,
                "the mask's cut edge would be visible at \(step)"
            )
        }
    }

    /// The rail leaves as one plane with the board — the identical shift, whole points —
    /// while fading over the first 35%: gone before the container has grown past it,
    /// back over the same band on the return leg, exact at both ends.
    func testRailRidesTheBoardAndFadesEarly() {
        let morph = closed
        for step in stride(from: CGFloat(0), through: 1, by: 0.1) {
            XCTAssertEqual(morph.railShift(at: step), morph.boardShift(at: step), "at \(step)")
        }
        XCTAssertEqual(PresentationMorph.railOpacity(at: 0), 1)
        XCTAssertEqual(PresentationMorph.railOpacity(at: PresentationMorph.railGoneBy), 0)
        XCTAssertEqual(PresentationMorph.railOpacity(at: 1), 0)
        // Wider than the controls' band — a bigger thing needs longer to leave — but
        // still gone in the first half of the travel.
        XCTAssertGreaterThan(PresentationMorph.railGoneBy, PresentationMorph.controlsGoneBy)
        XCTAssertLessThanOrEqual(PresentationMorph.railGoneBy, 0.5)
        // Monotonic out: the rail never flickers back on the way.
        var last = 1.0
        for step in stride(from: CGFloat(0), through: 1, by: 0.05) {
            let opacity = PresentationMorph.railOpacity(at: step)
            XCTAssertLessThanOrEqual(opacity, last + 1e-9, "at \(step)")
            last = opacity
        }
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

    /// The fill dissolve is compressed into the first 30% — two colours two points apart do
    /// not need 1011 points to blend.
    func testContainerFillCrossesEarly() {
        let morph = closed
        XCTAssertEqual(morph.panelFillOpacity(at: 0), 1)
        XCTAssertEqual(morph.panelFillOpacity(at: 0.15), 0.5, accuracy: 1e-9)
        XCTAssertEqual(morph.panelFillOpacity(at: 0.30), 0)
        XCTAssertEqual(morph.panelFillOpacity(at: 1), 0)
    }

    // MARK: - The settle and its interruptions

    /// The arrival spring derives from the drawer's shared construction, two notches
    /// livelier — a scene that dipped 15% needs an arrival with real snap. The constant is
    /// pinned; the construction itself is `DrawerReveal.settle`, which is the sharing.
    func testArrivalSpringIsTheSharedOneANotchLivelier() {
        XCTAssertEqual(PresentationMorph.settleDamping, 20)
        XCTAssertLessThan(PresentationMorph.settleDamping, 30, "livelier than the drawer's")
    }

    /// A gesture that catches the morph mid-settle must not have the mounts pulled out
    /// from under it when the interrupted spring's completion finally fires: a stale
    /// completion is a no-op, and only the current flight's own completion releases.
    @MainActor
    func testStaleSettleCompletionDoesNotReleaseTheMounts() {
        let model = PresentationMorphModel()
        // Enter flight, released: the spring is running.
        model.begin(atFullScreen: false)
        model.settle(to: true, velocity: 0, travel: 1011) {}
        let interrupted = model.generation
        XCTAssertTrue(model.isSettling)
        // A new gesture grabs the morph before the spring finishes.
        model.begin(atFullScreen: true)
        XCTAssertTrue(model.isDragging)
        // The old spring's completion arrives late — and does nothing.
        model.finishSettle(of: interrupted) {
            XCTFail("a stale completion must not run the caller's release")
        }
        XCTAssertTrue(model.isSettling, "the mounts stay held under the live drag")
        XCTAssertTrue(model.isActive)
        // The new flight settles; its own completion is the one that releases.
        model.settle(to: false, velocity: 0, travel: 1011) {}
        var released = false
        model.finishSettle(of: model.generation) { released = true }
        XCTAssertTrue(released)
        XCTAssertFalse(model.isSettling)
    }

    /// Out-of-range progress — a defensive caller, an overshooting spring — renders as the
    /// nearer endpoint rather than extrapolating a frame nothing designed.
    func testCurvesClampOutsideTheTravel() {
        let morph = closed
        XCTAssertEqual(morph.containerFrame(at: -0.5), morph.containerFrame(at: 0))
        XCTAssertEqual(morph.containerFrame(at: 1.5), morph.containerFrame(at: 1))
        XCTAssertEqual(morph.peekOpacity(at: -1), 0)
        XCTAssertEqual(morph.peekOpacity(at: 2), 1)
        XCTAssertEqual(morph.boardShift(at: 2), morph.boardTravel)
        XCTAssertEqual(morph.sidebarShift(at: -1), -layout.sessionsSidebarWidth)
    }
}
