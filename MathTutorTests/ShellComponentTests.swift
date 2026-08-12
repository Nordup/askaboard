import CoreGraphics
import SwiftUI
import UIKit
import XCTest
@testable import MathTutor

/// The shell's load-bearing numbers.
///
/// These are the values that drift silently: nothing crashes when the rail comes out 617
/// instead of 627.5, and nothing looks obviously wrong until the boards are held side by
/// side. Board 02 records that the rail has already been flattened onto the 4pt scale once
/// by a tool that rewrote the source node as well as the clone, so the arithmetic is
/// asserted here rather than trusted.
///
/// Since the shell became size-driven there is a second class of drift to catch, and it is
/// the one that put a third of the interface off a real iPad: a component that keeps a number
/// which was only ever true of one screen. So every assertion below is either about a
/// component's *internal* spec — which is fixed, and must be identical at every size — or
/// about what a component does with geometry it is handed, checked at four real device sizes
/// rather than one.
final class ShellComponentTests: XCTestCase {
    // MARK: - Tool rail

    func testToolRailChainSumsToTheBoardsVerifiedHeight() {
        XCTAssertEqual(
            ToolRailMetrics.height,
            627.5,
            "Board 02: 'if a Swift port ever measures the rail at 617, it copied the corrupted state.'"
        )
    }

    func testToolRailChainIsTheBoardsChainStepByStep() {
        XCTAssertEqual(ToolRailMetrics.chain.count, Self.boardsRailChain.count, "The rail has exactly five children")
        for (step, want) in zip(ToolRailMetrics.chain, Self.boardsRailChain) {
            XCTAssertEqual(step.name, want.name)
            XCTAssertEqual(step.marginTop, want.marginTop, "\(want.name) margin-top")
            XCTAssertEqual(step.height, want.height, "\(want.name) height")
        }

        // The chain has to be re-derivable by hand from the board's own Stack row.
        let sum = 9 + 226.5 + 11.5 + 1.5 + 19.5 + 243 + 29 + 5 + 19.5 + 54 + 9 as CGFloat
        XCTAssertEqual(ToolRailMetrics.height, sum)
    }

    func testToolRailPaddingIsBlockNineAndNotFoldedIntoAMargin() {
        XCTAssertEqual(ToolRailMetrics.paddingBlock, 9)
        // Board 02: 'do not "simplify" this into a single large padding value, which is the
        // bug this rail already had once'. The tell is the padding growing to absorb a
        // child's margin, so the two are pinned separately.
        XCTAssertEqual(ToolRailMetrics.chain.first?.marginTop, 0, "Tools is the first child and takes no margin")
    }

    func testToolsBlockIsTwoHundredAndTwentySixPointFive() {
        XCTAssertEqual(ToolRailMetrics.toolsHeight, 226.5)
        XCTAssertEqual(ToolRailMetrics.toolsGap, 3.5, "Off-grid and deliberate — not 0 and not 4")
        XCTAssertEqual(ToolRailMetrics.slot, 54)
        XCTAssertEqual(BoardTool.allCases.count, 4, "The block's height is 4 × 54 + 3 × 3.5")
    }

    func testSwatchesBlockIsTwoHundredAndFortyThree() {
        XCTAssertEqual(ToolRailMetrics.swatchesHeight, 243)
        XCTAssertEqual(ToolRailMetrics.swatch, 27)
        XCTAssertEqual(ToolRailMetrics.swatchGap, 27, "Halving the gap to tidy the grid halves the tap target")
        XCTAssertEqual(PenColor.allCases.count, 5, "The block's height is 5 × 27 + 4 × 27")
    }

    func testDividerIsOnePointFiveTall() {
        XCTAssertEqual(
            ToolRailMetrics.dividerHeight,
            1.5,
            "Board 02: '1.5, not 1 or 2. A tree-summary read of 46 × 2 is rounding.'"
        )
        XCTAssertEqual(ToolRailMetrics.dividerWidth, 46)
    }

    func testThicknessBarRadiusIsHalfItsHeightSoTheCapsStaySemicircles() {
        XCTAssertEqual(ToolRailMetrics.thicknessWidth, 36)
        XCTAssertEqual(ToolRailMetrics.thicknessHeight, 5)
        XCTAssertEqual(ToolRailMetrics.thicknessRadius, 2.5)
        // The design's one pinned stroke width is this bar, so the default ink has to draw
        // the bar the board draws.
        XCTAssertEqual(StrokeThickness.defaultValue.pointWidth, ToolRailMetrics.thicknessHeight)
    }

    func testThicknessMarginsAreTheBuiltValuesNotTheProseOnes() {
        // Board 02 flags the contradiction itself: the blurb says '28pt and 20pt', the build
        // says 29 and 19.5, and only the build reaches 627.5.
        XCTAssertEqual(ToolRailMetrics.thicknessMarginTop, 29)
        XCTAssertEqual(ToolRailMetrics.centreMarginTop, 19.5)
    }

    func testToolRailOpticalMarginsAreTwentyTwoAndTwentyThree() {
        // '22 top / 23 bottom · = 9 padding + 13/14 slot centring' — the stated reason the
        // 54pt slot may not be shrunk to fit its glyph.
        XCTAssertEqual(ToolRailMetrics.topOpticalMargin, 22)
        XCTAssertEqual(ToolRailMetrics.bottomOpticalMargin, 23)
    }

    func testToolRailIsSeventyTwoWideWithATwentyPointRadius() {
        XCTAssertEqual(ToolRailMetrics.width, 72)
        XCTAssertEqual(ToolRailMetrics.width, DS.Container.rail)
        XCTAssertEqual(ToolRailMetrics.cornerRadius, DS.Radius.xxl)
    }

    // MARK: - Tool rail · the chain does not move when the screen does

    /// The rail is the one component whose internals are *not* size-driven, on purpose. Its
    /// chain is hand-tuned and the board says twice not to re-tune it, so the screen is only
    /// allowed to change where the rail is — never what it is.
    func testToolRailChainIsIdenticalAtEverySize() {
        for band in Band.all {
            XCTAssertEqual(ToolRailMetrics.height, 627.5, band.name)
            XCTAssertEqual(ToolRailMetrics.chain.count, Self.boardsRailChain.count, band.name)
            for (step, want) in zip(ToolRailMetrics.chain, Self.boardsRailChain) {
                XCTAssertEqual(step.name, want.name, band.name)
                XCTAssertEqual(step.marginTop, want.marginTop, "\(band.name) · \(want.name) margin-top")
                XCTAssertEqual(step.height, want.height, "\(band.name) · \(want.name) height")
            }
        }
    }

    func testToolRailFitsEveryRealDeviceBandAndStaysFitContentThere() {
        for band in Band.all {
            let layout = band.layout
            XCTAssertGreaterThanOrEqual(
                layout.contentHeight,
                ToolRailMetrics.height,
                "\(band.name): the rail has to fit the content band of a full-screen iPad"
            )
            XCTAssertEqual(ToolRailMetrics.fit(inBandOfHeight: layout.contentHeight), .fitContent, band.name)
            XCTAssertEqual(
                ToolRailMetrics.renderedHeight(inBandOfHeight: layout.contentHeight),
                627.5,
                "\(band.name): a band with room to spare must not stretch the rail"
            )
            XCTAssertLessThanOrEqual(
                layout.contentTop + ToolRailMetrics.height,
                layout.contentBottom,
                "\(band.name): the rail's bottom stays inside the content band"
            )
        }
        // The narrowest, shortest iPad the app runs on is the one with the least room, and it
        // still has 64.5 to spare — which is why the rail's chain never had to be touched.
        // It was 672 while the status region was floored at the design's 40; a home-button
        // iPad reserves 20, so the band it actually gets is 20 taller than that.
        XCTAssertEqual(Band.devices.last?.layout.contentHeight, 692, "iPad 6th gen: 768 − 48 − 28")
    }

    /// The documented choice for the case no board draws: the chain is never re-tuned,
    /// re-scaled or truncated — it scrolls inside a rail that fills the band.
    func testAShortBandScrollsTheRailRatherThanClippingOrRetuningIt() {
        let short = ToolRailMetrics.height - 100

        XCTAssertEqual(ToolRailMetrics.fit(inBandOfHeight: short), .scrolls)
        XCTAssertEqual(
            ToolRailMetrics.renderedHeight(inBandOfHeight: short),
            short,
            "The rail fills the band it cannot fit in, so nothing hangs off the bottom"
        )
        // The whole point of scrolling rather than scaling: every value survives.
        XCTAssertEqual(ToolRailMetrics.height, 627.5)
        XCTAssertEqual(ToolRailMetrics.slot, 54, "Still a legal tap target in a short band")
        XCTAssertEqual(ToolRailMetrics.swatchPitch, 54, "Still a legal tap target in a short band")
        XCTAssertEqual(ToolRailMetrics.chain.map(\.extent), Self.boardsRailChain.map { $0.marginTop + $0.height })
    }

    func testTheBoundaryBetweenTheTwoFitsIsTheChainsOwnHeight() {
        XCTAssertEqual(ToolRailMetrics.fit(inBandOfHeight: ToolRailMetrics.height), .fitContent, "Exactly enough is enough")
        XCTAssertEqual(ToolRailMetrics.fit(inBandOfHeight: ToolRailMetrics.height - 0.5), .scrolls)
    }

    func testAnImpossibleBandStillProducesANonNegativeRail() {
        // A frame with a negative side is a runtime layout error rather than a small screen.
        XCTAssertEqual(ToolRailMetrics.renderedHeight(inBandOfHeight: 0), 0)
        XCTAssertEqual(ToolRailMetrics.renderedHeight(inBandOfHeight: -200), 0)
    }

    // MARK: - Tap targets

    func testSwatchTapTargetReachesTheFullPitchEvenThoughTheDotIsTwentySeven() {
        XCTAssertEqual(ToolRailMetrics.swatch, 27, "The drawn circle stays 27")
        XCTAssertEqual(ToolRailMetrics.swatchPitch, 54)
        XCTAssertGreaterThanOrEqual(ToolRailMetrics.swatchPitch, 44, "HIG minimum")
        // Consecutive targets on the pitch must tile without overlapping, which is what
        // makes the expanded target safe to apply inside a 243pt column.
        XCTAssertEqual(ToolRailMetrics.swatchPitch, ToolRailMetrics.swatch + ToolRailMetrics.swatchGap)
    }

    func testToolSlotIsAlreadyALegalTapTarget() {
        XCTAssertGreaterThanOrEqual(ToolRailMetrics.slot, 44)
    }

    func testPanelControlsGetAnExpandedTapTargetTheDesignDoesNotSpecify() {
        XCTAssertEqual(TutorPanelMetrics.controlButton, 32, "The drawn button stays 32")
        XCTAssertGreaterThanOrEqual(TutorPanelMetrics.controlTapTarget, 44)
        // 44 targets on a 32 + 14 pitch must not overlap, or one button would steal the
        // other's taps.
        let pitch = TutorPanelMetrics.controlButton + TutorPanelMetrics.controlsGap
        XCTAssertLessThanOrEqual(TutorPanelMetrics.controlTapTarget, pitch)
    }

    func testCollapsedDockSelectButtonIsALegalTapTarget() {
        XCTAssertGreaterThanOrEqual(CollapsedDockMetrics.selectButton, 44)
        XCTAssertGreaterThanOrEqual(CollapsedDockMetrics.orb, 44)
    }

    // MARK: - Tutor panel

    func testPanelContentWidthIsDerivedFromTheInsetRatherThanHardCoded() {
        XCTAssertEqual(TutorPanelMetrics.width, 337)
        XCTAssertEqual(TutorPanelMetrics.inset, 18)
        XCTAssertEqual(
            TutorPanelMetrics.contentWidth,
            301,
            "Board 02: 'panel 337 − 2 × inset 18 = content 301 · derive it, never hard-code'"
        )
        XCTAssertEqual(TutorPanelMetrics.contentWidth, DS.Container.panelContent)
        // The inset has to hold on both sides, which is the same statement read the other
        // way round and the one that catches a one-sided padding.
        XCTAssertEqual((TutorPanelMetrics.width - TutorPanelMetrics.contentWidth) / 2, TutorPanelMetrics.inset)
    }

    /// Board 02's rule with the literal removed: *"panel width minus twice the panel inset
    /// equals the content width"* — for any panel width, not just for 337.
    func testPanelContentColumnIsTheWidthLessTwiceTheInsetWhateverTheWidth() {
        let widths: [CGFloat] = [337, 301, 400, 512, 740] + Band.all.map(\.layout.screenWidth)
        for width in widths {
            XCTAssertEqual(
                TutorPanelMetrics.contentWidth(for: width),
                width - 2 * TutorPanelMetrics.inset,
                "panel \(width)"
            )
            XCTAssertEqual(
                (width - TutorPanelMetrics.contentWidth(for: width)) / 2,
                TutorPanelMetrics.inset,
                "panel \(width): the inset holds on both sides"
            )
        }
        XCTAssertEqual(TutorPanelMetrics.contentWidth(for: TutorPanelMetrics.width), 301, "The design's own case")
    }

    func testPanelContentColumnNeverGoesNegative() {
        // 36 is where the two insets meet; below it a stored `width − 36` would hand
        // `.frame` a negative side.
        XCTAssertEqual(TutorPanelMetrics.contentWidth(for: 36), 0)
        XCTAssertEqual(TutorPanelMetrics.contentWidth(for: 10), 0)
        XCTAssertEqual(TutorPanelMetrics.contentWidth(for: 0), 0)
    }

    func testPanelKeepsItsOwnSpecAndTakesOnlyItsHeightFromTheScreen() {
        XCTAssertEqual(TutorPanelMetrics.cornerRadius, DS.Radius.xxxl)
        XCTAssertEqual(TutorPanelMetrics.controlsHeight, 32)
        XCTAssertEqual(TutorPanelMetrics.controlsGap, 14)
        // The panel stays `--container-panel` wide at every size — Board 02 calls it "the only
        // fixed-width surface in the product" and the narrowest iPad still leaves a board
        // beside it — so the height is the one number the screen supplies.
        for band in Band.all {
            XCTAssertEqual(band.layout.panelWidth, TutorPanelMetrics.width, band.name)
            XCTAssertEqual(TutorPanelMetrics.contentWidth(for: band.layout.panelWidth), 301, band.name)
            XCTAssertEqual(band.layout.panelContentWidth, TutorPanelMetrics.contentWidth, band.name)
            XCTAssertGreaterThan(band.layout.contentHeight, 0, band.name)
        }
        // At the size the board was drawn at, the panel's height is still the board's 976.
        XCTAssertEqual(Band.reference.layout.contentHeight, 976)
    }

    // MARK: - Collapsed dock

    func testCollapsedDockWidthIsTheSumOfItsParts() {
        XCTAssertEqual(
            CollapsedDockMetrics.width,
            CollapsedDockMetrics.selectButton + CollapsedDockMetrics.gap + CollapsedDockMetrics.orb
        )
        XCTAssertEqual(CollapsedDockMetrics.width, 132)
        XCTAssertEqual(CollapsedDockMetrics.gap, DS.Space.s4)
        XCTAssertEqual(
            CollapsedDockMetrics.height,
            OrbSize.dock.metrics.frame.height,
            "Board 02: 'The orb sets the row height.'"
        )
        XCTAssertEqual(CollapsedDockMetrics.height, 64)
    }

    /// Board 02: *"the dock anchors to the board, not the screen: 24pt inside the board's
    /// bottom-right corner … anchor to the board rect and the dock follows it for free."*
    /// Which is exactly what has to keep working once the board rect stops being 1224 × 936.
    func testCollapsedDockStaysInsideTheBoardAtEverySize() {
        for band in Band.all {
            let layout = band.layout
            // The row the component draws and the slot the layout reserves for it are the
            // same size, or the anchor is measured against the wrong rectangle.
            XCTAssertEqual(layout.collapsedDockWidth, CollapsedDockMetrics.width, band.name)
            XCTAssertEqual(layout.collapsedDockHeight, CollapsedDockMetrics.height, band.name)

            XCTAssertGreaterThan(layout.collapsedDockX, layout.boardX, band.name)
            XCTAssertEqual(
                layout.collapsedDockX + CollapsedDockMetrics.width + DS.Space.gap,
                layout.boardX + layout.boardWidthCollapsed,
                "\(band.name): 24 inside the collapsed board's right edge"
            )
            XCTAssertEqual(
                layout.collapsedDockY + CollapsedDockMetrics.height + DS.Space.gap,
                layout.contentBottom,
                "\(band.name): 24 inside the board's bottom edge"
            )
            XCTAssertGreaterThan(layout.collapsedDockY, layout.contentTop, band.name)
        }
        // The design's own reading of the same anchor on the board it was drawn on.
        XCTAssertEqual(Band.reference.layout.collapsedDockX, 1192)
        XCTAssertEqual(Band.reference.layout.collapsedDockY, 916)
    }

    // MARK: - Whiteboard

    func testWhiteboardKeepsOneHeightAndTwoWidthsAtEverySize() {
        XCTAssertEqual(WhiteboardMetrics.cornerRadius, DS.Radius.xxxl)
        for band in Band.all {
            let layout = band.layout
            // 'Only its width changes when the tutor docks or collapses' — the collapsed board
            // absorbs the gap it used to sit behind plus the panel.
            XCTAssertEqual(
                layout.boardWidthCollapsed,
                layout.boardWidthDocked + DS.Space.gap + DS.Container.panel,
                band.name
            )
            XCTAssertGreaterThan(layout.boardWidthDocked, 0, "\(band.name): the board has width left over")
            XCTAssertGreaterThan(layout.contentHeight, 0, band.name)
            // 'a constant top-left origin in every state' — the origin does not move between
            // the two widths, which is what lets the ink layer stay put.
            XCTAssertEqual(layout.boardX, DS.Space.edge + DS.Container.rail + DS.Space.gap, band.name)
            // And every size the app supports can still host the three-lane design, so no
            // component is ever asked to draw itself into a lane that does not exist.
            XCTAssertEqual(layout.fit, .threeLane, band.name)
        }
    }

    /// The three numbers the component used to carry, now produced by the design's rule at
    /// the size the design was drawn at.
    func testTheDesignsOwnBoardSizesFallOutOfTheRuleAtTheReferenceSize() {
        let layout = Band.reference.layout
        XCTAssertEqual(layout.contentHeight, 976, "1032 − 28 − 28")
        XCTAssertEqual(layout.boardWidthDocked, 863)
        XCTAssertEqual(layout.boardWidthCollapsed, 1224)
        XCTAssertEqual(layout.boardX, 124, "28 + 72 + 24")
        XCTAssertEqual(layout.panelX, 1011, "1376 − 28 − 337")
        XCTAssertEqual(layout.contentTop, 28, "nothing is reserved, so content starts at 0 + 28")
    }

    func testTheLanesNeverOverlapOrGoNegativeAtAnyRealDeviceSize() {
        for band in Band.all {
            let layout = band.layout
            XCTAssertGreaterThan(layout.contentTop, 0, band.name)
            XCTAssertGreaterThan(layout.contentHeight, 0, band.name)
            // Rail, gap, board, gap, panel, in that order, with nothing touching.
            XCTAssertEqual(layout.railX, DS.Space.edge, band.name)
            XCTAssertEqual(
                layout.boardX - (layout.railX + DS.Container.rail),
                DS.Space.gap,
                "\(band.name): rail↔board gap"
            )
            XCTAssertEqual(
                layout.panelX - (layout.boardX + layout.boardWidthDocked),
                DS.Space.gap,
                "\(band.name): board↔panel gap"
            )
            XCTAssertEqual(
                layout.screenWidth - (layout.panelX + layout.panelWidth),
                DS.Space.edge,
                "\(band.name): the panel keeps its edge inset"
            )
            // Collapsed, the board takes the panel's lane and stops at the same edge inset.
            XCTAssertEqual(
                layout.screenWidth - (layout.boardX + layout.boardWidthCollapsed),
                DS.Space.edge,
                "\(band.name): collapsed board keeps the edge inset"
            )
            for region in layout.namedRegions {
                XCTAssertGreaterThanOrEqual(region.width, 0, "\(band.name): \(region.name) width")
                XCTAssertGreaterThanOrEqual(region.x, 0, "\(band.name): \(region.name) x")
                XCTAssertLessThanOrEqual(
                    region.x + region.width,
                    layout.screenWidth,
                    "\(band.name): \(region.name) stays on screen"
                )
            }
        }
    }

    /// The design's bottom inset is `--space-edge` 28 measured from the screen. On a device
    /// with a home indicator it composes with the real inset rather than ignoring it: 28 of
    /// air *below* the content and above the indicator, not 28 that happens to swallow it.
    /// The alternative — `max(28, indicator)` — would leave the indicator's own 20pt as the
    /// only clearance and make the design's inset disappear on exactly the devices that have
    /// one.
    func testTheBottomEdgeInsetComposesWithTheHomeIndicatorRatherThanIgnoringIt() {
        for band in Band.all {
            let layout = band.layout
            let bottomInset = layout.screenHeight - layout.contentBottom
            XCTAssertEqual(bottomInset, layout.safeAreaBottom + DS.Space.edge, band.name)
            XCTAssertGreaterThanOrEqual(
                bottomInset - layout.safeAreaBottom,
                DS.Space.edge,
                "\(band.name): --space-edge survives above the indicator"
            )
        }
        // A home button is an inset of 0, so the design's own number is what is left.
        XCTAssertEqual(
            Band.devices.last?.layout.contentBottom,
            740,
            "iPad 6th gen has no home indicator: 768 − 0 − 28"
        )
    }

    func testDotGridPitchIsUnequalAndNotTwentyFour() {
        XCTAssertEqual(DotGrid.pitch.width, 23.9)
        XCTAssertEqual(DotGrid.pitch.height, 24.5)
        XCTAssertNotEqual(DotGrid.pitch.width, DotGrid.pitch.height, "The pitch is not square")
        XCTAssertEqual(DotGrid.dotRadius, 1.4)
    }

    // MARK: - Board peek

    func testBoardPeekIsFlushLeftAndSpansTheContentBand() {
        XCTAssertEqual(BoardPeekMetrics.width, 68, "The tab width is the silhouette's, not the screen's")
        XCTAssertEqual(BoardPeekMetrics.referenceHeight, 976)
        for band in Band.all {
            let layout = band.layout
            XCTAssertEqual(layout.peekX, 0, "\(band.name): board 01 rule 14 — flush left with no 28 inset")
            XCTAssertEqual(layout.peekWidth, BoardPeekMetrics.width, band.name)
            XCTAssertGreaterThan(layout.contentHeight, BoardPeekShape.minimumHeight, band.name)
            // The peek is the board's edge, so it ends level with where the board ends.
            XCTAssertEqual(layout.contentTop + layout.contentHeight, layout.contentBottom, band.name)
        }
    }

    func testBoardPeekShadowTakesTheFilterBlurUnhalved() {
        // A CSS `filter: blur(5px)` is already the Gaussian's standard deviation, unlike a
        // box-shadow blur, which is twice it. `Elevation.Layer` halves; this must not.
        XCTAssertEqual(BoardPeekMetrics.shadowRadius, 5)
        XCTAssertEqual(Elevation.canvasLift.shadowRadius, Elevation.canvasLift.blur / 2)
        XCTAssertEqual(BoardPeekMetrics.shadowOpacity, 0.11)
        XCTAssertEqual(BoardPeekMetrics.shadowOffset, CGSize(width: 3, height: 2))
    }

    func testBoardPeekSilhouetteIsTheDesignsPathAndNotARoundedRectangle() {
        // Re-authoring the path at a height has to reproduce the board's `d` exactly at the
        // height the board drew it at, or the reference screenshot and the shape diverge.
        XCTAssertEqual(
            BoardPeekShape.pathData,
            "M0,0 H50 A18,18 0 0 1 68,18 V46 A18,18 0 0 1 50,64 H46 "
                + "A18,18 0 0 0 28,82 V958 A18,18 0 0 1 10,976 H0 Z"
        )

        let path = BoardPeekShape().path(
            in: CGRect(x: 0, y: 0, width: BoardPeekMetrics.width, height: BoardPeekMetrics.referenceHeight)
        )
        XCTAssertFalse(path.isEmpty)
        XCTAssertEqual(path.boundingRect.width, 68, accuracy: 0.5)
        XCTAssertEqual(path.boundingRect.height, 976, accuracy: 0.5)
        // The notch is the whole point: below the tab the strip is 28 wide, so a point at
        // x 60 low down has to be outside the silhouette.
        XCTAssertTrue(path.contains(CGPoint(x: 34, y: 30)), "Inside the 68-wide tab")
        XCTAssertFalse(path.contains(CGPoint(x: 60, y: 500)), "Outside the 28-wide strip")
        XCTAssertTrue(path.contains(CGPoint(x: 14, y: 500)), "Inside the 28-wide strip")
    }

    /// The hinge is the feature the board calls load-bearing, and a non-uniform scale to a
    /// shorter band is what would flatten it. Only the strip between the fillets may shorten.
    func testBoardPeekStretchesTheStripAndNeverTheFillets() {
        for band in Band.all {
            let height = band.layout.contentHeight
            let path = BoardPeekShape().path(
                in: CGRect(x: 0, y: 0, width: BoardPeekMetrics.width, height: height)
            )
            XCTAssertEqual(path.boundingRect.width, 68, accuracy: 0.5, band.name)
            XCTAssertEqual(path.boundingRect.height, height, accuracy: 0.5, band.name)

            // The tab is authored, so these three hold at exactly the same coordinates at
            // every height — which is the assertion a scaled path fails.
            XCTAssertTrue(path.contains(CGPoint(x: 34, y: 30)), "\(band.name): inside the 68-wide tab")
            XCTAssertFalse(path.contains(CGPoint(x: 60, y: 100)), "\(band.name): the tab still ends by y 64")
            XCTAssertTrue(path.contains(CGPoint(x: 14, y: height / 2)), "\(band.name): inside the 28-wide strip")
            XCTAssertFalse(path.contains(CGPoint(x: 60, y: height / 2)), "\(band.name): outside the 28-wide strip")

            // The bottom fillet keeps r = 18 rather than being squashed with the strip.
            XCTAssertFalse(path.contains(CGPoint(x: 20, y: height - 2)), "\(band.name): outside the bottom fillet")
            XCTAssertTrue(path.contains(CGPoint(x: 12, y: height - 6)), "\(band.name): inside the bottom fillet")
        }
    }

    func testBoardPeekRefusesToDrawItselfShorterThanItsOwnTabAndFillet() {
        // Not a size — a floor, so an impossible band cannot invert the path.
        XCTAssertEqual(BoardPeekShape.minimumHeight, 100)
        let path = BoardPeekShape().path(in: CGRect(x: 0, y: 0, width: 68, height: 10))
        XCTAssertEqual(path.boundingRect.height, BoardPeekShape.minimumHeight, accuracy: 0.5)
    }

    // MARK: - Orb

    func testOrbSizesAreTheFourTheDesignDraws() {
        let expected: [OrbSize: CGSize] = [
            .hero: CGSize(width: 150, height: 142),
            .panel: CGSize(width: 96, height: 90),
            .dock: CGSize(width: 64, height: 64),
            .thread: CGSize(width: 46, height: 46),
        ]
        XCTAssertEqual(Set(expected.keys), Set(OrbSize.allCases))
        for (size, frame) in expected {
            XCTAssertEqual(size.metrics.frame, frame, "\(size.rawValue) frame")
        }
    }

    func testOnlyTheHeroOrbHasASmile() {
        XCTAssertNotNil(OrbSize.hero.metrics.smileOrigin)
        for size in OrbSize.allCases where size != .hero {
            XCTAssertNil(size.metrics.smileOrigin, "\(size.rawValue) must not draw a mouth")
        }
    }

    func testOrbBodyIsASquashedPillRatherThanACircle() {
        for size in OrbSize.allCases {
            let body = size.metrics.body
            XCTAssertGreaterThan(body.width, body.height, "\(size.rawValue) body is wider than it is tall")
        }
    }

    func testOrbHaloIsRoughlyTwiceTheFrameAndSitsHighOnTheTwoLargeSizes() {
        for size in OrbSize.allCases {
            let metrics = size.metrics
            XCTAssertGreaterThan(metrics.halo.width, metrics.frame.width * 1.8, "\(size.rawValue) halo width")
            XCTAssertGreaterThan(metrics.halo.height, metrics.frame.height * 1.8, "\(size.rawValue) halo height")
            XCTAssertEqual(metrics.haloCentreOffset.width, 0, accuracy: 0.001, "\(size.rawValue) halo is centred horizontally")
        }
        XCTAssertEqual(OrbSize.hero.metrics.haloCentreOffset.height, -7)
        XCTAssertEqual(OrbSize.panel.metrics.haloCentreOffset.height, -4)
        XCTAssertEqual(OrbSize.dock.metrics.haloCentreOffset.height, 0)
        XCTAssertEqual(OrbSize.thread.metrics.haloCentreOffset.height, 0)
    }

    func testOnlyTheHeroHaloBloomsHarder() {
        XCTAssertEqual(OrbSize.hero.metrics.bloomWarmAlphas, OrbBloomAlphas(start: 0.78, mid: 0.36))
        XCTAssertEqual(OrbSize.hero.metrics.bloomCoolAlphas, OrbBloomAlphas(start: 0.74, mid: 0.32))
        for size in OrbSize.allCases where size != .hero {
            XCTAssertEqual(size.metrics.bloomWarmAlphas, OrbBloomAlphas(start: 0.75, mid: 0.34), size.rawValue)
            XCTAssertEqual(size.metrics.bloomCoolAlphas, OrbBloomAlphas(start: 0.70, mid: 0.30), size.rawValue)
        }
        // 'not a single scalable asset' — the core ellipse's proportions differ per size, so
        // dock and thread share a recipe that neither hero nor panel does.
        XCTAssertEqual(OrbSize.dock.metrics.coreRadius, OrbSize.thread.metrics.coreRadius)
        XCTAssertNotEqual(OrbSize.hero.metrics.coreRadius, OrbSize.panel.metrics.coreRadius)
    }

    func testOrbEyesSitWhereTheDesignPutsThemRatherThanCentred() {
        // The three flex variants push their eye row down with a `padding-top`, so a centred
        // row is the tell that the padding was dropped on the way across.
        for size in OrbSize.allCases where size != .hero {
            let metrics = size.metrics
            let centredTop = (metrics.body.height - metrics.eye) / 2
            XCTAssertGreaterThan(metrics.eyeTop, centredTop, "\(size.rawValue) eye row")
        }
        // Hero is the exception, and in the other direction: its eyes are placed absolutely
        // and sit *above* centre because the smile takes the lower half of the body. Reading
        // hero's layout off the flex sizes would put its eyes 5.5pt too low and leave the
        // mouth crowding them.
        let hero = OrbSize.hero.metrics
        XCTAssertLessThan(hero.eyeTop, (hero.body.height - hero.eye) / 2)
        XCTAssertEqual(hero.eyeTop, 22)
        XCTAssertEqual(hero.eyeGap, 22, "53 − 20 − 11, from the absolute eye positions")
    }


    // MARK: - The root measurement

    /// The failure this whole change exists to prevent, asserted directly.
    ///
    /// Every number above is `ScreenLayout` doing arithmetic on a size it was handed; this is
    /// the one test about where that size comes from. `MeasuredScreen` has to keep answering
    /// the *current* window — a `GeometryReader` re-read on every layout pass — and not the
    /// first one it ever saw. A latched measurement is invisible at launch and wrong forever
    /// after, which is precisely the shape of the bug the board already had: it opened a
    /// session on geometry captured before the first UIKit layout pass had happened.
    ///
    /// Rotation and a Split View drag reach SwiftUI as the same event — a new size on the same
    /// window — so one host and three resizes cover both. The insets are moved separately,
    /// because they change without the size doing so: showing the system status bar is exactly
    /// that, and it is the change this branch makes.
    ///
    /// The inset half is also what fails if the root is ever "simplified" back to
    /// `View.measuringScreenLayout()`, whose reader ignores the safe area and therefore reports
    /// no insets at all — see `MeasuredScreen`.
    @MainActor
    func testTheMeasuredRootRepublishesItsLanesInsteadOfLatchingTheFirstWindow() throws {
        let recorder = LayoutRecorder()
        let landscape = CGSize(width: 1376, height: 1032)
        let host = LayoutHost(LayoutProbe(recorder: recorder).modifier(MeasuredScreen()), size: landscape)
        defer { host.tearDown() }

        XCTAssertEqual(recorder.latest?.size, landscape, "the first measurement is the window's own size")
        // The horizontal lanes are absolute because an iPad reserves nothing at its sides:
        // 1376 − 28 − 72 − 24 − 337 − 24 − 28.
        XCTAssertEqual(recorder.latest?.boardWidthDocked, 863)

        // A rotation: the same screen with its sides swapped.
        let rotated = CGSize(width: landscape.height, height: landscape.width)
        host.resize(to: rotated)
        XCTAssertEqual(recorder.latest?.size, rotated, "a rotation republishes rather than latching")
        XCTAssertEqual(
            recorder.latest?.boardWidthDocked,
            rotated.width - 2 * DS.Space.edge - ScreenLayout.railWidth - 2 * DS.Space.gap - ScreenLayout.panelWidth,
            "the lanes are re-cut, not merely restated"
        )

        // A Split View resize: narrower, same height, and exactly at the width below which
        // the docked layout stops fitting — so the model's own verdict has to move with it.
        host.resize(to: CGSize(width: ScreenLayout.reference.dockedMinimumWidth, height: landscape.height))
        XCTAssertEqual(recorder.latest?.fit, .threeLane)
        XCTAssertEqual(recorder.latest?.boardWidthDocked, ScreenLayout.minimumBoardWidth)

        host.resize(to: CGSize(width: ScreenLayout.reference.dockedMinimumWidth - 1, height: landscape.height))
        XCTAssertEqual(recorder.latest?.fit, .boardOnly, "one point narrower and the tutor cannot dock")

        // The insets, on their own, and as deltas — what the host window itself reserves is
        // whichever simulator this ran on, but what the root does with a *change* to it is the
        // property. Nothing about the size changes here, so a root that re-measured only on a
        // size change would sail straight past this — and showing the system status bar is
        // exactly that: an inset appearing under a window that did not move.
        host.resize(to: landscape)
        let before = try XCTUnwrap(recorder.latest)
        host.reserve(top: 24, bottom: 20)
        let after = try XCTUnwrap(recorder.latest)

        XCTAssertEqual(after.size, before.size, "the window did not move")
        XCTAssertEqual(after.safeAreaTop, before.safeAreaTop + 24, "the reader still sees the real insets")
        XCTAssertEqual(after.contentTop, before.contentTop + 24, "--space-edge travels down with the obstruction")
        XCTAssertEqual(after.contentBottom, before.contentBottom - 20, "and up with the one at the bottom")
        XCTAssertEqual(after.boardWidthDocked, before.boardWidthDocked, "a top inset is not a horizontal one")

        XCTAssertGreaterThan(recorder.count, 1, "the probe was re-evaluated, not replayed")
    }

    #if DEBUG
    /// The other half of the same decision: the fixture run is the one that must **not**
    /// measure.
    ///
    /// `design/reference/screen-0*.png` were exported from a screen with a 40pt status region,
    /// and no iPad reserves 40. So `--ui-fixture` injects `ScreenLayout.reference` and the
    /// window it is running in has no say — including on the very device the boards were drawn
    /// for, where measuring would give `24 + 28 = 52` against the PNG's 68.
    @MainActor
    func testAFixtureRunIsBuiltFromTheDesignsScreenAndIgnoresTheWindowItIsIn() {
        let recorder = LayoutRecorder()
        let host = LayoutHost(
            LayoutProbe(recorder: recorder).modifier(FixtureScreen()),
            size: CGSize(width: 1376, height: 1032)
        )
        defer { host.tearDown() }

        XCTAssertEqual(recorder.latest, ScreenLayout.reference)
        XCTAssertEqual(recorder.latest?.contentTop, 28, "the PNG's content top, which the device now shares")
        XCTAssertEqual(recorder.latest?.contentBottom, 1004, "and its content bottom, with no indicator to pay for")

        // Every window the fixture might be launched in gets the same screen — which is the
        // difference between injecting and measuring. The reference device's own size is in
        // the list precisely because that is the one where measuring looks like it would work.
        host.resize(to: CGSize(width: 1024, height: 768))
        XCTAssertEqual(recorder.latest, ScreenLayout.reference)
        host.reserve(top: 24, bottom: 20)
        XCTAssertEqual(recorder.latest, ScreenLayout.reference)
        host.resize(to: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(recorder.latest, ScreenLayout.reference)
    }
    #endif

    /// Hosts a SwiftUI view in a window whose size and reserved insets the test can move.
    ///
    /// It has to be a real window: a `UIHostingController` off-window never lays its content
    /// out at all, so a probe hosted that way records nothing and every assertion below it
    /// passes vacuously or fails for the wrong reason.
    ///
    /// The insets are applied as `additionalSafeAreaInsets`, which *adds* to whatever the
    /// window already reserves — so the tests read them as deltas rather than as absolutes,
    /// and do not depend on which simulator they ran on.
    @MainActor
    private final class LayoutHost {
        private let window: UIWindow
        private let controller: UIHostingController<AnyView>
        private let previousKeyWindow: UIWindow?

        init(_ view: some View, size: CGSize) {
            controller = UIHostingController(rootView: AnyView(view))
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            previousKeyWindow = scene?.windows.first(where: \.isKeyWindow)
            window = scene.map(UIWindow.init(windowScene:)) ?? UIWindow(frame: .zero)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            resize(to: size)
        }

        func resize(to size: CGSize) {
            window.frame = CGRect(origin: .zero, size: size)
            controller.view.frame = window.bounds
            settle()
        }

        /// Reserves more of the window, the way a status bar or a home indicator does.
        func reserve(top: CGFloat, bottom: CGFloat) {
            controller.additionalSafeAreaInsets = UIEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
            settle()
        }

        /// A layout pass is what re-evaluates a `GeometryReader`, so the test forces one
        /// rather than waiting on a run loop for an answer that is already available.
        private func settle() {
            window.setNeedsLayout()
            window.layoutIfNeeded()
        }

        func tearDown() {
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }
    }

    /// Records the `ScreenLayout` its host publishes, once per evaluation.
    ///
    /// The value is read in `body` rather than through `onAppear` / `onChange` because the
    /// question is whether the environment value is re-derived on a layout pass — and a layout
    /// pass is exactly what `layoutIfNeeded()` guarantees, where a callback would leave the
    /// assertion racing a run loop.
    private struct LayoutProbe: View {
        @Environment(\.screenLayout) private var layout
        let recorder: LayoutRecorder

        var body: some View {
            recorder.record(layout)
            return Color.clear
        }
    }

    @MainActor
    private final class LayoutRecorder {
        private(set) var latest: ScreenLayout?
        private(set) var count = 0

        func record(_ layout: ScreenLayout) {
            latest = layout
            count += 1
        }
    }

    // MARK: - The sizes these components are checked at

    /// The design's rail chain, as the board's Stack row states it.
    private static let boardsRailChain: [(name: String, marginTop: CGFloat, height: CGFloat)] = [
        ("Tools", 0, 226.5),
        ("Divider", 11.5, 1.5),
        ("Swatches", 19.5, 243),
        ("Thickness", 29, 5),
        ("tool/center", 19.5, 54),
    ]

    /// One screen the shell has to work on, as the real layout model computes it.
    ///
    /// These tests are about what a *component* does with the geometry it is handed, so they
    /// hand it geometry — and they take it from `ScreenLayout` rather than re-deriving it,
    /// because a component checked against a second, private copy of the lane arithmetic is
    /// only ever proved to agree with the test.
    private struct Band {
        let name: String
        let layout: ScreenLayout

        static func device(
            _ name: String,
            _ width: CGFloat,
            _ height: CGFloat,
            safeTop: CGFloat,
            safeBottom: CGFloat
        ) -> Band {
            Band(
                name: name,
                layout: ScreenLayout(
                    size: CGSize(width: width, height: height),
                    safeArea: EdgeInsets(top: safeTop, leading: 0, bottom: safeBottom, trailing: 0)
                )
            )
        }

        /// The board's own screen, with the 40pt status region it drew rather than a device's
        /// inset. This is the geometry `design/reference/screen-0*.png` were exported at, and
        /// the only configuration that reproduces 863 / 1224 / 936.
        static let reference = Band(name: "reference (design board)", layout: .reference)

        /// Four real iPads in landscape, widest to narrowest, with the safe-area insets each
        /// reports there. The 1024 × 768 one is the iPad 6th generation this work started
        /// from; it has a home button, so its bottom inset is 0.
        static let devices: [Band] = [
            .device("iPad Pro 13-inch", 1376, 1032, safeTop: 24, safeBottom: 20),
            .device("iPad Pro 11-inch", 1194, 834, safeTop: 24, safeBottom: 20),
            .device("iPad 10th gen", 1180, 820, safeTop: 24, safeBottom: 20),
            .device("iPad 6th gen", 1024, 768, safeTop: 20, safeBottom: 0),
        ]

        static let all: [Band] = [reference] + devices
    }

    // MARK: - The resizable panel

    /// These four call `ScreenLayout.resolvingPanelWidth(_:)` directly — the same function
    /// `BoardScreen.resized(_:)` calls — rather than a private copy of its arithmetic. An
    /// earlier version of this file kept its own `min(max(requested, minimumPanelWidth),
    /// layout.maximumPanelWidth)` here, which pinned the *expression* but not the *contract*:
    /// deleting `resized(_:)` from `BoardScreen` entirely, or turning it into a write-back
    /// into `UIState`, left every one of these tests green, because none of them called
    /// anything `BoardScreen` actually runs. Calling the real, shared function is what makes
    /// a regression in the clamp itself fail here.
    func testARequestedWidthIsHonouredWhereItFits() {
        let l = ScreenLayout(size: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(l.resolvingPanelWidth(480), 480)
    }

    func testARequestedWidthIsClampedDownOnASmallerWindow() {
        // An 1112 × 834 iPad Air: lane = 936, leaving the board's 200pt floor gives 736.
        let l = ScreenLayout(size: CGSize(width: 1112, height: 834))
        XCTAssertEqual(l.maximumPanelWidth, 736, "maximumPanelWidth")
        XCTAssertEqual(l.resolvingPanelWidth(800), 736, "clamped, not honoured")
    }

    /// The reversibility contract. The requested width is presentation state that survives
    /// the window shrinking, so widening the window restores exactly what the student asked
    /// for rather than whatever the small window allowed.
    func testShrinkingThenGrowingTheWindowRestoresTheRequestedWidth() {
        let requested: CGFloat = 800
        let small = ScreenLayout(size: CGSize(width: 1112, height: 834))
        XCTAssertEqual(small.resolvingPanelWidth(requested), 736, "squeezed")

        let large = ScreenLayout(size: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(large.resolvingPanelWidth(requested), 800, "and restored")
    }

    func testTheClampedWidthAlwaysLeavesTheBoardAtItsUsableFloor() {
        for width in [1024, 1112, 1180, 1366, 1376] as [CGFloat] {
            let l = ScreenLayout(size: CGSize(width: width, height: 1032))
            guard l.maximumPanelWidth >= ScreenLayout.minimumPanelWidth else { continue }
            let clamped = l.resolvingPanelWidth(5000)
            let resolved = ScreenLayout(size: CGSize(width: width, height: 1032), panelWidth: clamped)
            XCTAssertGreaterThanOrEqual(
                resolved.boardWidthDocked,
                ScreenLayout.minimumBoardWidth,
                "at \(width): widening chat must still leave a usable whiteboard"
            )
        }
    }

    // MARK: - The reference render, unmoved

    /// The fixture run is diffed against `design/reference/*.png`, and this whole change is
    /// supposed to be invisible in it: the strip paints nothing at rest, occupies gutter
    /// that already existed, and takes no space in layout. If any published lane moved, the
    /// diff would fail for a reason nobody would connect to a resize handle.
    ///
    /// Five of these six values are already pinned individually by
    /// `testTheDesignsOwnBoardSizesFallOutOfTheRuleAtTheReferenceSize` above — only `panelWidth`
    /// is new here. That overlap is deliberate rather than an oversight: this test exists to
    /// guard Task 7's own scope, the *whole set* of published lanes together as one
    /// "nothing moved" fixture, so a future reader should not delete it as a duplicate of the
    /// test above — the two check different things even where their assertions coincide.
    func testTheReferenceScreenIsUnmovedByTheResizeSystem() {
        let l = ScreenLayout.reference
        XCTAssertEqual(l.panelWidth, 337, "panelWidth")
        XCTAssertEqual(l.panelX, 1011, "panelX")
        XCTAssertEqual(l.boardX, 124, "boardX")
        XCTAssertEqual(l.boardWidthDocked, 863, "boardWidthDocked")
        XCTAssertEqual(l.contentTop, 28, "contentTop")
        XCTAssertEqual(l.contentHeight, 976, "contentHeight")
    }

    /// The strip's own footprint, read from `ScreenLayout.resizeStripX` — the same property
    /// `BoardScreen.swift` draws the strip at — rather than a private re-derivation of it.
    ///
    /// The first version of this test computed `stripLeft` as `l.panelX - DS.Space.gap` and
    /// compared it against `boardRight = l.boardX + l.boardWidthDocked` with `>=`. But
    /// `boardWidthDocked` is *defined* as `max(0, panelX - DS.Space.gap - boardX)`
    /// (`Layout.swift`), so wherever that clamp does not fire — every value `.reference` takes —
    /// `boardRight` reduces algebraically to `panelX - DS.Space.gap`: the same expression as
    /// `stripLeft`, with its terms rearranged. The assertion could not fail; it was one formula
    /// compared to itself, and it gave no protection against `BoardScreen.swift`'s own placement
    /// expression drifting from it. Asserting literals against `resizeStripX` instead pins the
    /// published property itself, and stating the strip/board relationship as equality — not
    /// `>=` — says what is actually true: the strip begins exactly where the board ends, because
    /// it lives entirely inside the gutter between them.
    func testTheStripLiesEntirelyOutsideTheBoard() {
        let l = ScreenLayout.reference

        XCTAssertEqual(l.resizeStripX, 987, "the strip begins in the gutter, not on the board")

        let stripRight = l.resizeStripX + ResizeHandleMetrics.hitBreadth(
            gutter: DS.Space.gap,
            into: DS.Space.panelInset
        )
        XCTAssertEqual(stripRight, 1029, "claiming the gutter plus the panel's own dead margin")
        XCTAssertEqual(
            l.panelX + DS.Space.panelInset,
            1029,
            "which is exactly the panel's own content column, the panel-side bound"
        )
        XCTAssertLessThanOrEqual(
            stripRight,
            l.panelX + DS.Space.panelInset,
            "and it stops there rather than overshooting into the panel's content"
        )
    }


    // MARK: - Sessions drawer (boards 17 · 18 · 19)

    /// Board 17's frame, and the rule under it. The 263 is the design's number and the
    /// fraction is what actually ships, because the panel resizes and a stored 263 in a panel
    /// dragged to 1000 leaves a 737pt chat strip where the design leaves 74.
    func testTheDockedDrawerIsSeventyEightPercentOfWhateverThePanelIs() {
        XCTAssertEqual(SessionsDrawerMetrics.width(inPanel: 337), 263, "337 × 0.78, rounded")
        XCTAssertEqual(SessionsDrawerMetrics.stripWidth(inPanel: 337), 74, "337 − 263")
        XCTAssertEqual(
            SessionsDrawerMetrics.contentWidth(
                for: 263,
                inset: SessionsDrawerMetrics.insetInline
            ),
            239,
            "263 − 2 × 12"
        )

        // The two are complements at every width the panel can be, with nothing left over.
        for panel in [ScreenLayout.minimumPanelWidth, 300, 337, 512, 1000] as [CGFloat] {
            XCTAssertEqual(
                SessionsDrawerMetrics.width(inPanel: panel)
                    + SessionsDrawerMetrics.stripWidth(inPanel: panel),
                panel,
                "panel \(panel)"
            )
            XCTAssertGreaterThan(SessionsDrawerMetrics.stripWidth(inPanel: panel), 0)
        }
    }

    /// The sidebar, and the column that re-centres around it.
    ///
    /// **296, where board 19 draws 372.** The board's is 20% wider than its contents need; the
    /// frame keeps its `--space-edge` either side, so the width follows the content column
    /// rather than the other way round.
    func testTheFullScreenSidebarLeavesTheColumnCentredInWhatItAndThePeekLeave() {
        let layout = ScreenLayout.reference
        XCTAssertEqual(SessionsDrawerMetrics.sidebarWidth, 296, "240 + 2 × 28")
        XCTAssertEqual(SessionsDrawerMetrics.sidebarContentWidth, 240)
        XCTAssertEqual(layout.sessionsSidebarX, 0, "flush against the leading edge")
        XCTAssertEqual(
            SessionsDrawerMetrics.sidebarWidth,
            (372 * 0.8).rounded(.down) - 1,
            "20% off the board's 372, taken to the nearest whole content column"
        )
        // The two drawers agree about how long a title may be, so switching surfaces does not
        // re-truncate the list.
        XCTAssertEqual(
            SessionsDrawerMetrics.sidebarContentWidth
                - SessionsDrawerMetrics.contentWidth(
                    for: SessionsDrawerMetrics.width(inPanel: TutorPanelMetrics.width),
                    inset: SessionsDrawerMetrics.insetInline
                ),
            1,
            "240 against the docked 239"
        )

        let reserved = layout.sessionsSidebarWidth
        XCTAssertEqual(layout.columnRegionWidth(reserving: reserved), 1012, "1308 − 296")
        XCTAssertEqual(layout.columnWidth(reserving: reserved), 740, "min(740, 1012 − 56)")
        XCTAssertEqual(layout.columnMargin(reserving: reserved), 136, "(1012 − 740) ÷ 2")
        XCTAssertEqual(layout.columnX(reserving: reserved), 432, "296 + 136")

        // Reserving nothing is screen 07 unchanged, which is what lets the closed sidebar be
        // the layout that shipped rather than a re-derivation of it.
        XCTAssertEqual(layout.columnX(reserving: 0), layout.columnX)
        XCTAssertEqual(layout.columnWidth(reserving: 0), layout.columnWidth)
        XCTAssertEqual(layout.columnX, 284, "screen 07, untouched")
    }

    /// Board 18's intent lock: the first 12 points and 38° decide the axis.
    func testTheIntentLockCommitsOnAngleAndNotOnDirection() {
        // Under the threshold nothing is decided, however sideways it looks — and `.undecided`
        // means "ask again", which is why it is a case and not a `.vertical` default.
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 8, height: 0)), .undecided)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 0, height: 0)), .undecided)

        // Flat, and either way round — a left-swipe from an open drawer is the same gesture.
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 40, height: 0)), .horizontal)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: -40, height: 0)), .horizontal)

        // 100 across may drift 78 down (tan 38° = 0.781) and still pan; 80 scrolls. The old
        // cone allowed 26, which is less drift than a thumb's own pivot across a 337pt panel
        // produces — the swipes that went missing on the iPad 6th generation were all in here.
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: 78)), .horizontal)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: -78)), .horizontal)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: 26)), .horizontal)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: 80)), .vertical)

        // And the scroller keeps everything past dominance, with 7° of margin either side of
        // it: a drag steeper than 45° is never the drawer's, and one at 45° is not either.
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: 100)), .vertical)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 100, height: 120)), .vertical)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 0, height: 40)), .vertical)
        XCTAssertEqual(DrawerReveal.axis(for: CGSize(width: 10, height: 40)), .vertical)
        XCTAssertLessThan(
            DrawerReveal.intentAngle,
            45,
            "a bias toward the scroller, not a coin toss on the diagonal"
        )
    }

    /// One-to-one with the finger, anchored on where the drawer was, clamped at both ends.
    func testTravelTracksTheFingerFromTheAnchorAndStopsAtBothEnds() {
        XCTAssertEqual(DrawerReveal.progress(from: 0, translation: 131.5, travel: 263), 0.5)
        XCTAssertEqual(DrawerReveal.progress(from: 1, translation: -131.5, travel: 263), 0.5)
        XCTAssertEqual(DrawerReveal.progress(from: 0, translation: -400, travel: 263), 0, "no rubber band")
        XCTAssertEqual(DrawerReveal.progress(from: 1, translation: 400, travel: 263), 1)
        XCTAssertEqual(DrawerReveal.progress(from: 0.4, translation: 0, travel: 0), 0.4, "no travel, no move")
    }

    /// *"It opens past 50% of the travel, or on a fast fling in either direction below 50%."*
    func testTheReleaseSettlesByVelocityFirstAndPositionSecond() {
        XCTAssertTrue(DrawerReveal.settlesOpen(progress: 0.51, velocity: 0))
        XCTAssertFalse(DrawerReveal.settlesOpen(progress: 0.49, velocity: 0))
        XCTAssertTrue(DrawerReveal.settlesOpen(progress: 0.5, velocity: 0), "the line itself opens")

        // A fling wins from anywhere, in both directions — which is what makes it reversible.
        XCTAssertTrue(DrawerReveal.settlesOpen(progress: 0.05, velocity: 1_400))
        XCTAssertFalse(DrawerReveal.settlesOpen(progress: 0.95, velocity: -1_400))
        // And the tail of a drag being carefully placed is not a fling.
        XCTAssertFalse(DrawerReveal.settlesOpen(progress: 0.2, velocity: 120))
        // The unhurried swipe that used to spring back: a third of the way across, still
        // moving. 400 rejected it and read as the gesture having been missed.
        XCTAssertTrue(DrawerReveal.settlesOpen(progress: 0.34, velocity: 350))
    }

    /// The three frames the design publishes, and the crossover between them.
    func testTheVeilsCrossOverBetweenTwentyAndThirtyPercentOfTheTravel() {
        let tolerance = 0.005

        // At rest the drawer carries it and the chat has none — board 17's closed panel.
        XCTAssertEqual(DrawerReveal.drawerVeil(at: 0), 0.55, accuracy: tolerance)
        XCTAssertEqual(DrawerReveal.chatVeil(at: 0), 0, accuracy: tolerance)

        // Board 18, at 42% of the travel: `#FFFFFF4D` on the chat, 77/255.
        XCTAssertEqual(DrawerReveal.chatVeil(at: 111.0 / 263.0), 0.302, accuracy: 0.01)
        XCTAssertEqual(DrawerReveal.drawerVeil(at: 111.0 / 263.0), 0, accuracy: tolerance)

        // Board 17, fully open: `#FFFFFF8C` on the chat, 140/255.
        XCTAssertEqual(DrawerReveal.chatVeil(at: 1), 0.55, accuracy: tolerance)
        XCTAssertEqual(DrawerReveal.drawerVeil(at: 1), 0, accuracy: tolerance)

        // The band, and only the band, is where the drawer's veil moves.
        XCTAssertEqual(DrawerReveal.drawerVeil(at: 0.2), 0.55, accuracy: tolerance)
        XCTAssertEqual(DrawerReveal.drawerVeil(at: 0.3), 0, accuracy: tolerance)
        XCTAssertEqual(DrawerReveal.chatVeil(at: 0.2), 0, accuracy: tolerance)
        XCTAssertEqual(DrawerReveal.chatVeil(at: 0.3), 0.30, accuracy: tolerance)

        // Neither veil ever goes backwards, and neither exceeds the design's ceiling.
        var previousChat = -1.0
        for step in 0...100 {
            let p = CGFloat(step) / 100
            let chat = DrawerReveal.chatVeil(at: p)
            let drawer = DrawerReveal.drawerVeil(at: p)
            XCTAssertGreaterThanOrEqual(chat, previousChat - tolerance, "chat veil at \(p)")
            XCTAssertLessThanOrEqual(chat, DrawerReveal.fullVeil + tolerance, "chat veil at \(p)")
            XCTAssertLessThanOrEqual(drawer, DrawerReveal.fullVeil + tolerance, "drawer veil at \(p)")
            XCTAssertGreaterThanOrEqual(drawer, -tolerance, "drawer veil at \(p)")
            previousChat = chat
        }
    }

    /// Board 18's 12pt parallax is deliberately not implemented — the drawer and the panel
    /// share a fill, so a translation with no visible edge behind it reads as the drawer's
    /// margins changing. See `DrawerReveal.wholePoints(_:)`.
    func testThePanesTranslateByWholePointsOnly() {
        XCTAssertEqual(DrawerReveal.wholePoints(0), 0)
        XCTAssertEqual(DrawerReveal.wholePoints(131.5), 132)
        XCTAssertEqual(DrawerReveal.wholePoints(0.4 * 263), 105, "0.4 × 263 = 105.2")
        XCTAssertEqual(DrawerReveal.wholePoints(263), 263, "and the ends are exact")
    }
}
