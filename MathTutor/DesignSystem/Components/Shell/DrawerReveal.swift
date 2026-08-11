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
    static let intentThreshold: CGFloat = 12

    /// How far off horizontal a start may be and still commit to the drawer. The note's
    /// *"within 10–15°"*, taken at its upper bound: below 15° a deliberate sideways swipe on a
    /// tall list is regularly rejected, because a finger crossing a 337pt panel drifts.
    static let intentAngle: CGFloat = 15

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
    /// That case does not arise from `DragGesture(minimumDistance: intentThreshold)`, which is
    /// how the view drives it; it exists so a caller that drives this from raw touches — a
    /// `UIPanGestureRecognizer`, a test — gets the same answer and not a coin toss on the
    /// first pixel.
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
    /// Points per second, and deliberately well above a lazy drag: a flick across the 263pt
    /// travel takes about 200ms, which is 1300 pt/s, while the tail of an ordinary slow drag
    /// dies below 100. 400 sits in the empty band between them, so neither a deliberate flick
    /// nor a careful placement is ever read as the other.
    static let flingVelocity: CGFloat = 400

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
    static func settle(velocity: CGFloat, travel: CGFloat) -> Animation {
        .interpolatingSpring(
            stiffness: 320,
            damping: 30,
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

    // MARK: - Parallax

    /// How far the drawer sits behind its open position while the chat is still over it —
    /// board 18's *"a 12px parallax"*.
    static let parallax: CGFloat = 12

    /// The drawer's own x within the panel: `−12` closed, `0` open.
    ///
    /// Linear in the progress, which is a reading of *"eases in behind it"* rather than a
    /// transcription of it — board 18 draws the drawer at −12 at 42% of the travel, where this
    /// puts it at −7. The artboard is a single frame of a continuous motion and the offset it
    /// measures is 5 points on a 263pt slide; a curve fitted to that one frame would be a
    /// guess with more parameters than evidence. Stated as the simple rule, so what ships is
    /// legible rather than merely close.
    static func drawerOffset(at progress: CGFloat) -> CGFloat {
        -parallax * (1 - progress)
    }
}
