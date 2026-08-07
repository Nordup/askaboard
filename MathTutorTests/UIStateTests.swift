import CoreGraphics
import XCTest
@testable import MathTutor

@MainActor
final class UIStateTests: XCTestCase {
    func testAFreshStateIsScreen05() {
        let state = UIState()

        XCTAssertEqual(state.presentation, .docked)
        XCTAssertEqual(state.conversation, .start)
        XCTAssertFalse(state.isSelectionAttached)
        XCTAssertEqual(state.tool, .pen)
        XCTAssertEqual(state.penColor, .black)
        XCTAssertEqual(state.thickness, .medium)
    }

    func testTheDesignsTransitionTableWalksTheWholeStateTable() {
        let state = UIState()

        // 05 → 06 → 05: the dock control, then the orb.
        state.collapseTutor()
        XCTAssertEqual(state.presentation, .collapsed)
        state.restoreTutorFromDock()
        XCTAssertEqual(state.presentation, .docked)

        // 05 → 07 → 05: the full-screen control, then the board peek.
        state.expandTutorToFullScreen()
        XCTAssertEqual(state.presentation, .fullScreen)
        state.returnToBoard()
        XCTAssertEqual(state.presentation, .docked)

        // 05 → 08: sending, or tapping a suggestion chip.
        state.beginConversation()
        XCTAssertEqual(state.presentation, .docked)
        XCTAssertEqual(state.conversation, .active)

        // 08 → 06 → 08: collapsing hides the thread rather than ending it, so
        // the orb must return the student to their conversation, not a greeting.
        state.collapseTutor()
        XCTAssertEqual(state.conversation, .active)
        state.restoreTutorFromDock()
        XCTAssertEqual(state.presentation, .docked)
        XCTAssertEqual(state.conversation, .active)
    }

    func testStartingAConversationIsOneWayAndIdempotent() {
        let state = UIState()

        state.beginConversation()
        state.beginConversation()

        XCTAssertEqual(state.conversation, .active)
    }

    func testPresentationTransitionsNeverTouchTheConversation() {
        for phase in ConversationPhase.allCases {
            for presentation in TutorPresentation.allCases {
                let state = UIState(presentation: presentation, conversation: phase)

                state.collapseTutor()
                XCTAssertEqual(state.conversation, phase)
                state.expandTutorToFullScreen()
                XCTAssertEqual(state.conversation, phase)
                state.restoreTutorFromDock()
                XCTAssertEqual(state.conversation, phase)
                state.returnToBoard()
                XCTAssertEqual(state.conversation, phase)
            }
        }
    }

    func testBeginningAConversationNeverTouchesThePresentation() {
        for presentation in TutorPresentation.allCases {
            let state = UIState(presentation: presentation, conversation: .start)

            state.beginConversation()

            XCTAssertEqual(state.presentation, presentation)
            XCTAssertEqual(state.conversation, .active)
        }
    }

    func testEveryCellOfTheStateTableIsReachable() {
        for presentation in TutorPresentation.allCases {
            for phase in ConversationPhase.allCases {
                let state = UIState()
                if phase == .active { state.beginConversation() }
                switch presentation {
                case .docked: break
                case .collapsed: state.collapseTutor()
                case .fullScreen: state.expandTutorToFullScreen()
                }

                XCTAssertEqual(state.presentation, presentation)
                XCTAssertEqual(state.conversation, phase)
            }
        }
    }

    func testTheUndesignedCellIsReachableAndNamedRatherThanRedirected() {
        // Expanding during a thread and sending while full-screen are the two
        // ways in. Neither may silently re-dock the panel or reset the thread.
        let expandedDuringThread = UIState()
        expandedDuringThread.beginConversation()
        expandedDuringThread.expandTutorToFullScreen()

        let sentWhileFullScreen = UIState()
        sentWhileFullScreen.expandTutorToFullScreen()
        sentWhileFullScreen.beginConversation()

        for state in [expandedDuringThread, sentWhileFullScreen] {
            XCTAssertEqual(state.presentation, .fullScreen)
            XCTAssertEqual(state.conversation, .active)
            XCTAssertTrue(state.isUndesignedFullScreenThread)
        }

        // And it is exactly one cell, not a catch-all for "unusual".
        for presentation in TutorPresentation.allCases {
            for phase in ConversationPhase.allCases {
                let state = UIState(presentation: presentation, conversation: phase)
                XCTAssertEqual(
                    state.isUndesignedFullScreenThread,
                    presentation == .fullScreen && phase == .active
                )
            }
        }
    }

    func testTheUndesignedCellLeavesThroughEitherAxisWithoutStranding() {
        let backToTheBoard = UIState(presentation: .fullScreen, conversation: .active)
        backToTheBoard.returnToBoard()
        XCTAssertFalse(backToTheBoard.isUndesignedFullScreenThread)
        XCTAssertEqual(backToTheBoard.presentation, .docked)
        XCTAssertEqual(backToTheBoard.conversation, .active, "Screen 08 is where leaving full screen lands")

        let collapsed = UIState(presentation: .fullScreen, conversation: .active)
        collapsed.collapseTutor()
        XCTAssertFalse(collapsed.isUndesignedFullScreenThread)
        XCTAssertEqual(collapsed.presentation, .collapsed)
    }

    func testBoardSelectionAttachesAndDismissesIndependentlyOfBothAxes() {
        let state = UIState()
        XCTAssertFalse(state.isSelectionAttached)

        state.attachBoardSelection()
        XCTAssertTrue(state.isSelectionAttached)

        state.collapseTutor()
        state.restoreTutorFromDock()
        state.expandTutorToFullScreen()
        state.beginConversation()
        XCTAssertTrue(state.isSelectionAttached, "No presentation or conversation transition may drop an attachment")

        state.clearBoardSelection()
        XCTAssertFalse(state.isSelectionAttached)
        XCTAssertEqual(state.presentation, .fullScreen)
        XCTAssertEqual(state.conversation, .active)
    }

    func testRailSelectionsAreIndependentOfEachOtherAndOfThePanel() {
        let state = UIState()

        state.tool = .lasso
        state.penColor = .red
        state.thickness = .bold
        state.collapseTutor()
        state.beginConversation()

        XCTAssertEqual(state.tool, .lasso)
        XCTAssertEqual(state.penColor, .red)
        XCTAssertEqual(state.thickness, .bold)
    }

    // MARK: - Panel width

    func testPanelWidthStartsAtTheDesignsOwnWidth() {
        XCTAssertEqual(UIState().panelWidth, ScreenLayout.minimumPanelWidth)
    }

    func testSettingPanelWidthRecordsIt() {
        let state = UIState()
        state.setPanelWidth(480)
        XCTAssertEqual(state.panelWidth, 480)
    }

    func testResettingReturnsToTheDesignsWidth() {
        let state = UIState()
        state.setPanelWidth(480)
        state.resetPanelWidth()
        XCTAssertEqual(state.panelWidth, ScreenLayout.minimumPanelWidth)
    }

    func testANonFiniteWidthIsRefusedRatherThanStored() {
        let state = UIState()
        state.setPanelWidth(480)
        state.setPanelWidth(.nan)
        XCTAssertEqual(state.panelWidth, 480, "the last good width survives")
    }

    /// Width and presentation are independent axes, exactly like the two the design already
    /// has. Collapsing must not forget the width, or reopening the panel would silently
    /// undo a resize the student asked for.
    func testCollapsingAndRestoringPreservesTheWidth() {
        let state = UIState()
        state.setPanelWidth(480)
        state.collapseTutor()
        XCTAssertEqual(state.panelWidth, 480, "still 480 while collapsed")
        state.restoreTutorFromDock()
        XCTAssertEqual(state.panelWidth, 480, "and on the way back")
    }

    /// The collapse-by-*drag* route, mirroring exactly what `ResizeHandle.onChanged` does on
    /// the frame that crosses the collapse threshold: resolve a frame, write it into this
    /// binding through `ResizeModel.nextSize`, and only then fire `onCollapse`. Reusing the
    /// two real production functions rather than re-deriving their answer is what lets this
    /// test catch a regression in either one, rather than only in a hand-rolled copy of what
    /// they are supposed to do — see `ShellComponentTests`' resize-width tests, fixed for the
    /// mirror-image reason, for what a copy would miss.
    ///
    /// Before `ResizeModel.nextSize` existed, `ResizeHandle` wrote `resolution.size` — the
    /// floor — directly into this binding before calling `onCollapse`. Replacing the
    /// `ResizeModel.nextSize(...)` call below with a bare `resolution.size` reproduces that
    /// bug and fails this test with `panelWidth == 337`.
    func testCollapsingByDragPreservesTheRequestedWidthNotTheFloor() {
        let state = UIState()
        state.setPanelWidth(480)

        // The tutor panel's own numbers, matching `BoardScreen.resizeHandle` and
        // `ResizeModelTests`' `panel` fixture: 337 floor, 600 ceiling, collapse at 0.6 × 337.
        let constraints = ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: 337 * 0.6)
        let resolution = ResizeModel.resolve(
            start: 480,
            translation: 400,
            edge: .leading,
            constraints: constraints
        )
        XCTAssertTrue(resolution.isCollapsed, "sanity: the drag must actually cross the collapse threshold")

        state.setPanelWidth(ResizeModel.nextSize(current: state.panelWidth, resolution: resolution))
        state.collapseTutor()

        XCTAssertEqual(
            state.panelWidth, 480,
            "the drag route must preserve the width exactly like the button route already does"
        )
    }

    /// Final review, Important 1: the resize binding's `get:` and `set:` are not inverse of
    /// each other. `BoardScreen.resizeHandle` wires `get:` to `layout.panelWidth` —
    /// `ScreenLayout.resolvingPanelWidth(uiState.panelWidth)`, clamped against the *current*
    /// window — but `set:` to `uiState.setPanelWidth`, which stores whatever it is handed,
    /// raw. `testCollapsingByDragPreservesTheRequestedWidthNotTheFloor` above passes
    /// `state.panelWidth` itself as `ResizeModel.nextSize`'s `current:` — the raw value — which
    /// is not what the shipped binding does: the shipped `get:` hands `ResizeHandle` the
    /// *clamped* read, not the raw store, so a gesture that starts from a stored width already
    /// pinned to a narrower window's ceiling anchors from the ceiling, not from the wider
    /// number the student actually asked for.
    ///
    /// This composes the same three real functions `BoardScreen` and `ResizeHandle` call —
    /// `ScreenLayout.resolvingPanelWidth`, `ResizeModel.resolve` / `nextSize`, and
    /// `UIState.setPanelWidth` — clamped getter in, write out, exactly as the binding does,
    /// rather than re-deriving their answer, for the same reason the test above does: a
    /// hand-rolled stand-in for the clamp could drift from the real one and stop protecting
    /// anything.
    ///
    /// `ResizeHandle`'s own write itself lives inside a private `DragGesture` closure with no
    /// `@testable` seam — a `Binding`'s `get`/`set` pair cannot be reached from outside the
    /// view that builds it without instantiating and driving the gesture on a live view host,
    /// which is exactly the kind of simulator-dependent test the suite's own header explains
    /// `ResizeModelTests` exists to avoid. So the guard `ResizeHandle` applies before writing —
    /// skip the write when the resolved value already equals what the getter reports — is
    /// inlined here rather than called, and is what a regression in `ResizeHandle.swift` that
    /// deleted that guard would *not* be caught by. What this test does cover, and did fail
    /// before that guard was written, is that the underlying hazard is real: composing a
    /// clamped read with a raw write, the way the app is actually wired, loses a wider stored
    /// request the moment the window narrows and the seam is touched again.
    func testWideningAgainstASplitViewCeilingDoesNotDiscardTheStoredRequest() {
        let state = UIState()
        state.setPanelWidth(600)

        // A window narrow enough that its docked lane's own ceiling — half the shared lane —
        // sits at 468, below the 600 already stored. `1112 - 176 = 936`, halved is 468.
        let narrowedWindow = ScreenLayout(size: CGSize(width: 1112, height: 1032))
        XCTAssertEqual(
            narrowedWindow.maximumPanelWidth, 468,
            "sanity: this window must actually squeeze the ceiling below the stored 600"
        )

        // `BoardScreen.resized(_:)`'s own clamp-on-read, and then the value `layout.panelWidth`
        // — the binding's `get:` — actually reports: the clamped 468, not the raw 600.
        let resolvedPanelWidth = narrowedWindow.resolvingPanelWidth(state.panelWidth)
        let layout = ScreenLayout(size: narrowedWindow.size, panelWidth: resolvedPanelWidth)
        XCTAssertEqual(
            layout.panelWidth, 468,
            "sanity: the getter reads back the clamped ceiling, not the raw 600"
        )

        // The gesture's anchor is `size` at grab time — the clamped getter's answer, exactly
        // like `ResizeHandle`'s own `@GestureState anchor` — and dragging further outward just
        // presses harder on the same ceiling, so `resolve` clamps right back to it.
        let constraints = ResizeConstraints(
            minimum: ScreenLayout.minimumPanelWidth,
            maximum: layout.maximumPanelWidth,
            collapseBelow: ScreenLayout.minimumPanelWidth * 0.6
        )
        let resolution = ResizeModel.resolve(
            start: layout.panelWidth,
            translation: -50,
            edge: .leading,
            constraints: constraints
        )
        let next = ResizeModel.nextSize(current: layout.panelWidth, resolution: resolution)

        // `ResizeHandle`'s own guard: skip a write that only hands the getter's own answer
        // back to the setter. Deleting this `if` and writing unconditionally reproduces the
        // bug — `state.panelWidth` ends the test at 468, the ceiling, not 600.
        if next != layout.panelWidth {
            state.setPanelWidth(next)
        }

        XCTAssertEqual(
            state.panelWidth, 600,
            "the student pushed outward against a ceiling and must not have their 600 silently"
                + " replaced by the 468 it was clamped to"
        )
    }

    func testSettingWidthDoesNotDisturbEitherOtherAxis() {
        let state = UIState()
        state.beginConversation()
        state.setPanelWidth(480)
        XCTAssertEqual(state.presentation, .docked, "presentation")
        XCTAssertEqual(state.conversation, .active, "conversation")
    }
}
