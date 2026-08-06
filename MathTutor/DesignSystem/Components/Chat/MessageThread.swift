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

    var id: UUID { message.id }

    init(_ message: TutorMessage, hasSelection: Bool = false) {
        self.message = message
        self.hasSelection = hasSelection
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
    /// *"clears `--space-panel-inset`"*. The only inset the thread has — leading, trailing
    /// and top are all 0, because the panel applies its own 18 and the fade takes no space.
    let bottomPadding: CGFloat
    let fade: ScrollFadeMetrics
    /// What the fade has to ramp. It is the surface *behind* the thread, not a colour of
    /// the thread's own — the fade bleeding a different white over the messages is the one
    /// failure the board warns about by name.
    let surface: Color

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
    /// *"unchanged from panel scale"* — differing in two properties, both of which are
    /// consequences of *where* the thread is rather than how wide: it carries no bottom
    /// padding, because the 18 exists to clear the panel's own inset and full-screen there is
    /// no panel; and it fades to a different white.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        switch scale {
        case .panel:
            return Self(
                width: max(0, width),
                gap: DS.Space.messageGap,
                bottomPadding: DS.Space.panelInset,
                fade: .standard,
                surface: DS.Color.surfacePanel
            )
        case .fullScreen:
            return Self(
                width: max(0, width),
                gap: DS.Space.messageGap,
                bottomPadding: 0,
                fade: .standard,
                // *"Same component, different white."* The full-screen background is
                // `--color-surface`, not the panel grey, and a fade of the wrong white
                // bleeds — which is the failure the board warns about, now with two whites to
                // keep straight.
                surface: DS.Color.surface
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
    /// `btn/orb`, the thread's one non-message child. It belongs to the shell, so the
    /// thread reserves its place rather than drawing it — and the place matters: *"`btn/orb`
    /// is a normal flow child at the end of the message list, so it rides up and down with
    /// the conversation rather than being pinned to the panel."* It is also where a
    /// "tutor is thinking" state would go; the design draws no such state anywhere.
    @ViewBuilder var accessory: () -> Accessory

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: ThreadMetrics { .for(scale, width: column) }

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
            }
            .defaultScrollAnchor(.bottom)
        }
        .frame(width: metrics.width)
        // *"`Scroll fade` is the very last child and absolutely positioned, so it paints
        // over every message but sits below `Panel controls`, which are a sibling of
        // `Thread` rather than inside it."* An overlay is exactly that: over this view's
        // content, under whatever the panel draws around it.
        .overlay(alignment: .top) {
            ScrollFade(width: metrics.width, metrics: metrics.fade, color: metrics.surface)
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

    private var metrics: MessageMetrics { .for(scale, width: width ?? scale.contentWidth) }

    var body: some View {
        switch item.message.role {
        case .learner:
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                if item.hasSelection {
                    SelectionMessageBubble(text: item.message.text, metrics: metrics)
                } else {
                    MessageBubble(text: item.message.text, metrics: metrics)
                }
            }
            .frame(width: metrics.rowWidth, alignment: .trailing)
        case .tutor, .system:
            // The design has two authors and the domain has three. A system line is the
            // surface talking, not the student, so it takes the tutor's register rather
            // than being dropped — dropping it would hide content the caller chose to add.
            TutorMessageText(markdown: item.message.text, metrics: metrics)
                .frame(width: metrics.rowWidth, alignment: .leading)
        }
    }
}

