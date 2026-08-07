import SwiftUI

/// `row/setting` — the surface that replaced `select/option` on board 10.
///
/// The old screen spent 354 points of column on the two pickers: six 236 × 90 cards for the
/// effort grid and three more for the model, every option visible at once. The redesign
/// spends 240 on the same two settings by showing only the chosen one and putting the rest
/// behind a disclosure. That is a real trade — the captions "Fastest replies", "Deep
/// reasoning" and the other four are no longer on the screen — and it is the trade the
/// window's proportions asked for.
///
/// The row is a layout, not a control. What sits on its trailing edge is the caller's, which
/// is what lets one shape carry a picker, a plain value, or nothing at all.
enum SettingRowMetrics {
    /// Free — the design's. The label stack needs 44 of it, so the remaining 76 is air, split
    /// evenly by the centring. It grew from 92 when the window did: a taller window with two
    /// rows in it puts the extra height into the rows rather than leaving it at the bottom.
    static let height: CGFloat = 120
    /// Label block → trailing value. A minimum, not a fixed gap: the value is pushed to the
    /// trailing edge and this is the closest the two are ever allowed to get.
    static let gap = DS.Space.s6

    /// The rule **above** each row, so the first row's rule doubles as the header's.
    /// `--color-divider` again — see `SettingsWindowMetrics.rule`.
    static let rule = DS.Color.divider
    static let ruleWidth: CGFloat = 1

    /// 17 / 22 · 600 · ink.
    static let labelStyle = TextStyle(
        size: DS.Size.body, leading: DS.Leading.control, weight: .semibold
    )
    /// 15 / 18 · 400 · secondary.
    static let captionStyle = TextStyle(
        size: DS.Size.label, leading: DS.Leading.label, weight: .regular
    )
    static let captionTopMargin = DS.Space.s1

    /// 17 / 22 · 500 · ink. A weight below the label, because the label is the question and
    /// the value is the answer — reversing them makes the column read as a list of values.
    static let valueStyle = TextStyle(
        size: DS.Size.body, leading: DS.Leading.control, weight: .medium
    )
    /// Value → chevron.
    static let valueGap = DS.Space.s2

    /// **A fixed slot, and the reason the chevrons line up.**
    ///
    /// `ui/chevron-down` renders at 16 and the slot is 20, so the glyph is centred with 2pt
    /// either side. Handing the row a bare 16pt glyph and relying on `valueGap` would put
    /// each chevron wherever its own value's width left it, and the two rows' marks would sit
    /// in different columns — the failure the design system calls out by name for repeated
    /// rows. `flexShrink: 0` in the CSS, `layoutPriority` here.
    static let chevronSlot: CGFloat = 20
    static let chevronGlyph = Icon.uiChevronDown.renderSize

    /// `22 + 4 + 18 = 44`, which is what the 120 is centred around.
    static var labelStackHeight: CGFloat {
        labelStyle.leading + captionTopMargin + captionStyle.leading
    }
}

/// The label-and-caption block with whatever the caller puts on the trailing edge.
struct SettingRow<Trailing: View>: View {
    let label: String
    let caption: String
    /// The pane's measure. Rows do not carry a width of their own — see
    /// `SettingsWindowMetrics.paneContentWidth`.
    let width: CGFloat
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: SettingRowMetrics.gap) {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: label)
                    .textStyle(SettingRowMetrics.labelStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)

                Text(verbatim: caption)
                    .textStyle(SettingRowMetrics.captionStyle)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .lineLimit(1)
                    .padding(.top, SettingRowMetrics.captionTopMargin)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            trailing().layoutPriority(1)
        }
        .frame(width: width, height: SettingRowMetrics.height)
        // `Rectangle()` rather than a bare `Color`, for the reason `SettingsSidebar`'s fill
        // spells out: inside the window's clip, an unshaped fill can inherit the container's
        // corners and a hairline rule with rounded ends is a hairline that fades out.
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SettingRowMetrics.rule)
                .frame(height: SettingRowMetrics.ruleWidth)
        }
    }
}

/// The trailing pair: the chosen value, then the disclosure mark in its fixed slot.
struct SettingRowValue: View {
    let value: String

    var body: some View {
        HStack(spacing: SettingRowMetrics.valueGap) {
            Text(verbatim: value)
                .textStyle(SettingRowMetrics.valueStyle)
                .foregroundStyle(DS.Color.ink)
                .lineLimit(1)

            IconView(.uiChevronDown, size: SettingRowMetrics.chevronGlyph)
                .frame(width: SettingRowMetrics.chevronSlot)
        }
        .fixedSize()
    }
}

/// A `row/setting` whose value opens a menu of `SettingsOption`s.
///
/// **The design does not draw the open state** — board 10 shows `Luna ▾` and stops — so the
/// menu itself is the system's, not the design's. That is the honest reading rather than an
/// omission: inventing a bespoke popover would be inventing a container type this system
/// does not own, which is the same objection the original board 10 raised against sheets.
///
/// What the system menu cannot carry is each option's caption. `SettingsOption` still holds
/// them, and they are appended to the title so `Sol` reads as "Sol — Focused route" in the
/// menu rather than being lost outright.
struct SettingPickerRow<Value: Hashable & Sendable>: View {
    let label: String
    let caption: String
    let options: [SettingsOption<Value>]
    let width: CGFloat
    /// For `accessibilityIdentifier` on each menu item, so the UI tests can reach an option
    /// that is not on screen until the menu is open.
    let identifierPrefix: String
    let select: (Value) -> Void

    private var selected: SettingsOption<Value>? {
        options.first(where: \.isSelected)
    }

    var body: some View {
        SettingRow(label: label, caption: caption, width: width) {
            SettingRowValue(value: selected?.title ?? "")
        }
        // The row is drawn here and the menu's label is an invisible sheet on top of it.
        //
        // **Handing the row itself to `Menu` as its label does not work.** SwiftUI lifts a
        // menu's label into the presentation while the menu is open — it hides the original in
        // place and draws a highlight platter in its stead — so the whole 480 × 120 row
        // disappeared from the pane the moment you tapped it, leaving a grey slab behind the
        // options. A transparent label lifts a transparent platter, which is invisible, and
        // the real row never stops being drawn.
        //
        // The clear sheet also keeps the entire row tappable rather than just the value, which
        // is what a 480pt row with a 36pt target on its trailing edge would otherwise be.
        .overlay { menu }
        // The row's own text is hidden so VoiceOver gets one element — the menu — rather than
        // the label, the caption and the value as three unrelated strings plus a button.
        .accessibilityHidden(true)
        .accessibilityElement(children: .contain)
    }

    /// The chosen option, as something the picker can bind to.
    ///
    /// Optional because `options` could in principle arrive with nothing marked; the setter
    /// ignores a `nil` write, so a picker can only ever move the selection, never clear it.
    private var selection: Binding<Value?> {
        Binding(
            get: { selected?.value },
            set: { if let value = $0 { select(value) } }
        )
    }

    private var menu: some View {
        Menu {
            // **A `Picker`, not a row of `Button`s.** Buttons in a menu carry no selected
            // state, so the list came up with nothing marked — you could see six efforts and
            // not which one you were on, which is exactly the thing the row's value exists to
            // tell you. A picker hands the platform the selection and gets the platform's own
            // checkmark, in the platform's own position, for free.
            Picker("", selection: selection) {
                ForEach(options) { option in
                    Text(verbatim: "\(option.title) — \(option.caption)")
                        .tag(option.value as Value?)
                        .accessibilityIdentifier(
                            "\(identifierPrefix)-\(String(describing: option.value))"
                        )
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Color.clear.contentShape(Rectangle())
        }
        // Without this the menu label inherits the button tint and every row turns violet.
        .buttonStyle(.plain)
        .accessibilityHidden(false)
        .accessibilityLabel(label)
        .accessibilityValue(selected?.title ?? "")
        .accessibilityIdentifier(identifierPrefix)
    }
}
