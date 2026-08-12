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
}
