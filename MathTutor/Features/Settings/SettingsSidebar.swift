import SwiftUI

/// `nav/item` — the settings window's one new interactive surface.
///
/// It is deliberately the *same* shape as the rail's selected tool slot — `--radius-lg` 14,
/// with the selection carried by `--color-brand-tint` and nothing else. That tint is the
/// third sanctioned use of brand colour in the chrome — Foundations allows it in the send
/// button, the selected tool slot and the attachment label — and this is that slot's rule
/// applied to a different kind of slot, not a fourth spend.
///
/// The two states differ in fill **and** in the label, which is where this parts company with
/// the retired `select/option`. An option card's title was identical in both states because
/// the whole list was scanned at once; a nav item is read one at a time down a column, so the
/// selected one takes `--color-ink` at 600 and the rest sit back at secondary and 500.
/// Without that the column reads as three equal labels with a rectangle behind one of them.
enum SettingsNavItemMetrics {
    static let height: CGFloat = 44
    static let paddingInline = DS.Space.s3
    /// Between items. Off the 4px scale and component-internal: the items are tap targets
    /// with 44pt of their own, and a token gap here would open a dead lane between them.
    static let gap: CGFloat = 2
    /// `--radius-lg` — chips and the selected tool slot.
    static let radius = DS.Radius.lg

    /// 15 / 18 · 600 · ink.
    static let selectedLabelStyle: DS.TextStyle = .label
    /// 15 / 18 · 500 · secondary.
    static let labelStyle = TextStyle(
        size: DS.Size.label, leading: DS.Leading.label, weight: .medium
    )

    static func fill(isSelected: Bool) -> Color {
        isSelected ? DS.Color.brandTint : .clear
    }

    static func labelStyle(isSelected: Bool) -> DS.TextStyle {
        isSelected ? selectedLabelStyle : labelStyle
    }

    static func labelColor(isSelected: Bool) -> Color {
        isSelected ? DS.Color.ink : DS.Color.inkSecondary
    }
}

struct SettingsNavItem: View {
    let pane: SettingsPane
    let isSelected: Bool
    /// The sidebar's measure. The item fills it so the tint runs the full column rather than
    /// hugging a five-character label.
    let width: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: pane.navLabel)
                .textStyle(SettingsNavItemMetrics.labelStyle(isSelected: isSelected))
                .foregroundStyle(SettingsNavItemMetrics.labelColor(isSelected: isSelected))
                .lineLimit(1)
                .frame(
                    width: max(0, width - 2 * SettingsNavItemMetrics.paddingInline),
                    alignment: .leading
                )
                .padding(.horizontal, SettingsNavItemMetrics.paddingInline)
                .frame(width: width, height: SettingsNavItemMetrics.height, alignment: .leading)
                .background(
                    SettingsNavItemMetrics.fill(isSelected: isSelected),
                    in: RoundedRectangle(
                        cornerRadius: SettingsNavItemMetrics.radius, style: .circular
                    )
                )
                // **Load-bearing.** The selected item is hit-testable across its whole 184 × 44
                // because it has a fill; the other two are `.clear`, and a clear background is
                // not hittable — the accessibility tree reported them as 46 × 20, the size of
                // their labels, so only the word itself could be tapped. This makes the row's
                // geometry the target in both states, which is the whole reason the item is
                // 44 tall in the first place.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The tint is a fill, not a trait, so a screen reader has nothing to go on without
        // this — the same reason `SelectOption` sets it.
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("settings-nav-\(pane.rawValue)")
    }
}

/// The window's left column: the table of contents, and nothing else.
///
/// The close control used to live here, on the reading that every other close in this system
/// is a leading-edge affordance — the board peek, `btn/dock`. The redesign mirrors all three:
/// the peek hinges off the trailing edge, the panel's layout pair moved to the trailing end of
/// its row, and the window's exit went with them. The nav column did **not** move — a sidebar
/// is a table of contents, and this product reads left to right — so the two are now in
/// opposite corners, which is also where a dialog usually puts them.
///
/// The band the button occupied is still spent above the nav, so the first item sits on
/// exactly the line it always did. See `SettingsWindowMetrics.sidebarPaddingTop`.
struct SettingsSidebar: View {
    @Binding var selection: SettingsPane
    let metrics: SettingsWindowMetrics

    /// 36 × 36 with a 22pt glyph. Both the design's, and the glyph is `ui/cross` at its one
    /// product render size. No fill and no radius — the same nothing `btn/dock` and the other
    /// panel controls are drawn with, so the window's exit reads as chrome and not as a
    /// button competing with the nav.
    ///
    /// Still published here, and by the type that no longer draws it, because the sidebar is
    /// what has to reserve the button's band: `sidebarPaddingTop` is written from this number.
    static let closeButton: CGFloat = 36
    static let closeGlyph = Icon.uiCross.renderSize

    /// **44, and it is not decoration.** A bare `IconView` in a `Button` hands the button the
    /// *glyph's* bounds, not the frame around it — the accessibility tree reported this
    /// control as 12.3 × 12.3 before this was added, because `ui/cross` only spans 11.2 of its
    /// 24 viewBox. The panel controls solved the same problem the same way; this is that
    /// helper, at the pitch the rail and `SettingsScreen` both used.
    static let closeTapTarget: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: SettingsWindowMetrics.sidebarGap) {
            nav
            Spacer(minLength: 0)
        }
        .padding(.top, SettingsWindowMetrics.sidebarPaddingTop)
        .padding(.bottom, SettingsWindowMetrics.sidebarPaddingBlock)
        .padding(.horizontal, SettingsWindowMetrics.sidebarPaddingInline)
        .frame(width: SettingsWindowMetrics.sidebarWidth, alignment: .topLeading)
        .frame(maxHeight: .infinity)
        // **`in: Rectangle()` is load-bearing, not noise.** A bare `.background(Color)` inside
        // the window's `.clipShape` picks up the container's corner rounding on this SDK, and
        // the sidebar rendered with a rounded *top-right* corner against the divider — which
        // read as two floating cards rather than one window with a rule in it. Naming the
        // shape pins it square whatever the container is doing.
        .background(SettingsWindowMetrics.sidebarFill, in: Rectangle())
        // The CSS is `border-right` on a `border-box` sidebar, so the rule is *inside* the
        // 216 rather than beside it. An `HStack` sibling would take its 1pt out of the pane
        // and move every lane in there by a point; an overlay takes it out of the sidebar,
        // which is where the design puts it.
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(SettingsWindowMetrics.rule)
                .frame(width: SettingsWindowMetrics.ruleWidth)
        }
    }

    private var nav: some View {
        VStack(alignment: .leading, spacing: SettingsNavItemMetrics.gap) {
            ForEach(SettingsPane.allCases) { pane in
                SettingsNavItem(
                    pane: pane,
                    isSelected: pane == selection,
                    width: metrics.navItemWidth
                ) {
                    selection = pane
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-nav")
    }
}
