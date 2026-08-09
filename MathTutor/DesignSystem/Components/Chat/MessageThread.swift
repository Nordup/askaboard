import SwiftUI

/// One row of the thread.
///
/// `TutorMessage` carries no attachment flag and the design needs one — screen 08's eighth
/// child is a sent message with a board selection stuck to it. The flag lives here rather
/// than being read out of `LearningSignal`, because which send consumed a selection is
/// something the feature layer knows and the domain model does not claim to say.
struct ChatThreadItem: Identifiable, Sendable {
    let message: TutorMessage
    let hasSelection: Bool
    /// Files sent with this turn. Read back from `AttachmentStore`, which is why a reopened
    /// session still shows them — unlike `selectionView`, which is a crop of a board the
    /// device still holds and can re-derive, and unlike a photo of homework, which it
    /// cannot.
    let attachments: [MessageAttachment]
    /// The regions of the board the tutor looked at before writing this. Empty
    /// for every learner message and for any tutor turn that did not look.
    /// Board 14 — they are drawn above the reply, as part of the same turn.
    let boardViews: [BoardView]
    /// The region the learner marqueed and sent with this message, if any. Drawn
    /// above their bubble — see `MessageRow`.
    let selectionView: BoardView?

    var id: UUID { message.id }

    init(
        _ message: TutorMessage,
        hasSelection: Bool = false,
        attachments: [MessageAttachment] = [],
        boardViews: [BoardView] = [],
        selectionView: BoardView? = nil
    ) {
        self.message = message
        self.hasSelection = hasSelection
        self.attachments = attachments
        self.boardViews = boardViews
        self.selectionView = selectionView
    }
}

/// The thread's own geometry. Board 03: *"`justify-content: flex-end` is the whole
/// behaviour. The thread is a fixed-height column, so a short conversation sits on top of
/// the composer and grows upward instead of hanging from the top of the panel with a void
/// beneath it. The newest message is always the same distance from the input, which is
/// where the eye already is."*
struct ThreadMetrics: Equatable, Sendable {
    let width: CGFloat
    /// `--space-message-gap`. Uniform: *"22px between every pair of consecutive children,
    /// regardless of author. There is no tutor-vs-student variation, no run-grouping, no
    /// tighter gap for same-author runs."* Verified across all ten children of the live
    /// thread.
    let gap: CGFloat
    /// What sits under the newest message: *"clears `--space-panel-inset`"*, plus whatever
    /// band the thread runs behind.
    ///
    /// Leading, trailing and top are still 0 — the panel applies its own 18, and the top is
    /// deliberately 0 because the thread starts at the panel's own edge and passes behind the
    /// controls. The bottom is the one that grew: the thread now runs the panel's full height,
    /// so this has to hold the newest message off the composer as well as off the floor, or
    /// the message the student just sent lands behind the pill.
    let bottomPadding: CGFloat
    /// How far the thread's *clip* sits outside its column, on each side.
    ///
    /// Zero everywhere the thread is only text: messages are laid out in the column and stop
    /// at it. `btn/orb` is the exception, and it is the thread's own child — board 03 draws
    /// its halo at `left: −24` on a 46pt box, *"overflows the 46pt box on all sides"*, with the
    /// orb flush to the column's left edge. A scroll view that clipped to the 301 column would
    /// cut that glow off down a hard vertical line, which is the one thing the halo must not
    /// have.
    ///
    /// So the column stays 301 and the clip moves out to meet the halo. It is a bleed, not a
    /// wider column: no message moves, and nothing but the glow is drawn in it. The surface's
    /// own clip is still the real boundary — the panel gives up its 18pt inset and no more, and
    /// the last 6 points of overhang are gradient stops already at zero alpha.
    let bleed: CGFloat

    /// The box the thread clips to: its column plus the bleed on both sides.
    var clipWidth: CGFloat { width + 2 * bleed }

    /// What the column occupies: every child, every gap between them, and the bottom
    /// padding. On the board's ten children this is 589 + 198 + 18 = 805.
    func contentHeight(childHeights: [CGFloat]) -> CGFloat {
        guard !childHeights.isEmpty else { return bottomPadding }
        return childHeights.reduce(0, +) + gap * CGFloat(childHeights.count - 1) + bottomPadding
    }

    /// Where each child lands in a thread of `height`, bottom-anchored.
    ///
    /// *"Because `justify-content: flex-end`, all slack lands at the top (5pt here)."*
    /// Slack is clamped at 0 so an overflowing thread starts at the top and scrolls, rather
    /// than being pulled up off its own first message.
    func offsets(childHeights: [CGFloat], in height: CGFloat) -> [CGFloat] {
        var y = max(0, height - contentHeight(childHeights: childHeights))
        return childHeights.map { childHeight in
            defer { y += childHeight + gap }
            return y
        }
    }
}

extension ThreadMetrics {
    /// The thread in a column of `width`.
    ///
    /// The column is the only thing the screen gets to say about the thread. Board 13's
    /// `Thread · wide` is the same `justify-content: flex-end` and the same 22pt gap —
    /// *"unchanged from panel scale"* — differing in one property, and that one is a
    /// consequence of *where* the thread is rather than how wide: it carries no bottom
    /// padding, because the 18 exists to clear the panel's own inset and full-screen there is
    /// no panel.
    /// `clearing` is the band the thread's band overlaps at the bottom — the composer's, where
    /// the caller has run the thread behind it. It is added to the inset rather than replacing
    /// it, so the newest message keeps exactly the gap it had when the thread stopped above the
    /// composer instead of passing under it. Nobody who is not running the thread full-height
    /// passes it, which is why it defaults to nothing.
    /// The bleed is the thread's one child that is not a message: `OrbSize.thread` is the orb
    /// the design puts at the tail on both surfaces, so both get the same overhang rather than
    /// a number written down twice.
    static var bleed: CGFloat { OrbSize.thread.metrics.haloOverhang }

    static func `for`(_ scale: ChatScale, width: CGFloat, clearing band: CGFloat = 0) -> Self {
        switch scale {
        case .panel:
            return Self(
                width: max(0, width),
                gap: DS.Space.messageGap,
                bottomPadding: DS.Space.panelInset + max(0, band),
                bleed: bleed
            )
        case .fullScreen:
            return Self(
                width: max(0, width),
                gap: DS.Space.messageGap,
                bottomPadding: max(0, band),
                bleed: bleed
            )
        }
    }

    /// The design's own two columns: screen 08's 301 and board 13's 740.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

// MARK: - The thread

/// The scroll container, the message list, and the fade over the top of it.
struct MessageThread<Accessory: View>: View {
    let items: [ChatThreadItem]
    var scale: ChatScale = .panel
    /// The column the thread is laid out in. `nil` takes the one the design drew this scale
    /// at, which is what a preview or a gallery specimen wants; the app passes the panel's
    /// derived content width or `ScreenLayout.columnWidth`.
    var width: CGFloat?
    /// The band at the bottom of the thread's own frame that something else is painted over —
    /// the composer, on both surfaces. The thread scrolls its history behind it, so this is
    /// what keeps the newest message clear of it. See `ThreadMetrics.for(_:width:clearing:)`.
    var clearing: CGFloat = 0
    /// `btn/orb`, the thread's one non-message child. It belongs to the shell, so the
    /// thread reserves its place rather than drawing it — and the place matters: *"`btn/orb`
    /// is a normal flow child at the end of the message list, so it rides up and down with
    /// the conversation rather than being pinned to the panel."* It is also where a
    /// "tutor is thinking" state would go; the design draws no such state anywhere.
    @ViewBuilder var accessory: () -> Accessory

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: ThreadMetrics { .for(scale, width: column, clearing: clearing) }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: metrics.gap) {
                    ForEach(items) { item in
                        MessageRow(item: item, scale: scale, width: column)
                    }
                    accessory()
                }
                .padding(.bottom, metrics.bottomPadding)
                .frame(width: metrics.width, alignment: .leading)
                // `justify-content: flex-end`, in a scroll view: the content is at least as
                // tall as the viewport and sits at the bottom of it, so slack collects
                // above the first message instead of below the last.
                .frame(minHeight: proxy.size.height, alignment: .bottom)
                // Centres the column in the bled box, so the scroll content is exactly as
                // wide as the scroll view and nothing offers to scroll sideways.
                .frame(width: metrics.clipWidth)
            }
            .defaultScrollAnchor(.bottom)
            // A scroll view clips to its bounds and that is the whole reason this is here:
            // clipping to the column would cut `btn/orb`'s halo down the column's left edge.
            // See `ThreadMetrics.bleed`.
            .frame(width: metrics.clipWidth, height: proxy.size.height)
            // Back to the column for layout. A frame does not clip, so the bleed hangs
            // symmetrically outside this one and every message keeps the x it had.
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(width: metrics.width)
        // No fade here, and that is the change: it used to be this view's last child. Board
        // 03 moves both fades out of the thread — *"absolute — both are children of Tutor
        // chat, not Thread"* — so that they can span the panel corner to corner instead of the
        // 301 column, and so that `Panel controls` can paint over the top one. A thread that
        // masked its own edges could do neither. The surface that owns the thread owns them;
        // it also owns handing this view a band that runs behind its chrome, which is the
        // whole reason there is anything to mask.
    }
}

extension MessageThread where Accessory == EmptyView {
    init(items: [ChatThreadItem], scale: ChatScale = .panel, width: CGFloat? = nil) {
        self.init(items: items, scale: scale, width: width) { EmptyView() }
    }
}

/// One message, placed by author: bare text across the column, or a bubble against the
/// trailing edge.
struct MessageRow: View {
    let item: ChatThreadItem
    var scale: ChatScale = .panel
    /// The column this row spans. The bubble is pinned to its trailing edge, so this is also
    /// what decides where "right" is.
    var width: CGFloat?

    private var metrics: MessageMetrics { .for(scale, width: width ?? scale.contentWidth) }

    /// The chips a sent turn carried — `sentMessage`'s stack rather than the thread's own
    /// column, so it lands on the trailing edge where the student's other sent work already
    /// is. Clamped by the row, which is the only thing that can take the 224 away.
    private var chips: AttachmentStackMetrics { .sentChips(in: metrics.rowWidth) }

    /// The same card with nothing in front of it — a turn that is files and no words.
    private var chipsAlone: AttachmentStackMetrics { .sentChipsAlone(in: metrics.rowWidth) }

    var body: some View {
        switch item.message.role {
        case .learner:
            // Board 14: a marqueed region is an image the learner sent, so it sits
            // on their turn, against the same trailing edge as their bubble and
            // joined to it by `replyGap` rather than the thread's message gap.
            VStack(alignment: .trailing, spacing: BoardViewsMetrics.replyGap) {
                if let selectionView = item.selectionView {
                    BoardViewThumbnail(view: selectionView)
                }
                sentAttachments
            }
            .frame(width: metrics.rowWidth, alignment: .trailing)
        case .tutor, .system:
            // The design has two authors and the domain has three. A system line is the
            // surface talking, not the student, so it takes the tutor's register rather
            // than being dropped — dropping it would hide content the caller chose to add.
            //
            // Board 14: what the tutor looked at sits above what it said, joined to it by
            // the tighter `replyGap` rather than the thread's own `--space-message-gap`,
            // because that gap separates turns and this one joins a turn to itself.
            VStack(alignment: .leading, spacing: BoardViewsMetrics.replyGap) {
                if !item.boardViews.isEmpty {
                    BoardViewsRow(views: item.boardViews, width: metrics.rowWidth)
                }
                TutorMessageText(markdown: item.message.text, metrics: metrics)
            }
            .frame(width: metrics.rowWidth, alignment: .leading)
        }
    }

    /// The chips this turn was sent with, above the words.
    ///
    /// **Screen 08's stack, not the composer's.** By ruling: a sent attachment is part of
    /// the student's turn, so it sits where their sent selection already sits — trailing
    /// edge, 224 wide, the same 58pt bubble in front of it — rather than as a band running
    /// the thread's whole column, which read as the surface talking rather than as something
    /// the student sent. The stack is narrower than the row, and the enclosing
    /// `VStack(alignment: .trailing)` is what puts it on the edge, exactly as it already
    /// does for `SelectionMessageBubble`.
    ///
    /// **Read-only**: `isRemovable: false`, so no ✕ is drawn and the chips give back the
    /// width the control would have taken. `onRemove` and `onDismissSelection` are never
    /// reached; the turn has already gone, which is the distinction
    /// `SelectionAttachment.sent` already makes by taking no `onDismiss`.
    ///
    /// The thumbnails come from `AttachmentStore` by the server's own id, which is why a
    /// session reopened tomorrow still draws the pictures.
    ///
    /// **Undrawn: files with no words.** With no bubble there is nothing for the card's
    /// hidden band to tuck behind, so that branch draws the chips as a self-contained card
    /// instead of as the back layer of a stack — see `AttachmentStackMetrics.sentChipsAlone`,
    /// which is where the reasoning and the caveat live.
    @ViewBuilder
    private var sentAttachments: some View {
        if item.attachments.isEmpty {
            bubble
        } else if item.message.text.isEmpty {
            chipRow(chipsAlone)
                // All four corners, where every other card in the file cuts only its top
                // two. The bottom pair are edges here rather than tucks, and a
                // square-cornered tinted band under a rounded one is the mark of a card
                // that has lost the shape it was meant to sit behind.
                .clipShape(RoundedRectangle(cornerRadius: chipsAlone.bodyTopRadius, style: .circular))
        } else {
            AttachmentStack(metrics: chips) {
                chipRow(chips)
            } content: {
                // The fixed box, not the hugging bubble: the card behind it is sized off
                // that fixed height, which is the same reason `SelectionMessageBubble` uses
                // it. Not `SelectionMessageBubble` itself — that brings its own card, and
                // the chips card is the one this turn draws.
                StackedMessageBubble(text: item.message.text, metrics: metrics)
            }
        }
    }

    /// The chips themselves, in whichever card is holding them.
    private func chipRow(_ card: AttachmentStackMetrics) -> some View {
        AttachmentChipRow(
            attachments: item.attachments.map {
                // A sent attachment is by definition ready; the carried bytes are empty
                // because the store is the source here, not the upload that finished in a
                // draft that no longer exists.
                PendingAttachment(
                    id: $0.id,
                    filename: $0.filename,
                    state: .ready($0, thumbnail: Data())
                )
            },
            showsSelection: false,
            metrics: card,
            thumbnail: { AttachmentStore().thumbnail(for: $0) },
            onRemove: { _ in },
            onDismissSelection: {},
            isRemovable: false
        )
    }

    /// The student's words, pinned right.
    ///
    /// Nothing at all when there are none: a selection — or a file — sent on its own is the
    /// picture and nothing else. The store no longer writes a sentence the learner did not
    /// say (see `TutorStore.evaluate`), and an empty bubble under the thumbnail would be a
    /// mark for words that are deliberately not there — a 50pt violet crumb the eye reads
    /// as a failure.
    @ViewBuilder
    private var bubble: some View {
        if !item.message.text.isEmpty {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                if item.hasSelection {
                    SelectionMessageBubble(text: item.message.text, metrics: metrics)
                } else {
                    MessageBubble(text: item.message.text, metrics: metrics)
                }
            }
        }
    }
}

