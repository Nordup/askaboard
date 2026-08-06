# Infinite Whiteboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a student pan and write in every direction from where a session starts, instead of being confined to a 2,400 × 1,600 pt page anchored at its top-left corner.

**Architecture:** `PKCanvasView` gets a fixed 50,000 × 50,000 pt content size with the session origin at its center, `(25000, 25000)`, so the scroll view has room on all four sides of the start position. A pure `CanvasScroller` helper owns all offset math; the canvas scrolls to existing ink on first layout (which also handles sessions saved under the old coordinates), a toolbar control returns to that ink on demand, and board evaluation renders the bounding box of all strokes rather than the visible viewport.

**Tech Stack:** Swift 5, SwiftUI + UIKit (`UIViewRepresentable`), PencilKit, XCTest, XCUITest, xcodebuild.

**Spec:** `docs/superpowers/specs/2026-08-06-infinite-whiteboard-design.md`

## Global Constraints

- Board extent is exactly `50_000` pt square; board origin is exactly `CGPoint(x: 25_000, y: 25_000)`. Do not substitute other magnitudes — the spec's precision analysis depends on these values.
- Zoom range becomes `0.25 ... 3`, default `1`.
- `contentInset` becomes `.zero`; `contentInsetAdjustmentBehavior = .never` stays.
- No changes to `LearningSession`, persistence format, or any `Codable` shape. Sessions saved before this change must keep working with no migration.
- Rectangle-selection evaluation stays viewport-based. Only full-board evaluation changes.
- Target OS floor is iPadOS 17 (per README); use no API newer than that.
- Every task ends with the full unit test target green, not just the new tests.

**Build and test commands** (used verbatim throughout):

Full unit test target:

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

A single test:

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests/MathTutorTests/testCanvasScrollerCentersInkAndClampsAtBoardEdges test
```

If that simulator is not installed, pick any available iPadOS 17+ destination from `xcrun simctl list devices available` and use it consistently.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `MathTutor/CanvasView.swift` | Board geometry, scroll math, capture/rasterization, `UIViewRepresentable` bridge | Modify — `PencilCanvasConfiguration` constants, new `CanvasScroller`, `CanvasCapture.centerOnContent` + `snapshotAllInkData`, coordinator scroll-to-ink |
| `MathTutor/WorkspaceView.swift` | Workspace chrome and evaluation actions | Modify — toolbar button (`actionBar(compact:)`, ~line 406), `evaluateFullCanvas()` (~line 535) |
| `MathTutorTests/MathTutorTests.swift` | Unit tests | Modify — update two existing tests + one helper, add six tests |
| `MathTutorUITests/MathTutorUITests.swift` | E2E | Modify — one assertion inside `testE2ESeedLaunchOpensRadicalWorkspace` |
| `README.md` | Docs | Modify — architecture bullet, prototype-limitations sentence, QA checklist bullet |

`CanvasView.swift` is 383 lines and already groups these concerns coherently (configuration → mapping → capture → representable → DEBUG fixture). Keep that order; add `CanvasScroller` directly after `PencilCanvasConfiguration`, since the configuration calls into it. No file split is warranted.

---

### Task 1: Board geometry and `CanvasScroller`

Turns the page into a board and puts all offset math in one pure, testable place. Nothing scrolls to ink yet — that is Task 2.

**Files:**
- Modify: `MathTutor/CanvasView.swift:5-64` (`PencilCanvasConfiguration`), add `CanvasScroller` after it
- Test: `MathTutorTests/MathTutorTests.swift` — replace the test at `:38-45`, update the helpers at `:760-764` and `:766-789`, add three tests

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, relied on by Tasks 2–4:
  - `PencilCanvasConfiguration.boardExtent: CGFloat` (`50_000`)
  - `PencilCanvasConfiguration.boardOrigin: CGPoint` (`(25_000, 25_000)`)
  - `PencilCanvasConfiguration.contentSize(for viewport: CGSize) -> CGSize`
  - `PencilCanvasConfiguration.initialContentOffset(viewport: CGSize) -> CGPoint` — **signature change**, previously took no argument
  - `CanvasScroller.offset(centering target: CGRect, viewport: CGSize, zoomScale: CGFloat, scaledContentSize: CGSize) -> CGPoint`
  - Test helper `makeDrawing(color: UIColor, origin: CGPoint = CGPoint(x: 120, y: 250)) -> PKDrawing` — **signature change**, gains a defaulted parameter
- Removed (no longer referenced anywhere): `PencilCanvasConfiguration.minimumContentSize`, `PencilCanvasConfiguration.contentInset`

**Coordinate-space contract — read before writing `CanvasScroller`:**
`UIScrollView` reports `contentOffset`, `bounds`, and `contentSize` in *scaled* space (they already include `zoomScale`), while `PKDrawing` coordinates are *unscaled*. This is the same convention `CanvasViewportMapper` uses at `CanvasView.swift:71-83`, which divides by zoom to go from scroll space to drawing space. `CanvasScroller` goes the other way: it takes an unscaled `target`, multiplies by `zoomScale`, and returns a scaled offset. `scaledContentSize` is `canvas.contentSize` read straight off the view.

- [ ] **Step 1: Write the failing tests**

In `MathTutorTests/MathTutorTests.swift`, replace `testPencilCanvasConfigurationHasStableContentAndZoomBounds` (lines 38-45) entirely with the three tests below:

```swift
    func testPencilCanvasConfigurationCentersAnInfiniteBoard() {
        let viewport = CGSize(width: 1_024, height: 768)
        let contentSize = PencilCanvasConfiguration.contentSize(for: viewport)

        XCTAssertEqual(contentSize.width, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(contentSize.height, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(PencilCanvasConfiguration.boardOrigin, CGPoint(x: 25_000, y: 25_000))

        // The session starts in the middle of the board, not at a corner, which
        // is what makes panning up and left possible at all.
        let offset = PencilCanvasConfiguration.initialContentOffset(viewport: viewport)
        XCTAssertEqual(offset.x, 25_000 - 512, accuracy: 0.001)
        XCTAssertEqual(offset.y, 25_000 - 384, accuracy: 0.001)

        XCTAssertEqual(PencilCanvasConfiguration.minimumZoomScale, 0.25, accuracy: 0.0001)
        XCTAssertLessThan(PencilCanvasConfiguration.minimumZoomScale, PencilCanvasConfiguration.defaultZoomScale)
        XCTAssertLessThan(PencilCanvasConfiguration.defaultZoomScale, PencilCanvasConfiguration.maximumZoomScale)
    }

    func testCanvasScrollerCentersInkAndClampsAtBoardEdges() {
        let viewport = CGSize(width: 1_000, height: 800)
        let board = CGSize(width: 50_000, height: 50_000)

        let centered = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(centered.x, 24_500, accuracy: 0.001)
        XCTAssertEqual(centered.y, 24_600, accuracy: 0.001)

        // Ink near a corner cannot be centered; the offset clamps to the
        // scrollable range instead of scrolling past the board.
        let clampedLow = CanvasScroller.offset(
            centering: CGRect(x: 10, y: 10, width: 20, height: 20),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedLow.x, 0, accuracy: 0.001)
        XCTAssertEqual(clampedLow.y, 0, accuracy: 0.001)

        let clampedHigh = CanvasScroller.offset(
            centering: CGRect(x: 49_980, y: 49_980, width: 10, height: 10),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedHigh.x, 49_000, accuracy: 0.001)
        XCTAssertEqual(clampedHigh.y, 49_200, accuracy: 0.001)

        // The target is unscaled drawing space, the result is scaled scroll
        // space, so the same ink sits twice as far out at 2x zoom.
        let zoomed = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 2,
            scaledContentSize: CGSize(width: 100_000, height: 100_000)
        )
        XCTAssertEqual(zoomed.x, 49_500, accuracy: 0.001)
        XCTAssertEqual(zoomed.y, 49_600, accuracy: 0.001)
    }

    func testDrawingDataRoundTripsCoordinatesNearBoardOrigin() throws {
        let origin = PencilCanvasConfiguration.boardOrigin
        let locations = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 37.5, y: origin.y - 12.25),
            CGPoint(x: origin.x + 120.125, y: origin.y + 240.75)
        ]
        let controlPoints = locations.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 8, height: 8),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        let drawing = PKDrawing(strokes: [
            PKStroke(ink: PKInk(.pen, color: .black), path: path, transform: .identity, mask: nil, randomSeed: 13)
        ])

        let restored = try PKDrawing(data: drawing.dataRepresentation())
        let restoredPath = try XCTUnwrap(restored.strokes.first?.path)
        XCTAssertEqual(restoredPath.count, locations.count)

        // Serialized ink keeps sub-pixel accuracy this far from zero: a 32-bit
        // float quantizes to ~0.002pt at 25,000, far below the 0.5pt physical
        // pixel. This fails loudly if the board extent ever grows enough for
        // that error to become visible.
        for (index, expected) in locations.enumerated() {
            XCTAssertEqual(restoredPath[index].location.x, expected.x, accuracy: 0.01)
            XCTAssertEqual(restoredPath[index].location.y, expected.y, accuracy: 0.01)
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: **compile failure**, not a test failure — `boardExtent`, `boardOrigin`, and `CanvasScroller` do not exist, and `initialContentOffset` takes no argument. That is the correct red state here; a compile error is what "the API does not exist yet" looks like in Swift.

- [ ] **Step 3: Add `CanvasScroller`**

In `MathTutor/CanvasView.swift`, insert this immediately after the closing brace of `PencilCanvasConfiguration` (currently line 64) and before `CanvasViewportMapper`:

```swift
enum CanvasScroller {
    /// The scroll offset that centers `target` in the viewport, clamped to the
    /// board's scrollable range.
    ///
    /// `target` is in unscaled PencilKit drawing coordinates, while
    /// `viewport`, `scaledContentSize`, and the returned offset are in the
    /// scroll view's scaled space — the same convention `CanvasViewportMapper`
    /// inverts. Pass `canvas.contentSize` for `scaledContentSize`; UIScrollView
    /// already folds `zoomScale` into it.
    static func offset(
        centering target: CGRect,
        viewport: CGSize,
        zoomScale: CGFloat,
        scaledContentSize: CGSize
    ) -> CGPoint {
        let scale = max(zoomScale, .leastNonzeroMagnitude)
        let proposed = CGPoint(
            x: target.midX * scale - viewport.width / 2,
            y: target.midY * scale - viewport.height / 2
        )
        // A viewport wider than the board (possible only at minimum zoom on a
        // hypothetical huge display) has no scroll range, hence the max(0,).
        let maximum = CGPoint(
            x: max(0, scaledContentSize.width - viewport.width),
            y: max(0, scaledContentSize.height - viewport.height)
        )
        return CGPoint(
            x: min(max(proposed.x, 0), maximum.x),
            y: min(max(proposed.y, 0), maximum.y)
        )
    }
}
```

- [ ] **Step 4: Rewrite the geometry constants**

In `MathTutor/CanvasView.swift`, replace lines 5-21 (from `enum PencilCanvasConfiguration {` through the closing brace of `initialContentOffset()`, leaving `configure` in place) with:

```swift
enum PencilCanvasConfiguration {
    static let minimumZoomScale: CGFloat = 0.25
    static let maximumZoomScale: CGFloat = 3
    static let defaultZoomScale: CGFloat = 1

    /// The board is one very large fixed square rather than a page: ~18 screens
    /// of pan in every direction from the origin on a 12.9" iPad at 1x zoom.
    ///
    /// Growing the content on demand would be literally unbounded, but
    /// extending up or left means translating every existing stroke — and
    /// assigning `canvas.drawing` does not register with PencilKit's undo
    /// manager, so each shift would desynchronize undo. A fixed extent avoids
    /// that entirely. The magnitude is also deliberate: ink coordinates lose
    /// visible precision as 32-bit floats only in the millions, so 50,000
    /// leaves the far corners ~40x clear.
    static let boardExtent: CGFloat = 50_000

    /// Where a session starts, in drawing coordinates. Centering the viewport
    /// here is what makes panning up and left possible at all.
    static let boardOrigin = CGPoint(x: boardExtent / 2, y: boardExtent / 2)

    static func contentSize(for viewport: CGSize) -> CGSize {
        CGSize(
            width: max(boardExtent, viewport.width),
            height: max(boardExtent, viewport.height)
        )
    }

    static func initialContentOffset(viewport: CGSize) -> CGPoint {
        CanvasScroller.offset(
            centering: CGRect(origin: boardOrigin, size: .zero),
            viewport: viewport,
            zoomScale: defaultZoomScale,
            scaledContentSize: contentSize(for: viewport)
        )
    }
```

- [ ] **Step 5: Update `configure` for the board**

Still in `MathTutor/CanvasView.swift`, inside `configure(_:viewport:preserveViewport:)`, replace the line `canvas.contentInset = contentInset` with:

```swift
        // The board has no reachable edges, so edge padding would only distort
        // the offset math it was meant to soften.
        canvas.contentInset = .zero
        // A scroll indicator whose thumb is 2% of the track reports nothing.
        canvas.showsHorizontalScrollIndicator = false
        canvas.showsVerticalScrollIndicator = false
```

and replace `canvas.contentOffset = initialContentOffset()` in the `else` branch with:

```swift
            canvas.contentOffset = initialContentOffset(viewport: viewport)
```

Leave everything else in `configure` untouched, including the `preserveViewport` branch — rotation and split-view changes must still keep the student where they were.

- [ ] **Step 6: Keep the existing capture tests testing rasterization**

`configuredCanvas()` now starts centered on the board origin, so the four existing `CanvasCapture` tests — which draw at `(120, 250)` and snapshot the viewport — would capture blank paper and fail. Those tests are about ink rasterization, not about where the board starts, so pin their viewport to the coordinates their ink uses.

In `MathTutorTests/MathTutorTests.swift`, replace the helper at lines 760-764:

```swift
    private func configuredCanvas() -> PKCanvasView {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)
        // These tests assert on rasterization, not on where a session starts, so
        // they view the board's top-left corner and place ink there. Tests that
        // care about the centered start position set their own offset.
        canvas.contentOffset = .zero
        return canvas
    }
```

And make the drawing helper placeable — replace the `points` array at lines 768-774 (leave the rest of `makeDrawing` untouched) and update its signature at line 766:

```swift
    private func makeDrawing(color: UIColor, origin: CGPoint = CGPoint(x: 120, y: 250)) -> PKDrawing {
        let ink = PKInk(.pen, color: color)
        let points = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y)
        ]
```

The default reproduces the previous square exactly, so all four existing call sites keep their current behavior.

- [ ] **Step 7: Run the full unit target**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: **TEST SUCCEEDED**, all tests passing — the three new ones plus the pre-existing suite, including `testCanvasCaptureKeepsSelectedInkAfterPanAndZoom` and `testE2EFixtureContainsVectorInkWithUsefulBounds`.

If `testDrawingDataRoundTripsCoordinatesNearBoardOrigin` fails, do **not** loosen its tolerance — stop and report it. It failing means serialized coordinate precision at 25,000 is worse than the spec assumed, which is a design-level finding.

- [ ] **Step 8: Commit**

```bash
git add MathTutor/CanvasView.swift MathTutorTests/MathTutorTests.swift
git commit -m "Give the whiteboard a 50,000pt board centered on the session origin"
```

---

### Task 2: Scroll to the student's ink

Makes the canvas open on existing work — which is also what keeps sessions saved under the old coordinates (strokes near `(84, 410)`) and the `E2ESeedFixture` visible, with no data migration.

**Files:**
- Modify: `MathTutor/CanvasView.swift` — `CanvasCapture` (~line 87), `PencilCanvasView.updateUIView` (~line 208), `Coordinator` (~line 226)
- Test: `MathTutorTests/MathTutorTests.swift` — add two tests

**Interfaces:**
- Consumes: `CanvasScroller.offset(centering:viewport:zoomScale:scaledContentSize:)`, `PencilCanvasConfiguration.boardOrigin` (Task 1)
- Produces, relied on by Task 4: `CanvasCapture.centerOnContent(animated: Bool)`

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/MathTutorTests.swift`, next to the other `CanvasCapture` tests:

```swift
    @MainActor
    func testCenterOnContentBringsDistantInkIntoTheViewport() {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 30_000, y: 41_000))
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let viewportRect = CGRect(origin: .zero, size: canvas.bounds.size)
        let before = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertFalse(before.intersects(canvas.drawing.bounds), "Ink 30,000pt away must start off screen")

        capture.centerOnContent(animated: false)

        let after = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertTrue(
            after.contains(CGPoint(x: canvas.drawing.bounds.midX, y: canvas.drawing.bounds.midY)),
            "Centering must scroll the board to wherever the student's ink lives"
        )
    }

    @MainActor
    func testCenterOnContentReturnsToTheBoardOriginWhenEmpty() {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas
        canvas.contentOffset = CGPoint(x: 40_000, y: 40_000)

        capture.centerOnContent(animated: false)

        XCTAssertEqual(
            canvas.contentOffset.x,
            PencilCanvasConfiguration.boardOrigin.x - canvas.bounds.width / 2,
            accuracy: 0.5
        )
        XCTAssertEqual(
            canvas.contentOffset.y,
            PencilCanvasConfiguration.boardOrigin.y - canvas.bounds.height / 2,
            accuracy: 0.5
        )
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: compile failure — `centerOnContent` does not exist.

- [ ] **Step 3: Implement `centerOnContent`**

In `MathTutor/CanvasView.swift`, add to `CanvasCapture`, directly after `func clear()`:

```swift
    /// Scrolls the board to the student's ink, or back to the session origin
    /// when the board is empty. This is also how sessions saved before the
    /// board became infinite stay usable: their strokes sit near the board's
    /// top-left corner, and scrolling to them beats rewriting stored drawings.
    func centerOnContent(animated: Bool) {
        guard let canvasView else { return }
        let viewport = canvasView.bounds.size
        guard viewport.width > 0, viewport.height > 0 else { return }

        let inkBounds = canvasView.drawing.bounds
        let target = inkBounds.isNull || inkBounds.isEmpty
            ? CGRect(origin: PencilCanvasConfiguration.boardOrigin, size: .zero)
            : inkBounds

        canvasView.setContentOffset(
            CanvasScroller.offset(
                centering: target,
                viewport: viewport,
                zoomScale: canvasView.zoomScale,
                scaledContentSize: canvasView.contentSize
            ),
            animated: animated
        )
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: **TEST SUCCEEDED**.

- [ ] **Step 5: Scroll to ink on the first real layout**

`makeUIView` builds the canvas at `frame: .zero` and restores `initialDrawingData` there, so the drawing exists before any viewport does. Center once, on the first layout pass that has a real size.

In `MathTutor/CanvasView.swift`, add a flag to `Coordinator` next to `var didConfigure = false`:

```swift
        var didCenterOnContent = false
```

Then in `updateUIView`, replace the three lines after the viewport `guard`:

```swift
        PencilCanvasConfiguration.configure(canvas, viewport: viewport, preserveViewport: context.coordinator.didConfigure)
        context.coordinator.lastViewportSize = viewport
        context.coordinator.didConfigure = true
```

with:

```swift
        PencilCanvasConfiguration.configure(canvas, viewport: viewport, preserveViewport: context.coordinator.didConfigure)
        context.coordinator.lastViewportSize = viewport
        context.coordinator.didConfigure = true

        // `configure` can only center the board origin — it never sees the
        // drawing. Restored ink wins over that default, but only on the first
        // real layout: later viewport changes take the preserveViewport path
        // above and must not yank a panned-away student back to their strokes.
        if !context.coordinator.didCenterOnContent {
            capture.centerOnContent(animated: false)
            context.coordinator.didCenterOnContent = true
        }
```

- [ ] **Step 6: Verify on the simulator**

```bash
scripts/run-sim.sh
```

Then, in the booted simulator, relaunch with the seeded fixture and confirm the seeded solution is on screen at launch rather than off in blank space:

```bash
xcrun simctl terminate booted com.nordup.MathTutor && xcrun simctl launch booted com.nordup.MathTutor --ui-test-reset --ui-test-demo-service --e2e-seed-radical-attempt
```

Expected: the six handwritten lines (`√(x + 5) = x − 1` through `x = 4 or x = −1`) are visible on the board without scrolling. Also drag with one finger in all four directions and confirm the board moves each way — up and left included, which is what was impossible before.

- [ ] **Step 7: Run the full unit target and commit**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: **TEST SUCCEEDED**.

```bash
git add MathTutor/CanvasView.swift MathTutorTests/MathTutorTests.swift
git commit -m "Open the board on the student's existing ink"
```

---

### Task 3: Board evaluation captures all ink

On an endless board a student can scroll past a long solution; the viewport snapshot would silently send the tutor a fraction of it.

**Files:**
- Modify: `MathTutor/CanvasView.swift` — `CanvasCapture.snapshotData(region:)` (lines 94-144)
- Modify: `MathTutor/WorkspaceView.swift:535-541` — `evaluateFullCanvas()`
- Test: `MathTutorTests/MathTutorTests.swift` — add two tests

**Interfaces:**
- Consumes: `PencilCanvasConfiguration` / `CanvasScroller` only indirectly (test setup)
- Produces: `CanvasCapture.snapshotAllInkData() -> Data?`; `CanvasCapture.snapshotData(region:) -> Data?` keeps its exact current signature and viewport semantics

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/MathTutorTests.swift`:

```swift
    @MainActor
    func testBoardEvaluationCapturesInkOutsideTheVisibleViewport() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 10_000, y: 12_000))
        let capture = CanvasCapture()
        capture.canvasView = canvas

        // The viewport snapshot renders blank paper: the ink is 10,000pt away.
        let visible = try XCTUnwrap(capture.snapshotData())
        XCTAssertEqual(
            try pixelStats(for: visible).darkPixelCount,
            0,
            "The viewport snapshot cannot see ink that is 10,000pt off screen"
        )

        let allInk = try XCTUnwrap(
            capture.snapshotAllInkData(),
            "Board evaluation must capture ink wherever it lives on the board"
        )
        XCTAssertGreaterThan(try pixelStats(for: allInk).darkPixelCount, 40)
    }

    @MainActor
    func testBoardEvaluationSnapshotIsNilOnAnEmptyBoard() {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        XCTAssertNil(capture.snapshotAllInkData(), "An empty board must not send an evaluation image")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: compile failure — `snapshotAllInkData` does not exist.

- [ ] **Step 3: Extract the renderer**

The rasterization body (black-ink normalization, white opaque background, light trait override, 2,000 px clamp) is unchanged — it just needs a second caller. In `MathTutor/CanvasView.swift`, replace the whole of `snapshotData(region:)` (lines 94-144) with:

```swift
    func snapshotData(region: CGRect? = nil) -> Data? {
        guard let canvasView else { return nil }
        let viewport = CGRect(origin: .zero, size: canvasView.bounds.size)
        let requestedViewport = (region ?? viewport).intersection(viewport)
        guard !requestedViewport.isNull, requestedViewport.width > 0, requestedViewport.height > 0 else {
            return nil
        }
        let requested = CanvasViewportMapper.drawingRect(
            for: requestedViewport,
            canvasBounds: canvasView.bounds,
            zoomScale: canvasView.zoomScale
        )
        return renderPNG(drawingRect: requested)
    }

    /// Every stroke on the board, regardless of where the student has scrolled.
    /// A viewport-bounded capture would silently truncate a long solution that
    /// has been panned off screen, which an infinite board makes easy to do.
    func snapshotAllInkData() -> Data? {
        guard let canvasView else { return nil }
        let inkBounds = canvasView.drawing.bounds
        guard !inkBounds.isNull, inkBounds.width > 0, inkBounds.height > 0 else { return nil }
        return renderPNG(drawingRect: inkBounds.insetBy(dx: -24, dy: -24))
    }

    private func renderPNG(drawingRect requested: CGRect) -> Data? {
        guard let canvasView, requested.width > 0, requested.height > 0 else { return nil }

        // Keep handwriting crisp without sending an unnecessarily huge original-detail
        // image. A white background also avoids ambiguous transparent-PNG rendering.
        let maximumDimension: CGFloat = 2_000
        let scale = min(2, maximumDimension / max(requested.width, requested.height))
        // Evaluation images use a white paper background. Normalize ink colors
        // for this derived image so light PencilKit strokes remain visible instead
        // of disappearing into that background. The live drawing is never mutated.
        let evaluationDrawing = canvasView.drawing.strokes.isEmpty
            ? canvasView.drawing
            : PKDrawing(strokes: canvasView.drawing.strokes.map { stroke in
                PKStroke(
                    ink: PKInk(stroke.ink.inkType, color: .black),
                    path: stroke.path,
                    transform: stroke.transform,
                    mask: stroke.mask,
                    randomSeed: stroke.randomSeed
                )
            })
        let pixelSize = CGSize(width: requested.width * scale, height: requested.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        var image: UIImage?
        // PencilKit resolves some ink colors through the current trait collection
        // while rasterizing. Evaluation always flattens onto white paper, so use
        // an explicit light trait for both PencilKit and UIKit rendering. This is
        // scoped to the derived image and never changes the live canvas/drawing.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            let drawingImage = evaluationDrawing.image(from: requested, scale: scale)
            image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: pixelSize))
                drawingImage.draw(in: CGRect(origin: .zero, size: pixelSize))
            }
        }
        return image?.pngData()
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorTests test
```

Expected: **TEST SUCCEEDED**, including the four pre-existing `CanvasCapture` rasterization tests, which prove the extraction changed no behavior.

- [ ] **Step 5: Point board evaluation at all ink**

In `MathTutor/WorkspaceView.swift`, replace `evaluateFullCanvas()` (lines 535-541):

```swift
    private func evaluateFullCanvas() {
        guard let data = capture.snapshotAllInkData() else { return }
        selectionMode = false
        selectionRect = nil
        store.evaluate(imageData: data, regionDescription: "the whole board")
        panelExpanded = true
    }
```

`evaluateRegion()` is deliberately left alone: a dragged rectangle is a screen-space selection and must stay viewport-based.

- [ ] **Step 6: Verify the E2E flow still evaluates**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -only-testing:MathTutorUITests/MathTutorUITests/testE2ESeedLaunchOpensRadicalWorkspace test
```

Expected: **TEST SUCCEEDED** — the seeded attempt still produces feedback through the *Evaluate board* button.

- [ ] **Step 7: Commit**

```bash
git add MathTutor/CanvasView.swift MathTutor/WorkspaceView.swift MathTutorTests/MathTutorTests.swift
git commit -m "Evaluate every stroke on the board, not just the visible viewport"
```

---

### Task 4: Center-on-work control and docs

The last piece of the feature: on an endless board a student needs a way back to their work.

**Files:**
- Modify: `MathTutor/WorkspaceView.swift:406-469` — `actionBar(compact:)`
- Modify: `MathTutorUITests/MathTutorUITests.swift:70` — one assertion in `testE2ESeedLaunchOpensRadicalWorkspace`
- Modify: `README.md` — lines 57, 62, and the QA checklist

**Interfaces:**
- Consumes: `CanvasCapture.centerOnContent(animated:)` (Task 2)
- Produces: accessibility identifier `center-on-work`

- [ ] **Step 1: Add the button**

In `MathTutor/WorkspaceView.swift`, inside `actionBar(compact:)`, insert as the **first** element of the `HStack`, before the existing *Select region* button:

```swift
            Button {
                capture.centerOnContent(animated: true)
            } label: {
                if compact {
                    Image(systemName: "scope")
                        .frame(width: 40, height: 40)
                } else {
                    Label("Center", systemImage: "scope")
                }
            }
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(.primary)
            .accessibilityIdentifier("center-on-work")
            .accessibilityLabel("Center on my work")
```

- [ ] **Step 2: Assert the control exists in E2E**

In `MathTutorUITests/MathTutorUITests.swift`, in `testE2ESeedLaunchOpensRadicalWorkspace`, add directly after the line `XCTAssertTrue(app.staticTexts["Apple Pencil workspace"].waitForExistence(timeout: 8))` (line 70):

```swift
        XCTAssertTrue(
            app.buttons["center-on-work"].exists,
            "An endless board must offer a way back to the student's ink"
        )
```

Existence only — deliberately no tap. The first synthesized tap after launch is dropped on roughly 10% of runs, and a tap here would buy nothing the unit tests do not already cover.

- [ ] **Step 3: Run both test targets**

```bash
xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' test
```

Expected: **TEST SUCCEEDED** for `MathTutorTests` and `MathTutorUITests`. (`testLiveBoardEvaluationSeesPersistedAttempt` reports as skipped unless `RUN_LIVE_BOARD_E2E=1`; that is expected.)

- [ ] **Step 4: Update the README**

Three edits in `README.md`.

Replace the `PencilCanvasView` architecture bullet (line 57):

```markdown
- `PencilCanvasView`: PencilKit canvas on a 50,000pt board centered at (25,000, 25,000) so writing and panning work in every direction from where a session starts, native `PKToolPicker`, pen/marker/eraser helpers, undo/redo, two-finger undo, three-finger redo, and a Center control that returns to the current ink.
```

In the prototype-limitations paragraph (line 62), replace the sentence `Evaluation is explicit (full canvas or a dragged rectangle) and sends the rendered PencilKit image only when requested.` with:

```markdown
Evaluation is explicit (the whole board or a dragged rectangle) and sends the rendered PencilKit image only when requested; board evaluation renders the bounding box of every stroke, so scrolling away from a long solution does not truncate what the tutor sees.
```

In the Manual QA checklist, add after the Apple Pencil bullet:

```markdown
- Pan the board up, down, left, and right from the start position, write in a far corner, then tap **Center** and confirm it returns to your ink. Reopen the session and confirm it opens on that ink rather than on blank board.
```

- [ ] **Step 5: Manual QA on the simulator**

```bash
scripts/run-sim.sh
```

Walk the new QA checklist bullet, and additionally confirm: pinch out to minimum zoom and back without the board snapping to a corner; rotate the device mid-session and confirm the view stays where it was rather than jumping to the ink; draw a stroke far from the start, scroll it off screen, tap **Evaluate board**, and confirm the tutor's feedback refers to that work.

Report anything that feels sluggish while panning — a fixed 50,000pt content size is expected to be free, but this is the first run at that magnitude.

- [ ] **Step 6: Commit**

```bash
git add MathTutor/WorkspaceView.swift MathTutorUITests/MathTutorUITests.swift README.md
git commit -m "Add a center-on-work control and document the infinite board"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Board geometry (extent, origin, offset, inset, zoom, indicators) | Task 1, Steps 3-5 |
| §2 Landing on ink, ordering, no persistence of viewport | Task 2, Steps 3 and 5 |
| §3 `CanvasScroller` | Task 1, Step 3 |
| §3 `centerOnContent` + toolbar button | Task 2 Step 3, Task 4 Step 1 |
| §4 `snapshotAllInkData`, region unchanged, "the whole board" | Task 3, Steps 3 and 5 |
| §5 Coordinate precision | Task 1, Step 1 (round-trip test) + Step 4 (comment) |
| Testing 1-5 | Task 1 Steps 1/6, Task 2 Step 1, Task 3 Step 1 |
| Testing: UI identifier | Task 4, Step 2 |
| Files: README | Task 4, Step 4 |

No gaps.

**Type consistency:** `boardExtent`, `boardOrigin`, `contentSize(for:)`, `initialContentOffset(viewport:)`, `CanvasScroller.offset(centering:viewport:zoomScale:scaledContentSize:)`, `centerOnContent(animated:)`, `snapshotAllInkData()`, `renderPNG(drawingRect:)`, `didCenterOnContent`, and the identifier `center-on-work` are spelled identically at every definition and use site across tasks.

**Two signature changes that break existing call sites**, both handled in the task that makes them: `initialContentOffset()` → `initialContentOffset(viewport:)` (Task 1, Step 5 updates the only caller) and `makeDrawing(color:)` → `makeDrawing(color:origin:)` with a default that preserves all four existing call sites (Task 1, Step 6).
