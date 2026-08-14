# Container morph — how production shared-element transitions move content, and the recipe for this app

Research brief, 2026-08-12. Target: the docked panel ↔ full-screen reading column transition
(screens 05/08 ↔ screen 07), gesture-scrubbed, iPadOS 17, A10 iPad (6th gen).

Read this before touching `PresentationMorph.swift` again. Section 2 is the finding that
changes the design; everything after it follows from it.

---

## 0. The one-paragraph answer

The current morph interpolates a **box** and crossfades two **pictures** inside it. Every
production container transform interpolates a box *and moves the content that is inside it*,
because the content is drawn at its own layout size and multiplied by a transform that the
container drives. That is the whole difference, and the learner's sentence — *"chat dock stays
at the same place, it just fades away without any morphism"* — is a correct description of
content that was never given a path to travel.

For this app the fix is unusually cheap, because of section 2: **the two endpoints already
draw the same components at the same type scale on the same baselines.** The docked start
state and the full-screen start state differ in exactly two things — a horizontal translation
of 491.5 pt and a widening of four chips. Nothing needs to be scaled, re-typeset or
crossfaded for the hi state at all. The thread state is the only place a genuine crossfade is
required, and even there the glyph sizes match, so a co-located crossfade reads as text
re-flowing rather than as a dissolve between two different screens.

---

## 1. Where the code is right now

### 1.1 What exists

| File | Status | What it is |
|---|---|---|
| `MathTutor/DesignSystem/Components/Shell/PresentationMorph.swift` | **on disk, compiled, unwired** | The arithmetic (`PresentationMorph`), the live position (`PresentationMorphModel`), the per-role renderer (`PresentationMorphRender`), two `Shape`s |
| `MathTutor/DesignSystem/Components/Shell/PresentationMorphLayer.swift` | **deleted in the working tree** (`git status` = `D`) | The hosting layer that mounted both presentations at once |
| `MathTutorTests/PresentationMorphTests.swift` | on disk, 16 tests | Pins endpoint parity, travel, curves, clamping |
| `docs/design-system/02-shell-components.md` §15.4 | describes the tracked morph | Now ahead of the code |
| `MathTutor/Features/Tutor/TutorFullScreen.swift` ~line 355 | reverted to commit-triggered | *"the tracked container morph … is wired off for now: it froze the app on the iPadOS 17 device"* |

A concurrent session reverted the wiring while this brief was being written. Treat
`PresentationMorph.swift` as a surviving component with a good arithmetic core and a wrong
content model; treat the layer as a design to be rewritten rather than restored.

### 1.2 Why it reads as a crossfade and not a morph

Four independent reasons, all of them structural:

1. **Neither content ever moves.** `PresentationMorphRender` applies, per role: `.clipShape` +
   `.opacity` for `dockedChat`, `.clipShape` + `.opacity` for `fullScreenChat`. No `offset`,
   no `scaleEffect`, no frame interpolation. Both contents sit at their settled positions for
   the whole travel. The container's trailing edge slides out from under the docked content
   and the incoming content is revealed *already in its final place*. Literally nothing
   travels.
2. **Every shared element is duplicated, not shared.** The orb, the composer, the greeting and
   the sidebar toggle exist twice — once in `TutorPanel`, once in `TutorFullScreen` — and the
   morph dissolves one copy into the other. The App Store transition, Material's container
   transform and iOS 18's `.zoom` all move *one* instance. (§3)
3. **The crossfade band is Material's *return* window used on the *enter* leg.** The code holds
   the outgoing at opacity 1 until **60%** and fades the incoming in from **55%** to **85%**
   (`outgoingHoldUntil`, `incomingFrom`). Material's own default enter thresholds are
   `fade = 0f…0.25f`; its `0.60f…0.90f` pair is the *return* threshold. So for the first 55% of
   an expanding gesture the learner watches an empty growing rectangle, and everything happens
   in a rush at the end — which is the second half of the user's complaint.
4. **The board leaves the wrong way.** `boardShift` translates the card by the full travel
   (1011 pt on the reference screen), which carries its leading edge to x ≈ 1472 — *past* the
   peek at x = 1331 and off the screen — while a separately-drawn peek silhouette fades up at
   1331. Two objects, one crossfade, no continuity. (§8)

### 1.3 The freeze

The device hang is recorded in the code comment, not yet root-caused. Do not restore the layer
without a hypothesis. Section 9.3 lists the candidates in order, and the top one is a known
device-only, iPadOS-17-only class of bug in this repo (`BoardCanvas.swift` already carries the
scar: a `resignFirstResponder()` inside `updateUIView` deadlocked UIKit's keyboard machinery
on the same device).

---

## 2. What the two endpoints actually are — measured

Reference screen: 1376 × 1032, `panelWidth = 337`, no safe-area insets, no keyboard.

**The decisive fact: `TutorColumnMetrics.liveScale == .panel`.** The reading column currently
draws every component at `ChatScale.panel` (`TutorFullScreen.scale`), capped at
`panelTreatmentColumnCap = 600`. So the *type scale, chip treatment, icon sizes, composer
treatment and paddings are identical at both ends*. Board 05's "two variants, not one
responsive view" — which §15.4 still cites as the reason the contents cannot interpolate — is
no longer what the app draws. The only remaining differences are a column width and a column
origin.

### 2.1 Frames

| Thing | Docked (screen 05/08) | Full screen (screen 07, sidebar shut) | Delta |
|---|---|---|---|
| Container | `(28, 28, 337, 976)`, r=28 all round | `(0, 0, 1376, 1032)`, r=0 | grows 4.08× in x, 1.06× in y |
| Content column | x 46, width **301**, centre **196.5** | x **388**, width **600**, centre **688** | **+491.5** centre, **+299** width |
| Orb (`.panel`, 96×90) | top y **198**, x 148.5 | top y **198**, x 640 | **pure +491.5 x**, zero y, zero scale |
| Greeting block top | y **328** | y **328** | **zero** |
| Title (26/`.title`, 1 line, centred) | centred in 301 | centred in 600 | centre +491.5, same glyphs |
| Subtitle | width `min(277, column)` = **277** | width `min(277, 600)` = **277** | **identical layout**, centre +491.5 |
| Suggestion chips | 1 column × 4, 301 wide, h 62, gap 10 | 1 column × 4, **600** wide, h 62, gap 10 | x +342 (leading edge), **width +299** |
| Composer pill (`.panel`, h 50) | x 46, w 301, bottom **986** | x 388, w 600, bottom **1004** | x +342, w +299, **y +18** |
| Panel controls (dock + full-screen pair) | trailing of the 301 column, y 46 | **does not exist** | unmatched → fades |
| Sidebar toggle | x 46, y 46 | x 28 (`contentLeft`), y 28 | **−18 x, −18 y** — nearly stationary |
| Thread column | 301 wide, x 46 | 600 wide, x 388 | +342 x, +299 width, **bubbles re-wrap** |
| Board card | x 485, w 863 | absent; peek at x 1331, w 45 | see §8 |

`SuggestionChipMetrics.designColumns(.panel) == 1`, so the chip grid is 1-up at both widths —
no grid reflow. `GreetingMetrics.for(.panel, width:)` has no width-dependent term except the
chip container height, which is `4 × 62 + 3 × 10 = 278` at both widths. **The greeting block's
total height is 522 at both ends.**

### 2.2 What this means

- For the **hi state**, a true morph needs no crossfade, no scale, no snapshot and no
  re-typesetting. It needs a translation and one width interpolation. Every glyph keeps its
  size and its baseline; the block simply walks to the middle of the screen and the chips
  stretch under it. That is "text taking shape" delivered by the cheapest mechanism there is.
- For the **thread state**, the bubbles' `bubbleMaxWidth` is a function of the column, so text
  genuinely re-wraps. This is the only element that needs the two-copy technique (§4, §6.3).
- The composer, the orb and the sidebar toggle are **true shared elements** — same size, same
  treatment, both ends. They must be single instances that travel, not pairs that dissolve.

---

## 3. How production container transforms actually move content

Three systems, one decomposition. Every one of them separates **the mask**, **a single scale
scalar**, and **a fade with a much narrower progress window than the geometry**.

### 3.1 Material `MaterialContainerTransform`

Apple-language summary from the API reference: the transition "captures start and end Views
and creates a Drawable that morphs between their shapes"; a masking container transforms from
the start shape to the end shape, "Start and end Views are drawn inside the masking container
and fade in/out", and the container "translates and scales from start to end position and
size".
<https://developer.android.com/reference/com/google/android/material/transition/MaterialContainerTransform>

The draw call is the whole model — both contents go through the same helper, each with **its
own scale and its own alpha**, both pinned to the container's current origin:

```java
transform(canvas, getBounds(), currentStartBounds.left, currentStartBounds.top,
    fitModeResult.startScale, fadeModeResult.startAlpha, /* startView.draw(canvas) */);
```
<https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/MaterialContainerTransform.java>

**fitMode — one master axis drives both scales.** `FitModeEvaluators.java`:

```java
float currentWidth = lerp(startWidth, endWidth, scaleStartFraction, scaleEndFraction, progress, true);
float startScale = currentWidth / startWidth;   // outgoing, laid out at start size, scaled UP
float endScale   = currentWidth / endWidth;     // incoming, laid out at END size, scaled DOWN
```

That second line **is** the counter-scale: the incoming content is laid out at its final
geometry and scaled *down* to meet the container, so it arrives at scale 1.0 with no layout
pass. `FIT_MODE_AUTO` picks the axis on which fitted content *overflows* rather than
under-fills, so the mask never reveals empty space.
<https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FitModeEvaluators.java>

**Fade modes** (`FadeModeEvaluators.java`), alpha 0–255:

| Mode | start alpha | end alpha | z |
|---|---|---|---|
| `FADE_MODE_IN` (default) | 255 (held) | `lerp(0,255, fadeStart, fadeEnd, p)` | end on top |
| `FADE_MODE_OUT` | `lerp(255,0,…)` | 255 (held) | start on top |
| `FADE_MODE_CROSS` | `lerp(255,0,…)` | `lerp(0,255,…)` | start on top |
| `FADE_MODE_THROUGH` | out over first 35% of the window | in over the last 65% | start on top |

`FadeThroughProvider.FADE_THROUGH_THRESHOLD = 0.35F`.
<https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FadeModeEvaluators.java>
<https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FadeThroughProvider.java>

**Default progress thresholds** — the numbers that indict our current bands:

| Track | Enter | Return |
|---|---|---|
| fade | **0 … 0.25** | 0.60 … 0.90 |
| scale (content) | 0 … 1 | 0 … 1 |
| scaleMask (container size) | 0 … 1 | 0 … 0.90 |
| shapeMask (corner radius) | 0 … **0.75** | 0.30 … 0.90 |

Elevation lerps linearly across the whole progress; the scrim (`0x52000000`, black 32%) ramps
across the whole progress; corners are converted to **relative** corner sizes before
interpolation, which is why they stay right while the box changes aspect ratio.

Durations: the M3 theme applies `motionDurationLong2 = 500ms` entering /
`motionDurationMedium4 = 400ms` returning with the emphasized easing path; the older M2 prose
in the same repo states 300 ms / 250 ms with `cubic-bezier(0.4, 0, 0.2, 1)`. For a hand-rolled
iOS version the 300/250 pair is the better starting point — and for us it is moot, because the
gesture is the clock and the release is a spring.
<https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md>

### 3.2 UIKit snapshot / zoom transitions

The canonical recipe: lay the destination out at its **final** size, then scale it down about a
matching anchor.

```
scale = startFrame.width / endView.bounds.width      // == Material FIT_MODE_WIDTH
layer.anchorPoint = the corner that must coincide in both frames
layer.position    = that corner's location in the start frame
```

Scaling about a matched anchor makes the transform a pure similarity — no separate translate
term to keep in sync, and every child moves in exact proportion for free. Any child that must
*not* shrink gets the inverse transform `1/s`. Animating `frame` instead re-runs layout every
step: Auto Layout re-solves, text re-wraps mid-flight, wrap points change under the reader's
eye. Animating `transform` is one GPU matrix on the whole subtree.

`UIView.snapshotView(afterScreenUpdates:)` returns a static raster of the source; changing its
frame stretches the bitmap and it never re-renders.
`resizableSnapshotView(from:afterScreenUpdates:withCapInsets:)` adds nine-part cap insets so a
rounded-rectangle card can stretch its middle without smearing its corners.
<https://developer.apple.com/documentation/uikit/uiview/1622531-snapshotview>
<https://developer.apple.com/documentation/uikit/uiview/1622518-resizablesnapshotview>

Zalando's write-up is the cautionary tale for the raster route: they started with a
`UIGraphicsImageRenderer` snapshot and hit "image pixelation and awkward text scaling, leading
to abrupt disappearances", then moved to re-rendering the real components.
<https://engineering.zalando.com/posts/2024/07/custom-navigational-transitions-ios.html>

Interactivity: `UIViewPropertyAnimator.fractionComplete` is the scrubber.
WWDC 2017 session **230, "Advanced Animations with UIKit"**, states the load-bearing fact —
when an animator is **paused it converts to a linear timing curve**, "the fraction of time is
equal to the fraction of progress", so scrubbing is uniform; `continueAnimation(withTimingParameters:durationFactor:)`
restores the curve and remaps time so nothing jumps. Springs always restart from the
**presentation** values, so an interruption must build a fresh animator from the presentation
layer. The same session builds a six-animator transition coordinating frame, blur and "view
morphing" (scale + translate + opacity blend).
<https://nonstrict.eu/wwdcindex/wwdc2017/230/>
<https://developer.apple.com/documentation/uikit/uiviewpropertyanimator>
Apple's own interruptible reference implementation is the **PhotoTransitioning** sample.
<https://developer.apple.com/library/archive/samplecode/PhotoTransitioning/Introduction/Intro.html>

### 3.3 App Store card → detail

The most detailed public dissection (aunnnn's article + repo) yields three rules:

1. **Two curves, not one.** The container's vertical position animates on a **spring**
   (`usingSpringWithDamping: 0.5`, `initialSpringVelocity: 0`, duration 1.0 s); the card's
   width and height animate **linearly** (0.48 s). Mixing them onto one curve is what makes
   naive clones feel wrong.
2. **Text does not reshape — it is scaled at a locked point size.** The font size is held
   constant for the whole animation and a scale factor carries the size change (home 1.0,
   pressed 0.9, animating 0.9, detail 0.9). Changing the actual `font` mid-flight produces a
   visible jump. This is the iOS statement of Material's "draw at layout size, multiply by
   scale".
3. **No snapshot of the destination.** The presented view controller's real view is positioned
   by Auto Layout at the source cell's frame and the cell is hidden; the real hierarchy
   animates. Labels stay pinned to the card's corners throughout, and the background image
   uses `contentMode = .center` so it does not resize as the card grows.

<https://github.com/aunnnn/AppStoreiOS11InteractiveTransition>
<https://medium.com/@aunnnn/making-app-store-today-ios-11-custom-transition-part-1-presentation-9e4ef99e75d3>
<https://github.com/appssemble/appstore-card-transition>

**The illusion of "text morphing" in the App Store is: constant font size × animated scale ×
corner-pinned constraints.** There is no glyph interpolation anywhere in it. Worth internalising
before promising the learner something that no shipping app actually does.

### 3.4 iOS 18 `.zoom` — the intended feel, stated by Apple

Not available to us (iPadOS 17), but it is Apple's own description of the target: "the cell you
tap **morphs into** the incoming view", continuously interactive — grabbable "from the beginning
or during the transition", interruptible and cancellable. SwiftUI:
`.navigationTransition(.zoom(sourceID:in:))` + `.matchedTransitionSource(id:in:)`. UIKit:
`preferredTransition = .zoom { context in … }`, resolving the source view from a **stable
identifier** rather than a captured view.
<https://developer.apple.com/videos/play/wwdc2024/10145/>

`UIZoomTransitionOptions.alignmentRectProvider` — "returns a frame in the zoomed view
controller's view to which to align the source view" — is the direct analogue of Material's
fitMode, and Douglas Hill's teardown names the failure it exists to fix: without it, "the ferry
shifts because the aspect ratios of the source and destination don't match", producing a
two-image ghost. Our two aspect ratios (337×976 vs 1376×1032) are wildly mismatched, so we are
squarely in the case that needs an explicit alignment rect — which for us is section 2's per-
element table rather than one rect.
<https://developer.apple.com/documentation/uikit/uiviewcontroller/transition/zoomoptions/alignmentrectprovider>
<https://douglashill.co/zoom-transitions/>

### 3.5 The five-part decomposition to copy

1. A **mask/container** interpolating position, size and corner radius, clipping everything.
2. A **single scale scalar** derived from one master axis, applied to both contents.
3. **Content drawn at its own layout size and multiplied by that scale** — never resized,
   never re-laid-out mid-flight. Children that must hold their size get `1/s`.
4. A **fade with a much narrower window than the geometry** — first 25% on enter, last 30% on
   return, sequential (0.35 split) for fade-through.
5. **Corner radius finishing early** (75% on enter) and a scrim ramping across the whole thing.
6. App Store's addition: **split the curves** — springy on position, linear on size.

Our departure from (2)/(3) is deliberate and is licensed by section 2: because both endpoints
already share a type scale, we can do better than a global scale — we can give each shared
element its own frame-to-frame path, which is strictly more faithful than one scalar.

---

## 4. Text "taking shape" — the four real techniques

| Technique | What it looks like | Cost | Verdict here |
|---|---|---|---|
| **Raster scale** — snapshot the text, `scaleEffect` the bitmap | crisp at 1.0, soft past ~1.3×, mush at 2× | one texture, ~free | **No.** Our master ratio is 600/301 ≈ 1.99 for the column and 4.08 for the container. Zalando's exact failure. |
| **Vector scale at locked point size** (App Store) | genuinely crisp, but the *type gets bigger*, it does not re-wrap | one transform, free | **No** for the column: the endpoints have the *same* point size by design, so scaling would invent a size change the design does not ask for. |
| **Two copies, matched glyph size, co-located, crossfading mid-flight** | letters appear to re-flow into new line breaks | two layouts, each built once; per frame only offset + opacity | **Yes, for the thread only.** |
| **Real relayout at an interpolated width** | actually correct: the true intermediate | one layout pass per frame per text node | **Yes, for the hi state** — measured cheap because nothing re-wraps (§2.1) |

The fourth row is the one the design gets for free and nobody expects. The hi state's title is
one line, its subtitle is capped at 277 pt at *both* widths, and its chip labels are
`lineLimit(1)`. Interpolating the column width from 301 to 600 therefore re-typesets nothing —
it only re-centres and re-frames. That is a handful of layout nodes per frame, and it is the
honest, crisp, vector answer.

The third row is what the App Store *feels* like and what the learner is describing. It works
only when the two copies are the same glyph size and are **co-located** — which is exactly what
the current implementation fails to do (both copies sit at their own final positions, so the
dissolve has no common anchor and reads as one screen replacing another).

---

## 6. The recipe

Progress `p` runs **0 = docked → 1 = full screen**, driven one-to-one by the finger against the
container's trailing edge (`travel = screenWidth − dockTravel = 1011`), clamped both ends.
Every curve below is a pure function of `p`, so the reverse direction is the same code read
backwards and a gesture that turns around retraces its own frames. Keep that property — it is
the best thing about the existing arithmetic.

Notation: `t = p` (linear, finger-locked) unless a band is named. `smoothstep(a,b)` is the
existing helper. All coordinates are screen coordinates on the reference device.

### 6.0 Structural change: a flight layer

The shared elements cannot travel while they are children of two different surfaces. Adopt the
UIKit transition-container pattern rather than re-architecting `TutorPanel`/`TutorFullScreen`:

- At gesture commitment, the morph layer builds **one flight copy** of each shared element
  (orb, greeting title+subtitle, chip stack, composer pill, sidebar toggle), as real SwiftUI
  views laid out at the **destination** geometry, and hides those elements in both surfaces for
  the duration.
- Flight copies are built **once**, at commitment — never per frame. This is the SwiftUI
  equivalent of "take the snapshot at gesture start, not per frame".
- The composer flight copy renders the pill **without** the live `TextField` (a placeholder run
  of the same string at the same metrics). You cannot type mid-swipe, and this removes the
  entire first-responder hazard from the animated path (§9.3). Resign focus at commitment, on
  a `DispatchQueue.main.async` hop, never inside the render transaction.
- Both surfaces stay mounted (as today) so the settle lands on a live view with a live
  responder; they just contribute no shared elements while a morph is in flight.

### 6.1 The container — keep, retune

| Property | Band | Curve | Note |
|---|---|---|---|
| Frame | 0 … 1 | linear, finger | `containerFrame(at:)` unchanged |
| Corner radius | 0 … **0.75** | smoothstep | **change**: currently runs 0…1. Material finishes corners early; a square-cornered box that is still growing reads as "arrived". Return leg: 0.30 … 0.90 |
| Fill (panel → surface) | 0 … 0.30 | linear | **change**: currently linear across the whole travel. Two colours two points apart do not need 1011 pt to blend; get it done while the panel's shadow is going |
| Panel shadow underlay | 0 … 0.30 | smoothstep | keep exactly as is — it is correct and its rationale (never shadow a per-frame-changing shape) is sound |
| Scrim over the board | 0 … 1 | linear to ~0.20 alpha | **new**, optional. Material's scrim is what makes the container read as rising above the board. Cheap: one `Color.black.opacity()` rect |

### 6.2 The shared elements — new, and this is the whole fix

Each travels its own path, on the finger, with **no fade at all**. Fading a shared element is
the mistake — it is the same object in two places, and the eye must be allowed to follow it.

| Element | Path | Curve | Mechanism |
|---|---|---|---|
| **Orb** | x centre 196.5 → 688 (+491.5); y **fixed at 198**; size fixed 96×90 | `p`, eased slightly ahead of the container: `easeOutish(p) = 1−(1−p)²` clamped to `[0,1]`, so the tutor's face arrives before the box finishes | one `.offset(x:)` on a single mounted `Orb(.panel)`. Zero relayout. **This single change is what will make the user say it morphs.** |
| **Greeting title + subtitle** | centre +491.5, y fixed (328 and below) | same lead curve as the orb, 40 ms of stagger behind it (implement as `p` remapped to `[0.05, 1]`) | `.offset(x:)` on one instance. Glyphs never change size. |
| **Suggestion chips** | leading x 46 → 388; width 301 → **600**; heights and gaps fixed | width on `p` linear (finger-locked, so the stretch tracks the box); x on the lead curve | real `.frame(width:)` interpolation — 4 rows, each an icon + one `lineLimit(1)` label. Measured cheap. Fallback if it is not: `.scaleEffect(x:anchor:.leading)` with a `1/s` counter-scale on the icon. |
| **Composer pill** | x 46 → 388; width 301 → 600; **bottom 986 → 1004** (+18 y); height fixed 50 | width + y linear on `p`; x on the lead curve | real `.frame(width:)`. Children are fixed-size buttons anchored at both ends around one flexible lane — no text re-wrap. The fade/`ComposerSlot` band travels with it. |
| **Sidebar toggle** | (46, 46) → (28, 28) | linear on `p` | `.offset`. It moves 18 pt in each axis; it must **not** fade, because it exists at both ends. |
| **Panel controls pair** (`btn/dock`, `btn/full-screen`) | unmatched — no counterpart at full screen | opacity `1 → 0` over **0 … 0.25** (Material `FADE_MODE_OUT`), plus a 12 pt trailing drift | this is the *only* element that should vanish early. It is the control the learner just pressed; it leaving immediately is correct. |

The lead curve matters. Material runs content scale across the full progress while the fade is
crammed into the first quarter; the App Store runs position on a spring and size linearly. The
common principle: **content settles before the container does.** Give the shared elements a
slight ease-out lead over the linear, finger-locked container and the transition stops feeling
like a box dragging its cargo.

### 6.3 The thread state — the one real crossfade

When `uiState.conversation == .active`, the greeting elements above are replaced by the thread,
whose bubbles re-wrap between 301 and 600. Do **not** relayout it per frame.

| Copy | Layout | Path | Opacity |
|---|---|---|---|
| Outgoing thread | built once at width 301, x 46 | `.offset(x:)` toward the destination centre: +491.5 on the same lead curve | `1 → 0` over **0.30 … 0.55** |
| Incoming thread | built once at width 600, x 388 | `.offset(x:)` *from* a position 60 pt short of its final x (a small counter-travel, so it arrives rather than appears) | `0 → 1` over **0.30 … 0.60** |

Overlapping (`FADE_MODE_CROSS`), not sequential: the glyph sizes match, so an overlap reads as
the same text re-flowing. A `FADE_MODE_THROUGH` gap would show white. Both are laid out once at
commitment; per frame the cost is two offsets and two opacities.

Do not scale either copy. The ratio is 1.99 and it would be visible mush (§4).

The thread's scroll position must be carried across: capture the outgoing thread's content
offset at commitment and seed the incoming one, or the crossfade will dissolve between two
different parts of the conversation, which no amount of motion design will rescue.

### 6.4 The board

See §8 for the full argument. The change from today:

| Property | Today | Proposed |
|---|---|---|
| Translation | `+1011` (the container's own travel) — carries the card to x 1472, off screen | **`+846`**, so the card's leading edge lands exactly on the peek's leading edge (`peekX = 1331`, `boardX = 485`) |
| Shape | none; the card fades to 0 | clip to a mask that interpolates the card's rounded rect → `BoardPeekShape` over **0.55 … 1** |
| Opacity | fades out 0.60 … 0.90 | **stays at 1**; the peek artwork crossfades over the clipped card's last 15% |
| Resize | never (correct) | never (keep) — `PKCanvasView` takes no layout pass |

The card then reads as sliding under the screen's trailing edge and *becoming* the hinge tab,
rather than exiting stage right while a different object appears where it should have stopped.

### 6.5 The rail and the sidebar

- **Rail**: keep mounted through the morph so the growing container has something real to cover
  (current behaviour is right). Add nothing. It is covered within the first ~2% of the travel
  going up and uncovered in the last 2% coming back.
- **Sidebar**: keep `sidebarShift(at:)` exactly as it is — fold its own width off the leading
  edge over the same `p`, flag untouched. It is already the only content element in the current
  implementation that genuinely travels, and it is the one that reads correctly.

### 6.6 The return leg

`p` runs backwards and every curve above is a pure function of `p`, so the return is free —
with two Material-sanctioned asymmetries worth adopting:

- Corner radius on the return runs **0.30 … 0.90** rather than 0 … 0.75.
- The thread crossfade on the return runs later: **0.45 … 0.70** outgoing, **0.40 … 0.75**
  incoming. (Material's return fade is 0.60 … 0.90 against its 0 … 0.25 enter.) Returning to a
  small surface wants the destination to commit late; expanding wants it early.

Implement as a `direction` parameter on the curve helpers, not as a second set of functions.

### 6.7 Release and settle

Mark the live-finger frames' transactions `isContinuous` — the flag exists for exactly this
case and is not currently set anywhere in the shell.

Otherwise unchanged and correct: velocity-first at 300 pt/s, 50% line second, `DrawerReveal.settle`'s
`interpolatingSpring(stiffness: 320, damping: 30, initialVelocity: v/travel)`, presentation
flipped *inside* the transaction, mounts held until completion. Consider App Store's split: the
container's **position** on the spring and its **size** on a linear/ease-out of the same
duration. Only do this if the single spring reads wrong on device; one curve is simpler and the
existing tests pin it.

---

## 7. Mechanism table

| Element | Technique | Why | Per-frame cost on A10 |
|---|---|---|---|
| Container fill + radius | `Shape` with `animatableData`, one `Path` per frame | must clip; radius must interpolate | one rounded-rect path build + one fill. Cheap. Avoid `.shadow` on it — a shadow re-rasterises its input every frame |
| Container clip of contents | prefer `.mask()` or `.clipShape` with a **plain** `RoundedRectangle` whose frame is animated, over a custom `Path` | a custom `Path` per frame per clipped subtree is the most expensive thing in the current design, and it is applied to two large subtrees | measure; if `clipShape(Path)` shows on the timeline, switch to `.mask(RoundedRectangle().frame(...))` |
| Orb | `.offset(x:)` on one instance | render-tree transform, no layout | ~0 |
| Greeting title/subtitle | `.offset(x:)` on one instance | same | ~0 |
| Chips | `.frame(width:)` interpolation | crisp, correct, nothing re-wraps | 4 rows × (icon + 1 single-line label) layout. Small. |
| Composer pill | `.frame(width:)` + `.offset` | crisp; children are fixed-size + one flexible lane | one HStack layout. Small. |
| Sidebar toggle | `.offset` | 18 pt in each axis | ~0 |
| Panel controls pair | `.opacity` + `.offset` | unmatched element | ~0 |
| Thread (active) | two instances, laid out once, `.offset` + `.opacity` | re-wrap cannot be interpolated; glyph sizes match so a co-located crossfade reads as reflow | two offsets, two opacities. Both subtrees stay mounted and *must not be rebuilt* |
| Board card | `.offset` + animated `.mask` | `PKCanvasView` must never be handed a new size mid-gesture | one offset + one mask path |
| Peek silhouette | `.opacity` | arrival of a distinct artwork | ~0 |
| Sidebar | `.offset` | already correct | ~0 |
| Panel shadow | static-shaped underlay, `.opacity` only | never shadow a shape that changes per frame | ~0 |

**Rule that makes the table hold:** nothing progress-dependent may be passed *into* a stored
slot. The `DrawerRevealLayer` / `DockRevealLayer` discipline — slots arrive as already-built
view values, a gesture frame re-runs only the layer's body and hands the same values back
wearing new modifiers — is the reason those two gestures track on an A10. Every row above
obeys it: the flight copies are values built at commitment, and the per-frame work is modifiers
applied *around* them.

---

## 8. The board side

**Should the board card genuinely resize?** No.

- `PKCanvasView` is a `UIScrollView` subclass. Handing it a new bounds size per frame re-runs
  its own layout, recomputes the content offset and can perturb the visible ink origin; the
  repo already records that a `PKCanvasView` "handed a new size on every touch event stutters
  where a transform does not". On an A10 with real ink on the canvas this is not close.
- Every production system agrees: **transform the content, do not resize it** (§3.5 item 3).

**Does a mask reveal read as "expanding" if the mask edge moves while the canvas stays still?**
Not on its own — and that is the current bug in a sentence. A mask edge sweeping across a
stationary canvas reads as a *wipe*, not as a move. The fix is to move the card **and** the
mask: translate the card so its leading edge lands on the peek's leading edge (`+846`, not
`+1011`), and interpolate the mask from the card's rounded rect to `BoardPeekShape` over the
last 45%. Then the ink translates with the card (motion the eye can follow) while the silhouette
resolves around it (shape the eye can read). Nothing resizes.

**What polished apps do with canvas-like surfaces:** they translate + clip, and they crossfade
to a cheap stand-in near the end. Freeform's sidebar, Notes' markup and PencilKit-hosting apps
all move the canvas as a layer and let the chrome around it change shape. The App Store's own
answer to the same problem is `contentMode = .center` on the card artwork — pin the content and
let the frame change around it, so the pixels never rescale.

**One risk to test:** translating a live `PKCanvasView` by ~850 pt while it is still mounted
keeps it in the render tree at full size. If the timeline shows it, add
`.drawingGroup()`-free hiding at the very end of the travel (`opacity` 0 past `p > 0.98`) —
but do **not** unmount it (the pan, the zoom and the ink contract are lost) and do **not** wrap
it in `drawingGroup()` (it is UIKit-backed).

---

## 9. iPadOS 17 API specifics, constraints and pitfalls



### 9.1 The primitive-by-primitive verdict

| Primitive | iPadOS 17? | Scrubbable by a 0…1 gesture value? | Use here |
|---|---|---|---|
| `matchedGeometryEffect` | yes (iOS 14+) | **No** — see 9.2 | **Do not use.** |
| `.offset` / `.scaleEffect` / `.transformEffect` | yes | **Yes** — write the value every frame | The workhorses. Apple's own wording for all three is "**rendered output**": `offset` "only affects the displayed rendering, not the layout space occupied"; `scaleEffect` "scales this view's rendered output"; `transformEffect` "applies an affine transformation to this view's rendered output". No layout pass. |
| `.frame(width:)` | yes | Yes, but it **does** re-run layout | See the caveat below the table — the one place this brief departs from the received rule |
| `.position(x:y:)` | yes | layout-level placement, not a render transform | Prefer `offset` |
| `geometryGroup()` | **iOS 17.0+** — exactly our floor | n/a | "Isolates the geometry … from its parent view … **A group acts as a barrier … forcing the position and size values to be resolved and animated by the parent, before being passed down to each subview.**" Solves "unglueing", where a child inserted mid-animation snaps to the parent's *final* geometry. **Placement: inside the animating ancestor, outside the children you want locked together** — `.geometryGroup().frame(...)`. Candidate: the flight-copy container. Apple quotes no cost and neither does any write-up; treat "cheap" as unverified and measure. |
| `drawingGroup()` | yes | n/a | **Avoid.** Apple: the result "will not include views whose contents are composited by Core Animation layers … **most types of UIKit and AppKit views**. In those cases, the output displays a **placeholder image**." That is `PKCanvasView` and `TextField`. It also re-rasterises "whenever the content changes" — i.e. every frame here — and makes upscaled text permanently worse. |
| `compositingGroup()` | yes | n/a | Not a variant of the other two: it is purely an effect-ordering boundary (ancestor opacity/blend applies to the group as one unit). Already used correctly on the shadow underlay. |
| `Animatable` / `animatableData` | yes | **Yes — the only first-party way** to get a real 0…1 parameter into SwiftUI | Keep the pattern. Note: `AnimatableModifier` is deprecated since iOS 15; conform `ViewModifier`/`Shape`/`View` to `Animatable` directly, which the current code already does. |
| `Transaction.isContinuous` | yes | n/a | **Not currently used and should be.** Mark the live-finger transactions continuous so SwiftUI can pick gesture-appropriate behaviour. |
| `withAnimation(_:completionCriteria:_:completion:)` | **iOS 17.0+** | n/a | Already used for the settle, with `.removed` — correct, and the docs confirm `.removed` waits for the animation to leave the render tree, which matters for a spring's long tail |
| `UIViewPropertyAnimator.fractionComplete` | yes | Yes | Reaches only **layer-level** properties of a `UIHostingController`'s root view — frame, transform, alpha. It cannot set SwiftUI state or reach inside the render tree. **Hold in reserve.** |
| `UIView.snapshotView(afterScreenUpdates:)` | yes | n/a | "Very efficiently captures the current rendered appearance … faster than trying to render the contents … into a bitmap image yourself." But `afterScreenUpdates: true` forces the pending layout/render to commit first, and the bitmap route (`drawHierarchy`) has been measured at ~50 ms on one view — **three frames**. Never per frame. |

**The `frame` caveat.** The received rule — never animate `frame` per frame — is right in
general and is why the thread must not reflow. It is wrong for the chips and the composer pill
*in this specific app*, and section 2 is the proof: nothing inside them re-wraps, so a width
change costs one HStack/VStack layout of a handful of fixed-size nodes and no text
re-measurement. That is a claim to **verify with Instruments' Long View Body Updates**, not to
take on faith. If it does not hold, the fallback is
`.scaleEffect(x: w(p)/600, anchor: .leading)` on a chip stack laid out at 600 with a `1/s`
counter-scale on each chip's icon — the App Store's own trick, and the reason Material derives
both scales from one master axis.

### 9.2 `matchedGeometryEffect`, specifically

Apple: "the `matchedGeometryEffect()` modifier only arranges for the geometry of the views to
be linked, **not their rendering**", and "if the number of currently-inserted views in the
group with `isSource = true` is not exactly one, **results are undefined**". Implementation-wise
it "will essentially apply a `frame` and an `offset` modifier" driven by anchor preferences —
the non-source view keeps its own layout slot and only *visually* repositions.

It is not scrubbable, and this is stated rather than inferred: objc.io's Swift Talk S01E482
exists precisely because "**we can't directly control the progress of that interpolation**", and
rebuilds a simplified version with an explicit `progress: 0...1` so a gesture can drive it.

Three further reasons it is wrong here:

- **Modifier order is a trap** — applied *after* `.frame(...)`, the inner frame wins and the
  view jumps. It must go on a flexible base view before the frame.
- **Clip contexts.** Interpolation is in *window space*, but each view is still clipped by its
  own ancestors. One of our two copies lives inside the panel's clip inside a
  `DrawerRevealLayer`; the other is in a screen-sized `ZStack`. The morphing layer must live
  above every clip — which is exactly what the flight-layer design in §6.0 provides, and which
  we can have without `matchedGeometryEffect`.
- **Scroll containers.** Ghosting, jumping and `AttributeGraph precondition failure` crashes are
  well attested inside `LazyVStack`/`ScrollView`. Our thread is a scroller.

The objc.io pattern — read the two frames yourself, own the progress, drive `offset`/`frame`
from it — is what this brief recommends, and it is what `PresentationMorph` already does for
the container. The recipe extends it to the contents.

### 9.3 The freeze — hypotheses in priority order

The hang was device-only (iPad 6th gen, iPadOS 17.7), not reproducible in the simulator. That
signature matches a known, already-diagnosed class of bug in this repo.

1. **A responder or keyboard side effect inside the render transaction.** `BoardCanvas.swift`
   already carries the fix for exactly this: `canvas.resignFirstResponder()` called
   synchronously from `updateUIView` re-entered UIKit's keyboard machinery (with a third-party
   keyboard extension loaded) and never returned. The morph mounts and unmounts a surface that
   owns a focused `TextField` inside a `withAnimation` transaction, and both surfaces' composers
   exist at once. **Check first.** Mitigation is in the recipe: resign focus at commitment on a
   `DispatchQueue.main.async` hop, and give the flight composer no live `TextField`.
2. **`PresentationMorphRender` is `Animatable` and is applied to conditionally-mounted slots
   whose mount condition (`morph.isActive`) is written inside the same animated transaction**,
   with `.transition(.opacity)` on top. A freshly inserted view has no previous frame for the
   animatable render to interpolate from — the code comment says so and patches it with a
   transition. This is the documented hazard, not a guess: an `Animatable` conformance's `body`
   runs **every frame** at display refresh rate, mutating state from inside it "can cause
   unpredictable behavior and crashes, as state mutations weren't designed for per-frame
   execution", and `AttributeGraph precondition failure` is the attested crash class when
   animated *structural identity* meets matched/animated geometry. Rule to adopt: **let
   `animatableData` vary geometry only; never let it decide what exists.** Today's layer lets
   `morph.isActive` — written inside the animation — decide six mounts.
   (SwiftLee's completion-callback trick hops `DispatchQueue.main.async` for exactly this
   reason: to avoid "Modifying state during view update" from inside `animatableData`'s setter.)

   Related: `PresentationMorphModel.progress` is `@Published` and written per touch event. The
   repo's own doctrine says a per-frame publisher must be observed by exactly one view; the
   deleted layer honoured that, but it is worth re-checking that no second observer crept in,
   because a `@Published` write invalidates *every* observer of the object.
3. **A custom `Path` `clipShape` per frame over two large subtrees, one containing a UIKit
   representable.** `PresentationMorphClipShape` recomputes a path in *content-local*
   coordinates via `localOrigin`; that clip wraps the whole docked region including the nested
   `DockRevealLayer`. This is the largest per-frame cost in the current design and a plausible
   source of a layout storm rather than a true deadlock.
4. **`PKCanvasView`'s `updateUIView` being reached on every morph frame.** The board slot is a
   stored value, so it should not rebuild — but `BoardScreen` re-running for any reason during
   the gesture would call `updateUIView`, which calls `updateFirstResponder`, which is (1)
   again.

**Protocol to run it down** (from the recorded fix for the previous hang): breadcrumb prints
along the commit path, then
`xcrun devicectl device process launch --console --terminate-existing` to stream device stdout;
the last breadcrumb before silence names the blocking call. The device must be unlocked and on
a cable — a Wi-Fi link drops device services.

### 9.4 Performance rules for the A10

The render server splits into **Render Prepare** (layer tree → GPU commands; animations are
resolved here) and **Render Execute**; either can miss the 16.7 ms deadline. Apple's Tech Talk
*"Demystify and eliminate hitches in the render phase"* names **four** sources of offscreen
passes: **shadows, masks, rounded rectangles, and visual effects (blur/vibrancy)**. Its demo
app goes from 36 offscreen passes to 0 by fixing exactly those. Applied here:

- **A custom `Path` `clipShape` per frame is the worst case on that list** — an arbitrary-path
  clip is a mask, the most expensive of the four, and rebuilding the path re-runs `path(in:)`
  and re-tessellates every frame. The current design applies one to each of two large subtrees.
  Preference order: (1) a plain `RoundedRectangle` clip whose corner radius animates —
  `cornerRadius` is a native `CALayer` property and the cheapest thing available; (2) `.mask`
  with a simple shape; (3) a custom animatable `Path` only where the silhouette genuinely
  cannot be a rounded rect (which is true of `BoardPeekShape`, and of nothing else here).
- **`cornerRadius` and `masksToBounds` are each cheap alone and trigger an offscreen pass
  together.** Keep clipping off any layer whose content cannot exceed its bounds.
- **Shadows must have an explicit path.** UIKit's rule is `layer.shadowPath`; the SwiftUI
  equivalent is `.background(RoundedRectangle(...).shadow(...))` on a *known* shape rather than
  `.shadow()` on arbitrary content, because the latter forces the renderer to rasterise the
  subtree to derive the shadow. The existing static-shaped underlay already obeys this and is
  the single best decision in the current implementation.
- Per-frame work must be proportional to a handful of **transforms**, not to a relayout of a
  subtree. §7's table is the budget.
- No `drawingGroup()`, no `blur` on a moving subtree.
- A `Shape` with `animatableData` builds one `Path` per frame. One is fine; six are not.
- Text: never re-typeset per frame at a *changing* width unless you have proven that nothing
  re-wraps (§2 proves it for the hi state and disproves it for the thread). Where text *must*
  change apparent size, render at the **largest** size and scale **down** — `scaleEffect` does
  not re-rasterise text, it stretches the existing bitmap, so upscaling is visibly fuzzy.
  (Our endpoints share a point size, so we need no scaling at all — this is the rule we get to
  skip.)
- Capture any raster once, at gesture commitment.
- **Detection before belief**: Instruments' Core Animation / Animation Hitches template, the
  Simulator's *Debug ▸ Color Offscreen-Rendered*, the View Debugger's "Show Layers" per-layer
  offscreen count, and Xcode's runtime *Optimization Opportunities*. Xcode's newer *Long View
  Body Updates* instrument flags bodies that blow the frame deadline and profiles an iOS 17
  target fine.
- General SwiftUI hygiene from WWDC23 10160: `let _ = Self._printChanges()` to find out why a
  body ran; extract subviews so each depends on the narrowest possible value. That session
  names string interpolation, bundle lookups, data filtering and heap allocations as the usual
  in-`body` offenders.

---

## 10. What to reuse and what to discard from `PresentationMorph.swift`

### Reuse verbatim

- `PresentationMorphModel` — the `begin`/`track`/`settle` shape, the `isSettling` mount hold,
  the presentation flip inside the transaction. This is the third instance of a pattern that
  works (`DrawerReveal`, `DockReveal`) and it should stay the third instance.
- `travel`, `progress(from:translation:travel:)`, `settlesFullScreen(progress:velocity:)` —
  the gesture arithmetic and the shared release rule.
- `containerFrame(at:)`, `clipFrame(at:)` and the argument for why the clip's far end is the
  **screen** rather than the pane. That reasoning is correct and hard-won.
- `panelShadowOpacity(at:)` and the static-shaped-underlay design.
- `sidebarShift(at:)`.
- `PresentationMorphRender` being `Animatable` so a tap replays the swipe's curves — the
  principle, not the current role set.
- `PresentationMorphTests` — 16 tests of endpoint parity and curve shape. Most survive; the
  crossfade-band tests get new numbers.

### Retune

- `containerRadii(at:)` → finish at 0.75 (enter) / start at 0.30 (return).
- `panelFillOpacity(at:)` → compress to 0 … 0.30.
- `outgoingHoldUntil` / `outgoingGoneBy` / `incomingFrom` / `incomingFullBy` → these four
  constants currently describe a *whole-surface* crossfade. They should survive only as the
  **thread**'s crossfade band (0.30 … 0.55 / 0.30 … 0.60 enter) and be renamed to say so.
- `boardShift(at:)` → `+846`, not `+1011`, plus a mask.

### Discard

- **`PresentationMorphRole.dockedChat` and `.fullScreenChat` as whole-surface roles.** They are
  the crossfade-two-pictures model. Replace with per-element roles: `.orb`, `.greeting`,
  `.chips`, `.composer`, `.toggle`, `.panelControls`, `.thread(outgoing/incoming)`.
- **The clip-the-whole-surface-with-a-custom-`Path` approach** for the two content subtrees.
  Contents that travel need the container's clip only at their edges; a plain animated
  `RoundedRectangle` mask on the flight layer is enough and is far cheaper.
- **The duplicate mounting of shared elements.** Both surfaces keep their own orb, composer and
  greeting at rest; during a morph they must yield them to the flight layer.
- **`PresentationMorphLayer.swift` as written.** It is already deleted. Rewrite it around the
  flight-layer model rather than restoring it.

---

## 11. Suggested order of work

1. **Orb only.** Wire the morph back on with a single shared element: one `Orb(.panel)` in the
   flight layer, `.offset(x:)` from 148.5 to 640, everything else exactly as it is today. This
   is one afternoon and it will settle the question of whether the user's complaint is answered
   by content that travels. It also isolates the freeze: if the hang returns with only an
   `.offset` in flight, the cause is structural (9.3 items 1–2), not cost.
2. **Greeting + chips + composer.** The rest of the hi state. Full crispness, no crossfade.
3. **Retune the container bands** (radius 0.75, fill 0.30, scrim).
4. **The board's `+846` + mask.**
5. **The thread's two-copy crossfade**, with the scroll offset carried across.
6. **Measure on device** with Instruments' Core Animation / SwiftUI templates before adding
   `geometryGroup()` anywhere.

---

## 12. References

**Material**
- MaterialContainerTransform API reference — <https://developer.android.com/reference/com/google/android/material/transition/MaterialContainerTransform>
- `MaterialContainerTransform.java` — <https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/MaterialContainerTransform.java>
- `FitModeEvaluators.java` (the counter-scale) — <https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FitModeEvaluators.java>
- `FadeModeEvaluators.java` (the four fade modes) — <https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FadeModeEvaluators.java>
- `FadeThroughProvider.java` (`FADE_THROUGH_THRESHOLD = 0.35F`) — <https://github.com/material-components/material-components-android/blob/master/lib/java/com/google/android/material/transition/FadeThroughProvider.java>
- `docs/theming/Motion.md` (durations, easing, the M2/M3 conflict) — <https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md>
- The motion system (M2 spec page; JS-rendered, not machine-readable) — <https://m2.material.io/design/motion/the-motion-system.html#container-transform>
- Fade-through timing, restated — <https://medium.com/design-bootcamp/demystifying-the-material-design-expand-and-cross-fade-effect-67787306630c>

**UIKit transitions**
- WWDC 2017 session 230, *Advanced Animations with UIKit* (pausing linearises the curve; springs restart from presentation values; the six-animator morph) — <https://nonstrict.eu/wwdcindex/wwdc2017/230/>
- `UIViewPropertyAnimator` — <https://developer.apple.com/documentation/uikit/uiviewpropertyanimator>
- `snapshotView(afterScreenUpdates:)` — <https://developer.apple.com/documentation/uikit/uiview/1622531-snapshotview>
- `resizableSnapshotView(from:afterScreenUpdates:withCapInsets:)` — <https://developer.apple.com/documentation/uikit/uiview/1622518-resizablesnapshotview>
- Apple *PhotoTransitioning* sample (interruptible interactive zoom) — <https://developer.apple.com/library/archive/samplecode/PhotoTransitioning/Introduction/Intro.html>
- *Customizing the Transition Animations*, View Controller Programming Guide — <https://developer.apple.com/library/archive/featuredarticles/ViewControllerPGforiPhoneOS/CustomizingtheTransitionAnimations.html>

**App Store card → detail**
- aunnnn / AppStoreiOS11InteractiveTransition — <https://github.com/aunnnn/AppStoreiOS11InteractiveTransition>
- *Making the App Store iOS 11 Custom Transition, Part 1* (spring on position, linear on size; locked font size × scale) — <https://medium.com/@aunnnn/making-app-store-today-ios-11-custom-transition-part-1-presentation-9e4ef99e75d3>
- appssemble / appstore-card-transition — <https://github.com/appssemble/appstore-card-transition>
- Zalando Engineering, *Custom Navigational Transitions in iOS* (why snapshots pixelate text) — <https://engineering.zalando.com/posts/2024/07/custom-navigational-transitions-ios.html>

**iOS 18 `.zoom` — the target feel, for reference only**
- WWDC24 session 10145, *Enhance your UI animations and transitions* — <https://developer.apple.com/videos/play/wwdc2024/10145/>
- `UIZoomTransitionOptions.alignmentRectProvider` — <https://developer.apple.com/documentation/uikit/uiviewcontroller/transition/zoomoptions/alignmentrectprovider>
- `interactiveDismissShouldBegin` — <https://developer.apple.com/documentation/uikit/uiviewcontroller/transition/zoomoptions/interactivedismissshouldbegin>
- Douglas Hill, *Zoom transitions* (the aspect-ratio ghost; no SwiftUI equivalent of the alignment rect) — <https://douglashill.co/zoom-transitions/>

**SwiftUI primitives (iPadOS 17)**
- `matchedGeometryEffect(id:in:properties:anchor:isSource:)` — <https://developer.apple.com/documentation/swiftui/view/matchedgeometryeffect(id:in:properties:anchor:issource:)>
- Chris Eidhof, *Matched Geometry Effect* (it is a frame + offset; the modifier-order trap) — <https://chris.eidhof.nl/post/matched-geometry-effect/>
- SwiftUI Lab, matchedGeometryEffect [part 1](https://swiftui-lab.com/matchedgeometryeffect-part1/) / [part 2](https://swiftui-lab.com/matchedgeometryeffect-part2/) (the two modes; "matched views don't actually remove themselves … they only visually reposition")
- objc.io Swift Talk **S01E482, *Interpolating Matched Geometry Effect*** — "we can't directly control the progress of that interpolation" — <https://talk.objc.io/episodes/S01E482-interpolating-matched-geometry-effect> (see also [S01E257](https://talk.objc.io/episodes/S01E257-matched-geometry-effect-part-1), [S01E483 corner radius](https://talk.objc.io/episodes/S01E483-matched-geometry-and-corner-radius))
- Shadowfacts, *A SwiftUI Hero Transition* (namespaces do not cross a hosting-controller boundary; the two-engine split) — <https://shadowfacts.net/2023/swiftui-hero-transition/>
- Apple Forums, matchedGeometryEffect in `LazyVStack`/`ScrollView`: [800969](https://developer.apple.com/forums/thread/800969), [681038](https://developer.apple.com/forums/thread/681038), [685461](https://developer.apple.com/forums/thread/685461), [744021](https://developer.apple.com/forums/thread/744021), [756174](https://developer.apple.com/forums/thread/756174)
- `geometryGroup()` — <https://developer.apple.com/documentation/swiftui/view/geometrygroup()>
- fatbobman, *Mastering geometryGroup* (the unglueing case; placement) — <https://fatbobman.com/en/posts/mastring-geometrygroup/>
- Nil Coalescing, *Geometry, compositing and drawing groups in SwiftUI* (the three are not variants of one tool) — <https://nilcoalescing.com/blog/GeometryCompositingAndDrawingGroupsInSwiftUI/>
- `drawingGroup(opaque:colorMode:)` (the "placeholder image" rule for UIKit-backed views) — <https://developer.apple.com/documentation/swiftui/view/drawinggroup(opaque:colormode:)>
- `compositingGroup()` — <https://developer.apple.com/documentation/swiftui/view/compositinggroup()>
- `offset(x:y:)` — <https://developer.apple.com/documentation/swiftui/view/offset(x:y:)> · `scaleEffect(_:anchor:)` — <https://developer.apple.com/documentation/swiftui/view/scaleeffect(_:anchor:)> · `transformEffect(_:)` — <https://developer.apple.com/documentation/swiftui/view/transformeffect(_:)>
- Hacking with Swift, *How to scale a view up or down* — scaleEffect "won't cause it to be redrawn at its new size, only stretched" — <https://www.hackingwithswift.com/quick-start/swiftui/how-to-scale-a-view-up-or-down>
- *Animate text size change in SwiftUI* (font size is not `Animatable`; the render-large-scale-down workaround) — <https://swdevnotes.com/swift/2021/animate-text-size-change-in-swiftui/>
- SwiftUI Lab, *Advanced SwiftUI Animations part 3* (`AnimatableModifier` deprecated; body runs every frame; state mutation inside is unsafe) — <https://swiftui-lab.com/swiftui-animations-part3/>
- fatbobman, *The animation mechanism of SwiftUI* (`animatableData` set at display refresh rate; `Transaction.isContinuous`) — <https://fatbobman.com/en/posts/the_animation_mechanism_of_swiftui/>
- SwiftLee, *withAnimation completion callback* (the `DispatchQueue.main.async` hop out of `animatableData`) — <https://www.avanderlee.com/swiftui/withanimation-completion-callback/>
- Majid, *AnimatableModifier in SwiftUI* — <https://swiftwithmajid.com/2021/01/11/animatablemodifier-in-swiftui/>
- `withAnimation(_:completionCriteria:_:completion:)` (iOS 17+) — <https://developer.apple.com/documentation/swiftui/withanimation(_:completioncriteria:_:completion:)>
- `UIPercentDrivenInteractiveTransition` — <https://developer.apple.com/documentation/uikit/uipercentdriveninteractivetransition>
- `snapshotView(afterScreenUpdates:)` (efficiency claim; cannot reflect in-progress animations) — <https://developer.apple.com/documentation/uikit/uiview/snapshotview(afterscreenupdates:)>
- Snapshot cost measurement (~50 ms `drawViewHierarchyInRect:afterScreenUpdates:YES`) — <https://coderwall.com/p/56wcfq/fast-snapshot-any-views-on-ios-7>

**Performance**
- Apple Tech Talk, *Demystify and eliminate hitches in the render phase* (Render Prepare/Execute; the four offscreen-pass sources; `shadowPath`; `cornerCurve`; `masksToBounds`; 36 → 0) — <https://developer.apple.com/videos/play/tech-talks/10857/>
- WWDC23 session 10160, *Demystify SwiftUI performance* — <https://developer.apple.com/videos/play/wwdc2023/10160/> ([notes](https://wwdcnotes.com/documentation/wwdcnotes/wwdc23-10160-demystify-swiftui-performance/))
- WWDC25 session 306, *Optimize SwiftUI performance with Instruments* (Long View Body Updates; profiles an iOS 17 target) — <https://developer.apple.com/videos/play/wwdc2025/306/>
- `cornerRadius` + `masksToBounds` combining into an offscreen pass — <https://onmyway133.com/posts/how-to-set-corner-radius-in-ios/>

**Claims flagged as unverified by the research pass** (do not build a decision on these alone):
`geometryGroup()`'s runtime cost (no source quotes one); `drawingGroup()` breaking
accessibility specifically; `PKCanvasView` placeholder behaviour under `drawingGroup()` (it
follows from Apple's UIKit-view rule but no PencilKit-specific source states it); the
Core Animation `contentsScale` mechanism behind blurry scaled text; the fan-out cost of a
`@Published` per-frame progress; and the clip-shape ordering preference in §9.4, which is
grounded in the Tech Talk's mask guidance but is not stated there for SwiftUI.

**In this repo**
- `MathTutor/DesignSystem/Components/Shell/PresentationMorph.swift`
- `MathTutor/DesignSystem/Components/Shell/DrawerRevealLayer.swift`, `DockRevealLayer.swift` (the stored-slot discipline)
- `MathTutor/DesignSystem/Layout.swift` (`ScreenLayout`, `TutorColumnMetrics` lives in `TutorFullScreen.swift`)
- `MathTutor/DesignSystem/Components/Chat/ChatScale.swift`, `GreetingBlock.swift`, `SuggestionChip.swift`, `Composer.swift`
- `MathTutor/Features/Board/BoardCanvas.swift` (`Coordinator.updateFirstResponder` — the responder-hop precedent)
- `docs/design-system/02-shell-components.md` §15, §15.4
