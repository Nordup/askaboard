import SwiftUI

/// Where the session and the presentation are wired together, and the only place that knows
/// about both.
///
/// The port spec keeps them apart on purpose: *"Presentation state is not session data — it
/// should not persist, should not round-trip through JSON, and mixing the two is precisely
/// what grew `WorkspaceView` to 984 lines."* So `UIState` is created here, next to the store
/// rather than inside it, and nothing below this view owns both lifetimes.
///
/// It is also where the screen gets measured. `ScreenLayout` derives every lane from a window
/// size and a set of safe-area insets, and this is the one place both are known — so
/// `MeasuredScreen` is applied here and nowhere else. One measurement, one environment value,
/// every lane cut from the same numbers, because the lanes have to agree with each other.
struct RootView: View {
    @EnvironmentObject private var store: TutorStore

    #if DEBUG
    @StateObject private var uiState = LaunchOptions.current.makeUIState()
    #else
    @StateObject private var uiState = UIState()
    #endif

    var body: some View {
        #if DEBUG
        // The fixture run is the one that must *not* measure — see `FixtureScreen`.
        if LaunchOptions.current.usesFixtureCopy {
            screen.modifier(FixtureScreen())
        } else {
            measuredScreen
        }
        #else
        measuredScreen
        #endif
    }

    /// The shipping root, and the only thing on device.
    ///
    /// **No `.statusBarHidden(true)`.** Board 05 open question 15 asked which branch the
    /// product takes — hide the system band and draw the design's own, or drop the drawn one
    /// and anchor the screen to the safe area — and boards 05 through 08 answer it: every one
    /// of them draws a band with a time, a date and a battery, so the product intends a status
    /// bar to be there. iPadOS is the only thing that can supply a real one, and hiding it
    /// would also zero the top inset, which now puts `contentTop` at `0 + 28 = 28` instead of
    /// `24 + 28 = 52` — the whole interface 24 points high, with no clock.
    ///
    /// The measurement is a `GeometryReader`, not a captured value: it re-evaluates on every
    /// layout pass, so a Split View drag or a rotation republishes the lanes rather than
    /// leaving them at whatever the window was first. That distinction is the entire point of
    /// the exercise, and `ShellComponentTests` resizes a host window to prove it — the board's
    /// own `PKCanvasView` was bitten by exactly the opposite habit of trusting geometry read
    /// too early.
    private var measuredScreen: some View {
        screen.modifier(MeasuredScreen())
    }

    /// The app, minus any decision about where it is being drawn.
    private var screen: some View {
        BoardScreen()
            .environmentObject(uiState)
            // The design has one palette, and four of its surfaces are near-white within 2–4%
            // of each other with no dark mapping (open question 16). A dark render would be
            // an invention, not a port.
            .preferredColorScheme(.light)
            .onAppear(perform: resumeConversationIfNeeded)
            #if DEBUG
            .transaction { transaction in
                if LaunchOptions.current.isFrozen { transaction.animation = nil }
            }
            #endif
    }

    /// A session restored from disk already has a thread, but `UIState` deliberately does not
    /// persist — so the conversation axis is re-derived here rather than stored. Without this
    /// a returning student is shown the greeting over their own conversation.
    private func resumeConversationIfNeeded() {
        #if DEBUG
        // An explicit `--ui-state` is the whole point of the argument; resuming would
        // silently move the screen being diffed.
        guard LaunchOptions.current.screen == nil else { return }
        #endif
        if store.hasGoal { uiState.beginConversation() }
    }
}

/// How the root learns which screen it is on: one reader, one `ScreenLayout`, published to
/// everything below.
///
/// **It is `View.measuringScreenLayout()` and nothing else.** This modifier once carried its
/// own reader because the one in `Layout.swift` gave `.ignoresSafeArea()` to the *reader*,
/// which leaves it with no safe area left to report — `proxy.safeAreaInsets` all zeroes, so
/// `--space-edge` gets measured from the glass and `contentTop` lands at 28 with the system
/// clock sitting on top of the first row of content. That modifier has since been fixed to do
/// what this one did: a plain reader inside the safe area, the window reconstructed by adding
/// the insets back, `.ignoresSafeArea()` given to the content. Two implementations of one
/// measurement is exactly how the two would drift apart again, so there is one, and this is
/// the name the root and `ShellComponentTests` know it by.
struct MeasuredScreen: ViewModifier {
    func body(content: Content) -> some View {
        content.measuringScreenLayout()
    }
}

#if DEBUG
/// Everything a `--ui-fixture` run does differently, in one place.
///
/// That run exists to be diffed against `design/reference/screen-0*.png`, and those were
/// exported from a 1376 × 1032 board whose status region is 40 points tall. **No iPad reports
/// 40** — landscape gives 24 where there is a camera housing and 20 where there is a home
/// button — so measuring the window would lay the fixture out at `24 + 28 = 52` on the very
/// device the boards were drawn for, and every element below the band would sit 16 points
/// above where the PNG has it. The screen is therefore built from `ScreenLayout.reference`,
/// which is constructed from the design's own three numbers, rather than from the window.
///
/// This was always required and the removed 40pt floor was masking half of it: the floor made
/// the *top* come out at 68 on any device by accident, but nothing ever rescued the bottom,
/// where a home indicator costs 20 points the reference screen never spent.
///
/// The band that belongs with those numbers is the app-drawn one, so this turns it on and
/// turns the system's off — exactly one status bar, and it is the one in the reference
/// screenshots. Both halves live inside `#if DEBUG`, which is what makes it impossible for a
/// release build to draw a fake band or hide the real one.
struct FixtureScreen: ViewModifier {
    func body(content: Content) -> some View {
        content
            // The band is placed at an absolute y from the physical top, which is only the
            // same thing as the layout top once the safe area is out of the way.
            .ignoresSafeArea()
            .fixtureStatusBar(isEnabled: true, width: ScreenLayout.reference.screenWidth)
            .environment(\.screenLayout, .reference)
            .statusBarHidden(true)
    }
}
#endif
