import SwiftUI

/// What the attach menu was asked for.
enum AttachMenuChoice: String, CaseIterable, Sendable {
    case photoLibrary
    case camera
    case files

    /// Board 16's three rows, in the order it draws them.
    var label: String {
        switch self {
        case .photoLibrary: "Photo Library"
        case .camera: "Take Photo"
        case .files: "Files"
        }
    }
}

/// `menu/attach` — the three-row card behind the composer's `+`, board 16.
///
/// Built as a sibling of `SessionMenu` rather than as a system `Menu`, and *"construction is
/// inherited from `menu/sessions` exactly"*: the same 8pt card padding, 4pt row gap, 14pt
/// card radius, 44pt rows on a 12pt inline inset, the same `--color-surface` fill and the
/// same 04 · Modal shadow. This product draws its own menus, in the surface's own content
/// column, inside the surface — a system menu would arrive with system type, system spacing
/// and a system material, none of which exist anywhere else in the app.
///
/// **The rows are neutral, where `menu/sessions` colours its one action row brand.** There
/// the plus is the single action in a list of session rows; here the three rows are peers,
/// and colouring them would re-introduce the violet noise the `+`'s own colour decision
/// removes.
///
/// Anchored **above** the composer by its caller — `gapAbovePill` clear of it, matching the
/// gap `menu/sessions` leaves below the header — because the composer sits at the bottom of
/// its surface and a menu hanging down would leave the screen. There is no scrim, again
/// like `menu/sessions`.
struct AttachMenu: View {
    /// The surface's content column: 301 in the panel. A parameter rather than a constant
    /// for the reason every width inside the panel is one — hard-coding 301 is *"a bug
    /// waiting for the first panel-width change"*.
    let width: CGFloat
    let onSelect: (AttachMenuChoice) -> Void

    /// `3 × 44 + 2 × 4 + 2 × 8` — **156**, the card height board 16 measures.
    static var height: CGFloat {
        let rows = CGFloat(AttachMenuChoice.allCases.count)
        return rows * MenuCardMetrics.rowHeight
            + (rows - 1) * MenuCardMetrics.menuRowGap
            + 2 * MenuCardMetrics.menuPadding
    }

    /// How far clear of the pill the card's bottom edge sits. The same 8 the session menu
    /// leaves below the header it drops from, measured on board 16 as `744 + 156 + 8 = 908`,
    /// the composer's top.
    static var gapAbovePill: CGFloat { MenuCardMetrics.menuTopGap }

    var body: some View {
        VStack(alignment: .leading, spacing: MenuCardMetrics.menuRowGap) {
            ForEach(AttachMenuChoice.allCases, id: \.self) { choice in
                row(choice)
            }
        }
        .padding(MenuCardMetrics.menuPadding)
        .frame(width: width, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.lg).fill(DS.Color.surface)
        )
        .elevation(.modal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attach")
    }

    private func row(_ choice: AttachMenuChoice) -> some View {
        Button { onSelect(choice) } label: {
            HStack(spacing: MenuCardMetrics.rowGlyphGap) {
                // `ui/photo`, `ui/camera` and `ui/file` belong here at 20 × 20 in
                // `--color-icon`. Board 16 draws them; task 8 §7.10 records that all three
                // are **new glyphs not yet catalogued on board 04**, so `design/icons.json`
                // has no path for them and `Icon` has no case. A port cannot draw geometry
                // it has not been given, and inventing three marks to fill the slot would
                // put drawings in the product that the design has never seen. The rows ship
                // as labels until the icon board catches up; adding the glyph here is one
                // line, and `newSessionGap` above is already the 10pt gap §3 measures.
                Text(verbatim: choice.label)
                    // 17 / 22 · 600 — the specimen `menu/sessions` sets its own action row
                    // in, which is what these three are.
                    .textStyle(MenuCardMetrics.actionLabel)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, MenuCardMetrics.rowPaddingInline)
            .frame(height: MenuCardMetrics.rowHeight)
            // `--radius-sm`, the shape the row highlights and hit-tests as. The session
            // menu's rows take the same corner for the fill they get when they are current.
            .contentShape(RoundedRectangle(cornerRadius: DS.Radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.label)
    }
}

#if DEBUG
#Preview("Attach menu") {
    AttachMenu(width: DS.Container.panelContent, onSelect: { _ in })
        .padding(44)
        .background(DS.Color.surfacePanel)
}
#endif
