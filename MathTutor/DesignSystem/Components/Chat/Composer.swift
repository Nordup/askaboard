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

/// Every measured value of the composer, at both scales.
///
/// The child sizes close the row exactly at both scales, which is the check that the
/// padding and gap are right: `301 − 18 − 24 − 10 − 151 − 10 − 34 − 10 − 38 − 6 = 0` and
/// `740 − 28 − 574 − 16 − 46 − 16 − 52 − 8 = 0`. `placeholderWidth(_:)` is that
/// arithmetic, and the tests run it against the widths screens 05 and 07 measure.
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

    /// The composer's height once a selection is attached: the card's visible band plus
    /// the pill. 88 in the panel, once the pill came down to 50.
    var attachedHeight: CGFloat { attachment.totalHeight }

    /// Apple's stated default touch target: larger than the 24pt slot the cancel glyph sits in
    /// and larger than the panel's 34pt mic. A touch target, not a visual value — it draws
    /// nothing, and every drawn box stays exactly where the design put it.
    static let minimumTapTarget: CGFloat = 44

    /// The one line above the pill that says nothing came back, or that it failed.
    /// `15 / 18 · 400 · --color-ink-secondary`, the same specimen the error state's reassurance
    /// line uses.
    static let noteStyle = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)
    /// `--spacing-3` between the note and the pill: the retry is the mic, right below it.
    static let noteGap = DS.Space.s3

    /// What is left for the text once every fixed-width child and every gap comes off.
    func placeholderWidth(includingMarquee: Bool) -> CGFloat {
        let children: [CGFloat] = (includingMarquee ? [marqueeSize] : []) + [voiceButtonSize, sendButtonSize]
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
    /// The resting pill, never the attached one: a card grows the composer upward, and a band
    /// that followed it would redraw the conversation the moment a selection was attached.
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
    static func fullScreen(columnWidth: CGFloat) -> Self {
        Self(
            surfaceWidth: max(0, columnWidth),
            composerHeight: ComposerMetrics.for(.fullScreen, width: columnWidth).height,
            underhang: 0
        )
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

    private var metrics: ComposerMetrics { .for(scale, width: width ?? scale.contentWidth) }

    var body: some View {
        if selection == .attached {
            SelectionAttachment.composer(
                metrics: metrics.attachment,
                onDismiss: onDismissSelection
            ) {
                annotatedPill
            }
        } else {
            annotatedPill
        }
    }

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

    private var pill: some View {
        HStack(spacing: metrics.gap) {
            leading

            field

            // The mic is the stop control while capturing, and gone while transcribing: the
            // microphone has already closed, so a button that offered to close it would be
            // describing something that has happened. Cancel is the leading cross.
            if let onVoice, dictation?.phase != .transcribing {
                ComposerVoiceButton(metrics: metrics, dictation: dictation?.phase, action: onVoice)
            }

            ComposerSendButton(metrics: metrics, action: send)
        }
        .padding(.leading, metrics.paddingLeading)
        .padding(.trailing, metrics.paddingTrailing)
        .frame(width: metrics.width, height: metrics.height)
        .background(DS.Color.surface, in: Capsule())
        .elevation(.control)
    }

    /// The marquee's slot, which dictation borrows for its cancel because a lasso attachment is
    /// meaningless while the microphone is open — so nothing on screen moves when it opens.
    ///
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
    private var leading: some View {
        if let dictation {
            ComposerCancelButton(metrics: metrics, action: dictation.onCancel)
        } else if selection != .unavailable {
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
                .accessibilityLabel("Select an area of the board")
                // "Attached" the moment the marquee is armed, matching the glyph — this
                // value is what says the tap landed, and the dock's own button reports
                // the same axis the same way.
                .accessibilityValue(selection.isLit ? "Attached" : "Not attached")
                .accessibilityAddTraits(selection.isLit ? .isSelected : [])
            } else {
                marquee.accessibilityHidden(true)
            }
        }
    }

    private var marquee: some View {
        IconView(
            .uiSelectionMarker,
            size: metrics.marqueeSize,
            tint: selection.isLit ? DS.Color.brand : DS.Color.icon
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

    private var typingLane: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(verbatim: metrics.placeholder)
                    .textStyle(metrics.placeholderStyle)
                    .foregroundStyle(DS.Color.inkTertiary)
            }
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .textStyle(metrics.placeholderStyle)
                .foregroundStyle(DS.Color.ink)
                .tint(DS.Color.brand)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityLabel(metrics.placeholder)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(dictation.phase == .capturing ? "Recording" : "Transcribing")
    }

    /// Named, not a spinner.
    static let transcribingLabel = "Transcribing…"

    /// Nothing to send is not a designed state — there is no disabled send button on the
    /// board — so the button keeps its one appearance and the action declines instead.
    private func send() {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selection == .attached else { return }
        onSend()
    }
}
