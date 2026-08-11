import SwiftUI

/// The geometry of a menu card drawn inside the tutor panel.
///
/// It was `SessionSwitcherMetrics`, and it was board 15a's: the session title in
/// `Panel controls`, the card it dropped, and the rows in that card. Board 17 replaces the
/// whole switcher with the sessions drawer, so the title lane, the row's trailing meta column
/// and the card's own row styling went with it — see `SessionsDrawer`, which owns all three
/// facts now in its own shapes.
///
/// What is left is what outlived the switcher: board 16's attach menu, which the board says
/// takes its *"construction ... from `menu/sessions` exactly"*. So these are the numbers two
/// components used to share and one component now owns outright, kept under a name that
/// describes the shape rather than the deleted component — a card of 44pt rows, 8 in from the
/// card's edge and 12 in from a row's, on a 4pt row gap, hanging 8 clear of whatever it drops
/// from.
///
/// Kept as a type rather than folded into `AttachMenu` because the numbers are assertable
/// without a host and a spec that lives in a `body` cannot be regression-tested — the reason
/// `TutorPanelMetrics` and `ResizeHandleMetrics` are types too.
enum MenuCardMetrics {
    /// The gap between the control a card hangs off and the card itself.
    static let menuTopGap = DS.Space.s2
    static let menuPadding = DS.Space.s2
    static let menuRowGap = DS.Space.s1
    static let rowHeight: CGFloat = 44
    static let rowPaddingInline = DS.Space.s3
    static let rowGap = DS.Space.s2
    /// The gap between a row's leading glyph and its label.
    static let rowGlyphGap: CGFloat = 10

    /// 17 / 22 semibold — a row that is an action rather than a name. The menu's rows are
    /// controls, not prose, so they take the control leading the composer's placeholder does
    /// rather than the 25 running text uses.
    static let actionLabel = TextStyle(
        size: DS.Size.body,
        leading: DS.Leading.control,
        weight: .semibold
    )
}
