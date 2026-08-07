import SwiftUI

/// The panel's bottom slot — **one slot, every state**.
///
/// Boards 05 / 08 / 12 put a composer here; board 11 puts `btn/primary` here. It is the
/// same 58pt band with the same 18pt panel inset under it, which is why `btn/primary`'s
/// panel height is 58 and not a number of its own. Board 11 removes the composer rather
/// than greying one out, so the panel keeps its silhouette and reads as *not started*
/// instead of *broken* — *"there is no disabled state anywhere in this system."*
enum PanelActionSlotMetrics {
    static let width = DS.Container.panelContent
    /// The panel composer's height. Not a free value — the whole point is that the two
    /// occupants are interchangeable.
    static let height = ComposerMetrics.panel.height
    static let bottomInset = TutorPanelMetrics.inset

    /// Panel-local y of the slot's top, in whatever panel it is given: `936 − 18 − 58 = 860`
    /// on the reference screen, which is where boards 05, 08, 11 and 12 all put their bottom
    /// control.
    ///
    /// **Measured up from the panel's bottom, not down from its top.** It used to read
    /// `TutorPanelMetrics.height − 18 − 58`, and 936 was never the panel's own number — it was
    /// the content band a 1032pt screen with a 40pt status region happened to leave, so the
    /// panel now takes its height from the caller and has none to offer. Anchoring to the
    /// bottom reproduces the board's 860 exactly where the board's height is what arrives, and
    /// keeps the slot on the panel's floor where it is not; the alternative — an absolute 860
    /// — would leave the button floating mid-panel on a shorter iPad with a gap below it.
    ///
    /// Clamped at 0 because a panel shorter than `18 + 58` would otherwise place the slot
    /// above its own top edge.
    static func top(inPanelOfHeight height: CGFloat) -> CGFloat {
        max(0, height - bottomInset - Self.height)
    }
}

/// Board 11's `No-key state`, and the flow around it.
///
/// The block itself is bare text on the panel — no fill, no radius, no shadow — at the same
/// narrowed 277 measure the panel greeting uses, with the 17 / 24 "short and centred"
/// leading rather than the 17 / 25 of running message text.
enum NoAPIKeyMetrics {
    static let width = DS.Container.panelContent
    /// From the bottom of `Panel controls` to the top of the orb: `18 + 32 + 248 = 298`,
    /// which is the panel-local y board 11 measures for the orb.
    static let orbTopMargin: CGFloat = 248
    static let orb = OrbSize.panel
    static let blockTopMargin = DS.Space.s10

    static let titleStyle: DS.TextStyle = .title
    /// `301 − 24`, the same narrowed measure the panel greeting takes.
    static let bodyWidth: CGFloat = 277
    static let bodyStyle: DS.TextStyle = .bodyCentred
    static let bodyTopMargin = DS.Space.s3
    /// 15 / 18 · 400 · secondary.
    static let pointerStyle = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)
    static let pointerTopMargin = DS.Space.s5

    /// `34 + 12 + 3 × 24 + 20 + 18 = 156` on the board's three-line body.
    static func blockHeight(bodyLines: Int) -> CGFloat {
        titleStyle.leading
            + bodyTopMargin + bodyStyle.leading * CGFloat(bodyLines)
            + pointerTopMargin + pointerStyle.leading
    }

    /// The board's flow total, `18 + 32 + 248 + 90 + 40 + 156 = 584`, measured from the
    /// panel's top edge. The button is not in it — it is bottom-anchored in the action slot.
    static func flowBottom(bodyLines: Int) -> CGFloat {
        TutorPanelMetrics.inset + TutorPanelMetrics.controlsHeight
            + orbTopMargin + orb.metrics.frame.height
            + blockTopMargin + blockHeight(bodyLines: bodyLines)
    }
}

/// Board 11's copy.
enum NoAPIKeyCopy {
    static let title = "One thing before we start"

    /// **Not the board's sentence.** Board 11 writes *"It is kept in this device's Keychain
    /// and never leaves it"*, which is false — the key necessarily leaves the device on
    /// every request, and board 10's own caption says so: *"It is sent to OpenAI and nowhere
    /// else."* `06 §Open questions 9` flags the pair as a copy-correctness defect. This is
    /// a security claim on a first-run screen, so the accurate wording ships and the board
    /// is the thing that needs fixing. (The repo's README carries the same error.)
    static let body = "I need an OpenAI API key to think with. It is kept in this device's Keychain and sent only to OpenAI."

    static let pointer = "Get one at platform.openai.com"
    static let action = "Add your API key"
}

/// Cold start: the board and rail are live and drawable, and only the tutor is in a special
/// state. Nothing here blocks the student — board 11 puts the whole no-key condition inside
/// the panel precisely so a modal never lands on top of a board they could be drawing on.
///
/// Fills the tutor panel's content area, below `Panel controls`. The controls belong to the
/// panel and stay the caller's.
///
/// **The primary button is not here.** It used to be, bottom-anchored behind a `Spacer`, and
/// that put it in the panel's *fill* — the same layer as the thread, underneath the bottom
/// fade. The fade then painted an 80% veil straight over the one control on the screen, which
/// is what board 11 does not draw and what the panel looked like until this moved.
///
/// It belongs to `ComposerSlot`, which is the panel's bottom slot and paints above the fade.
/// `PanelActionSlotMetrics`' own note says why that is the right home rather than a workaround:
/// *"one slot, every state"* — a composer on boards 05/08/12, `btn/primary` on board 11, the
/// same band either way. So this view is the block, and the slot's occupant is the panel's.
struct NoAPIKeyState: View {
    var body: some View {
        VStack(spacing: 0) {
            Orb(NoAPIKeyMetrics.orb)
                .padding(.top, NoAPIKeyMetrics.orbTopMargin)

            block.padding(.top, NoAPIKeyMetrics.blockTopMargin)
        }
        .frame(width: NoAPIKeyMetrics.width, alignment: .top)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var block: some View {
        VStack(spacing: 0) {
            Text(verbatim: NoAPIKeyCopy.title)
                .textStyle(NoAPIKeyMetrics.titleStyle)
                .foregroundStyle(DS.Color.ink)
                .multilineTextAlignment(.center)
                .frame(width: NoAPIKeyMetrics.width)

            Text(verbatim: NoAPIKeyCopy.body)
                .textStyle(NoAPIKeyMetrics.bodyStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: NoAPIKeyMetrics.bodyWidth)
                .padding(.top, NoAPIKeyMetrics.bodyTopMargin)

            Text(verbatim: NoAPIKeyCopy.pointer)
                .textStyle(NoAPIKeyMetrics.pointerStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .multilineTextAlignment(.center)
                .frame(width: NoAPIKeyMetrics.bodyWidth)
                .padding(.top, NoAPIKeyMetrics.pointerTopMargin)
        }
        .frame(width: NoAPIKeyMetrics.width)
    }
}

#if DEBUG
#Preview("First run · no API key") {
    // The panel the board draws board 11 in: `--container-panel` by the reference screen's
    // content band. The height matters to this preview specifically — the button is
    // bottom-anchored, so a panel of some other height would not be the board's picture.
    TutorPanelShell(
        size: CGSize(width: TutorPanelMetrics.width, height: ScreenLayout.reference.contentHeight)
    ) {
        VStack(spacing: 0) {
            PanelControls(onDock: {}, onFullScreen: {})
            NoAPIKeyState()
        }
    }
    .padding(44)
    .background(DS.Color.surfaceScreen)
}
#endif
