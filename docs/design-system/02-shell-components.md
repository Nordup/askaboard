# 02 — Components · Shell

Code-ready extraction of the Paper artboard **"02 — Components · Shell"** (1680 × 9087) from the file *AI Whiteboard Tutor — Design System, Components & Page*.

Every number below was read from `get_computed_styles` / `get_jsx` / `get_node_info`. **Nothing is rounded and nothing is snapped to the 4px token scale.** Several values on this board are deliberately off-grid (`9`, `3.5`, `1.5`, `11.5`, `19.5`, `27`, `29`, `2.5`, `23.9`, `24.5`). Reproduce them exactly.

Target device: iPad Pro 13" landscape, **1376 × 1032 pt**, no scroll container. 1 Paper px = 1 pt.

> **Board blurb (verbatim):** "This board covers the persistent chrome: the surfaces and controls that are on screen regardless of conversation state. Every value is measured from the live screens — the shell tiles a fixed 1376pt iPad stage with no scroll container, so these numbers are load-bearing rather than decorative."

---

## 0. Design tokens referenced by this board

Full token set from the file (`get_tokens`). Only tokens actually used by shell components are annotated.

### Colour

| Token | Value | Used by |
|---|---|---|
| `--color-ink` | `#0C0E17` | doc type |
| `--color-ink-secondary` | `#62636E` | doc type |
| `--color-ink-tertiary` | `#A0A1AA` | doc type / eyebrows |
| `--color-surface` | `#FFFFFF` | `btn/select` (collapsed dock) |
| `--color-surface-screen` | `#F8F8F8` | screen background (doc stages) |
| `--color-surface-canvas` | `#FAFAFA` | whiteboard canvas, board-peek edge shape |
| `--color-surface-panel` | `#FCFCFC` | tool rail, tutor panel |
| `--color-brand` | `#6051DC` | selected pen glyph |
| `--color-brand-tint` | `#E6E3F9` | selected tool-slot fill |
| `--color-brand-tint-soft` | `#F1F0FB` | (doc annotation block only) |
| `--color-pen-black` | `#0A0A0A` | swatch 1, thickness bar |
| `--color-pen-violet` | `#6051DC` | swatch 2 |
| `--color-pen-blue` | `#0155FB` | swatch 3 |
| `--color-pen-green` | `#40A365` | swatch 4 |
| `--color-pen-red` | `#E33E38` | swatch 5 |
| `--color-icon` | `#55565A` | all unselected glyph fill/stroke |
| `--color-surface-bubble` | `#F2F2F6` | (not used on this board) |
| `--color-divider` | `#EFEFEF` | rail divider, doc row rules |
| `--color-shadow` | `#141432` | base of all elevation shadows |

### Layout / spacing / radius

| Token | Value | Used by |
|---|---|---|
| `--container-screen` | `1376px` | screen width |
| `--container-rail` | `72px` | tool rail width |
| `--container-panel` | `337px` | tutor panel width |
| `--container-panel-content` | `301px` | panel content column, panel-controls group |
| `--container-column` | `740px` | (not used on this board) |
| `--space-edge` | `28px` | screen edge inset |
| `--space-gap` | `24px` | board↔panel gap, dock inset inside board |
| `--space-content` | `56px` | (not used on this board) |
| `--space-panel-inset` | `18px` | panel padding-top |
| `--space-message-gap` | `22px` | (not used on this board) |
| `--spacing-1…12` | `4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 / 40 / 48` | `--spacing-4` = collapsed-dock gap |
| `--radius-xs … --radius-3xl` | `6 / 10 / 12 / 14 / 16 / 20 / 28` | `lg` 14 = tool slot, `2xl` 20 = rail, `3xl` 28 = panel & canvas |
| `--radius-full` | `9999px` — **built in Paper as `calc(infinity * 1px)`** | swatches, orb body/eyes, `btn/select` |
| `--radius-bubble` | `18px` | (not used on this board) |

### Type

`--font-doc: Montserrat` · `--font-sans: Source Sans 3` · `--font-mono: IBM Plex Mono`

Sizes `--text-label 15 / --text-body 17 / --text-body-lg 20 / --text-lead 21 / --text-title 26 / --text-display 40`.
Weights `400 / 500 / 600 / 700`. Tracking `--tracking-tight -0.01em`, `--tracking-wide 0.06em`.
Leading `--leading-label 18 / tight 20 / control 22 / snug 24 / body 25 / lead 30 / title 34 / display 48`.

### Elevation levels named on this board

| Level | Value |
|---|---|
| **01 Canvas** | `#14143209 0 2 6` |
| **02 Panel** | `#1414320E 0px 3px 10px, #1414320A 0px 1px 3px` |
| **03 Control** | referenced by name only; board states the collapsed dock **drifts** from it (see §7) |
| none | tool slot, thickness bar, panel controls, orb |

---

## 1. Tool rail — `Tool rail`

**Purpose:** the persistent left-edge surface holding tool selection, pen colour, stroke weight and the centre-on-work control. Layer path in the product file: `05 — Board + Tutor (no chrome) / Tool rail`.

> **Designer rationale (verbatim):** "The rail is a fit-content column so adding or removing a tool never requires re-measuring a fixed height. Its optical margins come from padding-block 9 plus the 54pt slot centring its own 27–28pt glyph — do not 'simplify' this into a single large padding value, which is the bug this rail already had once and which pushed the top and bottom glyphs out of balance."

### Frame

| Property | Value |
|---|---|
| Size | `var(--container-rail)` **72 × fit-content**; **627.5** as built (verified: node height = `627.5`) |
| Padding | `padding-block: 9px` (top 9, bottom 9). **No horizontal padding.** No token — 9 is intentional |
| Gap | **`gap: 0`** — the rail itself has no flex gap. All vertical steps come from `margin-top` on individual children |
| Direction | `flex-direction: column`, `align-items: center` |
| `height` | `fit-content` (declared), `flex-shrink: 0` |
| Radius | `var(--radius-2xl)` = **20px**, uniform |
| Background | `var(--color-surface-panel)` = `#FCFCFC` |
| Border | none |
| Shadow | **02 Panel** — `#1414320E 0px 3px 10px, #1414320A 0px 1px 3px` |

### Child stack — full spacing chain (5 children)

Read top to bottom. This is the exact chain; do **not** convert any of it to a uniform `gap`.

| # | Child | Own size | Preceding step | Running total |
|---|---|---|---|---|
| — | `padding-block` top | — | — | **9.0** |
| 1 | **Tools** (frame) | 54 × **226.5** | — (first child, no margin) | **235.5** |
| 2 | **Divider** (frame) | **46 × 1.5** | `margin-top: 11.5` | **248.5** |
| 3 | **Swatches** (frame) | 27 × **243** | `margin-top: 19.5` | **511.0** |
| 4 | **Thickness** (frame) | **36 × 5** | `margin-top: 29` | **545.0** |
| 5 | **tool/center** (slot) | **54 × 54** | `margin-top: 19.5` | **618.5** |
| — | `padding-block` bottom | — | — | **627.5** |

**Arithmetic as stated on the board (Stack row, verbatim):**
`5 children · Tools 226.5 → mt 11.5 → Divider 1.5 → mt 19.5 → Swatches 243 → mt 29 → Thickness 5 → mt 19.5 → center 54`

**Verified total:** `9 + 226.5 + 11.5 + 1.5 + 19.5 + 243 + 29 + 5 + 19.5 + 54 + 9 = ` **`627.5`** ✅ — matches the node's measured height exactly. **No regression present.**

#### Child 1 — `Tools` frame

- `display: flex; flex-direction: column; align-items: center;` **`gap: 3.5px`** (off-grid, deliberate)
- Height arithmetic: `4 × 54 + 3 × 3.5 = 216 + 10.5 = ` **`226.5`**
- Children are **fixed-size 54 × 54 slots**, `flex-shrink: 0`, in order:

| Slot | State | Glyph | Glyph size |
|---|---|---|---|
| `tool/pen · selected` | **selected** | pen | **27 × 28** (`viewBox 0 0 28 28`) |
| `tool/highlighter` | default | highlighter | 28 × 28 |
| `tool/eraser` | default | eraser | 28 × 28 |
| `tool/lasso` | default | dashed circle | 28 × 28 |

#### Child 2 — `Divider`

`width: 46px; height: 1.5px; margin-top: 11.5px; flex-shrink: 0; background: var(--color-divider)` (`#EFEFEF`). No radius.
**`1.5`, not `1` or `2`.** A tree-summary read of "46 × 2" is rounding — the computed height is `1.5px`.

#### Child 3 — `Swatches` frame

- `display: flex; flex-direction: column; align-items: center;` **`gap: 27px`**, `margin-top: 19.5px`
- Height arithmetic: `5 × 27 + 4 × 27 = 135 + 108 = ` **`243`**
- Each swatch: `27 × 27`, `border-radius: calc(infinity * 1px)` (= `--radius-full`), `flex-shrink: 0`
- **54pt pitch** = 27 dot + 27 gap, matching the tool-slot pitch. See §3.

#### Child 4 — `Thickness`

`width: 36px; height: 5px; border-radius: 2.5px; margin-top: 29px; background: var(--color-pen-black)` (`#0A0A0A`). See §4.

#### Child 5 — `tool/center`

`display: flex; align-items: center; justify-content: center; width: 54px; height: 54px; margin-top: 19.5px; flex-shrink: 0`
Glyph: **26 × 26**, `viewBox 0 0 24 24` — crosshair/target:

```svg
<svg width="26" height="26" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="7" fill="none" stroke="var(--color-icon)" stroke-width="2"/>
  <path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3" fill="none" stroke="var(--color-icon)"
        stroke-width="2" stroke-linecap="round"/>
  <circle cx="12" cy="12" r="1.9" fill="var(--color-icon)"/>
</svg>
```

Note this is the **only** glyph in the rail on a `0 0 24 24` viewBox; every other rail glyph is `0 0 28 28`.

### Optical margin (stated rationale)

> `22 top / 23 bottom · = 9 padding + 13/14 slot centring`

Verified: top glyph is 28 tall in a 54 slot → `(54 − 28) / 2 = 13`; `9 + 13 = 22`.
Bottom glyph is 26 tall in a 54 slot → `(54 − 26) / 2 = 14`; `9 + 14 = 23`.

### Known regression (transcribed verbatim — this is the board's regression note)

> **RESOLVED** — was snapped to 617 during authoring (gap 12 + margin-top 8/16/8, Tools gap 0, divider 1) and reverted to 627.5. Cause: `duplicate_nodes` quantises off-scale values to the 4px scale and rewrites the SOURCE node, not just the clone. A future export reading 617 is this regression, not a redesign.

**Implementation consequence:** if a Swift port ever measures the rail at 617, it copied the corrupted state. The correct total is **627.5**.

### Rail SVG glyphs (exact)

```svg
<!-- tool/pen (selected) — 27 × 28, viewBox 0 0 28 28, all paths fill var(--color-brand) #6051DC -->
<path d="M22.4 2.6a3 3 0 0 1 4.24 0l.76.76a3 3 0 0 1 0 4.24l-2.1 2.1-5-5 2.1-2.1Z"/>
<path d="M18.58 5.42l5 5L11.9 22.1l-5-5L18.58 5.42Z"/>
<path d="M5.86 18.14l5 5-6.53 1.72a.72.72 0 0 1-.88-.88l1.71-6.54Z"/>

<!-- tool/highlighter — 28 × 28, viewBox 0 0 28 28 -->
<path d="M18.1 3.9a2.7 2.7 0 0 1 3.82 0l2.18 2.18a2.7 2.7 0 0 1 0 3.82l-9.1 9.1-6-6 9.1-9.1Z" fill="var(--color-icon)"/>
<path d="M8.5 13.6 14.5 19.6 12.3 21.8H6a1.1 1.1 0 0 1-1.1-1.1v-4.4L8.5 13.6Z" fill="var(--color-icon)"/>
<path d="M4.6 25.4h18.8" fill="none" stroke="var(--color-icon)" stroke-width="2.2" stroke-linecap="round"/>

<!-- tool/eraser — 28 × 28, viewBox 0 0 28 28 -->
<path d="M12.6 4.1a2.1 2.1 0 0 1 2.97 0l8.33 8.33a2.1 2.1 0 0 1 0 2.97l-5.36 5.36a2.1 2.1 0 0 1-2.97 0L7.24 12.43a2.1 2.1 0 0 1 0-2.97L12.6 4.1Z"
      fill="none" stroke="var(--color-icon)" stroke-width="2"/>
<path d="M5.4 21.9h18.4" fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round"/>

<!-- tool/lasso — 28 × 28, viewBox 0 0 28 28 -->
<circle cx="14" cy="14" r="9.7" fill="none" stroke="var(--color-icon)"
        stroke-width="2.7" stroke-linecap="round" stroke-dasharray="0.1 4.3"/>
```

---

## 2. Tool slot — `Tool slot — selected / default`

**Purpose:** the fixed square that makes a small glyph a legal tap target and sets the rail's vertical rhythm. Layer path: `Tool rail / Tools / tool/pen · selected · tool/highlighter`.

> **Designer rationale (verbatim):** "A tool slot is a fixed 54pt square that centres a 27–28pt glyph, so the touch target stays legal even though the glyph is small. That 54pt box is also what produces the rail's optical margins: shrink the slot to fit the glyph and the whole rail loses its balance."

| Property | Default | Selected |
|---|---|---|
| Size | **54 × 54** (no token) | **54 × 54** — *identical in both states* |
| Padding | `0` — glyph centred by flex (`align-items: center; justify-content: center`), **never by padding** | same |
| Radius | **none** | `var(--radius-lg)` = **14px**, uniform |
| Background | **none** | `var(--color-brand-tint)` = `#E6E3F9` |
| Border | none | none |
| Shadow | none | none |
| Glyph size | 28 × 28 (pen is **27 × 28**) · `viewBox 0 0 28 28` | same |
| Glyph colour | fill/stroke `var(--color-icon)` = `#55565A` | pen fill `var(--color-brand)` = `#6051DC` |
| `flex-shrink` | `0` | `0` |

**States documented on the board: `default` and `selected` only.** No pressed, hover, or disabled variant is specified anywhere on this artboard (see Open questions).

Documentation labels on the specimen (`SELECTED` / `DEFAULT`) are board chrome, not product UI: `--font-sans`, 13px, weight 600, line-height 16, letter-spacing 0.06em, `--color-ink-tertiary`.

---

## 3. Pen swatches — `Pen swatches`

**Purpose:** the five ink colours. Layer path: `Tool rail / Swatches`.

> **Designer rationale (verbatim):** "Five ink colours on a 54pt pitch — the same pitch as a tool slot — so the swatch column and the tool column read as one vertical rhythm even though the swatch itself is only 27pt. The circle is half the pitch; the other half is the tap target."

| Property | Value |
|---|---|
| Column size | **27 × 243** |
| Swatch size | **27 × 27** each, `flex-shrink: 0` |
| Layout | `flex-direction: column; align-items: center` |
| Gap | **`27px`** — no token → **54px pitch** (27 dot + 27 gap) |
| Height arithmetic | `5 × 27 + 4 × 27 = 243` |
| Radius | `var(--radius-full)` = 9999px — **built as `calc(infinity * 1px)`** |
| Padding / border / shadow | none |
| `margin-top` in rail | `19.5px` |

| Index | Fill token | Hex |
|---|---|---|
| 1 | `--color-pen-black` | `#0A0A0A` |
| 2 | `--color-pen-violet` | `#6051DC` |
| 3 | `--color-pen-blue` | `#0155FB` |
| 4 | `--color-pen-green` | `#40A365` |
| 5 | `--color-pen-red` | `#E33E38` |

**Tap-target maths (do not change):** the swatch is 27, but the effective hit area is the full **54pt pitch**. The 27pt gap *is* the other half of the target. Halving the gap to tidy the grid halves the tap target.

**No selected/active swatch state is drawn or specified on this board.**

---

## 4. Stroke thickness — `Stroke thickness`

**Purpose:** a passive sample of the current stroke weight, not a slider. Layer path: `Tool rail / Thickness`.

> **Designer rationale (verbatim):** "A single fully-rounded bar that samples the stroke weight rather than showing a slider — one mark instead of a control cluster. It is the only item in the rail that breaks the 54pt slot grid, which is why it is bracketed by unusually large 28pt and 20pt margins: those exist to re-centre it optically, not as arbitrary spacing."

| Property | Value |
|---|---|
| Size | **36 × 5** (no token) |
| Radius | **`2.5px`** (no token) — *exactly half the height, so the caps are semicircles* |
| Fill | `var(--color-pen-black)` = `#0A0A0A` |
| Border / shadow | none |
| Padding / gap | n/a (leaf) |
| `margin-top` in rail | **`29px`** |
| `margin-top` of the *next* child (`tool/center`) | **`19.5px`** |
| `flex-shrink` | `0` |

⚠️ **Contradiction between prose and build:** the blurb says the bar is bracketed by "**28pt and 20pt** margins". The built values are **29** above and **19.5** below. The built values are what the rail's verified 627.5 total depends on — **use 29 / 19.5**; treat "28 / 20" as prose approximation.

**No states documented** — the bar has no interactive states on this board, and no variant for different stroke weights is drawn (only one 5pt sample).

---

## 5. Tutor panel shell — `Tutor panel shell`

**Purpose:** the fixed-width right-hand tutor surface. Layer path: `05 — Board + Tutor (no chrome) / Tutor chat`.

> **Designer rationale (verbatim):** "The panel is the only fixed-width surface in the product, and everything inside it is laid out against one derived number: panel width minus twice the panel inset equals the content width. Hard-coding 301 anywhere is a bug waiting for the first panel-width change. The specimen below is 1:1 in width with the height truncated — the live panel is 976 tall."

| Property | Value |
|---|---|
| Size | `var(--container-panel)` **337 × 976** |
| Padding | `padding-top: var(--space-panel-inset)` = **18px** — **top only**; sides come from the content width, not from padding |
| Bottom inset | **18px emergent, not declared** · board states "children sum to 958 in a 976 box" (see caveat below) |
| Content width | `var(--container-panel-content)` = **301px** |
| **Rule (do not violate)** | `panel 337 − 2 × inset 18 = content 301` · **derive it, never hard-code** |
| Radius | `var(--radius-3xl)` = **28px**, uniform |
| Background | `var(--color-surface-panel)` = `#FCFCFC` |
| Border | none |
| Shadow | **02 Panel** — `#1414320E 0px 3px 10px, #1414320A 0px 1px 3px` |
| Layout | `flex-direction: column; align-items: center; flex-shrink: 0` |
| Position | `absolute left 1011, top 68` · `1376 − 1011 − 337 = 28` edge inset (= `--space-edge`) |

⚠️ **Arithmetic caveat:** `18 (padding-top) + 958 (children) = 976` leaves **0** at the bottom, which cannot produce the stated "18px emergent" bottom inset. The specimen itself demonstrates the intended relationship correctly: a 460-tall panel with `padding-top: 18` and a 424-tall content block leaves exactly 18 at the bottom (`18 + 424 + 18 = 460`). By that rule the live children should sum to **940**, not 958. Flagged in Open questions — implement the *rule* (`content height = panel height − 2 × 18`), not the literal 958.

**Specimen construction** (documentation only, do not ship): outer 337 × **460** panel with the real radius/fill/shadow, containing a 301 × 424 `--color-brand-tint-soft` (`#F1F0FB`) block, radius 14, `gap: 8`, centred, labelled `301` (mono 13/16 weight 500, `--color-brand`) over `CONTENT WIDTH` (sans 12/16 weight 600, tracking 0.06em, `--color-ink-tertiary`).

**Not present on this artboard:** the panel **header**, the panel **scroll fade / gradient mask**, and the message list. See Open questions.

---

## 6. Panel controls — `Panel controls — dock / full-screen`

**Purpose:** the two-button row that docks the tutor or takes it full-screen. Layer path: `Tutor chat / Panel controls / btn/dock · btn/full-screen`.

> **Designer rationale (verbatim, a "do not change this" note):** "Both glyphs are outline only. An earlier version filled the smaller region of the dock glyph and everyone read it as a battery-percentage indicator, so the fill was removed and the two icons were made the same rect differing by a single divider stroke. **Do not reintroduce a fill to 'show which pane is active' — that is the exact change that was rejected.**"

| Property | Value |
|---|---|
| Group size | **301 × 32** (= `--container-panel-content`) |
| Group layout | `display: flex; align-items: center; justify-content: flex-start` |
| Group gap | **`14px`** — no token |
| Button size | **32 × 32** each, `flex-shrink: 0` |
| Button padding | `0`; glyph centred by flex (`align-items/justify-content: center`) |
| Button radius | none |
| Button fill | **none** |
| Button border | none |
| Button shadow | **none** |
| Icon slot | **28 × 28**, `viewBox 0 0 28 28`, `fill="none"`, `stroke: var(--color-icon)`, `stroke-width: 2.1` |

Glyphs (identical rect; the dock variant adds one divider stroke):

```svg
<!-- btn/dock -->
<rect x="3.5" y="5.5" width="21" height="17" rx="5" fill="none" stroke="var(--color-icon)" stroke-width="2.1"/>
<path d="M11.2 5.5V22.5" fill="none" stroke="var(--color-icon)" stroke-width="2.1"/>

<!-- btn/full-screen — identical rect, divider omitted -->
<rect x="3.5" y="5.5" width="21" height="17" rx="5" fill="none" stroke="var(--color-icon)" stroke-width="2.1"/>
```

**No selected/active/pressed/disabled state is specified** — and per the rationale above, an active state must **not** be expressed as a glyph fill.

**Tap target note:** the 32 × 32 button is smaller than the 44pt HIG minimum; the board does not state an expanded hit area. Flagged in Open questions.

### 6.1 The header's leading slot — `btn/sidebar-toggle`

Board 17 empties the chat header and refills it. The session-title dropdown and the settings
gear both leave; the drawer owns both. What takes the gear's leading slot is a sidebar toggle.
Verbatim, from `note/17 — header after`: *"A sidebar-toggle icon takes the leading slot the gear
held — it opens the drawer, and it is the discoverable alternative to the swipe. The full-screen
and minimize pair stays trailing, and it belongs to the dock: it holds this position while the
drawer opens, above both panes. The toggle belongs to the chat pane, so it travels with the chat
and fades out."*

So the header row is one 301 × 32 lane with two ends and two owners: `btn/sidebar-toggle`
leading, the layout pair trailing, and the same 32pt button, 28pt glyph slot and expanded 44pt
tap target on all three. Read off `note/17 — header crop`.

| Property | Value |
|---|---|
| Button size | **32 × 32**, at `left: 0` of the 301 row |
| Icon slot | **28 × 28**, `viewBox 0 0 28 28`, `fill="none"`, `stroke: var(--color-icon)`, `stroke-width: 2` |
| Effective stroke | **2.00** — authored at its render size, so the scale is 1.0 and nothing is re-derived |
| Fill / radius / border / shadow | none, like everything else on this row |
| Tap target | **44 × 44**, expanded the way the layout pair's is — one row, one target size |

```svg
<!-- ui/sidebar-toggle -->
<path d="M4 10.5 H17" fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round"/>
<path d="M4 17 H12"   fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round"/>
```

Two left-aligned lines, 13 units and 8 — a list whose last line is short, which is the shape the
drawer's own session rows make. It is the twenty-seventh product glyph; `design/icons.json`
carries it and `IconPaths.swift` is generated from that.

**Docked, it travels and fades.** It is content of the chat pane, not chrome of the dock, so it
takes the pane's whole translation and goes to nothing early — see §14.1. Tapping it opens the
drawer on the spring a fling opens it with, so the tap and the swipe end the same way.

**Full screen, it neither travels away nor fades — see §14.2.**

---

## 7. Collapsed dock — `Tutor dock · collapsed`

**Purpose:** what the tutor becomes when collapsed — a selection button plus the orb, anchored to the board. Layer path: `06 — Board + Tutor collapsed / Tutor dock · collapsed`.

> **Designer rationale (verbatim):** "When the tutor collapses, the dock anchors to the board, not the screen: 24pt inside the board's bottom-right corner. Measured from the screen edge the same position reads 52pt, which is a number that quietly breaks the moment the board's own 28pt inset changes. Anchor to the board rect and the dock follows it for free."

| Property | Value |
|---|---|
| Group size | **132 × 64** — `btn/select` 52 + gap 16 + `btn/orb` 64. **The orb sets the row height.** |
| Group layout | `display: flex; align-items: center` |
| Group gap | `var(--spacing-4)` = **16px** |
| Position | `var(--space-gap)` **24 inside the board's bottom-right** · absolute `1192, 916` vs board `124, 28, 1224 × 976` |
| Group padding / radius / fill | none |

Verified anchoring arithmetic: board right = `124 + 1224 = 1348`; `1348 − 1192 = 156 = 132 + 24` ✅. Board bottom = `28 + 976 = 1004`; `1004 − 916 = 88 = 64 + 24` ✅. Screen-edge reading = `28 (--space-edge) + 24 = 52` ✅.

**The dock is one surface with the docked panel, not a separate region.** A left-swipe on the
panel minimises to it and a right-swipe from the screen's leading edge brings the panel back,
so both have to be on screen while a finger is between them — see §15.1. `btn/orb` runs the
same spring the swipe settles on.

### `btn/select` (52 × 52)

| Property | Value |
|---|---|
| Size | **52 × 52**, `flex-shrink: 0` |
| Layout | flex, centred |
| Radius | `var(--radius-full)` — **built as `calc(infinity * 1px)`** |
| Fill | `var(--color-surface)` = `#FFFFFF` |
| Border | none |
| Shadow | **`#1414320F 0px 2px 6px, #1414320A 0px 1px 2px`** |
| Icon | **24 × 24**, `viewBox 0 0 24 24` — dashed lasso rect |

```svg
<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4" fill="none"
      stroke="var(--color-icon)" stroke-width="2" stroke-dasharray="4.6 3.9"/>
```

### 🔴 Drift note (the board's only "drift" row — Elevation row, verbatim)

> `btn/select #1414320F 0 2 6, #1414320A 0 1 2 · drifts from 03 Control (0D / 08)`

Read: the shipped `btn/select` shadow uses alpha **`0F`** on the first layer and **`0A`** on the second, whereas the named **03 Control** elevation level specifies **`0D` / `08`**. This is a live, *unresolved* drift — unlike the tool rail's regression, the board does **not** mark it RESOLVED. Implement `0F / 0A` to match the file as built, and treat the mismatch as a known open issue.

### `btn/orb` (64 × 64)

Fill **none**; it is the orb component, not an icon. See §11 (`dock 64` size). Its halo is `130 × 128` at `left −33 / top −32`.

---

## 8. Whiteboard canvas — `Whiteboard canvas`

**Purpose:** the drawing surface. Layer paths: `05 / Whiteboard canvas` and `06 / Whiteboard canvas`.

> **Designer rationale (verbatim):** "The board keeps a constant 976pt height and a constant top-left origin in every state; only its width changes when the tutor docks or collapses. That is what lets the ink layer stay put instead of reflowing — the board is resized from the right edge, never re-laid-out."

| Property | Value |
|---|---|
| Size — docked | **863 × 976** |
| Size — collapsed | **1224 × 976** |
| Position | `absolute 124, 68` **in both states — origin never moves** |
| Radius | `var(--radius-3xl)` = **28px**, uniform |
| Background | `var(--color-surface-canvas)` = `#FAFAFA` |
| Border | none |
| Shadow | **01 Canvas** — `#14143209 0px 2px 6px` (single layer) |
| Overflow | **`clip`** — ink and grid are clipped by the radius |
| `position` (computed) | `relative`, `flex-shrink: 0` |

Verified geometry: `x = 124 = --space-edge 28 + --container-rail 72 + --space-gap 24` ✅.
Docked right edge `124 + 863 = 987`; panel starts at `1011` → `24` gap (`--space-gap`) ✅.
Collapsed right edge `124 + 1224 = 1348`; `1376 − 1348 = 28` (`--space-edge`) ✅.

**Canvas layers:** a `Dot grid` layer (§9) and a `Handwritten ink` layer (548 × 641 in the specimen). The ink is sample board content only—not typography, chrome, or a visual-style direction; no spec rows exist for it.

---

## 9. Dot grid — `Dot grid`

**Purpose:** the canvas background texture. Layer path: `Whiteboard canvas / Dot grid`.

| Property | Value |
|---|---|
| Build | **SVG `<pattern patternUnits="userSpaceOnUse">` painted onto a full-bleed rect, used as `background-image` — not a tiled CSS gradient** |
| Pitch | **`23.9 × 24.5`** — no token — **NOT square, and not 24** |
| Dot | `<circle cx="1.4" cy="1.4" r="1.4">` · **2.8px diameter** |
| Fill | **`#F1F1F1`** — no token — *close to but not* `var(--color-divider)` `#EFEFEF` |
| Size | `absolute 0,0` · fills the board: **863 × 976 docked, 1224 × 976 collapsed** |
| Computed `background-size` | **`round(100%, 0.5px) round(100%, 0.5px)`** |
| Computed `background-position` | `50%` · `background-repeat: no-repeat` |

⚠️ **Caution (verbatim):** "background-size is 100%, so the asset **STRETCHES** with the board · both boards ship a separate SVG at their own width to keep the pitch true."

**Implementation consequence for Swift:** do not scale one grid asset between docked and collapsed widths. Either ship two assets (863-wide and 1224-wide) or draw the dots procedurally at a true `23.9 × 24.5` pitch.

*Note:* the spec row says "background-size is 100%", but the computed value is `round(100%, 0.5px) round(100%, 0.5px)` — a Paper-specific rounding wrapper. The behaviour (stretch to fill) is the same.

---

## 10. Board peek — `Board peek`

**Purpose:** the 68pt sliver of the board that remains visible when the tutor is full-screen. Layer path: `07 — Tutor · full screen / Board peek`.

> **Designer rationale (verbatim):** "In the full-screen tutor the board is not gone, it is hinged off-screen — a 68pt sliver keeps the board present so returning to it feels like closing a door, not loading a screen. Two things about the construction are load-bearing. The silhouette is a single concave-fillet path, not a rounded rectangle: the notch is what reads as a hinge. And Paper silently drops box-shadow on SVG paths, so the elevation is faked by duplicating the same path, filling it #141432, offsetting it 3 / 2 and applying blur(5px) at 11% opacity. A port that assigns a real shadow to the vector will look different from this file."

| Property | Value |
|---|---|
| Size | **68 × 976** — no token |
| Position | `absolute left 0, top 68` — **flush to the screen's left edge, intentionally** (no 28pt edge inset here) |
| Parts (z-order) | `Edge shadow` → `Board edge` (`Edge shape` + `Dot grid`) → `Board hinge icon` |
| Edge shape | `viewBox 0 0 68 976` · fill `var(--color-surface-canvas)` (`#FAFAFA`) · **all arcs r = 18** · the 0-sweep arc at `46,64 → 28,82` is the concave fillet |
| Elevation | **faked** — duplicate path, fill `#141432`, `absolute left 3 top 2`, `filter: blur(5px)`, `opacity: 0.11` |
| Grid | **51 × 934** · **explicit circles, not a pattern** · columns at `x 0 / 23.9 / 47.8`, rows step **24.5**, `r 1.4`, `#F1F1F1` |
| Icon | `Board hinge icon` **22 × 20** · `absolute left 23, top 22` · rect + 6 circles |
| Radius / border | none — the silhouette *is* the path |

**Exact `Edge shape` path `d`:**

```
M0,0 H50 A18,18 0 0 1 68,18 V46 A18,18 0 0 1 50,64 H46 A18,18 0 0 0 28,82 V958 A18,18 0 0 1 10,976 H0 Z
```

**Implementation consequence for Swift:** a `CAShapeLayer`/`Path` with a real `shadow` will not match this file. To match, replicate the fake: draw the same path filled `#141432`, offset `(3, 2)`, blur radius 5, alpha 0.11, beneath the real path.

**No states documented.** The peek has no default/pressed/disabled variants on this board.

---

## 11. Orb — `Orb — hero / panel / dock / thread`

**Purpose:** the tutor's identity mark, at four sizes. Layer paths: `07 / Orb · hero` — `05 / Tutor chat / Orb` — `06 / Tutor dock / btn/orb` — `10 / btn/orb`.

> **Designer rationale (verbatim):** "The orb is sized by free space, not by layout slot. While the thread still has whitespace it stays large and does the greeting; once messages fill the panel it shrinks to the 46pt thread size and becomes a marker above the composer. **Treat the four sizes as one adaptive component driven by remaining space — not as four separate assets to pick between.**"

### The four sizes

| Variant | Frame | Body | Eyes | Eye gap | Extras |
|---|---|---|---|---|---|
| **hero** | **150 × 142** | 84 × 66 | **11** — `position: absolute` at `left 20 / 53`, `top 22` | n/a (absolute) | **has Smile** |
| **panel** | **96 × 90** | 54 × 42 | 7 | `gap: 18`, `padding-top: 5` | — |
| **dock** | **64 × 64** | 44 × 34 | 5.5 | `gap: 14`, `padding-top: 4` | — |
| **thread** | **46 × 46** | 32 × 25 | 4 | `gap: 10`, `padding-top: 3` | — |

Body layout for panel/dock/thread: `display: flex; align-items: center; justify-content: center; position: relative; flex-shrink: 0`. Hero body is `position: relative` with absolutely-placed eyes and smile.

**Hero smile** (only on hero): wrapper `absolute left 33, top 40`, SVG `18 × 10`, `viewBox 0 0 18 10`:

```svg
<path d="M1.6 1.6C4 6.4 14 6.4 16.4 1.6" fill="none" stroke="#FFFFFF"
      stroke-width="2.4" stroke-linecap="round"/>
```

### Body fill (identical at all four sizes)

```css
background-image: linear-gradient(in oklab 180deg,
  oklab(25.4% -0.001 -0.053) 0%,
  oklab(17.5% -0.009 -0.032) 46%,
  oklab(13% -0.010 -0.019) 100%);
```

Eyes: `#FFFFFF`. **No tokens** for either. Radius on body and eyes: `var(--radius-full)`, built as `calc(infinity * 1px)` — **the body is a squashed pill, not a circle.**

### Halo

`position: absolute`, roughly **2× the frame, negatively offset**, `box-sizing: border-box`:

| Variant | Halo size | Offset |
|---|---|---|
| hero | **296 × 282** | `left −73, top −77` |
| panel | **190 × 180** | `left −47, top −49` |
| dock | **130 × 128** | `left −33, top −32` |
| thread | **94 × 92** | `left −24, top −23` *(measured; the board's spec row omits the thread offset)* |

**Halo fill — three stacked oklab radial-gradients. Alphas and the third ellipse's size differ per size; this is NOT a single scalable asset.**

Hero (alphas 78% / 74%):
```css
background-image:
  radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 78%) 0%, oklab(89.8% 0.036 -0.034 / 36%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%),
  radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 74%) 0%, oklab(90.5% .0006 -0.038 / 32%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%),
  radial-gradient(ellipse 28.000000000000004% 27% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%);
```

Panel (alphas 75% / 70%; third ellipse `27% 26%`):
```css
background-image:
  radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 75%) 0%, oklab(89.8% 0.036 -0.034 / 34%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%),
  radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 70%) 0%, oklab(90.5% .0006 -0.038 / 30%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%),
  radial-gradient(ellipse 27% 26% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%);
```

Dock **and** thread (alphas 75% / 70%; third ellipse `28.999999999999996% 28.000000000000004%`):
```css
background-image:
  radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 75%) 0%, oklab(89.8% 0.036 -0.034 / 34%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%),
  radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 70%) 0%, oklab(90.5% .0006 -0.038 / 30%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%),
  radial-gradient(ellipse 28.999999999999996% 28.000000000000004% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%);
```

The long decimals (`57.99999999999999`, `28.000000000000004`) are the literal computed values. **Do not convert these gradients out of the oklab colour space** — the board specifies `in oklab` interpolation explicitly.

**Elevation:** `none — the halo does the lifting`.

**Board's spec row (verbatim):** "three stacked oklab radial-gradients · alphas differ per size (hero 78/74%, others 75/70%) — not a single scalable asset".

---

## 12. Screen geometry summary (derived from the board, all verified)

| Value | Source |
|---|---|
| Screen | `1376 × 1032` (`--container-screen`) |
| Edge inset | `28` (`--space-edge`) |
| Rail width | `72` (`--container-rail`), height `627.5` |
| Board origin | `124, 68` in every state (`28 + 72 + 24`) |
| Board size | `863 × 976` docked · `1224 × 976` collapsed |
| Board↔panel gap | `24` (`--space-gap`) |
| Panel | `337 × 976` at `1011, 28` |
| Collapsed dock | `132 × 64` at `1192, 916` (24 inside board's bottom-right) |
| Board peek | `68 × 976` at `0, 28` (flush left, no edge inset) |

---

## 13. Documentation-board typography (board chrome — reference only, not product UI)

| Role | Font | Size / weight / leading | Colour |
|---|---|---|---|
| Board eyebrow | `--font-sans` | 13 / 600 / 16, tracking `0.06em` | `--color-ink-tertiary` |
| Board title | `--font-doc` | 40 / 600 / 48, tracking `-0.01em` | `--color-ink` |
| Board blurb | `--font-sans` | 17 / 400 / 26, width 860 | `--color-ink-secondary` |
| Section eyebrow | `--font-sans` | 13 / 600 / 16, tracking `0.06em` | `--color-ink-tertiary` |
| Section title | `--font-doc` | 34 / 600 / 42, tracking `-0.01em` | `--color-ink` |
| Section blurb | `--font-sans` | 17 / 400 / 26, width 860 | `--color-ink-secondary` |
| Spec card name | `--font-sans` | 19 / 600 / 24, `padding-bottom: 14` | `--color-ink` |
| Spec row label | `--font-sans` | 15 / 400 / 18 | `--color-ink-secondary` |
| Spec row value | `--font-mono` | 15 / 500 / 22, right-aligned | `--color-ink` |
| Spec row frame | — | `padding-block: 9`, `gap: 24`, `justify-content: space-between`, `align-items: baseline`, rule `box-shadow: var(--color-divider) 0 1px 0` | — |
| Specimen stage | — | bg `--color-surface-screen`, radius `20`, `padding: 44` | — |
| Section layout | — | column `gap: 36`; head→specimen row `gap: 48`, `align-items: flex-start` | — |

---

## 14. Sessions drawer — `Sessions drawer` (boards 17 · 18 · 19)

**Purpose:** the whole of the sessions UI, and the home of Settings. It replaces board 15a's
header dropdown, which is deleted. Layer paths: `17 — Sessions drawer · docked open / Tutor
panel / Sessions drawer`, and `19 — Sessions drawer · full screen / Sessions drawer`.

One component at two frames. The contents are identical; only the frame and its inset differ,
and the content column is derived from the frame the way the panel's 301 is derived from its
337 — `SessionsDrawerMetrics.contentWidth(for:inset:)`.

| Property | Docked (board 17) | Full screen (board 19) |
|---|---|---|
| Frame | **263 × 976**, inside the panel at local `(0, 0)` | **296 × 1032**, against the leading screen edge |
| Width rule | `panel × 0.78`, rounded — **derive it**, the panel resizes | `240 + 2 × 28`. Board 19 draws **372**; that is 20% wider than its contents need, and at that width the sidebar reads as having taken a fifth of the screen to say very little. The content column leads and the frame follows it. It is 13 more than the docked drawer's 227, and the two are deliberately not reconciled: each column is its own frame less its own inset, and one of those frames is a fraction of a resizable panel. |
| Padding | **`18` all round** (`--space-panel-inset`) | `28` (`--space-edge`) all round |
| Content column | **227** | **240** |
| Background | `--color-surface-panel` — the panel's own, so the seam is a corner and not a colour change | the screen's `--color-surface-screen`; the drawer paints no fill |
| Radius / shadow | none, either frame — the panel's own clip and elevation cover the docked case, and the full-screen sidebar is a lane rather than a surface |

**The docked inline inset was 12 and is now 18.** The old value was argued from the text: the
rows carry their own `12`, and `12 + 12` is the `24` a row's title sits at. That measured the
wrong edge. What the eye lands on is the row's **box** — the current session is filled
`--color-brand-tint`, and `New chat` is a pill — and those fills were sitting 12 from a surface
whose corner radius is 28, which reads as touching the corner. Both axes are now
`--space-panel-inset`, the inset everything else in the panel is placed on; the row's own 12 is
unchanged, so titles land at 30 and the drawer still reads down one left edge. The full-screen
sidebar is untouched: its inset is `--space-edge` and its column is still 240.

**Contents**, top to bottom, in the content column:

| Element | Spec |
|---|---|
| `Drawer header` | `44` tall, `padding-left 12`, `padding-right 8`. Wordmark "AI Tutor", 17 / 22 weight 600, `--tracking-tight`, `--color-ink`, and **nothing else**. Board 17 first drew a `30 × 24` halo-less orb beside it; the design has taken it out. The band keeps its height and its insets, so the wordmark sits on the rows' own left edge and the drawer opens on one left edge rather than two. |
| `Label · Recent` | `margin-top 26`, `padding-left 12`. "RECENT", 15 / 18 weight 600, `--tracking-wide` (0.06em), uppercase, `--color-ink-tertiary`. **The first all-caps label in the product** — `--tracking-wide` stopped being documentation-only for it. |
| `Session list` | `margin-top 10`, `gap 2`. |
| `row/session` | `44` tall, `--radius-sm` 10, `padding-inline 12`. Title 17 / 22, weight 500, and **nothing else** — the 18pt board glyph that sat in a fixed slot before it is gone with the header's orb. With no slot and no gap the title starts on the row's own 12pt inset, which is where the wordmark starts, so the drawer reads down one left edge. |
| `row/session` · held | Under a finger, a row lifts: 03 · Control shadow at the row's own 10pt radius, scaled 1.02 over 180ms. A row with no tint takes `--color-surface` while held rather than staying transparent — **opaque is the point, not the colour**: a lifted row with nothing behind it shows the drawer through its own shadow and reads as greyed out, which is the fault the system's own context-menu preview had. |
| `row/session · current` | Same box, filled `--color-brand-tint` `#E6E3F9`; glyph and title both `--color-brand`, title weight 600. The drawer names the open session by marking it, since the title that used to say so in words is gone. |
| `row/session` · long press | The **system context menu**, one destructive **Delete**, with the platter's own lift. Not a swipe action or an edit mode — those are `List` affordances and this is not a `List`. Deleting the open session falls back to the most recent one left, or to a fresh empty session when none are. |

**The preview is supplied, not left to the system.** Given nothing, the platter lifts a snapshot
of the row as it sits in the tree: square, because the row's corners belong to a background
whose radius the platter cannot know, and greyed for any row that is not the current one,
because those rows are transparent and the scrim shows through them. Passing a `preview:` of the
row over an opaque fill, clipped to its own 10 pt radius, answers both.

**Cancelling the menu must not open a session, and that takes a guard.** `.contextMenu` is
presented and dismissed entirely by the system, with no callback for either edge, so whether the
tap that cancels it is swallowed or falls through to a row underneath is the platform's
decision — and on iPadOS 17 it falls through. A confirmation dialog the drawer owned outright
was tried and rejected: it closed the leak by replacing the interaction, and the interaction was
the part worth keeping.

So the drawer infers the menu instead. A long press of its own runs early against the same touch
(0.35 s, deliberately inside `UIContextMenuInteraction`'s ~0.5 s commit, because the interaction
cancels every other recogniser when it takes the touch — a detector on the system's own
threshold would be cancelled instead of firing). From then until a tap arrives, a transparent
layer over the whole drawer swallows taps rather than letting them act, and holds for a further
0.35 s while the menu animates away. Every way the inference can be wrong costs one swallowed
tap and none of them can switch a session.

A row's tap is a `DragGesture` whose translation must be within 10 pt, not a `Button` — evidence
the row holds itself, which nothing outside it has to notice in time. Lifting after a menu opens
never reaches it, because the interaction cancels the drag and a cancelled drag never ends.
| `Drawer bottom bar` | `44` tall, on the content column, `justify-content: space-between`, one inset up from the floor (docked `top 914`, full screen `top 960`). |
| `btn/new-chat` | Bottom **left**. `44` tall pill, `--color-brand` fill, `--radius-full`, `gap 8`, `padding-left 16`, `padding-right 20`. Glyph `ui/plus` `20 × 20` white, label "New chat" 17 / 22 weight 600 white. Shadow `#6051DC33 0 4 12` + `#14143214 0 1 2`. |
| `btn/settings` | Bottom **right**. `44 × 44` `--color-surface` circle, glyph `control/settings` at 24, elevation 03 · Control. Already at the tap-target minimum, so unlike the panel's 32pt controls it needs no expansion. **It leaves the drawer open**: Settings is a window over the whole screen and it is reached from here, so closing the thing you opened it from returns you somewhere you were not. Every other action in this drawer replaces what the chat is showing, which is why they all close it and this one does not. |

> **The one non-neutral shadow in the product.** §0 of `01-foundations.md` states that every
> shadow is `--color-shadow` at one of five alphas. `btn/new-chat`'s outer layer is the brand
> violet at 20%. It is not an oversight: every other shadow separates a near-white surface from
> a near-white surface, and this one falls under the only saturated fill in the product, where a
> neutral grey reads as dirt. Carried at the call site rather than added to the elevation scale,
> so the scale keeps saying what it says.

### 14.1 The docked reveal (board 18)

The drawer is **revealed**, not pushed in. It sits still at the panel's leading edge and the
chat pane travels over it.

| Property | Value |
|---|---|
| Travel | **263** — the drawer's own width, 78% of the panel |
| Chat strip left visible | **74** = `337 − 263` |
| Chat pane radius while revealed | `--radius-2xl` **20**, leading two corners only. Tighter than the panel's 28 because the two surfaces touch. |
| Shadow at the seam | **none** — the panel's outer elevation is unchanged and nothing is added between the panes |
| Drawer parallax | Board 18 says **12**; **not implemented** — see below |

**The layout pair does not move.** `btn/full-screen` and `btn/dock` stay at the panel's own
top-right header position in every drawer state, painted over both panes — they are chrome of
the dock, not content of the chat. They were a child of the chat pane until it was drawn against
the device: the pair travelled with it, slid 263 pt right and then clipped in half at the pane's
leading edge, so the one control that puts the panel away was cut in two exactly while the
drawer was open over it. Boards 17 and 18 draw it unmoved in both frames. It still lays out in
the chat's 301 pt content column, because that column is what puts the pair on the panel's 18 pt
trailing inset — the column does not move, only the pane that usually fills it does. It sits
inside the reveal container rather than beside it, so a committed pan cancels a press on it like
anything else.

**The sidebar toggle does move, and it is gone before it gets anywhere.** Board 18: *"The
sidebar-toggle icon belongs to the chat pane and travels with it, so it fades out quickly: it is
fully transparent by 30–40% of the travel, well before it could reach the fixed minimize and
full-screen pair in the dock corner."* The implementation takes **0.35**, the middle of that
band, and keeps it in `DrawerReveal` beside the veil constants so the two curves are read
together: at 0.35 the chat has just started taking the wash, so the toggle clears rather than
dimming inside it. The ramp is linear where the veils are smoothstepped — one mark leaving is
not a crossfade, and easing its start would hold it at nearly full strength through exactly the
part of the swipe the note wants it already leaving. **Opacity is also the hit test**: nothing
is tappable at zero, so there is one number and not two.

It cannot be a child of the chat pane, even though it belongs to it. The pane is a stored view
value that a drag must never rebuild — that is the rule `DrawerRevealLayer` exists to keep — and
this control's opacity is a function of the drag. It gets its own slot in the layer instead: the
view is stored like the panes are, and the offset and the opacity are applied from outside, at
two modifiers a frame.

**The parallax is deliberately not implemented.** It is a pure translation of the whole
drawer — nothing inside it resizes — and on the artboard it reads as intended, a layer sliding
up from underneath. On the device it does not, because board 17 gives the drawer and the panel
the *same fill*, deliberately, so the seam can be the chat's rounded corner and nothing else. A
surface with no visible edge gives the eye nothing to attach the movement to, so the only
reference left is the panel's own edge — and 12 pt of content moving away from a fixed edge is
indistinguishable from 12 pt of padding growing. It was reported as the drawer's margins
changing during the swipe. The drawer therefore stays still and only the chat travels. If the
drawer is ever given a fill of its own the parallax becomes legible and is worth restoring.

Both panes translate by **whole points**. Each is rasterised by a compositing group, and
translating a raster by a fraction resamples every glyph in it differently on each frame, which
on an A10 at 2x reads as the contents shimmering rather than sliding.

**White veil crossfade.** A white overlay washes whichever pane is inactive; the surface colour
never changes. At rest the **drawer** carries `55%`. Across `20% → 30%` of the travel the two
reverse. From there the **chat** carries it, reaching `55%` fully open, and passing through
`30%` at the 42% of travel board 18 draws (`#FFFFFF4D` on a 226pt strip). The second leg is
eased rather than linear so all three of the design's published frames are reproduced — see
`DrawerReveal.chatVeil(at:)`.

**Gesture.** A right-swipe anywhere in the chat area opens it; a left-swipe closes it, **and
that one may start on either pane** — on the 74 pt chat strip, or on a session row inside the
drawer itself. The pane tracks the finger one-to-one either way, and a tap on the chat strip
also closes it.

The first **12 pt** of travel decide the axis, and a start within **38°** of horizontal commits
to the pan. The angle is wider than board 18's stated 10–15°: a thumb swiping across a 337 pt
panel on a two-handed iPad travels on an arc, and at 15° a 100 pt swipe was rejected for 27 pt
of drift — less drift than the thumb's own pivot produces. 38° is dominant-axis (45°) with a
modest bias kept for the scroller. The distance stayed at 12, because a slow swipe crosses 12 pt
just as surely as a fast one and a shorter vector has no meaningful angle to measure. Anything
steeper scrolls the list under the finger and the drawer takes nothing from the touch.

On release it settles by velocity first — a fling over **300 pt/s** decides the direction
outright — and by the 50% line otherwise. 300 rather than board 18's 400: an unhurried swipe
that stopped 90 pt into the 263 while still moving at 350 sprang back, which reads as the
gesture having been missed rather than judged.

**A swipe must not press what it crosses, and one mechanism does all of it.** A `Button` fires
on touch-*up* and cancels only when the finger leaves its bounds, which never happens here: a
session row is 227 × 44 and a chip is 301 × 62, so a whole 100 pt swipe starts and ends inside
one control. Without a guard, a left-swipe out of the drawer opened whichever session it
crossed.

Three generations of SwiftUI-side fixes could not close it — per-control `.disabled` lists
missed controls, container `allowsHitTesting` cannot reach a press already in flight on
iPadOS 17, and structural `.disabled` groups had to exempt the composer, because `.disabled`
resigns a focused `TextField` and drops the keyboard. That exemption was the last hole.

The mechanism that replaced all of them is `DrawerPanRecognizer`, a `UIGestureRecognizer` that
owns the whole horizontal axis and does what `UIScrollView` does: at the instant the touch
commits, **every other recogniser analysing that touch is cancelled at the UIKit level**. That
kills an in-flight SwiftUI press natively, composer included, without disabling anything — touch
cancellation does not resign first responder, so the keyboard stays up mid-sentence. Because
commitment is a property of the *touch* and not of the drawer, it fires just the same at a
travel boundary where the pan produces no visible motion. A vertical start fails fast, so
scrolling is exactly what it was, and a tap never travels 12 pt so it never meets the recogniser
at all.

Two SwiftUI-side guards remain, and both are about the *other* fingers rather than the
committing one: `allowsHitTesting(false)` over the panes stops a second finger picking up a
control mid-pan, and `scrollDisabled` stops it scrolling a list the pan is sliding.

**This recogniser is the single mechanism for horizontal gestures and press cancellation.**
Extend it — add regions, add routes — and never add a rival SwiftUI gesture or re-add a
SwiftUI-level press guard.

**The session rows need neither guard.** They are a plain view with a `LongPressGesture` and a
`DragGesture`, not a `Button`, so the row proves for itself that a swipe was not a tap: the
drag's own translation has to be within 10 pt for the tap to count. Evidence the row already
holds cannot be raced by anything that failed to switch it off in time. The hold is checked
first — `LongPressGesture` ends half a second in with the finger still down, so a lift after a
hold cannot also open the session.

### 14.2 The full-screen sidebar (board 19)

**Persistent, not modal.** The chat does not move, dim, or clip; both panes are active at the
same time and neither carries a veil.

- Ground becomes `--color-surface-screen` `#F8F8F8`; the chat is a `--color-surface` pane with
  `--radius-3xl` **28** on its leading corners. *"That edge carries the boundary, so there is
  no divider rule."*
- The reading column re-centres in what the sidebar and the board peek leave:
  region `1308 − 296 = 1012`, column `min(740, 1012 − 56) = 740`, margins `136`, so
  `x = 296 + 136 = 432`. Same rule as screen 07, one more term —
  `ScreenLayout.columnX(reserving:)`.
- **The pan surface is the whole screen**, stated with an explicit frame rather than inferred
  from the children. Every child of this screen is placed by `.offset`, and an offset moves a
  view without telling its parent — so the stack was only as wide as its widest *laid-out*
  child (the chat pane, or in the greeting state the 740 pt column), and a swipe starting right
  of that reached nothing. The board peek keeps its own tap: it is painted after the tutor in
  `BoardScreen`, so it hit-tests first.
- The board peek is untouched at `(1308, 28)`.
- **It is remembered across presentation changes**, and the docked drawer is not. Coming back
  to full screen restores the sidebar exactly as it was left; coming back to the docked panel
  always lands on the full chat. The two are separate flags on `UIState`
  (`isSessionsSidebarOpen` / `isSessionsDrawerOpen`) for that reason. The docked drawer covers
  78% of the panel, so arriving behind an open one is arriving with the conversation already
  hidden; the sidebar covers nothing and re-centres the column beside it, so it is a layout the
  learner chose rather than a detour they forgot to leave. Remembered for the run only — like
  every other axis on `UIState`, it never reaches the session JSON.
- **Choosing from it does not close it.** Picking a session, or `New chat`, leaves the sidebar
  open; only a left-swipe closes it. Board 19 keeps both panes live at once, so a pick is using
  the sidebar rather than finishing with it, and closing would make the learner re-open it to
  make a second comparison — the case a persistent sidebar exists for. The docked drawer is the
  opposite and still closes on a pick, because there the list is covering the chat you picked.
- The same right-swipe opens it, and a left-swipe closes it — including one that starts inside
  the sidebar, on a session row. It springs rather than tracking the finger: the chat is
  stationary and the column re-centres, so a finger-tracked sidebar would drag 740 points of
  text sideways a frame at a time.
- **`btn/sidebar-toggle` stays, and it is a true toggle here.** Board 19 draws it at `x: 28,
  y: 28` *inside the chat pane*, so it sits at `contentLeft + sidebar` and rides the pane's
  whole movement on the same spring. It never fades: the pane it is on is not dimming, covered
  or clipped, so a control that dimmed would be the only faded thing on the screen — which is
  the one place this surface parts company with the docked panel, where the toggle has to leave
  before 263 points of travel carry it into the dock's corner. Closed → tap opens; open → tap
  closes. It is the only exit besides the left-swipe, because nothing inside the sidebar closes
  it, and the swipe is the gesture on this surface a learner is least likely to find.

---

## 15. Horizontal swipe router — one recogniser, one table

Every horizontal gesture in the shell is the same recogniser (§14.1). What a committed pan
*drives* is decided in one place, `HorizontalSwipeRouter`, as arithmetic rather than as an `if`
inside each surface's `onCommit`.

**Direction is read once, at commitment, and never revisited.** That is the same lock the axis
is, one axis down: a swipe that starts left and curls back right keeps driving the route it
committed to, clamped at its own end of the travel. Re-routing mid-gesture is what would turn
two distinct gestures into one ambiguous one.

**An edge moves the tutor; a surface moves what is inside it.** That is the whole shape of the
table. The two edge zones are the presentation ladder — `collapsed → docked → full screen` going
up, and back down again — and neither of them overlaps a surface the tutor draws, so no touch
has to be arbitrated between the two meanings.

| Presentation | Drawer / sidebar | Direction | Origin | Transition |
|---|---|---|---|---|
| docked | closed | right | **leading edge** | **`enterFullScreen`** |
| docked | open | right | leading edge | `none` |
| docked | — | left | leading edge | as surface |
| docked | closed | right | surface | `openDrawer` |
| docked | closed | **left** | surface | **`collapseDock`** |
| docked | open | left | surface | `closeDrawer` |
| docked | open | right | surface | `none` |
| collapsed | — | right | **leading edge** | **`expandDock`** |
| collapsed | — | right | surface | `none` |
| collapsed | — | left | any | `none` |
| full screen | — | **left** | **trailing edge** | **`enterDocked`** |
| full screen | — | right | trailing edge | `none` |
| full screen | closed | right | surface / leading edge | `openSidebar` |
| full screen | open | left | surface / leading edge | `closeSidebar` |
| full screen | closed | left | surface / leading edge | `none` |
| full screen | open | right | surface / leading edge | `none` |

`none` is a real answer and not a failure: the pan still *committed*, so the presses it crossed
were cancelled. That boundary case is why commitment rather than motion is the trigger.

**The ladder, read off the two edge columns:** collapsed —edge-right→ docked —edge-right→ full
screen going up; full screen —edge-left→ docked —surface-left→ collapsed coming down. The one
asymmetry is deliberate: the rung down from docked is a swipe on the *panel* rather than on an
edge, because the panel is the thing that leaves, and because the drawer has to have the first
claim on a left-swipe made over it.

**There is no collapse while the drawer is open.** The drawer is covering 78% of the panel, so
the first left-swipe is unambiguously about the drawer and the collapse is the swipe after it —
two gestures, never one. `enterFullScreen` answers to the same precedence from the other side:
an open drawer refuses the leading edge's right-swipe too, so a presentation never changes
underneath a drawer the learner has not finished with.

**The sidebar is not the drawer, and the trailing edge does not consult it.** Board 19's sidebar
covers nothing, re-centres the column beside it and survives a presentation change; it is a
layout the learner chose rather than a detour they forgot to leave. A left-swipe 1300 points away
from it is about the board.

### 15.1 The dock swipe (screens 05/08 ↔ screen 06)

| Property | Value |
|---|---|
| Travel | `ScreenLayout.dockTravel` = `panelX + panelWidth`, **365** on the reference screen |
| Direction | the panel leaves by the **leading** edge, the edge it is pinned to |
| Tracking | one-to-one inside the travel, whole points |
| Past either end | rubber-banded, asymptotic to **6%** of the travel |
| Release | velocity first (**300 pt/s**), 50% line otherwise — `DrawerReveal`'s own rule |
| Settle | `DrawerReveal.settle(velocity:travel:)`, seeded with the release velocity |
| Dock fade | starts at `collapsedDockX ÷ dockTravel` = **0.405** on the reference screen |

The rubber band is the one place this parts company with the drawer, which takes a hard clamp
and says why: it lives inside the panel's clip and *"there is nothing past either end to
reveal."* The dock is the opposite case at both ends — past collapsed the panel is being pushed
further off an edge it has already left, past docked it would be pushed off the leading inset —
so the finger keeps producing motion and the motion asymptotes. `x / (1 + x / limit)`, whose
derivative is 1 at the boundary, so there is no corner where the resistance starts and no
second hard stop further out.

**The dock's fade threshold is derived, not chosen.** The panel's trailing edge sits at
`progress × dockTravel` — the travel is measured from the screen's leading edge, so the two are
the same number seen from either side — and the orb is anchored at `collapsedDockX`, *inside*
the panel's lane. The orb is painted over the panel, so it may not fade up until the panel's own
edge has passed it. A constant would be right at 337 pt of panel and wrong at every other width
the student can drag the seam to. The fade is smoothstepped and the slide (one `--space-gap`,
leading) is `1 − opacity`, so the two are one movement by construction.

**Every path to screen 06 runs the same spring.** The swipe, `btn/dock`, the dock's orb, a
resize drag past its floor and `Start on the board` all call
`DockRevealModel.settle(to:velocity:travel:_:)`, which makes the presentation change *inside*
the animation and holds the losing surface mounted until the spring has finished. Before this
the buttons wrote the presentation bare and the panel simply vanished — a fourth behaviour
rather than a fourth control. A tap differs from a release in one value: it has no velocity, so
the spring starts from rest.

The panel and the dock are each mounted only in their own presentation, plus for the duration of
a gesture and the spring after it. Screen 06 gives the board the screen to itself, which is a
performance promise as much as a layout: a message thread left mounted off the leading edge
would still be laid out and drawn on every frame the learner spends inking.

### 15.2 The leading-edge zone

A **24 pt** (`--space-gap`) grab region against the screen's leading edge, mounted in the
collapsed *and* the docked states — it is the up rung of the ladder, and it is the same strip of
screen in both, so the learner keeps swiping right from one place and the tutor keeps growing.

The collapsed screen has no tutor surface to swipe on at all, which is why the zone was written
for it first. The docked state has one, and the zone still does not overlap it: the panel is
pinned at `panelX` = `contentLeft` = `--space-edge`, so the zone stops **4 pt** short of the
panel's own pan region. Nothing has to be arbitrated between them.

Two facts keep it clear of the board, and the width is only the second:

1. In the collapsed lane arithmetic the canvas starts at `boardXCollapsed` — the leading inset,
   the rail and a gap, **124** on the reference screen and never less on any device. The zone is
   24 pt of empty screen grey and does not reach the rail at 28, let alone the canvas. **It does
   not overlap `PKCanvasView` at all.**
2. Where a future layout did put the canvas under it, the intent lock is still the arbitration:
   a stroke that starts vertically fails the recogniser at 12 pt and the canvas keeps the touch,
   and a horizontal commitment cancels the canvas's own recognisers exactly as it cancels a
   button's.

The zone additionally **refuses Apple Pencil touches outright**, at touch-down, before the
recogniser ever enters `.possible`. In this app a pencil is always drawing and never navigating,
and a pencil stroke that started near the edge must reach `PKCanvasView` intact rather than
commit, cancel the canvas and leave a 12 pt orphan of a stroke behind.

A left-swipe that starts in the zone routes as the surface would: the collapse when the panel is
docked, and nothing at all when it is already collapsed, since there is no state to the left of
that. Either way it committed and cancelled whatever it crossed.

**On a window too narrow to dock**, the edge swipe lands where the orb's tap lands — the
full-screen column — because that is the tutor's only home at that size.

**Both rungs track now.** `expandDock` tracks the panel's own travel, and `enterFullScreen`
tracks the presentation morph's (§15.4): board 05 still states the reading column as *a
different variant* of the tutor whose contents have no interpolable intermediate — type scale,
chip layout, composer all change — but the *container* interpolates at every point, and that
is what the finger drags. The release settles on the shared spring by the same velocity-first
rule as every tracked travel, position measured where the finger actually got to.

### 15.3 The trailing-edge zone (screen 07 → screens 05/08)

The board peek's own lane, **45 pt** wide (`BoardPeekMetrics.width`, sourced from the component so
the grab region and the silhouette cannot drift apart), against the screen's trailing edge and
spanning the content band. Left-swipe only.

It takes the whole lane rather than a 24 pt sliver because the lane is already reserved and
already means "the board": `TutorFullScreen` cuts exactly this width out of the sidebar's pan
region so the peek's tap can survive, and `ScreenLayout.columnWidth` reserves it on *both* sides
so the centred reading column never reaches it. Taking the whole lane therefore costs nothing
that was previously reachable, and it puts the swipe on the one piece of screen that already
draws the destination.

| Concern | Why it does not fight |
|---|---|
| The peek's **tap** | a tap never travels the 12 pt intent threshold, so the recogniser never commits and never cancels it; a swipe that does commit cancels the tap natively |
| **Scroll** | the thread is a 740 pt column centred on the screen; nothing scrollable is under this lane |
| The **sidebar** swipe | the sidebar's pan region is the screen less exactly this lane |
| **Apple Pencil** | refused at touch-down, as in the leading zone — a pencil in this app is always drawing and never navigating |
| **Paint order** | the peek is a sibling drawn later by `BoardScreen`, and a UIKit recogniser cannot see SwiftUI paint order, so the lane is stated as geometry instead |

Tracked, for the same reason `enterFullScreen` now is: the swipe drives the presentation morph
(§15.4) from progress `1` downward, so the chat surface's trailing edge follows the finger while
the board's card widens in behind it. **The tap and the swipe are one system**: the tap calls
`BoardScreen.returnToBoardFromPeek(velocity:)`, which runs the identical morph from rest on the
same spring through the same curves. The tap used to write `UIState` bare and the column simply
vanished, which is the fourth-behaviour-rather-than-fourth-control mistake the shared model
exists to end.

**What a presentation change does to the two session lists is unchanged**: the docked drawer
closes (`BoardScreen.onChange(of: presentation)`) and the full-screen sidebar is remembered. See
§14.2.

### 15.4 The presentation morph (screens 05/08 ↔ screen 07)

> **Status: live.** The docked ↔ full-screen transition is a tracked **flight-layer morph**:
> the container scrubs one-to-one with the finger while the shared elements — single
> instances, never pairs that dissolve — travel their own measured paths inside it. The
> first attempt (a whole-surface crossfade inside a morphing clip) was rejected on device
> ("it just fades away without any morphism") and then froze the app; the rebuild is
> engineered against the recorded freeze hypotheses: **mounts are decided only by state
> written outside animation transactions** (gesture commitment, settle completion),
> `animatableData` varies geometry alone, at most **one live `TextField`** exists per
> flight (the other composer renders a chrome `Text` run — `Composer.isInteractive`), and
> focus is resigned at commitment on a main-queue hop, never inside a render transaction.

`PresentationMorph` is the container arithmetic, `PresentationFlight` the per-element paths,
`PresentationMorphModel` the live position (the `DockRevealModel` shape one rung up, observed
by exactly one view), and `PresentationFlightLayer` the region that hosts the board, the
rail, the tutor and the peek — plus, in flight, the morphing container and the flight copies.

The decisive measurement (2026-08-12 research brief): with the reading column at the panel
treatment (`TutorColumnMetrics.liveScale == .panel`, capped at 600) the two endpoints draw
the same components at the same type scale on the same baselines, so the hi state needs no
crossfade, no scale and no snapshot — a translation of **+491.5** at the column's centre and
a widening of the chips and the pill from **301 → 600**. Every glyph keeps its size; the
block walks to the middle of the screen. The thread is the one element whose text re-wraps,
and therefore the one genuine crossfade.

| Track | Value |
|---|---|
| Progress | `0` docked … `1` full screen; pure functions of this one number, so a gesture that turns around retraces its own frames |
| Travel | the container's trailing edge: `screenWidth − dockTravel`, **1011** on the reference screen |
| Release | velocity first (**300 pt/s**), 50% line second — `DrawerReveal.settlesOpen`, delegated; live-finger frames are marked `Transaction.isContinuous`. The arrival spring is `DrawerReveal.settle`'s construction at **damping 26** (`PresentationMorph.settle` — the drawer keeps its 30): damping ratio ~0.73, so the ensemble arrives with a hint of snap |
| Dip | the travelling ensemble breathes: `scale(p) = 1 − 0.05·sin(π·p)` (`PresentationMorph.flightScale`), **exactly 1 at both endpoints** so pixel parity holds, minimum mid-flight. Applied to the flight copies as **one group about one shared anchor** — the container's centre (`flightDipAnchor`) — never per element, which would read as wobble. It rides gesture progress, so a scrub shows the dip under the finger and the settle spring carries the snap back. The **board card takes no counter-dip**: it must read as sliding planarly under the screen edge to become the hinge tab, and its landing on the peek's line is pixel-pinned — the surfaces lift, the ground stays put |
| Container | frame lerps panel → chat pane (sidebar-aware), glued to the finger; corners finish **early** — `0 … 0.75` entering, `0.30 … 0.90` returning; fill dissolves over the first **30%**, with the panel's static-shaped shadow underlay |
| Lead curve | shared elements run `1 − (1 − p)²` ahead of the finger-locked box (content settles before the container), as **one family with staggered departures** (`leadStaggered(_:by:)`): orb bare, greeting +5%, chips +8%, pill +10% — a flock, not a welded convoy. Every stagger is a remap of the interior, so all of them are exactly 0 and 1 at the ends. Widths stay linear on the finger |
| Orb | one `Orb(.panel)`: pure x, 148.5 → 640, y fixed at 198, size fixed |
| Greeting | one 301-wide title+subtitle block, translated only — subtitle capped 277 at both ends, so the centred block is pixel-identical to both settled surfaces |
| Chips | leading 46 → 388 on the lead; **width 301 → 600 linear on the finger** — a real `.frame(width:)`, nothing re-wraps |
| Composer | the chips' path and width; bottom edge 986 → 1004; flight copy is chrome only (no `TextField`); the wide pill's absent marquee is a folding 34pt slot, held open while a selection is attached |
| Toggle | (46, 46) → (28 + sidebar, 28), linear, never fades |
| Panel controls | the one unmatched element: opacity out over `0 … 0.25` with a 12pt trailing drift |
| Thread | two copies, each laid out once; docked copy slides toward the destination centre, wide copy arrives from 60pt short of home; overlapping cross-fade `0.30…0.55 / 0.30…0.60` entering, `0.45…0.70 / 0.40…0.75` returning (one direction parameter) |
| Board | translated **`peekX − boardX` = 846**, never resized and never faded, so its leading edge lands exactly on the peek's line; the peek artwork crossfades over the last 15%. `BoardFlightMask` (rounded rect → `BoardPeekShape` over `0.55 … 1`) is compiled and tested but not attached: at these curves its cut edge never crosses the screen edge (`PresentationMorphTests` proves it), so the live canvas keeps PencilKit's unmasked fast path |
| Sidebar | if open, a flight copy folds its own width off the leading edge; `isSessionsSidebarOpen` is untouched and the layout returns next visit |
| Buttons | `btn/full-screen` and the peek's tap replay the same morph from rest: `begin` outside any transaction, settle on the next main-queue turn, so the animatable renders spring through the identical curves |

Endpoint pixel-parity is arithmetic, not a rendering promise: every path is exact (never
rounded) at `0` and `1`, whole points between, so the handoff between a flight copy and the
settled surface's own element cannot jump. `PresentationMorphTests` and
`PresentationFlightTests` pin the equalities, the bands, the dip, the staggers and the
end-state opacities on both legs.

Two lifecycle rules learned from the shipped morph's first device round:

- **A stale settle completion is a no-op.** A gesture that grabs the morph while the
  previous flight's spring is still settling starts a new flight; when the interrupted
  spring's completion finally fires it must not clear `isSettling` or the screen's mount
  flag under the live drag — or the surfaces' own copies come back at full opacity while
  the flight copies are still in the air, and the screen shows both. `PresentationMorphModel`
  keeps a generation counter; `finishSettle(of:)` releases only for the current flight.
- **The panel's fade bands fly with the pill.** The docked composer slot's band and the
  panel's top scroll fade are `--color-surface-panel` gradients: invisible over the panel's
  own fill, a grey wash hanging at the panel's old position once the container has whitened
  past 30% of the travel. Both go invisible — never unmounted — for the flight's duration,
  which changes nothing at the docked handoff because there they sit on their own colour.

---

## Open questions / ambiguities

1. **No scroll fade exists on this artboard.** The panel's scroll-fade gradient is not present here — a `linear-gradient` search across the whole artboard returns only the five orb bodies, and no text node mentions "fade". The tutor panel specimen is a truncated placeholder with no header, message list, composer or fade. Those must live on another board (likely the conversation/messages artboard). **The requested exact scroll-fade gradient value cannot be sourced from `02 — Components · Shell`.**
2. **No "Live drift" row exists as such.** The board carries exactly two regression-style notes: the tool rail's `Known regression` row (marked **RESOLVED**, transcribed in §1) and the collapsed dock's `Elevation` row (`drifts from 03 Control (0D / 08)`, **not** marked resolved, transcribed in §7). If a separate "Live drift" table is expected, it is on a different artboard.
3. **Panel bottom-inset arithmetic does not close.** "18px emergent · children sum to 958 in a 976 box" implies 0 bottom inset (`18 + 958 = 976`). The specimen's own proportions (`18 + 424 + 18 = 460`) imply children should sum to **940**. Confirm with the designer; implement the stated *rule* rather than the literal 958.
4. **Thickness margins: prose says 28 / 20, build says 29 / 19.5.** The built values are load-bearing for the 627.5 total. Confirm the prose is just approximate.
5. **Elevation level "03 Control" is never defined on this board** — only referenced as `(0D / 08)` in the drift note. Its full spec (offsets, blur, second layer) presumably lives on the foundations board.
6. **Interactive states are largely undocumented.** Only the tool slot has two states (default / selected). Nothing on this board specifies pressed, hover, disabled, or focus for any control; there is no selected/active state for pen swatches, panel controls, `btn/select`, or the centre-on-work button.
7. **Tap targets below 44pt.** Panel-control buttons are 32 × 32 and `btn/select` is 52 × 52; the board states no expanded hit area for the 32pt buttons. The rail explicitly solves this with the 54pt slot and 54pt swatch pitch, so the 32pt panel controls look like an unaddressed gap.
8. **The tool rail has no `Position` row.** Its live x/y is not stated; §12's `x = 28 + 72 + 24 = 124` is derived from the board origin and token values, not read from a rail position row. The rail's vertical placement on the 1032pt screen is undocumented.
9. **`--color-surface-bubble` (`#F2F2F6`), `--space-content` (56), `--space-message-gap` (22), `--container-column` (740), `--radius-bubble` (18)** are defined but unused by any shell component — they belong to boards outside this scope.
10. **Board artifact:** the whiteboard-canvas specimen contains a stray empty `Text` node (5 × 20, content `" "`). It has no spec row and appears to be an authoring leftover, not a component.
