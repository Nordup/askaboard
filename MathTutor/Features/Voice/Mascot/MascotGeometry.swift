import CoreGraphics
import SwiftUI

/// The voice mascot's geometry, straight off the Paper boards.
///
/// Three boards draw it:
/// - board 28 "Voice · live · docked" — the 72pt face above the panel composer,
/// - board 29 "Voice · live · full screen" — the 120pt hero in the reading column,
/// - note/27 "Voice · mascot states" — the five states, drawn once at a 48pt reference face.
///
/// The per-size numbers (face box, eye row, halo boxes) are each live board's own. The
/// per-state numbers (halo scale and alphas, pulse ring, orbiting dot, ripple rings, eye
/// changes) come from note/27 and scale by `stateScale = faceWidth / 48`. The boards agree
/// exactly where they overlap: note/27's Ø6 eyes on 22pt centres × 1.5 are board 28's
/// Ø9 on 33, and × 2.5 are board 29's Ø15 on 55 — so the one reference sheet really is
/// the same mascot at a smaller size, and the scale rule is the design's own.
enum MascotVariant: String, CaseIterable, Sendable {
    /// Board 28: the docked panel, 72pt face.
    case panel
    /// Board 29: full screen, 120pt face.
    case fullScreen
    /// The collapsed dock's orb slot during a live call. No board draws this one — the
    /// decision is "the live mascot at the dock's existing orb size, nothing else" — so
    /// every number is `OrbSize.dock`'s own, promoted into the mascot's registration
    /// system rather than scaled off a board. See `metrics` for the derivations.
    case dock
}

/// Which stop list the core (the opaque lavender centre) uses. The two live boards draw it
/// two different ways and both are kept verbatim rather than averaged.
enum MascotCoreStops: Sendable {
    /// Board 28's separate inner layer: full at 0, 70 % at 55 %, gone at 100 %.
    case inner
    /// Board 29 folds the core into the one halo layer with the `Orb` hero's own stops:
    /// full to 58 %, half at 80 %, gone at 100 % (`OrbPalette.coreStops`).
    case hero
}

/// The core layer: an elliptical gradient in its own box, registered to the face centre.
struct MascotCoreSpec: Equatable, Sendable {
    let box: CGSize
    /// The box centre relative to the face centre.
    let centreOffset: CGSize
    /// The gradient ellipse's semi-axes as fractions of the box.
    let radiusFraction: CGSize
    /// The gradient centre as a fraction of the box.
    let centreFraction: CGPoint
    let stops: MascotCoreStops
    /// Board 28 paints the core as a later sibling (above the blooms); board 29's CSS list
    /// puts it underneath. Kept per-board rather than unified.
    let paintsAboveBlooms: Bool
}

struct MascotMetrics: Equatable, Sendable {
    /// The black capsule face. 72×56 on board 28, 120×94 on board 29 — each board's own
    /// aspect, so this is stored, never derived from the 48×38 reference.
    let face: CGSize
    /// The eye row's centre line, measured from the face's top edge. Derived the same way
    /// as `OrbMetrics`: CSS `padding-top` with the eyes centred in what is left.
    /// Board 28: 7 + (56 − 7 − 9)/2 + 9/2 = 31.5. Board 29: 12 + (94 − 12 − 15)/2 + 15/2 = 53.
    let eyeCentreY: CGFloat
    /// The two-bloom halo layer's box (board 28: 240×228; board 29: 422×400).
    let bloomBox: CGSize
    /// The bloom box centre relative to the face centre. Both boards float the halo a few
    /// points high: −6 on board 28, −9 on board 29.
    let bloomCentreOffset: CGSize
    let core: MascotCoreSpec
    /// note/27's reference face is 48pt wide; every state accent scales by this.
    var stateScale: CGFloat { face.width / MascotSpec.referenceFaceWidth }
    /// The square Canvas that contains every drawn extreme: the talking halo
    /// (bloom × 1.154, plus the breath and the ending exhale) and the widest ripple
    /// (Ø148.1 × stateScale). The layout slot stays face-sized; the Canvas overdraws it
    /// the way `OrbHalo` overdraws the orb's frame.
    let canvasSide: CGFloat
}

extension MascotVariant {
    var metrics: MascotMetrics {
        switch self {
        case .panel:
            // Board 28 "Orb · live" (301×120 slot): face 72×56 centred; blooms 240×228 at
            // (30, −60) → centre (150, 54) against the face centre (150.5, 60). The half
            // point of x is the odd 301pt container's parity, not a design offset, so the
            // registration is (0, −6). Core 150×143 at (75, −18) → (0, −6.5).
            MascotMetrics(
                face: CGSize(width: 72, height: 56),
                eyeCentreY: 31.5,
                bloomBox: CGSize(width: 240, height: 228),
                bloomCentreOffset: CGSize(width: 0, height: -6),
                core: MascotCoreSpec(
                    box: CGSize(width: 150, height: 143),
                    centreOffset: CGSize(width: 0, height: -6.5),
                    radiusFraction: CGSize(width: 0.40, height: 0.38),
                    centreFraction: CGPoint(x: 0.50, y: 0.47),
                    stops: .inner,
                    paintsAboveBlooms: true
                ),
                canvasSide: 320
            )
        case .fullScreen:
            // Board 29 "Orb · live hero" (700×200 slot): face 120×94 centred; one halo
            // layer 422×400 at (139, −109) → centre (350, 91) against the face centre
            // (350, 100), so (0, −9). The core rides inside that same box as the third
            // gradient: ellipse 27 % × 26 % at (50 %, 47 %).
            MascotMetrics(
                face: CGSize(width: 120, height: 94),
                eyeCentreY: 53,
                bloomBox: CGSize(width: 422, height: 400),
                bloomCentreOffset: CGSize(width: 0, height: -9),
                core: MascotCoreSpec(
                    box: CGSize(width: 422, height: 400),
                    centreOffset: CGSize(width: 0, height: -9),
                    radiusFraction: CGSize(width: 0.27, height: 0.26),
                    centreFraction: CGPoint(x: 0.50, y: 0.47),
                    stops: .hero,
                    paintsAboveBlooms: false
                ),
                canvasSide: 560
            )
        case .dock:
            // The mascot replaces the orb inside the orb's own 64pt slot, so the face is
            // the dock orb's 44×34 body and the eye row is the orb's: 4 + (34 − 4 − 5.5)/2
            // + 5.5/2 = 19 (`OrbSize.dock`). The reference sheet lands exactly on the orb
            // here — the resting eye is note/27's Ø6 × the 44/48 state scale = 5.5, the
            // orb's own — and only the eye spread differs: 22 × 44/48 ≈ 20.2 against the
            // orb's 19.5, a third of a point per eye.
            //
            // The bloom box: note/27 rests the halo at 104/130 of the listening box, and
            // the resting mascot must sit where the resting orb sits, so the box is the
            // orb's halo × 130/104: 130×128 → 162.5×160. Board 28 validates the rule:
            // 240×228 × 104/130 = 192×182.4 against the panel orb's 190×180 halo. The
            // dock orb's halo is centred on its frame (−33 + 65 − 32 = 0), so the
            // registration is (0, 0).
            //
            // The core is the orb's own third gradient, stacked as `OrbHalo` stacks it:
            // riding in the bloom box, ellipse 29% × 28% at (50%, 47%), hero stops,
            // under the blooms.
            MascotMetrics(
                face: CGSize(width: 44, height: 34),
                eyeCentreY: 19,
                bloomBox: CGSize(width: 162.5, height: 160),
                bloomCentreOffset: .zero,
                core: MascotCoreSpec(
                    box: CGSize(width: 162.5, height: 160),
                    centreOffset: .zero,
                    radiusFraction: CGSize(width: 0.29, height: 0.28),
                    centreFraction: CGPoint(x: 0.50, y: 0.47),
                    stops: .hero,
                    paintsAboveBlooms: false
                ),
                // The two boards' own proportion (320/240 and 560/422, both ≈ 4/3):
                // contains the talking halo (162.5 × ~1.19 ≈ 194) and the widest ripple
                // (Ø148.1 × 44/48 ≈ 136).
                canvasSide: 216
            )
        }
    }
}

// MARK: - The five states (note/27), at the 48pt reference face

/// What one phase looks like when fully settled. `MascotMotion` blends between these —
/// it never switches, so no number here ever steps on screen.
struct MascotStateTargets: Equatable, Sendable {
    /// Multiplier on `bloomBox`, normalised so listening = 1. Board 28 is drawn mid-listen
    /// (its alphas are the listening pair below), which pins the reference.
    var haloScale: CGFloat
    /// The whole halo layer's opacity — note/27 fades the layer, not the stops.
    var haloOpacity: Double
    var warm: OrbBloomAlphas
    var cool: OrbBloomAlphas
    /// The core appears only while the mascot is actually in the conversation's audio:
    /// listening and talking.
    var coreOpacity: Double
    /// note/27: listening core 80pt wide, talking 84 — the core swells 5 %, it does not
    /// follow the blooms' 15 %.
    var coreScale: CGFloat
    /// Eye box in reference units (Ø6 resting; Ø7 listening; 6×10 talking).
    var eyeSize: CGSize
    /// Eye-centre offset from the resting position, reference units. Thinking glances
    /// up-left by (−4.5, −4); talking sits 1pt high.
    var eyeOffset: CGVector
    /// Distance between the two eye centres, reference units.
    var eyeCentreDistance: CGFloat
}

/// note/27's numbers, verbatim. Everything is at the 48pt reference face; the painter
/// multiplies by `MascotMetrics.stateScale`.
enum MascotSpec {
    static let referenceFaceWidth: CGFloat = 48

    // MARK: Thinking accents

    /// The pulse ring: Ø108, 1.5pt stroke, `#6051DC38` — the brand violet at 56/255.
    static let ringDiameter: CGFloat = 108
    static let ringStrokeWidth: CGFloat = 1.5
    static let ringOpacity: Double = 56.0 / 255.0

    // MARK: Resting ring (work mode)

    /// Board 31's `state/resting`: **one** thin ring where every other state has a halo —
    /// Ø116 over the 72pt docked face, 1.5pt stroke, brand violet at 30 %, no fill and no
    /// glow. Both numbers are divided back into the 48pt reference face here (× 48/72), so
    /// `stateScale` reproduces the board exactly at 72 and carries the same proportion to
    /// the 120pt hero and the 44pt dock. note/27's own tile draws it at Ø76 on the
    /// reference face, a point and a half off the live board's Ø77.3; where the two
    /// disagree the live board wins, as it does for every other measured state.
    static let restingRingDiameter: CGFloat = 116 * referenceFaceWidth / 72
    static let restingRingStrokeWidth: CGFloat = 1.5 * referenceFaceWidth / 72
    /// `rgba(96,81,220,0.30)` — the brand at 30 %, dimmer than the thinking ring's 22 %
    /// *looks* because nothing else is lit behind it.
    static let restingRingOpacity: Double = 0.30

    /// The orbiting dot: Ø5, solid brand, drawn at (140.5, 26.5) against the face centre
    /// (106, 65) — radius √(34.5² + 38.5²) ≈ 51.70 at the angle the note froze it at.
    static let dotDiameter: CGFloat = 5
    static let dotOrbitRadius: CGFloat = 51.70
    static let dotStartAngle: Double = atan2(-38.5, 34.5)

    // MARK: Talking ripples

    /// The two drawn rings are one ripple at two ages: Ø88 at `#6051DC4D` (77/255) and
    /// Ø120 at `#6051DC24` (36/255). Two points define the linear fade; it reaches zero
    /// at Ø ≈ 148.1, which is where a ripple dies.
    static let rippleBirthDiameter: CGFloat = 88
    static let rippleBirthOpacity: Double = 77.0 / 255.0
    static let rippleFadePerPoint: Double = ((77.0 - 36.0) / 255.0) / Double(120 - 88)
    static var rippleDeathDiameter: CGFloat {
        rippleBirthDiameter + CGFloat(rippleBirthOpacity / rippleFadePerPoint)
    }
    static let rippleStrokeWidth: CGFloat = 1.5

    // MARK: Per-state targets

    /// The five cards, plus `connecting`, which note/27 does not draw: it borrows idle's
    /// look (the mascot arrives resting and wakes when the wire does).
    static func targets(for phase: VoicePhase) -> MascotStateTargets {
        switch phase {
        case .idle, .connecting:
            // Halo 104×98 at layer opacity 0.75, resting alphas, Ø6 eyes.
            return MascotStateTargets(
                haloScale: 104.0 / 130.0,
                haloOpacity: 0.75,
                warm: OrbBloomAlphas(start: 0.75, mid: 0.34),
                cool: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreOpacity: 0,
                coreScale: 1,
                eyeSize: CGSize(width: 6, height: 6),
                eyeOffset: CGVector(dx: 0, dy: 0),
                eyeCentreDistance: 22
            )
        case .listening:
            // Halo 130×123 full opacity, brightened alphas, the core appears, eyes Ø7 —
            // widened in place (gap 15 keeps the 22pt centres).
            return MascotStateTargets(
                haloScale: 1,
                haloOpacity: 1,
                warm: OrbBloomAlphas(start: 0.85, mid: 0.42),
                cool: OrbBloomAlphas(start: 0.80, mid: 0.38),
                coreOpacity: 1,
                coreScale: 1,
                eyeSize: CGSize(width: 7, height: 7),
                eyeOffset: CGVector(dx: 0, dy: 0),
                eyeCentreDistance: 22
            )
        case .thinking:
            // Halo 110×104 at 0.9, resting alphas; the ring and dot are drawn separately.
            // The face's padding (bottom 8, right 9) moves the eye pair (−4.5, −4).
            return MascotStateTargets(
                haloScale: 110.0 / 130.0,
                haloOpacity: 0.9,
                warm: OrbBloomAlphas(start: 0.75, mid: 0.34),
                cool: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreOpacity: 0,
                coreScale: 1,
                eyeSize: CGSize(width: 6, height: 6),
                eyeOffset: CGVector(dx: -4.5, dy: -4),
                eyeCentreDistance: 22
            )
        case .talking:
            // The strongest card: halo 150×142, the hottest alphas, core at 84/80, tall
            // 6×10 eyes on 21pt centres sitting 1pt high.
            return MascotStateTargets(
                haloScale: 150.0 / 130.0,
                haloOpacity: 1,
                warm: OrbBloomAlphas(start: 0.90, mid: 0.46),
                cool: OrbBloomAlphas(start: 0.85, mid: 0.40),
                coreOpacity: 1,
                coreScale: 84.0 / 80.0,
                eyeSize: CGSize(width: 6, height: 10),
                eyeOffset: CGVector(dx: 0, dy: -1),
                eyeCentreDistance: 21
            )
        case .resting:
            // Work mode, board 31. No halo at all — the layer opacity is zero, and the one
            // thin ring (`restingRing*` above, drawn by `MascotMotion`) is the whole mark.
            // The halo's *scale* still carries idle's value so the crossfade out of
            // listening shrinks as it fades rather than dissolving at full size.
            //
            // The eyes are the state: note/27's slits, Ø7 wide by 3 tall on the reference
            // face — the docked 10 × 4 the board draws, divided by the same 1.5. They close
            // over `restingTransitionSeconds`, which is the only reason that constant is
            // shorter than every other crossfade.
            return MascotStateTargets(
                haloScale: 104.0 / 130.0,
                haloOpacity: 0,
                warm: OrbBloomAlphas(start: 0.75, mid: 0.34),
                cool: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreOpacity: 0,
                coreScale: 1,
                eyeSize: CGSize(width: 7, height: 3),
                eyeOffset: CGVector(dx: 0, dy: 0),
                eyeCentreDistance: 22
            )
        case .ending:
            // Halo 96×91 at 0.5 — dimmer and smaller than idle, so the settle back to
            // idle afterwards reads as the face coming to rest, not as a second event.
            return MascotStateTargets(
                haloScale: 96.0 / 130.0,
                haloOpacity: 0.5,
                warm: OrbBloomAlphas(start: 0.75, mid: 0.34),
                cool: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreOpacity: 0,
                coreScale: 1,
                eyeSize: CGSize(width: 6, height: 6),
                eyeOffset: CGVector(dx: 0, dy: 0),
                eyeCentreDistance: 22
            )
        }
    }
}
