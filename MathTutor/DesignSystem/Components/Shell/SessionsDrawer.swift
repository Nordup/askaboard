import SwiftUI
import UIKit

/// The sessions drawer's own numbers — boards 17 and 19.
///
/// Two widths and one component. The docked drawer is cut out of the panel and the
/// full-screen sidebar is cut out of the screen, so the frame differs and nothing inside it
/// does: both are a header, a section label, a list of rows and a bottom bar, in a content
/// column derived from the frame exactly the way `TutorPanelMetrics.contentWidth(for:)` derives
/// the panel's. Hard-coding 227 or 240 would be the same bug board 02 names for 301.
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

    /// The docked drawer's padding, board 17: `--space-panel-inset` on all four sides.
    ///
    /// **18 inline, where it was 12.** The inline inset used to be 12 on the argument that the
    /// rows carry their own 12 and the pair should add up to the 24 a row's *text* sits at. That
    /// reasoning measured the wrong edge: what the eye lands on is not the text but the row's
    /// own box — the current session is filled `--color-brand-tint` and `New chat` is a pill —
    /// and those boxes were sitting 12 from a surface whose corner is 28. A fill closer to the
    /// corner than the corner's own radius reads as touching it.
    ///
    /// So both axes are now the panel's own `--space-panel-inset` — one inset for the drawer
    /// rather than one for each edge of it, and the same inset everything else inside this
    /// panel is placed on. The row's 12 stays where it is: it is padding *inside* the box, so
    /// the title lands at 30 and the wordmark and the section label move out with it. The
    /// drawer still reads down one left edge, six points further in, and the content column
    /// follows: `263 − 2 × 18 = 227`.
    static let inset = DS.Space.panelInset
    static let insetInline = DS.Space.panelInset

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
    /// 240 is 13 more than the docked drawer's 227, and the two columns are deliberately not
    /// reconciled: each is its own frame less its own inset, and the sidebar's frame is a lane
    /// of the screen while the drawer's is a fraction of a resizable panel. A title that fills
    /// the sidebar therefore truncates a little sooner in the drawer — as it already did at
    /// every panel width but 337, which is what makes a matched pair a coincidence rather than
    /// a rule.
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

    /// The row's corner, as one shape both the resting fill and the context-menu lift are cut
    /// from.
    ///
    /// **`.continuous`, not the default `.circular`.** The two are the same radius and a
    /// visibly different curve, and until the lift existed it did not matter which this was —
    /// a row's corner had nothing beside it to be compared against. It does now: the platter is
    /// drawn by UIKit, which rounds with a continuous curve throughout, so a circular row
    /// lifting into a continuous plate would shift shape as it rose. One shape, read by both,
    /// is also what stops the two drifting apart the next time the radius is touched.
    static let rowShape = RoundedRectangle(cornerRadius: rowRadius, style: .continuous)

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
    /// A row's context menu appeared (`true`) or finished going away (`false`).
    ///
    /// This is *ground truth*, straight from the `UIContextMenuInteraction` delegate the row's
    /// menu now runs on — see `SessionRowMenu`. The drawer used to infer the menu from a
    /// parallel 0.35s long press of its own and swallow taps behind a drawer-local overlay;
    /// both are gone. The caller wires this to `UIState.setContextMenuActive`, and
    /// `BoardScreen` shields the whole screen on that one flag, because the tap that dismisses
    /// a menu can land far outside this drawer — the pushed-aside chat strip, the composer,
    /// the rail, the board.
    let onMenuActivity: (Bool) -> Void
    let onSettings: () -> Void

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
        // No tap-swallowing overlay here any more. The tap that dismisses a context menu is
        // absorbed by the screen-wide shield in `BoardScreen`, mounted on the same
        // `isContextMenuActive` flag this drawer's rows publish — one mechanism, one place,
        // covering the chat strip and every other surface this drawer never could.
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

    /// One session row: the label, the travel-evidence tap, and the menu — with the menu owned
    /// in UIKit rather than declared to SwiftUI.
    ///
    /// `SessionRowMenu` hosts the row's content and attaches a `UIContextMenuInteraction` of
    /// its own, which is what replaces the 0.35s inference this drawer used to run. SwiftUI's
    /// `.contextMenu` reports neither edge of the menu's life; the interaction's delegate
    /// reports both, so the app *knows* when a menu is up instead of guessing — and the guess's
    /// two failure modes (a starved menu, a tap acting through a menu) go with it. The menu's
    /// contents, the destructive styling and the rounded lift are unchanged: the delegate
    /// mirrors board 17's Delete as a `UIAction` and cuts the platter from the same
    /// `SessionsDrawerMetrics.rowShape` radius the resting fill uses.
    private func row(_ summary: SessionSummary) -> some View {
        let isCurrent = summary.id == currentID
        return SessionRowMenu(
            onDelete: { onDelete(summary.id) },
            onMenuActivity: onMenuActivity
        ) {
            rowLabel(summary, isCurrent: isCurrent)
                .simultaneousGesture(tapGesture(summary))
        }
        .frame(width: contentWidth, height: SessionsDrawerMetrics.rowHeight)
        // `.ignore` rather than `.combine`, because the children are a UIKit hierarchy now:
        // every fact VoiceOver needs is stated here explicitly, exactly as it was before.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary.title)
        .accessibilityValue(isCurrent ? "Open" : SessionsDrawer.relativeAge(of: summary.lastSavedAt))
        .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { onOpen(summary.id) }
        // A long press is not a gesture VoiceOver performs, so the destructive action is
        // published as a named one instead.
        .accessibilityAction(named: "Delete") { onDelete(summary.id) }
    }

    /// The tap that opens the session — **and the proof that it was a tap.**
    ///
    /// A `DragGesture` measuring its own travel rather than a `TapGesture`, and that is the
    /// fix rather than a stylistic choice. A tap recogniser fires on touch-*up* whenever the
    /// touch stayed inside the view, and these rows are 227 × 44, so a 100pt horizontal swipe
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
    /// touch and never reaches the row either — `BoardScreen`'s screen-wide shield has it.
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
            // The same shape the lift is cut from — see `SessionsDrawerMetrics.rowShape`. It
            // has to be, or the row changes curve on its way up.
            SessionsDrawerMetrics.rowShape
                // `--color-brand-tint`, the strongest tint in the system and the one board
                // 01 reserves for marking exactly one item at a time. That is what this row
                // is: the drawer replaces a control that named the open session in words, so
                // the mark has to carry the same fact on its own.
                //
                // Transparent otherwise, and it can stay transparent: the platter fills the
                // declared path with its own background before compositing the row into it, so
                // an untinted row lifts onto a plate rather than onto the dimmed backdrop.
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

// MARK: - The row's menu, owned in UIKit

/// A session row with board 17's context menu, run on a `UIContextMenuInteraction` this type
/// owns — which is what turns "a menu is probably up" into "a menu is up".
///
/// **Why UIKit rather than `.contextMenu`.** SwiftUI's modifier presents and dismisses the
/// menu entirely inside the system and reports neither edge. The drawer's answer to that was
/// an inference — a parallel 0.35s `LongPressGesture` racing the system's ~0.5s commit — and
/// the race was itself a bug: a second long-press recogniser analysing the same touch is one
/// more thing the system interaction has to arbitrate against, and the loser was sometimes
/// the menu. Owning the interaction gives the delegate's `willDisplayMenuFor` /
/// `willEndFor(_:animator:)` as ground truth, and removes the competing recogniser in the
/// same stroke.
///
/// **What a touch on a row now meets, exhaustively:** the interaction's own recognisers
/// (the one long press left on the row), the hosted content's `DragGesture(minimumDistance: 0)`
/// (the travel-evidence tap, which claims nothing and cancels nothing), and the ancestor
/// `DrawerPanRecognizer` (simultaneous with everything, `.possible` under a still finger, and
/// it cancels others only at a 12pt horizontal commit — which a still long press never
/// reaches). Nothing in that set can starve the menu; only a real pan can cancel it, and a
/// real pan should.
///
/// **The lift is the same shape it was.** The platter is `UIPreviewParameters.visiblePath`,
/// cut from `SessionsDrawerMetrics.rowRadius` — the radius the resting fill and the old
/// `.contentShape(.contextMenuPreview, ...)` used — and UIKit fills that path before
/// compositing the row into it, so an untinted row still lifts onto a plate.
///
/// The content is embedded through a `UIHostingController` so the interaction's view *is* the
/// rendered row: the default lift snapshot then shows the row itself, and the row's SwiftUI
/// gesture still runs inside the hosted tree.
private struct SessionRowMenu<Content: View>: UIViewRepresentable {
    /// Board 17's destructive action, verbatim — the caller's semantics are untouched.
    let onDelete: () -> Void
    /// The menu's two edges, as the delegate reports them. `false` is sent only after the
    /// dismissal animation has completed, so the shield mounted on this flag outlives the
    /// animation tail without a timer.
    let onMenuActivity: (Bool) -> Void
    @ViewBuilder let content: Content

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        // `ignoresSafeArea` on the root, or the hosting controller keyboard-avoids a 44pt
        // row that happens to sit near the composer's keyboard.
        let host = UIHostingController(rootView: AnyView(content.ignoresSafeArea()))
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: container.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        context.coordinator.host = host
        container.addInteraction(UIContextMenuInteraction(delegate: context.coordinator))
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.host?.rootView = AnyView(content.ignoresSafeArea())
        context.coordinator.onDelete = onDelete
        context.coordinator.onMenuActivity = onMenuActivity
    }

    /// A row can unmount with its menu still up — deleting the last visible session does
    /// exactly that — and a flag left `true` then would shield the app forever. The system
    /// still calls `willEndFor` in the ordinary cases; this is the backstop, and
    /// `Coordinator.endMenu()` is idempotent so the two cannot double-fire.
    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.endMenu()
    }

    final class Coordinator: NSObject, UIContextMenuInteractionDelegate {
        var host: UIHostingController<AnyView>?
        var onDelete: () -> Void = {}
        var onMenuActivity: (Bool) -> Void = { _ in }
        private var isMenuActive = false

        /// The `false` edge, sent at most once per menu — from `willEndFor`'s animation
        /// completion in the ordinary case, and from `dismantleUIView` when the row leaves
        /// the screen first.
        func endMenu() {
            guard isMenuActive else { return }
            isMenuActive = false
            onMenuActivity(false)
        }

        func contextMenuInteraction(
            _ interaction: UIContextMenuInteraction,
            configurationForMenuAtLocation location: CGPoint
        ) -> UIContextMenuConfiguration? {
            UIContextMenuConfiguration(actionProvider: { [weak self] _ in
                UIMenu(children: [
                    UIAction(
                        title: "Delete",
                        image: UIImage(systemName: "trash"),
                        attributes: .destructive
                    ) { _ in
                        self?.onDelete()
                    }
                ])
            })
        }

        func contextMenuInteraction(
            _ interaction: UIContextMenuInteraction,
            willDisplayMenuFor configuration: UIContextMenuConfiguration,
            animator: UIContextMenuInteractionAnimating?
        ) {
            isMenuActive = true
            onMenuActivity(true)
        }

        func contextMenuInteraction(
            _ interaction: UIContextMenuInteraction,
            willEndFor configuration: UIContextMenuConfiguration,
            animator: UIContextMenuInteractionAnimating?
        ) {
            guard isMenuActive else { return }
            isMenuActive = false
            // The shield holds through the dismissal animation because *this* is where the
            // flag drops — the animator's own completion, not a guessed quarter-second.
            if let animator {
                animator.addCompletion { [onMenuActivity] in onMenuActivity(false) }
            } else {
                onMenuActivity(false)
            }
        }

        func contextMenuInteraction(
            _ interaction: UIContextMenuInteraction,
            previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
        ) -> UITargetedPreview? {
            targetedPreview(for: interaction)
        }

        func contextMenuInteraction(
            _ interaction: UIContextMenuInteraction,
            previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
        ) -> UITargetedPreview? {
            targetedPreview(for: interaction)
        }

        /// The lift and the drop-back, cut from the row's own shape. `nil` when the view has
        /// left the window — the delegate is asked during dismissal too, and a deleted row
        /// has no window to be lifted in; `nil` hands UIKit its default rather than crashing
        /// `UITargetedPreview` on a viewless target.
        private func targetedPreview(for interaction: UIContextMenuInteraction) -> UITargetedPreview? {
            guard let view = interaction.view, view.window != nil else { return nil }
            let parameters = UIPreviewParameters()
            parameters.visiblePath = UIBezierPath(
                roundedRect: view.bounds,
                cornerRadius: SessionsDrawerMetrics.rowRadius
            )
            return UITargetedPreview(view: view, parameters: parameters)
        }
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
        onMenuActivity: { _ in },
        onSettings: {}
    )
    .background(DS.Color.surfacePanel)
}
#endif
