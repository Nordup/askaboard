# 05 — Screens

The four live product screens, extracted from the Paper file
*"AI Whiteboard Tutor — Design System, Components & Page"*.

| Screen | Artboard name | Size |
|---|---|---|
| 05 | Board + Tutor (no chrome) | 1376 × 1032 |
| 06 | Board + Tutor collapsed | 1376 × 1032 |
| 07 | Tutor · full screen | 1376 × 1032 |
| 08 | Tutor · in conversation | 1376 × 1032 |

Target device: iPad Pro 13" landscape, 1376 × 1032 pt.

> **The composer pill came down a step**, and every number derived from it moved
> with it. 58 → **50** in the panel, 80 → **68** full-screen; paddings 20/8 →
> **18/6** and 32/12 → **28/8**; gap 12 → **10** and 18 → **16**; `btn/send`
> 42 → **38** and 56 → **52**; `btn/voice` 38 → **34** and 52 → **46**; the
> attached-selection card 67 → **63** with its top radius 29 → **25**; the
> attached composer 96 → **88**. The **glyphs did not move** — 20, 22 and 26
> are what `04-icons.md` publishes and the boxes shrank around them. Every
> composer number in this file is at the current pill.
>
> Two things reached these screens after this file was written and are recorded
> here only where the row arithmetic needs them: a leading **`ui/plus`** in both
> composers (specified on board **03b — Components · Attachments**, which has no
> transcription file), and the panel's **top and bottom scroll fades** replacing
> the thread's single internal fade. `03-chat-components.md` §2 and §7 still
> draw the 58 pt-era card and buttons and are flagged there as stale.

## How to read the numbers in this document

- **All coordinates are frame-relative** — i.e. `worldX/worldY` minus the artboard
  origin, which is identical to the `x`/`y` reported by the design tool for
  every top-level region (all four artboards place their children with
  `position: absolute`). Origin is the top-left of the 1376 × 1032 frame.
- Every value below comes from `get_computed_styles` / `get_node_info` /
  `get_jsx`. **Nothing was read off a screenshot.**
- **Fractional values are deliberate.** The tool rail is hand-tuned and is
  *not* on the 4 pt scale. `627.5`, `226.5`, `1.5`, `3.5`, `11.5`, `19.5`
  are correct as written. Do not round them.
- Token names refer to the token set defined in the design file; the values
  used in this document are quoted inline where useful.

### Tokens referenced in this document

```
--color-ink            #0C0E17     --color-surface          #FFFFFF
--color-ink-secondary  #62636E     --color-surface-screen   #F8F8F8
--color-ink-tertiary   #A0A1AA     --color-surface-canvas   #FAFAFA
--color-icon           #55565A     --color-surface-panel    #FCFCFC
--color-divider        #EFEFEF     --color-surface-bubble   #F2F2F6
--color-brand          #6051DC     --color-brand-tint       #E6E3F9
--color-shadow         #141432     --color-brand-tint-soft  #F1F0FB
--color-pen-black #0A0A0A  --color-pen-violet #6051DC  --color-pen-blue #0155FB
--color-pen-green #40A365  --color-pen-red   #E33E38

--font-sans  Source Sans 3
--radius-lg 14  --radius-xl 16  --radius-2xl 20  --radius-3xl 28
--radius-bubble 18  --radius-full 9999

--space-edge 28  --space-gap 24  --space-panel-inset 18  --space-message-gap 22
--spacing-10 40  --spacing-2 8

--container-rail 72  --container-panel 337  --container-panel-content 301
--container-column 740  --container-screen 1376
```

Shadow recipes used repeatedly (literal, not tokenised):

| Name in this doc | Value |
|---|---|
| `shadow/card` | `#1414320D 0 2px 6px, #14143208 0 1px 2px` |
| `shadow/panel` | `#1414320E 0 3px 10px, #1414320A 0 1px 3px` |
| `shadow/canvas` | `#14143209 0 2px 6px` |

---

## Shared shell (identical across all four screens)

### Status bar

Present, pixel-identical, on all four screens.

| Property | Value |
|---|---|
| Position | `x = 0`, `y = 16` |
| Size | `1376 × 24` |
| Background | none (transparent over the screen fill) |
| Layout | `position: relative` container; both groups absolutely positioned inside it |

| Group | Position (within status bar) | Contents |
|---|---|---|
| Left | `left: 30`, `top: 0`, `display:flex`, `gap: 12`, size `134 × 20` | Text `9:41 AM`, Text `Tue May 21` |
| Right | `left: 1251`, `top: 0`, `display:flex`, `gap: var(--spacing-2)` = 8, size `101 × 20` | Wi-Fi glyph `22 × 20`, Text `100%`, battery glyph `27 × 14` |

Right group right edge = `1251 + 101 = 1352`, i.e. 24 pt from the screen edge.

Status-bar text style: `--font-sans`, `15px / 20px`, weight `600`,
colour `--color-ink`. Glyph strokes also `--color-ink`.

> The status bar is **drawn in the design** (a mock iPadOS status bar), sitting
> at `y = 16` rather than at `y = 0`. See open questions.

### Screen background

| Screen | Fill |
|---|---|
| 05 | `--color-surface-screen` (#F8F8F8) |
| 06 | `--color-surface-screen` (#F8F8F8) |
| 07 | **`--color-surface`** (#FFFFFF) |
| 08 | `--color-surface-screen` (#F8F8F8) |

Screen 07 is the only one on pure white. All four artboards use `overflow: clip`.

### Tool rail (screens 05, 06, 08 — absent on 07)

The rail is byte-identical on all three screens that show it. It is a
component; see the components doc in `docs/design-system/`. Its geometry is
repeated here because it is hand-tuned and off-grid.

| Property | Value |
|---|---|
| Position | `x = 28`, `y = 28` |
| Size | `72 × 627.5` (height is `fit-content`) |
| Radius | `--radius-2xl` (20) |
| Background | `--color-surface-panel` |
| Shadow | `shadow/panel` |
| Layout | `flex column`, `align-items: center`, **`padding-block: 9`**, **`gap: 0`** |

Internal stack, in order (all offsets are `y` within the rail):

| Child | y | Size | Spacing rule |
|---|---|---|---|
| `Tools` frame | 9 | `54 × 226.5` | flex column, `align-items:center`, **`gap: 3.5`** |
| `Divider` | 247 | `46 × 1.5` | `margin-top: 11.5`; fill `--color-divider` |
| `Swatches` | 268 | `27 × 243` | `margin-top: 19.5`; flex column, **`gap: 27`** |
| `Thickness` | 540 | `36 × 5` | `margin-top: 29`; radius `2.5`; fill `--color-pen-black` |
| `tool/center` | 564.5 | `54 × 54` | `margin-top: 19.5` |

Arithmetic check: `9 + 226.5 + 11.5 + 1.5 + 19.5 + 243 + 29 + 5 + 19.5 + 54 + 9 = 627.5`. ✔

`Tools` children (each `54 × 54`, icon `28 × 28`, pitch `57.5`):

| Slot | y within `Tools` | y within rail | State |
|---|---|---|---|
| `tool/pen · selected` | 0 | 9 | radius `--radius-lg`, background `--color-brand-tint` |
| `tool/highlighter` | 57.5 | 66.5 | no background |
| `tool/eraser` | 115 | 124 | no background |
| `tool/lasso` | 172.5 | 181.5 | no background |

`Swatches` children — five `27 × 27` circles, pitch `54` (27 swatch + 27 gap):

| # | y within rail | Fill |
|---|---|---|
| 1 | 268 | `--color-pen-black` |
| 2 | 322 | `--color-pen-violet` |
| 3 | 376 | `--color-pen-blue` |
| 4 | 430 | `--color-pen-green` |
| 5 | 484 | `--color-pen-red` |

`tool/center` icon is a crosshair (`26 × 26`): circle r≈7.5, cross path, centre dot.

**Verified rail height per screen** (`get_node_info`):

| Screen | Tool rail height |
|---|---|
| 05 | **627.5** |
| 06 | **627.5** |
| 08 | **627.5** |
| 07 | n/a (no rail) |

No regression: none of the three rails has collapsed to 617 or snapped to
the 4 pt scale.

### Whiteboard canvas (screens 05, 06, 08)

| Property | Value |
|---|---|
| Position | `x = 124`, `y = 28` |
| Size | `863 × 976` (screens 05, 08) / `1224 × 976` (screen 06) |
| Radius | `--radius-3xl` (28) |
| Background | `--color-surface-canvas` |
| Shadow | `shadow/canvas` |
| Overflow | `clip` |

Canvas layers (absolute, within the canvas):

| Layer | Position | Size | Notes |
|---|---|---|---|
| `Dot grid` | `0, 0` | fills the canvas | background-image, exported SVG asset, `background-size: round(100%, 0.5px)`, `background-position: 50%`, no-repeat |
| `Handwritten ink` | `157, 147` (05, 08) / `338, 147` (06) | `548 × 641` | sample board content only—not typography, chrome, or a visual-style direction; background-image, exported SVG asset (the same asset in all three screens) |

The ink block is horizontally centred in the canvas in screen 06
(`(1224 − 548) / 2 = 338`); in 05/08 it sits at `157` (canvas centre would be
`157.5`).

Dot-grid appearance can be read exactly only from the `Board peek` strip on
screen 07, which draws the grid as vector geometry: dots are `r = 1.4`
(2.8 pt diameter), fill `#F1F1F1`, x-pitch `23.9`, y-pitch `24.5`.

### Layout rhythm shared by 05 / 06 / 08

```
28  rail left margin                 (--space-edge)
72  rail width                       (--container-rail)
24  gap rail → canvas                (--space-gap)
…   canvas
24  gap canvas → tutor panel         (--space-gap)  [screen 05 / 08 only]
28  right margin                     (--space-edge)
```

- 05 / 08: `28 + 72 + 24 + 863 + 24 + 337 + 28 = 1376` ✔
- 06: `28 + 72 + 24 + 1224 + 28 = 1376` ✔
- Vertically: content band is `y = 28 … 1004` (976 tall) on every screen,
  leaving a 28 pt bottom margin.

---

## Screen 05 — Board + Tutor (no chrome)

### Purpose / app state

The default working state. The student has the infinite board open with a
docked tutor panel on the right. The tutor has **not** been engaged yet — the
panel shows the greeting + suggestion chips ("start state"). A board selection
has already been made and is attached to the composer, waiting to be sent.

### Region map

| Region | Kind | x | y | w | h | Fill |
|---|---|---|---|---|---|---|
| Screen | — | 0 | 0 | 1376 | 1032 | `--color-surface-screen` |
| Status bar | absolute overlay | 0 | 16 | 1376 | 24 | none |
| Whiteboard canvas | absolute | 124 | 28 | 863 | 976 | `--color-surface-canvas` |
| Tool rail | absolute | 28 | 28 | 72 | **627.5** | `--color-surface-panel` |
| Tutor chat panel | absolute | 1011 | 28 | 337 | 976 | `--color-surface-panel` |

Every top-level region is a fixed-position overlay on the frame; none is in
document flow. Internal content of the rail and the panel is in flow
(flex column).

**Z-order** (back → front): Status bar → Whiteboard canvas → Tool rail →
Tutor chat panel. No region actually overlaps another on this screen, so
z-order is not load-bearing here.

### Tutor chat panel — internals

| Property | Value |
|---|---|
| Size | `337 × 976` |
| Radius | `--radius-3xl` (28) |
| Background | `--color-surface-panel` |
| Shadow | `shadow/panel` |
| Layout | `flex column`, `align-items: center`, `padding-block: 18` (= `--space-panel-inset`) |
| Content width | `301` (= `--container-panel-content`) → 18 pt inset each side |

Stack (y within the panel). **Every child is `position: absolute` now** — the
panel no longer flows them, so the margins this file used to record are gone
and the `y` values below are the placements themselves:

| # | Child | y | Size | x |
|---|---|---|---|---|
| 1 | `Scroll fade · top` | 0 | `337 × 80` | 0 — overlay, full panel width |
| 2 | `Panel controls` | 18 | `301 × 32` | 18 |
| 3 | `Orb` | 170 | `96 × 90` | 120.5 |
| 4 | `Start state` | 300 | `301 × 530` | 18 |
| 5 | `Composer` | **870** | **`301 × 88`** | 18 |
| 6 | `Scroll fade · bottom` | **908** | `337 × 68` | 0 — overlay, full panel width |

Content bottom = `870 + 88 = 958`; the panel is 976 tall, so **18 pt of slack
remains at the bottom**. Implement the composer as bottom-anchored with an
18 pt bottom inset — that reproduces the design exactly and is more robust
than reproducing the flex slack.

The bottom fade's **68** is the composer band: pill `50` + the 18 pt inset
under it, so it covers exactly what the composer occupies. It spans the full
`337`, not the `301` content column, and carries the panel's bottom corner
radii. **The two fades are not transcribed in detail here** — this file
predates them, as does §6 of `03-chat-components.md`, which still documents a
single `301 × 72` fade inside the thread.

#### 1. Panel controls (`301 × 32`, `flex row`, `gap: 14`, `justify-content: flex-end`)

| Button | Size | Icon |
|---|---|---|
| `btn/full-screen` | `32 × 32` | 28 × 28: rounded rect `x3.5 y5.5 w21 h17 rx5`, no divider. Stroke `--color-icon`, width 2. |
| `btn/dock` | `32 × 32` | 28 × 28: rounded rect `x3.5 y5.5 w21 h17 rx5` + vertical line at `x = 11.2` → a "left sidebar" glyph. Stroke `--color-icon`, width 2. |

Neither button carries a selected/pressed background in this design.

**The row holds these two and nothing else.** It briefly also held board 15a's
session-title dropdown in the middle lane and `btn/settings` at the leading
edge. Board 17 (`note/17 — header after`) takes both out: *"The session title
dropdown and the settings gear leave the header. The drawer owns both. Only the
full-screen and minimize pair stays."* The row justifies to `flex-end` and the
pair reads full-screen, then dock. See §14 of `02-shell-components.md` for what
took them.

#### 2. Orb (`96 × 90`, centred; `x = 120.5` within the panel)

- `Halo`: absolute `-47, -49`, `190 × 180`, three layered oklab radial gradients
  (violet/blue bloom), no clipping.
- `Orb body`: `54 × 42`, `border-radius: 9999`, `padding-top: 5`,
  `gap: 18`, linear gradient `oklab(25.4% …) → oklab(13% …)` at 180°.
- Two eyes: `7 × 7` white circles. **No smile in the panel-size orb.**

#### 3. Start state (`301 × 530` — verified)

`flex column`, `align-items: center`, `padding-bottom: 128`.

| Element | Style | Copy |
|---|---|---|
| Title | `301` wide, centred, 26 / 34, weight 600, tracking `-0.01em`, `--color-ink` | `Hi! I'm your AI Tutor` |
| Subtitle | `277` wide, centred, 17 / 24, weight 400, `--color-ink-secondary`, `margin-top: 10` | `I'm here to help you learn, practice and achieve your goals.` |
| `Suggestions` | `301` wide, flex column, `gap: 10`, `margin-top: 32`, height `278` | four chips |

Height check: `34 + 10 + 48 + 32 + 278 + 128 = 530`. ✔

Suggestion chips — four identical `chip/*` instances, `301 × 62`:
`align-items: center`, `padding-left: 18`, `gap: 14`,
`border-radius: --radius-lg`, background `--color-surface`, `shadow/card`.
Icon `22 × 22` (viewBox 24), stroke `--color-brand`, stroke-width 2.18.
Label 17 / 22, weight 500, `--color-ink`.

| Chip | y within `Suggestions` | Label | Icon |
|---|---|---|---|
| `chip/explain` | 0 | `Explain this concept` | lightbulb |
| `chip/example` | 72 | `Give me an example` | double sparkle |
| `chip/exercise` | 144 | `Create an exercise` | pencil-on-square |
| `chip/confused` | 216 | `I don't understand this` | question-mark circle |

#### 4. Composer (`301 × 88`, `position: relative`; two absolutely-positioned layers)

| Layer | Position | Size | Style |
|---|---|---|---|
| `Attached context` | `0, 0` | **`301 × 63`** | background `--color-brand-tint-soft`, top radii **`25 / 25`** (bottom square), `padding-left: 20`, `padding-right: 16`, `align-items: flex-start` |
| `Input` | `0, 38` | **`301 × 50`** | background `--color-surface`, `border-radius: 9999`, `shadow/card`, `padding-left: 18`, `padding-right: 6`, `gap: 10`, `align-items: center` |

The attached-context strip is 63 tall but the input is placed at `y = 38`, so
**25** pt of the strip is hidden behind the input pill — it reads as a tab
growing out from behind the composer. The 25 is the pill's own corner radius
(`50 ÷ 2`), which is the whole point of the number: the strip has to reach past
the pill's top curves or the panel shows through at both corners. Board 03's
§2 still states this rule at the 58pt pill (29 / 67) and is stale; **63 / 25 is
what this screen and screen 15a draw.**

Attached context inner row: `265 × 38`, `padding-inline: 3`, `padding-top: 6`,
`justify-content: space-between`.
- Label `Selection attached` — 15 / 18, weight 600, `--color-brand`.
- Dismiss `✕` glyph `14 × 14`, stroke `--color-brand`, width 2.

Input row children (computed from padding/gap; widths are exact):

| Child | x within input | Size | Notes |
|---|---|---|---|
| `ui/plus` | 18 | `20 × 20` | **new** — the attach affordance. Stroke `--color-icon`, *not* brand. Specified on board 03b, which has no transcription file yet |
| Selection glyph | 48 | `24 × 24` | dashed rounded square, `stroke-dasharray 4.6 3.9`, stroke `--color-brand`, width 2 |
| Placeholder text | 82 | **`121 × 22`** | `Ask anything...` — 17 / 22, `--color-ink-tertiary`, `flex-grow: 1` |
| `btn/voice` | 213 | **`34 × 34`** | mic glyph `20 × 20`, stroke `--color-icon`, width 2.4 |
| `btn/send` | 257 | **`38 × 38`** | filled circle `--color-brand`, up-arrow glyph `22 × 22` stroke `#FFFFFF` |

The row closes exactly:
`301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0`.
Without the plus — the row the Swift `ComposerMetrics.panel` currently builds —
the lane is `151` and everything else is unchanged.

### All literal copy on screen 05

```
9:41 AM
Tue May 21
100%
Hi! I'm your AI Tutor
I'm here to help you learn, practice and achieve your goals.
Explain this concept
Give me an example
Create an exercise
I don't understand this
Selection attached
Ask anything...
```

Board ink (an SVG asset, not live text): "Vector v⃗ in 2D", axes labelled
`y`, `x`, `0`, point label `(x, y)`, and `v⃗ = [x  y]` as a column vector.

---

## Screen 06 — Board + Tutor collapsed

### Purpose / app state

Full-attention drawing mode. The tutor panel is dismissed to a small floating
dock in the bottom-right of the board, and the canvas expands to the full
content width. Same board content, same tools, same tool state.

### Region map

| Region | Kind | x | y | w | h | Fill |
|---|---|---|---|---|---|---|
| Screen | — | 0 | 0 | 1376 | 1032 | `--color-surface-screen` |
| Status bar | absolute overlay | 0 | 16 | 1376 | 24 | none |
| Tool rail | absolute | 28 | 28 | 72 | **627.5** | `--color-surface-panel` |
| Whiteboard canvas | absolute | 124 | 28 | **1224** | 976 | `--color-surface-canvas` |
| `Tutor dock · collapsed` | absolute overlay | **1192** | **916** | **132** | **64** | none (children carry their own fills) |

**Z-order** (back → front): Status bar → Tool rail → Whiteboard canvas →
Tutor dock. The dock is the only true overlay: it floats **on top of** the
canvas card.

Dock placement relative to the canvas: right edge `1192 + 132 = 1324`, which
is `1348 − 1324 = 24` from the canvas right edge; bottom `916 + 64 = 980`,
which is `1004 − 980 = 24` from the canvas bottom. So the dock is inset
`--space-gap` (24) from the canvas's bottom-right corner.

### Tutor dock — internals

`flex row`, `align-items: center`, `gap: 16`, height `64`, width `132`
(`52 + 16 + 64`).

| Child | x within dock | Size | Style |
|---|---|---|---|
| `btn/select` | 0 | `52 × 52` | background `--color-surface`, `border-radius: 9999`, `shadow/card`. Icon `24 × 24`: rounded rect `rx 4`, **dashed** (`stroke-dasharray 4.6 3.9`), stroke `--color-icon`, width 2. Vertically centred (`y = 6`). |
| `btn/orb` | 68 | `64 × 64` | no card; `Halo` absolute `-33, -32`, `130 × 128` (same gradient recipe as the panel orb); `Orb body` `44 × 34`, radius 9999, `padding-top: 4`, `gap: 14`, two `5.5 × 5.5` white eyes. **No smile.** |

The dashed-square `btn/select` icon is the same glyph used in screen 05's
composer as the "selection attached" marker — it is the board-selection /
hand-off tool.

### All literal copy on screen 06

```
9:41 AM
Tue May 21
100%
```

Plus the same board-ink SVG as screen 05 (repositioned to `x = 338`).
There is **no** text in the collapsed dock.

---

## Screen 07 — Tutor · full screen

### Purpose / app state

The tutor takes over the whole screen. The board is reduced to a 68 pt peek
strip along the left edge that acts as the way back. The tutor is in its
**start state** (greeting + suggestion chips + empty composer) — the same
conversational state as screen 05, but at full-screen typographic scale.
The tool rail is not present at all.

### Region map

| Region | Kind | x | y | w | h | Fill |
|---|---|---|---|---|---|---|
| Screen | — | 0 | 0 | 1376 | 1032 | **`--color-surface`** (#FFFFFF) |
| Status bar | absolute overlay | 0 | 16 | 1376 | 24 | none |
| `Panel controls` | absolute | **352** | 68 | **996** | 32 | none — settings-only variant, added 2026-08-07 |
| `Greeting block` | absolute | **352** | 150 | **740** | **268** | none |
| `Suggestion grid` | absolute | **352** | 592 | **740** | 168 | none |
| `Composer · wide` | absolute | **352** | **936** | **740** | **68** | `--color-surface` |
| `Board peek` | absolute overlay | 0 | 28 | 68 | 976 | see below |

**Verified:** the content column is `740` wide at `x = 352`. ✔
`740` is `--container-column`.

The column is **not** centred on the screen — it is centred in the area to the
right of the board peek: `(1376 − 68 − 740) / 2 = 284`, so
`left = 68 + 284 = 352`, `right = 284`. Implement it as: reserve the 68 pt
peek, centre a 740 pt column in the remainder.

### No panel controls, and no gear

This screen draws **no** chrome. `btn/dock` and `btn/full-screen` are absent —
the board peek is the way back, and a full-screen button is a control for the
state you are already in.

It carried a settings-only row for a while: `996 × 32 at (352, 28)`,
`justify-content: flex-end`, one `btn/settings` landing on x 1316. Board 19
removes it. The gear is in the sessions drawer now, which is reachable from
this screen by the same right-swipe the docked panel takes, so Settings is
still one gesture and one tap away from the greeting — which is the gap the
gear was added to close. See §14 of `02-shell-components.md`.

One consequence in code: `TutorColumnMetrics.columnTop` used to give the column
up one 32 pt control band on any window narrow enough for the column's leading
edge to reach the gear — every portrait iPad. With no gear in the corner there
is nothing to give way to, and the narrow-window column gets those 32 points
back.

Vertical rhythm of the column:

```
150  greeting top
418  greeting bottom      (150 + 268)
174  gap
592  suggestion grid top
760  suggestion grid bottom (592 + 168)
176  gap
936  composer top
1004 composer bottom       (matches the 1004 content-band bottom of 05/06/08)
```

The composer bottom is the fixed end of that column: when the pill came down
80 → 68 its **top** moved 924 → 936 and the gap above it absorbed the 12.

**Z-order** (back → front): Status bar → Greeting block → Suggestion grid →
Composer → **Board peek** → Panel controls. The board peek is painted over the
column and is the only overlapping region; the controls row sits in the top-right
corner where nothing else reaches.

### Greeting block (`740 × 268` — verified)

`flex column`, `align-items: center`, height is `fit-content`.

| Element | y within block | Size | Style | Copy |
|---|---|---|---|---|
| `Orb · hero` | 0 | `150 × 142` | see below | — |
| Title | 176 | `335 × 48` | 40 / 48, weight 600, tracking `-0.01em`, `--color-ink`, `margin-top: 34` | `Hi! I'm your AI Tutor` |
| Subtitle | 238 | `512 × 30` | 21 / 30, weight 400, `--color-ink-secondary`, `margin-top: 14` | `I'm here to help you learn, practice and achieve your goals.` |

Height check: `142 + 34 + 48 + 14 + 30 = 268`. ✔

`Orb · hero` internals (this is the only orb variant with a mouth):

| Part | Position | Size | Style |
|---|---|---|---|
| `Halo` | absolute `-73, -77` | `296 × 282` | same three-layer oklab radial-gradient recipe as the other orbs |
| `Orb body` | centred | `84 × 66` | radius 9999, linear gradient `oklab(25.4%…) → oklab(13%…)` 180° |
| Eye L | `20, 22` within body | `11 × 11` | white circle |
| Eye R | `53, 22` within body | `11 × 11` | white circle |
| `Smile` | `33, 40` within body | SVG `18 × 10` | path `M1.6 1.6C4 6.4 14 6.4 16.4 1.6`, stroke `#FFFFFF`, width 2.4, round caps |

### Suggestion grid (`740 × 168`)

`display: flex`, `flex-wrap: wrap`, `gap: 20`, so a 2 × 2 grid of `360 × 74`
chips (`360 + 20 + 360 = 740`; `74 + 20 + 74 = 168`).

| Chip | x, y within grid | Label |
|---|---|---|
| `chip/explain` | `0, 0` | `Explain this concept` |
| `chip/example` | `380, 0` | `Give me an example` |
| `chip/exercise` | `0, 94` | `Create an exercise` |
| `chip/confused` | `380, 94` | `I don't understand this` |

Chip style (same component as screen 05, **per-screen overrides in bold**):
`align-items: center`, **`width: 360`**, **`height: 74`**,
**`padding-left: 22`**, **`gap: 16`**, `border-radius: --radius-lg`,
background `--color-surface`, `shadow/card`.
Icon **`24 × 24`**, stroke `--color-brand`, **stroke-width 2**.
Label **20 / 24**, weight 500, `--color-ink`.

### Composer · wide (`740 × 68`)

`flex row`, `align-items: center`, `border-radius: 9999`,
background `--color-surface`, `shadow/card`,
`padding-left: 28` (`--spacing-7`), `padding-right: 8` (`--spacing-2`),
`gap: 16` (`--spacing-4`).

| Child | x, y within composer | Size | Notes |
|---|---|---|---|
| `ui/plus` | `28, 24` | `20 × 20` | **new** — same glyph and same `--color-icon` stroke as the panel's. Board 03b |
| Placeholder text | `64, 21` | **`538 × 26`** | `Ask me anything...` — 21 / 26, weight 400, `--color-ink-tertiary`, `flex-grow: 1` |
| `btn/voice` | `618, 11` | **`46 × 46`** | mic glyph `26 × 26` |
| `btn/send` | `680, 8` | **`52 × 52`** | filled circle `--color-brand`, up-arrow glyph `26 × 26` |

The row closes exactly:
`740 − 28 − 20 − 16 − 538 − 16 − 46 − 16 − 52 − 8 = 0`.
Without the plus the lane is `574`.

**The glyphs did not scale with the boxes.** Send went 56 → 52 and voice
52 → 46 while both stayed at 26, so the ring of colour around the send arrow
tightened from 15 pt to 13.

There is **no** selection glyph and **no** attached-context strip in the
full-screen composer.

### Board peek (`68 × 976` at `0, 28`)

Three stacked children (back → front):

| Child | Position | Size | Notes |
|---|---|---|---|
| `Edge shadow` | `3, 2` | `68 × 976` | the same silhouette path, `opacity: 0.11`, `filter: blur(5px)` |
| `Board edge` (SVG) | `0, 0` | `68 × 976` | shape fill `--color-surface-canvas`; dot-grid path fill `#F1F1F1` |
| `Board hinge icon` | `23, 22` | `22 × 20` | see below |

`Board edge` silhouette path (viewBox `0 0 68 976`), exactly:

```
M0,0 H50 A18,18 0 0 1 68,18 V46 A18,18 0 0 1 50,64 H46
A18,18 0 0 0 28,82 V958 A18,18 0 0 1 10,976 H0 Z
```

i.e. a 68-wide **tab** occupying `y = 0 … 64` (holding the hinge icon), which
necks in via a concave 18 pt fillet to a **28-wide strip** for
`y = 82 … 936`. All corner radii are 18.

Dot grid inside the peek: circles `r = 1.4`, fill `#F1F1F1`,
x positions `0, 23.9, 47.8`, y pitch `24.5`, starting at `y = 1.4`; columns
past `x = 23.9` stop once the shape necks in.

`Board hinge icon`: SVG `22 × 20` (viewBox `26 × 24`) — rounded rect
`x2.1 y2.6 w21.8 h18.8 rx3.6`, stroke `--color-ink`, width 1.9, plus six
`r = 1` filled dots at `(8|13|18, 9|15)`. It reads as "a board".

### All literal copy on screen 07

```
9:41 AM
Tue May 21
100%
Hi! I'm your AI Tutor
I'm here to help you learn, practice and achieve your goals.
Explain this concept
Give me an example
Create an exercise
I don't understand this
Ask me anything...
```

---

## Screen 08 — Tutor · in conversation

### Purpose / app state

Same shell as screen 05 (board + docked panel), but the tutor conversation is
under way. The panel's start state has been replaced by a scrolling message
thread, the composer has lost its attached-context strip (the selection was
already sent), and the tutor is mid-turn (an orb "thinking" indicator sits at
the bottom of the thread).

### Region map

| Region | Kind | x | y | w | h | Fill |
|---|---|---|---|---|---|---|
| Screen | — | 0 | 0 | 1376 | 1032 | `--color-surface-screen` |
| Status bar | absolute overlay | 0 | 16 | 1376 | 24 | none |
| Whiteboard canvas | absolute | 124 | 28 | 863 | 976 | `--color-surface-canvas` |
| Tool rail | absolute | 28 | 28 | 72 | **627.5** | `--color-surface-panel` |
| Tutor chat panel | absolute | 1011 | 28 | 337 | 976 | `--color-surface-panel` |

Identical to screen 05 at this level, including the canvas ink asset and
position (`157, 147`, `548 × 641`).

**Z-order** (back → front): Status bar → Whiteboard canvas → Tool rail →
Tutor chat panel.

### Tutor chat panel — internals

Panel container is identical to screen 05 (`337 × 976`, `--radius-3xl`,
`--color-surface-panel`, `shadow/panel`, `flex column`, `align-items: center`,
`padding-block: 18`, content width `301`), and as on screen 05 every child is
absolutely positioned.

| # | Child | y within panel | Size |
|---|---|---|---|
| 1 | `Thread` | **0** | **`301 × 976`** — absolute, `left: 18` |
| 2 | `Scroll fade · top` | 0 | `337 × 80` — absolute overlay |
| 3 | `Panel controls` | 18 | `301 × 32` |
| 4 | `Scroll fade · bottom` | **908** | `337 × 68` — absolute overlay |
| 5 | `Composer` | **908** | **`301 × 50`** — absolute, `left: 18` |

Content bottom = `908 + 50 = 958`; again 18 pt of slack at the panel bottom —
implement the composer bottom-anchored with an 18 pt inset.

**The thread now spans the full panel height** and the composer floats over its
last 68 pt, with the bottom fade dissolving the messages into that band. This
is a structural change from the version this file was first written against
(thread `301 × 810` starting below the controls, one top-only fade inside it);
`03-chat-components.md` §5–§6 still describe the old arrangement. The thread's
own `padding-bottom` carries the clearance: **86** = the 68 pt composer band
plus 18.

`Panel controls` is identical to screen 05: `btn/dock` at `x = 0`,
`btn/full-screen` at `x = 46`, `gap: 14`, both `32 × 32`.

Note the **absence of an Orb block** in the panel header — the orb only
appears inline at the tail of the thread while the tutor is responding.

#### Thread (`301 × 976`)

`flex column`, **`justify-content: flex-end`**, `gap: var(--space-message-gap)`
= 22, **`padding-bottom: 86`**, `position: absolute` at `18, 0`,
`overflow: visible`.

Because the thread is bottom-anchored, the visible content is pinned to the
bottom and the top of the oldest visible message is clipped/faded.

Heights are measured; the `y` column is **derived** from them, the 22 pt gap and
the 86 pt bottom padding (flex children report no offset of their own).

| # | Node | y within thread | h | Kind | Copy |
|---|---|---|---|---|---|
| 1 | `msg/tutor` | 103 | 50 | plain text, 301 wide | `Welcome back — let's pick up where we left off with vectors.` |
| 2 | `msg/student` | 175 | 49 | bubble | `ok` |
| 3 | `msg/tutor` | 246 | 50 | plain text | `Draw a pair of axes and one arrow from the origin, then I'll take a look.` |
| 4 | `msg/student` | 318 | 49 | bubble | `done` |
| 5 | `msg/tutor` | 389 | 50 | text in a `flex column gap:12` wrapper | `Great start! 🎉 A vector in 2D has two components — x and y.` |
| 6 | `msg/student` | 461 | 74 | bubble (2 lines) | `why does the arrow start at 0?` |
| 7 | `msg/tutor` | 557 | 75 | plain text (3 lines) | `It doesn't have to. Starting at the origin is just standard position — slide it anywhere and it's the same vector.` |
| 8 | `msg/student · with selection` | 654 | 96 | **selection bubble stack** | `Selection` / `is my (x, y) label right?` |
| 9 | `msg/tutor` | 772 | 50 | plain text | `Yes — that point is the head of the vector, so (x, y) are exactly its components.` |
| 10 | `btn/orb` | 844 | 46 | thinking indicator | — |

Arithmetic check: items sum `589` + nine 22 pt gaps `198` = `787`;
`787 + 86` padding = `873`; bottom-anchored inside `976` → first item starts
at `y = 103`, and the orb's bottom lands on `890 = 976 − 86`. ✔

The fades are **siblings of the thread**, not children of it — see the panel
stack above. They are not transcribed in detail in this file.

Message styles:

| Role | Style |
|---|---|
| **Tutor** | No bubble. Full `301` width, `--font-sans` 17 / 25, weight 400, `--color-ink`. Left-aligned, flush to the content column. |
| **Student** | Row `301` wide, `justify-content: flex-end`. Bubble `max-width: 224`, `padding-block: 12`, `padding-inline: 16`, `border-radius: --radius-bubble` (18), background `--color-surface-bubble`, text 17 / 25 `--color-ink`. |

`btn/orb` (thinking indicator), `46 × 46`, left-aligned in the thread:
`Halo` absolute `-24, -23`, `94 × 92`; `Orb body` `32 × 25`, radius 9999,
`padding-top: 3`, `gap: 10`, two `4 × 4` white eyes.

`Scroll fade · top`: absolutely positioned at `0, 0` of the **panel**,
`337 × 80`, carrying `--radius-3xl` on its two top corners, a many-stop
`linear-gradient(in oklab 180deg, …)` from opaque `oklab(99.1% 0 0)` to
transparent — i.e. `--color-surface-panel` (#FCFCFC) fading downward.
**There is now a matching bottom fade** (`Scroll fade · bottom`, `337 × 68` at
`0, 908`, the ramp reversed and stopping at 80 % rather than full opacity, with
`--radius-3xl` on the two bottom corners). Both are full panel width and both
sit outside the thread. The single `301 × 72` fade this file and
`03-chat-components.md` §6 describe is superseded.

#### The selection hand-off affordance (message 8)

This is the key per-screen detail. `msg/student · with selection` is a row
(`301` wide, `justify-content: flex-end`) containing a
`Selection bubble stack` of `224 × 96`, `position: relative`, with two
absolutely-positioned layers:

| Layer | Position | Size | Style | Copy |
|---|---|---|---|---|
| Selection cap | `0, 0` | `224 × 67` | background `--color-brand-tint-soft`, top radii `18 / 18`, bottom square; `padding-left: 20`, `padding-right: 16`, `align-items: flex-start`; inner row `188 × 38`, `padding-inline: 3`, `padding-top: 6` | `Selection` — 15 / 18, weight 600, `--color-brand` |
| Message bubble | `0, 38` | `224 × 58` | background `--color-surface-bubble`, `border-radius: --radius-bubble` (18), `padding-inline: 20`, `gap: 12`, `align-items: center` | `is my (x, y) label right?` — 17 / 22, `--color-ink` |

Same "tab tucked behind the bubble" construction as the composer's attached
context on screen 05 — but **this one did not come down with the pill**: the cap
is still 67 tall over a 58 pt bubble, so 29 pt is hidden. That is correct as
drawn (the bubble's 18 pt radius only needs 18 covered, and 67 over-covers it
harmlessly), and it is what board 03 §11.5 already flags as 11 pt hidden for
nothing. **Do not "fix" it to match the composer's new 63 / 25** — the shape in
front here is a bubble, not a capsule, so the radius that drives the law is
different.

Differences from the composer version on screen 05:

| | Screen 05 composer | Screen 08 sent message |
|---|---|---|
| Width | 301 | 224 |
| Body height | **50** | 58 |
| Cap height | **63** | 67 |
| Cap top radius | **25** (= pill 50 ÷ 2) | 18 (`--radius-bubble`) |
| Label | `Selection attached` | `Selection` |
| Dismiss ✕ | yes (`14 × 14`, brand) | **no** |
| Body background | `--color-surface` (input pill) | `--color-surface-bubble` |
| Body radius | 9999 (pill) | `--radius-bubble` (18) |

**Important:** the design shows **no** corresponding selection marquee,
highlight, or lasso outline on the board itself in screen 08. The board ink
asset is identical to screen 05's. See open questions.

#### Composer (`301 × 50`)

`position: relative` wrapper, one absolutely-positioned `Input` at `0, 0`:
**`301 × 50`**, background `--color-surface`, `border-radius: 9999`,
`shadow/card`, `padding-left: 18`, `padding-right: 6`, `gap: 10`,
`align-items: center`.

Children identical to screen 05's input row: `ui/plus` `20 × 20` at `x = 18`;
selection glyph `24 × 24` (dashed square, brand) at `x = 48`; placeholder
`Ask anything...` (`121 × 22`, 17 / 22, `--color-ink-tertiary`) at `x = 82`;
`btn/voice` **`34 × 34`** at `x = 213`; `btn/send` **`38 × 38`** brand circle at
`x = 257`.

The dashed selection glyph is still present in the input even though nothing
is currently attached — it is a persistent affordance, not a state indicator.

### All literal copy on screen 08

```
9:41 AM
Tue May 21
100%
Welcome back — let's pick up where we left off with vectors.
ok
Draw a pair of axes and one arrow from the origin, then I'll take a look.
done
Great start! 🎉 A vector in 2D has two components — x and y.
why does the arrow start at 0?
It doesn't have to. Starting at the origin is just standard position — slide it anywhere and it's the same vector.
Selection
is my (x, y) label right?
Yes — that point is the head of the vector, so (x, y) are exactly its components.
Ask anything...
```

---

## State model

### The states these four screens represent

The four screens are not four independent layouts. They are the cross-product
of **two independent axes**, with one cell unillustrated:

| | Tutor **start state** | Tutor **conversation** |
|---|---|---|
| **Board + panel docked** | Screen **05** | Screen **08** |
| **Board only (panel collapsed)** | Screen **06** | Screen 06 (same — panel content is hidden) |
| **Tutor full-screen** | Screen **07** | *not designed* |

So:

- **Axis A — tutor presentation**: `docked` (337 pt panel, screens 05/08) ·
  `collapsed` (132 × 64 dock, screen 06) · `fullScreen` (740 pt column,
  screen 07).
- **Axis B — conversation state**: `start` (greeting + chips, screens 05/07) ·
  `active` (message thread, screen 08).
- **Axis C — board selection**: `none` · `attached` (screen 05's composer
  shows an attached selection; screen 08 shows one that has been sent).

Screen 06 collapses axis B entirely — when the panel is docked away, the
conversation state is simply not visible.

### Transitions the design shows or implies

| From | Control | To | Evidence |
|---|---|---|---|
| 05 / 08 | `btn/dock` in `Panel controls` (right-sidebar glyph) | 06 | The button is named `btn/dock`; screen 06 is named "Tutor dock · collapsed" and the panel is replaced by a dock. |
| 05 / 08 | `btn/full-screen` in `Panel controls` (plain rect glyph) | 07 | Button name; screen 07 is the full-screen tutor. |
| 06 | `btn/orb` in the dock | 05 or 08 | The orb is the tutor's avatar; tapping it restores the panel. Which of 05/08 you land on depends on whether a conversation already exists (axis B is preserved). |
| 07 | `Board peek` / `Board hinge icon` on the left edge | 05 or 08 | The peek is a literal edge of the board card with a "board" glyph in its tab; it is the only board affordance on the screen. |
| 05 → 08 | Sending from the composer, or tapping any suggestion chip | 08 | The start state is replaced by the thread; the chips are prompts. |
| 07 → 08 (implied) | Sending from `Composer · wide` | ? | **Not designed.** See open questions. |
| 06 | `btn/select` in the dock | selection mode on the board | The dashed-square glyph matches the composer's selection marker, and the "Selection attached" chip in 05 / "Selection" bubble in 08 are its downstream results. |
| 05 | `✕` on the `Selection attached` chip | 05 with no attachment | Explicit dismiss control. |

### What is genuinely shared (reuse these views)

- **Status bar** — byte-identical on all four. One view, always mounted at
  `y = 16`.
- **Tool rail** — byte-identical on 05, 06, 08 (**627.5** tall in all three).
  One view; visibility toggles off for `fullScreen`.
- **Whiteboard canvas** — identical card treatment on 05, 06, 08; **only the
  width changes** (863 ↔ 1224) and the ink re-centres. One view, animatable
  width. The dot grid and ink are the same assets.
- **Tutor panel chrome** — screens 05 and 08 share the container *exactly*
  (337 × 976, radius 28, `--color-surface-panel`, `shadow/panel`,
  `padding-top: 18`, 301 pt content column) and share `Panel controls`
  verbatim. Only the middle region and composer height differ.
- **Suggestion chip copy + icons** — the same four items and the same four
  glyphs appear on 05 and 07. One data source, two size variants.
- **`btn/settings`** — the same 32 × 32 gear in the same lane on 07 and 13, and
  at the trailing edge of the panel's controls row on 05 / 08 / 11 / 12. One
  button; only what surrounds it changes.
- **Greeting copy** — identical strings on 05 and 07.
- **Orb** — one component at four sizes:
  `150 × 142` hero (07, *with smile*), `96 × 90` panel (05),
  `64 × 64` dock (06), `46 × 46` inline thinking indicator (08).
  All share the same halo gradient recipe and body gradient; only the hero
  has a mouth.
- **Selection stack construction** — the composer attachment (05) and the sent
  selection message (08) are the same two-layer "tab behind a body" idiom at
  two widths/radii.

### What is genuinely different (branch these views)

- **Content column vs panel column.** 301 pt (panel) vs 740 pt (full screen).
  This is not a scale factor: the type scale, chip layout (1-up vs 2-up), chip
  height (62 vs 74), icon size (22 vs 24), composer height (**50/88 vs 68**) and
  the composer's contents all change. Treat the greeting/chips/composer as
  **two variants**, not one responsive view.
- **Start state vs Thread.** 530 pt fixed-height, centred, top-down flow vs
  976 pt bottom-anchored scrolling list under a top and a bottom scroll-fade.
  Different layout model.
- **Screen background.** #F8F8F8 on 05/06/08 vs #FFFFFF on 07.
- **The board.** A real 863/1224-wide interactive canvas on 05/06/08 vs a
  decorative 68 pt vector edge on 07 (which is *not* a live canvas — it is a
  static path plus a dot-grid path).
- **Composer height.** 88 (with attachment) vs 50 (without) in the panel — and
  only the *card* differs between them, since the 38 pt visible band plus the
  pill is the whole of the 88.
- **Panel orb.** Present as a header element in 05, absent in 08 (where the
  orb appears only inline at the tail of the thread).

### Recommended state enum

```swift
enum TutorPresentation { case docked, collapsed, fullScreen }
enum ConversationState { case start, active }
enum BoardSelection    { case none, attached(SelectionRef) }
```

Screen 05 = `(.docked, .start, .attached)`
Screen 06 = `(.collapsed, _, _)`
Screen 07 = `(.fullScreen, .start, .none)`
Screen 08 = `(.docked, .active, .none)`

---

## Open questions / not specified by the design

The design is a set of four static frames. Everything below is something an
implementer would otherwise have to invent — none of it should be guessed
silently.

### Missing states

1. **Full-screen tutor with an active conversation.** The `(fullScreen,
   active)` cell has no artboard. Unknown: does the 740 pt column host the
   thread? Is the thread also 740 wide, or narrower? Do the tutor messages
   stay flush-left and the student bubbles cap at some max width (the panel
   caps at 224 = 74% of 301 — the equivalent would be ~550 of 740, but that
   is extrapolation)? Is the greeting removed or scrolled away?
2. **Full-screen tutor with a selection attached.** `Composer · wide` has no
   attached-context strip and no dashed selection glyph. Unknown whether
   selections can even exist in full-screen mode, and if so how they render.
3. **Empty board.** Every screen shows the same finished "Vector v⃗ in 2D"
   ink. There is no first-run / blank-canvas state, no empty-board prompt,
   and no indication of what the board looks like before anything is drawn.
4. **Empty thread / first message.** Screen 08 shows a thread already ~10
   messages deep. The transition frame — greeting collapsing into the first
   exchange — is not designed.
5. **Tutor typing/streaming.** The inline `btn/orb` at the thread tail is
   presumably a "thinking" indicator, but there is no animation spec, no
   streaming-text treatment, and no error/retry state for a failed reply.
6. **Collapsed dock with unread activity.** No badge, dot, or attention state
   on `btn/orb` in screen 06. If the tutor replies while collapsed, nothing in
   the design says how the user learns about it.
7. **Selection-in-progress on the board.** There is no marquee, lasso path,
   handle, or highlight anywhere. Screen 08's board is pixel-identical to
   screen 05's despite a selection having been sent — so the design never
   shows what a selected region looks like *on the canvas*, nor whether the
   selection persists visually after sending.
8. **Tool states other than pen.** Only `tool/pen · selected` carries the
   `--color-brand-tint` background. There is no hover, pressed, or disabled
   treatment for any rail control, and no selected state shown for a colour
   swatch or for `tool/center`.
9. **Thickness control.** The rail's `Thickness` element is a static
   `36 × 5` bar. Whether it is a display, a stepper, or a popover trigger —
   and what its other values look like — is not specified.
10. **Undo / redo / clear / page management.** Not present anywhere in the
    four screens.

### Missing behaviour and dimensions

11. **Animation.** No timing, easing, or choreography for any transition:
    panel dock ↔ collapse, panel ↔ full screen, board width 863 ↔ 1224,
    greeting → thread, orb idle/thinking motion, halo pulsing. All four
    frames are static.
12. **Keyboard-up layout.** iPad software keyboard occupies roughly the
    bottom third. Nothing specifies whether the panel composer stays pinned
    above the keyboard, whether the thread shrinks or scrolls, or what the
    full-screen column does. The design also shows no focused-composer or
    caret state, and no filled (non-placeholder) composer.
13. **Scrolling.** The thread's `justify-content: flex-end` and its 80 pt top
    scroll-fade imply a scroll view, but there is no scrollbar treatment, no
    "scroll to latest" affordance and no over-scroll spec. *(The "no bottom
    fade" half of this is now answered: `Scroll fade · bottom`, `337 × 68`,
    covers the composer band.)* Whether the board itself pans/zooms (and
    whether `tool/center` is the recentre control) is implied by naming only.
14. **The 18 pt bottom slack in the panel.** Content in both panel screens
    ends at `y = 958` inside the 976 pt panel. It is not expressed as a
    `padding-bottom` — it falls out of the flex stack. Confirm the intent is
    "composer bottom-anchored with an 18 pt inset" (which is what this
    document recommends) rather than "content flows from the top and happens
    to stop 18 pt short".
15. **Status bar reality.** The design draws its own status bar at `y = 16`,
    height 24, with hard-coded `9:41 AM` / `Tue May 21` / `100%`. On device,
    iPadOS owns the status bar and the safe-area inset differs. Decide whether
    to hide the system bar and draw this one, or drop it and shift the
    `y = 28` content band to a safe-area-relative origin.
16. **Dark mode.** Only a light palette exists. Several fills are near-white
    and differ by 2–4 % (`#FFFFFF` / `#FCFCFC` / `#FAFAFA` / `#F8F8F8`); the
    dark-mode mapping of that hierarchy is undefined, as are the orb's oklab
    gradients.
17. **Dynamic Type / accessibility.** All type sizes are fixed px. No
    behaviour is specified for larger text sizes, and several containers are
    fixed-height (chips at 62/74, bubbles, composer) so they would clip.
    No VoiceOver labels are given for the icon-only controls
    (`btn/dock`, `btn/full-screen`, `btn/select`, `btn/orb`, `btn/voice`,
    `tool/center`, the swatches).
18. **Voice input.** `btn/voice` appears in every composer with no recording,
    listening, or permission state designed.
19. **Text wrapping in the thread.** Message heights (50 / 75 / 49 / 74) were
    laid out for the specific strings quoted here. Nothing specifies max
    thread-message width for the tutor (it uses the full 301) or how code,
    math, lists, or images render inside a message.
20. **The dot grid on the real canvas.** The canvas grid is an exported SVG
    background image, so its true pitch/colour cannot be read from the design.
    The 68 pt board peek draws the grid as vector geometry (dots `r = 1.4`,
    fill `#F1F1F1`, x-pitch 23.9, y-pitch 24.5) — use that as the reference
    unless the canvas asset is re-derived.
21. **Orientation and other sizes.** Only 1376 × 1032 (iPad Pro 13"
    landscape) exists. Portrait, smaller iPads, Split View, Slide Over, and
    Stage Manager window sizes are all undefined — and the full-screen
    column's "centre 740 in the space right of the 68 pt peek" rule needs an
    explicit behaviour below ~876 pt of width.
22. **Which state the orb returns you to.** Tapping `btn/orb` in the collapsed
    dock restores the panel, but the design does not say whether an
    in-progress conversation is preserved (05 vs 08) or whether collapsing
    resets to the start state.
23. **Suggestion chips after the conversation starts.** They disappear in
    screen 08. Whether they can come back (e.g. as follow-up suggestions after
    a tutor turn) is not shown.
