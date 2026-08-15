import CoreGraphics
import XCTest
@testable import MathTutor

/// The mascot's motion, on an injected clock.
///
/// `MascotMotion` is a pure integrator — same dates in, same frames out — so every claim
/// the animation makes is checkable without a display: the envelope's published shape
/// (80 ms attack, 400 ms release, a linear drain that lands on exactly zero), crossfades
/// that never step, the ripple lifecycle, clocks that freeze when their state leaves, and
/// the stall clamp that keeps a backgrounded frame from teleporting anything.
final class MascotMotionTests: XCTestCase {

    // MARK: - Harness

    /// Drives one `MascotMotion` along an injected timeline.
    private struct Harness {
        let motion = MascotMotion()
        private(set) var now = Date(timeIntervalSinceReferenceDate: 700_000)

        mutating func frame(
            _ state: VoiceDisplayState,
            reduceMotion: Bool = false
        ) -> MascotMotion.Frame {
            motion.frame(at: now, inputs: MascotMotion.Inputs(state: state, reduceMotion: reduceMotion))
        }

        /// Steps the clock through `seconds` of frames and returns the last one.
        @discardableResult
        mutating func run(
            _ seconds: TimeInterval,
            step: TimeInterval = 1.0 / 120.0,
            state: VoiceDisplayState,
            reduceMotion: Bool = false,
            onFrame: ((MascotMotion.Frame) -> Void)? = nil
        ) -> MascotMotion.Frame {
            var last = frame(state, reduceMotion: reduceMotion)
            var elapsed: TimeInterval = 0
            while elapsed < seconds {
                now = now.addingTimeInterval(step)
                elapsed += step
                last = motion.frame(at: now, inputs: MascotMotion.Inputs(state: state, reduceMotion: reduceMotion))
                onFrame?(last)
            }
            return last
        }
    }

    private func state(
        _ phase: VoicePhase,
        user: Double = 0,
        assistant: Double = 0
    ) -> VoiceDisplayState {
        VoiceDisplayState(phase: phase, userLevel: user, assistantLevel: assistant)
    }

    // MARK: - Resting state

    func testTheFirstFrameIsTheIdleCard() {
        var harness = Harness()
        let frame = harness.frame(state(.idle))

        XCTAssertEqual(frame.haloScale, 104.0 / 130.0, accuracy: 0.0001)
        XCTAssertEqual(frame.haloOpacity, 0.75, accuracy: 0.0001)
        XCTAssertEqual(frame.eyeSize, CGSize(width: 6, height: 6))
        XCTAssertEqual(frame.eyeCentreDistance, 22)
        XCTAssertNil(frame.ring)
        XCTAssertNil(frame.orbitDot)
        XCTAssertTrue(frame.ripples.isEmpty)
        XCTAssertEqual(frame.faceBobFraction, 0)
    }

    // MARK: - Envelope shape

    func testTheAttackReachesOneTimeConstantInEightyMilliseconds() {
        var harness = Harness()
        let frame = harness.run(0.080, step: 0.002, state: state(.listening, user: 1))

        // One τ of a one-pole: 1 − e⁻¹ ≈ 0.632 of a full-scale step.
        XCTAssertEqual(frame.userEnvelope, 1 - exp(-1), accuracy: 0.02)
    }

    func testTheReleaseDrainsToExactlyZero() {
        var harness = Harness()
        harness.run(1.0, state: state(.listening, user: 1))

        var previous = Double.greatestFiniteMagnitude
        var monotone = true
        let midRelease = harness.run(0.75, state: state(.listening)) { frame in
            if frame.userEnvelope > previous + 1e-12 { monotone = false }
            previous = frame.userEnvelope
        }
        // 400 ms of exponential to the knee, then the linear drain: from full scale the
        // level is still audible-side of zero at 750 ms…
        XCTAssertGreaterThan(midRelease.userEnvelope, 0)

        // …and has landed on *exactly* zero — not an asymptote — by 900 ms.
        let settled = harness.run(0.15, state: state(.listening))
        XCTAssertEqual(settled.userEnvelope, 0)
        XCTAssertTrue(monotone, "The release must never move upward against a silent input")
    }

    func testAStallClampsToOneTenthOfASecond() {
        var harness = Harness()
        // The first frame only anchors the clock; the envelope is still zero.
        _ = harness.frame(state(.listening, user: 1))

        // One frame five seconds later must integrate exactly the 100 ms clamp of
        // attack — not five full seconds of it, which would read 1.0.
        let frame = harness.run(5.0, step: 5.0, state: state(.listening, user: 1))
        XCTAssertEqual(frame.userEnvelope, 1 - exp(-0.1 / 0.080), accuracy: 0.01)
    }

    // MARK: - Crossfades

    func testAPhaseChangeNeverStepsTheHalo() {
        var harness = Harness()
        harness.run(0.5, state: state(.idle))

        var previous: CGFloat?
        var largestJump: CGFloat = 0
        let settled = harness.run(1.0, step: 1.0 / 60.0, state: state(.listening)) { frame in
            if let previous { largestJump = max(largestJump, abs(frame.haloScale - previous)) }
            previous = frame.haloScale
        }

        XCTAssertLessThan(largestJump, 0.02, "A 60 fps frame may only move the halo smoothly")
        // Settled listening at a silent mic: the card's scale 1.0, breathing ±0.02.
        XCTAssertEqual(Double(settled.haloScale), 1.0, accuracy: 0.05)
        XCTAssertEqual(settled.haloOpacity, 1.0, accuracy: 0.001)
    }

    func testEndingSettlesOnTheCardInAboutASecond() {
        var harness = Harness()
        harness.run(1.2, state: state(.talking, assistant: 0.6))

        let frame = harness.run(1.2, state: state(.ending))
        // The 900 ms ramp is over and the exhale swell (sin π) has closed.
        XCTAssertEqual(frame.haloOpacity, 0.5, accuracy: 0.001)
        XCTAssertEqual(frame.haloScale, 96.0 / 130.0, accuracy: 0.001)
        XCTAssertTrue(frame.ripples.isEmpty)
        XCTAssertEqual(frame.faceBobFraction, 0)
    }

    // MARK: - Eyes

    func testTheEyesFollowTheState() {
        var listening = Harness()
        let wide = listening.run(1.0, state: state(.listening))
        XCTAssertEqual(wide.eyeSize.width, 7, accuracy: 0.001)
        XCTAssertEqual(wide.eyeSize.height, 7, accuracy: 0.001)
        XCTAssertEqual(wide.eyeCentreDistance, 22, accuracy: 0.001)

        var thinking = Harness()
        let glancing = thinking.run(1.0, state: state(.thinking))
        XCTAssertEqual(glancing.eyeOffset.dx, -4.5, accuracy: 0.001)
        XCTAssertEqual(glancing.eyeOffset.dy, -4, accuracy: 0.001)

        var talking = Harness()
        let tall = talking.run(1.0, state: state(.talking))
        XCTAssertEqual(tall.eyeSize.width, 6, accuracy: 0.001)
        XCTAssertEqual(tall.eyeSize.height, 10, accuracy: 0.001)
        XCTAssertEqual(tall.eyeCentreDistance, 21, accuracy: 0.001)
    }

    // MARK: - Ripples

    func testRipplesSpawnExpandFadeAndDie() {
        var harness = Harness()
        let talking = state(.talking, assistant: 0.8)

        // Spawning starts once the crossfade has substantially arrived.
        let early = harness.run(0.3, state: talking)
        XCTAssertFalse(early.ripples.isEmpty)

        // The oldest ripple expands and fades monotonically while it lives.
        var previous: MascotMotion.Ripple?
        harness.run(0.55, state: talking) { frame in
            guard let first = frame.ripples.first else { return }
            if let previous {
                XCTAssertGreaterThan(first.diameter, previous.diameter)
                XCTAssertLessThan(first.opacity, previous.opacity)
            }
            previous = first
        }

        // Never more than three alive, at any frame.
        harness.run(2.0, state: talking) { frame in
            XCTAssertLessThanOrEqual(frame.ripples.count, 3)
        }

        // Silence stops the spawning; the survivors age out.
        let quiet = harness.run(2.5, state: state(.talking))
        XCTAssertTrue(quiet.ripples.isEmpty)
    }

    // MARK: - Clocks freeze with their states

    func testTheOrbitDotRunsOnlyWhileThinking() throws {
        var harness = Harness()
        let settled = harness.run(1.0, state: state(.thinking))
        let a1 = try XCTUnwrap(settled.orbitDot).angle

        let later = harness.run(0.5, state: state(.thinking))
        let a2 = try XCTUnwrap(later.orbitDot).angle
        // One settled half second at the 3.0 s orbit period; the tolerance is one
        // 1/120 step of accumulated float drift.
        XCTAssertEqual(a2 - a1, 2 * .pi * 0.5 / 3.0, accuracy: 0.05)

        // Leaving thinking retires the dot entirely.
        let elsewhere = harness.run(1.0, state: state(.listening))
        XCTAssertNil(elsewhere.orbitDot)
    }

    func testTheBobIsSilentWhenTheAssistantIs() {
        var harness = Harness()
        harness.run(1.0, state: state(.talking)) { frame in
            XCTAssertEqual(frame.faceBobFraction, 0, "No energy, no bob")
        }

        var moved = false
        harness.run(0.5, state: state(.talking, assistant: 0.8)) { frame in
            if abs(frame.faceBobFraction) > 0.001 { moved = true }
        }
        XCTAssertTrue(moved, "A speaking assistant must move the face")

        let silent = harness.run(1.5, state: state(.talking))
        XCTAssertEqual(silent.faceBobFraction, 0, "The drained envelope stills the face exactly")
    }

    // MARK: - Work mode (board 31)

    func testRestingIsOneThinRingAndNothingElse() throws {
        var harness = Harness()
        // Entered from a live call, the way `step_back` enters it: the tutor has just
        // finished speaking.
        harness.run(0.5, state: state(.talking, assistant: 0.7))
        let frame = harness.run(1.0, state: state(.resting))

        XCTAssertEqual(frame.haloOpacity, 0, accuracy: 0.0001, "Work mode draws no halo at all")
        XCTAssertEqual(frame.coreOpacity, 0, accuracy: 0.0001)
        XCTAssertTrue(frame.ripples.isEmpty, "The talking ripples must not survive the step back")
        XCTAssertNil(frame.orbitDot)

        let ring = try XCTUnwrap(frame.ring)
        XCTAssertEqual(ring.strokeWidth, MascotSpec.restingRingStrokeWidth, accuracy: 0.0001)
        XCTAssertEqual(ring.opacity, MascotSpec.restingRingOpacity, accuracy: 0.005)
        // The breath is ±2 % of the board's Ø, so the ring is never anywhere else.
        XCTAssertEqual(
            ring.diameter,
            MascotSpec.restingRingDiameter,
            accuracy: MascotSpec.restingRingDiameter * 0.02 + 0.0001
        )
    }

    func testTheEyesCloseToSlitsAndOpenAgainOnWake() {
        var harness = Harness()
        let listening = harness.run(1.0, state: state(.listening))
        XCTAssertEqual(listening.eyeSize.width, 7, accuracy: 0.01)
        XCTAssertEqual(listening.eyeSize.height, 7, accuracy: 0.01)

        // note/27's slits, reached inside board 31's ~250 ms.
        let rested = harness.run(0.30, state: state(.resting))
        XCTAssertEqual(rested.eyeSize.width, 7, accuracy: 0.01)
        XCTAssertEqual(rested.eyeSize.height, 3, accuracy: 0.01)

        // The tap: back to the listening card, ring retired with it.
        let awake = harness.run(0.40, state: state(.listening))
        XCTAssertEqual(awake.eyeSize.height, 7, accuracy: 0.01)
        XCTAssertEqual(awake.haloOpacity, 1, accuracy: 0.01)
        XCTAssertNil(awake.ring)
    }

    func testTheRestingRingBreathesAndItsClockStopsWithTheState() throws {
        var harness = Harness()
        harness.run(0.5, state: state(.resting))

        var smallest = CGFloat.greatestFiniteMagnitude
        var largest: CGFloat = 0
        harness.run(6.0, state: state(.resting)) { frame in
            if let ring = frame.ring {
                smallest = min(smallest, ring.diameter)
                largest = max(largest, ring.diameter)
            }
        }
        let base = MascotSpec.restingRingDiameter
        XCTAssertGreaterThan(largest, base * 1.015, "One ~6 s sine must reach its crest")
        XCTAssertLessThan(smallest, base * 0.985, "…and its trough")
        XCTAssertLessThanOrEqual(largest, base * 1.0201)
        XCTAssertGreaterThanOrEqual(smallest, base * 0.9799)

        // Reduce Motion holds it exactly on the board's own diameter.
        var still = Harness()
        still.run(0.5, state: state(.resting), reduceMotion: true)
        let a = try XCTUnwrap(still.run(1.0, state: state(.resting), reduceMotion: true).ring)
        let b = try XCTUnwrap(still.run(2.0, state: state(.resting), reduceMotion: true).ring)
        XCTAssertEqual(a.diameter, base, accuracy: 0.0001)
        XCTAssertEqual(b.diameter, base, accuracy: 0.0001)
    }

    // MARK: - Reduce Motion

    func testReduceMotionStillsTheAccessories() throws {
        var harness = Harness()
        harness.run(1.0, state: state(.talking, assistant: 0.8), reduceMotion: true) { frame in
            XCTAssertTrue(frame.ripples.isEmpty)
            XCTAssertEqual(frame.faceBobFraction, 0)
        }

        var thinking = Harness()
        let settled = thinking.run(1.0, state: state(.thinking), reduceMotion: true)
        let ring1 = try XCTUnwrap(settled.ring)
        let dot1 = try XCTUnwrap(settled.orbitDot)
        let later = thinking.run(0.5, state: state(.thinking), reduceMotion: true)
        let ring2 = try XCTUnwrap(later.ring)
        let dot2 = try XCTUnwrap(later.orbitDot)
        XCTAssertEqual(ring1.diameter, ring2.diameter, accuracy: 0.0001)
        XCTAssertEqual(ring1.opacity, ring2.opacity, accuracy: 0.0001)
        XCTAssertEqual(dot1.angle, dot2.angle, accuracy: 0.0001, "The orbit must hold still under Reduce Motion")
    }
}
