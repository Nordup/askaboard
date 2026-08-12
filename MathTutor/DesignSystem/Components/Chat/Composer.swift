import SwiftUI

/// What the composer has to say about the board selection.
///
/// Board 03 flags the marquee glyph's absence from the full-screen composer as one of two
/// unresolved asymmetries, and screen 08 explains what the glyph actually means: *"The
/// dashed selection glyph is still present in the input even though nothing is currently
/// attached — it is a persistent affordance, not a state indicator."* So its presence is
/// not a property of the scale, it is a property of whether there is a board to lasso
/// from — which is what this enum says, at either scale.
enum ComposerSelection: Equatable, Sendable {
    /// No board within reach: no marquee glyph, no card.
    case unavailable
    /// A board is reachable. The marquee shows in `--color-icon` grey.
    case idle
    /// `btn/select` is lit and the board's marquee is armed, but the student has not
    /// drawn a region yet.
    ///
    /// **Not from the design**, which draws this axis as a straight on/off because it
    /// never drew the drag in between (board 05 open question 7). The state has to exist
    /// once picking a region takes a gesture: the glyph must go violet the instant the tap
    /// lands — it is the only feedback the tap has — while the `Selection attached` card
    /// must not, because nothing is attached yet and a card that says otherwise is simply
    /// wrong.
    case arming
    /// A selection is attached: the marquee turns brand violet and the card grows behind
    /// the pill. Board 03 §11.4 flags that colour change as real but undocumented —
    /// *"confirm this is intentional (it reads as a sensible affordance) and add the token
    /// binding"* — which is what the binding here does.
    case attached

    /// Whether the glyph is drawn in `--color-brand` rather than `--color-icon`.
    var isLit: Bool { self == .arming || self == .attached }
}

/// Which card the composer has grown behind its pill.
///
/// **Two cards, not one card with two fills**, and this is the axis that says which. The
/// label card is board 03's — a 38pt band with "Selection attached" written across it, and
/// still exactly right for a lassoed region on its own. The chips card is board 16's: a
/// chip carrying a 32pt thumbnail does not fit in 38 points, so the band is 52 and the
/// composer is 102 rather than 88 (132 rather than 120 full-screen).
///
/// It exists because that difference was invisible in code. `attachedHeight` measured the
/// label card and was read by everything that reserves space for a grown composer, so a
/// composer showing chips was 14 points taller than anything measuring it believed. Every
/// such measurement now has to name the card, which is a question with an answer rather
/// than a bool with a default.
enum ComposerCard: Equatable, Sendable, CaseIterable {
    /// The resting pill: nothing behind it.
    case none
    /// `SelectionAttachment.composer` — a board region and nothing else.
    case label
    /// `AttachmentChipRow` — one or more files, with the region as a chip among them.
    case chips
}

/// Every measured value of the composer, at both scales.
///
/// The child sizes close the row exactly at both scales, which is the check that the
/// padding and gap are right. Without the attach button:
/// `301 − 18 − 24 − 10 − 151 − 10 − 34 − 10 − 38 − 6 = 0` and
/// `740 − 28 − 574 − 16 − 46 − 16 − 52 − 8 = 0`. With it:
/// `301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0` and
/// `740 − 28 − 20 − 16 − 538 − 16 − 46 − 16 − 52 − 8 = 0` — two fewer terms in
/// the wide row, which has no marquee.
/// `placeholderWidth(includingPlus:includingMarquee:)` is that arithmetic, and the
/// tests run it against the widths screens 05 and 07 measure.
///
/// **The pill came down a step.** 58 → 50 in the panel and 80 → 68 full-screen, because at the
/// old heights the input was the heaviest thing on a surface whose subject is the
/// conversation. Everything in the row came down with it in proportion — paddings, gap, and
/// both button boxes — with one exception: the **glyph sizes did not move**. `composer/send`
/// renders at 22 and 26, `composer/voice` at 20 and 26, and those are the sizes
/// `design/icons.json` publishes for them. Scaling the boxes is a layout change; inventing a
/// 19 or a 23 would add render sizes to a documented icon set to save two points of padding.
/// The send arrow now sits in 8pt of circle instead of 10.
struct ComposerMetrics: Equatable, Sendable {
    let scale: ChatScale
    /// The column the pill fills — *"every child of the panel is this wide"* in the panel, and
    /// the reading column full-screen. It is the one property of the composer that is a
    /// consequence of the screen rather than of the scale, which is why it is the only one
    /// `for(_:width:)` substitutes; see that method for why the rest hold still.
    ///
    /// `private(set)` so a caller can only get a re-widened composer through `for(_:width:)`,
    /// which is also the only thing in this file that writes it.
    private(set) var width: CGFloat
    let height: CGFloat
    let paddingLeading: CGFloat
    let paddingTrailing: CGFloat
    let gap: CGFloat
    /// `ui/selection-marker`, the leading glyph.
    let marqueeSize: CGFloat
    /// `ui/plus`, the attach button in the leading group.
    ///
    /// 20 at both scales, which is the single render size `design/icons.json` publishes for
    /// it. It is not stepped up to the marquee's 24 to make the two glyphs match: the
    /// marquee itself holds at 24 full-screen while every other glyph in the row steps up,
    /// for exactly this reason.
    let plusSize: CGFloat
    let voiceButtonSize: CGFloat
    let voiceGlyphSize: CGFloat
    let sendButtonSize: CGFloat
    let sendGlyphSize: CGFloat
    let placeholderStyle: DS.TextStyle
    let placeholder: String
    /// `ui/cross`, the cancel in the leading slot while a session runs. 22 at panel scale, 26
    /// full screen — board 15.
    let cancelGlyphSize: CGFloat
    /// `ui/level`, in the text lane while capturing.
    let meter: LevelMeterMetrics
    /// The full-screen send button carries a shadow the panel's does not — see
    /// `ComposerSendButton`.
    let sendIsRaised: Bool

    /// Board 03 §2, applied to whichever pill this scale draws — in the column this composer
    /// was given, because the card is edge-to-edge with the pill and a card still 740 wide
    /// behind a 644 pill is the notch rule broken from the other side.
    var attachment: AttachmentStackMetrics { .composer(scale, width: width) }

    /// The stack behind the pill for whichever card is drawn — see `ComposerCard`.
    ///
    /// `.none` takes the label card's geometry because that is what a caller asking about
    /// the *shape* of a resting composer means; nothing is drawn either way.
    func attachment(showing card: ComposerCard) -> AttachmentStackMetrics {
        switch card {
        case .none, .label: attachment
        case .chips: .composerChips(scale, width: width)
        }
    }

    /// The composer's whole height with `card` behind the pill — the card's visible band
    /// plus the pill, or just the pill when there is no card.
    ///
    /// **50 / 88 / 102 in the panel, 68 / 120 / 132 full-screen.** Anything reserving space
    /// for a grown composer has to say which of the three it means; there is no single
    /// "attached" height, and the one that used to exist measured the label card while the
    /// composer drew chips.
    func height(showing card: ComposerCard) -> CGFloat {
        card == .none ? height : attachment(showing: card).totalHeight
    }

    /// The space above and below the send button — and so the pill's own vertical padding.
    ///
    /// Not a new number. The send button is inset uniformly from the pill's edge at both
    /// scales — `38 + 2 × 6 = 50` and `52 + 2 × 8 = 68` — so this comes out equal to
    /// `paddingTrailing`, and `height` stops being a value the row is squeezed into and becomes
    /// a *consequence* of the row: the tallest child, plus this, twice. Which is the whole
    /// mechanism by which the pill can grow at all.
    var paddingVertical: CGFloat { (height - sendButtonSize) / 2 }

    /// The pill's interior at rest: the box every fixed child of the row keeps, so a single
    /// line of text and the three glyphs stay optically centred exactly where the design
    /// centres them, and a grown pill drops them onto its last line rather than floating them
    /// in the middle of it.
    var innerHeight: CGFloat { height - 2 * paddingVertical }

    /// The tallest the pill grows before the text starts scrolling inside it: `maxLines` lines
    /// of the scale's own placeholder type, in the same interior every other state uses.
    /// **124.7 in the panel and 163.8 full-screen.**
    ///
    /// `max`, not a sum, because the interior already holds the first line and then some — 38
    /// points of it against a 22.5pt line — so the pill does not move at all until the text
    /// outgrows the send button, and five lines cost four line boxes plus the change, not five.
    var maxHeight: CGFloat {
        max(innerHeight, placeholderStyle.height(lines: Self.maxLines)) + 2 * paddingVertical
    }

    /// The pill's corner radius — the one number in the row that does **not** follow the pill's
    /// height once it starts growing.
    ///
    /// Board 03: *"the pill height changes (50 in the panel, 68 full-screen) but the radius
    /// formula never does, so a port must use a capsule shape, not a fixed corner value."* The
    /// formula is half the height, and it is evaluated at the **resting** height: at rest this
    /// is exactly `Capsule()` — 25 and 34, the radii the two screens measure — while a capsule
    /// re-derived from a five-line pill is a 70pt stadium, which is not a shape the design
    /// draws anywhere. The card behind an attached selection is cut to this same curve.
    var cornerRadius: CGFloat { height / 2 }

    /// Apple's stated default touch target: larger than the 24pt slot the cancel glyph sits in
    /// and larger than the panel's 34pt mic. A touch target, not a visual value — it draws
    /// nothing, and every drawn box stays exactly where the design put it.
    static let minimumTapTarget: CGFloat = 44

    /// How many lines of typing the pill grows to hold, at either scale, before the text
    /// scrolls inside a pill that has stopped moving.
    ///
    /// **Not from the design.** Board 03 §11.11 draws the empty pill and nothing else, so what a
    /// long question does to it is undrawn — and "one line, then the words slide out of sight"
    /// is not a state the product can stay in: the panel's text lane is 151pt, which is about
    /// four words of a question a student is composing about the board in front of them.
    ///
    /// One number rather than one per scale, because the rule is *how much of the surface an
    /// input may take from the conversation it sits under*, and that is a property of the pill,
    /// not of the column: five lines is 125 of the panel's 976 and 164 of the reading column's,
    /// the same shallow slice of either surface.
    static let maxLines = 5

    /// The one line above the pill that says nothing came back, or that it failed.
    /// `15 / 18 · 400 · --color-ink-secondary`, the same specimen the error state's reassurance
    /// line uses.
    static let noteStyle = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)
    /// `--spacing-3` between the note and the pill: the retry is the mic, right below it.
    static let noteGap = DS.Space.s3

    /// What is left for the text once every fixed-width child and every gap comes off.
    ///
    /// `includingPlus` defaults to `false` so every specimen, preview and gallery entry —
    /// none of which mounts an attach button — keeps the width it had.
    func placeholderWidth(includingPlus: Bool = false, includingMarquee: Bool) -> CGFloat {
        let children: [CGFloat] = (includingPlus ? [plusSize] : [])
            + (includingMarquee ? [marqueeSize] : [])
            + [voiceButtonSize, sendButtonSize]
        let gaps = gap * CGFloat(children.count)
        return width - paddingLeading - paddingTrailing - children.reduce(0, +) - gaps
    }
}

extension ComposerMetrics {
    /// Screens 05 and 08, at the stepped-down pill. The voice button is 34 and its glyph
    /// stays 20 — screen 05's input row is also where board 03's "voice exists only at
    /// full-screen" claim comes apart: the live panel composer has one.
    static let panel = Self(
        scale: .panel,
        width: DS.Container.panelContent,
        height: 50,
        paddingLeading: 18,
        paddingTrailing: 6,
        gap: 10,
        marqueeSize: Icon.uiSelectionMarker.renderSize,
        plusSize: Icon.uiPlus.renderSize,
        voiceButtonSize: 34,
        voiceGlyphSize: 20,
        sendButtonSize: 38,
        sendGlyphSize: 22,
        placeholderStyle: .bodyControl,
        placeholder: "Ask anything...",
        cancelGlyphSize: 22,
        meter: .panel,
        sendIsRaised: false
    )

    /// Screen 07. The marquee keeps its one documented render size rather than stepping up
    /// with the other glyphs: `ui/selection-marker` is drawn at 24 everywhere in the
    /// product, and inventing a 26 for it would be a value the design never states.
    static let fullScreen = Self(
        scale: .fullScreen,
        width: DS.Container.column,
        height: 68,
        paddingLeading: DS.Space.s7,
        paddingTrailing: DS.Space.s2,
        gap: DS.Space.s4,
        marqueeSize: Icon.uiSelectionMarker.renderSize,
        plusSize: Icon.uiPlus.renderSize,
        voiceButtonSize: 46,
        voiceGlyphSize: Icon.composerVoice.renderSize,
        sendButtonSize: 52,
        sendGlyphSize: Icon.composerSend.renderSize,
        // `--text-lead` is the design's own pairing for this slot: "Lead paragraph and
        // composer placeholder at FULL-SCREEN scale". The node measures a 26pt line box
        // rather than the token's 30; the text is one line optically centred in the
        // pill, so the two are indistinguishable and the token is the traceable one.
        placeholderStyle: .lead,
        placeholder: "Ask me anything...",
        cancelGlyphSize: 26,
        meter: .fullScreen,
        sendIsRaised: true
    )

    static func `for`(_ scale: ChatScale) -> Self {
        switch scale {
        case .panel: .panel
        case .fullScreen: .fullScreen
        }
    }

    /// The same composer, in a column of `width`.
    ///
    /// **Only the width moves, and that is the whole point.** Board 05: *"the type scale …
    /// composer height (50/88 vs 68) and the composer's contents all change. Treat the
    /// greeting/chips/composer as two variants, not one responsive view."* So the pill's
    /// height, its paddings, its gap, its two button sizes and its placeholder are the
    /// scale's discrete treatment and hold still at every column; the row the children close
    /// exactly — `740 − 32 − 552 − 18 − 52 − 18 − 56 − 12 = 0` — closes on whatever the column
    /// is, because `placeholderWidth(includingMarquee:)` is the same subtraction with a
    /// different first term. The text lane is the only child with give in it, which is the
    /// same thing `flex-grow: 1` says about it on board 07.
    ///
    /// Which is what fixes the bug this exists for: `--container-column` is 740, but
    /// `ScreenLayout.columnWidth` is `min(740, region − 2 × edge)`, so a portrait iPad hands
    /// the full-screen composer 644 and the pill drew 740 in it.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        var metrics = Self.for(scale)
        metrics.width = max(0, width)
        return metrics
    }
}

// MARK: - The composer's slot

/// The composer and the band of surface behind it, measured once.
///
/// **These were two things and they drifted.** The fade lived in whichever branch of a surface
/// happened to draw the thread, so the full-screen greeting rendered a composer with nothing
/// behind it — a floating pill over content that scrolls the moment the chip grid wraps. The
/// band was also computed twice, and one of the two used the thread's clearance, which
/// includes the 24pt gap above the pill, so the veil started inside the newest message.
///
/// One type fixes both: `band` is the single expression of *composer top to surface floor*,
/// the fade is derived from it rather than passed alongside it, and `ComposerSlot` is the only
/// way to place a composer — so a new surface cannot forget the fade or size it independently.
struct ComposerSlotMetrics: Equatable, Sendable {
    /// The **full** width of the surface the fade spans — the panel's 337, not its 301 column.
    /// Board 03 puts the fade outside the thread precisely so it can run corner to corner.
    let surfaceWidth: CGFloat
    /// The resting pill — never the attached one, and never the grown one. Both of those grow
    /// the composer *upward*, and a band that followed them would redraw the conversation the
    /// moment a selection was attached or a second line was typed. The pill is opaque and
    /// carries 03 Control, so what rises above the band reads as floating over the thread,
    /// which is what it is.
    let composerHeight: CGFloat
    /// What sits under the pill inside the surface — the panel's 18pt inset, and nothing
    /// full-screen, where the pill's bottom *is* the content band's floor.
    let underhang: CGFloat

    /// Composer top to surface floor. The fade's whole extent, and the clearance the thread
    /// keeps at the bottom of its own frame.
    var band: CGFloat { composerHeight + underhang }

    var fade: ScrollFadeMetrics { .bottom(coveringComposer: band) }

    /// Boards 05, 08 and 12.
    static func panel(surfaceWidth: CGFloat) -> Self {
        Self(
            surfaceWidth: surfaceWidth,
            composerHeight: ComposerMetrics.panel.height,
            underhang: TutorPanelMetrics.inset
        )
    }

    /// Boards 07 and 13, in the column the reading lane actually got.
    ///
    /// `underhang` is the screen's edge inset below the content band — the full-screen
    /// surface is the screen, so its floor is the screen's, and the fade has to reach it the
    /// same way the panel's reaches through the 18pt inset. Defaulted to 0 for the gallery
    /// specimens, which have no screen below them.
    static func fullScreen(columnWidth: CGFloat, underhang: CGFloat = 0) -> Self {
        Self(
            surfaceWidth: max(0, columnWidth),
            composerHeight: ComposerMetrics.for(.fullScreen, width: columnWidth).height,
            underhang: max(0, underhang)
        )
    }

    /// Where board 16's attach menu's **top** edge lands, measured from the top of a surface
    /// `surfaceHeight` tall.
    ///
    /// The menu hangs *above* the composer — the composer sits on the surface's floor, so a
    /// menu dropping out of it would leave the surface — with its bottom edge
    /// `AttachMenu.gapAbovePill` clear of the pill's top. That is the whole of board 16's
    /// `744 + 156 + 8 = 908`, derived from the surface the app is actually in rather than
    /// read off the board.
    ///
    /// **`composerHeight` is the composer's height with whatever card it is currently
    /// drawing** — `ComposerMetrics.height(showing:)` — and not this slot's own
    /// `composerHeight`. The slot measures the *resting* pill on purpose, because the fade
    /// and the thread's clearance must not move when a card appears; but the card grows the
    /// composer **upward** out of the band, so a menu anchored on `band` is drawn over the
    /// chips the learner has just made. With one file attached in the panel that is 44 of
    /// the card's 52 points covered, on the tap that adds the second file.
    ///
    /// Clamped at 0, so a surface too short to hold the card pins it to the top rather than
    /// pushing it out through the surface's own edge.
    func attachMenuTop(in surfaceHeight: CGFloat, over composerHeight: CGFloat) -> CGFloat {
        max(0, surfaceHeight - composerHeight - underhang - AttachMenu.gapAbovePill - AttachMenu.height)
    }
}

extension AttachMenu {
    /// How wide the card is drawn in a surface whose content column is `contentColumn`.
    ///
    /// **Capped at `--container-panel-content` at both scales, by ruling.** A menu is a list
    /// of three short labels, not a reading column: its width follows its content, not the
    /// surface it happens to be on. 301 is what board 16 draws and what `menu/sessions`
    /// beside it takes, so full-screen the card sits left-aligned above the composer rather
    /// than stretching 740 points across the screen for three left-aligned words.
    ///
    /// A `min` rather than the bare constant, because the cap has to give in one direction:
    /// a panel the student has narrowed past 301 has no room for the card, and a menu wider
    /// than the surface clipping it is a menu with its rows running off the edge.
    ///
    /// It lives here beside `attachMenuTop` rather than on `AttachMenu` itself: both are how
    /// a *surface* places board 16's card relative to its composer, which is a question the
    /// menu does not answer for itself.
    static func width(in contentColumn: CGFloat) -> CGFloat {
        min(max(0, contentColumn), DS.Container.panelContent)
    }
}

/// The composer's slot as paint: the fade, then whatever occupies the slot, bottom-anchored.
///
/// Bottom-anchored rather than offset to a computed top, which is what makes the attached
/// composer free: the card grows upward out of the slot and the pill does not move, so no
/// caller has to know whether a selection is attached.
struct ComposerSlot<Content: View>: View {
    let metrics: ComposerSlotMetrics
    /// The fade has to be the surface it sits on. The panel's `--color-surface-panel`, and
    /// `--color-surface` in the reading column — *"a fade of the panel's grey would bleed a
    /// visibly different white over the messages."*
    var surfaceColor: Color = DS.Color.surfacePanel
    /// The occupant. May be empty — the band is still the slot's, so the fade is still right.
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollFade(width: metrics.surfaceWidth, metrics: metrics.fade, color: surfaceColor)
            content().padding(.bottom, metrics.underhang)
        }
        .frame(width: metrics.surfaceWidth, height: metrics.band, alignment: .bottom)
    }
}

// MARK: - What a running session hands the composer

/// A dictation session, as much of it as the composer needs to draw.
///
/// A value rather than a reference to the controller, so the design-system layer keeps knowing
/// nothing about the app: this is a phase, a start date, a way to read the microphone's level,
/// and the one action the composer owns that the mic button does not.
struct ComposerDictation {
    let phase: DictationPhase
    /// When the microphone opened — the elapsed label's origin.
    let startedAt: Date
    /// The live input level, 0…1. A closure rather than a value because the meter samples it at
    /// its own ~20 Hz rather than having twenty state changes a second pushed through the view
    /// tree.
    let level: () -> Double
    /// Discard the recording, or the request. Never a confirmation — see `ComposerCancelButton`.
    let onCancel: () -> Void

    init(
        phase: DictationPhase,
        startedAt: Date,
        level: @escaping () -> Double = { 0 },
        onCancel: @escaping () -> Void = {}
    ) {
        self.phase = phase
        self.startedAt = startedAt
        self.level = level
        self.onCancel = onCancel
    }
}

// MARK: - The composer

/// The one control that floats free of the panel edge, which is why it is a capsule:
/// *"the pill height changes (50 in the panel, 68 full-screen) but the radius formula
/// never does, so a port must use a capsule shape, not a fixed corner value."*
struct Composer: View {
    let scale: ChatScale
    /// The **column** the pill fills, not a size of its own. `nil` takes the column the design
    /// drew this scale in — 301 in the panel, 740 full-screen — which is what a preview or a
    /// gallery specimen wants; the screens pass the column they measured.
    var width: CGFloat?
    @Binding var text: String
    var selection: ComposerSelection = .idle
    let onSend: () -> Void
    /// The attach button's action — opening the menu. Optional so a specimen with nowhere
    /// to put a picker draws the composer without it, the rule `onVoice` and
    /// `onToggleSelection` already follow.
    var onAttach: (() -> Void)?
    /// Whether the draft can take another file at all.
    ///
    /// **Not from the design**, which draws exactly one `+` and no unavailable state for
    /// it. It has to exist because the thing behind the button can refuse:
    /// `ComposerAttachments.add(...)` returns `Void` and silently does nothing once the
    /// draft holds five files or while a send is in flight, and a control that swallows a
    /// tap is worse than one that says it cannot be used.
    ///
    /// **Greyed rather than a menu that opens and refuses.** Three reasons. The row's
    /// arithmetic must not move — the `+` keeps its 20pt slot and its gap in both
    /// compositions, so nothing on the pill shifts when the fifth file lands. The tint
    /// change is the mechanism the glyph *beside* it already uses to say lit or unlit, so
    /// the composer is not learning a second vocabulary. And the reason is already on
    /// screen: five chips are sitting in the card directly above the button, or a send is
    /// visibly under way — a menu that opened only to restate that would cost a tap and a
    /// card height the design never drew.
    var canAttach = true
    /// Dictation, when the platform has it. Board 03's unresolved note says the voice
    /// button's full-screen-only appearance *"is an inconsistency in the design, not a
    /// considered rule ... do not copy the current asymmetry into code as if it were
    /// intentional"*, so availability decides it here, not the scale — and both sizes the
    /// design draws are kept.
    var onVoice: (() -> Void)?
    /// The dictation session running right now, or `nil` when none is. Board 15.
    var dictation: ComposerDictation?
    /// One line above the pill: nothing came back, or it failed. Board 15 §02.
    var note: String?
    var onDismissSelection: (() -> Void)?
    /// `btn/select`: arm the board's marquee, or put the pencil back on the ink. Optional so
    /// a specimen that has no board behind it draws the glyph without pretending to be a
    /// control — see `leading`.
    var onToggleSelection: (() -> Void)?
    /// Whether there is anything on the board to select — `canAttach`'s twin, for the
    /// glyph on the other side of the field.
    ///
    /// The thing behind this button refuses the same way `ComposerAttachments.add(...)`
    /// does: `BoardScreen.toggleBoardSelection` guards on the board holding ink and
    /// silently returns, so on an empty board the one selection control in the docked
    /// composer swallowed its tap. The dock's `btn/select` already takes the same flag
    /// (`CollapsedDock.canSelect`), so the two instances of the control agree.
    ///
    /// A lit glyph stays enabled regardless — disarming is allowed unconditionally, so a
    /// marquee can never be left armed over a board that has since been cleared. That is
    /// the dock's rule too.
    var canSelect = true
    /// The files on this draft, in the order they were picked. Empty is the composer every
    /// screen has drawn until now.
    var attachments: [PendingAttachment] = []
    var onRemoveAttachment: ((UUID) -> Void)?

    private var metrics: ComposerMetrics { .for(scale, width: width ?? scale.contentWidth) }

    /// Drawn when there is somewhere for it to lead, and never while dictation holds the
    /// leading slot — a file picker mid-recording is meaningless, and nothing on screen
    /// should move when the microphone opens.
    var drawsAttachButton: Bool { onAttach != nil && dictation == nil }

    /// Which card is above the pill — **the one place that decides**, so the branch in
    /// `attachmentCard`, the metrics the chips are measured with, and any surface reserving
    /// room for a grown composer are all reading the same answer.
    ///
    /// Files win over the lone region because the region becomes a chip among them: the
    /// chips card is what draws both, and the label card is only ever a region on its own.
    var card: ComposerCard {
        if !attachments.isEmpty { .chips }
        else if selection == .attached { .label }
        else { .none }
    }

    /// The card above the pill, which used to belong to the board selection alone. It now
    /// appears for anything attached at all.
    var drawsAttachmentCard: Bool { card != .none }

    /// Nothing to send is not a designed state — there is no disabled send button on the
    /// board — so the button keeps its one appearance and the action declines instead.
    var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || selection == .attached
            || !attachments.isEmpty
    }

    /// **`drawsAttachmentCard` is the branch, not a description of it.** It was stated as a
    /// rule and then re-expressed as a condition chain here, which is two places to change
    /// and four tests reading the one that draws nothing. Whether there is a card is this
    /// property; *which* card is the only thing left inside.
    var body: some View {
        if drawsAttachmentCard {
            attachmentCard
        } else {
            annotatedPill
        }
    }

    @ViewBuilder
    private var attachmentCard: some View {
        if card == .chips {
            // Chips: `AttachmentStack` directly, with the taller card. Not
            // `SelectionAttachment.composer`, which is the *label* card — the one the
            // design drew, and still exactly right for a lassoed region on its own.
            AttachmentStack(metrics: chipsMetrics) {
                AttachmentChipRow(
                    attachments: attachments,
                    showsSelection: selection == .attached,
                    metrics: chipsMetrics,
                    onRemove: { onRemoveAttachment?($0) },
                    onDismissSelection: { onDismissSelection?() }
                )
            } content: {
                annotatedPill
            }
        } else {
            SelectionAttachment.composer(
                metrics: metrics.attachment,
                onDismiss: onDismissSelection
            ) {
                annotatedPill
            }
        }
    }

    /// The chips card, in the column this composer was given — the same substitution
    /// `ComposerMetrics.attachment` makes, for the same reason: a card still 740 wide
    /// behind a 644 pill is the notch rule broken from the other side.
    private var chipsMetrics: AttachmentStackMetrics { metrics.attachment(showing: .chips) }

    /// The note is drawn as an overlay rather than as a row above the pill, so a sentence that
    /// appears after a failed dictation cannot move the composer the student is about to type
    /// into. Board 15 puts it *in the band above*, and that band is empty space in every screen
    /// this composer appears on.
    private var annotatedPill: some View {
        pill
            .overlay(alignment: .topLeading) { noteLine }
            // WCAG 4.1.3: a status message has to reach a student who is not looking at the
            // band above the composer. One announcement when it appears — not one per phase
            // change, which is the "too chatty" failure the same criterion warns about.
            .onChange(of: note) { _, appeared in
                guard let appeared else { return }
                AccessibilityNotification.Announcement(appeared).post()
            }
    }

    @ViewBuilder
    private var noteLine: some View {
        if let note {
            Text(verbatim: note)
                .textStyle(ComposerMetrics.noteStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .frame(width: metrics.width, alignment: .leading)
                .offset(y: -(ComposerMetrics.noteStyle.leading + ComposerMetrics.noteGap))
                .accessibilityAddTraits(.isStaticText)
        }
    }

    /// **The pill measures its own row rather than being given a height**, which is what lets it
    /// grow with what is typed into it. At rest the arithmetic is unchanged and exact: every
    /// fixed child keeps `innerHeight`, the send button *is* `innerHeight`, and `innerHeight`
    /// plus `paddingVertical` twice is the 50 and the 68 the design measures.
    ///
    /// The row is bottom-aligned so the growth goes **upward** — the pill's bottom edge is the
    /// one thing on this surface a student's thumb has learned the position of, and the mic and
    /// send sit on the last line of a grown pill the way they sit on the only line of a resting
    /// one. Nothing below the composer moves, which is also why `ComposerSlotMetrics` still
    /// measures its band off the resting pill.
    private var pill: some View {
        HStack(alignment: .bottom, spacing: metrics.gap) {
            if drawsAttachButton {
                attachButton.frame(height: metrics.innerHeight)
            }

            leading

            // The one child with give in it — vertically now as well as horizontally. It fills
            // the pill's interior at rest, so a single line sits where the design centres it,
            // and past that it is the thing the pill's height is a consequence of.
            field
                .frame(maxWidth: .infinity, minHeight: metrics.innerHeight, alignment: .leading)

            // The mic is the stop control while capturing, and gone while transcribing: the
            // microphone has already closed, so a button that offered to close it would be
            // describing something that has happened. Cancel is the leading cross.
            if let onVoice, dictation?.phase != .transcribing {
                ComposerVoiceButton(metrics: metrics, dictation: dictation?.phase, action: onVoice)
                    .frame(height: metrics.innerHeight)
            }

            ComposerSendButton(metrics: metrics, action: send)
                .frame(height: metrics.innerHeight)
        }
        .padding(.leading, metrics.paddingLeading)
        .padding(.trailing, metrics.paddingTrailing)
        .padding(.vertical, metrics.paddingVertical)
        .frame(width: metrics.width)
        // The pill takes its **ideal** height, not the one it is offered. `ComposerSlot` sizes
        // itself to the resting band and proposes that band downward, and a vertical-axis text
        // field is flexible enough to accept it — which capped the composer at the two lines
        // that fit inside 50 points instead of the five its line limit allows. Vertical only:
        // the width is still the column's, and still the one thing the design lets move.
        .fixedSize(horizontal: false, vertical: true)
        // A capsule at the resting height, held there — see `ComposerMetrics.cornerRadius`.
        // `.circular`, like every other radius in the product: the design's corners are CSS
        // corners, and the card tucked behind this shape is sized off that exact curve.
        .background(DS.Color.surface, in: RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .circular))
        .elevation(.control)
    }

    /// `ui/plus` at its one published render size, in `--color-icon` rather than the
    /// `--color-brand` the icon set publishes for it.
    ///
    /// Board 15a's violet is right where the plus is *the* action on a menu of neutral
    /// rows. Here it is one of four controls in a grey row, and violet already means "lit"
    /// — the marquee immediately beside it uses exactly that to say a selection is armed.
    /// Two violet glyphs side by side meaning different things is worse than departing from
    /// the token, so the composer's instance departs and the published token does not
    /// change. The departure is recorded on the Paper node itself, in its layer name.
    ///
    /// The unavailable tint is `--color-ink-tertiary`, the token the placeholder already
    /// uses for text that is present but is not content — see `canAttach`.
    private var attachButton: some View {
        Button(action: { onAttach?() }) {
            IconView(
                .uiPlus,
                size: metrics.plusSize,
                tint: canAttach ? DS.Color.icon : DS.Color.inkTertiary
            )
            // 20 points in a 50pt pill hit-tests well under the 44pt minimum. Given back as
            // negative padding, like the marquee beside it, so the row's arithmetic —
            // `301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0` — does not
            // move by a point.
            .expandedTapTarget(ComposerMetrics.minimumTapTarget, over: metrics.plusSize)
        }
        .buttonStyle(.plain)
        .disabled(!canAttach)
        .accessibilityLabel(Self.attachLabel)
        .accessibilityValue(canAttach ? "" : Self.attachUnavailableValue)
    }

    static let attachLabel = "Attach a photo or file"
    /// What VoiceOver says in place of the grey the button turns. The learner using a
    /// screen reader gets a sentence where the sighted learner gets the full card above the
    /// button.
    ///
    /// One sentence for both refusals — a draft holding its fifth file, and a send already
    /// under way — because what it says is true of both and the composer is not told which
    /// of the two it is in.
    static let attachUnavailableValue = "Unavailable — this message can't take another file"

    /// The marquee's slot, which dictation borrows for its cancel because a lasso attachment is
    /// meaningless while the microphone is open — so nothing on screen moves when it opens.
    ///
    /// Either occupant takes the pill's resting interior as its box, like every other fixed
    /// child of the row. The **empty** branch has to stay genuinely empty, though: a
    /// zero-width child with a height on it is still a child, and the bottom-aligned row would
    /// space it — turning `301 − 18 − 24 − 10 − …` into a row with one gap too many.
    @ViewBuilder
    private var leading: some View {
        if let dictation {
            ComposerCancelButton(metrics: metrics, action: dictation.onCancel)
                .frame(height: metrics.innerHeight)
        } else if selection != .unavailable {
            marqueeControl
                .frame(height: metrics.innerHeight)
        }
    }

    /// **This glyph is `btn/select`.** Board 03 §11.4 describes it as *"a persistent
    /// affordance, not a state indicator"*, and the port read that as "decorative": it was an
    /// `IconView` with `accessibilityHidden(true)`, so tapping the one selection control on
    /// the docked screen did nothing and it never changed colour. Meanwhile the working
    /// control lived in `CollapsedDock`, which the docked screen does not draw — leaving the
    /// board unreachable from the state the app launches in. An affordance that affords
    /// nothing is the bug; wiring it to the same action the dock's button already had is the
    /// smallest fix, and it costs no new pixels because the design already put the glyph here
    /// in both of its states.
    ///
    /// It stays a plain glyph when no handler is supplied, which is what every specimen,
    /// preview and gallery entry passes.
    @ViewBuilder
    private var marqueeControl: some View {
        if let onToggleSelection {
            Button(action: onToggleSelection) {
                marquee
                    // The glyph is 24pt in a 50pt pill, so it hit-tests well under the
                    // 44pt minimum. Given back as negative padding, exactly as the
                    // rail's 27pt swatches are, so the target grows without the row's
                    // arithmetic — `301 − 18 − 24 − 10 − 151 − 10 − 34 − 10 − 38 − 6 = 0`
                    // — moving by a point.
                    .expandedTapTarget(ComposerMetrics.minimumTapTarget, over: metrics.marqueeSize)
            }
            .buttonStyle(.plain)
            .disabled(!marqueeIsAvailable)
            .accessibilityLabel("Select an area of the board")
            // "Attached" the moment the marquee is armed, matching the glyph — this
            // value is what says the tap landed, and the dock's own button reports
            // the same axis the same way. Unavailable gets a sentence instead, as
            // the `+` beside the field does — see `attachUnavailableValue`.
            .accessibilityValue(
                marqueeIsAvailable
                    ? (selection.isLit ? "Attached" : "Not attached")
                    : Self.selectUnavailableValue
            )
            .accessibilityAddTraits(selection.isLit ? .isSelected : [])
        } else {
            marquee.accessibilityHidden(true)
        }
    }

    /// Lit wins over unavailable by construction: a lit glyph means the marquee is armed
    /// or a region is attached, and that keeps the control enabled — see `canSelect`.
    private var marqueeIsAvailable: Bool { canSelect || selection.isLit }

    /// What VoiceOver says in place of the grey the glyph turns — the sentence pattern
    /// `attachUnavailableValue` set.
    static let selectUnavailableValue = "Unavailable — the board has nothing to select"

    private var marquee: some View {
        IconView(
            .uiSelectionMarker,
            size: metrics.marqueeSize,
            tint: selection.isLit
                ? DS.Color.brand
                : (marqueeIsAvailable ? DS.Color.icon : DS.Color.inkTertiary)
        )
    }

    /// The design draws only the empty state, at both widths — no caret, focus ring, or
    /// filled-text colour (board 03 §11.11). Not from the design, and as small as it can
    /// be: typed text takes `--color-ink` because the placeholder token's own description
    /// says tertiary is *"never used for real content"*, and there is no focus treatment
    /// at all because rule 1 is that the product has no borders.
    ///
    /// Keyboard-up is undesigned too (board 05 §12). Nothing here opts out of the
    /// keyboard safe area, so the composer rides above it the way every iPadOS control
    /// does, and whatever the design eventually says can replace that with a real rule.
    @ViewBuilder
    private var field: some View {
        if let dictation {
            dictationLane(dictation)
        } else {
            typingLane
        }
    }

    /// **The field wraps.** A vertical-axis field is the whole of it: it reports the height of
    /// what has been typed, the pill is that height plus its padding, and `lineLimit` is where
    /// both stop — past `maxLines` the field scrolls its own content and the pill holds still.
    ///
    /// Return still sends, which is why the axis costs nothing here: `submitLabel(.send)` is the
    /// design's, a vertical field routes the return key to `onSubmit` rather than inserting a
    /// newline, and the lines this grows to hold are wrapped ones — a question too long for a
    /// 151pt lane, not a student laying out paragraphs.
    private var typingLane: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(verbatim: metrics.placeholder)
                    .textStyle(metrics.placeholderStyle)
                    .foregroundStyle(DS.Color.inkTertiary)
            }
            TextField("", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1 ... ComposerMetrics.maxLines)
                .textStyle(metrics.placeholderStyle)
                .foregroundStyle(DS.Color.ink)
                .tint(DS.Color.brand)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityLabel(metrics.placeholder)
        }
    }

    /// Board 15's whole design, in one lane.
    ///
    /// **Capturing** is the meter and the elapsed time, and no word at all: motion that answers
    /// the student's voice says more than a label could, and it is the only mark in the product
    /// that proves the microphone is working.
    ///
    /// **Transcribing** is `state/thinking`'s dots plus the word — because there is genuinely
    /// nothing to see now, a timer-driven animation is honest here, and Apple's own guidance to
    /// *"avoid vague terms like loading"* is why it is named rather than left as a spinner.
    ///
    /// **Once text starts arriving** the words are the mark, trailed by `state/streaming`'s
    /// caret. The asymmetry is the point: motion that answers you means listening; motion that
    /// doesn't, plus a word, means working.
    @ViewBuilder
    private func dictationLane(_ dictation: ComposerDictation) -> some View {
        HStack(spacing: DS.Space.s2) {
            switch dictation.phase {
            case .capturing:
                LevelMeter(metrics: metrics.meter, level: dictation.level)
                ElapsedLabel(start: dictation.startedAt)
            case .transcribing where text.isEmpty:
                ThinkingIndicator(scale: scale).accessibilityHidden(true)
                Text(verbatim: Self.transcribingLabel)
                    .textStyle(ComposerMetrics.noteStyle)
                    .foregroundStyle(DS.Color.inkSecondary)
            case .transcribing:
                Text(verbatim: text)
                    .textStyle(metrics.placeholderStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                StreamingCaret(scale: scale)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(dictation.phase == .capturing ? "Recording" : "Transcribing")
    }

    /// Named, not a spinner.
    static let transcribingLabel = "Transcribing…"

    /// See `canSend` — the condition grew a third term when the draft learned to hold
    /// files, and it lives on the property so the tests can read it.
    private func send() {
        guard canSend else { return }
        onSend()
    }
}
