import CoreGraphics

/// The one axis every component on the conversation surface varies along.
///
/// Board 01: *"the panel and the full screen are one design at two scales, not two
/// designs."* Board 05 states the other half of it: *"This is not a scale factor: the type
/// scale, chip layout (1-up vs 2-up), chip height (62 vs 74), icon size (22 vs 24),
/// composer height (58/96 vs 80) and the composer's contents all change. Treat the
/// greeting/chips/composer as two variants, not one responsive view."*
///
/// Hence an enum with a lookup per property rather than a multiplier over one set of
/// numbers. The design's own steps are 62 → 74 (1.19), 22 → 24 (1.09), 26 → 40 (1.54) and
/// 17 → 21 (1.24); no single factor produces those, and any factor would also have to
/// invent a value for the properties the design deliberately holds still — the chip's 14pt
/// radius is *"the same as panel, deliberately not scaled"*.
///
/// **The scale is not a width.** It picks the treatment — type, chip grid, icon sizes,
/// paddings — and every component on this surface takes the column it is laid out in as a
/// separate parameter. The two were the same thing for as long as each scale had exactly one
/// column: 301 in the panel, 740 full-screen. The panel's is still fixed, because
/// `--container-panel` is, but `ScreenLayout.columnWidth` is `min(740, region − 2 × edge)`,
/// so the reading column is 740 on every iPad in landscape and narrower in portrait and in
/// Split View. Keeping them apart is what stops a narrower column quietly restyling the
/// conversation: the type does not drop to 17 because the screen got smaller.
enum ChatScale: String, CaseIterable, Sendable {
    /// Screens 05 and 08 — the 301pt content column inside the 337pt tutor panel.
    case panel
    /// Screen 07 — the reading column, centred on the screen. 740 where there is room
    /// for it.
    case fullScreen
}

extension ChatScale {
    /// The column the design drew this scale against: `--container-panel-content` 301 and
    /// `--container-column` 740.
    ///
    /// A reference, not a claim about the running app. It is what a component falls back to
    /// when nobody hands it a measured column — a preview, a gallery specimen, a spec table —
    /// and it is the width every published number on the boards was measured at, so the
    /// regression suite compares against the design rather than against itself.
    var contentWidth: CGFloat {
        switch self {
        case .panel: DS.Container.panelContent
        case .fullScreen: DS.Container.column
        }
    }
}
