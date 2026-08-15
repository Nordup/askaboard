import SwiftUI

enum CollapsedDockMetrics {
    /// `--spacing-4`. Board 01 rule 9 prefers the semantic name for layout, but this is a
    /// gap inside a component, and the design cites the numeric token here.
    static let gap = DS.Space.s4
    static let selectButton: CGFloat = 52
    static let selectIcon: CGFloat = 24
    static let orb = OrbSize.dock.metrics.frame.width

    /// `52 + 16 + 64 = 132`, summed from the parts rather than restated. The dock is the one
    /// shell surface whose size is genuinely its own — it is as wide as what it holds, at
    /// every screen size — so this is the rare number that stays a constant here. What was
    /// screen-derived was its *position*, and that was always the caller's.
    static var width: CGFloat { selectButton + gap + orb }
    /// The orb, not the button, sets the row height.
    static var height: CGFloat { OrbSize.dock.metrics.frame.height }
}

/// What the tutor becomes when collapsed: a selection button plus the orb.
///
/// Board 02: *"When the tutor collapses, the dock anchors to the board, not the screen:
/// 24pt inside the board's bottom-left corner. Measured from the screen edge the same
/// position reads 52pt, which is a number that quietly breaks the moment the board's own
/// 28pt inset changes. Anchor to the board rect and the dock follows it for free."* The
/// anchoring is the caller's — the layout carries it, measured off the collapsed board's
/// bottom-left corner at whatever size that board came out — and this view is only the
/// 132 × 64 row.
///
/// **Elevation drift, unresolved in the design.** The board gives `btn/select` the shadow
/// `#1414320F 0 2 6, #1414320A 0 1 2` and annotates it "drifts from 03 Control (0D / 08)",
/// without marking it resolved the way it marks the rail's height regression. Rather than
/// encode a fourth shadow that exists only as a drift, this uses `.control`; the difference
/// is 2/255 and 2/255 of alpha on a `#141432` shadow over white, which is below what the
/// display resolves.
///
/// **During a live voice call the orb slot shows the animated mascot instead of the
/// orb.** It arrives as `liveFace`, built by the screen, because the mascot is a voice
/// feature's view and this component is shell — no Shell component names a feature type,
/// and the dock is not where that changes. The slot box, the circular tap shape and the
/// label stay exactly the orb's: the face is visual only, the whole dock remains the tap
/// target that opens the chat, and the call's controls (mute, end) live in the voice bar
/// there. No extra discs here — that is the decision, not an omission.
struct CollapsedDock<LiveFace: View>: View {
    /// Whether the board is currently attached to the composer. This is the state
    /// `btn/select` draws — see `selectButton`.
    var isSelectionAttached: Bool = false
    /// Whether there is anything on the board to attach. **Not a state the design
    /// draws** — see `selectButton`.
    var canSelect: Bool = true
    let onSelect: () -> Void
    let onOpenTutor: () -> Void
    /// The orb slot's live-call face, `nil` whenever no call is live — and then the slot
    /// is the plain orb, pixel for pixel what it was before voice existed.
    var liveFace: LiveFace? = nil

    /// Orb first, then the selection button. The dock anchors to the board's bottom-**left**
    /// corner now, so the orb takes the outer side — the side the reach comes from — and the
    /// pair reads outward from the screen edge exactly as it did when the dock sat in the
    /// opposite corner.
    var body: some View {
        HStack(spacing: CollapsedDockMetrics.gap) {
            orbButton
            selectButton
        }
        .frame(width: CollapsedDockMetrics.width, height: CollapsedDockMetrics.height)
    }

    /// **The control's two colour states are the design's, and were missing.**
    ///
    /// Board 04 on `ui/selection-marker`: *"It is one asset in two colour states:
    /// `--color-brand` when a selection is live, `--color-icon` when the control is
    /// idle."* The dock drew only the idle one, so tapping `btn/select` changed
    /// nothing anywhere on screen — the "Selection attached" card that is its only
    /// other evidence lives in the composer, which is exactly the thing the
    /// collapsed state has hidden. A control whose whole result is invisible from
    /// the state it is reachable in is a control that does not work, and this is
    /// the state the design had already specified for it.
    ///
    /// It follows that the button is a **toggle**: once the glyph can say a
    /// selection is live, the same tap has to be able to take it back, and the
    /// design gives the board no other control that could.
    ///
    /// **`canSelect` is not from the design**, which draws no disabled state
    /// (05-screens open question 8). An empty board has nothing to attach, and the
    /// button used to swallow the tap in silence — the same do-nothing this whole
    /// note is about. Dimming is the smallest honest answer, but it is a new
    /// visual state and belongs in Paper before it belongs here.
    private var selectButton: some View {
        Button(action: onSelect) {
            // `ui/selection-marker` is the same glyph the composer uses for an attached
            // board selection; board 05 notes the pairing is deliberate, so the dashed
            // square means "a region of the board" in both places.
            IconView(
                .uiSelectionMarker,
                size: CollapsedDockMetrics.selectIcon,
                tint: isSelectionAttached ? DS.Color.brand : DS.Color.icon
            )
            .frame(width: CollapsedDockMetrics.selectButton, height: CollapsedDockMetrics.selectButton)
            // Board 01 rule 19: `--radius-full` is Paper's `calc(infinity * 1px)`; use a
            // capsule. On a square that is a circle, and it stays right if the button
            // ever stops being square.
            .background(Capsule().fill(DS.Color.surface))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .elevation(.control)
        .opacity(canSelect || isSelectionAttached ? 1 : 0.4)
        .disabled(!canSelect && !isSelectionAttached)
        .accessibilityLabel("Select an area of the board")
        .accessibilityValue(isSelectionAttached ? "Attached" : "Not attached")
        .accessibilityAddTraits(isSelectionAttached ? .isSelected : [])
    }

    /// The slot is framed here rather than by its occupant: `Orb(.dock)` sizes itself to
    /// the same 64pt box, but the mascot's layout box is only its 44×34 face — the dock
    /// orb's own body, which is where `MascotVariant.dock` centres it — so the explicit
    /// frame is what keeps the row's geometry and the circular tap shape identical in
    /// both states. Either occupant's glow overdraws the slot freely; neither hit-tests.
    private var orbButton: some View {
        Button(action: onOpenTutor) {
            Group {
                if let liveFace {
                    liveFace
                } else {
                    Orb(.dock)
                }
            }
            .frame(width: CollapsedDockMetrics.orb, height: CollapsedDockMetrics.height)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open the tutor")
    }
}

/// The dock with nothing live in the orb slot — every pre-voice call site, unchanged.
/// (The memberwise initializer cannot infer `LiveFace` from an omitted argument, so the
/// default is stated once here rather than at each site.)
extension CollapsedDock where LiveFace == EmptyView {
    init(
        isSelectionAttached: Bool = false,
        canSelect: Bool = true,
        onSelect: @escaping () -> Void,
        onOpenTutor: @escaping () -> Void
    ) {
        self.init(
            isSelectionAttached: isSelectionAttached,
            canSelect: canSelect,
            onSelect: onSelect,
            onOpenTutor: onOpenTutor,
            liveFace: nil
        )
    }
}

#if DEBUG
#Preview("Collapsed dock") {
    VStack(spacing: 40) {
        CollapsedDock(isSelectionAttached: false, onSelect: {}, onOpenTutor: {})
        CollapsedDock(isSelectionAttached: true, onSelect: {}, onOpenTutor: {})
        CollapsedDock(isSelectionAttached: false, canSelect: false, onSelect: {}, onOpenTutor: {})
    }
    .padding(60)
    .background(DS.Color.surfaceScreen)
}
#endif
