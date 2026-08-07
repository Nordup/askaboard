import SwiftUI

/// The surfaces boards 10–13 add to the system, and the one rule that used to tell them
/// apart: **all of them are the same shape, and only the fill says what will happen.**
///
/// - raised white + elevation 03 → safe and tappable (`select/option · default`)
/// - `--color-brand-tint` → the chosen one (`select/option · selected`)
/// - `--color-surface-bubble` with **no shadow** → destructive (`btn/destructive`)
///
/// **Two of those three are gone.** `select/option` — the 236 × 90 card that carried the
/// first two lines — was retired with the old board 10 and deleted rather than left standing
/// unused; the settings window shows one chosen value per row and puts the rest behind a
/// menu. Its selection rule did not die with it: `SettingsNavItemMetrics` is the same
/// `--radius-lg` and the same `--color-brand-tint`, which is also what the rail's selected
/// tool slot draws, so that citation now has one live example instead of two.
///
/// **The redesign broke the third line too, and that is a loss worth naming.** The old
/// rule was elegant: everything safe is lifted off the surface, and the things that destroy
/// are the only things that sit *in* it, so a flat grey pill meant "this one is different"
/// without spending a colour. The redesigned window puts `Remove API key` and `Reset this
/// session` on the same white-and-elevation-03 footing as the key field beside them, because
/// at 44pt beside a 56pt field the flat grey pill read as the *loudest* object in the pane
/// rather than the most careful one — it was the only filled shape in a window of white
/// surfaces. So the shape signal is gone and nothing replaced it.
///
/// What still carries the warning is the pane's lede, which is the same job the old
/// "Irreversible" heading and caption did: *"the entire destructive signal is carried by the
/// section heading and the caption."* That sentence now has to do all of the work rather than
/// most of it. Board 10 still spends no colour here, and `DS.Color.incorrect` is still **not**
/// available — its own token description says *"NOT for destructive, warning or validation
/// UI."* If the signal needs strengthening, that is a design decision, not a code one.

// MARK: - btn/primary

/// The one new violet moment in the system.
///
/// Foundations rule 2 allows brand colour in exactly three places — the send button, the
/// selected tool slot, and the attachment label. The design had no way to say *"this is the
/// primary action"* for anything but send, so board 11 spends a fourth: a brand-filled pill,
/// at two scales. There is no fifth. Anything else that wants to look important is a
/// suggestion chip, which is what board 14 means by *"the violet budget is spent
/// elsewhere."*
///
/// **No disabled state.** Board 11 draws the button because there is something to do, and
/// removes the composer entirely rather than greying one out — *"there is no disabled state
/// anywhere in this system."*
struct PrimaryButtonMetrics: Equatable, Sendable {
    let scale: ChatScale
    /// The column the button is laid out in. The panel button fills it; the full-screen one
    /// only needs to know it is inside it.
    let columnWidth: CGFloat
    /// Panel: fills the column. Full screen: `align-self: flex-start` and hugs its label, so
    /// the CTA is deliberately lighter than the composer above it.
    let fillsColumn: Bool
    let height: CGFloat
    /// 0 in the panel — *"the label is centred, not inset"*.
    let paddingInline: CGFloat
    let labelStyle: DS.TextStyle
    /// Identical at both scales, and the same level a chip takes.
    let elevation: Elevation = .control

    /// What the button hands `.frame`: the column in the panel, and nothing full screen,
    /// where the width is the label's own.
    var frameWidth: CGFloat? { fillsColumn ? columnWidth : nil }

    /// The measured 220 for `Start on the board`: label 156 + 32 × 2.
    func width(labelWidth: CGFloat) -> CGFloat { labelWidth + 2 * paddingInline }
}

extension PrimaryButtonMetrics {
    /// The button in a column of `width`.
    ///
    /// The height, the inset and the label are the scale's and hold. What the column decides
    /// is only what `fillsColumn` already said it decides — how wide a filled button is — and
    /// the panel's 301 was the design's column rather than a property of the button.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let column = max(0, width)
        switch scale {
        case .panel:
            return Self(
                scale: .panel,
                columnWidth: column,
                fillsColumn: true,
                // **58 is derived, not free**: it is the panel composer's height, so the
                // button occupies the composer's slot exactly when the composer is not there.
                height: ComposerMetrics.panel.height,
                paddingInline: 0,
                labelStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .semibold)
            )
        case .fullScreen:
            return Self(
                scale: .fullScreen,
                columnWidth: column,
                fillsColumn: false,
                // 64 *is* free — and pointedly not the full-screen composer's 80.
                height: 64,
                paddingInline: DS.Space.s8,
                labelStyle: TextStyle(size: DS.Size.bodyLarge, leading: DS.Leading.snug, weight: .semibold)
            )
        }
    }

    /// Board 11's no-key CTA and board 12's plan tail, in the 301pt column both were drawn in.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }

    /// Board 13's plan tail, in the 740pt column it was drawn in.
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

struct PrimaryButton: View {
    let title: String
    var scale: ChatScale = .panel
    /// The column the button is laid out in — it fills it in the panel. `nil` takes the one
    /// the design drew this scale in.
    var width: CGFloat?
    let action: () -> Void

    private var metrics: PrimaryButtonMetrics { .for(scale, width: width ?? scale.contentWidth) }

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .textStyle(metrics.labelStyle)
                // `#FFFFFF` literal in the design. `DS.Color.surface` is that same white
                // with a name — the substitution `IconView` already makes for
                // `composer/send`, and for the same reason: a label handed the default ink
                // would vanish into the violet under it.
                .foregroundStyle(DS.Color.surface)
                .lineLimit(1)
                .padding(.horizontal, metrics.paddingInline)
                .frame(width: metrics.frameWidth, height: metrics.height)
                // `--radius-full` on a 58 or 64pt box: a capsule, never a corner value.
                .background(DS.Color.brand, in: Capsule())
                .elevation(metrics.elevation)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - btn/destructive

/// A control that hugs its label, and the thing behind it does not come back.
///
/// Board 10 draws no pressed state, no disabled state and — deliberately — **no confirmation
/// dialog**: *"'cannot be undone' is asserted, but no dialog exists"*. That was once also an
/// observation about the system's limits, because there was no modal pattern to put a dialog
/// in. There is one now, and it is the window this button is drawn inside; whether an
/// irreversible action should get a second one on top of it is a question the design has not
/// been asked yet.
///
/// The redesign matched it to `field/key`, which is the control it stands directly under —
/// see the note at the top of this file for what that cost.
enum DestructiveButtonMetrics {
    /// Was 56 — the same height as the composer-sized key field it sat beside. It came down
    /// with the field, and stops one step short of it: 44 against 56 is what makes the pane
    /// read as a field with an action under it rather than two controls of equal weight.
    static let height: CGFloat = 44
    /// Component-internal, per Foundations rule 11. It was 28, which happened to equal
    /// `--space-edge`; at 44 tall that inset made the button read as a pill.
    static let paddingInline: CGFloat = 20
    /// `--radius-lg`, the product's control radius — chips and the selected tool slot. The
    /// capsule went with the height: `--radius-full` on a 44pt box is a pill, and a pill in
    /// a window of 14pt corners is the only round thing in it.
    static let radius = DS.Radius.lg
    static let fill = DS.Color.surface
    /// Elevation 03, like every other safe control. The `nil` that used to be here was the
    /// destructive signal.
    static let elevation: Elevation? = .control
    /// 15 / 18 · 600, down from 17 / 22 · 500. It is a label on a small control now, so it
    /// takes the label style — the same one the nav items and `Replace` take.
    static let labelStyle: DS.TextStyle = .label

    /// `"Remove API key"` at 20 × 2 of inset. Kept as a function because the label is the
    /// only thing that decides this button's width.
    static func width(labelWidth: CGFloat) -> CGFloat { labelWidth + 2 * paddingInline }
}

struct DestructiveButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .textStyle(DestructiveButtonMetrics.labelStyle)
                .foregroundStyle(DS.Color.ink)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, DestructiveButtonMetrics.paddingInline)
                .frame(height: DestructiveButtonMetrics.height)
                .background(
                    DestructiveButtonMetrics.fill,
                    in: RoundedRectangle(
                        cornerRadius: DestructiveButtonMetrics.radius, style: .circular
                    )
                )
                .elevation(.control)
        }
        .buttonStyle(.plain)
    }
}
