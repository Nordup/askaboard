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
    /// **No `.statusBarHidden(true)`, and the app is not full-screen.** iPadOS keeps its status
    /// bar, so `safeAreaTop` is whatever the device reserves — 24 in landscape with a camera
    /// housing — and `contentTop` is `24 + 28 = 52` there.
    ///
    /// The boards were redrawn with no status bar and every panel at `y = 28`, which is the
    /// same rule with a zero in it rather than a different rule: `--space-edge` from the
    /// nearest obstruction, and the boards have no obstruction to measure from. Hiding the
    /// system bar would make the device agree with them to the point, and that is a product
    /// decision about whether this app takes the screen over — not something a layout port gets
    /// to make. It has not been taken, so the drawing is 24 points ahead of the device and the
    /// arithmetic is what they share. `ScreenLayout.reference` is the boards' number; a
    /// measured screen is the device's.
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
/// That run exists to be diffed against `design/reference/screen-0*.png`, which are exported
/// from the 1376 × 1032 boards. Those boards reserve nothing at the top, and neither does the
/// shipping app, so `ScreenLayout.reference` and a real 13" iPad now agree — this modifier no
/// longer has to substitute a different set of numbers to make the diff line up.
///
/// What it still does is refuse to *measure*. A simulator running at some other size, or in
/// Split View, would otherwise lay the fixture out at that size and the diff would compare two
/// different screens. Pinning the environment to `.reference` is the whole job.
///
/// It draws no status bar. There was once an app-drawn band here, kept because the reference
/// PNGs had been exported with one; the boards dropped it, so the fixture did too. Hiding the
/// system bar is no longer this modifier's business either — the shipping root does it, and
/// doing it in both places would hide which one the device actually obeys.
struct FixtureScreen: ViewModifier {
    func body(content: Content) -> some View {
        content
            .ignoresSafeArea()
            .environment(\.screenLayout, .reference)
            .statusBarHidden(true)
    }
}
#endif
