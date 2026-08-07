# Resizable Tutor Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the student drag the seam between the board and the tutor panel to set the panel's width, collapsing it to the existing dock when dragged narrow enough.

**Architecture:** All the difficulty lives in `ResizeModel`, a pure function over value types with no SwiftUI import, so every edge case is a unit test against a function rather than a UI test against a gesture. `ResizeHandle` is a thin, axis-generic gesture host. `ScreenLayout.panelWidth` turns from a `static let` into an instance property, which is enough for `panelX`, `boardWidthDocked` and `dockedMinimumWidth` to follow with no new arithmetic.

**Tech Stack:** Swift 6.0, SwiftUI, iOS 17.0 deployment target, XCTest, XcodeGen.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-07-resizable-tutor-panel-design.md`. Read it before Task 1.
- **iPad landscape only.** `project.yml` pins `UISupportedInterfaceOrientations~ipad` to landscape; `TARGETED_DEVICE_FAMILY` is `"2"`. There is no portrait case to handle.
- **iOS 17.0 minimum.** `.sensoryFeedback(_:trigger:)` is available and is the required haptics API. Do not use `UIImpactFeedbackGenerator` directly.
- **Never introduce a raw number that a `DS` token already names.** `DS.Space.gap` is 24, `DS.Space.panelInset` is 18, `DS.Container.panel` is 337. The one new proportion permitted by the spec is the `0.6` collapse fraction.
- **XcodeGen:** sources are directory globs, so after creating any new file run `xcodegen generate` from the repo root before building. `MathTutor.xcodeproj` is committed — commit its regenerated `project.pbxproj` alongside new files.
- **Test command** (substitute the `-only-testing:` argument per task):

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeModelTests 2>&1 | tail -30
```

- **Commit to `main`.** Do not create branches or worktrees.
- **Never `git checkout` a file to undo work.** The tree is dirty with unrelated changes; undo your own edits with `Edit`.
- **Documentation voice.** This codebase documents *why*, at length, citing the board or the spec that forced a decision. Match it. A doc comment that only restates the signature is a review failure here.

---

### Task 1: Resize value types

**Files:**
- Create: `MathTutor/DesignSystem/Resize/ResizeGeometry.swift`
- Test: `MathTutorTests/ResizeModelTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `ResizeAxis`, `ResizeEdge` (with `.axis: ResizeAxis` and `.growthSign: CGFloat`), `ResizeLimit`, `ResizeConstraints(minimum:maximum:collapseBelow:rubberBand:)`, `ResizeResolution(size:handleOffset:isCollapsed:limit:)`.

- [ ] **Step 1: Write the failing test**

Create `MathTutorTests/ResizeModelTests.swift`:

```swift
import CoreGraphics
import XCTest
@testable import MathTutor

/// The resize system's whole difficulty lives in `ResizeModel`, which is a pure function,
/// so it is all asserted here rather than through a gesture on a simulator.
///
/// The recorded lesson about lossy first taps is the reason: a UI test that synthesises a
/// drag can fail for reasons that have nothing to do with the arithmetic. Everything that
/// can be a value test is one.
final class ResizeModelTests: XCTestCase {
    // MARK: - Edges

    func testEdgeGrowthSignFollowsWhichSideTheHandleIsOn() {
        // A handle on the surface's leading edge grows it when dragged toward the origin,
        // which is the tutor panel: it is pinned right, so dragging left widens it.
        XCTAssertEqual(ResizeEdge.leading.growthSign, -1, "leading")
        XCTAssertEqual(ResizeEdge.top.growthSign, -1, "top")
        // A handle on the trailing edge is the mirror: dragging away from the origin grows it.
        XCTAssertEqual(ResizeEdge.trailing.growthSign, 1, "trailing")
        XCTAssertEqual(ResizeEdge.bottom.growthSign, 1, "bottom")
    }

    func testEdgeReportsItsAxis() {
        XCTAssertEqual(ResizeEdge.leading.axis, .horizontal, "leading")
        XCTAssertEqual(ResizeEdge.trailing.axis, .horizontal, "trailing")
        XCTAssertEqual(ResizeEdge.top.axis, .vertical, "top")
        XCTAssertEqual(ResizeEdge.bottom.axis, .vertical, "bottom")
    }

    // MARK: - Constraints

    func testConstraintsReportWhetherTheyCanBeSatisfied() {
        XCTAssertTrue(ResizeConstraints(minimum: 337, maximum: 600).isSatisfiable)
        // A window too narrow to give the panel its minimum without starving the board.
        XCTAssertFalse(ResizeConstraints(minimum: 337, maximum: 300).isSatisfiable)
    }

    func testConstraintsDefaultToApplesRubberBandCoefficient() {
        XCTAssertEqual(ResizeConstraints(minimum: 337, maximum: 600).rubberBand, 0.55)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeModelTests 2>&1 | tail -30
```

Expected: compile failure — "cannot find 'ResizeEdge' in scope".

- [ ] **Step 3: Write the value types**

Create `MathTutor/DesignSystem/Resize/ResizeGeometry.swift`:

```swift
import CoreGraphics

/// Which way a surface is being resized.
///
/// The axis exists so one model serves both directions rather than growing a vertical
/// branch later. Nothing resizes vertically yet; the spec says so out loud, and keeping the
/// axis in the type from the start is what stops the horizontal case hard-coding `width`
/// everywhere it means `size along the drag`.
enum ResizeAxis: Equatable, Sendable {
    case horizontal
    case vertical
}

/// Which edge of the surface the handle sits on — and therefore which direction of drag
/// makes the surface bigger.
///
/// This is the only place the sign lives. The tutor panel is pinned to the screen's right
/// edge and its handle is on its **leading** side, so dragging left (a negative translation)
/// must *widen* it: `growthSign` is −1. A left-hand sidebar would put its handle on
/// `.trailing` and get +1. Every other type in the resize system is sign-agnostic because
/// of this property.
enum ResizeEdge: Equatable, Sendable {
    case leading
    case trailing
    case top
    case bottom

    var axis: ResizeAxis {
        switch self {
        case .leading, .trailing: .horizontal
        case .top, .bottom: .vertical
        }
    }

    /// Multiply a drag translation by this to get the change in size.
    ///
    /// A handle on the near edge (`leading` / `top`) grows its surface when dragged *toward*
    /// the origin, because the surface's far edge is pinned; a handle on the far edge grows
    /// it when dragged away.
    var growthSign: CGFloat {
        switch self {
        case .leading, .top: -1
        case .trailing, .bottom: 1
        }
    }
}

/// Which bound the gesture is currently pushing against, if any.
///
/// Carried on the resolution rather than recomputed by the view, because it is what fires
/// the haptic — and on a touchscreen that haptic is the *entire* feedback that a limit has
/// been reached. There is no cursor to change and no hover state to highlight, so a view
/// that had to re-derive this would be re-deriving the only signal the student gets.
enum ResizeLimit: Equatable, Sendable {
    case none
    case minimum
    case maximum
}

/// The bounds one resizable surface obeys.
///
/// Values, not rules: the caller works out what its minimum and maximum are from whatever
/// layout it has, and hands the numbers over. `ResizeConstraints` knows nothing about
/// panels, boards or screens, which is what makes the model reusable on any edge of any
/// surface.
struct ResizeConstraints: Equatable, Sendable {
    /// The smallest size the surface is ever *drawn* at. Dragging below it does not shrink
    /// the surface — it pins, rubber-bands, and eventually collapses.
    let minimum: CGFloat

    /// The largest size the surface may be drawn at.
    let maximum: CGFloat

    /// The virtual size below which the gesture collapses the surface, or `nil` where the
    /// surface is not collapsible.
    ///
    /// Compared against the *unclamped* proposed size, never against the drawn one — that
    /// is what makes a collapse reversible inside a single gesture. See `ResizeModel`.
    let collapseBelow: CGFloat?

    /// Apple's `UIScrollView` rubber-band coefficient. Named rather than inlined so a caller
    /// that wants a stiffer edge can say so, and so the 0.55 has somewhere to be explained.
    let rubberBand: CGFloat

    /// The coefficient `UIScrollView` uses, in the formula `b = (1 − 1/((x·c/d) + 1))·d`.
    static let defaultRubberBand: CGFloat = 0.55

    init(
        minimum: CGFloat,
        maximum: CGFloat,
        collapseBelow: CGFloat? = nil,
        rubberBand: CGFloat = ResizeConstraints.defaultRubberBand
    ) {
        self.minimum = minimum
        self.maximum = maximum
        self.collapseBelow = collapseBelow
        self.rubberBand = rubberBand
    }

    /// False where the window has become too small to honour both bounds at once.
    ///
    /// The model refuses to guess in that case rather than silently preferring one bound:
    /// picking the maximum would draw a panel wider than the board it is commentary on, and
    /// picking the minimum would claim a width that does not exist. The caller — which knows
    /// it has a collapsed state to fall back to — decides.
    var isSatisfiable: Bool { maximum >= minimum }
}

/// One frame's answer.
///
/// `size` and `handleOffset` are separate because they diverge under rubber band: the
/// surface stops at its bound while the handle keeps following the finger, which is the
/// whole visual language of "you are pushing against something".
struct ResizeResolution: Equatable, Sendable {
    /// The size to draw the surface at. Always within the constraints when they are
    /// satisfiable.
    let size: CGFloat

    /// How far past `size`'s own seam to draw the handle, in the drag's own coordinate
    /// direction. Zero unless the gesture is overshooting a bound.
    let handleOffset: CGFloat

    /// Whether this gesture position collapses the surface.
    let isCollapsed: Bool

    /// Which bound the gesture is pushing against.
    let limit: ResizeLimit
}
```

- [ ] **Step 4: Regenerate the Xcode project and run the tests**

```bash
xcodegen generate && xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeModelTests 2>&1 | tail -30
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/DesignSystem/Resize/ResizeGeometry.swift MathTutorTests/ResizeModelTests.swift MathTutor.xcodeproj/project.pbxproj
git commit -m "Add the resize system's value types"
```

---

### Task 2: `ResizeModel` — the pure resolver

**Files:**
- Create: `MathTutor/DesignSystem/Resize/ResizeModel.swift`
- Modify: `MathTutorTests/ResizeModelTests.swift`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `ResizeModel.resolve(start:translation:edge:constraints:) -> ResizeResolution` and `ResizeModel.rubberBand(_:coefficient:dimension:) -> CGFloat`.

- [ ] **Step 1: Write the failing tests**

Append to `MathTutorTests/ResizeModelTests.swift`, inside the `ResizeModelTests` class:

```swift
    // MARK: - The resolver

    /// The tutor panel's own numbers: 337 floor, 600 ceiling at the reference size,
    /// collapse at 0.6 × 337.
    private var panel: ResizeConstraints {
        ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: 337 * 0.6)
    }

    private func resolve(start: CGFloat = 337, translation: CGFloat) -> ResizeResolution {
        ResizeModel.resolve(start: start, translation: translation, edge: .leading, constraints: panel)
    }

    func testNoTranslationIsNoChange() {
        let r = resolve(translation: 0)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
        XCTAssertEqual(r.limit, .none, "limit")
    }

    func testDraggingTowardTheOriginWidensALeadingEdgeSurface() {
        // The panel is pinned right; dragging its leading handle left is a negative
        // translation and must make the panel wider, not narrower.
        XCTAssertEqual(resolve(translation: -100).size, 437)
    }

    func testWidthIsClampedAtTheMaximumAndTheLimitIsReported() {
        let r = resolve(translation: -400) // 337 + 400 = 737, past the 600 ceiling
        XCTAssertEqual(r.size, 600, "size")
        XCTAssertEqual(r.limit, .maximum, "limit")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
    }

    func testWidthPinsAtTheMinimumBeforeTheCollapseThreshold() {
        // 337 − 50 = 287, below the floor but above 202.2.
        let r = resolve(translation: 50)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.limit, .minimum, "limit")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
    }

    func testCollapsesOnceTheVirtualSizeCrossesTheThreshold() {
        // 337 − 140 = 197, below 0.6 × 337 = 202.2.
        XCTAssertTrue(resolve(translation: 140).isCollapsed)
    }

    func testCollapseIsReversibleWithinOneGesture() {
        // The decision is recomputed from the gesture's total translation every frame
        // rather than latched, so dragging back out un-collapses.
        XCTAssertTrue(resolve(translation: 140).isCollapsed, "collapsed on the way in")
        XCTAssertFalse(resolve(translation: 40).isCollapsed, "un-collapsed on the way back")
    }

    func testANonCollapsibleSurfaceNeverCollapses() {
        let fixed = ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: nil)
        let r = ResizeModel.resolve(start: 337, translation: 5000, edge: .leading, constraints: fixed)
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
        XCTAssertEqual(r.size, 337, "size")
    }

    // MARK: - Anchored, not accumulated

    /// The property the whole model exists to guarantee, and the bug it exists to prevent.
    ///
    /// A resizer that accumulates per-frame deltas loses the travel spent pinned at a bound:
    /// each frame clamps, and the clamped value becomes the next frame's start, so dragging
    /// 300pt past the ceiling and 300pt back leaves the panel stuck at the ceiling instead
    /// of where it began. Resolving from the frozen start size and the gesture's *total*
    /// translation makes the round trip exact.
    func testDraggingPastABoundAndBackReturnsExactlyToTheStart() {
        let out = resolve(translation: -900)
        XCTAssertEqual(out.size, 600, "pinned at the ceiling on the way out")
        XCTAssertEqual(resolve(translation: 0).size, 337, "exactly back, not merely close")
    }

    func testResolutionDependsOnlyOnTotalTranslationNotOnHowItWasReached() {
        XCTAssertEqual(resolve(translation: -120).size, resolve(translation: -120).size)
        XCTAssertEqual(resolve(translation: -120).size, 457)
    }

    // MARK: - Rubber band

    func testRubberBandIsZeroAtZeroAndOddSymmetric() {
        XCTAssertEqual(ResizeModel.rubberBand(0, coefficient: 0.55, dimension: 337), 0)
        let positive = ResizeModel.rubberBand(100, coefficient: 0.55, dimension: 337)
        let negative = ResizeModel.rubberBand(-100, coefficient: 0.55, dimension: 337)
        XCTAssertEqual(positive, -negative, accuracy: 0.0001)
    }

    func testRubberBandGrowsMonotonicallyButAtADecreasingRate() {
        let a = ResizeModel.rubberBand(50, coefficient: 0.55, dimension: 337)
        let b = ResizeModel.rubberBand(100, coefficient: 0.55, dimension: 337)
        let c = ResizeModel.rubberBand(150, coefficient: 0.55, dimension: 337)
        XCTAssertTrue(a < b && b < c, "monotonic")
        XCTAssertTrue(b - a > c - b, "each further point of travel buys less")
        XCTAssertTrue(c < 337, "asymptotic to the dimension, never past it")
    }

    func testTheHandleOvershootsWhileTheSurfaceStaysPinned() {
        let r = resolve(translation: -400)
        XCTAssertEqual(r.size, 600, "the surface holds at its bound")
        // Leading edge, so a widening overshoot moves the handle further in the drag's own
        // negative direction.
        XCTAssertTrue(r.handleOffset < 0, "the handle keeps following the finger")
        XCTAssertTrue(abs(r.handleOffset) < abs(-400), "but with resistance")
    }

    func testTheHandleDoesNotOvershootInsideTheBounds() {
        XCTAssertEqual(resolve(translation: -100).handleOffset, 0)
    }

    // MARK: - Degenerate input

    func testUnsatisfiableConstraintsResolveToTheMinimumAndSayTheyArePinned() {
        // A window too narrow for both bounds. The model must not silently pick the maximum
        // and draw a panel wider than the board.
        let squeezed = ResizeConstraints(minimum: 337, maximum: 300, collapseBelow: 202)
        let r = ResizeModel.resolve(start: 337, translation: -50, edge: .leading, constraints: squeezed)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.limit, .minimum, "limit")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
    }

    func testNonFiniteInputResolvesToTheStartRatherThanPropagatingNaN() {
        for bad in [CGFloat.nan, .infinity, -.infinity] {
            let r = resolve(translation: bad)
            XCTAssertEqual(r.size, 337, "translation \(bad)")
            XCTAssertFalse(r.isCollapsed, "translation \(bad) must not collapse")
        }
        XCTAssertEqual(ResizeModel.resolve(
            start: .nan, translation: -10, edge: .leading, constraints: panel
        ).size, 337, "a non-finite start falls back to the minimum")
    }

    func testAFlickFarPastTheCeilingClampsRatherThanOvershooting() {
        XCTAssertEqual(resolve(translation: -100_000).size, 600)
    }

    // MARK: - The other edges

    func testATrailingEdgeSurfaceGrowsInTheOppositeDirection() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .trailing, constraints: panel)
        XCTAssertEqual(r.size, 437, "a left-hand sidebar widens when dragged right")
    }

    func testTheVerticalAxisUsesTheSameCodePath() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .bottom, constraints: panel)
        XCTAssertEqual(r.size, 437, "bottom edge, dragged down, grows")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeModelTests 2>&1 | tail -30
```

Expected: compile failure — "cannot find 'ResizeModel' in scope".

- [ ] **Step 3: Write the model**

Create `MathTutor/DesignSystem/Resize/ResizeModel.swift`:

```swift
import CoreGraphics

/// One drag position in, one resolved size out — and nothing else in the file.
///
/// **Anchored, not accumulated.** Every resolution is computed from the size frozen when the
/// gesture began plus the gesture's *total* translation. It is never the previous frame's
/// size plus a per-frame delta, and the distinction is the difference between a resizer that
/// works and one that sticks: a frame spent pinned at a bound clamps, and if that clamped
/// value becomes the next frame's start then the travel which should have brought the
/// surface back off the bound has been silently thrown away. Drag 300 points past the
/// ceiling and 300 back, and an accumulating implementation leaves you at the ceiling.
/// `react-resizable-panels` reaches the same conclusion — it applies the drag delta to a
/// layout snapshot frozen at pointer-down — and it is the single correctness property
/// `ResizeModelTests` guards hardest.
///
/// **The collapse decision reads the unclamped size.** `size` is what gets drawn and is
/// always inside the constraints; the collapse threshold is compared against the *virtual*
/// size the finger is asking for, which may be far below the minimum. That is what makes a
/// collapse reversible inside one gesture: nothing latches, so dragging back out simply
/// resolves to a non-collapsed answer again.
///
/// No SwiftUI import, no view, no state. This is the whole of the difficulty and all of it
/// is testable as a function.
enum ResizeModel {
    static func resolve(
        start: CGFloat,
        translation: CGFloat,
        edge: ResizeEdge,
        constraints: ResizeConstraints
    ) -> ResizeResolution {
        // A non-finite start would poison every comparison below and end up as a NaN frame
        // width; a non-finite translation is a gesture the system should not have delivered.
        // Both resolve to "no change", which is the only answer that cannot make things
        // worse.
        guard start.isFinite, translation.isFinite else {
            return settled(at: start.isFinite ? start : constraints.minimum, constraints: constraints)
        }

        // The size the finger is asking for, before any bound is applied. Everything else is
        // derived from this one number.
        let proposed = start + edge.growthSign * translation

        if let threshold = constraints.collapseBelow, proposed < threshold {
            return ResizeResolution(
                size: constraints.minimum,
                handleOffset: 0,
                isCollapsed: true,
                limit: .minimum
            )
        }

        // Too narrow a window to honour both bounds. Refusing to choose is deliberate:
        // preferring the maximum would draw a panel wider than the board it is commentary
        // on, and preferring the minimum would claim width that does not exist. The caller
        // has a collapsed state to fall back to and `ScreenLayout.fit` to decide with.
        guard constraints.isSatisfiable else {
            return settled(at: constraints.minimum, constraints: constraints)
        }

        let clamped = min(max(proposed, constraints.minimum), constraints.maximum)
        let overshoot = proposed - clamped

        let limit: ResizeLimit =
            if proposed > constraints.maximum { .maximum }
            else if proposed < constraints.minimum { .minimum }
            else { .none }

        // The rubber band's asymptote is the surface's own minimum, so the handle can never
        // be pulled more than one panel-width past a bound however hard the student drags.
        // Using the minimum rather than the screen — which is what `UIScrollView` uses — keeps
        // the resistance proportional to the thing being resized rather than to the device.
        let banded = rubberBand(
            overshoot,
            coefficient: constraints.rubberBand,
            dimension: constraints.minimum
        )

        return ResizeResolution(
            size: clamped,
            handleOffset: edge.growthSign * banded,
            isCollapsed: false,
            limit: limit
        )
    }

    /// Apple's `UIScrollView` resistance curve, `b = (1 − 1/((|x|·c/d) + 1))·d`, made
    /// odd-symmetric so it works off either bound.
    ///
    /// Monotonic, asymptotic to `d`, and with a decreasing return on further travel — which
    /// is what reads as elastic rather than as lag. `c` is 0.55 by default because that is
    /// the constant `UIScrollView` uses and the one every iOS user's hand is calibrated to.
    static func rubberBand(_ x: CGFloat, coefficient: CGFloat, dimension: CGFloat) -> CGFloat {
        guard x != 0, dimension > 0, x.isFinite else { return 0 }
        let magnitude = abs(x)
        let resisted = (1 - (1 / ((magnitude * coefficient / dimension) + 1))) * dimension
        return x < 0 ? -resisted : resisted
    }

    /// A resolution that is not moving: pinned at `size`, no overshoot, not collapsed.
    private static func settled(at size: CGFloat, constraints: ResizeConstraints) -> ResizeResolution {
        let limit: ResizeLimit =
            if size <= constraints.minimum { .minimum }
            else if size >= constraints.maximum { .maximum }
            else { .none }
        return ResizeResolution(size: size, handleOffset: 0, isCollapsed: false, limit: limit)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
xcodegen generate && xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeModelTests 2>&1 | tail -30
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/DesignSystem/Resize/ResizeModel.swift MathTutorTests/ResizeModelTests.swift MathTutor.xcodeproj/project.pbxproj
git commit -m "Add the resize resolver, anchored rather than accumulated"
```

---

### Task 3: `ScreenLayout.panelWidth` becomes a variable

**Files:**
- Modify: `MathTutor/DesignSystem/Layout.swift`
- Modify: `MathTutorTests/LayoutTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ScreenLayout.init(size:safeArea:panelWidth:)` with `panelWidth` defaulting to `DS.Container.panel`; instance `panelWidth`, `dockedLaneWidth`, `maximumPanelWidth`, `dockedMinimumWidth`. `ScreenLayout.minimumPanelWidth` (static).

**The one behaviour change:** `dockedMinimumWidth` stops being static, because it now depends on the panel's width. `collapsedMinimumWidth` stays static — there is no panel in the collapsed state, so a wide panel must not raise the threshold at which the board alone stops fitting.

- [ ] **Step 1: Write the failing tests**

Append to `MathTutorTests/LayoutTests.swift`, inside the `LayoutTests` class:

```swift
    // MARK: - A variable panel width

    /// The panel's width became an input rather than a constant, and the entire point of the
    /// change is that nothing else moved. Every derivation still lands on the board's number
    /// when the input is the board's number.
    func testDefaultPanelWidthReproducesTheBoard() {
        let l = ScreenLayout.reference
        XCTAssertEqual(l.panelWidth, 337, "panelWidth")
        XCTAssertEqual(l.panelX, 1011, "panelX")
        XCTAssertEqual(l.boardWidthDocked, 863, "boardWidthDocked")
        XCTAssertEqual(l.dockedMinimumWidth, 850, "dockedMinimumWidth")
    }

    func testAWiderPanelMovesTheSeamAndNarrowsTheBoardByTheSameAmount() {
        let l = ScreenLayout(
            size: CGSize(width: 1376, height: 1032),
            panelWidth: 437
        )
        XCTAssertEqual(l.panelWidth, 437, "panelWidth")
        XCTAssertEqual(l.panelX, 911, "panelX — 1348 − 437")
        XCTAssertEqual(l.boardWidthDocked, 763, "boardWidthDocked — 100 less than 863")
        XCTAssertEqual(
            l.boardWidthDocked + l.panelWidth + DS.Space.gap,
            l.contentRight - l.boardX,
            "the two lanes and their gap still tile the space exactly"
        )
    }

    /// `--container-panel` stops being the panel's width and becomes its floor.
    func testMinimumPanelWidthIsTheDesignsOwnPanelWidth() {
        XCTAssertEqual(ScreenLayout.minimumPanelWidth, DS.Container.panel)
        XCTAssertEqual(ScreenLayout.minimumPanelWidth, 337)
    }

    /// The maximum is `ScreenLayout.minimumBoardWidth`'s rule applied live: the board must
    /// never end up narrower than the panel beside it, so the panel gets at most half the
    /// lane the two share.
    func testMaximumPanelWidthIsHalfTheSharedLane() {
        let l = ScreenLayout.reference
        // lane = 1348 − 124 − 24 = 1200.
        XCTAssertEqual(l.dockedLaneWidth, 1200, "dockedLaneWidth")
        XCTAssertEqual(l.maximumPanelWidth, 600, "maximumPanelWidth")
    }

    func testAtItsMaximumThePanelExactlyEqualsTheBoard() {
        let l = ScreenLayout(
            size: CGSize(width: 1376, height: 1032),
            panelWidth: 600
        )
        XCTAssertEqual(l.boardWidthDocked, l.panelWidth, "the rule the maximum encodes")
    }

    /// A wider panel needs a wider window to stay docked. It must not, however, change the
    /// width at which the *collapsed* layout stops fitting — there is no panel in that state.
    func testAWiderPanelRaisesTheDockedThresholdButNotTheCollapsedOne() {
        let wide = ScreenLayout(size: CGSize(width: 1376, height: 1032), panelWidth: 600)
        XCTAssertEqual(wide.dockedMinimumWidth, 1113, "28×2 + 72 + 24×2 + 600 + 337")
        XCTAssertEqual(ScreenLayout.collapsedMinimumWidth, 489, "unchanged by the panel")
    }

    /// The reversibility rule: a window too narrow for a wide panel reports `.boardOnly`,
    /// and widening it again reports `.threeLane` — the layout is a function of its inputs
    /// with nothing latched, so nothing can oscillate.
    func testShrinkingAndRegrowingTheWindowRoundTripsTheFit() {
        let narrow = ScreenLayout(size: CGSize(width: 1024, height: 768), panelWidth: 600)
        XCTAssertEqual(narrow.fit, .boardOnly, "1024 is under the 1113 a 600pt panel needs")

        let wide = ScreenLayout(size: CGSize(width: 1376, height: 1032), panelWidth: 600)
        XCTAssertEqual(wide.fit, .threeLane, "and it comes back")
    }

    /// On a window too narrow to give the panel its floor without starving the board, the
    /// bounds cross. `ResizeConstraints.isSatisfiable` is what a caller checks; the layout
    /// only has to report the numbers honestly rather than clamping them into agreement.
    func testTheBoundsCrossOnAWindowTooNarrowToDock() {
        let narrow = ScreenLayout(size: CGSize(width: 800, height: 768))
        XCTAssertLessThan(narrow.maximumPanelWidth, ScreenLayout.minimumPanelWidth)
        XCTAssertEqual(narrow.fit, .boardOnly, "which is why nothing draws a docked panel here")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/LayoutTests 2>&1 | tail -30
```

Expected: compile failure — no `panelWidth:` parameter on `ScreenLayout.init`.

- [ ] **Step 3: Add the stored property and the new derivations**

In `MathTutor/DesignSystem/Layout.swift`, replace the `init` and its preceding doc comment with:

```swift
    /// Insets are `EdgeInsets` at the boundary (that is what `GeometryProxy` hands you) and
    /// scalars inside, so the type is trivially `Sendable` and its `Equatable` is four
    /// comparisons rather than a nested struct's.
    ///
    /// `panelWidth` arrives the same way and for the same reason the size does: it is an
    /// input the screen knows and the layout does not. It defaults to `--container-panel`,
    /// so every existing call site — and every preview, gallery specimen and test that never
    /// passes one — lays out exactly as it did when the panel was a constant.
    init(
        size: CGSize,
        safeArea: EdgeInsets = EdgeInsets(),
        panelWidth: CGFloat = ScreenLayout.minimumPanelWidth
    ) {
        self.size = size
        safeAreaTop = safeArea.top
        safeAreaLeading = safeArea.leading
        safeAreaTrailing = safeArea.trailing
        safeAreaBottom = safeArea.bottom
        self.panelWidth = panelWidth
    }
```

Add the stored property immediately after `safeAreaBottom`'s declaration:

```swift
    /// What the student has asked the docked panel to be, clamped by whoever set it.
    ///
    /// Board 02 called the panel *"the only fixed-width surface in the product"*, and for as
    /// long as the product was one device that was a description rather than a constraint.
    /// It is now an input, which changes nothing about the arithmetic below — `panelX` and
    /// `boardWidthDocked` were always written as subtractions from this number, so they
    /// follow for free.
    ///
    /// The design's 337 is its **floor**, not its value: see `minimumPanelWidth`. A panel is
    /// never drawn narrower than it was designed, only wider — or collapsed to the dock.
    let panelWidth: CGFloat
```

- [ ] **Step 4: Replace the static panel width with a floor, and add the ceiling**

In `MathTutor/DesignSystem/Layout.swift`, replace the `static let panelWidth` / `var panelWidth` pair with:

```swift
    /// `--container-panel`, now read as the smallest width the panel is ever *drawn* at.
    ///
    /// 337 is what leaves the 301pt column `--space-panel-inset` is specced against, and
    /// board 05 is explicit that the panel and full-screen treatments are *"two variants,
    /// not one responsive view"*. There is no third variant, so nothing narrower than the
    /// one that was drawn ever appears: dragging inward pins here and then collapses.
    static let minimumPanelWidth: CGFloat = DS.Container.panel

    /// The width the board and the panel share, gap included on the panel's side.
    ///
    /// `1348 − 124 − 24 = 1200` on the reference screen. It exists because the panel's
    /// ceiling is a statement about this lane rather than about the screen.
    var dockedLaneWidth: CGFloat { max(0, contentRight - boardX - DS.Space.gap) }

    /// Half the shared lane — which is `minimumBoardWidth`'s rule applied live rather than
    /// as a static floor.
    ///
    /// That constant says *"the board must never end up narrower than the panel it sits
    /// beside — the board is the product and the tutor is the commentary."* Written as a
    /// live constraint, `panel ≤ board` is `panel ≤ lane ÷ 2`, and the recursion the naive
    /// reading suggests — the maximum depending on `boardWidthDocked`, which depends on the
    /// panel — collapses algebraically before it ever needs iterating.
    ///
    /// `600` on the reference screen, where a panel at its ceiling is exactly as wide as the
    /// board. Deliberately **not** floored at `minimumPanelWidth`: on a window too narrow to
    /// dock at all the two bounds genuinely do cross, and reporting that honestly is what
    /// lets `ResizeConstraints.isSatisfiable` catch it instead of the layout quietly
    /// preferring one bound.
    var maximumPanelWidth: CGFloat { dockedLaneWidth / 2 }
```

- [ ] **Step 5: Make `dockedMinimumWidth` an instance property**

In `MathTutor/DesignSystem/Layout.swift`, replace the `static let dockedMinimumWidth` declaration with:

```swift
    /// `28 + 72 + 24 + 337 + 24 + 337 + 28 = 850` — edge + rail + gap + board + gap + panel +
    /// edge, with the board at its floor and the panel at whatever the student has asked for.
    ///
    /// Instance rather than static since the panel's width became an input: a wider panel
    /// genuinely does need a wider window to stay docked, and a threshold that ignored the
    /// panel would let a 600pt panel dock beside a 200pt board. `collapsedMinimumWidth`
    /// stays static for the mirror-image reason — there is no panel in that state, so a wide
    /// one must not raise the width at which the board alone stops fitting.
    var dockedMinimumWidth: CGFloat {
        2 * DS.Space.edge + Self.railWidth + 2 * DS.Space.gap + panelWidth + Self.minimumBoardWidth
    }
```

Then in `fit`, change `Self.dockedMinimumWidth` to `dockedMinimumWidth`.

- [ ] **Step 6: Fix the reference-size accessor**

In the `extension ScreenLayout` block of reference-size accessors near the bottom of `Layout.swift`, the line `static var panelX: CGFloat { reference.panelX }` already works. Add alongside it:

```swift
    static var panelWidth: CGFloat { reference.panelWidth }
```

This keeps `ScreenLayout.panelWidth` resolving as a static for any call site that still reads it that way.

- [ ] **Step 7: Run the whole layout suite**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/LayoutTests 2>&1 | tail -40
```

Expected: PASS. `testReferenceReproducesEveryPublishedConstant` passing unchanged is the point of the task — if it fails, the refactor changed a number it must not have.

- [ ] **Step 8: Run the full unit suite to catch call sites**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests 2>&1 | tail -40
```

Expected: PASS. If `ShellComponentTests` or `SettingsAndPlanTests` fail to compile on `ScreenLayout.dockedMinimumWidth`, change those references to read it off a layout instance.

- [ ] **Step 9: Commit**

```bash
git add MathTutor/DesignSystem/Layout.swift MathTutorTests/LayoutTests.swift
git commit -m "Make the panel's width an input to ScreenLayout rather than a constant"
```

---

### Task 4: The panel-width axis on `UIState`

**Files:**
- Modify: `MathTutor/App/UIState.swift`
- Modify: `MathTutorTests/UIStateTests.swift`

**Interfaces:**
- Consumes: `ScreenLayout.minimumPanelWidth` from Task 3.
- Produces: `UIState.panelWidth: CGFloat` (`@Published private(set)`), `UIState.setPanelWidth(_:)`, `UIState.resetPanelWidth()`.

- [ ] **Step 1: Write the failing tests**

Append to `MathTutorTests/UIStateTests.swift`, inside the test class:

```swift
    // MARK: - Panel width

    func testPanelWidthStartsAtTheDesignsOwnWidth() {
        XCTAssertEqual(UIState().panelWidth, ScreenLayout.minimumPanelWidth)
    }

    func testSettingPanelWidthRecordsIt() {
        let state = UIState()
        state.setPanelWidth(480)
        XCTAssertEqual(state.panelWidth, 480)
    }

    func testResettingReturnsToTheDesignsWidth() {
        let state = UIState()
        state.setPanelWidth(480)
        state.resetPanelWidth()
        XCTAssertEqual(state.panelWidth, ScreenLayout.minimumPanelWidth)
    }

    func testANonFiniteWidthIsRefusedRatherThanStored() {
        let state = UIState()
        state.setPanelWidth(480)
        state.setPanelWidth(.nan)
        XCTAssertEqual(state.panelWidth, 480, "the last good width survives")
    }

    /// Width and presentation are independent axes, exactly like the two the design already
    /// has. Collapsing must not forget the width, or reopening the panel would silently
    /// undo a resize the student asked for.
    func testCollapsingAndRestoringPreservesTheWidth() {
        let state = UIState()
        state.setPanelWidth(480)
        state.collapseTutor()
        XCTAssertEqual(state.panelWidth, 480, "still 480 while collapsed")
        state.restoreTutorFromDock()
        XCTAssertEqual(state.panelWidth, 480, "and on the way back")
    }

    func testSettingWidthDoesNotDisturbEitherOtherAxis() {
        let state = UIState()
        state.beginConversation()
        state.setPanelWidth(480)
        XCTAssertEqual(state.presentation, .docked, "presentation")
        XCTAssertEqual(state.conversation, .active, "conversation")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/UIStateTests 2>&1 | tail -30
```

Expected: compile failure — "value of type 'UIState' has no member 'setPanelWidth'".

- [ ] **Step 3: Add the axis**

In `MathTutor/App/UIState.swift`, add after `isSelectionAttached`'s declaration:

```swift
    /// Axis D: how wide the student has asked the docked panel to be.
    ///
    /// Guarded like the other axes rather than left settable, because there is exactly one
    /// control that changes it and one that resets it — the same shape the design's other
    /// three axes have.
    ///
    /// **Stored unclamped, on purpose.** This is the width that was *asked for*; what fits
    /// is a question about the window, and the window is not this type's business —
    /// `UIState` deliberately does not know about the screen, in the same way `ScreenLayout`
    /// deliberately does not force a presentation. `BoardScreen` reconciles the two, which
    /// is what makes a resize survive a trip through Split View: the requested width is
    /// still here when the window comes back.
    ///
    /// It does not persist, like everything else on this type.
    @Published private(set) var panelWidth: CGFloat = ScreenLayout.minimumPanelWidth
```

Add the two transitions next to the others:

```swift
    /// The resize handle in the gutter between the board and the panel.
    ///
    /// Non-finite values are refused rather than stored: a NaN here becomes a NaN frame
    /// width, and SwiftUI's response to that is an unrecoverable layout rather than a crash
    /// anybody could debug.
    func setPanelWidth(_ width: CGFloat) {
        guard width.isFinite else { return }
        panelWidth = width
    }

    /// Double-tapping the resize handle — VS Code's `onDidReset`, which is the one gesture
    /// every splitter in the world agrees on.
    func resetPanelWidth() {
        panelWidth = ScreenLayout.minimumPanelWidth
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/UIStateTests 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/App/UIState.swift MathTutorTests/UIStateTests.swift
git commit -m "Add the panel-width axis to UIState"
```

---

### Task 5: `ResizeHandle` — the gesture host

**Files:**
- Create: `MathTutor/DesignSystem/Resize/ResizeHandle.swift`
- Create: `MathTutorTests/ResizeHandleTests.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `ResizeHandleMetrics` (`.capsuleThickness`, `.capsuleLength`, `.capsuleRadius`, `.appear`, `.disappear`, `.minimumDragDistance`, `.accessibilityStep`, `.hitBreadth(gutter:into:)`), and `ResizeHandle(edge:span:gutter:contentMargin:constraints:size:onBegin:onCollapse:onReset:)`.

**The hit-geometry rule, restated because it is the part most likely to be got wrong:** the strip claims the gutter plus `contentMargin` into the surface it belongs to, and **zero** into the surface on the other side. Here the other side is a live `PKCanvasView`, and one point of overlap eats ink strokes exactly where a right-handed student's hand rests.

- [ ] **Step 1: Write the failing tests**

Create `MathTutorTests/ResizeHandleTests.swift`:

```swift
import CoreGraphics
import XCTest
@testable import MathTutor

/// The handle's own spec. The gesture itself is not asserted here — that is `ResizeModel`'s
/// job, and it is a function — so what is left is the hit geometry, which is the part with a
/// wrong answer that looks right.
final class ResizeHandleTests: XCTestCase {
    func testTheStripClaimsTheGutterPlusOnlyItsOwnSidesDeadMargin() {
        // 24pt of --space-gap, plus the panel's 18pt --space-panel-inset, and nothing at all
        // from the board: the board is a live PKCanvasView and any overlap eats ink.
        XCTAssertEqual(
            ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: DS.Space.panelInset),
            42
        )
    }

    func testTheStripIsNeverNarrowerThanTheGutterItSitsIn() {
        XCTAssertEqual(ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: 0), 24)
        XCTAssertEqual(
            ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: -100),
            24,
            "a negative margin cannot shrink the strip below its gutter"
        )
    }

    /// 42 is under the HIG's 44, and that is a deliberate trade rather than an oversight: the
    /// strip is 42 × the full content band, and a long thin target is easy to acquire. The
    /// alternative was claiming two points of canvas, which is not a trade worth making.
    func testTheStripIsWithinTwoPointsOfTheHIGMinimum() {
        let breadth = ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: DS.Space.panelInset)
        XCTAssertGreaterThanOrEqual(breadth, 42)
        XCTAssertLessThanOrEqual(44 - breadth, 2)
    }

    func testTheCapsuleFitsInsideTheGutterItIsDrawnIn() {
        XCTAssertLessThanOrEqual(
            ResizeHandleMetrics.capsuleThickness,
            DS.Space.gap,
            "a capsule wider than the gutter would paint over the board or the panel"
        )
    }

    func testTheDragHasToTravelBeforeItCounts() {
        XCTAssertGreaterThan(
            ResizeHandleMetrics.minimumDragDistance,
            0,
            "otherwise a tap on the strip resizes the panel by half a point"
        )
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeHandleTests 2>&1 | tail -30
```

Expected: compile failure — "cannot find 'ResizeHandleMetrics' in scope".

- [ ] **Step 3: Write the handle**

Create `MathTutor/DesignSystem/Resize/ResizeHandle.swift`:

```swift
import SwiftUI

/// The resize strip's own numbers.
///
/// Split out from the view for the same reason `TutorPanelMetrics` is: the numbers are
/// assertable without a host, and a spec that lives in a `body` cannot be regression-tested.
enum ResizeHandleMetrics {
    /// Painted only while the gesture is live. Fits inside `--space-gap` with room either
    /// side, so it never touches the surfaces it sits between.
    static let capsuleThickness: CGFloat = 4
    static let capsuleLength: CGFloat = 48
    static let capsuleRadius: CGFloat = DS.Radius.xs

    static let appear: Double = 0.12
    static let disappear: Double = 0.18

    /// Non-zero so a tap on the strip is a tap and not a half-point resize. Two points is
    /// enough to reject a tap and small enough that the drag still feels like it starts
    /// under the finger.
    static let minimumDragDistance: CGFloat = 2

    /// How much one VoiceOver increment moves the edge. `--space-gap`, so the adjustable
    /// action moves the panel by a unit the design already uses.
    static let accessibilityStep: CGFloat = DS.Space.gap

    /// How wide the grabbable strip is: all of the gutter, plus whatever dead margin the
    /// surface it belongs to can spare, and **nothing** from the surface opposite.
    ///
    /// The asymmetry is the whole rule, and it is where this departs from every splitter it
    /// was modelled on. VS Code centres its sash on the seam and `react-resizable-panels`
    /// grows its hit region evenly in both directions, which is right when both neighbours
    /// are ordinary content. Here one of them is a live `PKCanvasView`: a hit region that
    /// overlaps it by a single point swallows ink strokes at exactly the place a
    /// right-handed student's hand rests. So the general rule this encodes is that **a
    /// resize region may only claim space no content can reach** — and where a neighbour's
    /// content runs to its own edge, the margin on that side is zero.
    ///
    /// For the tutor panel that is `24 + 18 = 42`: `--space-gap` is empty screen-grey, and
    /// `--space-panel-inset` is dead by construction because board 02 specs the 301pt column
    /// against it.
    static func hitBreadth(gutter: CGFloat, into contentMargin: CGFloat) -> CGFloat {
        gutter + max(0, contentMargin)
    }
}

/// A drag strip that resizes the surface it is attached to.
///
/// Reusable on any edge of any surface: it takes an edge, the constraints to obey and a
/// binding to write, and knows nothing about panels, boards or `ScreenLayout`. Both axes
/// work, because `ResizeEdge` carries the sign and `ResizeModel` has one code path.
///
/// **Nothing is painted at rest.** The strip occupies gutter that already exists, so adding
/// it changes no layout and creates no space. That costs discoverability, which is a trade
/// made deliberately: the two `PanelControls` buttons remain the visible route to the same
/// states, and the mitigations here — the double-tap reset and the adjustable action — cost
/// no pixels.
///
/// **The feedback is haptic, and that is not decoration.** A desktop splitter tells you it
/// has been grabbed by changing the cursor and tells you it has hit a bound by changing it
/// again. A touchscreen has neither, and worse, the finger covers the pixels a touch-down
/// state would reveal. So `.sensoryFeedback` carries what the cursor carried: a light impact
/// on grab, a rigid one the moment a bound is reached, a medium one on collapse.
struct ResizeHandle: View {
    /// Which edge of the surface this sits on. Supplies the direction of growth.
    let edge: ResizeEdge

    /// How long the strip is along its own axis — the full height of the content band for a
    /// vertical seam.
    let span: CGFloat

    /// The empty space between the two surfaces that the strip may claim in full.
    let gutter: CGFloat

    /// How far into its own surface the strip may reach — the surface's dead inset. Never
    /// the opposite surface's; see `ResizeHandleMetrics.hitBreadth`.
    let contentMargin: CGFloat

    /// The bounds to obey. Recomputed by the caller on every layout pass, so a window change
    /// re-clamps without this view knowing anything happened.
    let constraints: ResizeConstraints

    /// The size being driven. Written on every frame of the drag.
    @Binding var size: CGFloat

    /// Fired once when a drag begins, so the caller can freeze whatever it needs to.
    var onBegin: () -> Void = {}

    /// Fired when the gesture crosses the collapse threshold.
    var onCollapse: () -> Void = {}

    /// Double-tap. VS Code's `onDidReset`.
    var onReset: () -> Void = {}

    /// The size when this gesture started. **This is the anchor** — every frame resolves
    /// from it plus the gesture's total translation, never from the previous frame. See
    /// `ResizeModel`.
    @State private var startSize: CGFloat?

    /// What the last resolved frame reported, kept only to drive the capsule and the
    /// haptics.
    @State private var overshoot: CGFloat = 0
    @State private var limit: ResizeLimit = .none
    @State private var isDragging = false
    @State private var collapseCount = 0
    @State private var grabCount = 0

    var body: some View {
        strip
            .contentShape(Rectangle())
            .overlay(capsule)
            .gesture(drag)
            .onTapGesture(count: 2) { onReset() }
            .accessibilityElement()
            .accessibilityLabel("Resize the tutor panel")
            .accessibilityValue("\(Int(size.rounded())) points")
            .accessibilityAdjustableAction(adjust)
            // The three haptics that replace a desktop cursor. `.rigid` fires on the
            // *transition* into a limit rather than every frame spent inside one, because
            // `limit` only changes when the state does.
            .sensoryFeedback(.impact(weight: .light), trigger: grabCount)
            .sensoryFeedback(.impact(flexibility: .rigid), trigger: limit) { _, new in
                new != .none
            }
            .sensoryFeedback(.impact(weight: .medium), trigger: collapseCount)
    }

    // MARK: - Geometry

    private var breadth: CGFloat {
        ResizeHandleMetrics.hitBreadth(gutter: gutter, into: contentMargin)
    }

    /// The strip takes no space in layout — it is `.overlay`-style furniture placed by its
    /// caller — but it does need a size to hit-test against.
    @ViewBuilder
    private var strip: some View {
        switch edge.axis {
        case .horizontal: Color.clear.frame(width: breadth, height: span)
        case .vertical: Color.clear.frame(width: span, height: breadth)
        }
    }

    /// The one thing that is ever painted, and only while a finger is down.
    ///
    /// It is drawn at the strip's centre rather than at the finger's position, which is a
    /// simplification the span makes safe: the strip is the full height of the band, so a
    /// centred capsule is never far from the finger, and tracking the touch's `y` would put
    /// the capsule directly under the fingertip where it cannot be seen anyway.
    @ViewBuilder
    private var capsule: some View {
        if isDragging {
            RoundedRectangle(cornerRadius: ResizeHandleMetrics.capsuleRadius)
                .fill(DS.Color.inkTertiary)
                .frame(
                    width: edge.axis == .horizontal
                        ? ResizeHandleMetrics.capsuleThickness
                        : ResizeHandleMetrics.capsuleLength,
                    height: edge.axis == .horizontal
                        ? ResizeHandleMetrics.capsuleLength
                        : ResizeHandleMetrics.capsuleThickness
                )
                .offset(
                    x: edge.axis == .horizontal ? overshoot : 0,
                    y: edge.axis == .vertical ? overshoot : 0
                )
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }

    // MARK: - The gesture

    private var drag: some Gesture {
        DragGesture(minimumDistance: ResizeHandleMetrics.minimumDragDistance)
            .onChanged { value in
                let anchor = startSize ?? beginDrag()
                let translation = edge.axis == .horizontal
                    ? value.translation.width
                    : value.translation.height

                let resolution = ResizeModel.resolve(
                    start: anchor,
                    translation: translation,
                    edge: edge,
                    constraints: constraints
                )

                // Unanimated, deliberately. The panel must track the finger one-for-one;
                // wrapping this in a `withAnimation` is the classic failure and produces a
                // panel that lags behind the drag. Only the *release* animates.
                size = resolution.size
                limit = resolution.limit
                withAnimation(.easeOut(duration: ResizeHandleMetrics.appear)) {
                    overshoot = resolution.handleOffset
                }

                if resolution.isCollapsed {
                    collapseCount += 1
                    endDrag()
                    onCollapse()
                }
            }
            .onEnded { _ in endDrag() }
    }

    private func beginDrag() -> CGFloat {
        startSize = size
        grabCount += 1
        withAnimation(.easeOut(duration: ResizeHandleMetrics.appear)) { isDragging = true }
        onBegin()
        return size
    }

    /// The single exit from a drag, however it ends — released, collapsed, or cancelled out
    /// from under us by a backgrounding or a window change. It always leaves a committed
    /// state and never a half-drag, which is why every path goes through here rather than
    /// unwinding its own state.
    private func endDrag() {
        startSize = nil
        limit = .none
        withAnimation(.easeOut(duration: ResizeHandleMetrics.disappear)) {
            isDragging = false
            overshoot = 0
        }
    }

    private func adjust(_ direction: AccessibilityAdjustmentDirection) {
        let step = direction == .increment
            ? ResizeHandleMetrics.accessibilityStep
            : -ResizeHandleMetrics.accessibilityStep
        guard constraints.isSatisfiable else { return }
        size = min(max(size + step, constraints.minimum), constraints.maximum)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
xcodegen generate && xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ResizeHandleTests 2>&1 | tail -30
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/DesignSystem/Resize/ResizeHandle.swift MathTutorTests/ResizeHandleTests.swift MathTutor.xcodeproj/project.pbxproj
git commit -m "Add the reusable resize handle"
```

---

### Task 6: Wire the handle into `BoardScreen`

**Files:**
- Modify: `MathTutor/Features/Board/BoardScreen.swift`
- Modify: `MathTutorTests/ShellComponentTests.swift`

**Interfaces:**
- Consumes: `ResizeHandle`, `ResizeConstraints` (Tasks 1, 5); `ScreenLayout.maximumPanelWidth` / `minimumPanelWidth` (Task 3); `UIState.panelWidth` / `setPanelWidth` / `resetPanelWidth` (Task 4).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `MathTutorTests/ShellComponentTests.swift`, inside the test class:

```swift
    // MARK: - The resizable panel

    /// The reconciliation `BoardScreen` performs, asserted as arithmetic rather than through
    /// the view: a requested width is clamped by the window it lands in, and the request
    /// itself is never overwritten.
    private func clampedPanelWidth(requested: CGFloat, in layout: ScreenLayout) -> CGFloat {
        min(max(requested, ScreenLayout.minimumPanelWidth), layout.maximumPanelWidth)
    }

    func testARequestedWidthIsHonouredWhereItFits() {
        let l = ScreenLayout(size: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(clampedPanelWidth(requested: 480, in: l), 480)
    }

    func testARequestedWidthIsClampedDownOnASmallerWindow() {
        // An 1112 × 834 iPad Air: lane = 1112 − 28 − 72 − 24 − 24 − 28 = 936, so max = 468.
        let l = ScreenLayout(size: CGSize(width: 1112, height: 834))
        XCTAssertEqual(l.maximumPanelWidth, 468, "maximumPanelWidth")
        XCTAssertEqual(clampedPanelWidth(requested: 600, in: l), 468, "clamped, not honoured")
    }

    /// The reversibility contract. The requested width is presentation state that survives
    /// the window shrinking, so widening the window restores exactly what the student asked
    /// for rather than whatever the small window allowed.
    func testShrinkingThenGrowingTheWindowRestoresTheRequestedWidth() {
        let requested: CGFloat = 600
        let small = ScreenLayout(size: CGSize(width: 1112, height: 834))
        XCTAssertEqual(clampedPanelWidth(requested: requested, in: small), 468, "squeezed")

        let large = ScreenLayout(size: CGSize(width: 1376, height: 1032))
        XCTAssertEqual(clampedPanelWidth(requested: requested, in: large), 600, "and restored")
    }

    func testTheClampedWidthNeverLeavesTheBoardNarrowerThanThePanel() {
        for width in [1024, 1112, 1180, 1366, 1376] as [CGFloat] {
            let l = ScreenLayout(size: CGSize(width: width, height: 1032))
            guard l.maximumPanelWidth >= ScreenLayout.minimumPanelWidth else { continue }
            let clamped = clampedPanelWidth(requested: 5000, in: l)
            let resolved = ScreenLayout(size: CGSize(width: width, height: 1032), panelWidth: clamped)
            XCTAssertGreaterThanOrEqual(
                resolved.boardWidthDocked,
                resolved.panelWidth,
                "at \(width): the board is the product and the tutor is the commentary"
            )
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ShellComponentTests 2>&1 | tail -30
```

Expected: FAIL on `testARequestedWidthIsClampedDownOnASmallerWindow` if `maximumPanelWidth` is wrong, or PASS if Task 3 was correct. Either way these assertions must be green before Step 3 proceeds — they pin the arithmetic the view is about to depend on.

- [ ] **Step 3: Feed the requested width into the layout**

In `MathTutor/Features/Board/BoardScreen.swift`, replace the `layout` computed property's `return measuredLayout` and the `--ui-window` branch's `return ScreenLayout(...)` so both carry the panel width. The property becomes:

```swift
    private var layout: ScreenLayout {
        #if DEBUG
        if let window = LaunchOptions.current.window {
            // The insets are kept, not zeroed: a smaller window on an iPad still sits under
            // the same status bar and the same home indicator, and `contentTop` is measured
            // from those rather than from the glass.
            return resized(
                ScreenLayout(
                    size: window,
                    safeArea: EdgeInsets(
                        top: measuredLayout.safeAreaTop,
                        leading: measuredLayout.safeAreaLeading,
                        bottom: measuredLayout.safeAreaBottom,
                        trailing: measuredLayout.safeAreaTrailing
                    )
                )
            )
        }
        #endif
        return resized(measuredLayout)
    }

    /// The student's requested panel width, reconciled with the window it has to fit in.
    ///
    /// A clamp on read rather than a write back into `UIState`, which is the same move
    /// `presentation` makes one property down and for the same reason: it is what keeps a
    /// resize reversible. A window that shrinks squeezes the panel; a window that grows
    /// again restores exactly what was asked for, because what was asked for was never
    /// overwritten. Clamping here rather than at the gesture is also what handles the window
    /// changing while nobody is dragging at all — Split View, Stage Manager, an external
    /// display — since this evaluates on every layout pass.
    private func resized(_ layout: ScreenLayout) -> ScreenLayout {
        guard layout.maximumPanelWidth >= ScreenLayout.minimumPanelWidth else { return layout }
        let width = min(
            max(uiState.panelWidth, ScreenLayout.minimumPanelWidth),
            layout.maximumPanelWidth
        )
        return ScreenLayout(
            size: layout.size,
            safeArea: EdgeInsets(
                top: layout.safeAreaTop,
                leading: layout.safeAreaLeading,
                bottom: layout.safeAreaBottom,
                trailing: layout.safeAreaTrailing
            ),
            panelWidth: width
        )
    }
```

- [ ] **Step 4: Place the handle**

In `MathTutor/Features/Board/BoardScreen.swift`, extend the `tutor` view builder's `.docked` case:

```swift
        case .docked:
            TutorPanel(text: $composerText, dictation: dictation, actions: actions)
                .offset(x: layout.panelX, y: layout.contentTop)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("tutor-panel")
            resizeHandle
```

and add the property alongside it:

```swift
    /// The drag strip in the gutter between the board and the panel.
    ///
    /// Mounted only in the `.docked` case of `tutor`, which means it does not exist when the
    /// panel is collapsed or full-screen rather than existing invisibly and staying
    /// hittable — a strip with nothing to resize is a control that eats touches on the
    /// board. Settings needs no case of its own: `settingsWindow` covers the whole screen,
    /// so a handle under it is unreachable by construction.
    ///
    /// It is positioned by its **trailing** edge against the panel, so the strip runs from
    /// `panelX − gutter` to `panelX + panelInset` and claims not one point of the canvas.
    @ViewBuilder
    private var resizeHandle: some View {
        let constraints = ResizeConstraints(
            minimum: ScreenLayout.minimumPanelWidth,
            maximum: layout.maximumPanelWidth,
            collapseBelow: ScreenLayout.minimumPanelWidth * Self.panelCollapseFraction
        )
        if constraints.isSatisfiable {
            ResizeHandle(
                edge: .leading,
                span: layout.contentHeight,
                gutter: DS.Space.gap,
                contentMargin: DS.Space.panelInset,
                constraints: constraints,
                size: Binding(
                    get: { layout.panelWidth },
                    set: uiState.setPanelWidth
                ),
                onCollapse: uiState.collapseTutor,
                onReset: uiState.resetPanelWidth
            )
            .frame(
                width: ResizeHandleMetrics.hitBreadth(
                    gutter: DS.Space.gap,
                    into: DS.Space.panelInset
                ),
                height: layout.contentHeight,
                alignment: .topLeading
            )
            .offset(x: layout.panelX - DS.Space.gap, y: layout.contentTop)
        }
    }

    /// How far below its floor the *virtual* panel width has to be dragged before the
    /// gesture collapses the tutor to the dock.
    ///
    /// The one proportion in the resize system that no token names, and it earns the
    /// exception by never landing on screen: it is a gesture threshold, not a layout value.
    /// `0.6 × 337 = 202`, which is 135 points of finger travel past the floor — far enough
    /// that no ordinary narrowing drag trips it, close enough that reaching for it is one
    /// motion rather than two.
    private static let panelCollapseFraction: CGFloat = 0.6
```

- [ ] **Step 5: Verify the board does not re-centre mid-drag**

Read `MathTutor/Features/Board/BoardCanvas.swift` and confirm `centerOnContent` is only called from the rail's `onCentreOnWork` action, never from a size-change observer. If a `sizeThatFits`, `updateUIView` or `layoutSubviews` path calls it, guard that call so it does not fire while the width is changing — a canvas that re-centres on every frame of the drag throws the student's work around under their hand.

Run the app and drag the handle end to end:

```bash
scripts/run-sim.sh
```

Expected: the board's ink stays put; only the canvas's frame changes.

- [ ] **Step 6: Run the full unit suite**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests 2>&1 | tail -40
```

Expected: PASS, everything.

- [ ] **Step 7: Commit**

```bash
git add MathTutor/Features/Board/BoardScreen.swift MathTutorTests/ShellComponentTests.swift
git commit -m "Wire the resize handle into the docked board screen"
```

---

### Task 7: The reference-render guard

**Files:**
- Modify: `MathTutorTests/ShellComponentTests.swift`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

The `--ui-fixture` run exists to be diffed against `design/reference/screen-0*.png`. Nothing in this change may move it: the handle paints nothing at rest, so the render must be byte-identical to what shipped.

- [ ] **Step 1: Write the failing test**

Append to `MathTutorTests/ShellComponentTests.swift`:

```swift
    /// The fixture run is diffed against `design/reference/*.png`, and this whole change is
    /// supposed to be invisible in it: the strip paints nothing at rest, occupies gutter
    /// that already existed, and takes no space in layout. If any published lane moved, the
    /// diff would fail for a reason nobody would connect to a resize handle.
    func testTheReferenceScreenIsUnmovedByTheResizeSystem() {
        let l = ScreenLayout.reference
        XCTAssertEqual(l.panelWidth, 337, "panelWidth")
        XCTAssertEqual(l.panelX, 1011, "panelX")
        XCTAssertEqual(l.boardX, 124, "boardX")
        XCTAssertEqual(l.boardWidthDocked, 863, "boardWidthDocked")
        XCTAssertEqual(l.contentTop, 28, "contentTop")
        XCTAssertEqual(l.contentHeight, 976, "contentHeight")
    }

    /// The strip's own footprint, asserted against the lanes rather than as literals, so it
    /// cannot silently start overlapping the canvas if a token moves.
    func testTheStripLiesEntirelyOutsideTheBoard() {
        let l = ScreenLayout.reference
        let stripLeft = l.panelX - DS.Space.gap
        let boardRight = l.boardX + l.boardWidthDocked
        XCTAssertGreaterThanOrEqual(stripLeft, boardRight, "not one point of canvas is claimed")

        let stripRight = stripLeft + ResizeHandleMetrics.hitBreadth(
            gutter: DS.Space.gap,
            into: DS.Space.panelInset
        )
        XCTAssertLessThanOrEqual(
            stripRight,
            l.panelX + DS.Space.panelInset,
            "and it stops at the panel's content column"
        )
    }
```

- [ ] **Step 2: Run it**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData -only-testing:MathTutorTests/ShellComponentTests 2>&1 | tail -30
```

Expected: PASS. A failure here means an earlier task moved a published lane.

- [ ] **Step 3: Run the whole suite, unit and UI**

```bash
xcodebuild test -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath build/DerivedData 2>&1 | tail -40
```

Expected: PASS.

- [ ] **Step 4: Manual acceptance pass**

```bash
scripts/run-sim.sh
```

Walk the list and confirm each:

1. Drag the seam left — the panel widens, the board narrows, one-for-one with the finger.
2. Keep dragging past 600 — the panel stops, the capsule keeps following with resistance, one haptic on arrival.
3. Drag back out and release at the start — the panel returns to exactly 337, not near it.
4. Drag right past 337 — the panel pins, then collapses to the dock with a medium haptic.
5. Tap the dock orb — the panel returns at the width it had before collapsing.
6. Double-tap the strip — the panel returns to 337.
7. Tap the strip without moving — nothing happens.
8. Draw with a finger or Pencil at the board's right edge — every stroke lands; nothing is eaten.
9. Open Settings while docked — the strip is unreachable under the window.
10. Collapse the tutor, then try to drag where the strip was — nothing happens.

- [ ] **Step 5: Commit**

```bash
git add MathTutorTests/ShellComponentTests.swift
git commit -m "Guard the reference render and the strip's footprint"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: constraints table → Task 3; drag feel and haptics → Task 5; the four architecture units → Tasks 1, 2, 5; wiring → Task 6. Edge cases: ①③ Task 6 (`resized`, round-trip tests), ② Task 4 (unclamped storage) + Task 6, ④ Tasks 1–2 (`isSatisfiable`), ⑤⑨⑪ Task 2, ⑥⑦ SwiftUI's `DragGesture` by construction, ⑧ Task 5 (`endDrag` as the single exit), ⑩⑬ Task 6 (mounted only when docked), ⑫ Task 6 (Settings covers the screen), ⑭⑮ Tasks 2 and 4, ⑯ Task 5, ⑰ Task 6 Step 5, ⑱ Task 5 (unanimated `size`, animated capsule), ⑲ Task 7.

**Out of scope, as the spec says:** persistence (task chip), corner resize, the Settings window and full-screen column as consumers, and any vertical consumer. The axis and the handle support vertical; nothing uses it.

**Known follow-up.** Step 5 of Task 6 is an inspection rather than an assertion, because whether `BoardCanvas` re-centres on resize cannot be known without reading it. If it does, that becomes its own task.
