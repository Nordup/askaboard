import SwiftUI

/// Board 10's region map, after settings stopped being a screen.
///
/// The old comment here said board 10 *"is **not a modal and not a sheet**"*, and defended
/// that on the grounds that *"a sheet is a card with an edge"* while everything else in the
/// product separates by elevation. The redesign makes it a window, and the defence survives
/// intact: this window has no edge either. It is `--color-surface` on `--radius-3xl`, lifted
/// off a whitened backdrop by elevation 04 and nothing else — the same vocabulary the tutor
/// panel uses, at a level the scale did not previously go to.
///
/// Every number is the design's, and the two that are *derived* say so. Nothing here is a
/// fraction of the screen: the window is a fixed size that gets clamped when the screen is
/// too small for it, which is the same shape of answer the tool rail gives.
struct SettingsWindowMetrics: Equatable, Sendable {
    /// 760 × 520 on the board. Both are free values — the window is sized to its content,
    /// not derived from a lane — so they are stated rather than computed.
    static let designSize = CGSize(width: 760, height: 520)

    /// `--radius-3xl`, the radius the whiteboard and the tutor panel take. Foundations:
    /// *"Radius is chosen by how big the surface is, not by taste"*, and at 760 × 520 this
    /// is the largest surface in the product bar the board itself.
    static let radius = DS.Radius.xxxl
    static let fill = DS.Color.surface
    static let elevation: Elevation = .modal

    // MARK: - Sidebar

    /// Fixed, and the first thing the window gives up nothing of when it is clamped: a nav
    /// column that narrows below its labels stops being a nav column.
    static let sidebarWidth: CGFloat = 216
    static let sidebarFill = DS.Color.surfacePanel
    /// The one stroke in the window, and it is sanctioned: `--color-divider` is *"the ONLY
    /// border colour in the product"*, for *"hairline rules inside a surface"*. The sidebar
    /// and the pane are one surface; this is the rule between them, exactly as the tool
    /// rail's own divider is a rule inside the rail.
    static let rule = DS.Color.divider
    static let ruleWidth: CGFloat = 1

    static let sidebarPaddingBlock = DS.Space.s5
    static let sidebarPaddingInline = DS.Space.s4
    /// Close button → nav list.
    static let sidebarGap = DS.Space.s6

    // MARK: - Pane

    static let panePadding = DS.Space.s8

    /// `--text-title` 26 / 34 · 600 · `--tracking-tight`.
    static let paneTitleStyle: DS.TextStyle = .title
    /// Title → lede. Off the 4px scale and component-internal, per Foundations rule 11.
    static let paneTitleGap: CGFloat = 10
    /// 15 / 22 · 400 · secondary. The label *size* in the control *line box*, because this is
    /// the one paragraph in the window that wraps — `--leading-label` 18 would set two lines
    /// of 15pt copy 3pt tighter than the font draws them.
    static let paneLedeStyle = TextStyle(
        size: DS.Size.label, leading: DS.Leading.control, weight: .regular
    )
    /// Every pane's lede is written to run to two lines at the pane's measure. See
    /// `headerHeight`.
    static let paneLedeLines = 2
    /// Lede → the rule under the header.
    static let paneHeaderPaddingBottom = DS.Space.s7

    /// `34 + 10 + 22 × 2 + 28 = 116`, and **pinned rather than hugged**.
    ///
    /// Left to hug, the header is 94 in the API-key pane, whose lede is one line at this
    /// measure, and 116 in the other two — so the rule beneath it, and everything under the
    /// rule, would jump 22pt as you moved between panes. A window whose furniture moves when
    /// you change tabs reads as three windows. So the height is the tallest header's, the
    /// short lede leaves slack under itself, and the rule is in one place.
    static var headerHeight: CGFloat {
        paneTitleStyle.leading
            + paneTitleGap
            + paneLedeStyle.leading * CGFloat(paneLedeLines)
            + paneHeaderPaddingBottom
    }

    /// Rule → the pane's content, and between stacked controls in a pane.
    static let paneBodyGap = DS.Space.s6

    // MARK: - Measured

    /// The window's size on this screen: the design's, or as much of it as fits.
    let size: CGSize
    /// Top-leading, in screen coordinates. Centred horizontally in the safe width and
    /// vertically in the content band.
    let origin: CGPoint

    /// The screen the window is centred on.
    ///
    /// On the board's own 1376 × 1032 this reproduces the design exactly — 760 × 520 at
    /// (308, 256) — because the clamps do not bite and the two centrings are the board's own
    /// subtraction. On anything smaller the window shrinks before it moves, which keeps it
    /// inside the same band every other surface respects.
    init(layout: ScreenLayout) {
        let availableWidth = max(0, layout.usableWidth - 2 * DS.Space.edge)
        let availableHeight = layout.contentHeight

        let width = min(Self.designSize.width, availableWidth)
        let height = min(Self.designSize.height, availableHeight)
        size = CGSize(width: width, height: height)
        origin = CGPoint(
            x: layout.safeAreaLeading + (layout.usableWidth - width) / 2,
            y: layout.contentTop + (availableHeight - height) / 2
        )
    }

    /// The board's own screen, which is what every published number above was measured on.
    static let reference = SettingsWindowMetrics(layout: .reference)

    /// `760 − 216 = 544`.
    var paneWidth: CGFloat { max(0, size.width - Self.sidebarWidth) }

    /// `544 − 32 × 2 = 480` — the measure every row, lede, field and button in the pane is
    /// laid out against, and the reason none of them carry a width of their own.
    var paneContentWidth: CGFloat { max(0, paneWidth - 2 * Self.panePadding) }

    /// `216 − 16 × 2 = 184`.
    var navItemWidth: CGFloat { max(0, Self.sidebarWidth - 2 * Self.sidebarPaddingInline) }
}

/// The settings window: a sidebar, a rule, and one pane.
///
/// It owns which pane is showing and nothing else. Everything with consequences —
/// the model, the effort, the key, the session — belongs to `TutorStore`, and the panes
/// reach it through the environment rather than through this view, so adding a pane does not
/// widen this file.
struct SettingsWindow: View {
    @Environment(\.screenLayout) private var layout

    /// Which pane the sidebar has selected. Presentation state, so it is `@State` here
    /// rather than anything `UIState` persists: closing settings and reopening it should
    /// land on the first pane, the way every settings window does.
    @State private var pane: SettingsPane = .tutor

    let onClose: () -> Void

    private var metrics: SettingsWindowMetrics { SettingsWindowMetrics(layout: layout) }

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(selection: $pane, metrics: metrics, onClose: onClose)
            SettingsPaneContent(pane: pane, metrics: metrics)
        }
        .frame(width: metrics.size.width, height: metrics.size.height)
        .background(
            SettingsWindowMetrics.fill,
            // `.circular`, not `.continuous`: the design's radii are CSS corners.
            in: RoundedRectangle(cornerRadius: SettingsWindowMetrics.radius, style: .circular)
        )
        // The CSS says `overflow: clip`, and it is load-bearing rather than defensive: the
        // sidebar paints a *square* `--color-surface-panel` block, so without this its corners
        // sit outside the window's 28pt radius at the top and bottom left. Before `.elevation`,
        // so the shadow is cast by the rounded silhouette and not by the square one.
        .clipShape(RoundedRectangle(cornerRadius: SettingsWindowMetrics.radius, style: .circular))
        .elevation(SettingsWindowMetrics.elevation)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("settings-window")
    }
}
