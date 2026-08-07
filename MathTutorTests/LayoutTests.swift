import CoreGraphics
import SwiftUI
import XCTest
@testable import MathTutor

/// `ScreenLayout` used to be thirty constants read off board 09. It is now the arithmetic
/// that produced them, evaluated against a real window.
///
/// The first test is the whole point of the file: at the size the board was drawn against,
/// every derivation must land on the number the board published. If one of them does not,
/// the derivation is wrong — the expectation is not negotiable, because it is what shipped
/// and what the design signed off. Every expectation below is therefore a literal, not a
/// re-computation, so a test cannot agree with a bug by performing it twice.
final class LayoutTests: XCTestCase {
    // MARK: - The regression guard

    func testReferenceReproducesEveryPublishedConstant() {
        let l = ScreenLayout.reference

        // Screen · 1376 × 1032, iPad Pro 13" landscape.
        XCTAssertEqual(l.screenWidth, 1376, "screenWidth")
        XCTAssertEqual(l.screenHeight, 1032, "screenHeight")

        // Vertical lanes · nothing reserved, so all four edges are the plain 28.
        XCTAssertEqual(l.statusBarBottom, 0, "statusBarBottom")
        XCTAssertEqual(l.contentTop, 28, "contentTop")
        XCTAssertEqual(l.contentBottom, 1004, "contentBottom")
        XCTAssertEqual(l.contentHeight, 976, "contentHeight")

        // Horizontal lanes, docked · 1376 − 28 − 72 − 24 − 337 − 24 − 28 = 863.
        XCTAssertEqual(l.railX, 28, "railX")
        XCTAssertEqual(l.railWidth, 72, "railWidth")
        XCTAssertEqual(l.boardX, 124, "boardX")
        XCTAssertEqual(l.boardWidthDocked, 863, "boardWidthDocked")
        XCTAssertEqual(l.boardWidthCollapsed, 1224, "boardWidthCollapsed")
        XCTAssertEqual(l.panelX, 1011, "panelX")
        XCTAssertEqual(l.panelWidth, 337, "panelWidth")
        XCTAssertEqual(l.panelContentWidth, 301, "panelContentWidth")
        XCTAssertEqual(l.contentRight, 1348, "contentRight")

        // Full-screen tutor · peek flush left, 740 column centred past it.
        XCTAssertEqual(l.peekX, 0, "peekX")
        XCTAssertEqual(l.peekWidth, 68, "peekWidth")
        XCTAssertEqual(l.columnWidth, 740, "columnWidth")
        XCTAssertEqual(l.columnMargin, 284, "columnMargin")
        XCTAssertEqual(l.columnX, 352, "columnX")
        XCTAssertEqual(l.columnX + l.columnWidth, 1092, "column right edge")

        // Collapsed dock · 24 from the board's corner.
        XCTAssertEqual(l.collapsedDockWidth, 132, "collapsedDockWidth")
        XCTAssertEqual(l.collapsedDockHeight, 64, "collapsedDockHeight")
        XCTAssertEqual(l.collapsedBoardRight, 1348, "collapsedBoardRight")
        XCTAssertEqual(l.collapsedDockX, 1192, "collapsedDockX")
        XCTAssertEqual(l.collapsedDockY, 916, "collapsedDockY")

        XCTAssertEqual(l.fit, .threeLane, "the reference device hosts the docked layout")
    }

    /// The reference-size statics are the migration seam: views that have not yet been handed
    /// a measured layout still read them, and they must not drift from the instance they
    /// forward to.
    func testReferenceStaticsForwardToTheReferenceInstance() {
        let l = ScreenLayout.reference

        XCTAssertEqual(ScreenLayout.screenWidth, l.screenWidth)
        XCTAssertEqual(ScreenLayout.screenHeight, l.screenHeight)
        XCTAssertEqual(ScreenLayout.statusBarBottom, l.statusBarBottom)
        XCTAssertEqual(ScreenLayout.contentTop, l.contentTop)
        XCTAssertEqual(ScreenLayout.contentBottom, l.contentBottom)
        XCTAssertEqual(ScreenLayout.contentHeight, l.contentHeight)
        XCTAssertEqual(ScreenLayout.railX, l.railX)
        XCTAssertEqual(ScreenLayout.railWidth, l.railWidth)
        XCTAssertEqual(ScreenLayout.boardX, l.boardX)
        XCTAssertEqual(ScreenLayout.boardWidthDocked, l.boardWidthDocked)
        XCTAssertEqual(ScreenLayout.boardWidthCollapsed, l.boardWidthCollapsed)
        XCTAssertEqual(ScreenLayout.panelX, l.panelX)
        XCTAssertEqual(ScreenLayout.panelWidth, l.panelWidth)
        XCTAssertEqual(ScreenLayout.panelContentWidth, l.panelContentWidth)
        XCTAssertEqual(ScreenLayout.peekX, l.peekX)
        XCTAssertEqual(ScreenLayout.peekWidth, l.peekWidth)
        XCTAssertEqual(ScreenLayout.columnWidth, l.columnWidth)
        XCTAssertEqual(ScreenLayout.columnMargin, l.columnMargin)
        XCTAssertEqual(ScreenLayout.columnX, l.columnX)
        XCTAssertEqual(ScreenLayout.collapsedDockWidth, l.collapsedDockWidth)
        XCTAssertEqual(ScreenLayout.collapsedDockHeight, l.collapsedDockHeight)
        XCTAssertEqual(ScreenLayout.collapsedDockX, l.collapsedDockX)
        XCTAssertEqual(ScreenLayout.collapsedDockY, l.collapsedDockY)
    }

    /// An unmeasured view — a preview, a snapshot host, anything that never reaches
    /// `measuringScreenLayout()` — must draw the board exactly as it did before this file
    /// learned to compute.
    func testTheEnvironmentDefaultIsTheReferenceDevice() {
        XCTAssertEqual(EnvironmentValues().screenLayout, ScreenLayout.reference)
    }

    // MARK: - Real devices

    /// Landscape point sizes with **nothing reserved at any edge**, which is no longer what the
    /// app ships into: `RootView` leaves the system status bar showing, so a real run always
    /// reports an inset and `insetDevices` below is the shipping list. This one is the
    /// degenerate case kept deliberately — a hidden bar, a snapshot host, a window with no
    /// chrome at all — where `--space-edge` is measured from the glass because the glass is then
    /// the nearest obstruction. It is also the list the removed 40pt floor used to rescue, and
    /// the reason it is still checked is that every invariant has to hold with the insets at
    /// zero as well as at what a device reserves.
    private static let landscapeDevices: [Device] = [
        Device(name: "iPad Pro 13\"", size: CGSize(width: 1376, height: 1032)),
        Device(name: "iPad Pro 11\"", size: CGSize(width: 1194, height: 834)),
        Device(name: "iPad Air", size: CGSize(width: 1180, height: 820)),
        Device(name: "iPad 10.2\"", size: CGSize(width: 1080, height: 810)),
        Device(name: "iPad 9.7\" / 6th gen", size: CGSize(width: 1024, height: 768)),
    ]

    /// The same hardware as iPadOS actually insets it with the bar showing: 24 at the top where
    /// there is a camera housing, 20 where there is a home button, 20 at the bottom wherever
    /// there is a home indicator. Every invariant in this file is checked against these as well
    /// as against the zero-inset list — the arithmetic the 40pt floor got wrong is only visible
    /// once the insets are the ones a device reports.
    private static let insetDevices: [Device] = [
        Device(
            name: "iPad Pro 13\" · bar showing",
            size: CGSize(width: 1376, height: 1032),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)
        ),
        Device(
            name: "iPad Pro 11\" · bar showing",
            size: CGSize(width: 1194, height: 834),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)
        ),
        Device(
            name: "iPad 9.7\" · home button",
            size: CGSize(width: 1024, height: 768),
            safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
        ),
    ]

    /// Every size this file knows about, for the invariant sweeps.
    private static var everySize: [Device] { landscapeDevices + insetDevices + awkwardSizes }

    func testEveryLandscapeIPadHostsTheDockedLayout() {
        for device in Self.landscapeDevices + Self.insetDevices {
            let l = device.layout
            XCTAssertEqual(l.fit, .threeLane, device.name)
            assertNothingIsNegative(l, device.name)
            assertEverythingLandsInsideTheScreen(l, device.name)
            assertTheThreeLanesDoNotOverlap(l, device.name)

            // The board is the product; the panel is the commentary. It stays the wider of
            // the two on every device the design is meant to run on.
            XCTAssertGreaterThanOrEqual(l.boardWidthDocked, ScreenLayout.minimumBoardWidth, device.name)
            XCTAssertGreaterThan(l.boardWidthDocked, l.panelWidth, device.name)
            XCTAssertGreaterThan(l.boardWidthCollapsed, l.boardWidthDocked, device.name)

            // The safe band still has room for the tallest thing the design puts in it.
            XCTAssertGreaterThan(l.contentHeight, ScreenLayout.minimumContentHeight, device.name)
        }
    }

    /// The number that started this: on an iPad 6th generation the panel used to be drawn at
    /// x 1011…1348, off the right edge of a 1024pt screen.
    func testTheIPadSixthGenerationPanelIsBackOnTheScreen() {
        let l = ScreenLayout(size: CGSize(width: 1024, height: 768))

        XCTAssertEqual(l.panelX, 659, "1024 − 28 − 337")
        XCTAssertEqual(l.panelX + l.panelWidth, 996, "the panel's right edge is the edge inset")
        XCTAssertEqual(l.boardWidthDocked, 511, "1024 − 28 − 72 − 24 − 337 − 24 − 28")
        XCTAssertEqual(l.boardWidthCollapsed, 872, "511 + 24 + 337")
        XCTAssertEqual(l.contentBottom, 740, "768 − 28")
        XCTAssertEqual(l.contentHeight, 712, "768 − 28 − 28")

        // The rail and the panel did not move: only the board gave ground.
        XCTAssertEqual(l.railX, ScreenLayout.reference.railX)
        XCTAssertEqual(l.railWidth, ScreenLayout.reference.railWidth)
        XCTAssertEqual(l.boardX, ScreenLayout.reference.boardX)
        XCTAssertEqual(l.panelWidth, ScreenLayout.reference.panelWidth)

        // Nothing is reserved at the top here — this window is measured with the system bar
        // hidden — so `--space-edge` comes off the screen and `contentTop` is the token itself.
        // It is 40 short of the reference device's 68, which is the design's inset, not this
        // window's. See `testAHiddenStatusBarLeavesContentTopAtThePlainEdgeToken`.
        XCTAssertEqual(l.contentTop, DS.Space.edge, "0 + 28")
    }

    // MARK: - Portrait, Split View, Stage Manager

    /// Portrait iPads and the multitasking widths. `project.yml` pins the app to landscape
    /// today, but Split View and Stage Manager hand out sizes no orientation lock covers, and
    /// a layout model that only survives its own device is the bug this file exists to fix.
    private static let awkwardSizes: [Device] = [
        Device(name: "iPad Pro 13\" portrait", size: CGSize(width: 1032, height: 1376)),
        Device(name: "iPad Pro 11\" portrait", size: CGSize(width: 834, height: 1194)),
        Device(name: "iPad Air portrait", size: CGSize(width: 820, height: 1180)),
        Device(name: "iPad 9.7\" portrait", size: CGSize(width: 768, height: 1024)),
        Device(name: "Split View · half of 13\"", size: CGSize(width: 678, height: 1032)),
        Device(name: "Split View · two-thirds of 13\"", size: CGSize(width: 900, height: 1032)),
        Device(name: "Split View · one-third", size: CGSize(width: 375, height: 1032)),
        Device(name: "Split View · narrowest", size: CGSize(width: 320, height: 1032)),
        Device(name: "Stage Manager · small window", size: CGSize(width: 512, height: 400)),
        Device(name: "degenerate", size: CGSize(width: 1, height: 1)),
        Device(name: "zero", size: CGSize(width: 0, height: 0)),
    ]

    func testNoSizeEverProducesANegativeRegion() {
        for device in Self.everySize {
            assertNothingIsNegative(device.layout, device.name)
        }
    }

    func testPortraitAndSplitViewFallBackToStatesTheDesignAlreadyHas() throws {
        let expected: [String: ScreenLayout.Fit] = [
            "iPad Pro 13\" portrait": .threeLane,
            "iPad Pro 11\" portrait": .boardOnly,
            "iPad Air portrait": .boardOnly,
            "iPad 9.7\" portrait": .boardOnly,
            "Split View · half of 13\"": .boardOnly,
            "Split View · two-thirds of 13\"": .threeLane,
            "Split View · one-third": .unsupported,
            "Split View · narrowest": .unsupported,
            // 512 clears the collapsed sum by 23pt, so screen 06 still fits — the board is
            // 360 wide, which is a board. Height is not the constraint here.
            "Stage Manager · small window": .boardOnly,
            "degenerate": .unsupported,
            "zero": .unsupported,
        ]

        for device in Self.awkwardSizes {
            let want = try XCTUnwrap(expected[device.name], device.name)
            XCTAssertEqual(device.layout.fit, want, device.name)
        }
    }

    /// `.boardOnly` is not a degraded layout — it is screen 06, which the design draws and
    /// which the student already reaches by collapsing the tutor. So the board it leaves has
    /// to be a board worth drawing on, and the dock that reopens the tutor has to fit on it.
    func testTheCollapsedFallbackIsAWholeUsableScreen() {
        for device in Self.awkwardSizes where device.layout.fit == .boardOnly {
            let l = device.layout

            XCTAssertFalse(l.canDockTutor, device.name)
            XCTAssertGreaterThanOrEqual(l.boardWidthCollapsed, ScreenLayout.minimumBoardWidth, device.name)
            XCTAssertGreaterThan(l.boardWidthCollapsed, l.boardWidthDocked, device.name)

            // The dock sits on the board with its 24pt inset clear on both axes.
            XCTAssertGreaterThanOrEqual(l.collapsedDockX - DS.Space.gap, l.boardX, device.name)
            XCTAssertGreaterThanOrEqual(l.collapsedDockY - DS.Space.gap, l.contentTop, device.name)
            XCTAssertEqual(l.collapsedDockX + l.collapsedDockWidth + DS.Space.gap, l.collapsedBoardRight, device.name)

            // And the tutor is still reachable at full size from it.
            XCTAssertGreaterThan(l.columnWidth, 0, device.name)
        }
    }

    /// A window that cannot host screen 06 either. The model says so rather than quietly
    /// handing back a board of nought points and letting the screen look merely empty.
    func testUnsupportedSizesSaySoRatherThanDrawNonsense() {
        let tiny = ScreenLayout(size: CGSize(width: 320, height: 1032))

        XCTAssertEqual(tiny.fit, .unsupported)
        XCTAssertFalse(tiny.canDockTutor)
        XCTAssertEqual(tiny.boardWidthDocked, 0, "clamped, not negative — 320 cannot seat a panel")
        XCTAssertLessThan(tiny.boardWidthCollapsed, ScreenLayout.minimumBoardWidth)

        // Short but wide: the width is fine and the band is not. `140 − 28 − 28 = 84`, four
        // points short of the dock's own anchor. (It was 150 when the top inset was floored at
        // 40; the same window is four points taller in content terms now that it is not.)
        let shallow = ScreenLayout(size: CGSize(width: 1376, height: 140))
        XCTAssertEqual(shallow.contentHeight, 84, "140 − 28 − 28")
        XCTAssertLessThan(shallow.contentHeight, ScreenLayout.minimumContentHeight)
        XCTAssertEqual(shallow.fit, .unsupported)
        XCTAssertGreaterThan(shallow.boardWidthDocked, 0, "the width was never the problem")
    }

    /// The threshold is the docked lanes with the board at its floor, and nothing else — a
    /// point either side of it flips the answer.
    func testTheDockingThresholdIsExactlyTheLaneSum() {
        XCTAssertEqual(ScreenLayout.dockedMinimumWidth, 850, "28 + 72 + 24 + 337 + 24 + 337 + 28")
        XCTAssertEqual(ScreenLayout.collapsedMinimumWidth, 489, "28 + 72 + 24 + 337 + 28")
        XCTAssertEqual(ScreenLayout.minimumBoardWidth, DS.Container.panel, "the board never reads as the minor lane")
        XCTAssertEqual(ScreenLayout.minimumContentHeight, 88, "24 + 64 — the dock's own anchor")

        let tallEnough: CGFloat = 1032
        XCTAssertEqual(ScreenLayout(size: CGSize(width: 850, height: tallEnough)).fit, .threeLane)
        XCTAssertEqual(ScreenLayout(size: CGSize(width: 849, height: tallEnough)).fit, .boardOnly)
        XCTAssertEqual(ScreenLayout(size: CGSize(width: 489, height: tallEnough)).fit, .boardOnly)
        XCTAssertEqual(ScreenLayout(size: CGSize(width: 488, height: tallEnough)).fit, .unsupported)

        // At the threshold the board is exactly its floor, which is the definition of it.
        XCTAssertEqual(
            ScreenLayout(size: CGSize(width: 850, height: tallEnough)).boardWidthDocked,
            ScreenLayout.minimumBoardWidth
        )
        XCTAssertEqual(
            ScreenLayout(size: CGSize(width: 489, height: tallEnough)).boardWidthCollapsed,
            ScreenLayout.minimumBoardWidth
        )
    }

    // MARK: - Safe areas

    /// Board 01's rule is *status-bar bottom + `--space-edge`* — the bottom of whatever the
    /// system reserves, not the literal 40 that only the board ever reserved.
    func testContentTopFollowsTheStatusBarWhereverItEnds() {
        let deep = ScreenLayout(
            size: CGSize(width: 1024, height: 768),
            safeArea: EdgeInsets(top: 59, leading: 0, bottom: 0, trailing: 0)
        )
        XCTAssertEqual(deep.statusBarBottom, 59)
        XCTAssertEqual(deep.contentTop, 59 + DS.Space.edge)
    }

    /// **The regression guard for the pixel diff.** `reference` reserves nothing, which is both
    /// what the boards draw and what the shipping app produces once it hides the system bar. The
    /// fixture is therefore the same layout the device makes, not a second set of numbers that
    /// has to be kept in step with it.
    func testReferenceReservesNothingJustLikeADeviceWithTheBarHidden() {
        let l = ScreenLayout.reference

        XCTAssertEqual(l.safeAreaTop, 0, "the boards reserve nothing above the content")
        XCTAssertEqual(l.statusBarBottom, 0)
        XCTAssertEqual(l.contentTop, 28, "0 + 28 — every panel on every screen")
        XCTAssertEqual(l.contentBottom, 1004)
        XCTAssertEqual(l.contentHeight, 976, "1032 − 28 − 28")

        // And it gets there by the ordinary rule: the same size with no insets, through the
        // ordinary initialiser, is the same layout. The fixture is not a special case.
        let rebuilt = ScreenLayout(size: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(rebuilt, l)
        XCTAssertEqual(rebuilt.contentTop, l.statusBarBottom + DS.Space.edge)
    }

    /// Nothing in the app asks for a band any more, but the rule is the expression rather than
    /// the zero it normally evaluates with: a window that *does* report a reserved region gets
    /// `inset + 28`, and this is what showing the bar would cost.
    func testAReservedBandStillPushesTheContentTopDown() {
        let l = ScreenLayout(
            size: CGSize(width: 1376, height: 1032),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 0, trailing: 0)
        )

        XCTAssertEqual(l.statusBarBottom, 24, "where iPadOS's landscape status bar would end")
        XCTAssertEqual(l.contentTop, 52, "24 + 28")
        XCTAssertEqual(l.contentBottom, 1004, "1032 − 28 — the bottom edge did not move")
        XCTAssertEqual(l.contentHeight, 952, "1032 − 52 − 28")

        // Stated as the cost, because hiding the bar is what buys it back: a visible band takes
        // 24 points out of the safe band the boards draw their content in.
        XCTAssertEqual(ScreenLayout.reference.contentHeight - l.contentHeight, 24)

        // Nothing horizontal moved: this is a vertical change only.
        XCTAssertEqual(l.railX, ScreenLayout.reference.railX)
        XCTAssertEqual(l.boardWidthDocked, ScreenLayout.reference.boardWidthDocked)
        XCTAssertEqual(l.panelX, ScreenLayout.reference.panelX)
    }

    /// A home-button iPad reserves 20 — the shallowest bar any supported device has, and four
    /// points shallower than the app's own 24pt band.
    func testAHomeButtonIPadMeasuresFromItsOwnTwentyPointBar() {
        let l = ScreenLayout(
            size: CGSize(width: 1024, height: 768),
            safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
        )

        XCTAssertEqual(l.statusBarBottom, 20)
        XCTAssertEqual(l.contentTop, 48, "20 + 28")
        XCTAssertEqual(l.contentBottom, 740, "768 − 28")
        XCTAssertEqual(l.contentHeight, 692, "768 − 48 − 28")
        XCTAssertEqual(l.fit, .threeLane)

        assertNothingIsNegative(l, "home-button iPad")
        assertEverythingLandsInsideTheScreen(l, "home-button iPad")
        assertTheLanesClose(l, "home-button iPad")
    }

    /// **This is the shipping case.** `RootView` hides the system bar, so nothing is reserved
    /// and `--space-edge` falls back to its plain definition — an inset from the screen edge,
    /// because with no obstruction the screen edge is what is nearest. Not a special case: the
    /// same expression, with a zero in it. It is also what the boards draw.
    func testAHiddenStatusBarLeavesContentTopAtThePlainEdgeToken() {
        let l = ScreenLayout(size: CGSize(width: 1376, height: 1032))

        XCTAssertEqual(l.safeAreaTop, 0)
        XCTAssertEqual(l.statusBarBottom, 0, "nothing reserved, and nothing floored either")
        XCTAssertEqual(l.contentTop, DS.Space.edge, "0 + 28")
        XCTAssertEqual(l.contentTop, 28)
        XCTAssertEqual(l.contentHeight, 976, "1032 − 28 − 28")

        // It is the same rule as the bottom edge of the same window, which has no obstruction
        // either — so the two ends are symmetric down to the point.
        XCTAssertEqual(l.contentTop, l.screenHeight - l.contentBottom)

        assertEverythingLandsInsideTheScreen(l, "status bar hidden")
    }

    /// `--space-edge` is measured from the obstruction, not from the glass — **one rule, both
    /// ends**. `contentTop` is `safeAreaTop + 28` and `contentBottom` is `28` up from
    /// `screenHeight − safeAreaBottom`, and these are the same sentence rather than two
    /// coincidences that happen to use the same token.
    func testTheTopAndBottomRulesAreTheSameRule() {
        let insets: [(top: CGFloat, bottom: CGFloat)] = [
            (0, 0),      // bar hidden, no indicator
            (24, 20),    // 13" iPad, bar showing, home indicator
            (20, 0),     // home button, top and bottom
            (40, 0),     // the design's own reference inset
            (59, 34),    // a notched phone-shaped window, for the extremes
        ]

        for inset in insets {
            let name = "top \(inset.top) · bottom \(inset.bottom)"
            let l = ScreenLayout(
                size: CGSize(width: 1376, height: 1032),
                safeArea: EdgeInsets(top: inset.top, leading: 0, bottom: inset.bottom, trailing: 0)
            )

            let topClearance = l.contentTop - l.safeAreaTop
            let bottomClearance = (l.screenHeight - l.safeAreaBottom) - l.contentBottom

            XCTAssertEqual(topClearance, DS.Space.edge, "\(name) · top clearance")
            XCTAssertEqual(bottomClearance, DS.Space.edge, "\(name) · bottom clearance")
            XCTAssertEqual(topClearance, bottomClearance, "\(name) · one rule, not two")

            // Spelled out the other way round, as the arithmetic each property performs.
            XCTAssertEqual(l.contentTop, l.safeAreaTop + DS.Space.edge, name)
            XCTAssertEqual(l.contentBottom, l.screenHeight - l.safeAreaBottom - DS.Space.edge, name)
        }
    }

    /// The bottom half of the same rule, stated against the case it was doubted for: a device
    /// with a home indicator. Content clears the indicator by `--space-edge`, exactly as it
    /// clears the status bar by `--space-edge` at the other end.
    ///
    /// The alternative that was considered — `max(--space-edge, safeAreaBottom)` — is asserted
    /// against here rather than described, because it is the change someone would make: against
    /// a 20pt indicator it leaves 8 points of air, and 8 is not a number this design uses
    /// against a screen edge.
    func testContentClearsAHomeIndicatorByExactlyTheEdgeInset() {
        let indicator: CGFloat = 20
        let l = ScreenLayout(
            size: CGSize(width: 1376, height: 1032),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: indicator, trailing: 0)
        )

        XCTAssertEqual(l.contentBottom, 984, "1032 − 20 − 28")
        XCTAssertEqual((l.screenHeight - indicator) - l.contentBottom, DS.Space.edge, "28 clear of the indicator")

        // Not the rejected reading, which would have measured from the glass and let the
        // indicator eat 20 of the 28.
        let cramped = l.screenHeight - max(DS.Space.edge, indicator)
        XCTAssertNotEqual(l.contentBottom, cramped)
        XCTAssertEqual(cramped - l.contentBottom, indicator, "the 20 the rejected reading would have swallowed")
        XCTAssertEqual((l.screenHeight - indicator) - cramped, DS.Space.edge - indicator, "8pt — visually cramped")

        // The collapsed dock rides on `contentBottom`, so it clears the indicator too.
        XCTAssertEqual(l.collapsedDockY + l.collapsedDockHeight + DS.Space.gap, l.contentBottom)
        XCTAssertLessThanOrEqual(l.collapsedDockY + l.collapsedDockHeight, l.screenHeight - indicator)

        assertEverythingLandsInsideTheScreen(l, "home indicator")
        assertTheLanesClose(l, "home indicator")
    }

    func testEveryEdgeInsetIsHonouredAtOnce() {
        let insets = EdgeInsets(top: 59, leading: 44, bottom: 34, trailing: 44)
        let l = ScreenLayout(size: CGSize(width: 1024, height: 768), safeArea: insets)

        XCTAssertEqual(l.fit, .threeLane)
        XCTAssertEqual(l.railX, 44 + 28, "the edge inset is measured from the safe edge")
        XCTAssertEqual(l.boardX, 44 + 28 + 72 + 24)
        XCTAssertEqual(l.contentRight, 1024 - 44 - 28)
        XCTAssertEqual(l.panelX + l.panelWidth, l.contentRight)
        XCTAssertEqual(l.contentBottom, 768 - 34 - 28)
        XCTAssertEqual(l.contentTop, 59 + 28)
        XCTAssertEqual(l.peekX, 44, "flush to the edge it is allowed to touch, which is the safe one")

        assertNothingIsNegative(l, "large insets")
        assertEverythingLandsInsideTheScreen(l, "large insets")
        assertTheThreeLanesDoNotOverlap(l, "large insets")
        assertTheLanesClose(l, "large insets")
    }

    // MARK: - Invariants that hold at every size

    /// `edge + rail + gap + board + gap + panel + edge == width`, at every size that can host
    /// the docked layout. Below the threshold the board is clamped at zero instead of going
    /// negative, so the sum stops closing — which is precisely what `fit` reports.
    func testTheLaneArithmeticCloses() {
        for device in Self.everySize {
            guard device.layout.fit == .threeLane else { continue }
            assertTheLanesClose(device.layout, device.name)
        }
    }

    /// The collapsed board runs from its own left edge to the screen's edge inset, and it is
    /// the docked board plus the gap plus the panel — the two spellings board 09 gives.
    func testTheCollapsedBoardAbsorbsTheGapAndThePanel() {
        for device in Self.everySize {
            let l = device.layout
            guard l.fit == .threeLane else { continue }

            XCTAssertEqual(
                l.boardWidthCollapsed,
                l.boardWidthDocked + DS.Space.gap + l.panelWidth,
                accuracy: 0.0001,
                device.name
            )
            XCTAssertEqual(l.boardX + l.boardWidthCollapsed, l.contentRight, accuracy: 0.0001, device.name)
        }
    }

    /// *"The one exception to the edge rule."* The dock is 24 from the **board's** corner, so
    /// it must track the board at every size — including the sizes where the board no longer
    /// reaches the screen's edge inset.
    func testTheDockStaysOnTheBoardsCornerAtEverySize() {
        for device in Self.everySize {
            let l = device.layout
            guard l.fit != .unsupported else { continue }

            XCTAssertEqual(
                l.collapsedDockX,
                l.collapsedBoardRight - DS.Space.gap - l.collapsedDockWidth,
                accuracy: 0.0001,
                device.name
            )
            XCTAssertEqual(
                l.collapsedDockY,
                l.contentBottom - DS.Space.gap - l.collapsedDockHeight,
                accuracy: 0.0001,
                device.name
            )
            XCTAssertNotEqual(
                l.collapsedDockX,
                l.contentRight - l.collapsedDockWidth,
                "24 from the board, not 28 from the screen — \(device.name)"
            )
        }
    }

    /// *"Because the peek occupies the left 68, that column is centred in what remains rather
    /// than on the screen."* Equal margins inside the region, and never the screen's centre.
    func testTheReadingColumnCentresPastThePeekAtEverySize() {
        for device in Self.everySize {
            let l = device.layout
            guard l.columnWidth > 0 else { continue }

            let leftMargin = l.columnX - (l.peekX + l.peekWidth)
            let rightMargin = (l.screenWidth - l.safeAreaTrailing) - (l.columnX + l.columnWidth)
            XCTAssertEqual(leftMargin, rightMargin, accuracy: 0.0001, device.name)
            XCTAssertEqual(leftMargin, l.columnMargin, accuracy: 0.0001, device.name)
            XCTAssertGreaterThanOrEqual(leftMargin, 0, device.name)

            XCTAssertLessThanOrEqual(l.columnWidth, DS.Container.column, "never wider than 740 — \(device.name)")
            XCTAssertNotEqual(
                l.columnX,
                (l.screenWidth - l.columnWidth) / 2,
                "centred in the region, not on the screen — \(device.name)"
            )
        }
    }

    /// Once the region drops below `740 + 2 × 28` the column stops being 740 and starts being
    /// the region less one edge inset a side — which is the rule for anything against a screen
    /// edge, so no new number appears.
    func testTheColumnShrinksToTheEdgeInsetRatherThanOverflowing() {
        let wide = ScreenLayout(size: CGSize(width: 1024, height: 768))
        XCTAssertEqual(wide.columnWidth, DS.Container.column, "1024 − 68 − 56 = 900, so 740 still fits")

        let narrow = ScreenLayout(size: CGSize(width: 700, height: 1032))
        XCTAssertEqual(narrow.columnWidth, 700 - 68 - 2 * DS.Space.edge, "576")
        XCTAssertEqual(narrow.columnMargin, DS.Space.edge)
        XCTAssertEqual(narrow.columnX, 68 + DS.Space.edge)
        XCTAssertEqual(narrow.columnX + narrow.columnWidth, 700 - DS.Space.edge)
    }

    /// The two lanes the design calls fixed stay fixed, whatever the window does.
    func testTheRailAndThePanelNeverResize() {
        for device in Self.everySize {
            XCTAssertEqual(device.layout.railWidth, DS.Container.rail, device.name)
            XCTAssertEqual(device.layout.panelWidth, DS.Container.panel, device.name)
            XCTAssertEqual(device.layout.panelContentWidth, DS.Container.panelContent, device.name)
            XCTAssertEqual(
                device.layout.panelContentWidth,
                device.layout.panelWidth - 2 * DS.Space.panelInset,
                device.name
            )
        }
    }

    // MARK: - Helpers

    private struct Device {
        let name: String
        let size: CGSize
        var safeArea = EdgeInsets()

        var layout: ScreenLayout { ScreenLayout(size: size, safeArea: safeArea) }
    }

    private func assertNothingIsNegative(_ l: ScreenLayout, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        for region in l.namedRegions {
            XCTAssertGreaterThanOrEqual(region.width, 0, "\(name) · \(region.name) width", file: file, line: line)
        }
        XCTAssertGreaterThanOrEqual(l.contentHeight, 0, "\(name) · contentHeight", file: file, line: line)
        XCTAssertGreaterThanOrEqual(l.usableWidth, 0, "\(name) · usableWidth", file: file, line: line)
        XCTAssertGreaterThanOrEqual(l.columnMargin, 0, "\(name) · columnMargin", file: file, line: line)
    }

    private func assertEverythingLandsInsideTheScreen(_ l: ScreenLayout, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let left = l.safeAreaLeading
        let right = l.screenWidth - l.safeAreaTrailing

        for region in l.namedRegions {
            XCTAssertGreaterThanOrEqual(region.x, left, "\(name) · \(region.name) left", file: file, line: line)
            XCTAssertLessThanOrEqual(region.x + region.width, right, "\(name) · \(region.name) right", file: file, line: line)
        }

        XCTAssertGreaterThanOrEqual(l.contentTop, l.statusBarBottom, "\(name) · contentTop", file: file, line: line)
        XCTAssertLessThanOrEqual(l.contentBottom, l.screenHeight - l.safeAreaBottom, "\(name) · contentBottom", file: file, line: line)
        XCTAssertLessThanOrEqual(
            l.collapsedDockY + l.collapsedDockHeight,
            l.contentBottom,
            "\(name) · dock bottom",
            file: file,
            line: line
        )
    }

    private func assertTheThreeLanesDoNotOverlap(_ l: ScreenLayout, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(l.boardX - (l.railX + l.railWidth), DS.Space.gap, accuracy: 0.0001, "\(name) · rail→board", file: file, line: line)
        XCTAssertEqual(l.panelX - (l.boardX + l.boardWidthDocked), DS.Space.gap, accuracy: 0.0001, "\(name) · board→panel", file: file, line: line)
        XCTAssertEqual(l.railX - l.safeAreaLeading, DS.Space.edge, accuracy: 0.0001, "\(name) · left edge", file: file, line: line)
        XCTAssertEqual(
            (l.screenWidth - l.safeAreaTrailing) - (l.panelX + l.panelWidth),
            DS.Space.edge,
            accuracy: 0.0001,
            "\(name) · right edge",
            file: file,
            line: line
        )
    }

    private func assertTheLanesClose(_ l: ScreenLayout, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let lanes = l.safeAreaLeading
            + DS.Space.edge
            + l.railWidth
            + DS.Space.gap
            + l.boardWidthDocked
            + DS.Space.gap
            + l.panelWidth
            + DS.Space.edge
            + l.safeAreaTrailing

        XCTAssertEqual(lanes, l.screenWidth, accuracy: 0.0001, "\(name) · docked lanes", file: file, line: line)

        let collapsed = l.safeAreaLeading
            + DS.Space.edge
            + l.railWidth
            + DS.Space.gap
            + l.boardWidthCollapsed
            + DS.Space.edge
            + l.safeAreaTrailing

        XCTAssertEqual(collapsed, l.screenWidth, accuracy: 0.0001, "\(name) · collapsed lanes", file: file, line: line)

        // `safe top + edge + band + edge + safe bottom == height`. The two `DS.Space.edge` terms
        // are the same rule applied at either end — see `testTheTopAndBottomRulesAreTheSameRule`.
        let vertical = l.statusBarBottom + DS.Space.edge + l.contentHeight + DS.Space.edge + l.safeAreaBottom
        XCTAssertEqual(vertical, l.screenHeight, accuracy: 0.0001, "\(name) · vertical lanes", file: file, line: line)
    }
}
