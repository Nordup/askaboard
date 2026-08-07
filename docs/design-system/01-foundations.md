# 01 — Foundations & 09 — Screen anatomy

Code-ready transcription of two Paper boards from **"AI Whiteboard Tutor — Design System, Components & Page"**:

- **01 — Foundations** (1680 × 5192) — the token values everything else is built from.
- **09 — Screen anatomy** (1800 × 7852) — absolute layout math for the four screens.

Every number and colour below came from `get_computed_styles` / `get_jsx` / `get_node_info`, never from a screenshot. **Off-grid values are deliberate and are reported exactly as found — do not round, snap to the 4px scale, or "tidy" them.**

Target device: **iPad Pro 13-inch landscape, 1376 × 1032 pt. Single device, no breakpoints, no responsive reflow.**

---

## 0. What the boards say about themselves

> **Board header (01):** "A single-device iPad design system — one screen size, one typeface, no breakpoints. Every value here was measured off the live screens rather than estimated, and anything still carrying a raw value is marked as such instead of quietly rounded to look tidy. Surfaces are separated by elevation, never by stroke."

> **How to read this / Nine boards:** "Foundations sets the values. The component boards show every part at 1:1 with its measured spec. The screens are the product itself, and screen anatomy gives the absolute positions to build against. Nothing here is drawn from memory — each specimen is the live element, duplicated."

### Board index (verbatim)

| Board | Contents |
| --- | --- |
| 01 — Foundations | Colour, type, spacing, radius, elevation. The values everything else is built from. |
| 02 — Components · Shell | The persistent chrome — tool rail, panel, controls, collapsed dock, board, board peek, orb. |
| 03 — Components · Chat | The conversation surface — composer, attached selection, messages, thread, chips, scroll fade. |
| 04 — Icons | Every glyph at 1:1 with its viewBox, stroke width and colour binding. |
| 05 — Board + Tutor | Default state. Board docked beside the tutor panel, tutor showing its greeting. |
| 06 — Board + Tutor collapsed | Tutor folded into a floating dock so the board takes the full width. |
| 07 — Tutor · full screen | Tutor takes the screen; the board stays visible as an edge you can reach back to. |
| 08 — Tutor · in conversation | Thread full, orb shrunk to its 46pt size above the composer, scroll fade at the top. |
| 09 — Screen anatomy | Measured diagrams of all four states with absolute x / y / w / h for every element. |

---

## 1. Colour

**Section heading: "One violet, four greys."**

> "Everything structural is a grey. Colour appears in exactly three places — the send button, the selected tool slot, and the attachment label — and all three are the same violet. The five pen colours belong to the drawing, not to the interface, and take no part in the UI palette."

### 1.1 Ink & surface

| Token | Hex | Semantic role (token description, verbatim) |
| --- | --- | --- |
| `--color-ink` | `#0C0E17` | Primary text. Message copy, chip labels, headings, status bar. |
| `--color-ink-secondary` | `#62636E` | Supporting copy under a heading. Used only in the greeting states. |
| `--color-ink-tertiary` | `#A0A1AA` | Placeholder text in the composer. Never used for real content. |
| `--color-surface` | `#FFFFFF` | Raised things that sit ON a panel or the screen — composer input, suggestion chips, the orb's eyes. |
| `--color-surface-screen` | `#F8F8F8` | The screen behind everything. Slightly darker than the panels so they lift off it. |
| `--color-surface-canvas` | `#FAFAFA` | The whiteboard itself. A hair warmer than the panel so the drawing surface reads as a different material. |
| `--color-surface-panel` | `#FCFCFC` | Tool rail and tutor panel. The chrome material. |
| `--color-surface-bubble` | `#F2F2F6` | Fill for the student's own message bubbles and the attached-selection bubble in the thread. The only grey that sits ON a panel rather than behind one. |
| `--color-icon` | `#55565A` | Default icon stroke — tool rail glyphs and panel controls. |
| `--color-divider` | `#EFEFEF` | Hairline rules inside a surface — the tool-rail divider. **This is the ONLY border colour in the product; every other separation is done with elevation, not stroke.** |
| `--color-shadow` | `#141432` | The single hue every shadow in the product is built from. Never used as a fill. Applied at four alphas — see the Elevation scale. |

**Surface stack, back to front (stated as a layout invariant on board 09):**
`screen #F8F8F8 → board #FAFAFA → panel #FCFCFC`

### 1.2 Brand

| Token | Hex | Semantic role |
| --- | --- | --- |
| `--color-brand` | `#6051DC` | The one brand violet. Send button fill, selected-tool tint source, and the selection-attachment label. Appears sparingly — it is the only saturated colour in the UI chrome. |
| `--color-brand-tint` | `#E6E3F9` | Selected tool slot in the rail. The strongest tint — marks exactly one item at a time. |
| `--color-brand-tint-soft` | `#F1F0FB` | Attached-selection card behind the composer. Soft enough to sit under white without competing. |

### 1.3 Pen palette (drawing colours, **not** UI colours)

Section eyebrow, verbatim: **"Pen palette · 27px circles, 54px pitch"**

| Token | Hex | Note |
| --- | --- | --- |
| `--color-pen-black` | `#0A0A0A` | Pen palette 1 of 5. Also fills the stroke-thickness indicator in the rail. |
| `--color-pen-violet` | `#6051DC` | Pen palette 2 of 5. **Shares its hex with `--color-brand` by coincidence, not by dependency — do not alias them.** |
| `--color-pen-blue` | `#0155FB` | Pen palette 3 of 5. |
| `--color-pen-green` | `#40A365` | Pen palette 4 of 5. |
| `--color-pen-red` | `#E33E38` | Pen palette 5 of 5. |

### 1.4 Documentation-only colours (never ship)

| Value | Where | Note |
| --- | --- | --- |
| `#5A49E2` | Doc eyebrows, spacing-scale squares, radius-specimen borders, `--space-panel-inset` callout | Raw hex on the documentation boards. **Distinct from `--color-brand` `#6051DC`** — do not conflate. |
| `#EAEAEA` 1px border | Colour-swatch chips for near-white values (`--color-surface-screen`, `--color-surface-canvas`, `--color-surface-panel`, `--color-divider`, `--color-brand-tint-soft`) | Documentation affordance so light swatches are visible on the board. There are **no** borders in the product. |

---

## 2. Typography

**Section heading: "Six sizes, one family."**

> "Source Sans 3, and nothing else. Two of the six sizes exist only because the full-screen state gives the same components a 740pt column instead of a 301pt one — the panel and the full screen are one design at two scales, not two designs. A second family, Montserrat, appears on these documentation boards only and never ships."

### 2.1 Families

| Token | Family | Weights used | Product / doc | Description |
| --- | --- | --- | --- | --- |
| `--font-sans` | **Source Sans 3** | 400 · 500 · 600 | **PRODUCT** | The product's only typeface — every text node on every live screen uses it. Humanist, open apertures, single-storey g. |
| `--font-doc` | Montserrat | 600 · 700 | DOC ONLY | Design-documentation boards only. Geometric, circular bowls, double-storey a. Never ships. |
| `--font-mono` | IBM Plex Mono | 500 (spec values) | **DOC only** | Spec values, token names and measurements on the boards. It briefly had one product use — `field/key`'s masked API key, where a 24-bullet run needs an even pitch — and that field was deleted on 2026-08-08 with the credential it held. **Doc-only again, with nothing exempted:** no product screen sets this family, and `MathTutorTests` asserts every style on the scale is `--font-sans`. |

### 2.2 Product type scale (transcribed from the "Type scale" table)

| Token | Size | Leading | Weight | Tracking | Where it appears |
| --- | --- | --- | --- | --- | --- |
| `--text-display` | 40px | 48px (`--leading-display`) | 600 | −0.01em (`--tracking-tight`) | Greeting headline at FULL-SCREEN scale. The largest type in the product; appears exactly once per screen. |
| `--text-title` | 26px | 34px (`--leading-title`) | 600 | −0.01em (`--tracking-tight`) | Greeting headline at PANEL scale ("Hi! I'm your AI Tutor" in the 337pt column). |
| `--text-lead` | 21px | 30px (`--leading-lead`) | 400 | — | Lead paragraph and composer placeholder at FULL-SCREEN scale. Pairs with `--text-display`. |
| `--text-body-lg` | 20px | 24px (`--leading-snug`) | 500 | — | Suggestion-chip labels at FULL-SCREEN scale (740pt column). Same component as `--text-body`, stepped up because the reading column is wider. |
| `--text-body` | 17px | 25px (`--leading-body`) | 400 | — | Default body at PANEL scale (337pt column): message text, suggestion-chip labels, composer placeholder. The workhorse — most text in the product is this. |
| `--text-label` | 15px | 18px (`--leading-label`) | 600 | — | Status bar, the "Selection" attachment label, and small meta. **The smallest size in the product — nothing goes below this.** |

### 2.3 Line-height tokens (all six, with their pairing rule)

| Token | Value | Pairs with / rationale |
| --- | --- | --- |
| `--leading-label` | 18px | Pairs with `--text-label` inside a tight container (the selection-attachment chip). |
| `--leading-tight` | 20px | Status bar only — 15px text in a 20px band. |
| `--leading-control` | 22px | Single-line text inside a control (composer placeholder at panel scale). Tighter than body because the text is vertically centred, never wrapped. |
| `--leading-snug` | 24px | Suggestion-chip labels and short centred body copy. |
| `--leading-body` | 25px | Running body text — message bubbles and any wrapped paragraph at `--text-body`. |
| `--leading-lead` | 30px | Pairs with `--text-lead` in the full-screen greeting. |
| `--leading-title` | 34px | Pairs with `--text-title` in the panel greeting. |
| `--leading-display` | 48px | Pairs with `--text-display` in the full-screen greeting. |

### 2.4 The three-leadings rule for 17px body (verbatim, board callout)

> "17px text takes **25px** leading when it wraps (messages, paragraphs), **24px** when it is short and centred, and **22px** inside a control where it never wraps and is optically centred instead. **Known inconsistency to settle in code:** the panel greeting's body copy sits at 24 while message text sits at 25, and there is no design reason for the difference — it is left as measured rather than silently corrected here."

### 2.5 Weights

| Token | Value | Use |
| --- | --- | --- |
| `--font-weight-regular` | 400 | Body copy, message text, placeholders. |
| `--font-weight-medium` | 500 | Suggestion-chip labels. |
| `--font-weight-semibold` | 600 | Headings, status bar, the selection label. **The heaviest weight the product uses.** |
| `--font-weight-bold` | 700 | Documentation boards only — the product never goes above semibold. |

### 2.6 Letter spacing

| Token | Value | Use |
| --- | --- | --- |
| `--tracking-tight` | −0.01em | Applied to `--text-title` and `--text-display` only. Large type needs the air taken out of it. |
| `--tracking-wide` | 0.06em | All-caps eyebrow labels on the documentation boards. (Documentation-only usage.) |

---

## 3. Spacing & layout

**Section heading: "28 · 24 · 18."**

> "Three numbers carry the entire layout: 28 from the screen edge to anything, 24 between two panels, 18 from a panel's edge to its contents. Every other layout value is a multiple of 4, with one deliberate exception — the 22pt gap between messages, where 24 read too loose and 20 too dense. **Spacing inside a component — tap-target pitch, icon-to-label, optical padding — is tuned by eye and specced per component in 02–04.**"

### 3.1 The 4px scale

| Token | Value | Description |
| --- | --- | --- |
| `--spacing-1` | 4px | Base grid unit. Every spacing value in the product is a multiple of 4 except `--space-message-gap` (22). |
| `--spacing-2` | 8px | Icon-to-label gap in tight controls. |
| `--spacing-3` | 12px | Send-button inset inside the composer pill. |
| `--spacing-4` | 16px | Composer icon-to-text gap; collapsed-dock gap. |
| `--spacing-5` | 20px | Suggestion-grid gap at full-screen scale. |
| `--spacing-6` | 24px | Same value as `--space-gap`. **Prefer the semantic name for layout.** |
| `--spacing-7` | 28px | Same value as `--space-edge`. **Prefer the semantic name for layout.** |
| `--spacing-8` | 32px | Composer pill left inset at full-screen scale. |
| `--spacing-10` | 40px | Reserved. |
| `--spacing-12` | 48px | Reserved. |

(The board's spacing specimen row renders squares at 4, 8, 12, 16, 20, 24, 28, 32, 40, 48 — labelled `1 · 4` through `12 · 48`. Note **there is no `--spacing-9` or `--spacing-11`.**)

### 3.2 Semantic spacing (the "margin rules" cards, verbatim)

| Token | Value | Rationale, verbatim |
| --- | --- | --- |
| `--space-edge` | **28px** | "Screen-edge inset for panels, on all four sides. Was 18px at the bottom — too tight for a 13" display, and it made the layout read as bottom-heavy. **With no status band reserved, the top edge is measured from the screen like every other edge: content starts at 0 + 28 = 28.**" |
| `--space-gap` | **24px** | "Between adjacent panels. Slightly tighter than the edge inset so panels group against the screen rather than floating apart." |
| `--space-panel-inset` | **18px** | "Inside a panel: left, right and bottom. Everything in the tutor panel — header, buttons, chip, field — sits in one 301pt column so a single lane runs down each edge. Smaller than the screen inset because a panel is already inset from the screen." |
| `--space-content` | **56px** | "Content inset for full-screen reading layouts. Wider than the panel inset, because a full-bleed measure needs more air than a panel does." |
| `--space-message-gap` | **22px** | "**The one layout value off the 4px grid.** Between consecutive messages in the thread — 24 read too loose against 17px body, 20 too dense. Elsewhere in layout, stay on multiples of 4." |

### 3.3 Fixed widths (container tokens)

| Token | Value | Description |
| --- | --- | --- |
| `--container-screen` | 1376px | iPad Pro 13-inch landscape width in points. The product is a single-device layout — there are no breakpoints. |
| `--container-rail` | 72px | Tool rail width. Fixed — the rail never resizes. |
| `--container-panel` | 337px | Tutor panel width when docked beside the board. |
| `--container-panel-content` | 301px | Usable content width inside the tutor panel = `--container-panel` minus 2 × `--space-panel-inset`. Every child of the panel is this wide. |
| `--container-column` | 740px | Reading column in the full-screen tutor state — greeting, suggestion grid and composer all align to this. |

> Board card, verbatim: "Rail 72. Tutor panel 337, which leaves a 301pt content column once the 18pt inset comes off both sides. Full-screen reading column 740. Screen 1376 × 1032 — one device, no breakpoints."

---

## 4. Radius

**Section heading: "Corners scale with the surface."**

> "Radius is chosen by how big the surface is, not by taste. The two large surfaces — board and tutor panel — share 28. The rail is narrower so it takes 20, chips take 14, message bubbles 18, and anything pill-shaped goes fully round."

| Token | Value | Use (token description + board caption) |
| --- | --- | --- |
| `--radius-xs` | 6px | Icon-internal geometry only (glyph corners). Board caption: "icon detail". |
| `--radius-sm` | 10px | Small inline marks. |
| `--radius-md` | 12px | **Reserved — no current product use.** (Used on the doc boards for colour swatches.) |
| `--radius-lg` | 14px | Suggestion chips and the selected-tool slot. **The product's control radius**, and the settings window's four surfaces take it too: `nav/item`, `field/key`, `btn/destructive`, and the retired `select/option` before them. |
| `--radius-xl` | 16px | **Reserved — no current product use.** |
| `--radius-bubble` | 18px | Message bubbles in the thread. Sits between `--radius-xl` and `--radius-2xl` because bubbles are small and need a softer corner than a panel. |
| `--radius-2xl` | 20px | Tool rail. |
| `--radius-3xl` | 28px | Whiteboard canvas and tutor panel — the two big surfaces — and, since the redesign, the settings window, which at 760 × 520 is larger than either. |
| `--radius-full` | 9999px | Pills and circles: composer input, send button, orb, pen swatches. In Paper this renders as `calc(infinity * 1px)`. **In Swift use a capsule shape, not a literal 9999.** |

---

## 5. Elevation / shadow scale

**Section heading: "Shadow, never stroke."**

> "Surfaces separate by shadow alone — **there is not one border left in the product.** Three levels and nothing else: the canvas gets a single soft shadow, panels and controls get two, a wide soft one for the lift and a tight one for the contact edge. All of them are built from a single hue, `--color-shadow` (`#141432`)."

Paper has no shadow token type, so this scale lives as prose + specimens on the board. Values below are the exact `box-shadow` strings read off the specimens, cross-checked against the level captions and the board-09 invariants table (all three agree).

### 5.1 The scale

| Level | Layer | Colour (8-digit) | Hue | Alpha | x | y | Blur | Spread | Board caption |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **01 · Canvas** | single | `#14143209` | `#141432` | 0.035 (`0x09`/255) | 0 | 2 | 6 | 0 | "0 2 6 · 0.035 — The board. Barely lifted — it is the ground." |
| **02 · Panel** | outer lift | `#1414320E` | `#141432` | 0.055 (`0x0E`/255) | 0 | 3 | 10 | 0 | "0 3 10 · 0.055 + 0 1 3 · 0.04 — Tool rail, tutor panel. Floats over the board." |
| | contact edge | `#1414320A` | `#141432` | 0.04 (`0x0A`/255) | 0 | 1 | 3 | 0 | |
| **03 · Control** | outer lift | `#1414320D` | `#141432` | 0.05 (`0x0D`/255) | 0 | 2 | 6 | 0 | "0 2 6 · 0.05 + 0 1 2 · 0.03 — Buttons, chips, the floating dock." |
| | contact edge | `#14143208` | `#141432` | 0.03 (`0x08`/255) | 0 | 1 | 2 | 0 | |
| **04 · Modal** | outer lift | `#14143216` | `#141432` | 0.086 (`0x16`/255) | 0 | 16 | 40 | 0 | **No board caption — see below.** |
| | contact edge | `#1414320E` | `#141432` | 0.055 (`0x0E`/255) | 0 | 4 | 12 | 0 | |

CSS form, ready to port:

```
/* 01 · Canvas  */  box-shadow: #14143209 0px  2px  6px;
/* 02 · Panel   */  box-shadow: #1414320E 0px  3px 10px, #1414320A 0px 1px  3px;
/* 03 · Control */  box-shadow: #1414320D 0px  2px  6px, #14143208 0px 1px  2px;
/* 04 · Modal   */  box-shadow: #14143216 0px 16px 40px, #1414320E 0px 4px 12px;
```

**No layer in any level has a spread.** All offsets are y-only (x = 0).

### 5.1a Level 04 is authored, not measured

The other three levels were read off Foundations specimens whose captions state the intent.
**04 has no specimen and no caption**, because it did not exist when the board was drawn: the
product had three surfaces and all of them sat on the screen grey. The settings redesign
(board 10) adds a situation the scale has no answer for — a white window over a backdrop that
has itself been *whitened*, where the two surfaces are the same colour and the shadow is the
only thing separating them. At 02 · Panel's 0.055 / 10px, tuned for `#FCFCFC` on `#FAFAFA`,
the window has no edge at all.

It keeps every structural rule the section states: one hue, two layers in lift-then-contact
order, x = 0, no spread. What it extends is the numeric range.

It was also **drawn heavier and pulled back**. The first version ran `0.141 / 24 / 64` — 2.6×
the previous alpha ceiling and 6.4× the previous blur — and read as a drop shadow rather than
a lift. What ships is `0.086 / 16 / 40`, and the contact layer's `0x0E` is 02 · Panel's outer
alpha *exactly*, so **one number in this level is genuinely new** rather than four.

Foundations should gain a specimen for it. Until then this table is the only record, and
`Elevation.swift` carries the same note.

### 5.2 Which component uses which level

| Level | Components (as stated on the boards) |
| --- | --- |
| 01 · Canvas | Whiteboard canvas (all states, docked 863 wide and expanded 1224 wide). Verified on the live diagram nodes. |
| 02 · Panel | Tool rail; tutor panel (docked, both greeting and in-conversation states). Verified on the live diagram nodes. |
| 03 · Control | Buttons, suggestion chips, the collapsed floating dock, **and the composer field**. Also `field/key` and `btn/destructive` in the settings window. |
| 04 · Modal | The settings window (board 10), and nothing else. **One user is the point** — if a second surface ever wants this level, that is the moment to ask whether the product has a modal *pattern* rather than a modal. |

### 5.3 Fields use level 03 — stated rationale

> "The composer is raised, not recessed. An inward rim shadow was tried and rejected — it read as a hole rather than a control."

Verified: the full-screen composer pill carries `#1414320D 0 2 6, #14143208 0 1 2` on a `#FFFFFF` fill with `radius-full`.

### 5.4 "One thing to know" — the faked board-peek shadow (verbatim)

> "Paper silently drops `box-shadow` on SVG path nodes — it accepts the style and renders nothing at all. The board peek's edge shadow is therefore faked: a blurred duplicate of the same path, offset 3/2, filled `#141432`, blur 5px, opacity 0.11. **A code port should use a real shadow there and delete the duplicate path.**"

Verified on the live node — the "Edge shadow" child of the board peek is:

```
position: (x 3, y 2) relative to the peek
size: 68 × 976
filter: blur(5px)
opacity: 0.11
<path d="M0,0 H50 A18,18 0 0 1 68,18 V46 A18,18 0 0 1 50,64 H46 A18,18 0 0 0 28,82 V958 A18,18 0 0 1 10,976 H0 Z" fill="#141432" />
```

---

## 6. Screen anatomy (board 09)

**Board blurb, verbatim:**

> "The product is a single fixed device layout — one screen size, iPad Pro 13-inch landscape, no breakpoints and no responsive reflow. Every position on this board is therefore an absolute value you can type straight into a layout constraint. Each diagram below is drawn 1:1 against the live screen it documents, and every number in the tables was read off that live node."

### 6.1 Layout invariants (hold on all four screens)

> "These hold on all four screens. Nothing here is derived at runtime — the safe content band, the edge inset, the gap and the panel inset are constants, and every panel width in the diagrams below is a consequence of them."

| Invariant | Value / arithmetic (verbatim from the table) |
| --- | --- |
| Screen size | `1376 × 1032 pt · iPad Pro 13" landscape` |
| Screen background | `var(--color-surface-screen) #F8F8F8` |
| Content top edge | `y = 28 · every panel on every screen` |
| Safe content band | `y 28 → 1004 · height 1032 − 28 − 28 = 976` |
| Screen edge inset | `28 · var(--space-edge) · left / right / bottom` |
| Inter-panel gap | `24 · var(--space-gap)` |
| Panel inset | `18 · var(--space-panel-inset)` |
| Panel content width | `337 − 2 × 18 = 301 · var(--container-panel-content)` |
| Tool rail width | `72 · var(--container-rail) · height is fit-content` |
| Board left edge | `28 + 72 + 24 = 124 · edge + rail + gap` |
| Panel radius · board & tutor | `28 · var(--radius-3xl)` |
| Rail radius | `20 · var(--radius-2xl)` |
| Elevation · board surface | `#14143209 0 2 6 — one soft pass, sits lowest` |
| Elevation · rail & tutor panel | `#1414320E 0 3 10 + #1414320A 0 1 3` |
| Elevation · floating control | `#1414320D 0 2 6 + #14143208 0 1 2` |
| Surface stack, back to front | `screen #F8F8F8 → board #FAFAFA → panel #FCFCFC` |

**Derived vertical lanes (used by every screen):**

```
y   0 …  16   screen top padding above the status bar
y  16 …  40   status bar band (height 24)
y  40 …  68   --space-edge, measured from the status bar not the screen
y  68 … 1004  safe content band (height 936) — all panels live here
y 1004 … 1032 --space-edge bottom
```

**Derived horizontal lanes, docked layout (screens 05 and 10):**

```
x    0 …   28   --space-edge left
x   28 …  100   tool rail (72)
x  100 …  124   --space-gap (24)
x  124 …  987   whiteboard canvas (863)
x  987 … 1011   --space-gap (24)
x 1011 … 1348   tutor panel (337)
x 1348 … 1376   --space-edge right
```

(The board's tick marks confirm these lane boundaries at x = 0, 28, 100, 124, 987, 1011, 1348, 1375.)

---

### 6.2 Screen 05 — "Board + Tutor (no chrome)"

> "The resting state, and the layout the app opens into. Three lanes across the safe band: tool rail, whiteboard, docked tutor. The tutor is showing its greeting because no work has been submitted yet. **This frame is the reference the other three are measured against.**"

| Element | x | y | w | h | Extra (read off the live node) |
| --- | --- | --- | --- | --- | --- |
| Screen | 0 | 0 | 1376 | 1032 | bg `--color-surface-screen` `#F8F8F8` |
| Status bar | 0 | 16 | 1376 | 24 | |
| Tool rail | 28 | 28 | 72 | **617** (fit-content) | radius 20, bg `--color-surface-panel`, elevation 02, `padding-block: 9px`, `gap: 12px` (`--spacing-3`), flex column, align center |
| Whiteboard canvas | 124 | 28 | 863 | 976 | radius `--radius-3xl` (28), `overflow: clip`, bg `--color-surface-canvas`, elevation 01 |
| Tutor chat panel | 1011 | 28 | 337 | 976 | radius `--radius-3xl` (28), bg `--color-surface-panel`, elevation 02, `padding-top: 18px`, flex column, align center |

**Board width derivation (verbatim):** `1376 − 28 − 72 − 24 − 337 − 24 − 28 = 863`

**Tool rail internal stack (canonical — this is the reference rail):**

| Child | Size | Spacing |
| --- | --- | --- |
| Tools (4 × 54×54 slots) | 54 × 216 | **gap 0** — slots butt directly, giving a 54pt tap pitch |
| Divider | 46 × **1** | `#EFEFEF` (= `--color-divider`) |
| Swatches (5 × 27×27 circles) | 27 × 243 | **gap 27** (off-grid, deliberate → 54pt pitch), `margin-top: 8px` |
| Thickness indicator | 36 × 5 | |
| tool/center button | 54 × 54 | contains a 26×26 SVG |

Rail container: `padding-block: 9px`, `gap: 12px` between the five children.

---

### 6.3 Screen 06 — "Board + Tutor collapsed"

> "The tutor is dismissed and the board takes the panel's width plus the gap it used to sit behind. The user reaches this by collapsing the tutor to work uninterrupted. **Note the one exception to the edge rule on this board: the collapsed dock is inset 24 from the board's bottom-right corner, not 28 from the screen edge, so it reads as sitting on the board rather than on the screen.**"

| Element | x | y | w | h | Extra |
| --- | --- | --- | --- | --- | --- |
| Screen | 0 | 0 | 1376 | 1032 | bg `--color-surface-screen` `#F8F8F8` |
| Status bar | 0 | 16 | 1376 | 24 | |
| Tool rail | 28 | 28 | 72 | 617 (fit-content) | identical to screen 05 |
| Whiteboard canvas | 124 | 28 | **1224** | 976 | radius 28, `overflow: clip`, bg `--color-surface-canvas`, elevation 01 |
| Tutor dock · collapsed | 1192 | 916 | 132 | 64 | flex row, align center, `gap: 16px` (`--spacing-4`), elevation 03 |

**Board width derivation (verbatim):** `863 + 24 + 337 = 1224 · board absorbs gap + panel`

**Dock anchor (verbatim):** `1348 − 1324 = 24 right · 1004 − 980 = 24 bottom` — i.e. `--space-gap`, measured from the board's edges, **not** `--space-edge` from the screen.

---

### 6.4 Screen 07 — "Tutor · full screen"

> "The tutor takes the whole screen for reading and long explanations, leaving a 68pt peek of the board pinned to the left as the way back. The three-lane grid is gone: content is a single 740 reading column, and because the peek occupies the left 68, that column is centred in what remains rather than on the screen."

| Element | x | y | w | h | Extra |
| --- | --- | --- | --- | --- | --- |
| Screen | 0 | 0 | 1376 | 1032 | bg **`#FFFFFF`** — see note below |
| Status bar | 0 | 16 | 1376 | 24 | |
| Board peek | **0** | 68 | 68 | 976 | **flush left, no 28 inset.** Contains: faked edge shadow (§5.4), board-edge SVG path, board-hinge icon at local (23, 22) |
| Greeting block (avatar, title, subtitle) | **34** | 150 | 1376 | 264 | flex column, align center — see the centring note below |
| Suggestion grid (2 × 2 wrap) | 352 | 592 | 740 | 168 | `flex-wrap: wrap`, `gap: 20px` (`--spacing-5`) → two 74pt rows + one 20pt gap |
| Composer pill | 352 | 924 | 740 | 80 | radius full, bg `#FFFFFF`, elevation 03, `padding-left: 32px` (`--spacing-8`), `padding-right: 12px` (`--spacing-3`), `gap: 18px`, align center. **Bottom edge lands on 1004.** |

**Column centring (verbatim):** `68 + (1376 − 68 − 740) ÷ 2 = 352 · margins 284 / 284`

Tick marks on the diagram: x = 0, 68, 352, 1092, 1375. Reading-column edges at x 352 and x 1092.

**Screen background (verbatim spec row):** `#FFFFFF, not var(--color-surface-screen) #F8F8F8` — screen 07 is the one state whose background differs from the other three.

**Note on the greeting block's x = 34.** It is a 1376-wide, centre-aligned container placed at x 34, so it overhangs the right screen edge by 34pt and is clipped. Its optical centre is `34 + 688 = 722`, which equals `68 + (1376 − 68) ÷ 2 = 722` — the same centre the 740 column uses. **In Swift, implement this as content centred in the region x ∈ [68, 1376], not as a 1376-wide box offset by 34.**

---

### 6.5 Screen 10 — "Tutor · in conversation"

(Called **screen 10** on board 09; the board index calls the same state **08 — Tutor · in conversation**.)

> "The working state: the user has asked something and the thread has replaced the greeting. **The outer frame is identical to screen 05 down to the pixel — only the tutor panel's contents change — so a developer implements one shell and swaps what fills the panel.** This is where the 18pt panel inset earns its keep."

| Element | x | y | w | h | Panel-local | Extra |
| --- | --- | --- | --- | --- | --- | --- |
| Screen | 0 | 0 | 1376 | 1032 | | bg `--color-surface-screen` `#F8F8F8` |
| Status bar | 0 | 16 | 1376 | 24 | | |
| Tool rail | 28 | 28 | 72 | 617 (fit-content) *(spec table)* | | see contradiction in §8 |
| Whiteboard canvas | 124 | 28 | 863 | 976 | | radius 28, elevation 01, bg `--color-surface-canvas` |
| Tutor chat panel | 1011 | 28 | 337 | 976 | | radius 28, elevation 02, bg `--color-surface-panel`, `padding-top: 18px` |
| ↳ Panel controls | 1029 | 86 | 301 | 32 | (18, 18) | |
| ↳ Thread | 1029 | 118 | 301 | 810 | (18, 50) | **bottom-aligned, message gap 22** |
| ↳ Composer | 1029 | 928 | 301 | 58 | (18, 860) | |

**Panel vertical stack (verbatim):** `18 + 32 + 850 + 58 + 18 = 976`

**Outer frame vs. screen 05 (verbatim):** `identical — only the panel's contents differ`

Panel horizontal lanes annotated on the diagram: inset left 18 (x 1011→1029), panel content 301 (x 1029→1330), inset right 18 (x 1330→1348).

---

## 7. Stated rules, do's and don'ts

Collected from both boards. All verbatim or near-verbatim.

1. **No borders.** "Surfaces separate by shadow alone — there is not one border left in the product." `--color-divider` `#EFEFEF` is the *only* border colour, used only for the tool-rail hairline.
2. **One violet.** Colour appears in exactly three places — the send button, the selected tool slot, and the attachment label — all `--color-brand`.
3. **Pen colours are not UI colours.** They belong to the drawing and take no part in the UI palette.
4. **Do not alias `--color-pen-violet` to `--color-brand`.** Same hex, coincidental, no dependency.
5. **`--color-shadow` is never a fill.** It exists only as a shadow hue.
6. **Nothing goes below 15px** (`--text-label`) in the product.
7. **The product never goes above semibold (600).** 700 is documentation-only.
8. **Never use `--font-doc` (Montserrat) or `--font-mono` (IBM Plex Mono) in the product.** Source Sans 3 only, everywhere.
9. **Prefer semantic spacing names over numeric ones for layout** — `--space-gap` over `--spacing-6`, `--space-edge` over `--spacing-7`.
10. **Layout stays on multiples of 4** — with exactly one exception, `--space-message-gap` = 22.
11. **Component internals are allowed off-grid.** "Spacing inside a component — tap-target pitch, icon-to-label, optical padding — is tuned by eye and specced per component in 02–04." (This is why the rail's 27pt swatch gap and 0pt tool-slot gap are correct as-is.)
12. **No status bar is drawn or reserved; the app hides the system one.** Every edge is the plain token: `0 + 28 = 28`.
13. **The collapsed dock is the one exception to the edge rule** — 24 from the board's corner, not 28 from the screen's.
14. **The board peek is flush left with no 28 inset.**
15. **The full-screen reading column centres past the peek, not on the screen.**
16. **The composer is raised, not recessed.** An inward rim shadow was tried and rejected.
17. **Port the board peek's shadow to a real shadow and delete the duplicated blurred path.** (Paper limitation, not a design intent.)
18. **Screens 05 and 10 share one shell.** Build the shell once; swap only the panel's contents.
19. **`--radius-full` renders as `calc(infinity * 1px)` in Paper.** Use a capsule in Swift.
20. **Reserved tokens with no current product use:** `--radius-md` (12), `--radius-xl` (16), `--spacing-10` (40), `--spacing-12` (48).

---

## 8. Open questions / ambiguities

Genuine problems found; each is reported as measured, not corrected.

1. **~~Screen 10's tool-rail specimen has drifted off the canonical rail.~~ SUPERSEDED — this
   entry is wrong, and so is board 09. Corrected 2026-08-06; see `06-states-and-settings.md §6`
   for the evidence.**

   **The canonical rail is 627.5, not 617.** Board 09 documents 617 but its own listed parts
   sum to 593, so its table is internally inconsistent — and board 09 draws its diagrams as
   *clones* of the live screens, which is exactly the operation board 02 names as the cause of
   the corruption. Board 02's own RESOLVED note says it plainly: *"A future export reading 617
   is this regression, not a redesign."* All four live screens measure 627.5 by node.

   Build the rail from `02-shell-components.md §1`, which has the correct chain. The stale
   comparison table is kept below only so a future reader recognises the corrupted values:

   | | Screens 05 & 06 (canonical) | Screen 10 (drifted) |
   | --- | --- | --- |
   | Tools stack gap | **0** (54pt tap pitch) | `var(--spacing-1)` = **4px** |
   | Swatches gap | **27px** (54pt pitch) | `var(--spacing-7)` = **28px** |
   | Tools block height | 216 | 228 |
   | Swatches block height | 243 | 247 |
   | Rail total height | 617 | 633 |

   This looks exactly like the 4px-scale snapping the boards warn against. **Build the rail from the screen-05 geometry (gap 0 / gap 27 / height 617)** and treat the screen-10 specimen as stale. Worth confirming with the designer.

2. **`--color-shadow`'s description says "Applied at four alphas", but the elevation scale uses five distinct alphas** — 0.035, 0.055, 0.04, 0.05, 0.03. The scale itself is internally consistent (specimen hex, level captions and the board-09 invariants table all agree); it is the token description that undercounts.

3. **The elevation section's prose says "Three levels and nothing else", but the section shows four cards.** The fourth ("Fields use 03") is a restatement of level 03 for the composer, not a fourth level. No conflict in values — only in card count.

4. **Board naming mismatch.** The board index calls the conversation state **"08 — Tutor · in conversation"**; board 09 labels the same diagram **"SCREEN 10"**. Likewise the index calls the default state "05 — Board + Tutor" while board 09 titles it "Board + Tutor (no chrome)". These are the same states under two naming schemes.

5. **The 24 vs 25 leading inconsistency at 17px is unresolved by design** and flagged on the board as "Known inconsistency to settle in code: the panel greeting's body copy sits at 24 while message text sits at 25, and there is no design reason for the difference." A decision is still needed.

6. **The pen-palette specimen on the Foundations board is drawn at 2× the product size.** The eyebrow says "27px circles, 54px pitch" (which matches the live rail: 27×27 swatches, 27px gap), but the swatch circles rendered next to it are 54 × 54 with a 40px flex gap. The specimen is a documentation blow-up, not the product geometry. **Use 27px circles at 54px pitch.**

7. **`--space-content` (56px) is defined and rationalised, but no element on board 09 uses it.** The full-screen state uses the 740 reading column centred past the peek (margins 284/284), not a 56pt inset. It may be intended for a layout not documented on these two boards.

8. **`--leading-tight` (20px) is described as "Status bar only"**, but no status-bar type spec appears on either of these two boards beyond the band geometry (1376 × 24 at y 16). The 15/20/600 pairing is inferable from the token descriptions but is not stated as a row anywhere on boards 01 or 09.

9. **The screen-07 greeting block's `x = 34, width = 1376` overhangs the screen by 34pt** and relies on `overflow: clip`. This is a Paper drawing convenience for centring; it is not a constraint to reproduce literally. See §6.4.

Everything else on both boards is internally consistent and unambiguous.
