import SwiftUI

/// The sessions drawer's own numbers — boards 17 and 19.
///
/// Two widths and one component. The docked drawer is cut out of the panel and the
/// full-screen sidebar is cut out of the screen, so the frame differs and nothing inside it
/// does: both are a header, a section label, a list of rows and a bottom bar, in a content
/// column derived from the frame exactly the way `TutorPanelMetrics.contentWidth(for:)` derives
/// the panel's. Hard-coding 239 or 316 would be the same bug board 02 names for 301.
enum SessionsDrawerMetrics {

    // MARK: - The docked drawer, inside the panel (board 17)

    /// How much of the panel the drawer takes when it is open: `263 ÷ 337`.
    ///
    /// A fraction rather than the artboard's 263, because the panel is resizable and the drawer
    /// is drawn *inside* it. A stored 263 in a panel dragged to 1000 leaves a 737pt chat strip
    /// where the design leaves 74, and in one dragged to 260 it leaves −3.
    static let revealFraction: CGFloat = 0.78

    /// `337 × 0.78 = 262.86 → 263`. Rounded to the point so the strip beside it is a whole
    /// number too: the two are complements and a half-point in one is a seam in the other.
    static func width(inPanel panelWidth: CGFloat) -> CGFloat {
        max(0, (panelWidth * revealFraction).rounded())
    }

    /// `337 − 263 = 74` — what is left of the panel for the pushed-aside chat.
    static func stripWidth(inPanel panelWidth: CGFloat) -> CGFloat {
        max(0, panelWidth - width(inPanel: panelWidth))
    }

    /// The docked drawer's padding, board 17: `padding-block: 18; padding-inline: 12`.
    ///
    /// The block inset is the panel's own `--space-panel-inset`, so the drawer's header sits on
    /// the same line as the controls row it replaced; the inline inset is 12, not 18, because
    /// the rows carry their own 12 of padding and the design lets the two add up to the 24 a
    /// row's text sits at rather than to 30.
    static let inset = DS.Space.panelInset
    static let insetInline = DS.Space.s3

    /// The corner the pushed chat turns toward the drawer — board 17's `--radius-2xl` on the
    /// leading two corners only. Not the panel's own 28: the panel's radius is against the
    /// screen and this one is against another surface 0 points away, which is a tighter
    /// relationship and the design draws it tighter.
    static let stripCornerRadius = DS.Radius.xxl

    // MARK: - The full-screen sidebar (board 19)

    /// Board 19's `372`, flush against the leading screen edge and the full height of the
    /// screen — not the content band. It is a lane of the screen rather than a panel on it, so
    /// it has no radius, no shadow and no edge inset of its own; the chat's rounded edge beside
    /// it is the whole of the boundary.
    ///
    /// `316 + 2 × 28`: the content column is what the design draws and the frame is that column
    /// plus `--space-edge` either side, which is the rule every surface against a screen edge
    /// follows.
    static let sidebarWidth: CGFloat = sidebarContentWidth + 2 * DS.Space.edge
    static let sidebarContentWidth: CGFloat = 316
    static let sidebarInset = DS.Space.edge

    /// The corner the full-screen chat turns toward the sidebar — board 19's `--radius-3xl`,
    /// the panel's own radius. It is the panel's radius because the pane is now the same kind
    /// of thing the panel is: a surface on the screen grey. The docked strip's is tighter (see
    /// `stripCornerRadius`) because there the two surfaces touch.
    static let chatCornerRadius = DS.Radius.xxxl

    /// The content column, from whichever frame this drawer is in.
    static func contentWidth(for width: CGFloat, inset: CGFloat) -> CGFloat {
        max(0, width - 2 * inset)
    }

    // MARK: - Header

    /// `Drawer header`: 44 tall, `padding-left: 12`, `padding-right: 8`.
    static let headerHeight: CGFloat = 44
    static let headerPaddingLeading = DS.Space.s3
    static let headerPaddingTrailing = DS.Space.s2

    /// **No mark beside the wordmark.** Board 17 drew a 30 × 24 halo-less orb here and the
    /// design has since taken it out. The header keeps its 44pt height and its 12pt leading
    /// inset, so the wordmark lands on the same line the rows' titles do and the drawer opens
    /// on one left edge rather than two. A second orb was also the product's fifth, three
    /// hundred points from the one at the tail of the thread.
    ///
    /// 17 / 22 semibold at `--tracking-tight` — the wordmark, alone.
    static let wordmark = TextStyle(
        size: DS.Size.body,
        leading: DS.Leading.control,
        weight: .semibold,
        tracking: DS.Tracking.tight
    )

    // MARK: - Section label

    /// `Label · Recent`: `margin-top: 26`, `padding-left: 12`.
    static let sectionLabelTopGap: CGFloat = 26

    /// 15 / 18 semibold at `--tracking-wide`, uppercase, `--color-ink-tertiary`.
    ///
    /// The first all-caps label in the product, and the reason `DS.Tracking.wide` stopped being
    /// documentation-only: at 15pt with no letter-spacing an uppercase word reads as a
    /// mis-typed proper noun rather than as a section head.
    static let sectionLabel = TextStyle(
        size: DS.Size.label,
        leading: DS.Leading.label,
        weight: .semibold,
        tracking: DS.Tracking.wide
    )

    // MARK: - Session rows

    /// `Session list`: `margin-top: 10`, `gap: 2`.
    static let listTopGap: CGFloat = 10
    static let rowGap: CGFloat = 2

    /// `row/session`: 44 tall, `--radius-sm`, `padding-inline: 12`, `gap: 10`, an 18pt glyph.
    static let rowHeight: CGFloat = 44
    static let rowRadius = DS.Radius.sm
    static let rowPaddingInline = DS.Space.s3
    static let rowGlyphGap: CGFloat = 10
    static let rowGlyph: CGFloat = 18

    /// 17 / 22, semibold for the open session and medium for the rest — the same two weights
    /// the switcher's rows carried, so a learner who used the dropdown reads the drawer the
    /// same way.
    static func rowTitle(current: Bool) -> TextStyle {
        TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: current ? .semibold : .medium)
    }

    /// How long a press on a row has to be held before it offers to delete it.
    ///
    /// `UIContextMenuInteraction`'s own delay, matched deliberately: this replaced a
    /// `.contextMenu` and a learner who had already found the gesture should not have to
    /// re-learn its timing. `LongPressGesture` cancels itself past 10 points of travel, which
    /// sits just under the drawer pan's own 12 — so a swipe never becomes a press, and a press
    /// that turns into a swipe is cancelled by the pan before it commits.
    static let deletePressDuration: Double = 0.5

    /// How long the rows stay inert after the delete prompt's binding clears.
    ///
    /// The prompt is modal and consumes its own dismiss tap, so this is insurance rather than
    /// the mechanism — but the binding clears when the dismissal *starts*, not when it ends,
    /// and UIKit takes about a quarter second to animate a popover away. For that quarter
    /// second the rows would be live again underneath a presentation the learner can still
    /// see. See `SessionsDrawer.isDeletePromptShowing`.
    static let deleteDismissGuard: Double = 0.35

    /// How many rows the drawer shows.
    ///
    /// Board 17 draws five in a list 228 tall, and the drawer's band is 976 — so unlike the
    /// dropdown this is not a frame the list has to fit inside, and the number is a choice
    /// rather than a constraint. Eight, which is the design's five plus room to grow, and still
    /// short of the 19 the band would hold: a drawer that fills to the bottom bar has no visible
    /// end, and the list has no scroller yet. See `docs/TODO.md`.
    static let visibleRows = 8

    // MARK: - Bottom bar

    /// `Drawer bottom bar`: 44 tall, on the content column, `justify-content: space-between`,
    /// one inset up from the drawer's floor.
    static let bottomBarHeight: CGFloat = 44

    /// `btn/new-chat`: a 44pt brand pill, `gap: 8`, `padding-left: 16`, `padding-right: 20` —
    /// the trailing padding is the larger one because the leading side already carries the
    /// glyph's own optical margin.
    static let newChatGap = DS.Space.s2
    static let newChatPaddingLeading = DS.Space.s4
    static let newChatPaddingTrailing = DS.Space.s5
    static let newChatGlyph: CGFloat = 20

    /// The pill's own glow — `#6051DC33 0 4 12`, plus the contact layer 03 · Control already
    /// states.
    ///
    /// **The one shadow in the product that is not `--color-shadow`**, which board 01 says
    /// there are none of. It is not an oversight in the board and not one here either: every
    /// other shadow separates a near-white surface from a near-white surface, and this one sits
    /// under the only saturated fill in the product, where a neutral grey reads as dirt against
    /// the violet. Carried at the call site rather than added to `Elevation`, so the scale keeps
    /// saying what it says and the exception stays visible where it is taken.
    static let newChatGlowAlpha: Double = 0.2
    static let newChatGlowBlur: CGFloat = 12
    static let newChatGlowY: CGFloat = 4

    /// `btn/settings`: a 44pt white circle with a 24pt gear. Already at the tap-target
    /// minimum, so unlike the panel's 32pt controls it needs no expansion.
    static let settingsButton: CGFloat = 44
    static let settingsGlyph: CGFloat = 24
}

/// `Sessions drawer` — boards 17 and 19.
///
/// One component at two frames. It is the whole of the sessions UI now: board 15a's header
/// dropdown is gone, and with it the session title in `Panel controls`, so this is also the
/// only place the open session is named. The gear came with it — settings is a destination
/// reached from the place you manage sessions, not a control on a chat panel — which is what
/// empties the docked header down to the layout pair.
///
/// It draws no surface of its own in the docked case: it is painted straight onto the panel's
/// `--color-surface-panel`, and board 17 gives it the same fill precisely so the seam between
/// the drawer and the chat over it is the chat's rounded corner and nothing else. In the
/// full-screen case it sits on the screen's own `--color-surface-screen` and the fill is
/// likewise the ground's. So the fill is the caller's, and this view paints only its contents.
struct SessionsDrawer: View {
    let sessions: [SessionSummary]
    let currentID: UUID
    /// The frame this drawer is drawn in — the panel-derived 263, or the screen's 372.
    let width: CGFloat
    /// The frame's own inset. 12 docked, `--space-edge` full-screen.
    let inset: CGFloat
    /// The band the drawer occupies — the panel's content height, or the screen's.
    let height: CGFloat
    let onNewChat: () -> Void
    let onOpen: (UUID) -> Void
    /// The destructive action on a row's context menu. It is the caller's because deleting the
    /// *open* session has to decide what to open next, and that is the store's question rather
    /// than this view's — see `TutorStore.deleteSession(id:)`.
    let onDelete: (UUID) -> Void
    let onSettings: () -> Void

    /// The row whose delete has been asked for, and the presentation's own binding.
    ///
    /// **This is the fix for the tap-through, and it is the binding that is the fix.** The
    /// gesture used to raise a `.contextMenu`, which is presented and dismissed entirely by the
    /// system: there is no callback for either edge, so there is no moment at which this view
    /// could have made anything inert, and whether the dismiss tap was swallowed or passed
    /// through to the row underneath was the platform's decision and not ours. On iPadOS 17 it
    /// passed through, and cancelling the menu switched sessions.
    ///
    /// A `confirmationDialog` driven by state we own is the same gesture and the same
    /// destructive action with that decision taken back. It is a modal presentation, so the
    /// tap that dismisses it is consumed by its own presentation controller and cannot reach a
    /// row by construction — and because the binding is ours, the rows can also be held inert
    /// across the dismissal, which the system menu gave us no way to do.
    ///
    /// It also gains a confirmation the context menu never had, which a destructive action with
    /// no undo should have wanted anyway.
    @State private var pendingDelete: SessionSummary?

    /// True through the prompt's dismissal animation, after `pendingDelete` has already gone.
    @State private var isDismissingDelete = false

    /// Whether anything is on screen that the rows must not be reachable underneath.
    private var isDeletePromptShowing: Bool { pendingDelete != nil || isDismissingDelete }

    private var contentWidth: CGFloat {
        SessionsDrawerMetrics.contentWidth(for: width, inset: inset)
    }

    /// The most recent, plus the open session if it is not among them.
    ///
    /// The same rule the dropdown had and for the same reason: rows are ordered by when a
    /// session was last written and the open one gets no special place, so a learner who
    /// reopens an old session can watch it fall past the window. A list that omits the session
    /// you are in is worse than one row too long.
    private var rows: [SessionSummary] {
        let visible = Array(sessions.prefix(SessionsDrawerMetrics.visibleRows))
        guard !visible.contains(where: { $0.id == currentID }),
              let current = sessions.first(where: { $0.id == currentID })
        else { return visible }
        return visible + [current]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            sectionLabel
                .padding(.top, SessionsDrawerMetrics.sectionLabelTopGap)
            list
                .padding(.top, SessionsDrawerMetrics.listTopGap)
            Spacer(minLength: 0)
            bottomBar
        }
        .frame(width: contentWidth, alignment: .leading)
        .padding(.horizontal, inset)
        .padding(.vertical, SessionsDrawerMetrics.inset)
        .frame(width: width, height: height, alignment: .top)
        // Nothing in the drawer is reachable while the prompt is up or on its way out — the
        // same one modifier the pan uses, for the same reason. See `isDeletePromptShowing`.
        .inertToTouches(isDeletePromptShowing)
        .confirmationDialog(
            "Delete this session?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { summary in
            Button("Delete", role: .destructive) { onDelete(summary.id) }
            Button("Cancel", role: .cancel) {}
        } message: { summary in
            Text("\u{201C}\(summary.title)\u{201D} and the board that goes with it are deleted for good.")
        }
        // The binding clears when the dismissal begins; the presentation is still on screen
        // for a moment after that. Holding the guard across it is what makes "cancel only
        // cancels" true for the whole of the interaction rather than most of it.
        .onChange(of: pendingDelete) { previous, current in
            guard previous != nil, current == nil else { return }
            isDismissingDelete = true
            Task {
                try? await Task.sleep(for: .seconds(SessionsDrawerMetrics.deleteDismissGuard))
                isDismissingDelete = false
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sessions")
    }

    /// The wordmark, on the rows' own left edge.
    ///
    /// Still a 44pt band with the design's insets, so nothing below it moves for the mark that
    /// left — see `SessionsDrawerMetrics`. `headerGap` has nothing left to separate and is gone
    /// with it.
    private var header: some View {
        HStack(spacing: 0) {
            Text("AI Tutor")
                .textStyle(SessionsDrawerMetrics.wordmark)
                .foregroundStyle(DS.Color.ink)
            Spacer(minLength: 0)
        }
        .padding(.leading, SessionsDrawerMetrics.headerPaddingLeading)
        .padding(.trailing, SessionsDrawerMetrics.headerPaddingTrailing)
        .frame(height: SessionsDrawerMetrics.headerHeight)
    }

    private var sectionLabel: some View {
        Text("Recent")
            .textStyle(SessionsDrawerMetrics.sectionLabel)
            .textCase(.uppercase)
            .foregroundStyle(DS.Color.inkTertiary)
            .padding(.leading, SessionsDrawerMetrics.rowPaddingInline)
            .accessibilityAddTraits(.isHeader)
    }

    /// Scrolled rather than clipped once the list outgrows the band it has.
    ///
    /// The same answer the tool rail and the full-screen greeting already give: every designed
    /// value survives, every row stays reachable, and nothing new is drawn. `ViewThatFits` so
    /// the unscrolled candidate — which is the design, and which is what a learner with a
    /// handful of sessions always sees — has no scroll view in the tree at all.
    private var list: some View {
        let rows = VStack(alignment: .leading, spacing: SessionsDrawerMetrics.rowGap) {
            ForEach(self.rows) { row($0) }
        }
        return ViewThatFits(in: .vertical) {
            rows
            // No `scrollDisabled` of its own: the intent lock suspends this scroller from
            // `DrawerRevealLayer` through the environment, and an explicit write here would
            // override it. See `MessageThread`, which had the same flag taken off it.
            ScrollView(.vertical, showsIndicators: false) { rows }
                .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func row(_ summary: SessionSummary) -> some View {
        let isCurrent = summary.id == currentID
        return rowLabel(summary, isCurrent: isCurrent)
            // A tap opens; a half-second hold offers to delete. `ExclusiveGesture` and not two
            // simultaneous ones: the long press wins outright when it recognises, so lifting
            // the finger after a hold cannot also fire the tap. That was the second half of
            // this bug — a `Button` with a menu attached runs its own action on touch-up
            // regardless of what the hold did.
            //
            // This is a plain view with gestures rather than a `Button` because a `Button`'s
            // action is exactly the thing that must not fire, and `.plain` styling draws no
            // pressed state, so nothing is lost by not being one. The button *semantics* are
            // restored below where they belong, in the accessibility layer.
            .gesture(
                ExclusiveGesture(
                    LongPressGesture(minimumDuration: SessionsDrawerMetrics.deletePressDuration)
                        .onEnded { _ in pendingDelete = summary },
                    TapGesture().onEnded { onOpen(summary.id) }
                )
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel(summary.title)
            .accessibilityValue(isCurrent ? "Open" : SessionsDrawer.relativeAge(of: summary.lastSavedAt))
            .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { onOpen(summary.id) }
            // The hold is not a gesture VoiceOver can perform, so the destructive action is
            // published as a named one instead — and it goes straight through rather than
            // raising the prompt, because a rotor action is already deliberate.
            .accessibilityAction(named: "Delete") { onDelete(summary.id) }
    }

    private func rowLabel(_ summary: SessionSummary, isCurrent: Bool) -> some View {
        HStack(spacing: SessionsDrawerMetrics.rowGlyphGap) {
            IconView(
                .uiSession,
                size: SessionsDrawerMetrics.rowGlyph,
                tint: isCurrent ? DS.Color.brand : DS.Color.inkTertiary
            )
            Text(summary.title)
                .textStyle(SessionsDrawerMetrics.rowTitle(current: isCurrent))
                .foregroundStyle(isCurrent ? DS.Color.brand : DS.Color.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, SessionsDrawerMetrics.rowPaddingInline)
        .frame(width: contentWidth, height: SessionsDrawerMetrics.rowHeight, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: SessionsDrawerMetrics.rowRadius)
                // `--color-brand-tint`, the strongest tint in the system and the one board
                // 01 reserves for marking exactly one item at a time. That is what this row
                // is: the drawer replaces a control that named the open session in words, so
                // the mark has to carry the same fact on its own.
                .fill(isCurrent ? DS.Color.brandTint : Color.clear)
        )
        .contentShape(.rect)
    }

    private var bottomBar: some View {
        HStack(spacing: 0) {
            newChatButton
            Spacer(minLength: 0)
            settingsButton
        }
        .frame(width: contentWidth, height: SessionsDrawerMetrics.bottomBarHeight)
    }

    private var newChatButton: some View {
        Button(action: onNewChat) {
            HStack(spacing: SessionsDrawerMetrics.newChatGap) {
                IconView(.uiPlus, size: SessionsDrawerMetrics.newChatGlyph, tint: DS.Color.surface)
                Text("New chat")
                    .textStyle(SessionsDrawerMetrics.rowTitle(current: true))
                    .foregroundStyle(DS.Color.surface)
                    .fixedSize()
            }
            .padding(.leading, SessionsDrawerMetrics.newChatPaddingLeading)
            .padding(.trailing, SessionsDrawerMetrics.newChatPaddingTrailing)
            .frame(height: SessionsDrawerMetrics.bottomBarHeight)
            .background(Capsule().fill(DS.Color.brand))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // See `SessionsDrawerMetrics.newChatGlowAlpha` — the product's one non-neutral shadow.
        .shadow(
            color: DS.Color.brand.opacity(SessionsDrawerMetrics.newChatGlowAlpha),
            radius: SessionsDrawerMetrics.newChatGlowBlur / 2,
            y: SessionsDrawerMetrics.newChatGlowY
        )
        .shadow(
            color: Elevation.controlContact.color,
            radius: Elevation.controlContact.shadowRadius,
            y: Elevation.controlContact.y
        )
        .accessibilityLabel("New chat")
    }

    private var settingsButton: some View {
        Button(action: onSettings) {
            IconView(.controlSettings, size: SessionsDrawerMetrics.settingsGlyph)
                .frame(
                    width: SessionsDrawerMetrics.settingsButton,
                    height: SessionsDrawerMetrics.settingsButton
                )
                .background(Circle().fill(DS.Color.surface))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .elevation(.control)
        .accessibilityLabel("Tutor settings")
    }

    /// How long ago a session was last written, in the drawer's own words.
    ///
    /// Moved here whole when board 15a's `SessionMenu` was deleted. The drawer's rows show no
    /// meta column — board 17 draws a glyph and a title and nothing else — but the fact is
    /// still the only thing that distinguishes two sessions with the same title, so it survives
    /// as the row's accessibility value. Hand-rolled rather than
    /// `RelativeDateTimeFormatter` because the strings were written for a 78pt lane: the
    /// formatter says "1 hour ago" where this says "1h ago", and "Yesterday" is worth spelling
    /// out because a learner reads it as a different kind of fact than a count of hours.
    static func relativeAge(of date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        // A clock that moved backwards, or a session saved in the same instant it is being
        // drawn. Neither is worth a negative age.
        guard seconds >= 60 else { return "Now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        if calendar.isDateInToday(date) { return "\(minutes / 60)h ago" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

#if DEBUG
#Preview("Sessions drawer · docked") {
    let current = UUID()
    let now = Date.now
    return SessionsDrawer(
        sessions: [
            SessionSummary(id: current, title: "Vectors in 2D", lastSavedAt: now, messageCount: 8),
            SessionSummary(id: UUID(), title: "Radical equations", lastSavedAt: now.addingTimeInterval(-7_200), messageCount: 14),
            SessionSummary(id: UUID(), title: "Trig identities", lastSavedAt: now.addingTimeInterval(-93_600), messageCount: 6),
            SessionSummary(id: UUID(), title: "Quadratics", lastSavedAt: now.addingTimeInterval(-300_000), messageCount: 21),
            SessionSummary(id: UUID(), title: "Fractions review", lastSavedAt: now.addingTimeInterval(-900_000), messageCount: 4),
        ],
        currentID: current,
        width: SessionsDrawerMetrics.width(inPanel: TutorPanelMetrics.width),
        inset: SessionsDrawerMetrics.insetInline,
        height: 976,
        onNewChat: {},
        onOpen: { _ in },
        onDelete: { _ in },
        onSettings: {}
    )
    .background(DS.Color.surfacePanel)
}
#endif
