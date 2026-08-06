import Combine
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

    /// Axis C. The design gives it exactly one control in each direction, so it
    /// is guarded the same way the other two axes are.
    @Published private(set) var isSelectionAttached: Bool

    /// The rail's three selections carry no invariant between them — any tool
    /// works with any colour and any width — so they are plain settable state
    /// rather than transitions.
    @Published var tool: BoardTool = .defaultValue
    @Published var penColor: PenColor = .defaultValue
    @Published var thickness: StrokeThickness = .defaultValue

    init(
        presentation: TutorPresentation = .docked,
        conversation: ConversationPhase = .start,
        isSelectionAttached: Bool = false
    ) {
        self.presentation = presentation
        self.conversation = conversation
        self.isSelectionAttached = isSelectionAttached
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

    /// The board peek on the left edge of screen 07 — the only board affordance
    /// on that screen, and the way back to the docked panel.
    func returnToBoard() {
        presentation = .docked
    }

    /// Sending from the composer, or tapping any suggestion chip. One-way: the
    /// design has no control that returns a thread to the greeting.
    func beginConversation() {
        conversation = .active
    }

    /// `btn/select` on the board produces the composer's attached selection.
    func attachBoardSelection() {
        isSelectionAttached = true
    }

    /// The ✕ on the `Selection attached` chip, and the send that consumes it —
    /// screen 08 shows the selection in the thread, not still in the composer.
    func clearBoardSelection() {
        isSelectionAttached = false
    }
}
