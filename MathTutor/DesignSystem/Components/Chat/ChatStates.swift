import SwiftUI

/// The thread's three transient states, from board 14 — the board that closed the gap
/// `03 §11.10` left open (*"No streaming / typing / loading / error / retry affordance
/// exists on this board"*).
///
/// All three are drawn in the tutor's own register: no box, no fill, no colour. Board 14:
/// *"A failure is a tutor message, not a system alert: same 17/25 text, same left edge, no
/// box, no colour."*

// MARK: - Thinking

/// Three dots on one body line box.
///
/// *"The 25 pt height is the whole idea: the indicator occupies exactly one
/// `--leading-body` line box, so replacing it with the first line of the reply causes zero
/// layout shift."* Which is why the row's height is the leading token and not a number.
struct ThinkingIndicator: View {
    /// `6 × 6 · radius-full · NO TOKEN — component-internal`. Smaller than any spacing step
    /// and used nowhere else.
    static let dotSize: CGFloat = 6
    /// *"opacity 0.35 → 1 → 0.35, 1.2s loop, 160ms stagger — spec, not drawn."*
    static let dimmedOpacity: Double = 0.35
    static let cycle: TimeInterval = 1.2
    static let stagger: TimeInterval = 0.16

    /// Board 15, which specified the mark at 740 for the first time: dot 8, gap 12, in the
    /// `--leading-lead` line box the wide column's own text occupies.
    static func dotSize(at scale: ChatScale) -> CGFloat {
        scale == .panel ? dotSize : DS.Space.s2
    }

    static func gap(at scale: ChatScale) -> CGFloat {
        scale == .panel ? DS.Space.s2 : DS.Space.s3
    }

    static func lineBox(at scale: ChatScale) -> CGFloat {
        scale == .panel ? DS.Leading.body : DS.Leading.lead
    }

    /// Variant B's status line. `nil` gives variant A, the bare dots — the default.
    var status: String?
    /// Panel unless said otherwise, which is every call site the thread has.
    var scale: ChatScale = .panel

    @State private var isBright = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.s1) {
            if let status {
                Text(verbatim: status)
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.inkSecondary)
            }
            dots
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status ?? "The tutor is thinking")
    }

    private var dots: some View {
        HStack(spacing: Self.gap(at: scale)) {
            ForEach(0 ..< 3, id: \.self) { index in
                Circle()
                    .fill(DS.Color.icon)
                    .frame(width: Self.dotSize(at: scale), height: Self.dotSize(at: scale))
                    .opacity(isBright ? 1 : Self.dimmedOpacity)
                    .animation(
                        // A 1.2s loop that returns to where it started is two 0.6s halves.
                        .easeInOut(duration: Self.cycle / 2)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * Self.stagger),
                        value: isBright
                    )
            }
        }
        .frame(height: Self.lineBox(at: scale))
        .onAppear { isBright = true }
    }
}

// MARK: - Streaming

/// The bar that trails the text as a reply arrives.
///
/// *"`msg/tutor` exactly — the growing text IS the message."* So there is no streaming
/// message type: a partial reply is a tutor message, and this is the mark that follows its
/// last glyph. The caret is `2 × 22 · radius-full · var(--color-ink)`, where the 22 is
/// `--leading-control` *"optically centred in the 25 line box"* — a derived height, not a
/// free one.
struct StreamingCaret: View {
    /// `NO TOKEN — component-internal`, and the only free value in the mark.
    static let width: CGFloat = 2
    /// *"caret opacity 1 → 0 → 1, 1.06s step — no fade on the text itself."*
    static let cycle: TimeInterval = 1.06

    /// Board 15 specified the caret at 740 for the first time: 2 × 26 in the
    /// `--leading-lead` line box, the same derivation the panel's 2 × 22 in a 25 box is.
    static func height(at scale: ChatScale) -> CGFloat {
        scale == .panel ? DS.Leading.control : 26
    }

    static func lineBox(at scale: ChatScale) -> CGFloat {
        scale == .panel ? DS.Leading.body : DS.Leading.lead
    }

    var scale: ChatScale = .panel

    var body: some View {
        // A step, not a fade, so the phase is read off the clock rather than animated
        // between two opacities — an `.easeInOut` here would be the fade the spec rules out.
        TimelineView(.periodic(from: .now, by: Self.cycle / 2)) { context in
            Capsule()
                .fill(DS.Color.ink)
                .frame(width: Self.width, height: Self.height(at: scale))
                .opacity(Self.isVisible(at: context.date) ? 1 : 0)
        }
        .frame(width: Self.width, height: Self.lineBox(at: scale))
        .accessibilityHidden(true)
    }

    static func isVisible(at date: Date) -> Bool {
        Int(date.timeIntervalSinceReferenceDate / (cycle / 2)).isMultiple(of: 2)
    }
}

// MARK: - Failure & recovery

/// A failure, told as a tutor message with the one action that fixes it.
///
/// Board 14: *"What follows it is a suggestion chip — the component that already means
/// 'this is the thing to tap next' — carrying the one action that fixes it... Under the
/// chip, one line of 15/18 secondary copy says what was NOT lost, because that is the
/// actual question a student has."*
struct ChatErrorMetrics: Equatable, Sendable {
    let scale: ChatScale
    /// The column the failure is told in — the thread's own row, since it *is* a thread child.
    let width: CGFloat
    /// `margin-top: var(--spacing-4)` on the chip.
    let chipTopMargin: CGFloat
    /// `margin-top: var(--spacing-3)` on the reassurance line.
    let reassuranceTopMargin: CGFloat
    let messageStyle: DS.TextStyle
    let reassuranceStyle: DS.TextStyle
    let chip: SuggestionChipMetrics

    /// The failure in a column of `width`, at either scale.
    ///
    /// Board 14 only ever drew the panel, and it drew it as a rule rather than as a size: *"A
    /// failure is a tutor message, not a system alert: same 17/25 text, same left edge, no box,
    /// no colour."* **Same as the messages around it** is the whole specification, so the
    /// message takes `MessageMetrics`' own text style at this scale rather than a second copy
    /// of 17/25 that would stay 17/25 in a thread whose messages had gone to 21/30. Board 13
    /// carried the panel's message spec up to the reading column exactly that way.
    ///
    /// The two margins, the chip and the reassurance line's 15/18 do not step: the board states
    /// one value for each and no second one, and inventing a wide variant of a line the design
    /// never scaled is the thing this port does not do.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        Self(
            scale: scale,
            width: max(0, width),
            chipTopMargin: DS.Space.s4,
            reassuranceTopMargin: DS.Space.s3,
            messageStyle: MessageMetrics.for(scale, width: width).textStyle,
            // 15 / 18 at weight 400 — the same size and line box as the "Selection" label, but
            // this is running copy rather than a label, so it takes the regular weight.
            reassuranceStyle: TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular),
            chip: .for(scale, width: width)
        )
    }

    /// Board 14's own column: the 301pt panel content width it was measured in.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }

    /// `25 + 16 + 62 + 12 + 36 = 151` for the network state's one-line message and two-line
    /// reassurance — the specimen the board measures.
    func height(messageLines: Int, reassuranceLines: Int) -> CGFloat {
        messageStyle.leading * CGFloat(messageLines)
            + chipTopMargin + chip.height
            + reassuranceTopMargin + reassuranceStyle.leading * CGFloat(reassuranceLines)
    }
}

struct ChatErrorState: View {
    /// `state/error · network`, verbatim.
    static let networkMessage = "I couldn't reach the tutor service just now."
    static let networkAction = "Try again"
    static let networkReassurance = "Nothing was lost — what you wrote is still in the composer."

    let message: String
    let actionLabel: String
    /// `ui/retry` for a network failure, `control/settings` for a bad key — *"identical
    /// structure — only the copy and the glyph change."*
    let actionIcon: Icon
    let reassurance: String
    let action: () -> Void

    var metrics: ChatErrorMetrics = .panel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: message)
                .textStyle(metrics.messageStyle)
                .foregroundStyle(DS.Color.ink)
                .frame(width: metrics.width, alignment: .leading)

            SuggestionChip(
                icon: actionIcon,
                label: actionLabel,
                scale: metrics.scale,
                // The chip is laid out in the same column the message is, so the one the
                // metrics measured and the one that is drawn cannot drift apart.
                width: metrics.width,
                // *"a repair is not a suggestion — and the violet budget is spent
                // elsewhere."*
                tint: DS.Color.icon,
                action: action
            )
            .padding(.top, metrics.chipTopMargin)

            Text(verbatim: reassurance)
                .textStyle(metrics.reassuranceStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .frame(width: metrics.width, alignment: .leading)
                .padding(.top, metrics.reassuranceTopMargin)
        }
        .frame(width: metrics.width, alignment: .leading)
    }
}

extension ChatErrorState {
    /// The tutor service could not be reached.
    ///
    /// The column defaults to board 14's own 301 so a specimen still draws what the board
    /// drew; a thread passes the column it is laid out in.
    static func network(onRetry: @escaping () -> Void, metrics: ChatErrorMetrics = .panel) -> Self {
        Self(
            message: networkMessage,
            actionLabel: networkAction,
            actionIcon: .uiRetry,
            reassurance: networkReassurance,
            action: onRetry,
            metrics: metrics
        )
    }
}
