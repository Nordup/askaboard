import CoreGraphics
import Foundation

/// Integrates everything that moves on the voice mascot: the phase crossfades, the two
/// speech envelopes, the listening breath, the thinking pulse and orbit, the talking bob
/// and ripples, and the ending exhale.
///
/// It integrates in `dt` rather than sampling `f(t)` — the sleep orb's discipline — for the
/// same reason the sleep orb adopted it: one shared instance is injected at `BoardScreen`
/// level, so when the panel mascot is swapped for the full-screen one mid-sentence the
/// envelopes, clocks and half-finished crossfades carry straight across instead of
/// restarting. Two views drawing the same instance in one frame are also safe: the second
/// `frame(at:)` call sees `dt == 0` and advances nothing.
///
/// Everything that can move is either ramped in `dt` and eased where it is read, or is an
/// amplitude multiplied by a smooth weight — so a phase change never steps a pixel.
///
/// Not `@MainActor` so the unit tests can drive it with injected dates from any context;
/// in the app it is only ever touched from view bodies. `@unchecked Sendable` exists solely
/// to let an optional of it sit in an `EnvironmentKey` default under Swift 6.
final class MascotMotion: @unchecked Sendable {

    struct Inputs {
        var state: VoiceDisplayState
        var reduceMotion: Bool = false
    }

    /// A talking ripple at one instant, in note/27's reference units.
    struct Ripple: Equatable {
        var diameter: CGFloat
        var opacity: Double
    }

    struct Ring: Equatable {
        var diameter: CGFloat
        var opacity: Double
        /// In the same reference units as `diameter` — the thinking ring and the resting
        /// ring are drawn at different weights (1.5 and 1.0 on the 48pt face), so the
        /// weight travels with the ring rather than sitting in the painter.
        var strokeWidth: CGFloat = MascotSpec.ringStrokeWidth
    }

    struct Dot: Equatable {
        var angle: Double
        var opacity: Double
    }

    /// One drawn instant. Geometry fields are in note/27's reference units (48pt face);
    /// the painter scales them. The envelopes ride along for the unit tests.
    struct Frame {
        var haloScale: CGFloat
        var haloOpacity: Double
        var warmAlphas: OrbBloomAlphas
        var coolAlphas: OrbBloomAlphas
        var coreOpacity: Double
        var coreScale: CGFloat
        var eyeSize: CGSize
        var eyeOffset: CGVector
        var eyeCentreDistance: CGFloat
        /// Vertical face bob as a fraction of the face height. Face and eyes only —
        /// the halo does not bob.
        var faceBobFraction: CGFloat
        var ring: Ring?
        var orbitDot: Dot?
        var ripples: [Ripple]
        var userEnvelope: Double
        var assistantEnvelope: Double
    }

    // MARK: - Integrated state

    private var lastTick: Date?
    /// One weight per phase, ramped linearly in `dt` toward the active phase and
    /// smoothstepped where they are read. Starts resting on idle, so a mascot appearing
    /// mid-call fades in through its first crossfade rather than popping.
    private var weights: [Double] = MascotMotion.phases.map { $0 == .idle ? 1 : 0 }
    private var userEnvelope: Double = 0
    private var assistantEnvelope: Double = 0
    /// The listening breath (and connecting's fainter version of it). Advances only at
    /// the combined weight of the two states that breathe, so elsewhere it has stopped,
    /// not merely flattened.
    private var breathPhase: Double = 0
    /// The thinking pulse — ring opacity/size and the halo's slow swell share it.
    private var pulsePhase: Double = 0
    private var orbitAngle: Double = MascotSpec.dotStartAngle
    /// The talking bob's clock. Frozen while the assistant is silent (the sleep orb's
    /// `rimTime` rule): the face resumes where it left off, it does not jump.
    private var bobPhase: Double = 0
    /// The resting ring's breath. Its own clock rather than the listening breath's,
    /// because it runs at a sixth of the rate and must not inherit that one's position
    /// when the tutor steps back mid-sentence.
    private var restPhase: Double = 0
    /// Talking ripples as unit progress 0…1; diameter and fade are derived.
    private var rippleProgress: [Double] = []
    private var nextRippleIn: Double = 0
    private var endingElapsed: Double = 0

    // MARK: - Tunables

    /// The speech envelope, verbatim from the sleep orb (§10 of the port guide is binding
    /// on the shape): 80 ms one-pole attack, 400 ms one-pole release, and below `e⁻¹` the
    /// release is *replaced* by a linear drain at the exponential's own rate there, so the
    /// level lands on exactly zero instead of crawling toward it forever.
    private static let attackSeconds: Double = 0.080
    private static let releaseSeconds: Double = 0.400
    private static let releaseKnee: Double = exp(-1)
    private static let releaseDrainPerSecond: Double = exp(-1) / releaseSeconds
    /// The noise-floor squelch in normalised units, rescaled over the full range so
    /// nothing steps at the gate.
    private static let noiseFloorGate: Double = 0.08
    /// Naka–Rushton lift (k = 3): a quiet voice reads without the gate's doorstep lifting
    /// with it. Same curve, same constant, same reasons as the sleep orb.
    private static let reactivityLift: Double = 3

    /// Ordinary crossfades take 350 ms; the ending exhale gets the spec's "~1 s": a 900 ms
    /// ramp, plus the one-shot swell below.
    private static let transitionSeconds: Double = 0.35
    private static let endingTransitionSeconds: Double = 0.90
    /// Work mode's own, shorter crossfade: board 31 closes the eyes to slits in ~250 ms.
    /// Waking takes the ordinary 350 ms — the phase being ramped toward is `.listening`
    /// then, and it is the target phase that picks the duration.
    private static let restingTransitionSeconds: Double = 0.25
    /// The exhale: a half-sine swell over the ending's first 450 ms — the halo fills
    /// before it empties.
    private static let endingSwellSeconds: Double = 0.45
    private static let endingSwellAmplitude: Double = 0.05

    private static let breathPeriodSeconds: Double = 3.6
    /// Resting breath amplitude on the halo scale; the voice deepens it and adds a swell.
    private static let breathBaseAmplitude: Double = 0.02
    private static let breathVoiceAmplitude: Double = 0.06
    private static let listeningSwellAmplitude: Double = 0.05
    /// "Brightens with the user's voice level": how much the bloom alphas rise at full
    /// depth, on top of the listening card's own 0.85/0.42 · 0.80/0.38.
    private static let listeningAlphaBoost: Double = 0.05
    /// Connecting borrows idle's card with a faint breath — the mascot arriving, not yet
    /// carrying anything.
    private static let connectingBreathAmplitude: Double = 0.015

    /// The resting ring breathes ±2 % on a ~6 s sine — slow enough to read as alive
    /// rather than as a state doing something. Integrated in `dt` like every other clock
    /// here; nothing in this file samples `f(t)`.
    private static let restPeriodSeconds: Double = 6.0
    private static let restBreathAmplitude: Double = 0.02

    private static let pulsePeriodSeconds: Double = 2.8
    private static let pulseHaloAmplitude: Double = 0.02
    private static let orbitPeriodSeconds: Double = 3.0

    /// Syllable-rate bob, echoing the sleep rim's fastest lobe (2.41 Hz) rounded down for
    /// a face rather than a rim.
    private static let bobFrequencyHz: Double = 2.2
    /// Peak bob as a fraction of face height: ~2.5pt on the 56pt panel face.
    private static let bobAmplitude: Double = 0.045
    private static let talkingSwellAmplitude: Double = 0.04

    /// A ripple's life: Ø88 → Ø148.1 over 0.9 s. Spawned every 0.48 s while the assistant
    /// is audibly talking, which reproduces note/27's still exactly: when one ring reaches
    /// Ø120 the next is at Ø88. Never more than three alive.
    private static let rippleLifetimeSeconds: Double = 0.9
    private static let rippleSpawnInterval: Double = 0.48
    private static let maxRipples = 3
    /// The assistant depth below which ripples stop spawning.
    private static let rippleSpawnFloor: Double = 0.05

    private static let phases: [VoicePhase] = [
        .idle, .connecting, .listening, .thinking, .talking, .resting, .ending,
    ]

    // MARK: - Frame

    func frame(at now: Date, inputs: Inputs) -> Frame {
        advance(to: now, inputs: inputs)

        // Smoothstepped, normalised weights: eased blends whose ends arrive exactly.
        let eased = weights.map(Self.smoothstep)
        let sum = eased.reduce(0, +)
        let w = sum > 0 ? eased.map { $0 / sum } : Self.phases.map { $0 == .idle ? 1.0 : 0 }

        func weight(_ phase: VoicePhase) -> Double {
            guard let index = Self.phases.firstIndex(of: phase) else { return 0 }
            return w[index]
        }

        // Blend the settled per-state targets.
        var haloScale: Double = 0
        var haloOpacity: Double = 0
        var warmStart: Double = 0, warmMid: Double = 0
        var coolStart: Double = 0, coolMid: Double = 0
        var coreOpacity: Double = 0
        var coreScale: Double = 0
        var eyeW: Double = 0, eyeH: Double = 0
        var eyeDX: Double = 0, eyeDY: Double = 0
        var eyeCD: Double = 0
        for (index, phase) in Self.phases.enumerated() {
            let t = MascotSpec.targets(for: phase)
            let wi = w[index]
            haloScale += wi * Double(t.haloScale)
            haloOpacity += wi * t.haloOpacity
            warmStart += wi * t.warm.start
            warmMid += wi * t.warm.mid
            coolStart += wi * t.cool.start
            coolMid += wi * t.cool.mid
            coreOpacity += wi * t.coreOpacity
            coreScale += wi * Double(t.coreScale)
            eyeW += wi * Double(t.eyeSize.width)
            eyeH += wi * Double(t.eyeSize.height)
            eyeDX += wi * Double(t.eyeOffset.dx)
            eyeDY += wi * Double(t.eyeOffset.dy)
            eyeCD += wi * Double(t.eyeCentreDistance)
        }

        let listening = weight(.listening)
        let connecting = weight(.connecting)
        let thinking = weight(.thinking)
        let talking = weight(.talking)
        let resting = weight(.resting)
        let ending = weight(.ending)
        let userDepth = Self.depth(ofEnvelope: userEnvelope)
        let assistantDepth = Self.depth(ofEnvelope: assistantEnvelope)
        let reduceMotion = inputs.reduceMotion

        // The listening breath and voice swell; connecting's fainter breath; the thinking
        // pulse; the talking swell; the ending exhale. All amplitudes ride their state's
        // weight, so a crossfade fades the motion with the look.
        if !reduceMotion {
            let breathAmplitude = Self.breathBaseAmplitude
                + Self.breathVoiceAmplitude * userDepth
            haloScale += listening * (breathAmplitude * sin(breathPhase)
                + Self.listeningSwellAmplitude * userDepth)
            haloScale += connecting * Self.connectingBreathAmplitude * sin(breathPhase)
            haloScale += thinking * Self.pulseHaloAmplitude * sin(pulsePhase)
            haloScale += talking * Self.talkingSwellAmplitude * assistantDepth
            let swellPhase = min(endingElapsed / Self.endingSwellSeconds, 1)
            haloScale += ending * Self.endingSwellAmplitude * sin(.pi * swellPhase)
        }

        // "Brightens with the user's voice level."
        let boost = Self.listeningAlphaBoost * userDepth * listening
        let warm = OrbBloomAlphas(start: min(warmStart + boost, 1), mid: min(warmMid + boost, 1))
        let cool = OrbBloomAlphas(start: min(coolStart + boost, 1), mid: min(coolMid + boost, 1))

        // Thinking accents, and work mode's single ring.
        //
        // One ring field, and the heavier weight takes it. The two states never really
        // overlap: `step_back` arrives on a response the tutor is speaking, and a call
        // that is thinking has a worker turn open — which the tool gate answers `busy`.
        var ring: Ring?
        var dot: Dot?
        if resting > 0.003, resting >= thinking {
            let breath = reduceMotion ? 0 : sin(restPhase)
            ring = Ring(
                diameter: MascotSpec.restingRingDiameter
                    * CGFloat(1 + Self.restBreathAmplitude * breath),
                opacity: MascotSpec.restingRingOpacity * resting,
                strokeWidth: MascotSpec.restingRingStrokeWidth
            )
        } else if thinking > 0.003 {
            let pulse = reduceMotion ? 0 : sin(pulsePhase)
            ring = Ring(
                diameter: MascotSpec.ringDiameter * CGFloat(1 + 0.03 * pulse),
                opacity: MascotSpec.ringOpacity * (0.775 + 0.225 * pulse) * thinking
            )
            dot = Dot(angle: orbitAngle, opacity: thinking)
        }

        // The bob: assistant energy through the envelope, on a clock that only runs while
        // there is energy to run on.
        let bob = reduceMotion
            ? 0
            : Self.bobAmplitude * assistantDepth * sin(bobPhase) * talking

        let ripples = rippleProgress.map { progress in
            Ripple(
                diameter: MascotSpec.rippleBirthDiameter
                    + CGFloat(progress) * (MascotSpec.rippleDeathDiameter - MascotSpec.rippleBirthDiameter),
                opacity: MascotSpec.rippleBirthOpacity * (1 - progress) * talking
            )
        }

        return Frame(
            haloScale: CGFloat(haloScale),
            haloOpacity: min(max(haloOpacity, 0), 1),
            warmAlphas: warm,
            coolAlphas: cool,
            coreOpacity: min(max(coreOpacity, 0), 1),
            coreScale: CGFloat(coreScale),
            eyeSize: CGSize(width: eyeW, height: eyeH),
            eyeOffset: CGVector(dx: eyeDX, dy: eyeDY),
            eyeCentreDistance: CGFloat(eyeCD),
            faceBobFraction: CGFloat(bob),
            ring: ring,
            orbitDot: dot,
            ripples: ripples,
            userEnvelope: userEnvelope,
            assistantEnvelope: assistantEnvelope
        )
    }

    // MARK: - Integration

    private func advance(to now: Date, inputs: Inputs) {
        // A frame after a stall (backgrounded, first frame) must not teleport anything.
        let raw = lastTick.map { now.timeIntervalSince($0) } ?? 0
        let dt = min(max(raw, 0), 0.1)
        lastTick = now
        guard dt > 0 else { return }

        let phase = inputs.state.phase

        // Envelopes first: everything below reads them.
        userEnvelope = Self.stepEnvelope(userEnvelope, toward: Self.squelched(inputs.state.userLevel), dt: dt)
        assistantEnvelope = Self.stepEnvelope(assistantEnvelope, toward: Self.squelched(inputs.state.assistantLevel), dt: dt)

        // Phase weights: linear ramps toward the active phase, eased where read.
        let duration = switch phase {
        case .ending: Self.endingTransitionSeconds
        case .resting: Self.restingTransitionSeconds
        default: Self.transitionSeconds
        }
        let step = dt / duration
        for (index, candidate) in Self.phases.enumerated() {
            let target: Double = candidate == phase ? 1 : 0
            weights[index] = target > weights[index]
                ? min(target, weights[index] + step)
                : max(target, weights[index] - step)
        }

        if phase == .ending {
            endingElapsed += dt
        } else {
            endingElapsed = 0
        }

        // Clocks advance at their state's raw weight, so leaving a state stops its clock
        // rather than leaving it ticking under a zero amplitude.
        let listeningW = rawWeight(.listening)
        let connectingW = rawWeight(.connecting)
        let thinkingW = rawWeight(.thinking)
        let talkingW = rawWeight(.talking)
        let restingW = rawWeight(.resting)

        breathPhase += 2 * .pi * dt * max(listeningW, connectingW) / Self.breathPeriodSeconds
        if breathPhase > 4 * .pi { breathPhase -= 4 * .pi }
        restPhase += 2 * .pi * dt * restingW / Self.restPeriodSeconds
        if restPhase > 4 * .pi { restPhase -= 4 * .pi }
        pulsePhase += 2 * .pi * dt * thinkingW / Self.pulsePeriodSeconds
        if pulsePhase > 4 * .pi { pulsePhase -= 4 * .pi }
        if !inputs.reduceMotion {
            orbitAngle += 2 * .pi * dt * thinkingW / Self.orbitPeriodSeconds
        }
        if assistantEnvelope > 0 {
            bobPhase += 2 * .pi * Self.bobFrequencyHz * dt
        }

        // Ripples age out; new ones spawn only while the mascot is substantially talking
        // and the assistant is audibly making noise.
        rippleProgress = rippleProgress.compactMap { progress in
            let aged = progress + dt / Self.rippleLifetimeSeconds
            return aged < 1 ? aged : nil
        }
        let voiced = Self.depth(ofEnvelope: assistantEnvelope) > Self.rippleSpawnFloor
        if talkingW > 0.5, voiced, !inputs.reduceMotion {
            nextRippleIn -= dt
            if nextRippleIn <= 0, rippleProgress.count < Self.maxRipples {
                rippleProgress.append(0)
                nextRippleIn = Self.rippleSpawnInterval
            }
        } else {
            // The next talking stretch answers promptly, without banking spawns.
            nextRippleIn = 0
        }
    }

    private func rawWeight(_ phase: VoicePhase) -> Double {
        guard let index = Self.phases.firstIndex(of: phase) else { return 0 }
        return weights[index]
    }

    /// One-pole attack, one-pole release, linear drain to exactly zero below the knee.
    private static func stepEnvelope(_ envelope: Double, toward target: Double, dt: Double) -> Double {
        if target > envelope {
            return envelope + (target - envelope) * (1 - exp(-dt / attackSeconds))
        } else if envelope > releaseKnee {
            return envelope + (target - envelope) * (1 - exp(-dt / releaseSeconds))
        } else {
            return max(target, envelope - releaseDrainPerSecond * dt)
        }
    }

    private static func squelched(_ level: Double) -> Double {
        let clamped = min(max(level, 0), 1)
        return max(0, (clamped - noiseFloorGate) / (1 - noiseFloorGate))
    }

    /// The enveloped level → visual depth: 0 → 0, 1 → 1, concave with a finite slope at
    /// the origin, so a soft voice reads and the gate's doorstep does not.
    private static func depth(ofEnvelope envelope: Double) -> Double {
        let e = min(max(envelope, 0), 1)
        return e * (1 + reactivityLift) / (1 + reactivityLift * e)
    }

    private static func smoothstep(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return t * t * (3 - 2 * t)
    }
}
