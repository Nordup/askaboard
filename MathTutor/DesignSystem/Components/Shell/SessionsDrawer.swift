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

    /// Flush against the leading screen edge and the full height of the screen — not the
    /// content band. It is a lane of the screen rather than a panel on it, so it has no radius,
    /// no shadow and no edge inset of its own; the chat's rounded edge beside it is the whole of
    /// the boundary.
    ///
    /// **296, where board 19 draws 372.** The board's is 20% wider than it needs to be for what
    /// it holds — a wordmark, a section label and a column of one-line titles — and on the
    /// device that width reads as a sidebar that has taken a fifth of the screen to say very
    /// little. 20% off 372 is 297.6; 296 is the nearest value that keeps the frame's own
    /// arithmetic whole, because `--space-edge` is 28 either side and the content column has to
    /// land on an even number: `240 + 2 × 28`.
    ///
    /// 240 is also the docked drawer's 239 to within a point, which is the useful part of the
    /// coincidence: a session title that fits in one drawer fits in the other, so switching
    /// between the two surfaces does not re-truncate the list.
    static let sidebarWidth: CGFloat = sidebarContentWidth + 2 * DS.Space.edge
    static let sidebarContentWidth: CGFloat = 240
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

    /// `row/session`: 44 tall, `--radius-sm`, `padding-inline: 12`.
    ///
    /// **No glyph.** The rows carried an 18pt board mark in a fixed slot, and the design has
    /// taken it out along with the header's orb. What it leaves behind is the alignment that
    /// was the point: with no slot and no gap the title starts on the row's own 12pt inset,
    /// which is exactly where the "AI Tutor" wordmark starts, so the whole drawer reads down
    /// one left edge. It also leaves the row nothing to say but its name, which is all a list
    /// of things that are all the same kind of thing needs.
    static let rowHeight: CGFloat = 44
    static let rowRadius = DS.Radius.sm
    static let rowPaddingInline = DS.Space.s3

    /// 17 / 22, semibold for the open session and medium for the rest — the same two weights
    /// the switcher's rows carried, so a learner who used the dropdown reads the drawer the
    /// same way.
    static func rowTitle(current: Bool) -> TextStyle {
        TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: current ? .semibold : .medium)
    }

    /// How far a finger may travel and still have been a tap on a row.
    ///
    /// The row proves for itself that a swipe was not a tap, rather than trusting anything
    /// outside it to have switched it off in time — see `SessionsDrawer.rowGestures(_:)`. 10 is
    /// `LongPressGesture`'s own `maximumDistance`, so the two halves of the row's gesture agree
    /// about what counts as having moved, and it sits just under the drawer pan's 12: a touch
    /// that goes on to become a pan has already failed this by the time the pan commits.
    static let tapSlop: CGFloat = 10

    /// When the drawer decides a context menu is about to appear.
    ///
    /// **Deliberately shorter than `UIContextMenuInteraction`'s own ~0.5s commit, and the gap
    /// is the whole point.** SwiftUI gives `.contextMenu` no callback for either edge, so the
    /// drawer has to notice the menu for itself, and the only signal available is a press of
    /// its own running against the same touch. Once the interaction takes the touch it cancels
    /// every other recogniser on the view — so a detector set at or after the system's own
    /// threshold would be cancelled *instead of* firing, on exactly the presses that matter.
    ///
    /// Firing early cannot miss a menu. It can raise a false alarm on a slow tap, and the cost
    /// of one is a single swallowed tap afterwards — which is the right way round, because the
    /// bug this exists to stop is cancelling the menu and landing in a different session.
    static let menuDetectDuration: Double = 0.35

    /// How long the drawer keeps swallowing taps after the one that dismissed the menu.
    ///
    /// The menu is still animating away for about a quarter second after the tap that ended
    /// it, and a second tap inside that window is far more likely to be an impatient repeat of
    /// the first than a considered choice of session. See `SessionsDrawer.isMenuGuarding`.
    static let menuDismissGuard: Double = 0.35

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

    /// The row a context menu has just been raised from, and the drawer's only knowledge that
    /// one exists at all.
    ///
    /// **This is the fix for the tap-through, and the reason it has to be inferred.** SwiftUI's
    /// `.contextMenu` is presented and dismissed entirely by the system: there is no callback
    /// for either edge, so whether the tap that cancels it is swallowed or falls through to a
    /// row underneath is the platform's decision. On iPadOS 17 it falls through, and cancelling
    /// switched sessions.
    ///
    /// A `confirmationDialog` the drawer owned outright was tried and rejected: it closed the
    /// leak by replacing the interaction, and the interaction was the part worth keeping. So
    /// the menu is back and the drawer watches for it instead — a press of its own, running
    /// early against the same touch, says a menu is coming (`menuDetectDuration`), and from
    /// then until a tap arrives the drawer swallows taps rather than acting on them.
    ///
    /// Every way this inference can be wrong costs exactly one swallowed tap — a menu that
    /// never appeared, or one dismissed by something that is not a tap — and none of them can
    /// switch a session, which is the failure that matters.
    @State private var menuRow: UUID?

    /// True for a beat after the tap that dismissed the menu, while it animates away.
    @State private var isDismissingMenu = false

    /// Whether the drawer is swallowing taps rather than acting on them.
    private var isMenuGuarding: Bool { menuRow != nil || isDismissingMenu }

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
        // The tap that cancels a context menu is caught here rather than by whatever it landed
        // on. A transparent layer over the whole drawer, mounted only while a menu is believed
        // to be up — for the reason every other dismiss layer in this app is mounted that way:
        // a view that swallows every touch is not something to leave lying around.
        //
        // It covers the rows, the pill and the gear alike, because the stray tap can land on
        // any of them; and it holds for a beat after the tap, because the menu is still
        // animating away. If a future OS swallows the tap itself the guard simply waits for the
        // next one, which costs a tap and never a session.
        .overlay {
            if isMenuGuarding {
                Color.clear
                    .contentShape(.rect)
                    .onTapGesture { endMenuGuard() }
                    .accessibilityHidden(true)
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
            .simultaneousGesture(tapGesture(summary))
            .simultaneousGesture(menuDetector(summary))
            // Board 17's delete, as the system's own menu. It draws the lift, the platter and
            // the destructive styling, and it is what a learner already expects a long press on
            // a list row to do.
            .contextMenu {
                Button(role: .destructive) {
                    endMenuGuard()
                    onDelete(summary.id)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } preview: {
                // **The preview is supplied rather than left to the system, and both faults it
                // was reported for are answered in this one view.** Left to itself the platter
                // lifts a snapshot of the row as it sits in the tree: square, because the row's
                // corners belong to a background whose radius the platter has no way to know,
                // and greyed for any row that is not the current one, because those rows are
                // transparent and the platter's own scrim shows straight through them.
                //
                // An opaque fill under the row answers the second; clipping to the row's own
                // radius answers the first.
                rowLabel(summary, isCurrent: isCurrent)
                    .background(DS.Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: SessionsDrawerMetrics.rowRadius))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(summary.title)
            .accessibilityValue(isCurrent ? "Open" : SessionsDrawer.relativeAge(of: summary.lastSavedAt))
            .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { onOpen(summary.id) }
            // A long press is not a gesture VoiceOver performs, so the destructive action is
            // published as a named one instead.
            .accessibilityAction(named: "Delete") { onDelete(summary.id) }
    }

    /// The tap that dismissed the menu, spent — and the path a chosen `Delete` takes too, so
    /// the guard is never left standing over a drawer whose menu closed by being used.
    private func endMenuGuard() {
        guard menuRow != nil else { return }
        menuRow = nil
        isDismissingMenu = true
        Task {
            try? await Task.sleep(for: .seconds(SessionsDrawerMetrics.menuDismissGuard))
            isDismissingMenu = false
        }
    }

    /// The press that tells the drawer a context menu is on its way — see `menuRow`.
    ///
    /// It raises nothing itself. The system's own interaction draws the menu; this exists only
    /// so the drawer knows one is there, because SwiftUI will not tell it.
    private func menuDetector(_ summary: SessionSummary) -> some Gesture {
        LongPressGesture(minimumDuration: SessionsDrawerMetrics.menuDetectDuration)
            .onEnded { _ in menuRow = summary.id }
    }

    /// The tap that opens the session — **and the proof that it was a tap.**
    ///
    /// A `DragGesture` measuring its own travel rather than a `TapGesture`, and that is the
    /// fix rather than a stylistic choice. A tap recogniser fires on touch-*up* whenever the
    /// touch stayed inside the view, and these rows are 239 × 44, so a 100pt horizontal swipe
    /// starts and ends inside the same one and reads as a tap on it. Every way of switching
    /// that off from outside — hit testing, `isEnabled` — depends on something else having
    /// noticed in time; the translation is evidence the row already holds, so it needs no help
    /// and cannot be raced.
    ///
    /// `minimumDistance: 0` so the gesture exists from touch-down and always reports. A scroll
    /// takes the touch away in the ordinary way and this still ends, with a translation far
    /// past the slop, which is exactly the answer wanted.
    ///
    /// Lifting the finger after a menu has opened does not reach this at all: the context menu
    /// interaction cancels every other recogniser on the row when it takes the touch, and a
    /// cancelled `DragGesture` never ends. The tap that *dismisses* the menu is a separate
    /// touch and never reaches the row either — the guard layer over the drawer has it.
    private func tapGesture(_ summary: SessionSummary) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onEnded { value in
                let travelled = hypot(value.translation.width, value.translation.height)
                guard travelled <= SessionsDrawerMetrics.tapSlop else { return }
                onOpen(summary.id)
            }
    }

    private func rowLabel(_ summary: SessionSummary, isCurrent: Bool) -> some View {
        HStack(spacing: 0) {
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
                //
                // Transparent otherwise, and the context-menu preview is where that costs
                // something — see `row(_:)`, which puts an opaque fill under this one rather
                // than letting the platter's scrim show through.
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
