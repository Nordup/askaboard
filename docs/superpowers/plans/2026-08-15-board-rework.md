# Board Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native, fast, frameless board drawing (SVG, path, math, images) plus web search, image fetch, and script execution, per `docs/superpowers/specs/2026-08-15-board-rework-design.md`.

**Architecture:** The per-frame overlay repaint becomes one transformed content layer with per-element raster caches and viewport culling. SwiftDraw replaces the WKWebView→PDF pipeline. Three element kinds join the scene model on both sides (`path`, `math_text`, `image`). The server gains hosted `web_search` and code interpreter, plus a `fetch_image` tool that lands blobs the existing `GET /v1/blobs/{key}` endpoint already serves.

**Tech Stack:** Swift 6 / UIKit / Core Animation / PencilKit, SwiftDraw (SPM, zlib), ExtendedSwiftMath (vendored), FastAPI + Pydantic + OpenAI Responses API (openai>=2.8), httpx, Pillow, pytest + respx.

## Global Constraints

- Work on `main`. No branches, no worktrees. Commit and push after each task.
- The user edits files and runs builds mid-session: check for a running `xcodebuild` before building; re-read a file right before editing it.
- NEVER run `xcodebuild test`. Swift verification per task = compile only: `./scripts/build.sh` if present, else `xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'generic/platform=iOS Simulator' build`. The user runs the test suite at stage checkpoints.
- After creating any new Swift file: run `xcodegen generate`. No duplicate basenames in the target.
- Server tests: `cd server && uv run pytest tests/<file> -q`. DB-backed tests need `TEST_DATABASE_URL`; never run two pytest invocations concurrently (shared Neon branch).
- `TOOL_DEFINITIONS` in `server/app/tutor/tools.py` stays a module constant, never per-request (prompt-cache rule).
- Board coordinates: ±25,000 points. Caps: `MAX_SVG_CHARS = 40_000` (spec said 100k; cut to fit `MAX_SCENE_CHARS = 60_000`), `MAX_PATH_CHARS = 20_000`, `MAX_LATEX_CHARS = 2_000`.
- SSE events carry no `event:` name; the JSON `type` field discriminates (`server/app/sse.py`).
- Raster cache byte limit: 128 MB. Zoom buckets: powers of two, exponent clamped to `[-3, 2]` (scale 1/8 … 4).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Stage 1 — Client foundation: raster cache, layer view, culling

Ships the lag fix alone, with the existing element kinds.

### Task 1: Hashable scene model

**Files:**
- Modify: `MathTutor/Domain/BoardScene.swift`
- Test: `MathTutorTests/BoardSceneHashTests.swift` (create)

**Interfaces:**
- Produces: `BoardElement: Hashable` (and all element structs, `BoardStyle`, `BoardPoint`). Task 2 keys raster caches on `element.hashValue`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

final class BoardSceneHashTests: XCTestCase {
    func testEqualElementsHashEqually() {
        let a = BoardElement.line(LineElement(id: "l1", x1: 0, y1: 0, x2: 10, y2: 10))
        let b = BoardElement.line(LineElement(id: "l1", x1: 0, y1: 0, x2: 10, y2: 10))
        XCTAssertEqual(a.hashValue, b.hashValue)
    }

    func testContentChangeChangesEquality() {
        let a = BoardElement.svg(SVGElement(id: "s", x: 0, y: 0, width: 10, height: 10, svg: "<svg/>"))
        let b = BoardElement.svg(SVGElement(id: "s", x: 0, y: 0, width: 10, height: 10, svg: "<svg><g/></svg>"))
        XCTAssertNotEqual(a, b)
    }
}
```

If `LineElement`/`SVGElement` memberwise inits differ, match the real field order in `BoardScene.swift` — do not add new inits.

- [ ] **Step 2: Verify it fails to compile** (`Hashable` missing). Run the compile-only build command from Global Constraints; expect an error naming `hashValue`.
- [ ] **Step 3: Implement** — in `BoardScene.swift`, add `Hashable` to the conformance lists of `BoardStyle`, `BoardPoint`, every element struct, `BoardElement`, and `BoardScene`. No custom `hash(into:)`; synthesized conformance is correct because every stored property is hashable.
- [ ] **Step 4: Run `xcodegen generate` (new test file), then compile-only build. Expect success.**
- [ ] **Step 5: Commit**

```bash
git add MathTutor/Domain/BoardScene.swift MathTutorTests/BoardSceneHashTests.swift MathTutor.xcodeproj
git commit -m "Make the board scene model Hashable for raster cache keys" && git push
```

### Task 2: BoardRasterCache

**Files:**
- Create: `MathTutor/Features/Board/BoardRasterCache.swift`
- Test: `MathTutorTests/BoardRasterCacheTests.swift` (create)

**Interfaces:**
- Produces:
  - `struct RasterKey: Hashable { let content: Int; let bucket: Int }`
  - `@MainActor final class BoardRasterCache` with `init(byteLimit: Int = 128 * 1024 * 1024)`, `func image(for key: RasterKey) -> CGImage?`, `func store(_ image: CGImage, for key: RasterKey)`, `var totalBytes: Int { get }`
  - `enum ZoomBucket { static func bucket(forZoom zoom: CGFloat) -> Int; static func scale(forBucket bucket: Int) -> CGFloat }`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

@MainActor
final class BoardRasterCacheTests: XCTestCase {
    private func makeImage(side: Int) -> CGImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        return renderer.image { $0.fill(CGRect(x: 0, y: 0, width: side, height: side)) }.cgImage!
    }

    func testStoreAndFetch() {
        let cache = BoardRasterCache()
        let key = RasterKey(content: 1, bucket: 0)
        cache.store(makeImage(side: 4), for: key)
        XCTAssertNotNil(cache.image(for: key))
    }

    func testEvictsLeastRecentlyUsedAtByteLimit() {
        let cache = BoardRasterCache(byteLimit: 4 * 64 * 64 * 2)  // room for ~two 64px images
        cache.store(makeImage(side: 64), for: RasterKey(content: 1, bucket: 0))
        cache.store(makeImage(side: 64), for: RasterKey(content: 2, bucket: 0))
        _ = cache.image(for: RasterKey(content: 1, bucket: 0))  // touch 1 so 2 is LRU
        cache.store(makeImage(side: 64), for: RasterKey(content: 3, bucket: 0))
        XCTAssertNil(cache.image(for: RasterKey(content: 2, bucket: 0)))
        XCTAssertNotNil(cache.image(for: RasterKey(content: 1, bucket: 0)))
    }

    func testZoomBucketsClampToPowersOfTwo() {
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 1.0), 0)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 2.0), 1)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 0.05), -3)   // clamped low
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 32.0), 2)    // clamped high
        XCTAssertEqual(ZoomBucket.scale(forBucket: -3), 0.125)
        XCTAssertEqual(ZoomBucket.scale(forBucket: 2), 4)
    }
}
```

- [ ] **Step 2: Compile-only build; expect failure (`BoardRasterCache` unresolved).**
- [ ] **Step 3: Implement**

```swift
import CoreGraphics
import UIKit

struct RasterKey: Hashable {
    let content: Int
    let bucket: Int
}

enum ZoomBucket {
    static func bucket(forZoom zoom: CGFloat) -> Int {
        let exponent = Int(log2(max(zoom, .leastNonzeroMagnitude)).rounded())
        return min(2, max(-3, exponent))
    }

    static func scale(forBucket bucket: Int) -> CGFloat {
        pow(2, CGFloat(bucket))
    }
}

/// LRU bitmap cache for rendered board elements. Byte-capped so a board full
/// of large figures degrades to re-rasterization, never to memory pressure.
@MainActor
final class BoardRasterCache {
    private let byteLimit: Int
    private var images: [RasterKey: CGImage] = [:]
    private var order: [RasterKey] = []  // most recently used last
    private(set) var totalBytes = 0

    init(byteLimit: Int = 128 * 1024 * 1024) {
        self.byteLimit = byteLimit
    }

    func image(for key: RasterKey) -> CGImage? {
        guard let image = images[key] else { return nil }
        touch(key)
        return image
    }

    func store(_ image: CGImage, for key: RasterKey) {
        if let old = images[key] { totalBytes -= cost(of: old) }
        images[key] = image
        totalBytes += cost(of: image)
        touch(key)
        while totalBytes > byteLimit, let victim = order.first, order.count > 1 {
            order.removeFirst()
            if let evicted = images.removeValue(forKey: victim) {
                totalBytes -= cost(of: evicted)
            }
        }
    }

    private func touch(_ key: RasterKey) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private func cost(of image: CGImage) -> Int {
        image.bytesPerRow * image.height
    }
}
```

- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success.**
- [ ] **Step 5: Commit** (`git add` the two new files + project, message `Add the byte-capped LRU raster cache with zoom buckets`, push.)

### Task 3: Single-element draw and bounds in BoardSceneRenderer

**Files:**
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift`
- Test: `MathTutorTests/BoardElementBoundsTests.swift` (create)

**Interfaces:**
- Produces (both currently private, become internal):
  - `BoardSceneRenderer.draw(element: BoardElement, in context: CGContext)` (rename of private `draw(_:in:)`)
  - `BoardSceneRenderer.bounds(of element: BoardElement, boardOrigin: CGPoint) -> CGRect` — includes rotation expansion, wrapping today's private `elementBounds` + `rotatedBounds`.
- Consumes: nothing new. `draw(scene:in:boardOrigin:)` and capture keep working unchanged through these.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

@MainActor
final class BoardElementBoundsTests: XCTestCase {
    func testLineBoundsIncludeStrokeInset() {
        var line = LineElement(id: "l", x1: 0, y1: 0, x2: 100, y2: 0)
        line.style.strokeWidth = 4
        let bounds = BoardSceneRenderer.bounds(of: .line(line), boardOrigin: .zero)
        XCTAssertEqual(bounds.minY, -2, accuracy: 0.01)
        XCTAssertEqual(bounds.height, 4, accuracy: 0.01)
    }

    func testRotatedBoundsCoverTheDiagonal() {
        var rect = RectangleElement(id: "r", x: 0, y: 0, width: 100, height: 10)
        rect.style.rotation = 45
        let bounds = BoardSceneRenderer.bounds(of: .rectangle(rect), boardOrigin: .zero)
        XCTAssertGreaterThan(bounds.width, 70)  // hypot(100,10)/2 * 2 ≈ 100.5, rotated circle bound
    }
}
```

- [ ] **Step 2: Compile-only build; expect failure (`bounds(of:boardOrigin:)` not found).**
- [ ] **Step 3: Implement** — in `BoardSceneRenderer.swift`: rename `private static func draw(_ element:in:)` to `static func draw(element: BoardElement, in context: CGContext)` (update the two internal callers at the scene loop and keep behavior identical). Add:

```swift
static func bounds(of element: BoardElement, boardOrigin: CGPoint) -> CGRect {
    var rect = elementBounds(element, boardOrigin: boardOrigin)
    if element.style.rotation != 0 {
        rect = rotatedBounds(of: rect, degrees: element.style.rotation)
    }
    return rect
}
```

Rewrite `bounds(of scene:boardOrigin:)` to union `bounds(of:boardOrigin:)` per element so the logic lives once.

- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success.**
- [ ] **Step 5: Commit and push** (`Expose per-element draw and bounds from BoardSceneRenderer`).

### Task 4: BoardSceneLayerView with culling

**Files:**
- Create: `MathTutor/Features/Board/BoardSceneLayerView.swift`
- Test: `MathTutorTests/BoardSceneLayerTests.swift` (create)

**Interfaces:**
- Produces:
  - `@MainActor final class BoardSceneLayerView: UIView` with `var scene: BoardScene`, `var boardOrigin: CGPoint`, `func setViewport(contentOffset: CGPoint, zoomScale: CGFloat)`, `func reconcile()`
  - `static func visibleIds(scene: BoardScene, viewport: CGRect, boardOrigin: CGPoint, margin: CGFloat) -> Set<String>` — pure, the culling decision.
- Consumes: `BoardRasterCache`, `ZoomBucket`, `RasterKey` (Task 2); `BoardSceneRenderer.draw(element:in:)`, `.bounds(of:boardOrigin:)` (Task 3).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

@MainActor
final class BoardSceneLayerTests: XCTestCase {
    private func scene(_ elements: [BoardElement]) -> BoardScene {
        var scene = BoardScene.empty
        scene.elements = elements
        return scene
    }

    func testCullingKeepsOnlyViewportIntersectingElements() {
        let inside = BoardElement.circle(CircleElement(id: "in", cx: 100, cy: 100, radius: 10))
        let outside = BoardElement.circle(CircleElement(id: "out", cx: 5_000, cy: 5_000, radius: 10))
        let ids = BoardSceneLayerView.visibleIds(
            scene: scene([inside, outside]),
            viewport: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            boardOrigin: .zero,
            margin: 200
        )
        XCTAssertEqual(ids, ["in"])
    }

    func testMarginKeepsNearOffscreenElements() {
        let near = BoardElement.circle(CircleElement(id: "near", cx: 1_100, cy: 400, radius: 10))
        let ids = BoardSceneLayerView.visibleIds(
            scene: scene([near]),
            viewport: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            boardOrigin: .zero,
            margin: 200
        )
        XCTAssertEqual(ids, ["near"])
    }

    func testReconcileMountsOnlyVisibleLayers() {
        let view = BoardSceneLayerView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 800))
        view.boardOrigin = .zero
        view.scene = scene([
            .circle(CircleElement(id: "in", cx: 100, cy: 100, radius: 10)),
            .circle(CircleElement(id: "out", cx: 9_000, cy: 9_000, radius: 10)),
        ])
        view.setViewport(contentOffset: .zero, zoomScale: 1)
        XCTAssertEqual(view.mountedElementIdsForTesting, ["in"])
    }
}
```

If `BoardScene.elements` is `let`, use whatever initializer `BoardScene` actually has (check the struct at `MathTutor/Domain/BoardScene.swift:11`) rather than mutating.

- [ ] **Step 2: Compile-only build; expect failure.**
- [ ] **Step 3: Implement**

```swift
import UIKit

/// Replaces the repaint-per-frame overlay. One content layer carries the
/// pan/zoom transform; elements are rasterized once per zoom bucket and
/// composited by Core Animation. Pan cost is a transform set, not a redraw.
@MainActor
final class BoardSceneLayerView: UIView {
    var boardOrigin: CGPoint = PencilCanvasConfiguration.boardOrigin
    var scene: BoardScene = .empty {
        didSet {
            guard scene != oldValue else { return }
            reconcile()
        }
    }

    private let contentLayer = CALayer()
    private var elementLayers: [String: CALayer] = [:]
    private let rasterCache = BoardRasterCache()
    private var contentOffset: CGPoint = .zero
    private var zoomScale: CGFloat = 1
    private var currentBucket = 0

    var mountedElementIdsForTesting: Set<String> { Set(elementLayers.keys) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        layer.addSublayer(contentLayer)
        contentLayer.anchorPoint = .zero
        accessibilityIdentifier = "tutor-scene-overlay"
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("code only") }

    /// Called from the scroll delegate on every pan/zoom tick. Only sets a
    /// transform; never triggers drawing.
    func setViewport(contentOffset: CGPoint, zoomScale: CGFloat) {
        self.contentOffset = contentOffset
        self.zoomScale = zoomScale
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        contentLayer.setAffineTransform(
            CGAffineTransform(translationX: -contentOffset.x, y: -contentOffset.y)
                .scaledBy(x: zoomScale, y: zoomScale)
        )
        CATransaction.commit()
        let bucket = ZoomBucket.bucket(forZoom: zoomScale)
        if bucket != currentBucket {
            currentBucket = bucket
            reconcile()
        } else {
            reconcileVisibilityOnly()
        }
    }

    /// Viewport in drawing coordinates, expanded by `margin` board points.
    static func visibleIds(
        scene: BoardScene,
        viewport: CGRect,
        boardOrigin: CGPoint,
        margin: CGFloat
    ) -> Set<String> {
        let expanded = viewport.insetBy(dx: -margin, dy: -margin)
        var ids: Set<String> = []
        for element in scene.elements {
            let bounds = BoardSceneRenderer.bounds(of: element, boardOrigin: boardOrigin)
            if bounds.intersects(expanded) { ids.insert(element.id) }
        }
        return ids
    }

    private var drawingViewport: CGRect {
        CGRect(
            x: contentOffset.x / zoomScale,
            y: contentOffset.y / zoomScale,
            width: bounds.width / zoomScale,
            height: bounds.height / zoomScale
        )
    }

    private func reconcileVisibilityOnly() {
        let visible = Self.visibleIds(
            scene: scene, viewport: drawingViewport, boardOrigin: boardOrigin,
            margin: max(bounds.width, bounds.height) / 2
        )
        guard visible != mountedElementIdsForTesting else { return }
        reconcile()
    }

    func reconcile() {
        let visible = Self.visibleIds(
            scene: scene, viewport: drawingViewport, boardOrigin: boardOrigin,
            margin: max(bounds.width, bounds.height) / 2
        )
        let elementsById = Dictionary(
            scene.elements.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }
        )
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (id, layer) in elementLayers where !visible.contains(id) || elementsById[id] == nil {
            layer.removeFromSuperlayer()
            elementLayers[id] = nil
        }
        for id in visible {
            guard let element = elementsById[id] else { continue }
            let bounds = BoardSceneRenderer.bounds(of: element, boardOrigin: boardOrigin)
            guard bounds.width > 0, bounds.height > 0 else { continue }
            let layer = elementLayers[id] ?? {
                let layer = CALayer()
                layer.anchorPoint = .zero
                contentLayer.addSublayer(layer)
                elementLayers[id] = layer
                return layer
            }()
            layer.frame = bounds
            layer.contents = raster(for: element, bounds: bounds)
        }
        CATransaction.commit()
    }

    private func raster(for element: BoardElement, bounds: CGRect) -> CGImage? {
        let key = RasterKey(content: element.hashValue, bucket: currentBucket)
        if let cached = rasterCache.image(for: key) { return cached }
        let scale = ZoomBucket.scale(forBucket: currentBucket) * UIScreen.main.scale
        let pixelSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        guard pixelSize.width >= 1, pixelSize.height >= 1,
              pixelSize.width * pixelSize.height < 64_000_000 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { context in
            let cg = context.cgContext
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -bounds.minX, y: -bounds.minY)
            cg.translateBy(x: boardOrigin.x, y: boardOrigin.y)
            BoardSceneRenderer.draw(element: element, in: cg)
        }
        guard let cgImage = image.cgImage else { return nil }
        rasterCache.store(cgImage, for: key)
        return cgImage
    }
}
```

Note the translate order in `raster`: element bounds are in drawing coordinates (they already include `boardOrigin`), and `draw(element:in:)` draws in board coordinates, so the context maps board→pixel by `-bounds.origin` then `+boardOrigin`.

- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success.**
- [ ] **Step 5: Commit and push** (`Add the layer-based scene view: raster once, transform per frame`).

### Task 5: Wire the layer view into BoardCanvasView

**Files:**
- Modify: `MathTutor/Features/Board/BoardCanvas.swift:20-60` (scene property, `updateSceneOverlay`), `:383-389` (scroll delegate)
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift` (delete `BoardSceneOverlayView`, lines ~520-599)
- Test: existing `MathTutorTests` must still compile; `MathTutorTests/BoardSceneLayerTests.swift` covers behavior.

**Interfaces:**
- Consumes: `BoardSceneLayerView` (Task 4).
- Produces: `BoardCanvasView.sceneOverlay` becomes `let sceneOverlay = BoardSceneLayerView()`; `updateSceneOverlay()` keeps its name (callers at `layoutSubviews` and the scroll delegate stand).

- [ ] **Step 1: Re-read `BoardCanvas.swift` (user edits mid-session), then modify** — `updateSceneOverlay()` becomes:

```swift
func updateSceneOverlay() {
    if sceneOverlay.superview != self {
        addSubview(sceneOverlay)
    }
    bringSubviewToFront(sceneOverlay)
    sceneOverlay.frame = bounds
    sceneOverlay.setViewport(contentOffset: contentOffset, zoomScale: zoomScale)
}
```

The `boardScene` didSet keeps `BoardSVGCache.shared.prepare(scene:)` (WebKit still renders `svg` until Stage 2) and sets `sceneOverlay.scene = boardScene`. Search the target for other `BoardSceneOverlayView` references (`rg -n "BoardSceneOverlayView" MathTutor`) and migrate each — the accessibility identifier `tutor-scene-overlay` moved with the new view, so UI tests keep passing. The `.boardSVGCacheDidRender` observer moves into `BoardSceneLayerView.init` calling `reconcile()` (add it now; it becomes the generic ready-signal in Stage 2).

- [ ] **Step 2: Delete `BoardSceneOverlayView`** from `BoardSceneRenderer.swift`.
- [ ] **Step 3: Compile-only build; expect success. Fix any missed reference the build names.**
- [ ] **Step 4: Commit and push** (`Swap the repaint overlay for the transformed layer view`).
- [ ] **Step 5: STAGE 1 CHECKPOINT — ask the user to run the test suite and try a heavy board on the iPad.** The lag fix is complete here.

---

## Stage 2 — Native SVG via SwiftDraw

### Task 6: Add SwiftDraw and write the feature probe

**Files:**
- Modify: `project.yml:15-23` (packages) and the `MathTutor` target dependencies (`:30`)
- Test: `MathTutorTests/SwiftDrawProbeTests.swift` (create)

**Interfaces:**
- Produces: the `SwiftDraw` product linked into the app target; probe facts recorded as test assertions.

- [ ] **Step 1: Add the package** to `project.yml`:

```yaml
  swiftDraw:
    url: https://github.com/swhitty/SwiftDraw
    from: 0.18.0
```

and under the `MathTutor` target dependencies: `- package: swiftDraw` / `product: SwiftDraw`. Run `xcodegen generate`. If 0.18.0 is not the current release, pin the latest tag (`git ls-remote --tags https://github.com/swhitty/SwiftDraw | tail -5`).

- [ ] **Step 2: Write the probe test** — this is the task's deliverable; it documents what the renderer supports before we delete WebKit:

```swift
import XCTest
import SwiftDraw
@testable import MathTutor

final class SwiftDrawProbeTests: XCTestCase {
    private func render(_ markup: String) -> UIImage? {
        SVG(data: Data(markup.utf8))?.rasterize()
    }

    func testPathsAndGroupsRender() {
        let markup = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(10,10)"><path d="M0 0 L80 0 L40 60 Z" fill="#204060"/></g></svg>"#
        XCTAssertNotNil(render(markup))
    }

    func testLinearGradientRenders() {
        let markup = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>"#
        XCTAssertNotNil(render(markup))
    }

    func testCSSStyleBlockRenders() {
        let markup = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.a{fill:#123456}</style><rect class="a" width="100" height="100"/></svg>"#
        XCTAssertNotNil(render(markup))
    }

    func testTextRenders() {
        let markup = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><text x="10" y="30" font-size="20">probe</text></svg>"#
        XCTAssertNotNil(render(markup))
    }

    func testViewBoxSizeIsReported() {
        let svg = SVG(data: Data(#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"/>"#.utf8))
        XCTAssertEqual(svg?.size, CGSize(width: 300, height: 120))
    }
}
```

If the `SVG(data:)`/`rasterize()` names differ in the pinned release, adapt the probe to the package's actual public interface (open `Vendor` checkouts or the package's `SVG.swift`) — the probe exists to pin these names down for Tasks 7–8.

- [ ] **Step 3: Compile-only build; expect success. Ask the user to run `SwiftDrawProbeTests` before Task 7 proceeds** — a red probe (especially the CSS test) triggers the spec's fallback: server-side style pre-normalization gets added to the Stage 4 lint task instead of deleting it here.
- [ ] **Step 4: Commit and push** (`Vendor SwiftDraw and pin its feature probe`).

### Task 7: BoardSVGStore — parse, bounds, raster

**Files:**
- Create: `MathTutor/Features/Board/BoardSVGStore.swift`
- Test: `MathTutorTests/BoardSVGStoreTests.swift` (create)

**Interfaces:**
- Produces:
  - `@MainActor final class BoardSVGStore` with `static let shared`, `func prepare(scene: BoardScene)`, `func document(for element: SVGElement) -> ParsedSVG?`, `func render(element: SVGElement) async -> ParsedSVG?` (awaitable readiness for capture/tests)
  - `struct ParsedSVG { let image: CGImage; let size: CGSize }`
  - `Notification.Name.boardSceneArtifactReady` (rename of `.boardSVGCacheDidRender`; the layer view observer follows)
- Consumes: SwiftDraw (Task 6). Parsing and rasterization run off-main via `Task.detached`; publication is main-actor.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

@MainActor
final class BoardSVGStoreTests: XCTestCase {
    private let triangle = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path d="M0 80 L50 0 L100 80 Z" fill="#2266aa"/></svg>"#

    func testRenderProducesImageAndViewBoxSize() async {
        let element = SVGElement(id: "s1", x: 0, y: 0, width: nil, height: nil, svg: triangle)
        let parsed = await BoardSVGStore.shared.render(element: element)
        XCTAssertNotNil(parsed?.image)
        XCTAssertEqual(parsed?.size, CGSize(width: 100, height: 80))
    }

    func testMalformedMarkupFailsClosed() async {
        let element = SVGElement(id: "s2", x: 0, y: 0, width: nil, height: nil, svg: "<svg><unclosed")
        let parsed = await BoardSVGStore.shared.render(element: element)
        XCTAssertNil(parsed)
    }
}
```

This test forces the `SVGElement.width/height: CGFloat?` change — do it in this task (Swift side only): make both optional in `BoardScene.swift`, decode with `decodeIfPresent`, and treat `0` as nil (the server's strict schema sends 0 for "natural" today).

- [ ] **Step 2: Compile-only build; expect failure.**
- [ ] **Step 3: Implement** — mirror the in-flight/completed bookkeeping of today's `BoardSVGCache` (`MathTutor/Features/Board/BoardSVGCache.swift:349-423`) minus WebKit: key = SHA256 of markup; work = `Task.detached { SVG(data:) → rasterize at min(size, 2048-long-side) → cgImage }`; on completion hop to the main actor, store `ParsedSVG`, post `.boardSceneArtifactReady`. Keep the "failure does not poison the key" retry rule from the old cache's comment.
- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success.**
- [ ] **Step 5: Commit and push** (`Add BoardSVGStore: native SwiftDraw parse and raster cache`).

### Task 8: Frameless svg rendering, WebKit deletion

**Files:**
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift` (the `.svg` arms of `draw(element:in:)` and `elementBounds`)
- Modify: `MathTutor/Features/Board/BoardCanvas.swift:29` (`prepare` moves to `BoardSVGStore`)
- Delete: `MathTutor/Features/Board/BoardSVGCache.swift`
- Modify: `MathTutorTests/BoardSVGTests.swift` (rewrite against the store)
- Modify: `server/app/tutor/board_scene.py:300-328` (`SVGElement.width/height` optional), `server/app/tutor/tools.py:363-376` (svg arm schema + description)
- Test: `server/tests/test_board.py`

**Interfaces:**
- Produces: `.svg` draw = fitted when `width/height` present, 1:1 at `(x, y)` when absent; bounds from `ParsedSVG.size`. Server schema: `width`/`height` stay in the strict schema but the description says "0 for natural size; omit scaling" and the model validator maps 0 → `None`.

- [ ] **Step 1: Write the failing server test** in `server/tests/test_board.py`:

```python
def test_svg_without_frame_is_natural_size():
    update, error = parse_board_update(json.dumps({
        "mode": "upsert", "delete_ids": [],
        "elements": [{
            "kind": "svg", "id": "fig", "x": 100, "y": -50,
            "width": 0, "height": 0,
            "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'/>",
            **DEFAULT_STYLE,
        }],
    }))
    assert error is None
    element = update.elements[0]
    assert element.width is None and element.height is None
```

Match `DEFAULT_STYLE`/argument shape to the file's existing helpers (read `server/tests/test_board.py` first).

- [ ] **Step 2: Run `uv run pytest tests/test_board.py -q`; expect the new test to fail.**
- [ ] **Step 3: Implement server side** — `SVGElement` in `board_scene.py`: `width: float | None` / `height: float | None` with a validator mapping `0 → None`; keep `MAX_SVG_CHARS = 40_000`. Update the tool-arm descriptions: user units are board points 1:1; give the document a `viewBox`; the viewBox's top-left corner lands at `(x, y)`; set `width`/`height` to 0 unless fitting into a legacy frame. Run the test; expect pass. Also run `uv run pytest tests/test_tools.py -q` (schema assertions).
- [ ] **Step 4: Implement Swift side** — `.svg` arm of `draw(element:in:)`: fetch `BoardSVGStore.shared.document(for:)`; if `width/height` present draw fitted into that rect (scale-to-fit, matching today's behavior for persisted scenes); else draw at `(x, y)` with `parsed.size`. `elementBounds` `.svg` arm: frame rect when present, else `(x, y, parsed.size)`, else `.zero` while unparsed (the ready notification re-reconciles). Move `prepare(scene:)` call in `BoardCanvas.swift` to `BoardSVGStore.shared`. Delete `BoardSVGCache.swift` entirely (the WebKit renderer, timed completion, offscreen window). Rewrite `MathTutorTests/BoardSVGTests.swift` assertions against `BoardSVGStore.render(element:)`.
- [ ] **Step 5: `xcodegen generate`; compile-only build; expect success. Commit and push** (`Frameless native svg: SwiftDraw replaces the WebKit renderer`). **STAGE 2 CHECKPOINT — user runs both suites; old boards must still render.**

---

## Stage 3 — path and math_text elements

### Task 9: Server schema for path and math_text

**Files:**
- Modify: `server/app/tutor/board_scene.py` (two classes + union at `:330`, caps at `:23-49`)
- Modify: `server/app/tutor/tools.py` (two `_board_element` arms next to `:234-376`)
- Test: `server/tests/test_board.py`, `server/tests/test_tools.py`

**Interfaces:**
- Produces (Pydantic, mirrored to Swift in Tasks 10–11):
  - `PathElement`: `kind: Literal["path"]`, `d: str` (≤ `MAX_PATH_CHARS = 20_000`), `fill_rule: Literal["nonzero", "evenodd"] = "nonzero"`, inherits `_Identified` style.
  - `MathTextElement`: `kind: Literal["math_text"]`, `x: float`, `y: float`, `latex: str` (≤ `MAX_LATEX_CHARS = 2_000`), `font_size: float` (8–256), inherits `_Identified`.

- [ ] **Step 1: Write the failing tests** (in `test_board.py`, same helper style as Task 8):

```python
def test_path_element_parses_with_default_fill_rule():
    update, error = parse_board_update(_update_json(kind="path", id="p1", d="M0 0 C10 0 20 10 30 10", extra={}))
    assert error is None
    assert update.elements[0].fill_rule == "nonzero"

def test_path_rejects_oversized_d():
    _, error = parse_board_update(_update_json(kind="path", id="p1", d="M0 0 " + "L1 1 " * 4000, extra={}))
    assert error is not None

def test_math_text_parses():
    update, error = parse_board_update(_update_json(kind="math_text", id="m1", extra={
        "x": 10, "y": 20, "latex": r"\\frac{a}{b}", "font_size": 24}))
    assert error is None
```

And in `test_tools.py`, extend the union-arm kind-set assertion (`test_tools.py:69`) to include `"path"` and `"math_text"`.

- [ ] **Step 2: Run both test files; expect the new tests to fail.**
- [ ] **Step 3: Implement** — add the constants, the two model classes, the union entries, and the two schema arms (copy an existing arm's shape; `strict: True` requires every field listed with exact types). Descriptions: `d` is absolute board points; `math_text` is the only correct way to put notation on the board.
- [ ] **Step 4: Run both test files; expect pass. Commit and push** (`Server scene model: path and math_text elements`).

### Task 10: Swift path element

**Files:**
- Modify: `MathTutor/Domain/BoardScene.swift` (struct + `BoardElementKind.path` + enum case + decode switch)
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift` (draw + bounds arms)
- Test: `MathTutorTests/BoardPathElementTests.swift` (create)

**Interfaces:**
- Produces: `struct PathElement: Codable, Hashable, Sendable { var id: String; var kind: BoardElementKind = .path; var d: String; var fillRule: PathFillRule = .nonzero; var style: BoardStyle }` with `CodingKeys` mapping `fill_rule`; `BoardElement.path(PathElement)`.
- Consumes: `SVGPath.path(from:)` (`MathTutor/DesignSystem/SVGPath.swift:22`) → `Path` → `.cgPath`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

final class BoardPathElementTests: XCTestCase {
    func testDecodesFromServerJSON() throws {
        let json = #"{"id":"p1","kind":"path","d":"M0 0 L100 0 L100 100 Z","fill_rule":"evenodd","style":{}}"#
        // Decode through BoardElement so the discriminator switch is what's tested.
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))
        guard case .path(let path) = element else { return XCTFail("wrong case") }
        XCTAssertEqual(path.fillRule, .evenodd)
    }

    @MainActor
    func testBoundsComeFromThePathBoundingBox() {
        let element = BoardElement.path(PathElement(id: "p", d: "M10 20 L110 20 L110 220 Z"))
        let bounds = BoardSceneRenderer.bounds(of: element, boardOrigin: .zero)
        XCTAssertEqual(bounds.minX, 10, accuracy: 1)
        XCTAssertEqual(bounds.maxY, 220, accuracy: 1)
    }
}
```

Match the decode entry point to how `BoardElement.init(from:)` actually discriminates (see the `kind` switch near `BoardScene.swift:335`); if elements only decode inside `BoardSceneUpdate`, wrap accordingly.

- [ ] **Step 2: Compile-only build; expect failure.**
- [ ] **Step 3: Implement** — model per the Interfaces block; renderer arms:

```swift
case .path(let value):
    let cgPath = SVGPath.path(from: value.d).cgPath
    withRotation(style.rotation, around: cgPath.boundingBoxOfPath, in: context) {
        if value.style.fill != "transparent" {
            context.addPath(cgPath)
            context.fillPath(using: value.fillRule == .evenodd ? .evenOdd : .winding)
        }
        context.addPath(cgPath)
        context.strokePath()
    }
```

Bounds arm: `SVGPath.path(from: value.d).cgPath.boundingBoxOfPath` offset by `boardOrigin`, inset by `-strokeWidth/2`.

- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success. Commit and push** (`Swift path element: native freeform curves in board points`).

### Task 11: Swift math_text element

**Files:**
- Modify: `project.yml` (add `extendedSwiftMath: path: Vendor/ExtendedSwiftMath` package; target dependency `product: ExtendedSwiftMath`)
- Modify: `MathTutor/Domain/BoardScene.swift` (struct + kind `mathText = "math_text"` + case + decode)
- Create: `MathTutor/Features/Board/BoardMathStore.swift`
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift`, `MathTutor/Features/Board/BoardCanvas.swift` (prepare call includes math)
- Test: `MathTutorTests/BoardMathElementTests.swift` (create)

**Interfaces:**
- Produces:
  - `struct MathTextElement: Codable, Hashable, Sendable { var id: String; var kind: BoardElementKind = .mathText; var x: CGFloat; var y: CGFloat; var latex: String; var fontSize: CGFloat; var style: BoardStyle }` (`font_size` coding key)
  - `@MainActor final class BoardMathStore` with `static let shared`, `func prepare(scene: BoardScene)`, `func artifact(for element: MathTextElement) -> MathArtifact?`, `func render(element: MathTextElement) async -> MathArtifact?`; `struct MathArtifact { let image: CGImage; let size: CGSize }`. Posts `.boardSceneArtifactReady` when an entry lands.
- Consumes: `MTMathImage(latex:fontSize:textColor:labelMode:textAlignment:)` + `asImage()` from ExtendedSwiftMath (`Vendor/ExtendedSwiftMath/Sources/ExtendedSwiftMath/MathRender/MTMathImage.swift:39,58`). Raster at `fontSize × 2` for crispness; the layer view scales.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MathTutor

@MainActor
final class BoardMathElementTests: XCTestCase {
    func testRenderTypesetsAFraction() async {
        let element = MathTextElement(id: "m", x: 0, y: 0, latex: #"\frac{1}{2}"#, fontSize: 24)
        let artifact = await BoardMathStore.shared.render(element: element)
        XCTAssertNotNil(artifact?.image)
        XCTAssertGreaterThan(artifact?.size.height ?? 0, 24)  // a fraction is taller than its font size
    }

    func testMalformedLatexFailsClosed() async {
        let element = MathTextElement(id: "m2", x: 0, y: 0, latex: #"\frac{1}"#, fontSize: 24)
        let artifact = await BoardMathStore.shared.render(element: element)
        XCTAssertNil(artifact)
    }
}
```

- [ ] **Step 2: Compile-only build; expect failure.**
- [ ] **Step 3: Implement** — store mirrors `BoardSVGStore` bookkeeping; render body: `MTMathImage(latex:fontSize:textColor: UIColor(hex: style.stroke) ?? .black, labelMode: .display, textAlignment: .left)`, `asImage()`; nil error and non-nil image required, else fail closed. Renderer draw arm: draw artifact image in `CGRect(origin: (x, y), size: artifact.size / 2)` (the ×2 raster). Bounds arm: `(x, y, artifact.size / 2)` or `.zero` until ready. `UIColor(hex:)` is `private` in `BoardSceneRenderer.swift` — lift it to an internal `UIColor+BoardHex.swift` next to it rather than duplicating.
- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success. Commit and push** (`Swift math_text element typeset by ExtendedSwiftMath`). **STAGE 3 CHECKPOINT — user runs suites and draws a math-heavy exercise on device.**

---

## Stage 4 — image element and fetch_image

### Task 12: Server image element + svg lint warnings

**Files:**
- Modify: `server/app/tutor/board_scene.py` (ImageElement + union; `lint_svg(markup: str) -> list[str]` helper)
- Modify: `server/app/tutor/tools.py` (image arm)
- Modify: `server/app/tutor/loop.py:333` region (`_answer` update_board arm appends lint warnings to the ack)
- Test: `server/tests/test_board.py`, `server/tests/test_loop.py`

**Interfaces:**
- Produces: `ImageElement`: `kind: Literal["image"]`, `x, y: float`, `width, height: float` (> 0, ≤ 50_000), `blob_id: str` matching `^sha256:[0-9a-f]{64}$` (the existing blob-key shape, `server/app/api/sessions.py:36`); `lint_svg` returning human-readable warnings for `<filter`, `<animate`, `<mask`, `<foreignObject`, `<script`, `href="http`, `xlink:href="http`.
- Existence of the blob is NOT validated at parse time (parse is DB-free); a bad id renders the client placeholder. Spec deviation, recorded here.

- [ ] **Step 1: Write failing tests** — `test_board.py`: image element parses; bad `blob_id` shape rejected; `lint_svg` flags `<filter>` and passes a clean document. `test_loop.py`: an `update_board` call whose svg markup contains `<animate>` gets an ack containing `unsupported` (follow the `_answer` test style around `tests/test_loop.py`'s board cases).
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Ack composition: `UPDATE_BOARD_ACK` + `" Warnings: " + "; ".join(warnings)` only when warnings exist.
- [ ] **Step 4: Run `tests/test_board.py`, `tests/test_loop.py`, `tests/test_tools.py`; expect pass. Commit and push** (`Server image element and svg lint warnings in the update_board ack`).

### Task 13: fetch_image tool

**Files:**
- Create: `server/app/tutor/fetch_image.py`
- Modify: `server/app/tutor/tools.py` (FETCH_IMAGE_TOOL def + registry), `server/app/tutor/loop.py` (`ToolAnswer` + `_answer` + run loop + injected fetcher), `server/app/api/turn.py` (construct fetcher with the recorder), `server/app/tutor/events.py` (`TOOL_PHASES["fetch_image"] = "searching"`, `TOOL_STEP_LABELS["fetch_image"] = "Fetching image"`)
- Test: `server/tests/test_fetch_image.py` (create), `server/tests/test_loop.py`

**Interfaces:**
- Produces:
  - Tool def: strict schema `{url: string}`; description: fetch one image the learner or a search result pointed at; result carries `blob_id` for an `image` board element; the image itself is attached for the model to see.
  - `async def fetch_image(url: str, *, client: httpx.AsyncClient | None = None) -> FetchedBytes` in `fetch_image.py` where `@dataclass(frozen=True) class FetchedBytes { data: bytes; content_type: str; width: int; height: int }`; raises `ImageFetchError(reason: str)`.
  - Loop: `ImageFetcher = Callable[[str], Awaitable[str]]` (returns the JSON output string), injected like `BoardFetcher` (`loop.py:230`); `_answer` routes `"fetch_image"` to a new `ToolAnswer(fetch=url)` variant; the run loop awaits it with a 15 s `asyncio.timeout`, appends the JSON as `function_call_output`, and appends the image as an attachment item via `_rendered_items(call_id, image, detail="high")` (`loop.py:376`) so the model sees what it fetched.
- Guards (all in `fetch_image.py`): scheme must be `https`; hostname resolves via `anyio.getaddrinfo` and every address passes `ipaddress.ip_address(addr).is_global`; `follow_redirects=False` (a redirect is an error); streamed read caps at `MAX_IMAGE_BYTES = 10 * 1024 * 1024`; `Content-Type` in `{image/png, image/jpeg, image/webp, image/gif}`; dimensions via `PIL.Image.open` (Pillow is already a server dependency — verify with `rg pillow server/pyproject.toml`, add if absent); total timeout `10.0`.

- [ ] **Step 1: Write failing tests** in `test_fetch_image.py` using `respx` for the outbound URL: happy path returns bytes+type+dimensions; `http://` rejected; a URL resolving to `127.0.0.1`/`10.0.0.0/8` rejected (monkeypatch the resolver); redirect rejected; 11 MB body rejected; `text/html` rejected. In `test_loop.py`: a `fetch_image` tool call round-trips — output JSON contains `blob_id`, and the next-round outbox contains an `input_image` attachment (mirror the `view_board` test shape).
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** In `turn.py`, build the fetcher closure: call `fetch_image`, then `recorder.record_attachment(kind="fetched_image", data=..., content_type=..., turn_id=...)` (`recorder.py:326`), then return `json.dumps({"blob_id": ref.key, "width": w, "height": h})`. On `ImageFetchError`, return `json.dumps({"error": reason})` — the model can retry with a different URL. The attachment row is what lets `GET /v1/blobs/{key}` (`sessions.py:381`) recover the content type — no new endpoint.
- [ ] **Step 4: Run `tests/test_fetch_image.py`, `tests/test_loop.py`, `tests/test_events.py`; expect pass. Commit and push** (`fetch_image tool: guarded download into the blob store`).

### Task 14: Swift image element

**Files:**
- Modify: `MathTutor/Domain/BoardScene.swift` (struct + kind + case + decode)
- Create: `MathTutor/Features/Board/BoardImageStore.swift`
- Modify: `MathTutor/Features/Board/BoardSceneRenderer.swift`, `BoardCanvas.swift` (prepare)
- Test: `MathTutorTests/BoardImageElementTests.swift` (create)

**Interfaces:**
- Produces: `struct ImageElement: Codable, Hashable, Sendable { var id: String; var kind: BoardElementKind = .image; var x, y, width, height: CGFloat; var blobId: String; var style: BoardStyle }` (`blob_id` key); `@MainActor final class BoardImageStore` with `static let shared`, `prepare(scene:)`, `artifact(for:) -> CGImage?`, `render(element:) async -> CGImage?`, posting `.boardSceneArtifactReady`.
- Consumes: the app's existing backend client for `GET /v1/blobs/{key}` — find it with `rg -n "v1/blobs|Authorization" MathTutor/Services` and reuse its base-URL + bearer plumbing; do not hand-roll a second client. Disk cache: `FileManager` caches directory, filename = the hex digest, checked before network.
- Renderer: draw the bitmap into the frame rect; while loading, draw a `secondarySystemFill` rounded placeholder so layout is visible. Bounds arm: the frame rect.

- [ ] **Step 1: Write the failing test** — decode-from-JSON (`blob_id` mapping) and a store test that injects a stub loader (`BoardImageStore.loaderForTesting: ((String) async -> Data?)?`) returning a 1×1 PNG, asserting `render` yields a `CGImage` and the disk cache serves the second call without the loader.
- [ ] **Step 2: Compile-only build; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `xcodegen generate`; compile-only build; expect success. Commit and push** (`Swift image element with blob download and disk cache`). **STAGE 4 CHECKPOINT — user runs suites; fetch an image end-to-end on device.**

---

## Stage 5 — web_search and code interpreter

### Task 15: web_search

**Files:**
- Modify: `server/app/tutor/tools.py:768-776` (append at the marked hosted-tools seam)
- Test: `server/tests/test_tools.py`

- [ ] **Step 1: Failing test** — registry contains `{"type": "web_search"}` after the function tools; registry order test (`test_tools.py:13`) updated.
- [ ] **Step 2: Implement** — one literal dict appended to `TOOL_DEFINITIONS`. The events translator already maps `response.web_search_call.*` to the searching phase (`events.py:402`); confirm `tests/test_events.py:242`'s sibling web-search test exists, add one if only file_search is covered.
- [ ] **Step 3: Run `tests/test_tools.py`, `tests/test_events.py`; expect pass. Commit and push** (`Enable hosted web_search`).

### Task 16: Code interpreter with file relay

**Files:**
- Modify: `server/app/tutor/tools.py` (append `{"type": "code_interpreter", "container": {"type": "auto"}}`)
- Modify: `server/app/tutor/events.py` (`PhaseName` gains `"computing"`; prefix match for `response.code_interpreter_call.*`; step label)
- Modify: `server/app/tutor/loop.py` (post-round citation scan + relay + attachment note)
- Modify: `server/app/api/turn.py` (relay closure with recorder + OpenAI client)
- Test: `server/tests/test_events.py`, `server/tests/test_loop.py`

**Interfaces:**
- Produces, in `loop.py`:
  - `FileRelay = Callable[[str, str, str], Awaitable[str]]` — `(container_id, file_id, filename) -> blob_id`, injected like `BoardFetcher`.
  - After each round, `_container_citations(response) -> list[tuple[str, str, str]]` walks `response.output` message content for annotations with `type == "container_file_citation"` (fields `container_id`, `file_id`, `filename`). For each, the relay downloads via the OpenAI client (`client.containers.files.content.retrieve(file_id, container_id=container_id)` in openai>=2.8 — **first step of this task: verify the exact method with `uv run python -c "from openai import AsyncOpenAI; c = AsyncOpenAI(api_key='x'); print(type(c.containers.files.content))"` and read its `retrieve` signature**), records it (`kind="script_output"`), and a follow-up user item is appended to the next round's outbox: `input_text` listing `filename → blob_id` pairs plus `input_image` parts for image files, so the model can place them with `image` elements. Rounds still respect `MAX_TOOL_ROUNDS = 5`; citations in the final round are relayed and surfaced in the ack text instead.
- [ ] **Step 1: Verify the containers API surface** (command above; adjust the relay call to what the installed SDK exposes).
- [ ] **Step 2: Failing tests** — `test_events.py`: a `response.code_interpreter_call.interpreting` event emits a `computing` status (mirror `test_file_search_emits_searching_status` at `:242`). `test_loop.py`: an SSE fixture whose final response carries a `container_file_citation` produces one relay call and a next-round outbox containing the filename and an `input_image` (respx the containers content URL; extend `tests/fixtures/sse.py` with a `CODE_INTERPRETER_TURN` tuple).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `tests/test_events.py`, `tests/test_loop.py`; expect pass. Commit and push** (`Code interpreter: hosted tool with output-file relay to blobs`).

---

## Stage 6 — Prompt flip

### Task 17: Rewrite the drawing guidance

**Files:**
- Modify: `server/app/tutor/tools.py:184-208` (`UPDATE_BOARD_TOOL` description)
- Modify: `server/app/tutor/prompt.py` (TOOLS list `:94-127`, RESEARCH `:74-78`)
- Test: `server/tests/test_tools.py` (description assertions), eval by hand

- [ ] **Step 1: Rewrite `update_board`'s description**: primitives for simple geometry and annotations; `path` for curves and freeform shapes; `math_text` for ALL notation (never plain `text`, never SVG `<text>`, never simulated with primitives); `svg` encouraged for any multi-part figure, placed 1:1 in board points via viewBox with `width`/`height` 0; supported subset named (paths, shapes, groups, transforms, gradients, defs/use, text) and the unsupported set named (filters, animation, masks, external references); `image` for fetched photos and script-generated charts. Keep the untouched rules verbatim: learner-ink protection, `recommended_tutor_rect`, ids, view_board-before-grading.
- [ ] **Step 2: Update `prompt.py`** — TOOLS section gains one-liners for `fetch_image`, `web_search`, and script execution; RESEARCH says: for data-bearing charts, compute with a script and place the produced image; for diagrams, draw natively.
- [ ] **Step 3: Add light assertions** in `test_tools.py` (description mentions `math_text`, does not mention the deleted 2-second constraint), run `uv run pytest tests -q` for the whole server suite once.
- [ ] **Step 4: Commit and push** (`Prompt flip: native drawing guidance for the reworked board`). **FINAL CHECKPOINT — user runs both suites and a real tutoring session on device: transcription, a math exercise, a fetched image, a computed chart.**

---

## Self-review notes (kept for the implementer)

- Spec coverage: every spec section maps to a task — render pipeline (1–5), native svg (6–8), path/math (9–11), image+fetch (12–14), search/scripts (15–16), prompt (17). The spec's "blob endpoint" task dissolved: `GET /v1/blobs/{key}` exists (`sessions.py:381`); Task 13 reuses it via the attachments table.
- Spec deviations, both recorded inline: `MAX_SVG_CHARS` stays 40,000 (scene cap is 60,000); `blob_id` existence is shape-checked, not DB-checked, at parse time.
- Capture parity: `renderPNG` (`BoardCapture.swift:562`) draws through `BoardSceneRenderer.draw`, which reads the same stores the layer view reads, so capture output tracks the overlay for free once each store lands.
