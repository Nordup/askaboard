import SwiftUI

/// The tutor panel's frame, and the one derivation everything inside it hangs off.
///
/// Board 02, verbatim: *"The panel is the only fixed-width surface in the product, and
/// everything inside it is laid out against one derived number: panel width minus twice the
/// panel inset equals the content width. Hard-coding 301 anywhere is a bug waiting for the
/// first panel-width change."*
///
/// So `contentWidth` is computed and `DS.Container.panelContent` is only ever the thing it
/// is checked against.
enum TutorPanelMetrics {
    /// `--container-panel`. Board 02 calls the panel *"the only fixed-width surface in the
    /// product"*, and it stays fixed here: on the narrowest iPad the design's lanes still
    /// leave 511pt of board beside it, so nothing forces the panel to give width back. Its
    /// **height** is the one that moved — that was the content band of a 1032pt screen.
    static let width = DS.Container.panel
    static let inset = DS.Space.panelInset
    static let cornerRadius = DS.Radius.xxxl

    /// The board's one rule, as a function of whatever width the panel is given: *"panel
    /// width minus twice the panel inset equals the content width. Hard-coding 301 anywhere
    /// is a bug waiting for the first panel-width change."*
    ///
    /// `max(0, …)` because a width under 36 would otherwise hand `.frame` a negative side.
    static func contentWidth(for width: CGFloat) -> CGFloat { max(0, width - 2 * inset) }

    /// The same derivation at the design's one panel width: `337 − 2 × 18 = 301`. Kept
    /// because every child of the panel is measured against it, and it is still derived —
    /// what it must never become is a stored 301.
    static var contentWidth: CGFloat { contentWidth(for: width) }

    // MARK: - Panel controls

    static let controlsHeight: CGFloat = 32
    static let controlsGap: CGFloat = 14
    static let controlButton: CGFloat = 32

    /// **Not from the design.** Board 02 flags the 32pt buttons as smaller than the 44pt
    /// HIG minimum and states no expanded hit area — it calls the gap "unaddressed", having
    /// solved the same problem for the rail with a 54pt slot and a 54pt swatch pitch. 44 is
    /// the minimum that closes it. With a 14pt gap the two 44pt targets sit 2pt apart, so
    /// nothing overlaps and nothing on the row moves.
    static let controlTapTarget: CGFloat = 44
}

/// The fixed-width right-hand tutor surface, as a container only.
///
/// Board 09, on why this is a container: *"The outer frame is identical to screen 05 down
/// to the pixel — only the tutor panel's contents change — so a developer implements one
/// shell and swaps what fills the panel."* Screens 05 and 08 pass different bodies and get
/// the same panel.
///
/// The panel's 18pt bottom inset is emergent in the design rather than declared, and the
/// board's own arithmetic for it does not close (`18 + 918` fills a 936 box exactly, leaving
/// nothing). Board 02 says to implement the rule and not the literal, so the shell pins the
/// top inset and leaves the bottom to the content: a bottom-anchored composer with an 18pt
/// inset reproduces the design, and nothing here forces it.
///
/// The size arrives from the caller. 936 was never the panel's own number — it was the
/// content band left by one screen's status bar and edge insets — and the 18pt inset that
/// *is* the panel's own survives being handed any size at all, which is the whole point of
/// deriving the content column instead of storing it.
struct TutorPanelShell<Content: View>: View {
    private let size: CGSize
    private let content: Content

    init(size: CGSize, @ViewBuilder content: () -> Content) {
        self.size = CGSize(width: max(0, size.width), height: max(0, size.height))
        self.content = content()
    }

    var body: some View {
        content
            .frame(width: TutorPanelMetrics.contentWidth(for: size.width))
            .padding(.top, TutorPanelMetrics.inset)
            .frame(
                width: size.width,
                height: size.height,
                alignment: .top
            )
            .background(
                RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius)
                    .fill(DS.Color.surfacePanel)
            )
            .elevation(.panel)
    }
}

/// The two-button row that docks the tutor or takes it full-screen.
///
/// Board 02, a "do not change this" note, verbatim: *"Both glyphs are outline only. An
/// earlier version filled the smaller region of the dock glyph and everyone read it as a
/// battery-percentage indicator, so the fill was removed and the two icons were made the
/// same rect differing by a single divider stroke. **Do not reintroduce a fill to 'show
/// which pane is active' — that is the exact change that was rejected.**"*
///
/// Which is also why neither button takes a selected or pressed background here: the design
/// draws none, and the one obvious way to add one is the one the designer rejected.
struct PanelControls: View {
    let onDock: () -> Void
    let onFullScreen: () -> Void

    var body: some View {
        HStack(spacing: TutorPanelMetrics.controlsGap) {
            button(.controlDock, label: "Collapse tutor to the dock", action: onDock)
            button(.controlFull, label: "Show tutor full screen", action: onFullScreen)
        }
        .frame(
            width: TutorPanelMetrics.contentWidth,
            height: TutorPanelMetrics.controlsHeight,
            alignment: .leading
        )
    }

    private func button(_ icon: Icon, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            IconView(icon)
                .frame(width: TutorPanelMetrics.controlButton, height: TutorPanelMetrics.controlButton)
                .expandedTapTarget(TutorPanelMetrics.controlTapTarget, over: TutorPanelMetrics.controlButton)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

#if DEBUG
#Preview("Tutor panel shell") {
    TutorPanelShell(size: CGSize(width: TutorPanelMetrics.width, height: 600)) {
        VStack(spacing: 0) {
            PanelControls(onDock: {}, onFullScreen: {})
            Orb(.panel).padding(.top, 120)
            Spacer(minLength: 0)
        }
    }
    .padding(44)
    .background(DS.Color.surfaceScreen)
}
#endif
