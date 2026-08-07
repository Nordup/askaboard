#if DEBUG
import Foundation

/// The launch arguments that put the app into one designed state so a screenshot can be
/// diffed against the board it came from.
///
/// Compiled out of release builds for the same reason `E2ESeedFixture` is: this exists to
/// make one comparison reproducible, not to ship a second way of driving the app.
///
/// The port spec states why the copy matters as much as the state: *"Using anything else
/// makes a pixel diff meaningless, because a different line break moves every element below
/// it."* So `--ui-fixture` carries the boards' own strings rather than whatever the session
/// happens to hold.
struct LaunchOptions: Sendable {
    static let stateArgument = "--ui-state"
    static let fixtureArgument = "--ui-fixture"
    static let freezeArgument = "--ui-freeze"
    /// `--ui-window 1024x768` — the window `BoardScreen` must lay itself out in.
    static let windowArgument = "--ui-window"

    /// The four values `--ui-state` takes, each named for the board it reproduces.
    enum Screen: String, CaseIterable, Sendable {
        /// Board 05 — docked panel, greeting, and a selection already attached.
        case dockedStart = "docked-start"
        /// Board 06 — the 132 × 64 dock and a 1224pt board.
        case collapsed
        /// Board 07 — the 740pt column on white.
        case fullScreenStart = "fullscreen-start"
        /// Board 08 — docked panel with the thread.
        case dockedActive = "docked-active"
    }

    let screen: Screen?
    let usesFixtureCopy: Bool
    /// Disables animation and the orb's idle motion so a screenshot is stable.
    let isFrozen: Bool

    /// The window the screen must draw itself in, whatever window it was actually given.
    ///
    /// The bug this whole layout change exists to fix is a 1376pt layout on a 1024pt iPad, and
    /// a UI test cannot reproduce it by resizing: iPadOS has no public API for setting a
    /// window's size, driving Split View through SpringBoard is the flakiest thing in a suite
    /// that already retries dropped taps, and the suite is pinned to one simulator. So the test
    /// states the window instead — `--ui-window 1024x768` — and asserts every lane lands inside
    /// it. Nothing else in the app reads this, and the whole file is `#if DEBUG`.
    let window: CGSize?

    static let current = LaunchOptions(arguments: ProcessInfo.processInfo.arguments)

    init(arguments: [String]) {
        screen = Self.value(after: Self.stateArgument, in: arguments).flatMap(Screen.init(rawValue:))
        usesFixtureCopy = arguments.contains(Self.fixtureArgument)
        isFrozen = arguments.contains(Self.freezeArgument)
        window = Self.value(after: Self.windowArgument, in: arguments).flatMap(Self.size(from:))
    }

    /// `1024x768`. Anything else is ignored rather than defaulted, so a typo shows up as the
    /// test measuring the real window and failing loudly, not as a silent second geometry.
    private static func size(from value: String) -> CGSize? {
        let parts = value.split(separator: "x")
        guard parts.count == 2, let width = Double(parts[0]), let height = Double(parts[1]),
              width > 0, height > 0
        else { return nil }
        return CGSize(width: width, height: height)
    }

    /// `05-screens.md`'s own state triples, so `--ui-state` reproduces the whole board and
    /// not just its two axes: screen 05 is `(.docked, .start, .attached)` and screen 08 is
    /// `(.docked, .active, .none)` — the attachment is part of what the board draws.
    @MainActor
    func makeUIState() -> UIState {
        switch screen {
        case .dockedStart:
            UIState(presentation: .docked, conversation: .start, isSelectionAttached: true)
        case .collapsed:
            UIState(presentation: .collapsed, conversation: .start)
        case .fullScreenStart:
            UIState(presentation: .fullScreen, conversation: .start)
        case .dockedActive:
            UIState(presentation: .docked, conversation: .active)
        case nil:
            UIState()
        }
    }

    /// Screen 08's thread, verbatim, or `nil` when the session's own messages should show.
    ///
    /// Nine messages, not ten: the board's tenth child is `btn/orb`, which the thread now
    /// draws at its tail in every state rather than only mid-turn, so the fixture has nothing
    /// left to say about it.
    var fixtureThread: [ChatThreadItem]? {
        usesFixtureCopy ? Self.screen08Thread : nil
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }

    /// The nine messages `05-screens.md` transcribes for screen 08, in order, with the
    /// selection on the eighth — the only child that is not a plain message.
    private static let screen08Thread: [ChatThreadItem] = [
        ChatThreadItem(TutorMessage(role: .tutor, text: "Welcome back — let's pick up where we left off with vectors.")),
        ChatThreadItem(TutorMessage(role: .learner, text: "ok")),
        ChatThreadItem(TutorMessage(role: .tutor, text: "Draw a pair of axes and one arrow from the origin, then I'll take a look.")),
        ChatThreadItem(TutorMessage(role: .learner, text: "done")),
        ChatThreadItem(TutorMessage(role: .tutor, text: "Great start! 🎉 A vector in 2D has two components — x and y.")),
        ChatThreadItem(TutorMessage(role: .learner, text: "why does the arrow start at 0?")),
        ChatThreadItem(TutorMessage(role: .tutor, text: "It doesn't have to. Starting at the origin is just standard position — slide it anywhere and it's the same vector.")),
        ChatThreadItem(TutorMessage(role: .learner, text: "is my (x, y) label right?"), hasSelection: true),
        ChatThreadItem(TutorMessage(role: .tutor, text: "Yes — that point is the head of the vector, so (x, y) are exactly its components.")),
    ]
}
#endif
