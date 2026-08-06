# Infinite Whiteboard — Design

**Date:** 2026-08-06
**Status:** Approved, ready for implementation planning

## Problem

The whiteboard is a bounded page, not a board. `PencilCanvasConfiguration`
fixes the content size at 2,400 × 1,600 pt and starts the viewport at the
content's top-left corner (`initialContentOffset()` returns `(-64, -96)`, the
negated content inset). A student can therefore pan roughly one and a half
screens right and down, and cannot pan up or left at all. Running out of room
mid-solution forces erasing or zooming out.

The board should let a student write and pan in **any** direction from where
they start.

## Approach

Give `PKCanvasView` a very large fixed content size and start the viewport at
its center, rather than growing the content on demand.

The rejected alternative was true unbounded growth: observe scrolling, extend
`contentSize` when approaching an edge, and — when extending up or left —
translate every existing stroke and compensate `contentOffset` in the same
frame. That is literally infinite but carries two real costs. Assigning
`canvas.drawing` directly does not register with PencilKit's undo manager, so
each shift desynchronizes the undo stack (undoing a pre-shift stroke restores
pre-shift coordinates). And each shift rebuilds the whole drawing, which
hitches on large boards.

A 50,000 pt extent is ~18 screens of pan in every direction from the origin on
a 12.9" iPad at 1× zoom. Unreachable in a tutoring session, at a fraction of
the complexity and none of the undo risk.

## Design

### 1. Board geometry — `PencilCanvasConfiguration`

| Constant | Before | After |
|---|---|---|
| Content size | `2400 × 1600` (floored to viewport) | `50_000 × 50_000` (floored to viewport) |
| Board origin | implicit `(0, 0)`, top-left | `(25_000, 25_000)`, center |
| Initial offset | `(-64, -96)` — content corner | centers the origin in the viewport |
| Content inset | `96 / 64 / 224 / 64` | `.zero` |
| Minimum zoom | `0.75` | `0.25` |
| Maximum zoom | `3` | `3` (unchanged) |

`initialContentOffset()` gains a `viewport: CGSize` parameter and returns the
offset that centers the board origin. It is implemented by delegating to
`CanvasScroller` (§3) rather than duplicating the centering math.

The content inset existed to keep ink clear of the top exercise card and the
bottom tool picker at the page edges. With no reachable edges it only distorts
the offset math, so it is removed. Scroll indicators are disabled — a
2%-length thumb reports nothing useful.

`configure(_:viewport:preserveViewport:)` keeps its existing contract: the
`preserveViewport` path still restores the prior zoom and offset, so viewport
changes (rotation, split view) do not teleport the student.

### 2. Landing on ink, not on empty space

New strokes are stored at absolute coordinates near 25,000. Sessions saved
before this change hold strokes near `(84, 410)`, and `E2ESeedFixture` draws
there too. Both would otherwise open onto blank space.

Instead of migrating stored drawings — which needs a schema flag and rewrites
data one way — the first layout pass after the viewport is known scrolls to
content:

- Ink present → center `canvas.drawing.bounds` in the viewport.
- Empty board → center the board origin.

Legacy sessions, new sessions, and the seeded fixture all land on their
content, and nothing on disk changes.

Ordering: `configure` runs first and centers the board origin (it cannot see
the drawing); the scroll-to-ink pass then overrides that offset when ink
exists. It runs once, in the coordinator's first `updateUIView` where
`bounds.size != .zero`, alongside the existing `didConfigure` bookkeeping, so
later viewport changes take the `preserveViewport` path instead.

Viewport position is deliberately not persisted across launches; scroll-to-ink
is a better guarantee than restoring a possibly-empty saved offset.

### 3. `CanvasScroller` and "Center on work"

Extract the offset math into a pure helper so it is testable without a live
view:

```swift
enum CanvasScroller {
    static func offset(
        centering target: CGRect,   // drawing-space rect, or the origin point
        viewport: CGSize,
        zoomScale: CGFloat,
        contentSize: CGSize
    ) -> CGPoint
}
```

It centers `target` (scaled by `zoomScale`) in `viewport` and clamps the result
to the scrollable range `0...(contentSize * zoomScale - viewport)` per axis,
guarding the case where scaled content is smaller than the viewport.

`CanvasCapture.centerOnContent(animated:)` applies it to the live canvas and
backs both §2 (on load, not animated) and the new toolbar button (animated).

The button sits next to *Select region* in `actionBar(compact:)`, in both the
regular and compact layouts, styled `.bordered` to match its neighbor:

- Regular: `Label("Center", systemImage: "scope")`
- Compact: `Image(systemName: "scope")` at 40 × 40
- `accessibilityIdentifier("center-on-work")`, label "Center on my work"

### 4. Evaluation captures all ink

`CanvasCapture.snapshotData(region:)` intersects with the canvas bounds, so it
only ever renders what is on screen. Rectangle selection should keep that —
the selection is a screen-space drag. Full-board evaluation should not: on an
endless board a student can scroll past a long solution and silently send the
tutor a fraction of it.

Add a sibling:

```swift
func snapshotAllInkData() -> Data?
```

It renders `canvas.drawing.bounds` padded by 24 pt, ignoring the viewport, and
reuses the existing pipeline unchanged — black-ink normalization, white opaque
background, light trait override, and the 2,000 px maximum-dimension clamp
that keeps a wide board from producing an enormous PNG. An empty drawing has a
null `bounds`, so it returns `nil` and the button no-ops exactly as today.

`WorkspaceView.evaluateFullCanvas()` calls it, and its `regionDescription`
becomes `"the whole board"` to match the *Evaluate board* button.

### 5. Coordinate precision

At 25,000 the gap between neighboring 32-bit floats is `2^(14-23)` ≈ 0.002 pt
— about 0.4 µm, roughly 1/256 of a physical pixel on a 2× iPad, and ~1/85 of a
pixel even at the 3× maximum zoom. Invisible.

This matters only because the error scales with magnitude: at a 10⁷ pt extent,
coordinates in the millions quantize at 0.5 pt, a full pixel of stair-stepping
on every stroke. Visible degradation begins around coordinates of 2 million,
so 50,000 keeps the whole board ~40× clear at its far corners.

`PKStrokePoint.location` is a `CGPoint` (`Double` in memory), so this concerns
only `PKDrawing.dataRepresentation()`, whose binary layout is private and
assumed — not confirmed — to store control points as 32-bit floats. The test
below converts the assumption into a checked fact.

## Testing

Unit tests (`MathTutorTests`):

1. Update `testPencilCanvasConfigurationHasStableContentAndZoomBounds` for the
   new extent, origin, viewport-dependent initial offset, and zoom bounds.
2. `CanvasScroller` centering: ink centered in the viewport; clamped when the
   target sits near a board edge; empty board resolves to the origin.
3. `snapshotAllInkData()` returns ink drawn ~10,000 pt outside the canvas
   bounds — the exact regression the viewport-only path fails.
4. `snapshotData(region:)` still honors the viewport, so rectangle selection is
   unchanged (the existing pan/zoom capture tests cover this; keep them green).
5. Round-trip a `PKDrawing` with control points near 25,000 through
   `dataRepresentation()` / `init(data:)` and assert locations match within a
   tolerance well under a pixel. Fails loudly if a future extent change pushes
   coordinates into the range where precision matters.

UI test (`MathTutorUITests`): assert `center-on-work` exists on the workspace.
Existence only — no synthesized tap, given the known lossy-first-tap behavior
after launch.

## Files

- `MathTutor/CanvasView.swift` — geometry constants, `CanvasScroller`,
  `centerOnContent`, `snapshotAllInkData`, scroll-to-ink on first layout
- `MathTutor/WorkspaceView.swift` — toolbar button, `evaluateFullCanvas`
- `MathTutorTests/MathTutorTests.swift` — tests above
- `MathTutorUITests/MathTutorUITests.swift` — identifier assertion
- `README.md` — canvas description on line 57 and the evaluation note on line 62

## Out of scope

Persisting pan/zoom across launches, a minimap or board overview, multi-page
boards, and unbounded on-demand growth.
