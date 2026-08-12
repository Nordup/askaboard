import CoreGraphics
import SwiftUI

/// The sessions drawer's physics, as arithmetic rather than as a gesture handler.
///
/// Split out of the view for the reason `ResizeModel` is: every number the note under board
/// 18 states — the intent-lock angle, the crossfade band, the fling threshold, the 50% line —
/// is assertable without a host, and a rule that lives inside an `onChanged` closure cannot be
/// regression-tested. The view supplies translations and velocities; this decides what they
/// mean.
///
/// The note, verbatim on the three rules this type encodes:
///
/// - *"The chat pane tracks the finger one-to-one; the drawer eases in behind it with a 12px
///   parallax."*
/// - *"A white veil marks which pane is inactive, and it crosses over during the travel. At
///   rest the drawer carries the veil under the chat. Between 20% and 30% of the travel the
///   two reverse: the drawer clears and the chat takes the veil, fully veiled at open."*
/// - *"On release the drawer settles by velocity, not by position alone: it opens past 50% of
///   the travel, or on a fast fling in either direction below 50%."*
enum DrawerReveal {

    // MARK: - Intent lock

    /// How far the finger travels before the gesture has an axis. The note: *"the first 10–15°
    /// of travel decide the axis"* — the degrees are the angle and this is the distance, which
    /// the note gives as the same 10–15 in points on the artboard. 12 is the middle of it, and
    /// it is also `DragGesture`'s `minimumDistance`, so the first frame the view ever sees is
    /// already past the threshold and no travel is spent undecided.
    ///
    /// **Kept at 12, and the widened cone is why.** The distance was the other suspect for the
    /// rejected swipes, and it is the wrong one: a slow swipe crosses 12 points just as surely
    /// as a fast one, only later. What 12 buys is a decision vector long enough to have a
    /// meaningful angle — at 4 points the ratio is mostly touch-digitiser noise, and widening
    /// the cone on a noisy vector would start stealing the scroller's drags instead. So the
    /// angle moved and the distance did not.
    static let intentThreshold: CGFloat = 12

    /// How far off horizontal a start may be and still commit to the drawer.
    ///
    /// **38°, not the note's 10–15.** The note states the cone as the angle a *deliberate*
    /// sideways swipe stays inside, and on a 13-inch desk that is true. On an iPad 6th
    /// generation held in two hands it is not: a thumb swiping across a 337pt panel travels on
    /// an arc, and at 15° a 100pt swipe was rejected for 27 points of drift — which is less
    /// drift than the thumb's own pivot produces. The reports were all of the same thing, a
    /// swipe that was plainly a swipe doing nothing.
    ///
    /// 38° is dominant-axis (45°) with a modest bias kept for the scroller: a drag has to be
    /// more horizontal than vertical *and then some* before the drawer takes it, so a
    /// mostly-vertical drag still scrolls and the list never feels stolen. The seven degrees
    /// between 38 and 45 are the whole of that bias, and they are what this number is for —
    /// widening to 45 would make every diagonal a coin toss between two behaviours.
    static let intentAngle: CGFloat = 38

    /// Which way a touch went, decided once and never revisited for that touch.
    ///
    /// Three cases, not two. `.undecided` is not "no answer yet" — the first frame always has
    /// one — it is the state before any frame has arrived, and it is what makes the lock a
    /// lock: `axis(for:)` is asked exactly once per touch and the answer is stored, so a drag
    /// that starts sideways and curls downward keeps panning the drawer, and one that starts
    /// down keeps scrolling the thread however far it later wanders across.
    enum Axis: Equatable, Sendable {
        case undecided
        /// The drawer pans; the thread's scroll is suppressed until the finger lifts.
        case horizontal
        /// The thread scrolls; the drawer takes nothing from this touch at all.
        case vertical
    }

    /// The axis a translation commits to.
    ///
    /// Stated as a ratio rather than as an `atan2` because that is what the rule is: a
    /// translation is horizontal when its vertical component is inside the tangent of the
    /// allowed angle. `tan(15°) = 0.268`, so a 100pt sideways drag may drift 27pt down and
    /// still be a drawer pan.
    ///
    /// A translation shorter than `intentThreshold` is `.undecided` and asks again next frame.
    /// That is the live case now: `DrawerPanRecognizer` drives this from raw touches and asks
    /// on every move until the vector is long enough to answer. A caller **must not store** an
    /// `.undecided` answer as this touch's axis; it means "ask me again", and the recogniser
    /// stays `.possible` until it is told something.
    static func axis(for translation: CGSize) -> Axis {
        let dx = abs(translation.width)
        let dy = abs(translation.height)
        guard hypot(dx, dy) >= intentThreshold else { return .undecided }
        return dy <= dx * tan(intentAngle * .pi / 180) ? .horizontal : .vertical
    }

    // MARK: - Travel

    /// Where along the travel a drag has got to, `0` closed and `1` open.
    ///
    /// One-to-one with the finger, which is the note's first rule: the translation is added to
    /// wherever the drawer was when the touch landed, and divided by the travel. Clamped at
    /// both ends rather than allowed to rubber-band — the drawer is inside the panel's own clip
    /// and there is nothing past either end to reveal.
    static func progress(from anchor: CGFloat, translation: CGFloat, travel: CGFloat) -> CGFloat {
        guard travel > 0 else { return anchor }
        return min(1, max(0, anchor + translation / travel))
    }

    /// How fast the finger has to be going for the release to override the halfway line.
    ///
    /// Points per second, and deliberately above a lazy drag: a flick across the 263pt travel
    /// takes about 200ms, which is 1300 pt/s, while the tail of a drag being carefully placed
    /// dies below 100. 300 sits in the empty band between them, so neither a deliberate flick
    /// nor a careful placement is read as the other.
    ///
    /// **Lowered from 400** with the cone, and for the same complaint. An unhurried swipe that
    /// stopped short of halfway — 90 points of the 263, still moving at 350 — sprang back
    /// closed, which reads as the gesture having been missed rather than judged. 300 lets that
    /// one through and still holds the line against a drag that is genuinely being placed.
    static let flingVelocity: CGFloat = 300

    /// Whether the drawer settles open. The note's release rule, in one expression.
    ///
    /// Velocity first, position second — *"by velocity, not by position alone"*. A fast fling
    /// toward the closed edge from 80% of the travel closes, which is what makes the gesture
    /// reversible: the learner who has overshot can throw it back without dragging the whole
    /// way. Below the fling threshold the halfway line decides, and the sign of the velocity is
    /// ignored entirely rather than nudging the boundary.
    static func settlesOpen(progress: CGFloat, velocity: CGFloat) -> Bool {
        if velocity >= flingVelocity { return true }
        if velocity <= -flingVelocity { return false }
        return progress >= 0.5
    }

    /// The settle animation. A spring rather than a curve, and given the release velocity so
    /// the pane keeps the speed it already had instead of restarting from rest.
    ///
    /// `travel` normalises the velocity: `interpolatingSpring` states initial velocity in
    /// fractions of the animated distance per second, and the caller's is in points per second.
    ///
    /// `damping` defaults to the drawer's own 30 and exists for exactly one caller: the
    /// presentation morph's arrival (`PresentationMorph.settle`), which runs the same spring
    /// a notch livelier. One construction, so a stiffness change reaches every settle at once.
    static func settle(velocity: CGFloat, travel: CGFloat, damping: CGFloat = 30) -> Animation {
        .interpolatingSpring(
            stiffness: 320,
            damping: damping,
            initialVelocity: travel > 0 ? Double(velocity / travel) : 0
        )
    }

    // MARK: - The white veil

    /// The veil at rest, and the strongest either pane ever carries — `#FFFFFF8C` on board 17's
    /// pushed-aside chat, which is 140/255.
    static let fullVeil: Double = 0.55

    /// The band the two veils cross over in. Board 18's note: *"Between 20% and 30% of the
    /// travel the two reverse."*
    static let crossfadeStart: CGFloat = 0.20
    static let crossfadeEnd: CGFloat = 0.30

    /// What the chat carries the moment the crossover completes — `#FFFFFF4D` on board 18's
    /// mid-swipe chat, 77/255, measured at 42% of the travel.
    static let crossoverVeil: Double = 0.30

    /// The veil on the **drawer**, which is the pane that is inactive while the chat covers it.
    ///
    /// Full at rest, gone by the end of the crossover band, and nothing after that: past 30% of
    /// the travel the drawer is the pane being reached for and carries no wash at all.
    static func drawerVeil(at progress: CGFloat) -> Double {
        fullVeil * (1 - Double(crossfade(progress)))
    }

    /// The veil on the **chat**, which takes over as the drawer clears.
    ///
    /// Two legs, and the second one is eased rather than linear. The design publishes three
    /// points — 0 below the band, 0.30 at the crossover, 0.55 fully open — and a straight line
    /// through the last two puts 34% on board 18's 42%-travel frame, where the artboard
    /// measures 30%. Squaring the second leg lands it on 30.7%, so all three of the design's
    /// own frames are reproduced instead of two of them. It is also the right shape for what
    /// the veil is saying: the wash arrives with the crossover and then deepens slowly, rather
    /// than climbing at the same rate as the pane slides.
    static func chatVeil(at progress: CGFloat) -> Double {
        let crossed = Double(crossfade(progress))
        let tail = Double(min(1, max(0, (progress - crossfadeEnd) / (1 - crossfadeEnd))))
        return crossoverVeil * crossed + (fullVeil - crossoverVeil) * tail * tail
    }

    /// `0` before the band, `1` after it, smoothstepped across it.
    ///
    /// Smoothstepped rather than linear because this is the one place both veils change at
    /// once: a linear ramp puts a visible corner on each pane at both ends of a 10%-wide band,
    /// and the two corners land on the same two frames, so they read as a flicker rather than
    /// as a crossfade.
    private static func crossfade(_ progress: CGFloat) -> CGFloat {
        let t = min(1, max(0, (progress - crossfadeStart) / (crossfadeEnd - crossfadeStart)))
        return t * t * (3 - 2 * t)
    }

    // MARK: - The sidebar toggle

    /// Where the chat header's `btn/sidebar-toggle` has finished fading out, as a fraction of
    /// the travel. Board 18's note: *"it is fully transparent by 30–40% of the travel, well
    /// before it could reach the fixed minimize and full-screen pair in the dock corner."*
    ///
    /// **0.35, the middle of the band the note gives.** It lives here rather than in the view
    /// for the reason the veil constants do: it is one more curve read off the same travel, and
    /// the two have to be judged together — the toggle is on the pane the chat veil is washing,
    /// so a toggle still visible past the crossover would be a control fading *into* a wash
    /// instead of clearing before it. 0.35 puts the toggle at zero half a crossfade band after
    /// the chat starts taking the veil, which reads as one movement rather than two.
    ///
    /// The arithmetic below is also the whole of what makes the control unreachable: nothing
    /// hit-tests at zero opacity, so the view has one number to read and not two.
    static let toggleFadeEnd: CGFloat = 0.35

    /// The toggle's opacity, `1` closed and `0` from `toggleFadeEnd` on.
    ///
    /// Linear, and deliberately not smoothstepped like the veils. The veils are smoothed because
    /// two of them change at once and a corner on each reads as a flicker; this is one mark
    /// going away, and easing its start would keep it at nearly full strength through the first
    /// tenth of the travel — which is exactly the part of the swipe where the note wants it
    /// already leaving. *"Fades fast"* is the instruction, and a straight ramp is the fastest
    /// honest reading of it.
    static func toggleOpacity(at progress: CGFloat) -> Double {
        guard toggleFadeEnd > 0 else { return progress > 0 ? 0 : 1 }
        return Double(min(1, max(0, 1 - progress / toggleFadeEnd)))
    }

    // MARK: - Parallax, and why there is none

    /// Board 18 gives the drawer *"a 12px parallax"* — it sits 12 points behind its open
    /// position while the chat is still over it, and eases up to 0. **It is not implemented,
    /// and the reason is a property of the two surfaces rather than a disagreement with the
    /// board.**
    ///
    /// The parallax is a pure translation of the whole drawer, padding and all: nothing inside
    /// it resizes, and on the artboard it reads exactly as intended, as a layer sliding up from
    /// underneath. On the device it does not, because board 17 gives the drawer and the panel
    /// the *same fill* — deliberately, so that the seam between the two panes can be the chat's
    /// rounded corner and nothing else. A surface with no visible edge has nothing for the eye
    /// to attach the movement to, so the only reference left is the panel's own edge, and 12
    /// points of content moving away from a fixed edge is indistinguishable from 12 points of
    /// padding growing. That is what it was reported as: the drawer's margins changing while
    /// the pan was in motion.
    ///
    /// So the drawer stays exactly still and only the chat travels. If the design ever gives
    /// the drawer a fill of its own, the parallax becomes legible and is worth restoring; until
    /// then it is an effect that can only be read as a bug.
    ///
    /// The other half of the same report was sub-pixel: both panes are rasterised by a
    /// `compositingGroup` and were then translated by fractional offsets, so every frame
    /// resampled the text a fraction of a pixel differently. `wholePoints(_:)` is that fix.
    static func wholePoints(_ offset: CGFloat) -> CGFloat {
        offset.rounded()
    }

}
