# 03 — Components · Chat

Code-ready transcription of the Paper board **"03 — Components · Chat"** (1680 × 12127) from
**"AI Whiteboard Tutor — Design System, Components & Page"**.

Every number, colour and radius below was read from `get_computed_styles` / `get_jsx` /
`get_node_info` on the live nodes — never from a screenshot. **Off-grid values are deliberate and
are reported exactly as found. Do not round, do not snap to the 4px scale, do not "tidy".** Where a
value contradicts another value on the board, both are reported and the contradiction is listed in
§11.

Target device: **iPad Pro 13-inch landscape, 1376 × 1032 pt. Single device, no breakpoints.**

Token reference: see `01-foundations.md`. Elevation names used here (`02 Panel`, `03 Control`) are
the Foundations names.

> **The pill came down a step.** 58 → **50** in the panel and 80 → **68** full-screen, and the
> paddings, the gap and both button boxes came down with it. Every number below is at the current
> height. **Board 03 was only half re-drawn for it:** §1 (the composer specimens and the section
> blurb) is current; §2 (the rule, the notch diagram, the standalone card) and §7 (the button
> specimens) still draw the 58pt-era numbers. Where the board contradicts itself, the value that
> screens 05 / 07 / 08 / 15a and board 03b draw is reported as the number, the board's stale
> specimen is named inline, and the contradiction is listed in §11.

> **Not covered here.** The board has grown two specimens this file does not transcribe —
> `Composer · panel, five lines (cap)` and `Composer · full-screen, five lines (cap)` — and its
> §05 is now a two-specimen scroll-fade section (`Body`, `Body · bottom`) rather than the single
> top fade documented in §6. A sibling board, **"03b — Components · Attachments"**, carries the
> composer's `ui/plus`, `menu/attach` and the attachment-chip card, and has no transcription file
> at all. The panel composer's leading slot now holds a plus *and* the marquee on every screen;
> only the plus's own geometry is deferred to 03b.

---

## 0. What the board says about itself

> **Board header — "Chat & composer":** "These are the conversation surface: everything whose
> layout depends on how much has been said. A composer that grows a card when a selection is
> attached, a thread that fills from the bottom up, messages that are boxed on one side and bare on
> the other. Sizes here are 1:1 with the live screens — every number was read off the node, not
> estimated."

### Board contents (8 sections, in order)

| # | Section | Specimens |
| --- | --- | --- |
| 01 | Composer | `Composer · panel, plain`, **`Composer · panel, five lines (cap)`**, `Composer · panel, with attached selection`, `Composer · full-screen wide`, **`Composer · full-screen, five lines (cap)`** |
| 02 | Attached selection | "The rule" prose, notch diagram (Correct / Wrong), `Attached context — card`, `Attached context — label row` |
| 03 | Messages | `msg/tutor · plain`, `msg/tutor · with emoji`, `msg/student · short`, `msg/student · with selection` |
| 04 | Thread | `Thread` (full 9-message demo incl. orb + scroll fade) |
| 05 | Scroll fade | **`Body`, `Body · bottom`** — §6 below still transcribes the single top fade only |
| 06 | Suggestion chips | `chip · panel`, `chip · full-screen` |
| 07 | Buttons | `btn/send · btn/voice` (three sizes), "Unresolved — decide before build" |
| 08 | Greeting blocks | `Greeting · panel`, `Greeting · full-screen` |

**There is no streaming / typing / loading / error / retry specimen anywhere on this board.** The
only non-message affordance in the thread is `btn/orb` (46 × 46), documented in §5.3. See §11.

Every specimen is laid out as a `Stage` (grey `--color-surface-screen` or `--color-surface-panel`
plate, `border-radius: 20px`, `padding: 44px` on all four sides) plus a `Spec` table. The 44pt stage
padding is documentation chrome — **it is not part of any component.**

---

## 1. Section 01 — Composer

> **Section blurb:** "One control, restated at two column widths. The input is a full pill —
> `border-radius: calc(infinity * 1px)` on all four corners — because the composer is the only
> element that floats free of the panel edge, and a pill is the shape that reads as floating. The
> pill height changes (50 in the panel, 68 full-screen) but the radius formula never does, so a port
> must use a capsule shape, not a fixed corner value. Elevation 03 Control on every variant.
>
> The resting height is the send button in a uniform inset — 38 + 2 × 6 = 50, 52 + 2 × 8 = 68 — so
> it is a consequence of the row, and a question too long for the lane grows the pill upward from a
> bottom edge that never moves. Five lines is the cap; past it the text scrolls inside a pill that
> has stopped. The radius is the one thing the growth does not carry: resolved once at the resting
> height (25 and 34) and held, because a capsule re-derived from a five-line pill is a stadium."

### 1.1 `Composer · panel, plain`

Stage 389 × 138 → component 301 × 50.

**Outer wrapper** — layer `Composer`, 301 × 50, `position: relative`, `display: flex`,
`flex-direction: column`, `flex-shrink: 0`. Exists only to be the positioning context for the
absolutely-positioned `Input`; it carries no paint.

**`Input` (the pill)**

| Property | Value |
| --- | --- |
| Size | **301 × 50** — width fixed (`--container-panel-content`), height fixed |
| Position | `absolute`, `left: 0`, `top: 0` |
| Padding | left **18**, right **6**, top 0, bottom 0 (no token for either) |
| Gap | **10** (no token) |
| Radius | `calc(infinity * 1px)` — **all four corners** (no token; source is `--radius-full`) |
| Fill | `var(--color-surface)` `#FFFFFF` |
| Border | none |
| Shadow | **03 Control** — `#1414320D 0px 2px 6px, #14143208 0px 1px 2px` |
| Layout | `display: flex`, `align-items: center`, direction row |
| Layer path | `Tutor chat / Composer / Input` |

**Children (left → right)**

| Child | Size | Detail |
| --- | --- | --- |
| Marquee icon (SVG) | 24 × 24 | `flex-shrink: 0`. viewBox `0 0 24 24`; `<rect x=2.6 y=2.6 w=18.8 h=18.8 rx=4 fill=none stroke-width=2 stroke-dasharray="4.6 3.9">`. **Stroke = `var(--color-icon)` `#55565A`** (grey — see §1.2 for the attached state) |
| Placeholder text | **195** × 22, `flex-grow: 1` | "Ask anything…" — **17 / 22 · 400 · `var(--color-ink-tertiary)`**, `font-family: var(--font-sans)` |
| `btn/send` | **38 × 38** | `flex-shrink: 0`, see §7.1 |

The row closes exactly: `301 − 18 − 24 − 10 − 195 − 10 − 38 − 6 = 0`.

Spec table, verbatim: `Size: var(--container-panel-content) 301 × 50` · `Padding: left 18 · right 6
· no token` · `Gap: 10 · no token` · `Radius: calc(infinity * 1px) — all 4 · no token` ·
`Fill: var(--color-surface) · #FFFFFF` · `Text: 17 / 22 · 400 · var(--color-ink-tertiary)` ·
`Elevation: 03 Control — #1414320D 0 2 6, #14143208 0 1 2` ·
`Children: icon 24 · placeholder flex-grow 1 · send 38`.

> **This specimen's row is not the panel composer's row — do not port it.** The three children
> above are all board 03 draws, and both the spec row and the 195pt lane are faithful to it. Every
> *screen* draws five: **`ui/plus` 20 · marquee 24 · placeholder 121 · `btn/voice` 34 · `btn/send`
> 38**, closing `301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0` — verified on
> screens 05, 08 and 15a, and restated on board 03b's `Composer · panel, with plus`. The voice
> button in particular is the thing this specimen loses: 34 × 34 with a 20pt mic glyph, sitting
> between the placeholder and send. Board 03's own §7 still calls voice full-screen-only (§7.4);
> the screens have settled it the other way. Without the plus the lane is 151, which is the row the
> Swift `ComposerMetrics.panel` currently builds. See §11.

### 1.2 `Composer · panel, with attached selection`

Stage 389 × 176 → component **301 × 88**.

This is the composite. **It is not a stack — the card is edge-to-edge *behind* the pill.**

**Outer wrapper** — layer `Composer`, **301 × 88**, `position: relative`, `display: flex`,
`flex-direction: column`.

**Layer order (first child paints first = furthest back):**

| z | Layer | Position | Size | Radius (TL / TR / BR / BL) | Fill | Shadow |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (back) | `Attached context` (card) | `absolute` `left: 0`, **`top: 0`** | **301 × 63** | **25 / 25 / 0 / 0** | `var(--color-brand-tint-soft)` `#F1F0FB` | **none** |
| 1 (front) | `Input` (pill) | `absolute` `left: 0`, **`top: 38`** | **301 × 50** | `calc(infinity * 1px)` all 4 | `var(--color-surface)` `#FFFFFF` | 03 Control |

- **Overlap = 25pt** (card bottom 63 − pill top 38) — the pill's radius, `50 ÷ 2`.
- **Visible band of the card = 38pt** (y 0 → 38).
- **Total component height = 88** (38 + 50).
- Card padding: left **20**, right **16**. Card layout: `display: flex`, **`align-items:
  flex-start`** — "label pins to the visible band".

> **Board 03 still draws this card at the 58pt pill's size.** Its `Attached context` layer measures
> **301 × 67 with a 29pt top radius**, and its spec rows say `card 301 × 67`, `29 overlap` and
> `card 29 / 29 / 0 / 0` — all left over from the 58pt pill, against a pill the same board has
> already brought down to 50. Screens 05 and 15a draw **301 × 63 / radius 25**, which is what the
> board's own derived law gives (`38 + 25`) and what is reported above. The **total is 88 either
> way**: only the hidden part of the card moved. See §11.

**Card contents** — a single `Frame` **265 × 38** (= 301 − 20 − 16):
`display: flex`, `align-items: center`, `justify-content: space-between`, `padding-top: 6`,
`padding-inline: 3`, `flex-shrink: 0`. It wraps an inner `flex: 1` row containing:

| Element | Style |
| --- | --- |
| Text "Selection attached" | **15 / 18 · 600 · `var(--color-brand)` `#6051DC`**, `flex-grow: 1` |
| Dismiss icon (SVG) | **13 × 13**, `flex-shrink: 0`. viewBox `0 0 14 14`, `d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2"`, `stroke #6051DC`, `stroke-width 1.9`, `stroke-linecap round` |

**State difference worth porting:** in the *plain* composer the 24 × 24 marquee icon is bound to
`var(--color-icon)` (`#55565A`, grey). In the *with-selection* composer that same icon carries **no
colour override**, so it renders its raw SVG attribute **`#6051DC`** (brand violet). Verified on the
nodes: the plain icon's computed style is `{ stroke: "var(--color-icon)" }`; the attached one's is
`{}`. This is a real visual state change (grey → violet) and it is **not** mentioned in any spec row
or prose on the board. See §11.

Spec table, verbatim (**the card numbers in it are the stale ones — see the note above**):
`Size: 301 × 88 overall — card 301 × 67 + pill 301 × 50` · `Stacking: card absolute 0,0 · pill
absolute 0,38 · 29 overlap` · `Padding: pill left 18 · right 6 — card left 20 · right 16` ·
`Gap: pill 10 · no token` · `Radius: pill calc(infinity * 1px) — card 29 / 29 / 0 / 0 · no token` ·
`Fill: pill var(--color-surface) · card var(--color-brand-tint-soft)` · `Text: label 15 /
18 · 600 · var(--color-brand)` · `Elevation: pill 03 Control — card none` · `Layer path: Tutor chat /
Composer / {Attached context, Input}`.

### 1.3 `Composer · full-screen wide`

Stage 828 × 156 → component **740 × 68**. No wrapper — the pill is the component
(`position: relative`, `left: 0`, `top: 0`, `flex-shrink: 0`).

| Property | Value |
| --- | --- |
| Size | **740 × 68** — width `var(--container-column)`, height fixed |
| Padding | left **28** (`--spacing-7`), right **8** (`--spacing-2`), top/bottom 0 |
| Gap | **16** (`--spacing-4`) |
| Radius | `calc(infinity * 1px)` — all four corners |
| Fill | `var(--color-surface)` `#FFFFFF` |
| Shadow | **03 Control** — `#1414320D 0px 2px 6px, #14143208 0px 1px 2px` |
| Layout | `display: flex`, `align-items: center`, row |
| Layer path | `07 Tutor · full screen / Composer · wide` |

**Children (left → right)**

| Child | Size | Detail |
| --- | --- | --- |
| Placeholder text | **574** × 26, `flex-grow: 1` | **"Ask me anything…"** (note: different copy from the panel's "Ask anything…") — **21 / 26 · 400 · `var(--color-ink-tertiary)`** |
| `btn/voice` | **46 × 46** | `flex-shrink: 0`, no fill, no radius, glyph 26 × 26 stroke `var(--color-icon)` — see §7.3 |
| `btn/send` | **52 × 52** | `flex-shrink: 0`, brand fill, radius full, **carries a shadow** — see §7.2 |

The row closes exactly: `740 − 28 − 574 − 16 − 46 − 16 − 52 − 8 = 0`.

Spec table, verbatim: `Size: var(--container-column) 740 × 68` · `Padding: left 28 · right 8 · no
token` · `Gap: 16 · no token` · `Radius: calc(infinity * 1px) — all 4 · no token` ·
`Fill: var(--color-surface) · #FFFFFF` · `Text: 21 / 26 · 400 · var(--color-ink-tertiary)` ·
`Elevation: 03 Control — #1414320D 0 2 6, #14143208 0 1 2` ·
`Children: placeholder flex-grow 1 · voice 46 · send 52`.

**There is no marquee / attachment icon in the full-screen composer**, and no full-screen variant of
the attached-selection card exists on this board. See §11. Screen 07 does add a leading **`ui/plus`
20 × 20** here — `740 − 28 − 20 − 16 − 538 − 16 − 46 − 16 − 52 − 8 = 0`, the lane dropping 574 → 538
— which is board 03b's to specify, not this board's.

### 1.4 Composer variants — side-by-side diff

| | Panel (plain) | Panel (with selection) | Full-screen |
| --- | --- | --- | --- |
| Pill size | 301 × 50 | 301 × 50 (at `top: 38`) | 740 × 68 |
| Component height | 50 | **88** | 68 |
| Padding L / R | 18 / 6 | 18 / 6 | **28 / 8** |
| Gap | 10 | 10 | **16** |
| Radius | capsule (all 4) — 25 at rest | capsule (all 4) — 25 at rest | capsule (all 4) — **34** at rest |
| Placeholder | "Ask anything…" 17/22, lane 195 | "Ask anything…" 17/22, lane 195 | **"Ask me anything…" 21/26**, lane 574 |
| Leading marquee icon | 24 × 24, `--color-icon` | 24 × 24, **`#6051DC`** | **absent** |
| Voice button | **absent on this board — 34 × 34 on every screen** | **absent on this board — 34 × 34 on every screen** | 46 × 46 |
| Send button | 38 × 38, **no shadow** | 38 × 38, no shadow | 52 × 52, **shadow** |
| Attachment card | — | 301 × 63, radius 25/25/0/0 | **no variant exists** |
| Elevation | 03 Control | 03 Control (pill only) | 03 Control |

---

## 2. Section 02 — Attached-selection card

> **Section blurb:** "When the student lassoes part of the board, the composer grows a tinted card
> above the input. The card is not a separate block stacked on top of the pill — it is edge-to-edge
> behind it, and the two shapes are tuned to read as one object. Get the overlap wrong and the seam
> shows. This is the single geometry rule on the board most likely to be lost in a port, so it is
> stated in full below."

### 2.1 THE RULE (verbatim)

**This whole section is still written against the 58pt pill.** The law is right and is what the
current geometry is derived from; only the numbers plugged into it are stale. Both texts are quoted
as they stand, with the current arithmetic beneath.

> "A pill's top edge is only straight between its corner radii. At 301 wide with a 29 radius, that
> straight run is 301 − 2 × 29 = **243pt**. Anything full-width sitting behind the pill must extend
> past those curves, or a notch of background shows through at both corners."

> **Derived law, reusable anywhere on this board:** "card height = visible band + the corner radius
> of whatever sits on top of it. Here 67 = 38 visible + 29 hidden. The card's top two corners take
> that same 29 (58 ÷ 2) so the silhouette continues without a step."

So for a capsule of height *h*, effective corner radius = *h* / 2. **At the current pill: 50 / 2 =
25 in the panel and 68 / 2 = 34 full-screen.** The straight run is `301 − 2 × 25 = 251pt`, and the
composer's card is `38 + 25 = 63`.

Board 03b restates the same law at the current height, verbatim: *"card height = visible band + the
corner radius of whatever sits on top of it. The pill's radius is half its height, so the panel card
is 52 + 25 = 77 and the full-screen card is 64 + 34 = 98."* (Those are the **attachment-chip** card's
taller bands, not the selection card's 38 — the radii are the part to carry across.)

```
cardHeight   = visibleBand + radiusOfShapeOnTop
cardTopRadii = radiusOfShapeOnTop
pillTop      = visibleBand
stackHeight  = visibleBand + pillHeight
```

### 2.2 Notch diagram — Correct vs Wrong

**Both stages are still drawn at the 58pt pill** and are transcribed as found; the *ordering* lesson
is what they are for, and it is unaffected. At the current pill the same diagram would be a 301 × 88
composite of a 301 × 63 card and a 301 × 50 pill.

Both stages are 389 × 244 (component 301 × 96 + a 44pt caption block).

**Correct** — layer order: `Attached context` (301 × 67) first, `Input` (301 × 58) second.

> Caption: "Correct — card 301 × 67, tucked 29 behind the pill. One silhouette."

**Wrong** — layer order **inverted and the card shortened**:

| Layer | Order | Position | Size | Radius | Fill |
| --- | --- | --- | --- | --- | --- |
| `Frame` (the pill) | first (back) | `absolute 0, 38` | 301 × 58 | `calc(infinity * 1px)` | `var(--color-surface)`, 03 Control shadow |
| `Attached context · too short` | second (front) | `absolute 0, 0` | **301 × 38** | 29 / 29 / **0 / 0** | `var(--color-brand-tint-soft)` |

> Caption: "Wrong — card height 38, stacked on the pill instead of behind it. Background bites into
> both corners."

The failure: the card's bottom edge is straight at y = 38, but the pill's top corners curve inward
from y = 38 to y = 67, so the panel background shows through at both top corners.

### 2.3 `Attached context — card` (standalone specimen)

Stage 389 × 155 → component **301 × 63**. Identical geometry to §1.2's card, restated on its own.
(The stage is 155 = 67 + 2 × 44 because it is still built around the stale 67pt card; at 63 it
would be 151. Every other stage on the board is the current component plus the same 88.)

| Property | Value |
| --- | --- |
| Size | **301 × 63** — 38 visible + 25 behind the pill. Width fixed, height fixed |
| Position | `absolute 0, 0` — edge-to-edge, **first child of `Composer`** |
| Padding | left **20** · right **16** (no token); top/bottom 0 |
| Layout | `display: flex`, **`align-items: flex-start`** — label pins to the visible band |
| Radius | **25 / 25 / 0 / 0** — top two = pill 50 ÷ 2 (no token) |
| Fill | `var(--color-brand-tint-soft)` `#F1F0FB` |
| Border | none |
| Elevation | **none** — "the pill above it carries 03 Control" |
| Text | 15 / 18 · 600 · `var(--color-brand)` |
| Layer path | `Tutor chat / Composer / Attached context` |

> **Board 03's specimen is 301 × 67 / radius 29**, and its spec rows read `301 × 67 — 38 visible +
> 29 behind the pill` and `29 / 29 / 0 / 0 — top two = pill 58 ÷ 2 · no token`. Those are the 58pt
> pill's numbers, still drawn against a 50pt pill. **Screens 05 and 15a both measure 301 × 63 with
> a 25pt top radius**, which is also what §2.1's law gives, so 63 / 25 is what is reported above and
> what a port should build. The visible band, the padding, the label row and the total stack height
> are unaffected. See §11.

### 2.4 `Attached context — label row`

Stage 389 × 126 → component **265 × 38**.

| Property | Value |
| --- | --- |
| Size | **265 × 38** — "fills the card's visible band exactly" (265 = 301 − 20 − 16). Width fixed, height fixed, `flex-shrink: 0` |
| Padding | **top 6** · **inline 3** · bottom 0 (no token) |
| Layout | `flex` row · `align-items: center` · `justify-content: space-between` |
| Label | "Selection attached" — **15 / 18 · 600 · `var(--color-brand)`**, `flex-grow: 1` |
| Icons | **no leading icon** · trailing dismiss **13 × 13**, `flex-shrink: 0` |
| Layer path | `Tutor chat / Composer / Attached context / Frame` |

Internally the row wraps its contents in one more `flex: 1` / `align-items: center` frame before the
label + icon; that inner frame carries no styling of its own.

> **Note (verbatim):** "The label deliberately has no leading icon. The composer's own input already
> shows a selection-coloured marquee glyph two rows below, and repeating it here made the card read
> as a second control rather than a caption on the same one."

---

## 3. Section 03 — Messages

> **Section blurb:** "The asymmetry is the point. The tutor is unboxed text sitting directly on the
> panel — it is the voice of the surface, not a participant in a chat log. Only the student gets a
> bubble, right-aligned and shrunk to its content, so the eye can scan one edge to find everything
> the student said. A port that boxes both sides loses the whole hierarchy."

### 3.1 `msg/tutor · plain`

Stage 389 × 163 → component **301 × 75** (3 lines × 25).

| Property | Value |
| --- | --- |
| Node type | **`Text` — not a frame, not a bubble** |
| Size | width **301** fixed (`--container-panel-content`), **height auto** — wraps to the panel column |
| Padding | **none** — sits flush on the panel |
| Fill | **none** |
| Border | none |
| Radius | n/a |
| Text | **17 / 25 · 400 · `var(--color-ink)`**, `font-family: var(--font-sans)`, left-aligned |
| Elevation | **none** |
| Layer path | `Tutor chat / Thread / msg/tutor` |

Specimen copy: "It doesn't have to. Starting at the origin is just standard position — slide it
anywhere and it's the same vector."

### 3.2 `msg/tutor · with emoji`

Stage 389 × 138 → component **301 × 50** (2 lines × 25).

| Property | Value |
| --- | --- |
| Node type | **`Frame` (column) wrapping one `Text` — no styling of its own** |
| Size | width **301**, height auto |
| Gap | **12** — "for a second paragraph" (no token) |
| Text | **17 / 25 · 400 · `var(--color-ink)` — identical to plain** |
| Emoji | **inline glyph in the run — not an image, no size override** |
| Elevation | none |
| Layer path | `Tutor chat / Thread / msg/tutor` |

Specimen copy: "Great start! 🎉 A vector in 2D has two components — x and y."

**Porting note:** this is the *multi-paragraph* tutor message; a single-paragraph tutor message is a
bare `Text` node (§3.1). The 12pt column gap is the paragraph rhythm.

### 3.3 `msg/student · short`

Stage 389 × 137 → row **301 × 49**.

**Row (outer)**

| Property | Value |
| --- | --- |
| Size | **301** wide, height hugs the bubble |
| Layout | `display: flex`, **`justify-content: flex-end`** — bubble pinned right |

**Bubble (inner)**

| Property | Value |
| --- | --- |
| Size | **hugs content**, `max-width: 224` (both width *and* height intrinsic) |
| Padding | **block 12 · inline 16** (no token) |
| Radius | **`var(--radius-bubble)` 18px — all four corners equal** |
| Fill | `var(--color-surface-bubble)` `#F2F2F6` |
| Border | none |
| Elevation | **none** |
| Text | **17 / 25 · 400 · `var(--color-ink)`**, left-aligned inside the bubble |
| Layer path | `Tutor chat / Thread / msg/student / Frame` |

Height for *n* wrapped lines = `12 + 25n + 12`. Measured in the thread: 1 line → **49**, 2 lines →
**74**.

### 3.4 `msg/student · with selection` — the layered composite

Stage 389 × 184 → row **301 × 96**, bubble stack **224 × 96**.

This is the second use of the attachment-stack pattern. **Full layered geometry:**

```
Row                     301 × 96   flex, justify-content: flex-end
└─ "Bubble stack"       224 × 96   position: relative, flex-shrink: 0
   └─ inner frame       224 × 96   position: absolute, flex, flex-direction: column   (no paint)
      ├─ [z0, back ] card    224 × 67   absolute  left 0, top  0
      └─ [z1, front] bubble  224 × 58   absolute  left 0, top 38
```

| | Card (`Attached context`) | Bubble (`Input`, re-skinned) |
| --- | --- | --- |
| Size | **224 × 67** | **224 × 58** |
| Position | `absolute` `0, 0` | `absolute` `0, 38` |
| Radius TL / TR / BR / BL | **18 / 18 / 0 / 0** | **18 / 18 / 18 / 18** (`var(--radius-bubble)`) |
| Fill | `var(--color-brand-tint-soft)` `#F1F0FB` | `var(--color-surface-bubble)` `#F2F2F6` |
| Padding | left **20** · right **16** | **inline 20**, block 0 |
| Layout | `flex`, `align-items: flex-start` | `flex`, `align-items: center`, `gap: 12` |
| Shadow | none | none — "a sent message never floats" |

- **Overlap = 29** (67 − 38) · **visible card band = 38** · **stack height = 96**.
- **Card label row:** `Frame` **188 × 38** (= 224 − 20 − 16), `padding-top: 6`, `padding-inline: 3`,
  `flex`, `align-items: center`, `justify-content: space-between`; inner `flex: 1` row holds
  `Text "Selection"` — **15 / 18 · 600 · `var(--color-brand)`**, `flex-grow: 1`.
  **There is NO dismiss icon here** (unlike the composer card) — a sent message cannot be detached.
  The label copy is also shorter: **"Selection"**, not "Selection attached".
- **Bubble text:** "is my (x, y) label right?" — **17 / 22 · 400 · `var(--color-ink)`**,
  `flex-grow: 1`. Note the **22** line-height, not the 25 used by every other message.

Spec table, verbatim: `Size: Bubble stack 224 × 96 — card 224 × 67 + bubble 224 × 58` · `Stacking:
same rule as the composer — card 0,0 · bubble 0,38` · `Padding: bubble inline 20 — card left 20 ·
right 16` · `Radius: bubble var(--radius-bubble) 18px — card 18 / 18 / 0 / 0 · top corners only, left
raw deliberately` · `Fill: bubble var(--color-surface-bubble) · card var(--color-brand-tint-soft)` ·
`Text: body 17 / 22 · 400 — label "Selection" 15 / 18 · 600` · `Elevation: none — a sent message
never floats` · `Layer path: Thread / msg/student · with selection / Bubble stack`.

> **Note — "Fragile for a port" (verbatim):** "in the file this bubble is a copy of the composer
> subtree — its inner frame is still named `Composer` and its `Input` frame is re-skinned as a
> bubble. The two are not linked, so a change to the composer will not reach here. Build it as one
> shared 'attachment stack' primitive parameterised by width, radius and fill."

**Geometry consequence of that copy (flagged in §11):** the derived law in §2.1 would give a card
height of `38 + 18 = 56` here, because the shape on top has an 18pt radius, not a 29pt capsule
radius. The card is **67** — the composer's number, carried over by the copy. This is *visually
safe* (67 > 56, so the bubble's corner curves are fully covered and no notch appears) but **11pt of
the card is hidden for no reason**, and a parameterised primitive would produce 56. Build the
primitive with `cardHeight = visibleBand + topShapeRadius` and expect 56 here; if pixel-parity with
the mock is required, hard-code 67.

---

## 4. Message-list composition (vertical rhythm)

### 4.1 The gap is uniform

**`var(--space-message-gap)` = 22px between every pair of consecutive children, regardless of
author.** There is no tutor-vs-student variation, no run-grouping, no tighter gap for same-author
runs. Token description (Foundations): *"Deliberately off the 4px grid — 24px read as too loose and
20px too dense at 17px body."*

Measured on the live 9-message thread demo (y offsets relative to the thread column, all in pt):

| # | Child | y | height | next y | gap |
| --- | --- | --- | --- | --- | --- |
| 1 | `msg/tutor` (Text) | 5 | 50 | 77 | 22 |
| 2 | `msg/student` | 77 | 49 | 148 | 22 |
| 3 | `msg/tutor` (Text) | 148 | 50 | 220 | 22 |
| 4 | `msg/student` | 220 | 49 | 291 | 22 |
| 5 | `msg/tutor` (Frame, emoji) | 291 | 50 | 363 | 22 |
| 6 | `msg/student` (2 lines) | 363 | 74 | 459 | 22 |
| 7 | `msg/tutor` (Text, 3 lines) | 459 | 75 | 556 | 22 |
| 8 | `msg/student · with selection` | 556 | 96 | 674 | 22 |
| 9 | `msg/tutor` (Text) | 674 | 50 | 746 | 22 |
| 10 | `btn/orb` | 746 | 46 | — | — |

Content bottom = 746 + 46 = **792**; + `padding-bottom: 18` = **810** = the thread height. Because
`justify-content: flex-end`, all slack lands at the top (5pt here).

### 4.2 Scroll container insets

The `Thread` **is** the scroll container. It is a fixed-height flex column, not a scroll view with
content insets in the UIKit sense:

| Inset | Value |
| --- | --- |
| Top | **0** (the 72pt `Scroll fade` overlays the top but takes no space) |
| Bottom | **18** — `padding-bottom: 18`, "clears `var(--space-panel-inset)`" |
| Leading / trailing | **0** — the thread is exactly `--container-panel-content` (301) wide; the panel's 18pt inset is applied by the panel, not the thread |

Horizontal alignment is per message: tutor messages are full-width `Text` at 301; student rows are
301 wide with `justify-content: flex-end` and a 224 max-width bubble.

---

## 5. Section 04 — Thread

> **Section blurb:** "`justify-content: flex-end` is the whole behaviour. The thread is a
> fixed-height column, so a short conversation sits on top of the composer and grows upward instead
> of hanging from the top of the panel with a void beneath it. The newest message is always the same
> distance from the input, which is where the eye already is. It is also the positioning context for
> the scroll fade, so it must stay `position: relative`."

### 5.1 `Thread`

Stage 389 × 898 → component **301 × 810**.

| Property | Value |
| --- | --- |
| Size | **301 × 810** — width `var(--container-panel-content)`; height fixed in situ |
| Layout | `flex` column · **`justify-content: flex-end`** · **`position: relative`** |
| Padding | **bottom 18** — "clears `var(--space-panel-inset)`" (no token). All other sides 0 |
| Gap | **`var(--space-message-gap)` · 22px** |
| Children | messages · `btn/orb` 46 · `Scroll fade` (last, absolute) |
| Fill | **none** — inherits `var(--color-surface-panel)` |
| Border | none |
| Elevation | none |
| Layer path | `Tutor chat / Thread` |

### 5.2 Child ordering — two hard constraints

> **Note (verbatim):** "Two ordering constraints a port must preserve. `btn/orb` (46 × 46) is a
> normal flow child at the end of the message list, so it rides up and down with the conversation
> rather than being pinned to the panel. `Scroll fade` is the very last child and absolutely
> positioned, so it paints over every message but sits below `Panel controls`, which are a sibling
> of `Thread` rather than inside it. Reordering either one breaks the layering with no error."

1. `btn/orb` — **in normal flow**, last item *before* the fade, so it participates in the 22pt gap
   and scrolls with the conversation.
2. `Scroll fade` — **last child, `position: absolute`**, so paint order puts it over the messages
   but under `Panel controls` (a sibling of `Thread`).

### 5.3 `btn/orb` (46 × 46) — the only non-message affordance in the thread

No dedicated specimen or spec table exists for the orb on this board (it belongs to board 02 —
Components · Shell). Geometry read off the live node inside the thread:

```
btn/orb                46 × 46   flex, align-items center, justify-content center, position relative, flex-shrink 0
├─ Halo                94 × 92   position absolute, left −24, top −23   (overflows the 46pt box on all sides)
│                      background: three stacked radial-gradients in oklab (see below)
└─ Orb body            32 × 25   radius calc(infinity * 1px), flex, align-items center,
                                 justify-content center, gap 10, padding-top 3, position relative
                                 background: linear-gradient(in oklab 180deg,
                                   oklab(25.4% -0.001 -0.053) 0%, oklab(17.5% -0.009 -0.032) 46%,
                                   oklab(13% -0.010 -0.019) 100%)
   ├─ Eye              4 × 4     radius full, #FFFFFF
   └─ Eye              4 × 4     radius full, #FFFFFF
```

Halo background (verbatim):
`radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 75%) 0%, oklab(89.8% 0.036 -0.034 / 34%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%), radial-gradient(ellipse 46% 44% at 64% 58% in oklab, oklab(86.7% 0.001 -0.054 / 70%) 0%, oklab(90.5% .0006 -0.038 / 30%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%), radial-gradient(ellipse 29% 28% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%)`

The in-thread orb has **two eyes and no mouth**. The hero orb in the full-screen greeting (§9.2) is
the same construction at a different size **and has a mouth**.

---

## 6. Section 05 — Scroll fade

> **Section blurb:** "A 72pt panel-coloured gradient pinned to the top of the thread, so messages
> dissolve into the panel instead of being guillotined by its edge. It is the thread's last child on
> purpose: that paints it over the messages but still underneath the panel controls, which live
> outside the thread. **Warning for the port — this is the one colour in the whole file that is not
> tokenised.** A CSS gradient cannot take a token for its transparent stop, so `#FCFCFC` is
> hard-coded in all four stops. If `var(--color-surface-panel)` ever changes, this gradient must be
> edited by hand or the fade will bleed a different white over the messages."

Stage 389 × 306 → the demo shows three messages behind a fade.

| Property | Value |
| --- | --- |
| Size | **301 × 72** — width = thread width, height fixed |
| Position | **`absolute` `0, 0` — last child of `Thread`** |
| Fill | `linear-gradient` **180deg** · **NOT TOKENISED** |
| Stops (as documented) | `#FCFCFC 0%` · `#FCFCFC 34%` · `rgba(252,252,252,.72) 62%` · `rgba(252,252,252,0) 100%` |
| Stops (as stored in the file) | `linear-gradient(in oklab 180deg, oklab(99.1% 0 0) 0%, oklab(99.1% 0 0) 34%, oklab(99.1% 0 0 / 72%) 62%, oklab(99.1% 0 0 / 0%) 100%)` |
| Interpolation | stored in **oklab** — **"port as a plain sRGB alpha ramp"** |
| Radius / border | none |
| Elevation | **none — "it is paint order, not a shadow"** |
| Layer path | `Tutor chat / Thread / Scroll fade` |

The demo's container (`Fade demo`) is 301 wide, `height: fit-content`, `flex` column,
`gap: var(--space-message-gap)`, `position: relative` — i.e. a miniature thread.

---

## 7. Section 07 — Composer buttons

> **This entire section is still drawn at the 58pt pill and every box in it is superseded.** The
> button boxes came down with the pill; the **glyphs did not move**. Current sizes, from the
> composer specimens on this same board (§1.1, §1.3) and from every screen:
>
> | | Board 03 §7 draws | Current | Glyph |
> | --- | --- | --- | --- |
> | `btn/send`, panel | 42 × 42 | **38 × 38** | 22 (unchanged) |
> | `btn/send`, full-screen | 56 × 56 | **52 × 52** | 26 (unchanged) |
> | `btn/voice`, full-screen | 52 × 52 | **46 × 46** | 26 (unchanged) |
> | `btn/voice`, panel | *not drawn* | **34 × 34** | **20** |
>
> Everything else below — the radii, the fills, the shadow asymmetry, the glyph paths — is
> unaffected and still holds. See §11.

> **Section blurb:** "Send is the only filled brand-colour object in the chat surface, which is what
> lets it hold its own inside a white pill without a border. It scales with the composer — 42 in the
> panel, 56 full-screen — while the glyph stays fixed at 22 and 26, so the ring of colour grows
> faster than the mark inside it. Unresolved: voice exists only at full-screen scale. See the note
> below rather than assuming it was an oversight in one direction or the other."

Spec table, verbatim: `Size: send 42 × 42 · send 56 × 56 · voice 52 × 52` · `Glyph: 22 · 26 · 26 —
centred, no padding` · `Radius: send calc(infinity * 1px) — voice has no radius set` · `Fill: send
var(--color-brand) — voice none, glyph only` · `Layout: flex · align-items center · justify-content
center · flex-shrink 0` · `Elevation: send 42 none — send 56 has #1414320F 0 2 6, #1414320A 0 1 2` ·
`Layer path: Composer / btn/send · Composer / btn/voice`.

### 7.1 `btn/send` — 42 as drawn here, **38 in the panel**

| Property | Value |
| --- | --- |
| Size | 42 × 42 on this board — **38 × 38** in §1.1 and on every screen, `flex-shrink: 0` |
| Radius | `calc(infinity * 1px)` |
| Fill | `var(--color-brand)` `#6051DC` |
| Border | none |
| Shadow | **none** |
| Layout | `flex`, `align-items: center`, `justify-content: center`, no padding |
| Glyph | **22 × 22**, viewBox `0 0 24 24`; `M12 19.4V5.4` + `M5.8 11.6 12 5.4l6.2 6.2`; `stroke #FFFFFF`, `stroke-width 2.5`, `linecap round`, `linejoin round` |

### 7.2 `btn/send` — 56 as drawn here, **52 full-screen**

Identical to §7.1 except:

| Property | Value |
| --- | --- |
| Size | 56 × 56 on this board — **52 × 52** in §1.3 and on screen 07 |
| Glyph | **26 × 26** (same viewBox and paths, same 2.5 stroke) |
| Shadow | **`#1414320F 0px 2px 6px, #1414320A 0px 1px 2px`** |

### 7.3 `btn/voice` — 52 as drawn here, **46 full-screen and 34 in the panel**

| Property | Value |
| --- | --- |
| Size | 52 × 52 on this board — **46 × 46** in §1.3 and on screen 07; **34 × 34** in the panel row (screens 05 / 08 / 15a, board 03b), `flex-shrink: 0` |
| Radius | **none set** |
| Fill | **none** — glyph only |
| Shadow | none |
| Layout | `flex`, `align-items: center`, `justify-content: center` |
| Glyph | **26 × 26** full-screen — **20 × 20** in the panel. viewBox `0 0 24 24`, mic: capsule body + arc + stem; `stroke: var(--color-icon)` on all three paths, `stroke-width 1.9` |

It is a **bare hit area around a glyph**, not a pill, at every size.

### 7.4 "UNRESOLVED — DECIDE BEFORE BUILD" (verbatim)

**The first of these three is no longer unresolved — the screens decided it.** `btn/voice` 34 × 34
is drawn in the panel composer on screens 05, 08 and 15a and on board 03b, i.e. the design took the
"add voice to the panel composer" branch. Only this section still says otherwise. The two smaller
mismatches in the second quote do still stand (with the boxes renumbered 52 → 46 and 42 → 38).

> "The voice button exists only in the full-screen composer. It is absent from the panel composer
> and from the collapsed dock, so dictation silently disappears when the tutor is not full-screen.
> This is an inconsistency in the design, not a considered rule — nothing in the layout explains it,
> and the panel composer has the room. Either add voice to the panel composer or remove it from
> full-screen; **do not copy the current asymmetry into code as if it were intentional.**"

> "Two smaller mismatches in the same family: the 56 send button carries a shadow (`#1414320F 0 2 6,
> #1414320A 0 1 2` — elevation 02 Panel) while the 42 send button carries none; and `btn/voice` has
> no `border-radius` or fill at all — it is a bare 52 × 52 hit area around a glyph, so it is not a
> pill like its neighbour despite reading as one in the mock."

---

## 8. Section 06 — Suggestion chips

> **Section blurb:** "Openers for a student who does not yet know what to ask. They are
> icon-plus-label rows with no right padding — the label ends where it ends, and the chip's width is
> set by its column, not its content. Both scales carry elevation 03 so they read as tappable
> objects lying on the surface rather than fields cut into it. The full-screen set is a 2 × 2 grid
> produced by wrapping a 740pt row, not by a grid definition, which matters if the copy ever grows."

### 8.1 `chip/suggestion — panel`

Stage 389 × 398. Container `Suggestions` **301 × 278** with **`margin-top: var(--spacing-8)` = 32**.

**Container**

| Property | Value |
| --- | --- |
| Size | **301 × 278** (4 × 62 + 3 × 10), `flex-shrink: 0` |
| Layout | `flex` column |
| Gap | **10** |
| Margin | **`margin-top: 32`** (`--spacing-8`) — this is the greeting→suggestions margin, see §9.1 |

**Chip**

| Property | Value |
| --- | --- |
| Size | **301 × 62** — width fixed to the column, height fixed; `flex-shrink: 0` |
| Padding | **left 18 only — no right padding**, no top/bottom (no token) |
| Gap | **14** — icon 22 → label (no token) |
| Radius | **`var(--radius-lg)` · 14px** — all four corners |
| Fill | `var(--color-surface)` `#FFFFFF` |
| Border | none |
| Shadow | **03 Control** — `#1414320D 0px 2px 6px, #14143208 0px 1px 2px` |
| Layout | `flex` row, `align-items: center` |
| Icon slot | **22 × 22** SVG, `flex-shrink: 0`, viewBox `0 0 24 24`, stroke `#6051DC` (`--color-brand`), `stroke-width 1.9` |
| Label | **17 / 22 · 500 (`--font-weight-medium`) · `var(--color-ink)`**, left-aligned, no width constraint |
| Layer path | `Tutor chat / Start state / Suggestions / chip/…` |

The four specimen chips and their glyphs: "Explain this concept" (lightbulb), "Give me an example"
(two sparkles), "Create an exercise" (pencil-on-square), "I don't understand this" (question mark in
circle; the dot is a filled `circle r=1.15 fill #6051DC`).

### 8.2 `chip/suggestion — full-screen`

Stage 828 × 256. Container **740 × 168**.

**Container**

| Property | Value |
| --- | --- |
| Size | **740 wide × 168 tall** (2 rows × 74 + 20) |
| Layout | `flex` row · **`flex-wrap: wrap`** — "2 × 2 by wrapping", **not a grid definition** |
| Gap | **20** (`--spacing-5`), both axes |
| Position | `relative`, `left: 0`, `top: 0` |

**Chip**

| Property | Value |
| --- | --- |
| Size | **360 × 74**, `flex-shrink: 0` (360 × 2 + 20 = 740 exactly) |
| Padding | **left 22 only — no right padding** (no token) |
| Gap | **16** — icon 24 → label (no token) |
| Radius | **`var(--radius-lg)` · 14px — same as panel, deliberately not scaled** |
| Fill | `var(--color-surface)` `#FFFFFF` |
| Shadow | **03 Control** — identical to panel |
| Icon slot | **24 × 24** (up from 22), same paths, stroke `#6051DC`, `stroke-width 1.9` |
| Label | **20 / 24 · 500 · `var(--color-ink)`** (`--text-body-lg`) |
| Layer path | `07 Tutor · full screen / Frame (suggestions) / chip/…` |

### 8.3 Chip diff

| | Panel | Full-screen |
| --- | --- | --- |
| Chip | 301 × 62 | **360 × 74** |
| Left padding | 18 | **22** |
| Right padding | 0 | 0 |
| Icon → label gap | 14 | **16** |
| Icon | 22 | **24** |
| Label | 17 / 22 · 500 | **20 / 24 · 500** |
| Radius | 14 | **14 (unchanged)** |
| Container | 301, column, gap 10 | **740, row + wrap, gap 20** |
| Shadow | 03 Control | 03 Control |

---

## 9. Section 08 — Greeting blocks

> **Section blurb:** "The same block restated for a 301pt column and a 740pt one. It is not a linear
> scale: the title jumps 26 → 40 while the body only goes 17 → 21, so the headline gains most of the
> extra room and the supporting line stays at a comfortable reading size. That widening ratio —
> roughly 1.5× on display, 1.2× on body — is the type rule to carry into any other two-width
> component."

**These blocks use explicit margins, not gaps and not spacer rectangles.** `gap` is `none` on both;
all vertical rhythm is `margin-top` on the children. Values below are the true, current margins.

### 9.1 `Greeting · panel` — layer `Start state · greeting only`

Stage 389 × 222 → component **301 × 94**.

**Container**

| Property | Value |
| --- | --- |
| Size | **301 × 94** — width fixed, **height intrinsic** (sum of children + margins), `flex-shrink: 0` |
| Layout | `flex` column · `align-items: center` · text-align center |
| Gap | **none** |
| Margin | **`margin-top: var(--spacing-10)` = 40** on the block itself |
| Padding (in situ) | **bottom 120 — "lifts the block off the composer"** (declared in the spec table; not applied on the specimen node) |
| Layer path | `Tutor chat / Start state` |

**Children (in flow order)**

| # | Child | y | Size | Margin-top | Type |
| --- | --- | --- | --- | --- | --- |
| 1 | Title "Hi! I'm your AI Tutor" | 0 | 301 × 34 | 0 | **26 / 34 · 600 · `-0.01em` · `var(--color-ink)`**, centred |
| 2 | Body "I'm here to help you learn, practice and achieve your goals." | 46 | **277** × 48 | **12** (`--spacing-3`) | **17 / 24 · 400 · `var(--color-ink-secondary)`**, centred, wraps to 2 lines |

**Total height = 34 + 12 + 48 = 94.** Body width is constrained to **277** (not 301) to force the
2-line wrap; the title is the full 301.

**Composed panel start state** (greeting + chips, both measured on this board):

```
margin-top 40   (--spacing-10, on the greeting block)
greeting        94
margin-top 32   (--spacing-8, on the Suggestions container)
suggestions    278   (4 × 62 + 3 × 10)
padding-bottom 120   (declared "in situ" only)
────────────────────
greeting + margin + chips = 404
… + the declared 120 bottom padding = 524
```

> Spec row, verbatim: `Gap: none — margin-top 12 on the body copy, 32 on the suggestion stack`.

### 9.2 `Greeting · full-screen` — layer `Greeting block`

Stage 828 × 352 → component **740 × 264** as drawn. Spec table says **"1376 × 268 in situ"** — see
§11.

> **Note (verbatim):** "Shown here at 740 to fit the page. In the live screen this block is **1376
> wide with centred children** — it is not clipped to the 740pt reading column the way the chip grid
> and the composer below it are."

**Container**

| Property | Value |
| --- | --- |
| Size | **740 × 264** on this board; **1376 wide in situ** |
| Layout | `flex` column · `align-items: center` · `position: relative` · `flex-shrink: 0` |
| Gap | **none** |
| Margin | none on the block itself |

**Children (in flow order)**

| # | Child | y | Size | Margin-top | Type |
| --- | --- | --- | --- | --- | --- |
| 1 | `Orb · hero` | 0 | **150 × 142** | 0 | see below |
| 2 | Title "Hi! I'm your AI Tutor" | 174 | intrinsic × 48 | **32** (`--spacing-8`) | **40 / 48 · 600 · `-0.01em` · `var(--color-ink)`** |
| 3 | Body "I'm here to help you learn, practice and achieve your goals." | 234 | intrinsic × 30 | **12** (`--spacing-3`) | **21 / 30 · 400 · `var(--color-ink-secondary)`** |

**Total height = 142 + 32 + 48 + 12 + 30 = 264.**

**`Orb · hero`** — `150 × 142`, `flex`, `align-items: center`, `justify-content: center`,
`position: relative`:

```
Halo        296 × 282   position absolute, left −73, top −77
                        (same 3-radial-gradient recipe as §5.3, alphas 78/36/0 · 74/32/0)
Orb body     84 × 66    radius calc(infinity * 1px), position relative,
                        linear-gradient(in oklab 180deg,
                          oklab(25.4% -0.001 -0.053) 0%, oklab(17.5% -0.009 -0.032) 46%,
                          oklab(13% -0.010 -0.019) 100%)
├─ Eye       11 × 11    absolute left 20, top 22, radius full, #FFFFFF
├─ Eye       11 × 11    absolute left 53, top 22, radius full, #FFFFFF
└─ Mouth     18 × 10    absolute left 33, top 40; SVG viewBox "0 0 18 10",
                        d="M1.6 1.6C4 6.4 14 6.4 16.4 1.6", stroke #FFFFFF, stroke-width 2.4, linecap round
```

Spec row, verbatim: `Orb: hero 150 × 142 · halo 296 × 282`.

### 9.3 Greeting diff

| | Panel | Full-screen |
| --- | --- | --- |
| Block size | **301 × 94** | **740 × 264** (1376 wide in situ) |
| Orb | **absent** | 150 × 142 hero + 296 × 282 halo |
| Title | 26 / 34 · 600 · −0.01em | **40 / 48 · 600 · −0.01em** (1.54×) |
| Body | 17 / 24 · 400, width capped **277** | **21 / 30 · 400**, width unconstrained (1.24×) |
| Title margin-top | 0 | **32** |
| Body margin-top | **12** | **12** |
| Block margin-top | **40** | 0 |
| Alignment | `align-items: center` + `text-align: center` | `align-items: center` |
| Colours | title `--color-ink`, body `--color-ink-secondary` | same |

---

## 10. Quick reference — every specimen and its frame size

| Component (as named in the design) | Frame (W × H) | Intrinsic dimension |
| --- | --- | --- |
| `Composer · panel, plain` (Input pill) | 301 × 50 | neither — both fixed |
| `Composer · panel, with attached selection` | 301 × 88 | height = 38 + 50, both fixed |
| ↳ `Attached context` card | 301 × 63 | both fixed (board 03 still draws 67 — §11) |
| ↳ `Input` pill | 301 × 50 | both fixed |
| `Composer · full-screen wide` | 740 × 68 | both fixed |
| `Attached context — card` (standalone) | 301 × 63 | both fixed (board 03 still draws 67 — §11) |
| `Attached context — label row` | 265 × 38 | both fixed |
| `msg/tutor · plain` | 301 × auto | **height intrinsic** |
| `msg/tutor · with emoji` | 301 × auto | **height intrinsic** |
| `msg/student · short` (row) | 301 × auto | **height intrinsic** |
| ↳ bubble | hug × hug, `max-width: 224` | **both intrinsic** |
| `msg/student · with selection` (row) | 301 × 96 | both fixed |
| ↳ Bubble stack | 224 × 96 | both fixed |
| ↳ card | 224 × 67 | both fixed |
| ↳ bubble | 224 × 58 | both fixed |
| `Thread` | 301 × 810 | both fixed in situ |
| `btn/orb` | 46 × 46 | both fixed |
| `Scroll fade` | 301 × 72 | both fixed |
| `chip/suggestion — panel` | 301 × 62 | both fixed |
| ↳ `Suggestions` container | 301 × 278 | **height intrinsic** |
| `chip/suggestion — full-screen` | 360 × 74 | both fixed |
| ↳ container | 740 × 168 | **height intrinsic (wrapping)** |
| `btn/send` (panel) | 38 × 38 | both fixed (§7 still draws 42 — §11) |
| `btn/send` (full-screen) | 52 × 52 | both fixed (§7 still draws 56 — §11) |
| `btn/voice` (full-screen) | 46 × 46 | both fixed (§7 still draws 52 — §11) |
| `btn/voice` (panel) | 34 × 34 | both fixed — **not drawn on board 03 at all** |
| `Greeting · panel` | 301 × 94 | **height intrinsic** |
| `Greeting · full-screen` | 740 × 264 (1376 in situ) | **height intrinsic** |
| ↳ `Orb · hero` | 150 × 142 | both fixed |

**Text styles used in the chat surface** (all `--font-sans` / Source Sans 3):

| Where | Size / line-height | Weight | Tracking | Colour |
| --- | --- | --- | --- | --- |
| Tutor message, student bubble (short) | 17 / 25 | 400 | normal | `--color-ink` |
| Student bubble inside the selection stack | **17 / 22** | 400 | normal | `--color-ink` |
| Composer placeholder (panel) | 17 / 22 | 400 | normal | `--color-ink-tertiary` |
| Composer placeholder (full-screen) | 21 / 26 | 400 | normal | `--color-ink-tertiary` |
| Selection label (composer card & bubble card) | 15 / 18 | 600 | normal | `--color-brand` |
| Chip label (panel) | 17 / 22 | 500 | normal | `--color-ink` |
| Chip label (full-screen) | 20 / 24 | 500 | normal | `--color-ink` |
| Greeting title (panel) | 26 / 34 | 600 | −0.01em | `--color-ink` |
| Greeting body (panel) | 17 / 24 | 400 | normal | `--color-ink-secondary` |
| Greeting title (full-screen) | 40 / 48 | 600 | −0.01em | `--color-ink` |
| Greeting body (full-screen) | 21 / 30 | 400 | normal | `--color-ink-secondary` |

---

## 11. Open questions / ambiguities

1. **The 56pt send button's shadow matches no documented elevation level.** Its value is
   `#1414320F 0px 2px 6px, #1414320A 0px 1px 2px`. The board's own "Unresolved" note calls this
   "elevation 02 Panel", but Foundations defines 02 Panel as `#1414320E 0px 3px 10px, #1414320A 0px
   1px 3px` and 03 Control as `#1414320D 0px 2px 6px, #14143208 0px 1px 2px`. The actual value is
   03 Control's *geometry* with two different alphas (`0F` / `0A`). It is a fourth, undocumented
   shadow. **Decide: promote it to 03 Control, or add it to the elevation scale.**

2. ~~**Voice button exists only at full-screen scale.**~~ **Resolved by the screens, not yet by
   board 03.** Screens 05, 08 and 15a and board 03b all draw `btn/voice` **34 × 34** with a 20pt mic
   glyph in the panel composer, between the placeholder and send. The design took the "add voice to
   the panel composer" branch. Board 03's §1.1 specimen and its §7.4 note are the only places that
   still say otherwise, and they are stale, not a second opinion. **Nothing to decide — board 03
   needs redrawing.**

3. **`btn/voice` has no radius and no fill**, so its box (46 full-screen, 34 in the panel) is a bare
   hit area. It reads as a pill in the mock only because of the glyph. Decide whether it should get
   a shape.

4. **The composer's marquee icon changes colour between states and this is undocumented.** Plain:
   `stroke: var(--color-icon)` `#55565A`. With selection attached: no override, so the raw
   `#6051DC` applies. No spec row or prose mentions it. Confirm this is intentional (it reads as a
   sensible affordance) and add the token binding.

5. **`msg/student · with selection` card height (67) does not follow the board's own derived law.**
   The law gives `38 + 18 = 56` for an 18pt-radius bubble; the file has 67, inherited verbatim from
   the composer copy. Visually safe but 11pt is hidden for nothing. A shared parameterised
   primitive would produce 56. Decide which to build.

6. **Full-screen greeting height: 264 drawn vs "268 in situ" declared.** The measured node is
   `142 + 32 + 48 + 12 + 30 = 264`; the spec row says `1376 × 268 in situ`. 4pt unexplained. Cross-check
   against board 07 before hard-coding either number.

7. **No greeting block on this board is 522pt tall.** A `522` value was expected. Searched the whole
   artboard for both the literal text "522" and any node with `height: 522px` — zero hits. Measured
   greeting heights are **94** (panel) and **264** (full-screen); the composed panel start state
   (greeting + 32 margin + 278 chips + the declared 120 bottom padding) is **524**, not 522.
   If 522 is authoritative it comes from a different board (probably 07 / 08) and must be
   reconciled there.

8. **The panel greeting's `margin-top: 40` (`--spacing-10`) is not in any spec row.** The spec lists
   only "margin-top 12 on the body copy, 32 on the suggestion stack" and "padding bottom 120 in
   situ". The 40 sits on the greeting block node itself. It may be stage-centring residue or a real
   in-situ offset — confirm against board 07 before shipping it.

9. **The panel greeting's `padding-bottom: 120` is documented but not applied.** It appears only as
   a spec-table row ("bottom 120 in situ"); the specimen node has no bottom padding. Treat the spec
   row as authoritative for the live screen.

10. **No streaming / typing / loading / error / retry affordance exists on this board.** The orb is
    the only candidate and it is documented as a *button* (`btn/orb`), not a state indicator, with
    no animation, variant, or spec table here. If the app needs a "tutor is thinking" state, it is
    undesigned.

11. **The composer has no filled / focused / disabled variant.** Only the empty placeholder state is
    drawn, at both widths. Focus ring, caret, filled-text colour, disabled send, and character
    limits are all undefined.

12. **No full-screen variant of the attached-selection composer exists.** The 740 × 68 pill has no
    card specimen, so the card width, the 28/8 padding interaction, and the capsule radius
    (68 ÷ 2 = **34**, implying a 34pt overlap and 34pt top radii by the derived law) are all
    unverified extrapolations. Board 03b's chip card is the nearest drawn thing and uses that same
    34 full-screen, which is corroboration but not the selection card.

13. **Thread height 810 is a single measured instance,** not a formula. It is the panel height minus
    the panel's own chrome on board 05/08; this board does not state how it is derived.

14. **Token-binding inconsistency in the chip icons.** In the full-screen chip set, the first chip's
    first path is bound to `var(--color-brand)` while every other path in every chip carries the raw
    `#6051DC`. Same rendered colour, so no visual bug — but a find-and-replace on the token will
    miss them.

15. **Board 03 is half-redrawn for the 50pt pill, and contradicts itself.** §1 (the blurb and all
    three composer specimens) is current; §2 and §7 are not. The live disagreements, all confirmed
    on the nodes:

    | Where | Board 03 draws | Screens 05 / 07 / 08 / 15a + board 03b | Reported above as |
    | --- | --- | --- | --- |
    | Attached card, §1.2 + §2.3 | 301 × **67**, radius **29** | 301 × **63**, radius **25** | 63 / 25 |
    | The rule, §2.1 | `301 − 2 × 29 = 243` | `301 − 2 × 25 = 251` | both |
    | Derived law, §2.1 | `67 = 38 + 29`, "29 (58 ÷ 2)" | `63 = 38 + 25`, "25 (50 ÷ 2)" | both |
    | Notch diagram, §2.2 | 301 × 96 of 67 + 58 | 301 × 88 of 63 + 50 | as drawn, flagged |
    | `btn/send` panel, §7 | 42 | **38** | 38 |
    | `btn/send` full-screen, §7 | 56 | **52** | 52 |
    | `btn/voice` full-screen, §7 | 52 | **46** | 46 |
    | `btn/voice` panel, §1.1 + §7 | absent | **34**, glyph 20 | 34 |

    The composite's **total** height is 88 on every surface, because the overlap absorbs the card's
    4pt — which is why the stale card survived a partial redraw without looking wrong. **Redraw §2
    and §7 at the 50/68 pill before either is used as a source again.**

16. **The panel composer's row is documented in three places and only one of them is the product's.**
    §1.1's specimen is `icon 24 · placeholder 195 · send 38`; the screens are `plus 20 · marquee 24 ·
    placeholder 121 · voice 34 · send 38`; the Swift `ComposerMetrics.panel` is the screens' row
    without the plus, `marquee 24 · placeholder 151 · voice 34 · send 38`. All three close on 301,
    which is exactly why the discrepancy is easy to miss — the lane absorbs it. The plus is new
    design (board 03b) that the code has not taken yet; the voice button is not new and the
    specimen is simply behind.
