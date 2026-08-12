import XCTest
@testable import MathTutor

/// The shared elements' flight paths, pinned the way `PresentationMorphTests` pins the
/// container: endpoints exactly, curves by their stated shapes.
///
/// The decisive measurement these tests re-derive rather than hard-code: with the reading
/// column at the panel treatment, the two endpoints draw the same components at the same
/// type scale, so each shared element's path is a translation (and, later steps, a width) —
/// never a scale, never a crossfade.
final class PresentationFlightTests: XCTestCase {

    private let layout = ScreenLayout.reference

    private var closed: PresentationFlight { PresentationFlight(layout: layout, isSidebarOpen: false) }
    private var open: PresentationFlight { PresentationFlight(layout: layout, isSidebarOpen: true) }

    // MARK: - The columns

    func testColumnsAreTheTwoSurfacesOwn() {
        let flight = closed
        // Docked: the panel's content column — x 46, width 301 on the reference screen.
        XCTAssertEqual(flight.dockedColumnX, layout.panelX + TutorPanelMetrics.inset)
        XCTAssertEqual(flight.dockedColumnWidth, TutorPanelMetrics.contentWidth(for: layout.panelWidth))
        XCTAssertEqual(flight.dockedColumnX, 46)
        XCTAssertEqual(flight.dockedColumnWidth, 301)
        // Full screen: the reading column the live surface actually draws — the capped 600,
        // centred, exactly as `TutorColumnMetrics` places it.
        let column = TutorColumnMetrics(layout: layout)
        XCTAssertEqual(flight.fullColumnX, column.x)
        XCTAssertEqual(flight.fullColumnWidth, column.width)
        XCTAssertEqual(flight.fullColumnWidth, 600)
        XCTAssertEqual(flight.fullColumnX, 388)
    }

    /// The one number the hi state's translation is: +491.5 at the reference screen.
    func testColumnShiftIsTheCentresDistance() {
        XCTAssertEqual(closed.columnShift, 491.5)
    }

    /// With the sidebar open the reading column re-centres in what the sidebar leaves, and
    /// the flight follows `TutorColumnMetrics` rather than a constant.
    func testColumnShiftFollowsTheSidebar() {
        let column = TutorColumnMetrics(layout: layout, reserving: layout.sessionsSidebarWidth)
        XCTAssertEqual(open.fullColumnX, column.x)
        XCTAssertEqual(
            open.columnShift,
            (column.x + column.width / 2) - (open.dockedColumnX + open.dockedColumnWidth / 2)
        )
    }

    // MARK: - The orb

    func testOrbTravelsPureXAtFixedY() {
        let flight = closed
        // Endpoints: centred in the 301 column, then centred in the 600 one.
        XCTAssertEqual(flight.orbX(at: 0), 148.5, accuracy: 0.5)
        XCTAssertEqual(flight.orbX(at: 1), 640, accuracy: 0.5)
        // y never moves: both surfaces stack inset + controls + 120 below the content top.
        XCTAssertEqual(
            flight.orbTop,
            layout.contentTop + TutorPanelMetrics.inset
                + TutorPanelMetrics.controlsHeight + PanelStack.orbTopMargin
        )
        XCTAssertEqual(flight.orbTop, 198)
        // Size fixed — the flight is a translation, not a zoom.
        XCTAssertEqual(PresentationFlight.orbFrame, CGSize(width: 96, height: 90))
    }

    func testOrbPathIsWholePointsAndMonotonic() {
        let flight = closed
        var last = -CGFloat.greatestFiniteMagnitude
        for step in stride(from: CGFloat(0), through: 1, by: 0.05) {
            let x = flight.orbX(at: step)
            XCTAssertEqual(x, x.rounded(), "fractional offset at \(step)")
            XCTAssertGreaterThanOrEqual(x, last - 1e-9)
            last = x
        }
    }

    // MARK: - The greeting

    /// One 301-wide block, translated only: leading edge 46 → 537.5, so its centre lands on
    /// the destination column's own centre — pixel parity with the settled surface at both
    /// ends, exact (never rounded) at the endpoints where the handoff happens.
    func testGreetingTravelsAsOneBlock() {
        let flight = closed
        XCTAssertEqual(flight.greetingX(at: 0), flight.dockedColumnX)
        XCTAssertEqual(flight.greetingX(at: 0), 46)
        XCTAssertEqual(flight.greetingX(at: 1), flight.dockedColumnX + flight.columnShift)
        XCTAssertEqual(flight.greetingX(at: 1), 537.5)
        // Whole points through the interior of the travel.
        let mid = flight.greetingX(at: 0.5)
        XCTAssertEqual(mid, mid.rounded())
    }

    /// The block hangs `--spacing-10` under the orb on both surfaces — y never moves.
    func testGreetingTopIsTheSharedChain() {
        XCTAssertEqual(closed.greetingTop, closed.orbTop + PresentationFlight.orbFrame.height + DS.Space.s10)
        XCTAssertEqual(closed.greetingTop, 328)
    }

    /// The greeting rides one stagger behind the orb: still at the anchor through the first
    /// 5% of the travel, together with everything at both ends.
    func testGreetingStaggersBehindTheOrb() {
        XCTAssertEqual(PresentationMorph.leadStaggered(0), 0)
        XCTAssertEqual(PresentationMorph.leadStaggered(0.05), 0)
        XCTAssertEqual(PresentationMorph.leadStaggered(1), 1)
        for step in stride(from: CGFloat(0.1), to: 1, by: 0.1) {
            XCTAssertLessThanOrEqual(
                PresentationMorph.leadStaggered(step),
                PresentationMorph.lead(step) + 1e-9,
                "the greeting must not outrun the orb at \(step)"
            )
        }
    }

    /// The orb's endpoints are exact too — the interior rounds, the ends never do.
    func testFlightEndpointsAreExact() {
        let flight = closed
        XCTAssertEqual(flight.orbX(at: 0), flight.dockedOrbX)
        XCTAssertEqual(flight.orbX(at: 1), flight.dockedOrbX + flight.columnShift)
    }

    // MARK: - The chips

    /// The one genuine width interpolation in the hi state: 301 → 600, linear on the finger,
    /// while the leading edge travels 46 → 388 on the lead curve.
    func testChipsStretchLinearlyWhileTravelling() {
        let flight = closed
        XCTAssertEqual(flight.chipsWidth(at: 0), 301)
        XCTAssertEqual(flight.chipsWidth(at: 1), 600)
        XCTAssertEqual(flight.chipsWidth(at: 0.5), DrawerReveal.wholePoints(450.5))
        XCTAssertEqual(flight.chipsX(at: 0), 46)
        XCTAssertEqual(flight.chipsX(at: 1), 388)
        // The lead curve carries x ahead of the linear width.
        XCTAssertGreaterThan(flight.chipsX(at: 0.5), 46 + 0.5 * 342)
    }

    /// The stack hangs off the greeting's own chain — `--spacing-8` under the subtitle,
    /// identical at both ends because both surfaces draw the panel-treatment block.
    func testChipsTopIsTheGreetingsChain() {
        let greeting = GreetingMetrics.for(.panel, width: closed.dockedColumnWidth)
        XCTAssertEqual(
            closed.chipsTop,
            closed.greetingTop + greeting.titleHeight + greeting.subtitleTopMargin
                + greeting.subtitleHeight + (greeting.suggestionsTopMargin ?? 0)
        )
        XCTAssertEqual(closed.chipsTop, 452)
    }

    /// The chips' centre lands where every other element's does: the destination column's
    /// own centre — leading edge plus half the width recovers the +491.5 at the far end.
    func testChipsCentreArrivesWithTheColumn() {
        let flight = closed
        let centreAtEnd = flight.chipsX(at: 1) + flight.chipsWidth(at: 1) / 2
        XCTAssertEqual(centreAtEnd, flight.fullColumnX + flight.fullColumnWidth / 2)
    }

    // MARK: - The composer

    /// The pill shares the chips' horizontal flight and adds the one vertical component:
    /// its bottom edge runs 986 → 1004, linear on the finger.
    func testComposerFliesWithTheColumnAndDropsToTheBand() {
        let flight = closed
        XCTAssertEqual(flight.composerX(at: 0), 46)
        XCTAssertEqual(flight.composerX(at: 1), 388)
        XCTAssertEqual(flight.composerWidth(at: 0), 301)
        XCTAssertEqual(flight.composerWidth(at: 1), 600)
        XCTAssertEqual(flight.composerBottom(at: 0), 986)
        XCTAssertEqual(flight.composerBottom(at: 1), 1004)
        XCTAssertEqual(flight.composerBottom(at: 0.5), DrawerReveal.wholePoints(995))
    }

    /// The marquee's slot — glyph + gap, 34 — folds to zero toward the wide pill, which
    /// draws no marquee at rest; with a selection attached it holds at both ends, because
    /// then the wide pill draws it too.
    func testMarqueeSlotFoldsUnlessASelectionHolds()  {
        let flight = closed
        let slot = Icon.uiSelectionMarker.renderSize + ComposerMetrics.panel.gap
        XCTAssertEqual(flight.composerMarqueeSlot(at: 0, isSelectionAttached: false), slot)
        XCTAssertEqual(flight.composerMarqueeSlot(at: 1, isSelectionAttached: false), 0)
        XCTAssertEqual(flight.composerMarqueeSlot(at: 0.5, isSelectionAttached: false), slot / 2)
        for step in stride(from: CGFloat(0), through: 1, by: 0.25) {
            XCTAssertEqual(flight.composerMarqueeSlot(at: step, isSelectionAttached: true), slot)
        }
    }

    // MARK: - The toggle and the controls

    /// (46, 46) → (28, 28): 18 points in each axis, linear, exact at both ends — and it
    /// never fades, because it exists at both ends.
    func testToggleWalksItsEighteenPoints() {
        let flight = closed
        XCTAssertEqual(flight.toggleX(at: 0), 46)
        XCTAssertEqual(flight.toggleY(at: 0), 46)
        XCTAssertEqual(flight.toggleX(at: 1), layout.contentLeft)
        XCTAssertEqual(flight.toggleY(at: 1), layout.contentTop)
        // With the sidebar open the toggle lands on the chat pane's own corner.
        XCTAssertEqual(open.toggleX(at: 1), layout.contentLeft + layout.sessionsSidebarWidth)
    }

    /// The unmatched pair fades over the first quarter with a 12pt trailing drift.
    func testControlsFadeEarlyAndDriftTrailing() {
        let flight = closed
        XCTAssertEqual(flight.dockedControlsOrigin.x, 46 + 301 - PresentationFlight.controlsPairWidth)
        XCTAssertEqual(PresentationMorph.controlsOpacity(at: 0), 1)
        XCTAssertEqual(PresentationMorph.controlsOpacity(at: PresentationMorph.controlsGoneBy), 0)
        XCTAssertEqual(PresentationMorph.controlsOpacity(at: 1), 0)
        XCTAssertEqual(flight.controlsX(at: 0), flight.dockedControlsOrigin.x)
        XCTAssertEqual(flight.controlsX(at: 1), flight.dockedControlsOrigin.x + 12)
    }

    // MARK: - The thread crossfade

    /// Overlapping (`FADE_MODE_CROSS`), mid-travel on the enter leg: no frame is blank.
    func testThreadTradesWithoutABlankFrame() {
        for step in stride(from: CGFloat(0), through: 1, by: 0.01) {
            for returnLeg in [false, true] {
                let sum = PresentationMorph.dockedThreadOpacity(at: step, returnLeg: returnLeg)
                    + PresentationMorph.fullThreadOpacity(at: step, returnLeg: returnLeg)
                XCTAssertGreaterThanOrEqual(sum, 0.75, "near-blank frame at \(step), return \(returnLeg)")
            }
        }
        // Exact at the ends, both legs.
        for returnLeg in [false, true] {
            XCTAssertEqual(PresentationMorph.dockedThreadOpacity(at: 0, returnLeg: returnLeg), 1)
            XCTAssertEqual(PresentationMorph.fullThreadOpacity(at: 0, returnLeg: returnLeg), 0)
            XCTAssertEqual(PresentationMorph.dockedThreadOpacity(at: 1, returnLeg: returnLeg), 0)
            XCTAssertEqual(PresentationMorph.fullThreadOpacity(at: 1, returnLeg: returnLeg), 1)
        }
    }

    /// The return leg commits late — Material's own asymmetry: its bands sit higher up the
    /// travel than the enter leg's.
    func testReturnLegTradesLater() {
        // At 0.5 the enter leg has mostly traded; the return leg has barely started.
        XCTAssertLessThan(
            PresentationMorph.dockedThreadOpacity(at: 0.5, returnLeg: false),
            PresentationMorph.dockedThreadOpacity(at: 0.5, returnLeg: true)
        )
    }

    /// The incoming thread arrives rather than appears: from 60pt short of home, landing
    /// exactly on the settled column.
    func testFullThreadArrivesFromShortOfHome() {
        let flight = closed
        XCTAssertEqual(flight.fullThreadX(at: 0), flight.fullColumnX - 60)
        XCTAssertEqual(flight.fullThreadX(at: 1), flight.fullColumnX)
        XCTAssertEqual(flight.dockedThreadX(at: 0), 46)
    }

    // MARK: - The lead curve

    /// `1 − (1 − p)²`: identity at both ends, ahead of the finger everywhere between —
    /// content settles before the container does.
    func testLeadCurveRunsAheadOfTheFinger() {
        XCTAssertEqual(PresentationMorph.lead(0), 0)
        XCTAssertEqual(PresentationMorph.lead(1), 1)
        XCTAssertEqual(PresentationMorph.lead(0.5), 0.75, accuracy: 1e-9)
        for step in stride(from: CGFloat(0.05), to: 1, by: 0.05) {
            XCTAssertGreaterThan(PresentationMorph.lead(step), step)
        }
        // Clamped: an overshooting spring renders the endpoint, not an extrapolation.
        XCTAssertEqual(PresentationMorph.lead(-0.5), 0)
        XCTAssertEqual(PresentationMorph.lead(1.5), 1)
    }

    /// The lead is the whole of the orb's easing: at any point the orb has covered the led
    /// fraction of its travel.
    func testOrbRidesTheLeadCurve() {
        let flight = closed
        for step in stride(from: CGFloat(0), through: 1, by: 0.1) {
            let expected = flight.dockedOrbX + PresentationMorph.lead(step) * flight.columnShift
            XCTAssertEqual(flight.orbX(at: step), DrawerReveal.wholePoints(expected))
        }
    }

    // MARK: - The flock

    /// One curve family, staggered departures: the orb leads bare, the greeting follows at
    /// 5%, the chips at 8%, the pill at 10% — and every stagger still lands exactly at both
    /// ends, because the remap only shifts the interior.
    func testFlockDepartsInOrderAndArrivesTogether() {
        XCTAssertEqual(PresentationMorph.greetingStagger, 0.05)
        XCTAssertEqual(PresentationMorph.chipsStagger, 0.08)
        XCTAssertEqual(PresentationMorph.composerStagger, 0.10)
        for stagger in [PresentationMorph.greetingStagger,
                        PresentationMorph.chipsStagger,
                        PresentationMorph.composerStagger] {
            XCTAssertEqual(PresentationMorph.leadStaggered(0, by: stagger), 0)
            XCTAssertEqual(PresentationMorph.leadStaggered(stagger, by: stagger), 0)
            XCTAssertEqual(PresentationMorph.leadStaggered(1, by: stagger), 1)
        }
        // Departure order holds through the interior: rear never outruns front.
        for step in stride(from: CGFloat(0.05), to: 1, by: 0.05) {
            let orb = PresentationMorph.lead(step)
            let greeting = PresentationMorph.leadStaggered(step, by: PresentationMorph.greetingStagger)
            let chips = PresentationMorph.leadStaggered(step, by: PresentationMorph.chipsStagger)
            let pill = PresentationMorph.leadStaggered(step, by: PresentationMorph.composerStagger)
            XCTAssertLessThanOrEqual(greeting, orb + 1e-9, "at \(step)")
            XCTAssertLessThanOrEqual(chips, greeting + 1e-9, "at \(step)")
            XCTAssertLessThanOrEqual(pill, chips + 1e-9, "at \(step)")
        }
    }

    /// The pill rides its own beat now, no longer welded to the chips — but the two still
    /// agree exactly at both ends.
    func testComposerTrailsTheChipsThroughTheInterior() {
        let flight = closed
        XCTAssertEqual(flight.composerX(at: 0), flight.chipsX(at: 0))
        XCTAssertEqual(flight.composerX(at: 1), flight.chipsX(at: 1))
        XCTAssertLessThan(flight.composerX(at: 0.4), flight.chipsX(at: 0.4))
    }

    // MARK: - The dip

    /// `scale(p) = 1 − depth·sin(π·p)`: exactly 1 at both endpoints — pixel parity is not
    /// negotiable — minimum at mid-flight, symmetric, clamped outside the travel so an
    /// overshooting settle spring renders the endpoint and never a magnified frame.
    func testDipIsExactlyOneAtTheEndsAndBreathesBetween() {
        XCTAssertEqual(PresentationMorph.flightScale(at: 0), 1)
        XCTAssertEqual(PresentationMorph.flightScale(at: 1), 1)
        XCTAssertEqual(
            PresentationMorph.flightScale(at: 0.5),
            1 - PresentationMorph.flightDipDepth,
            accuracy: 1e-9
        )
        XCTAssertEqual(
            PresentationMorph.flightScale(at: 0.25),
            PresentationMorph.flightScale(at: 0.75),
            accuracy: 1e-9
        )
        XCTAssertEqual(PresentationMorph.flightScale(at: -0.5), 1)
        XCTAssertEqual(PresentationMorph.flightScale(at: 1.5), 1)
        // The depth stays in the judged band.
        XCTAssertGreaterThanOrEqual(PresentationMorph.flightDipDepth, 0.04)
        XCTAssertLessThanOrEqual(PresentationMorph.flightDipDepth, 0.08)
    }

    /// One shared anchor, the container's centre — never a per-element anchor.
    func testDipAnchorsOnTheContainersCentre() {
        let morph = PresentationMorph(layout: layout, isSidebarOpen: false)
        for step in stride(from: CGFloat(0), through: 1, by: 0.25) {
            let frame = morph.containerFrame(at: step)
            let anchor = morph.flightDipAnchor(at: step)
            XCTAssertEqual(anchor.x, frame.midX / layout.screenWidth, accuracy: 1e-9)
            XCTAssertEqual(anchor.y, frame.midY / layout.screenHeight, accuracy: 1e-9)
        }
    }

    // MARK: - End states, both legs

    /// Every fade and every mount-facing opacity at both endpoints, on both legs — the
    /// frame the settled surface takes over from must be exactly the surface's own, and a
    /// reversed gesture must retrace to exactly the frame it left.
    func testEndStateOpacitiesArePinnedOnBothLegs() {
        let morph = closed
        for returnLeg in [false, true] {
            // Docked end: panel chrome at full strength, nothing of the far end visible.
            XCTAssertEqual(PresentationMorph.controlsOpacity(at: 0), 1)
            XCTAssertEqual(morph.panelShadowOpacity(at: 0), 1)
            XCTAssertEqual(morph.panelFillOpacity(at: 0), 1)
            XCTAssertEqual(morph.peekOpacity(at: 0), 0)
            XCTAssertEqual(PresentationMorph.dockedThreadOpacity(at: 0, returnLeg: returnLeg), 1)
            XCTAssertEqual(PresentationMorph.fullThreadOpacity(at: 0, returnLeg: returnLeg), 0)
            XCTAssertEqual(morph.boardShift(at: 0), 0)
            XCTAssertEqual(PresentationMorph.flightScale(at: 0), 1)
            // Full-screen end: the far end at full strength, the panel's chrome gone.
            XCTAssertEqual(PresentationMorph.controlsOpacity(at: 1), 0)
            XCTAssertEqual(morph.panelShadowOpacity(at: 1), 0)
            XCTAssertEqual(morph.panelFillOpacity(at: 1), 0)
            XCTAssertEqual(morph.peekOpacity(at: 1), 1)
            XCTAssertEqual(PresentationMorph.dockedThreadOpacity(at: 1, returnLeg: returnLeg), 0)
            XCTAssertEqual(PresentationMorph.fullThreadOpacity(at: 1, returnLeg: returnLeg), 1)
            XCTAssertEqual(morph.boardShift(at: 1), morph.boardTravel)
            XCTAssertEqual(PresentationMorph.flightScale(at: 1), 1)
        }
    }
}
