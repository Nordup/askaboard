import Combine
import CoreGraphics
import Foundation

/// Where the tutor sits on screen. Axis A of the design's state model.
enum TutorPresentation: String, CaseIterable, Sendable {
    /// Screens 05 / 08 — the 337pt panel beside the board.
    case docked
    /// Screen 06 — the 132 × 64 dock; the board has the screen to itself.
    case collapsed
    /// Screen 07 — the 740pt column; the board survives only as an edge peek.
    case fullScreen
}

/// Whether the tutor is showing its greeting or a thread. Axis B.
enum ConversationPhase: String, CaseIterable, Sendable {
    /// Screens 05 / 07 — orb, greeting, and suggestion chips.
    case start
    /// Screen 08 — the message thread.
    case active
}

/// What is on screen and which board tool is armed.
///
/// This is deliberately not part of `LearningSession` and deliberately not on
/// `TutorStore`. None of it should persist: it must not round-trip through the
/// session JSON, and a student who quit with the tutor full-screen should come
/// back to their board. Keeping presentation next to session state is precisely
/// what grew `WorkspaceView` to 984 lines.
///
/// `ObservableObject` rather than `@Observable` so a view injects this and
/// `TutorStore` through the same mechanism; `TutorStore` predates the
/// observation macro and converting it is not part of this change.
@MainActor
final class UIState: ObservableObject {
    /// The two axes are independent, and every transition below preserves that:
    /// none of them writes the other axis. Screen 06 hides the conversation
    /// rather than resetting it, which is what lets the dock orb return the
    /// student to 05 or 08 correctly.
    @Published private(set) var presentation: TutorPresentation
    @Published private(set) var conversation: ConversationPhase

    /// Axis C, now three states rather than two — see `BoardSelection`.
    ///
    /// The design gives this axis exactly one control, `btn/select`, and drew it
    /// as a straight on/off. It cannot be: the thing being turned on is *a region
    /// of the board*, and picking one takes a drag. So the control arms the
    /// marquee and the drag attaches it, which is the same one-control axis with
    /// the middle of the interaction no longer missing.
    @Published private(set) var selection: BoardSelection

    /// What the composer's marquee glyph and the dock's `btn/select` draw their
    /// brand-violet state from. Kept as the old spelling because that is the
    /// question every call site actually asks.
    var isSelectionAttached: Bool { selection.isAttached }

    /// Axis D: how wide the student has asked the docked panel to be.
    ///
    /// Guarded like the other axes rather than left settable, because there is exactly one
    /// control that changes it and one that resets it — the same shape the design's other
    /// three axes have.
    ///
    /// **Stored unclamped, on purpose.** This is the width that was *asked for*; what fits
    /// is a question about the window, and the window is not this type's business —
    /// `UIState` deliberately does not know about the screen, in the same way `ScreenLayout`
    /// deliberately does not force a presentation. `BoardScreen` reconciles the two, which
    /// is what makes a resize survive a trip through Split View: the requested width is
    /// still here when the window comes back.
    ///
    /// It does not persist, like everything else on this type.
    @Published private(set) var panelWidth: CGFloat = ScreenLayout.defaultPanelWidth

    /// Whether the sessions drawer is revealed — boards 17 and 19.
    ///
    /// Here rather than in `@State` on the panel for the reason everything else
    /// on this type is: it is presentation, it must not persist, and it has to
    /// survive the panel's body being rebuilt by any of the publishers around it
    /// — a drawer that shut itself every time a tutor delta arrived would be
    /// impossible to use mid-turn. It has to be here for a second reason board
    /// 15a's dropdown did not: full-screen, the drawer is a lane of the *screen*
    /// and the reading column re-centres around it, so two surfaces read it.
    ///
    /// It replaces `isSessionMenuOpen`, and it is the same kind of thing: not a
    /// fifth axis, and no transition below preserves it. Every control that takes
    /// the learner somewhere the drawer cannot follow closes it first.
    ///
    /// **The open/closed state only.** The live position of a drag is not here —
    /// it is `@State` on the surface being dragged, for the reason
    /// `BoardScreen.previewPanelWidth` is: publishing an environment object on
    /// every touch event invalidates every consumer of it and the pane visibly
    /// stutters. This is written once, on release.
    @Published private(set) var isSessionsDrawerOpen = false

    /// Whether a session row's context menu is on screen — ground truth, not a guess.
    ///
    /// Written by the row's own `UIContextMenuInteraction` delegate (see
    /// `SessionsDrawer.SessionRowMenu`): true when the system reports the menu will display,
    /// false only after the dismissal animation has finished. That makes it the one fact the
    /// whole app can shield on — `BoardScreen` mounts a screen-wide layer over every surface
    /// while this is true, and suspends the drawer pan through `isDrawerPanSuspended`, so a
    /// tap that dismisses the menu can never also press whatever it landed on.
    ///
    /// Here rather than in `@State` on the drawer because the shield is the *screen's*: the
    /// stray tap can land on the chat strip, the composer, the rail or the board, none of
    /// which the drawer draws. It does not persist, like everything else on this type.
    @Published private(set) var isContextMenuActive = false

    /// The row's menu appeared or finished going away — see `isContextMenuActive`.
    func setContextMenuActive(_ active: Bool) {
        guard active != isContextMenuActive else { return }
        isContextMenuActive = active
    }

    /// The rail's three selections carry no invariant between them — any tool
    /// works with any colour and any width — so they are plain settable state
    /// rather than transitions.
    @Published var tool: BoardTool = .defaultValue
    @Published var penColor: PenColor = .defaultValue
    @Published var thickness: StrokeThickness = .defaultValue

    init(
        presentation: TutorPresentation = .docked,
        conversation: ConversationPhase = .start,
        selection: BoardSelection = .none
    ) {
        self.presentation = presentation
        self.conversation = conversation
        self.selection = selection
    }

    /// True for the one cell of the state table the design never drew: the
    /// full-screen column with a thread in it.
    ///
    /// The state is allowed to exist and is named here rather than being
    /// forbidden or quietly re-docked. Both of those alternatives would have one
    /// axis silently rewrite the other, which the design says they never do —
    /// and re-docking would invent a transition out of a table row the design
    /// leaves as a literal question mark. A feature branching on this should do
    /// the minimal obvious thing, the 740pt column with the thread where the
    /// greeting was, and not invent a layout that was never drawn.
    var isUndesignedFullScreenThread: Bool {
        presentation == .fullScreen && conversation == .active
    }

    /// `btn/dock` in `Panel controls` (screens 05 / 08).
    func collapseTutor() {
        presentation = .collapsed
    }

    /// `btn/full-screen` in `Panel controls` (screens 05 / 08).
    func expandTutorToFullScreen() {
        presentation = .fullScreen
    }

    /// `btn/orb` in the collapsed dock (screen 06). The conversation phase is
    /// untouched on purpose: it is what decides whether the panel comes back as
    /// screen 05 or screen 08.
    func restoreTutorFromDock() {
        presentation = .docked
    }

    /// The board peek on the trailing edge of screen 07 — the only board affordance
    /// on that screen, and the way back to the docked panel.
    func returnToBoard() {
        presentation = .docked
    }

    /// Sending from the composer, or tapping any suggestion chip. One-way: the
    /// design has no control that returns a thread to the greeting.
    func beginConversation() {
        conversation = .active
    }

    /// The conversation axis re-derived from a session, rather than moved by a
    /// control.
    ///
    /// `beginConversation` is one-way because no *control* returns a thread to a
    /// greeting, and none does. This is not that. Switching sessions replaces the
    /// conversation wholesale, so the axis is being recomputed for a different
    /// subject rather than walked backwards for the same one — an empty session
    /// must open on its greeting, and one with a thread must open on the thread.
    /// `RootView.resumeConversationIfNeeded` derives it the same way at launch.
    func showConversation(_ phase: ConversationPhase) {
        conversation = phase
    }

    /// `btn/select`, in the dock and in the composer: arm the marquee, or put the
    /// pencil back on the ink.
    ///
    /// A toggle over all three states rather than two, because the design gives
    /// the axis one control and something has to undo an armed-but-undrawn
    /// marquee as well as a drawn one. Toggling off an attached region throws it
    /// away, which is the same thing the chip's ✕ does and the only reading of
    /// "off" that leaves no state behind.
    func toggleBoardSelection() {
        selection = selection == .none ? .arming : .none
    }

    /// A finished marquee drag. Only ever called with a region `BoardMarquee`
    /// already judged big enough to be one.
    func attachBoardSelection(region: CGRect) {
        selection = .attached(region)
    }

    /// The ✕ on the `Selection attached` chip, and the send that consumes it —
    /// screen 08 shows the selection in the thread, not still in the composer.
    func clearBoardSelection() {
        selection = .none
    }

    /// A right-swipe that settled open — see `DrawerReveal.settlesOpen(progress:velocity:)`.
    func openSessionsDrawer() {
        isSessionsDrawerOpen = true
    }

    /// A left-swipe, a tap on the pushed-aside chat strip, picking a session, or
    /// any transition that changes what the tutor is showing.
    func closeSessionsDrawer() {
        isSessionsDrawerOpen = false
    }

    /// The resize handle in the gutter between the board and the panel.
    ///
    /// Non-finite values are refused rather than stored: a NaN here becomes a NaN frame
    /// width, and SwiftUI's response to that is an unrecoverable layout rather than a crash
    /// anybody could debug.
    func setPanelWidth(_ width: CGFloat) {
        guard width.isFinite else { return }
        panelWidth = width
    }

    /// Double-tapping the resize handle — VS Code's `onDidReset`, which is the one gesture
    /// every splitter in the world agrees on.
    func resetPanelWidth() {
        panelWidth = ScreenLayout.defaultPanelWidth
    }
}
