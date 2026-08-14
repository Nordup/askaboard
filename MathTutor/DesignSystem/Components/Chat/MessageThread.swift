import SwiftUI
import UIKit

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
    /// The region the learner marqueed and sent with this message, if any. Drawn
    /// above their bubble — see `MessageRow`.
    let selectionView: BoardView?

    var id: UUID { message.id }

    init(
        _ message: TutorMessage,
        hasSelection: Bool = false,
        attachments: [MessageAttachment] = [],
        selectionView: BoardView? = nil
    ) {
        self.message = message
        self.hasSelection = hasSelection
        self.attachments = attachments
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
    /// Leading and trailing are still 0 — the panel applies its own 18. The bottom is the one
    /// that grew: the thread now runs the panel's full height, so this has to hold the newest
    /// message off the composer as well as off the floor, or the message the student just
    /// sent lands behind the pill.
    let bottomPadding: CGFloat
    /// What sits above the **first** message when the thread is scrolled all the way back.
    ///
    /// The thread still starts at the surface's own edge and its history still dissolves
    /// through the chrome on its way out — that is what the fades are for. But the fade is
    /// for text *in motion*; the first message of the conversation is a rest state, and with
    /// no padding it rested wherever the frame began: inside the panel's fade, half washed
    /// out under the controls, and in the reading column jammed into the screen's top corner.
    /// So the content carries air above its first child — the whole top fade's band in the
    /// panel, so the message settles just clear of the dissolve, and the content band's 28 in
    /// the reading column, where there is no fade and the band is the rule everything else
    /// on the screen follows.
    let topPadding: CGFloat
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

    /// What the column occupies: the top padding, every child, every gap between them, and
    /// the bottom padding. On the board's ten children in the panel this is
    /// 80 + 589 + 198 + 18 = 885.
    func contentHeight(childHeights: [CGFloat]) -> CGFloat {
        guard !childHeights.isEmpty else { return topPadding + bottomPadding }
        return topPadding + childHeights.reduce(0, +)
            + gap * CGFloat(childHeights.count - 1) + bottomPadding
    }

    /// Where each child lands in a thread of `height`, bottom-anchored.
    ///
    /// *"Because `justify-content: flex-end`, all slack lands at the top (5pt here)."*
    /// Slack is clamped at 0 so an overflowing thread starts at its own top padding and
    /// scrolls, rather than being pulled up off its own first message.
    func offsets(childHeights: [CGFloat], in height: CGFloat) -> [CGFloat] {
        var y = topPadding + max(0, height - contentHeight(childHeights: childHeights))
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
                // The whole top fade — plateau and ramp — so a thread scrolled to its very
                // beginning rests its first message just below the dissolve instead of
                // half-washed inside it. See `topPadding`.
                topPadding: ScrollFadeMetrics.top(for: .panel).height,
                bleed: bleed
            )
        case .fullScreen:
            return Self(
                width: max(0, width),
                gap: DS.Space.messageGap,
                bottomPadding: max(0, band),
                // No fade over the head of this thread (boards 07 and 13), so the air is the
                // content band's own 28 — the line everything else on the screen starts at.
                topPadding: DS.Space.edge,
                bleed: bleed
            )
        }
    }

    /// The design's own two columns: screen 08's 301 and board 13's 740.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

// MARK: - The scroll container

/// The one scroll container every chat fill runs in — the thread and both start states.
///
/// It exists so those fills cannot drift apart. The thread, the panel's start state and the
/// reading column's start state are the same surface in three fills, and each used to carry
/// its own scroller with its own defaults — which is how one of them grew a visible
/// indicator and another clipped its content at a hard edge mid-screen. What they share is
/// stated once here:
///
/// - **Indicators are never shown.** The fades are the scroll affordance on these surfaces.
/// - **The clip is the column plus the bleed**, never the bare column. The orb halos and the
///   chips' `shadow/card` are the content's visible bounds; the column is only its layout
///   slot, and a container that clips to the slot cuts them off down a hard vertical line.
///   See `ThreadMetrics.bleed`.
/// - **The rest position is offset zero, in both modes.** The panel's start chain anchors
///   top and rests on its own head. The thread reads bottom-anchored — `justify-content:
///   flex-end`, the newest message on the composer — but gets there by inversion rather
///   than by a bottom anchor: see `Anchor.newestFirst`. There is deliberately no
///   `defaultScrollAnchor` here any more; an anchored rest position over lazily estimated
///   content is a search, and the search is what used to come up empty.
/// - **It bounces only when it scrolls.** A fill that fits its band is stationary, so a drag
///   cannot pull it past its own clip and show the edge.
/// - **No `scrollDisabled` of its own, deliberately.** Board 18's intent lock suspends this
///   scroller while a drawer pan owns the touch, from `DrawerRevealLayer` through the
///   environment — an explicit write here would override it and put the lock back.
///
/// The container is the *band*, full height, not the content's own region: whoever mounts it
/// frames it from the surface's top edge to the content floor and lets the content carry its
/// clearances as padding. That is what makes an overflowing fill scroll off the surface's own
/// edge — under a fade or past the screen — instead of clipping at a line the eye can find.
struct ChatScrollColumn<Content: View>: View {
    /// Which way the band reads, and what offset zero means in it.
    enum Anchor {
        /// Content anchored on the band's head; the rest position shows it. The start fills.
        case top
        /// The inverted chat scroller. The scroll view is flipped vertically, so the
        /// content's layout top renders at the visual bottom: the caller lays its children
        /// **newest-first** and counter-flips each one back upright. Offset zero — a
        /// scroller's natural rest, no anchor needed — *is* the newest content, and the rows
        /// a lazy stack builds first are exactly the rows that rest position shows.
        ///
        /// This replaced a `.bottom` cell that anchored an upright, oldest-first thread with
        /// `defaultScrollAnchor(.bottom)`. That rest position is a *search*: the scroller
        /// has to find the content's bottom across heights a lazy stack has only estimated,
        /// and on iOS 17 the anchored window could land on rows the stack never built — a
        /// mounted thread showing nothing at all until a drag forced realization, which is
        /// the intermittent white chat this type is documented against. Inversion removes
        /// the search rather than winning the race: nothing about offset zero depends on an
        /// estimate.
        ///
        /// The flip wraps the SwiftUI scroll view from outside, so everything mechanical —
        /// offsets, insets, laziness windows, the frames a test reads — stays in plain
        /// unflipped layout space. Only the rendering and the touch mapping are mirrored,
        /// and the caller's counter-flip squares the rendering.
        case newestFirst
    }

    /// The column the content is laid out in.
    let width: CGFloat
    /// How far the clip sits outside the column on each side. A bleed, not a wider column:
    /// no content moves, and nothing but glow and shadow is drawn in it.
    var bleed: CGFloat = ThreadMetrics.bleed
    /// Stated by every caller. A default hid the last architecture's `.bottom` in plain
    /// sight; which way a band reads is the one thing its owner must say.
    let anchor: Anchor
    @ViewBuilder var content: () -> Content

    /// The box the scroller clips to: the column plus the bleed on both sides.
    private var clipWidth: CGFloat { width + 2 * bleed }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                content()
                    .frame(width: width, alignment: .leading)
                    // The content is at least as tall as the band and sits at its layout
                    // top. For `.top` that is the anchored end itself. For `.newestFirst`
                    // the flip renders layout-top at the visual bottom, so a short thread
                    // still sits on the composer and slack still collects at the visual
                    // top — `justify-content: flex-end` as a consequence of the flip, not
                    // of an anchor.
                    .frame(minHeight: proxy.size.height, alignment: .top)
                    // Centres the column in the bled box, so the scroll content is exactly
                    // as wide as the scroll view and nothing offers to scroll sideways.
                    .frame(width: clipWidth)
            }
            .scrollBounceBehavior(.basedOnSize)
            // The inversion itself — see `Anchor.newestFirst`. Applied to the scroll view,
            // not inside it, so the scroller's own machinery never sees the flip.
            .scaleEffect(x: 1, y: anchor == .newestFirst ? -1 : 1)
            // A scroll view clips to its bounds, and that is the whole reason this frame is
            // here: clipping to the column would cut the halos and shadows down their edges.
            .frame(width: clipWidth, height: proxy.size.height)
            // Back to the column for layout. A frame does not clip, so the bleed hangs
            // symmetrically outside this one and the content keeps the x it had.
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(width: width)
    }
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
    /// A `view_board` step's rendered crop, by the id `BoardCropStore` filed it under —
    /// handed to every tutor row's `ActivityTrailView` rather than resolved here, because
    /// this file has no store of its own to resolve it from (see `ChatThreadItem`'s own doc
    /// comment on why a crop's bytes never travel as data on the item). Defaulted so a
    /// gallery specimen or a preview thread, which draws no trail, needs no argument for it.
    var crop: (UUID) -> Data? = { _ in nil }
    /// The long-press menu's Edit on a learner bubble, handed the message's id. `nil` — the
    /// default, and what every preview and gallery specimen takes — draws the menu with Copy
    /// alone: Copy is the row's own business, but an edit rewrites the conversation, and only
    /// a surface wired to the store can honour that.
    var onEditMessage: ((UUID) -> Void)? = nil
    /// `btn/orb`, the thread's one non-message child. It belongs to the shell, so the
    /// thread reserves its place rather than drawing it — and the place matters: *"`btn/orb`
    /// is a normal flow child at the end of the message list, so it rides up and down with
    /// the conversation rather than being pinned to the panel."* It is also where a
    /// "tutor is thinking" state would go; the design draws no such state anywhere.
    @ViewBuilder var accessory: () -> Accessory

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: ThreadMetrics { .for(scale, width: column, clearing: clearing) }

    var body: some View {
        // `justify-content: flex-end`, the bleed clip and the hidden indicators are all
        // the container's — see `ChatScrollColumn`, which the start states run in too.
        // `.newestFirst` is the inverted chat scroller; everything below builds its
        // content newest-first and counter-flipped, which is that mode's contract.
        ChatScrollColumn(width: metrics.width, bleed: metrics.bleed, anchor: .newestFirst) {
            threadContent
        }
        // No fade here, and that is the change: it used to be this view's last child. Board
        // 03 moves both fades out of the thread — *"absolute — both are children of Tutor
        // chat, not Thread"* — so that they can span the panel corner to corner instead of the
        // 301 column, and so that `Panel controls` can paint over the top one. A thread that
        // masked its own edges could do neither. The surface that owns the thread owns them;
        // it also owns handing this view a band that runs behind its chrome, which is the
        // whole reason there is anything to mask.
    }

    /// The list itself — laid out newest-first inside the inverted scroller.
    ///
    /// The scroller is flipped (`ChatScrollColumn.Anchor.newestFirst`), so layout-top is the
    /// visual bottom: the newest message is the first row, the rest position — offset zero,
    /// no anchor, no estimate — shows it, and the lazy stack realizes from the newest
    /// *backwards*. History is built only when the learner scrolls for it, which is what
    /// keeps a long session scrolling on an iPad: every row here carries a SwiftUI hosting
    /// bridge per formula, and a stack that materializes them all keeps every formula-backed
    /// `MTMathUILabel` alive and re-measured on layout passes while offscreen. It is also
    /// what makes the white mount structurally impossible — the rows the lazy stack builds
    /// first are the rows the rest position shows, on every mount, whatever the history's
    /// heights turn out to be.
    ///
    /// Each row is counter-flipped individually. It must be the row and not a group: a row
    /// has to stay a direct child of the lazy stack to be lazily realized, and a single flip
    /// per direct child is what puts every glyph upright while the reversed `ForEach` sets
    /// the reading order.
    private var threadContent: some View {
        LazyVStack(alignment: .leading, spacing: metrics.gap) {
            accessoryBlock
            ForEach(items.reversed()) { item in
                MessageRow(
                    item: item, scale: scale, width: column, crop: crop,
                    onEditMessage: onEditMessage
                )
                .scaleEffect(x: 1, y: -1)
            }
        }
        // The metrics keep their visual meaning; the flip decides which layout edge carries
        // them. `bottomPadding` clears the composer at the visual bottom — layout top here —
        // and `topPadding` is the air above the oldest message at the visual top, which is
        // the layout bottom.
        .padding(.top, metrics.bottomPadding)
        .padding(.bottom, metrics.topPadding)
    }

    /// The accessory, counter-flipped as one block.
    ///
    /// One flip for the group rather than one per child: a group flipped once inside a
    /// flipped scroller is mirrored twice, so its children keep exactly the order and
    /// orientation the design states — plan, then failure, then the thinking line, the orb
    /// at the tail — while the block as a whole sits at layout top, which is the visual
    /// bottom, where the tail of the conversation lives. Flipping each child instead would
    /// read them back to the learner in reverse.
    ///
    /// The `EmptyView` gate keeps a specimen thread's geometry honest. A wrapped-empty
    /// accessory would still be a zero-height child of the lazy stack, and the stack would
    /// spend a message gap on each side of it — 22 stray points between the newest message
    /// and the composer clearance. The app itself never takes the gate: its accessory always
    /// ends in the thread orb, which is presence, never absent.
    @ViewBuilder
    private var accessoryBlock: some View {
        if Accessory.self != EmptyView.self {
            VStack(alignment: .leading, spacing: metrics.gap) {
                accessory()
            }
            .scaleEffect(x: 1, y: -1)
        }
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
    /// A `view_board` step's rendered crop, by the id `BoardCropStore` filed it under. See
    /// `MessageThread`'s own property of the same name — this is threaded straight through
    /// from there, one closure rather than one resolved per row, because a closed trail
    /// never needs to read the store at all.
    var crop: (UUID) -> Data? = { _ in nil }
    /// See `MessageThread`'s property of the same name — threaded straight through.
    var onEditMessage: ((UUID) -> Void)? = nil

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
            // Board 14 §04: what the tutor did sits above what it said, joined to it by
            // the tighter `replyGap` rather than the thread's own `--space-message-gap`,
            // because that gap separates turns and this one joins a turn to itself. Read
            // straight off `item.message.activity` — the trail is carried on the message
            // itself and persists with it, unlike a photo of a board region a moment ago,
            // so every tutor message in history draws its own trail here, not only the
            // most recent one.
            VStack(alignment: .leading, spacing: BoardViewsMetrics.replyGap) {
                if let activity = item.message.activity, !activity.isEmpty {
                    ActivityTrailView(trail: activity, width: metrics.rowWidth, crop: crop)
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
                    // Copy only, for the selection bubble's reason: the files went
                    // with these words, and words alone cannot resend the turn.
                    .contextMenu { menuItems(canEdit: false) }
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
                    // Copy only: a turn that pointed at the board cannot be resent
                    // faithfully as words alone, so Edit is not offered on it.
                    SelectionMessageBubble(text: item.message.text, metrics: metrics)
                        .contextMenu { menuItems(canEdit: false) }
                } else {
                    MessageBubble(text: item.message.text, metrics: metrics)
                        // The lift takes the bubble's own rounded shape rather than
                        // its bounding rect — without this the press shows square
                        // corners around a rounded bubble.
                        .contentShape(
                            .contextMenuPreview,
                            RoundedRectangle(cornerRadius: metrics.bubbleRadius, style: .circular)
                        )
                        .contextMenu { menuItems(canEdit: true) }
                }
            }
        }
    }

    /// The long-press menu on the learner's own words — the one place in the thread the
    /// student can act on something already sent.
    ///
    /// Copy is self-contained: the text is right here, and the pasteboard needs nothing
    /// from the feature layer. Edit is the wired action — it rewrites the conversation, so
    /// it exists only where a surface passed `onEditMessage`, and only on a plain text turn
    /// (`canEdit`): a turn that carried files or a board region cannot be resent as words
    /// alone, and offering an Edit that silently dropped the picture would be the kind of
    /// quiet downgrade `BoardScreen.send` is built to refuse.
    @ViewBuilder
    private func menuItems(canEdit: Bool) -> some View {
        Button {
            UIPasteboard.general.string = item.message.text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }
        if canEdit, item.attachments.isEmpty, let onEditMessage {
            Button {
                onEditMessage(item.message.id)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
        }
    }
}

