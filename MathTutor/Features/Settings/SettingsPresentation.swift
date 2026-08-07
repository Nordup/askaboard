import SwiftUI

/// What the board does while the settings window is up.
///
/// The redesign's premise is that the board stays visible — *"blur and white background"* —
/// so this is the one presentation in the product that cannot be a `fullScreenCover`. A
/// cover replaces the screen, and there would be nothing left behind the window to whiten.
enum SettingsBackdropMetrics {
    /// **1, from the design's `blur(2px)`.**
    ///
    /// CSS `blur()` is stated as the full width of the Gaussian; SwiftUI's `.blur(radius:)`
    /// is half of it. This is the same halving `Elevation.Layer.shadowRadius` does for
    /// `box-shadow`, and getting it wrong the other way is the more common mistake: a 2
    /// passed straight through reads as twice the defocus the design draws.
    static var blurRadius: CGFloat { designBlur / 2 }
    static let designBlur: CGFloat = 2

    /// `#FFFFFF66` — white at 0x66/255 = 0.4.
    ///
    /// **White, not ink.** A dark scrim is the reflex, and it was the first thing drawn here;
    /// it turned the board and the panel into one grey field and cost the backdrop its
    /// identity. Whitening washes the board out while leaving the rail's pen colours and the
    /// ink legible as *your work, still there*, which is the entire argument for not covering
    /// the screen in the first place.
    static let scrim = DS.Color.surface.opacity(0.4)

    /// How long the board takes to defocus and the window to arrive. Free — the design draws
    /// no motion — so it is the shortest duration that still reads as a transition rather
    /// than a cut.
    static let duration: Double = 0.18
}

extension View {
    /// Puts the settings window over this view, and pushes this view back while it is there.
    ///
    /// Written as a modifier on the screen rather than as a branch inside `BoardScreen` for
    /// one reason: the blur has to apply to *everything* the screen drew — board, rail,
    /// panel, dock — and a branch inside the stack can only reach its own subtree. It also
    /// keeps the board's body the shape it was, which board 09 cares about: *"the outer frame
    /// is identical to screen 05 down to the pixel"*.
    ///
    /// The backdrop is inert while the window is up: it takes the blur, the scrim and a tap
    /// that closes, and `accessibilityHidden` so VoiceOver does not walk a board the student
    /// cannot reach.
    func settingsWindow(isPresented: Binding<Bool>) -> some View {
        modifier(SettingsPresentation(isPresented: isPresented))
    }
}

struct SettingsPresentation: ViewModifier {
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content
            .blur(radius: isPresented ? SettingsBackdropMetrics.blurRadius : 0)
            .accessibilityHidden(isPresented)
            .overlay {
                if isPresented {
                    window.transition(.opacity)
                }
            }
            // Presenting is a state change the student made, so it animates; the board behind
            // it defocusing at the same time is what makes the window read as arriving in
            // front rather than cutting in.
            .animation(.easeOut(duration: SettingsBackdropMetrics.duration), value: isPresented)
    }

    private var window: some View {
        ZStack {
            scrim
            SettingsWindow(onClose: close)
        }
        .ignoresSafeArea()
    }

    /// Tapping outside closes, which is the only dismissal the design draws besides the
    /// close control. There is no drag-to-dismiss: the window is not a sheet and has no
    /// grabber to suggest one.
    private var scrim: some View {
        SettingsBackdropMetrics.scrim
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture(perform: close)
            .accessibilityLabel(SettingsCopy.close)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("settings-scrim")
    }

    private func close() { isPresented = false }
}
