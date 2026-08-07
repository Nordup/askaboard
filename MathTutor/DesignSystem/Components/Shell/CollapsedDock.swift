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
/// 24pt inside the board's bottom-right corner. Measured from the screen edge the same
/// position reads 52pt, which is a number that quietly breaks the moment the board's own
/// 28pt inset changes. Anchor to the board rect and the dock follows it for free."* The
/// anchoring is the caller's — the layout carries it, measured off the collapsed board's
/// bottom-right corner at whatever size that board came out — and this view is only the
/// 132 × 64 row.
///
/// **Elevation drift, unresolved in the design.** The board gives `btn/select` the shadow
/// `#1414320F 0 2 6, #1414320A 0 1 2` and annotates it "drifts from 03 Control (0D / 08)",
/// without marking it resolved the way it marks the rail's height regression. Rather than
/// encode a fourth shadow that exists only as a drift, this uses `.control`; the difference
/// is 2/255 and 2/255 of alpha on a `#141432` shadow over white, which is below what the
/// display resolves.
struct CollapsedDock: View {
    /// Whether the board is currently attached to the composer. This is the state
    /// `btn/select` draws — see `selectButton`.
    var isSelectionAttached: Bool = false
    /// Whether there is anything on the board to attach. **Not a state the design
    /// draws** — see `selectButton`.
    var canSelect: Bool = true
    let onSelect: () -> Void
    let onOpenTutor: () -> Void

    var body: some View {
        HStack(spacing: CollapsedDockMetrics.gap) {
            selectButton
            orbButton
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

    private var orbButton: some View {
        Button(action: onOpenTutor) {
            Orb(.dock)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open the tutor")
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
