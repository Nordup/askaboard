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
        TutorPanelSurface(size: size) {
            content
                .frame(width: TutorPanelMetrics.contentWidth(for: size.width))
                .padding(.top, TutorPanelMetrics.inset)
                .frame(
                    width: size.width,
                    height: size.height,
                    alignment: .top
                )
        }
    }
}

/// The panel as a *surface*: its size, its fill, its radius, its shadow — and nothing about
/// what is laid out on it.
///
/// `TutorPanelShell` is this plus the 18pt inset and the derived content column, which is what
/// every caller with a simple vertical stack of children wants. The live panel is the one that
/// cannot use it: its thread runs the panel's full height and passes *behind* the controls
/// row, and its two fades span corner to corner rather than the 301 column, so it places its
/// own bands against the surface directly.
///
/// The clip is the design's `overflow: clip`, and it is load-bearing now in a way it was not
/// when the thread stopped below the controls: a thread anchored at panel-local y 0 has its
/// oldest message hard against the surface's rounded corners.
struct TutorPanelSurface<Content: View>: View {
    private let size: CGSize
    private let content: Content

    init(size: CGSize, @ViewBuilder content: () -> Content) {
        self.size = CGSize(width: max(0, size.width), height: max(0, size.height))
        self.content = content()
    }

    /// **The shadow is cast by the background shape, not by the panel's contents.**
    ///
    /// It used to be `.clipShape(…).elevation(.panel)` on the whole thing, which is the obvious
    /// spelling and is wrong twice over. `shadow` renders its input into an offscreen buffer to
    /// derive the silhouette — so every frame of a sessions-drawer swipe, with two panes moving
    /// inside the panel, re-rasterised 337 × 976 points of thread and drawer *twice*, once per
    /// shadow layer, for a silhouette that is a rounded rectangle and never changes. On an iPad
    /// 6th generation that was the single most expensive thing in the frame.
    ///
    /// It is also what let the drawer's white veil paint outside the dock mid-animation: the
    /// clip sat under that offscreen pass, and what came back out of it was composited against
    /// the screen rather than against the clip.
    ///
    /// Casting from the background shape fixes both. The shape is opaque, exactly the panel's
    /// bounds and completely static, so the shadow is identical to the point and is rasterised
    /// once; the content is clipped over the top of it and never enters a shadow's buffer at
    /// all. `compositingGroup` keeps the two shadow layers stacking against the shape rather
    /// than each against the other's output, which is the ordering `Elevation` documents.
    var body: some View {
        content
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipShape(RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius))
            .background {
                RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius)
                    .fill(DS.Color.surfacePanel)
                    .compositingGroup()
                    .elevation(.panel)
            }
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

    /// Which end of the row the pair sits at. The redesign puts the layout controls on the
    /// **trailing** side and the gear on the leading one, so `TutorControlsRow` asks for
    /// `.trailing`; the gallery specimen keeps the default and draws the pair on its own.
    ///
    /// A parameter rather than a hard-coded edge because the alignment has to compose: this
    /// view's own frame is the design's fixed 301, while the row that hosts it is the panel's
    /// *derived* content width, and the two only agree about where the buttons land if they
    /// align to the same end.
    var alignment: Alignment = .leading

    /// The pair reads full-screen, then dock in every mirror. The redesign moved the pair to the
    /// trailing end of the header, and the internal order is mirrored with it.
    var body: some View {
        HStack(spacing: TutorPanelMetrics.controlsGap) {
            button(.controlFull, label: "Show tutor full screen", action: onFullScreen)
            button(.controlDock, label: "Collapse tutor to the dock", action: onDock)
        }
        .frame(
            width: TutorPanelMetrics.contentWidth,
            height: TutorPanelMetrics.controlsHeight,
            alignment: alignment
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

/// The chat header's leading control — the one that opens the sessions drawer.
///
/// Board 17's note on the header after the redesign, verbatim: *"A sidebar-toggle icon takes the
/// leading slot the gear held — it opens the drawer, and it is the discoverable alternative to
/// the swipe."* So it is the same 32pt button in the same 32pt row as the layout pair, and it
/// takes the same expanded tap target: the row is one row, and a control on it that was 32
/// points wide where its neighbours are 44 would be the harder of the two to hit.
///
/// **It belongs to the chat pane and not to the dock**, which is the whole difference from
/// `PanelControls` beside it. The pair is chrome of the surface and holds the panel's own
/// corner however far the drawer is open; this one names the pane it sits on, so it travels
/// with that pane and goes with it — see `DrawerReveal.toggleOpacity(at:)` for the going.
///
/// It draws no pressed or selected background, for the reason the layout pair draws none: the
/// design draws none on this row at all.
struct SidebarToggleButton: View {
    /// What the label says the tap does. The docked drawer only ever opens from here, so it
    /// reads "Show sessions"; the full-screen sidebar is a true toggle and says which way it
    /// is about to go.
    var label: String = "Show sessions"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IconView(.uiSidebarToggle)
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
