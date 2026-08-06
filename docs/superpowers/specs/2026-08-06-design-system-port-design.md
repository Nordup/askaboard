# Porting the design system to code

**Date:** 2026-08-06
**Source of truth:** Paper file *AI Whiteboard Tutor — Design System, Components & Page* (`01KZAH9BZ4FRZXKG2309B7SSRG`), transcribed into [`docs/design-system/`](../../design-system/).

## What this is

The design system is finished and unusually well specified: 74 tokens each carrying the
designer's own rationale, nine boards, and four live screens whose every value was measured
rather than estimated. The app it describes does not exist yet — the current app is a
different design wearing stock iOS controls.

This is a ground-up rebuild of the presentation layer against that design, keeping the parts
of the current app that are good and have nothing to do with how it looks.

## Keep, rewrite, add

| | What | Why |
|---|---|---|
| **Keep** | The board engine in `CanvasView.swift` — 50,000pt board, centroid-based evaluation cropping, "first UIKit layout pass is the board's real start" | Genuinely good work, densely commented, covered by ~25 unit tests. Only its *tool ownership* changes. |
| **Keep** | `TutorService`, `OpenAITutorService`, `KeychainStore`, `SessionPersistence`, the strict-JSON planning envelope | Nothing to do with presentation. Split into files by responsibility, logic untouched. |
| **Keep** | `Models.swift` domain types | Extended, not replaced. |
| **Rewrite** | `WorkspaceView.swift` (984 lines), `ContentView.swift` (327 lines) | They implement a different design: a draggable resizable floating panel, a native `PKToolPicker`, `.indigo` system tints, a top bar and exercise card the design has no place for. |
| **Add** | A design-system layer that did not exist | Tokens, elevation, typography, icons, and the components the boards specify. |

## Layering

Each layer may only depend on layers above it.

```
Domain        Models, LearningSession, TutorMessage, BoardTool     — no UIKit, no SwiftUI
Services      TutorService, OpenAI, Keychain, Persistence          — depends on Domain
DesignSystem  tokens, elevation, typography, icons, components     — depends on nothing
Features      Board, Tutor                                         — depends on all three
App           MathTutorApp, RootView                               — wires them together
```

`DesignSystem` knowing nothing about the app is the load-bearing rule: a component that
reaches for `TutorStore` is not a component, it is a screen fragment.

## The token pipeline

Values must not be retyped by hand — that is how a design system rots.

```
Paper  ──get_tokens──▶  design/tokens.json  ──scripts/generate-tokens.swift──▶  DesignTokens.swift
```

`design/tokens.json` is the verbatim export, including Paper's own `contentHash`. A unit test
re-runs the generator in-process and asserts the checked-in Swift matches, so drift fails the
build instead of surprising someone six weeks later.

**The one exception, and it is declared as one:** Paper has no shadow token type, so the
elevation scale lives as prose on the Foundations board and is hand-carried into
`Elevation.swift`. That file carries the verbatim board text next to the values.

## The icon pipeline

The design ships 16 custom product glyphs (plus two OS-chrome glyphs marked "DO NOT SHIP").
They are stroked vectors with per-icon weights, two dash textures, and token-bound colours —
none of that survives a PNG export, and SF Symbols are not these shapes.

```
Paper  ──get_jsx──▶  design/icons.json (verbatim `d` attributes)  ──▶  IconPaths.swift  ──▶  SVGPath parser  ──▶  SwiftUI Path
```

Keeping the `d` strings verbatim means the code can be diffed against the design directly.
The parser needs elliptical-arc support (`A`/`a`) because several glyphs use it; that is the
only genuinely tricky part and it gets its own tests.

**Adopting the design's own rejected recommendation.** Board 04 recommends drawing every glyph
on a 24 viewBox rendered at 24, so `strokeWidth` is always exactly 2.0 with nothing to
re-derive. It was rejected *in Paper* because rescaling a 28 viewBox there means redrawing
every coordinate. In code that constraint does not exist — a `scaleEffect` on the path is free.
So the port normalises render size and carries one stroke width, with the two documented
exceptions (`tool/lasso` 2.7, `board/hinge` 1.9) preserved as explicit overrides.

## State model

The four screens are two independent axes, not four screens:

```
presentation ∈ { docked, collapsed, fullScreen }
conversation ∈ { start, active }
```

| | start | active |
|---|---|---|
| **docked** | screen 05 | screen 08 |
| **collapsed** | screen 06 | screen 06 |
| **fullScreen** | screen 07 | **undesigned** |

Board 09 states it outright: *"The outer frame is identical to screen 05 down to the pixel —
only the tutor panel's contents change — so a developer implements one shell and swaps what
fills the panel."* The code follows that exactly: one `BoardShell`, one `TutorPanel` whose
body branches on `conversation`.

This is why UI state gets its own type rather than living in `TutorStore`. Presentation state
is not session data — it should not persist, should not round-trip through JSON, and mixing
the two is precisely what grew `WorkspaceView` to 984 lines.

## The tool rail is the biggest behavioural change

Today PencilKit owns tool selection through its floating `PKToolPicker`. The design replaces it
with a 72pt rail the app owns: four tools, five pen colours, a thickness control, centre-on-work.

So the canvas stops presenting the picker and instead takes `canvas.tool` from rail state
(`PKInkingTool` / `PKEraserTool` / `PKLassoTool`). Finger-pan and pencil-only drawing stay as
they are — that behaviour is deliberate and tested.

**The rail's spacing is hand-tuned and must not be tidied.** `padding-block 9`, rail `gap 0`,
tool slots `gap 3.5`, divider `46 × 1.5`, swatches 27pt on a 27pt gap, margin-tops
11.5 / 19.5 / 29 / 19.5 — summing to exactly **627.5**. A test asserts that total, because
snapping these to the 4px scale has already broken this rail once.

## What the design does not specify

Real gaps, listed so they are decisions rather than accidents. Where the design is silent the
code stays minimal and obvious rather than inventing a visual language:

- Full-screen tutor *with* an active conversation — the one empty cell in the state table
- Streaming/typing, error/retry, and evaluation-feedback states (a design agent is now drawing these)
- Settings, session plan, and the no-API-key onboarding state (same agent)
- All animation: timing, easing, panel dock/expand, canvas width change, orb motion
- Keyboard-up layout and the focused/filled composer
- Selection marquee on the canvas itself
- Tool rail states beyond "pen selected" — no hover, pressed, disabled, or selected swatch
- Dark mode (four near-white surfaces 2–4% apart, with no dark mapping) and Dynamic Type

## Verification

1. **Generator drift test** — checked-in Swift matches `design/tokens.json`.
2. **Geometry tests** — the numbers the design states as load-bearing, asserted directly:
   rail 627.5, panel 337/301, column 740 at x 352, greeting 522 and 268, board 863 and 1224,
   content band 68→1004.
3. **SVG parser tests** — every command including arcs, against known-good bounding boxes.
4. **Existing unit tests keep passing** — the board engine's behaviour must not regress.
5. **XCUITests** rewritten for the new state machine.
6. **Visual diff** — run on an iPad Pro 13" simulator, screenshot each state, and compare
   side by side against the Paper boards. This is the check that actually catches a wrong
   inset, and it is the last gate.

### The launch-argument contract for visual diffing

Comparing a screenshot against a design board only works if the app can be put into an exact
state without a human driving it, and without the comparison being spoiled by content that
changes run to run. So `RootView` honours these DEBUG-only launch arguments:

| Argument | Effect |
|---|---|
| `--ui-state docked-start` | Screen 05 |
| `--ui-state collapsed` | Screen 06 |
| `--ui-state fullscreen-start` | Screen 07 |
| `--ui-state docked-active` | Screen 08 |
| `--ui-fixture` | Loads the exact copy the boards show, so text wraps identically |
| `--ui-freeze` | Disables animation and the orb's idle motion, so screenshots are stable |

The fixture copy is the literal strings transcribed in `docs/design-system/05-screens.md`
("Hi! I'm your AI Tutor", the four chip labels, "Selection attached", "Ask anything...").
Using anything else makes a pixel diff meaningless, because a different line break moves
every element below it.

These are compiled out of release builds, exactly as the existing `--e2e-seed-radical-attempt`
fixture already is.
