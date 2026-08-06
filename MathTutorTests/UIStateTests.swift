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
}
