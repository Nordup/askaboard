# Resizable Tutor Panel — Design

**Date:** 2026-08-07
**Status:** Approved, ready for implementation planning

## Problem

`--container-panel` is 337 and the panel is, in board 02's words, *"the only
fixed-width surface in the product."* That was a defensible simplification when
the product was one device at one size. It is no longer one: `ScreenLayout`
derives every lane from a measured window, the app runs on every iPad from a
1024pt 6th generation upward and in Split View, and the one lane that never
gives is the one carrying the conversation the student is actually reading.

The student has no way to say "I want more tutor" or "I want more board" short
of the two buttons in `PanelControls`, which are all-or-nothing — dock it away
entirely, or take the whole screen. There is nothing in between, and the whole
screen is the state that hides the board.

Three things follow from that:

- A student working through a long explanation cannot widen the panel to read
  it without losing sight of their own work.
- A student sketching cannot narrow the panel to get board width without
  losing the conversation to the dock.
- On the narrower iPads the docked layout is a fixed 337 against whatever the
  board is left with, and the ratio is the device's choice rather than the
  student's.

What this is **not** is a request for a general window manager. The design has
three tutor states and they stay three; this adds one continuous axis to the
docked one.

## Approach

A drag handle in the gutter that already exists between the board and the
panel, driving a panel width that lives on `UIState` and flows into
`ScreenLayout` — which already derives `panelX`, `boardWidthDocked` and
`dockedMinimumWidth` from the panel's width and therefore needs no new
arithmetic, only a variable where a constant was.

The resize machinery is split so that **all of the difficulty is in a pure
value type with no SwiftUI in it**, and the view is a thin gesture host. Every
edge case below is a unit test against a function, not a UI test against a
gesture.

### What the design system already permits

[`ChatScale`](../../../MathTutor/DesignSystem/Components/Chat/ChatScale.swift)
settles the question that would otherwise sink this: *"The scale is not a
width. It picks the treatment — type, chip grid, icon sizes, paddings — and
every component on this surface takes the column it is laid out in as a
separate parameter."*

So a wider panel is already a supported input. The type does not grow, the
chips do not go 2-up, the composer does not restyle; the content column simply
gets wider, which is what `TutorPanelMetrics.contentWidth(for:)` was written
to absorb. The same passage names the rule this must not break: **the scale
must not flip to `.fullScreen` because the panel got wide.** `TutorPanel`
passes `.panel` at every width.

### Why the panel only widens

337 is a hard floor. The panel is never drawn narrower than the width it was
designed at; dragging inward pins it there, rubber-bands the handle, and past
a threshold collapses to the dock the design already draws.

The alternative — a continuous shrink to ~250 before collapsing — feels
smoother for about a second and then puts every chat component into width
territory nothing was drawn against. Board 05 is explicit that the panel and
full-screen treatments are *"two variants, not one responsive view"*; there is
no third variant, and inventing one is the change that would need boards.

## Constraints

Every bound is an existing rule or an existing token. Nothing here introduces
a magic number.

| Bound | Value | Where it comes from |
|---|---|---|
| Minimum | `DS.Container.panel` (337) | The design's one panel width, used as a floor rather than a constant |
| Maximum | `boardWidthDocked` | `ScreenLayout.minimumBoardWidth` already says the board must never be narrower than the panel — *"the board is the product and the tutor is the commentary."* Applied live rather than as a static floor, that is `panel ≤ board`. |
| Collapse threshold | `0.6 × minimum` (202) | The one proportion introduced, and it is a gesture threshold rather than a layout value — it never lands on screen. |
| Rubber-band coefficient | `0.55` | Apple's `UIScrollView` constant. |

The maximum being `boardWidthDocked` makes the constraint mutually recursive
with the thing it constrains, since `boardWidthDocked` is derived from
`panelWidth`. It resolves algebraically: with `lane = usableWidth − 2·edge −
rail − 2·gap`, `panel ≤ board` is `panel ≤ lane / 2`. That is what gets
implemented — a bound on the lane, not a fixed point iteration. At the
reference size, `lane = 1200` and the maximum is 600.

## Where the drag may start

The most-researched part of this, and the part with the least room for taste.

```
┌──────────┐  ⋮  ┌────────┐
│          │  ⋮  │        │   board side:   0pt
│  board   │  ⋮  │ panel  │   gutter:      24pt   (--space-gap)
│ (canvas) │  ⋮  │        │   panel side:  18pt   (--space-panel-inset)
│          │  ⋮  │        │
└──────────┘  ⋮  └────────┘   42pt grabbable · 0pt painted at rest
```

The strip is deliberately **asymmetric**, which is where it departs from every
reference implementation:

- **0pt into the board.** The board is a live `PKCanvasView`. A hit region that
  overlaps it by even one point eats ink strokes at the exact place a
  right-handed student's hand rests. Every desktop splitter straddles its seam
  evenly; this one cannot.
- **24pt of gutter.** `--space-gap` is empty screen-grey the full 976pt of the
  content band. Nothing is drawn in it and nothing is interactive in it, so
  claiming it costs no pixels and creates no new space.
- **18pt into the panel.** `--space-panel-inset` is dead by construction —
  board 02 specs the 301pt content column against it, so no child of the panel
  reaches its edge.

42pt is under the HIG's 44, and that is fine: the target is 42 × 976. Fitts's
law makes a long thin target easy to acquire, which is the same reasoning
`ToolRailMetrics.swatchPitch` relies on.

**The rule the strip obeys, stated generally:** a resize region may only claim
space that no content can reach. Where a neighbour's content extends to its
own edge, the margin on that side is zero.

## What a drag feels like

On a touchscreen the desktop feedback vocabulary is simply absent — there is no
hover state and no cursor, so VS Code's 300ms hover highlight and
`react-resizable-panels`' `cursorFlags` have no analogue. Worse, a finger
occludes the pixels a touch-down state reveals.

**So the confirmation is haptic.** That is the substitute for the cursor
feedback, not an embellishment on top of it.

| Moment | Visual | Haptic |
|---|---|---|
| Touch down in strip | 4 × 48 capsule fades in over 120ms, centred on the seam **at the finger's y** | `.impact(.light)` |
| Dragging | Board and panel resize live, 1:1 with the finger | — |
| Pinned at min or max | Panel holds; capsule follows the finger with rubber-band resistance | `.impact(.rigid)`, once per contact |
| Crossing collapse | Panel springs to the dock | `.impact(.medium)` |
| Release | Capsule fades out over 180ms | — |
| Double-tap | Resets to 337 | `.selection` |

Nothing is painted at rest. The capsule appears where the finger is, which is
the touch equivalent of a hover state — it cannot appear at a fixed position,
because the student is looking at their finger.

Invisible-at-rest has a real discoverability cost, and it is accepted
deliberately: the design does not change, and no space is created for an
affordance. The mitigations that cost nothing visually are the double-tap
reset, the accessibility adjustable action, and the two existing
`PanelControls` buttons, which remain the discoverable path to the same states.

## Architecture

Four units. Only the third knows SwiftUI exists.

### `ResizeConstraints` — value type

`minimum`, `maximum`, `collapseBelow: CGFloat?` (nil = not collapsible),
`rubberBandCoefficient`. `Equatable`, `Sendable`. Constructed by the caller
from whatever rules it has; knows nothing about panels.

### `ResizeResolution` — value type

The output of one resolve: the `size` to draw, the `handleOffset` (which
differs from the size only under rubber band), `isCollapsed`, and `limit:
.none | .minimum | .maximum` — the last existing so the view knows when to fire
a haptic without recomputing anything.

### `ResizeModel` — pure function

```
resolve(start: CGFloat,
        translation: CGFloat,
        edge: ResizeEdge,
        constraints: ResizeConstraints) -> ResizeResolution
```

**Anchored, not accumulated.** The size is always computed from the size
frozen at gesture start plus the gesture's *total* translation — never from
the previous frame's size plus a per-frame delta. This is the single most
important correctness property, and it is the one `react-resizable-panels`
calls out: accumulating deltas drifts, and it fights clamping, because a
frame spent pinned at a limit silently loses the travel that would have
brought the panel back off it.

`edge` supplies the sign. `ResizeAxis` is `.horizontal | .vertical` and
`ResizeEdge` is `.leading | .trailing | .top | .bottom`, so the model covers
both axes with one code path and no vertical-specific branch.

Zero SwiftUI imports. This is where every edge case is tested.

### `ResizeHandle` — the view

Owns the hit geometry (asymmetric insets supplied per edge by the caller),
`DragGesture(minimumDistance: 2)`, the capsule, the haptics, the double-tap,
and `.accessibilityAdjustableAction`. Takes constraints and a size binding,
reports gesture start and end through closures. Knows nothing about the tutor
panel, the board, or `ScreenLayout` — it is reusable on any edge of any
surface.

### Wiring

- `ScreenLayout.panelWidth` becomes an instance property with
  `DS.Container.panel` as its default. `panelX`, `boardWidthDocked` and
  `dockedMinimumWidth` already derive from it and change not at all.
  `dockedMinimumWidth` becomes an instance property for the same reason.
- `UIState` gains `panelWidth`, `@Published private(set)`, mutated through
  guarded transitions like the other three axes. It does not persist, in
  keeping with the type's own contract.
- `BoardScreen.layout` injects it — the same computed property that already
  rebuilds the layout for `--ui-window`, which is the established seam for
  "the screen publishes the layout it drew itself in."

## Edge cases

Named because handling them is the requirement, not a bonus.

**Geometry**

1. Split View or Stage Manager invalidates a width that was legal a moment
   ago. The width is re-clamped on **every layout pass**, not only at drag
   end. Rotation is *not* among the causes: `project.yml` pins
   `UISupportedInterfaceOrientations~ipad` to the two landscape orientations,
   so the window never changes aspect that way. It is still a window-size
   change like any other and needs no special case.
2. The window shrinks past `dockedMinimumWidth`. The existing `fit`
   substitution collapses the panel; the requested width must be **remembered,
   not destroyed**, so widening the window restores it. This is the same
   reversibility argument `BoardScreen.presentation` already makes.
3. A wider panel raises `dockedMinimumWidth`, so a wide panel collapses at a
   window size a default one survives. Coherent, but needs a test proving it
   does not oscillate — it does not, because `fit` reads the *requested* width,
   which the substitution never writes back.
4. `maximum < minimum` on a small window. Clamp order decides whether the panel
   can be forced wider than the board. The model must resolve this to the
   unsupported case rather than picking a bound.
5. Zero, negative or NaN container size.

**Gesture**

6. The finger leaves the strip mid-drag. Tracking continues (SwiftUI gives
   this; the DOM implementations need document-level listeners for it).
7. A second finger lands mid-drag. Ignored.
8. The gesture is cancelled — backgrounding, an incoming call, a Split View
   change. Must commit a valid state, never a half-drag.
9. A tap with no movement. No resize, no collapse. This is what
   `minimumDistance` buys.
10. Apple Pencil on the strip resizes; Pencil hovering the canvas never arms
    it.
11. A fast flick past the maximum clamps rather than overshooting and
    recoiling.
12. The Settings window is open. The strip is inert — `SettingsPresentation`
    blurs the screen behind it, and a live handle under a blur is a ghost
    control.
13. The tutor is collapsed or full-screen. The strip does not exist, rather
    than existing invisibly and remaining hittable.

**State**

14. Collapse-by-drag and collapse-by-button both land in `.collapsed`.
    Reopening restores the custom width, because presentation and width are
    independent axes — the same model the design's existing two axes use.
15. Collapse, then drag back within the same gesture. Un-collapses.
16. VoiceOver reaches the handle as an adjustable element and resizes by a
    fixed step.

**Rendering**

17. `PKCanvasView` is resized on every frame of the drag. It must not
    auto-recentre mid-gesture; `CanvasCapture.centerOnContent` stays a
    rail-driven action.
18. Width is **unanimated during the drag** and **animated on snap and
    release**. Mixing the two is the classic failure and produces a panel that
    lags the finger.
19. `--ui-fixture` and `--ui-window` stay pinned to their reference values so
    the `design/reference/*.png` diff does not move.

## Testing

The split exists so that most of this is cheap.

- **`ResizeModelTests`** — pure, no host view. Covers every geometry and state
  case above: clamping at both bounds, the collapse threshold in both
  directions, rubber-band monotonicity, anchored-vs-accumulated drift (drag out
  past the limit and back, assert the size returns exactly), `max < min`, and
  the degenerate sizes.
- **`LayoutTests`** — extended. `panelWidth` as a variable reproduces every
  currently-asserted number at its default, the `panel ≤ lane/2` bound is
  correct at several window sizes, and `dockedMinimumWidth` tracks the panel.
- **`ShellComponentTests`** — the existing host-window resize proves a custom
  width re-clamps when the window shrinks and survives when it grows back.
- **UI** — one test that the strip does not exist when collapsed or
  full-screen. Deliberately thin: per the recorded lesson about lossy first
  taps, gesture assertions go through the model, not the simulator.

## Out of scope

- **Persistence across launches.** `UIState` states that presentation state
  must not persist, and honouring that is a decision, not an oversight. Tracked
  separately.
- **Corner resize.** Both axes are covered by the model and the handle, but no
  orthogonal or corner handle is built. VS Code needs a dedicated corner-sash
  mechanism for that and it is the fiddliest part of their implementation;
  there is no consumer for it here.
- **Resizing the Settings window or the full-screen column.** The handle is
  built to be reusable there, but neither is wired up.
- **Vertical resize consumers.** The axis exists in the model and the handle;
  nothing uses it yet.

## References

- [VS Code `Sash`](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/sash/sash.ts)
  — hit area straddling the seam, drag state machine, double-click reset.
- [`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels)
  — anchored drag math, `hitAreaMargins` coarse/fine, collapse-snapping,
  container-resize behaviour.
- [WAI-ARIA window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter)
  — the accessibility contract an adjustable action reproduces.
- [Apple HIG — touchscreen gestures](https://developers.apple.com/design/human-interface-guidelines/inputs/touchscreen-gestures)
  and [pointing devices](https://developer.apple.com/design/human-interface-guidelines/inputs/pointing-devices).
- [NN/g — drag and drop](https://www.nngroup.com/articles/drag-drop/) and
  [tablet discoverability study](https://arxiv.org/pdf/1806.06084) — the cost
  of invisible contextual gestures, accepted here deliberately.
- Apple rubber-band formula `b = (1 − 1/((x·c/d) + 1))·d`, `c = 0.55`
  ([analysis](https://medium.com/@victorbaro/recreating-apple-s-rubber-band-effect-in-swift-dbf981b40f35)).
