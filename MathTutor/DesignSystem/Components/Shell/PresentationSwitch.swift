import SwiftUI

/// The docked ↔ full-screen presentation switch — screens 05/08 ↔ screen 07.
///
/// **This is a switch, not a morph.** The tracked container morph (elements that travel,
/// a finger-scrubbed box) was built, shipped to the device and rejected by the user:
/// *"no travel at all, scratch that."* The full design and its arithmetic are in git
/// history (see `docs/design-system/02-shell-components.md` §15.4) and in the 2026-08-12
/// research brief. What replaced it is the shipped commit-triggered transition with a
/// small amount of polish: the incoming surface fades in over a short directional slide,
/// the outgoing fades out with the matching drift, and the board and rail crossfade in
/// place. Nothing flies across the screen and nothing scales.
///
/// The two transitions are one system with the travel direction: entering full screen
/// the content's home moves toward the trailing edge, so the reading column arrives
/// drifting that way and the panel leaves the same way; returning, both run the mirror.
/// Because each surface always enters and leaves on its own side of that line, one
/// symmetric transition per surface states both legs.
///
/// Like every settle in the shell, the spring is `DrawerReveal.settle`'s construction —
/// one definition, so a stiffness change reaches every gesture at once — and the release
/// rule for the edge swipes is `DrawerReveal.settlesOpen`, applied at the destination by
/// the commit-triggered pattern the sidebar's own swipe uses.
enum PresentationSwitch {

    /// How far the surfaces drift while they fade — short enough to read as a settle
    /// rather than a travel. The board's own motion between the two states is zero; only
    /// the tutor surface drifts.
    static let slideDistance: CGFloat = 32

    /// The reading column's transition. It rests trailing-ward of the panel, so its side
    /// of the travel line is the leading one: it is inserted from `-slideDistance`
    /// (arriving trailing-ward — the enter leg's direction) and removed toward
    /// `-slideDistance` (leaving leading-ward — the return leg's direction).
    static var fullScreenSurface: AnyTransition {
        .offset(x: -slideDistance).combined(with: .opacity)
    }

    /// The docked panel's (and dock's) transition — the mirror: inserted from
    /// `+slideDistance` on the return leg, removed toward it on the enter leg.
    static var dockedSurface: AnyTransition {
        .offset(x: slideDistance).combined(with: .opacity)
    }

    /// The switch's spring: the shared construction, at the drawer's own damping. The
    /// release velocity of the swipe that asked for the switch is carried in, normalised
    /// by the same travel every dock settle uses, so a hard flick arrives faster than a
    /// tap — the one thing a commit-triggered transition still takes from the finger.
    static func settle(velocity: CGFloat, travel: CGFloat) -> Animation {
        DrawerReveal.settle(velocity: velocity, travel: travel)
    }
}
