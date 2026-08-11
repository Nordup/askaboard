# 04 — Icons

Complete extraction of the icon set from the Paper file **"AI Whiteboard Tutor — Design System, Components & Page"**, artboard **04 — Icons** (1680×6140).

Every number, colour, path and attribute below was read from the design's markup (`get_jsx` / `get_computed_styles`), never from a screenshot. Screenshots were used only to confirm each glyph looks the way its markup says it does.

**18 distinct assets** — 16 product glyphs + 2 OS-chrome stand-ins that must not be ported.

---

## How to read this document

### Effective rendered stroke weight

The board's central thesis:

> What the eye reads is not the stroke attribute but the rendered weight: `strokeWidth × (rendered ÷ viewBox)`. Measured that way the set spans 1.58 to 2.71 — a 1.7× range — which is why it never looked like one family, and why tuning attributes by eye kept failing. The target is 2.0 rendered.

For the three non-square glyphs the governing scale is the *uniform* scale under the default `preserveAspectRatio="xMidYMid meet"` — i.e. `min(renderW/vbW, renderH/vbH)`. `board/hinge` is where this matters: width ratio gives 1.61, height ratio gives 1.58, and 1.58 is the number the board quotes as the set minimum.

### Two layers of truth: specimen vs. product

This is the single most important thing for the SwiftUI port.

The **icon board specimens** carry the *original, un-normalised* stroke attributes. The **product artboards** (05 Board+Tutor, 06 collapsed, 07 full screen, 08 in-conversation) carry the *same markup* plus **inline style overrides** that implement the normalisation. The override always wins.

So a glyph can read `strokeWidth="2.2"` in the markup and render at `2.0` because an inline `style={{ strokeWidth: '2' }}` sits on top of it. Every record below gives both.

Two glyphs also have their **rendered size** overridden the same way (`tool/pen`, `composer/dismiss`) — the `width`/`height` attributes are stale and the inline style is what renders.

---

## The stroke-weight rule

**Target: 2.0 rendered on every product glyph.**

Board's own summary rows:

| | |
|---|---|
| Distinct assets documented | 18 — selection-marker serves both composer and dock |
| viewBox in use | `0 0 24 24` — 8 · `0 0 28 28` — 6 · `0 0 14 14` — 1 · non-square — 3 |
| Target rendered weight | 2.0 on every product glyph — 3 documented exceptions |
| Stroke attributes before normalisation — tuned by eye, never derived | 1.7 · 1.9 · 2 · 2.1 · 2.2 · 2.5 · 2.7 — rendering 1.58 to 2.71 |
| Stroke colour — tools, controls, dock | `var(--color-icon)` → `#55565A` — 8 glyphs |
| Stroke colour — accent glyphs (rebound this pass) | was `#6051DC` × 7 → `var(--color-brand)` |
| Stroke colour — board and OS chrome | `var(--color-ink)` → `#0C0E17` — 3 glyphs |
| Stroke linecap | `round` on open paths · `butt` (default) on closed shapes |
| Stroke linejoin | `round` where declared · `miter` (default) elsewhere |
| Glyphs carrying a fill | 7 of 18 — `tool/pen` is fill-only, no stroke at all |
| Dash patterns — two unrelated systems | lasso `0.1 4.3` · selection + dock/select `4.6 3.9` |
| Non-square viewBox — cannot go in a square slot | `board/hinge` 26×24 · `os/wifi` 24×22 · `os/battery` 27×14 |
| Rendered size ≠ viewBox, so stroke weight drifts | center · voice · send · hinge · wifi · dismiss — 6 of 18 |

### Per-glyph normalisation table (verbatim from section 08)

| glyph | board's prescription |
|---|---|
| `tool/pen` | vb28 · r28 · fill only — no stroke to normalise |
| `tool/highlighter` | vb28 · r28 · 2.2 renders 2.20 → set 2.0 |
| `tool/eraser` | vb28 · r28 · 2.0 renders 2.00 → already correct |
| `tool/center` | vb24 · r26 · 2.0 renders 2.17 → set 1.85 |
| `control/dock` · `control/full` | vb28 · r28 · 2.1 renders 2.10 → set 2.0 |
| `ui/selection-marker` | vb24 · r24 · 2.0 renders 2.00 → already correct |
| `composer/voice` · full screen | vb24 · r26 · 1.9 renders 2.06 → set 1.85 |
| `composer/voice` · in-conversation panel | vb24 · r20 · 2.4 renders 2.00 → already correct |
| `composer/send` · docked panel | vb24 · r22 · 2.5 renders 2.29 → set 2.18 |
| `composer/send` · full screen | vb24 · r26 · 2.5 renders 2.71 → set 1.85 |
| `composer/dismiss` | vb14 · r13 · 1.9 renders 1.76 → set 2.15 |
| `chip/explain` · `example` · `exercise` · `confused` — full screen | vb24 · r24 · 1.9 renders 1.90 → set 2.0 |
| `chip/explain` · `example` · `exercise` · `confused` — docked panel | vb24 · r22 · 1.9 renders 1.74 → set 2.18 |

**Status:** this prescription has already been applied in the product artboards via inline style overrides — with one variation. `composer/dismiss` took the *re-fit* route instead (rendered at 14 rather than 13, stroke a plain `2.0`) rather than the tabled `2.15`.

---

## The three documented exceptions

The board's heading is **"THREE DOCUMENTED EXCEPTIONS — VERIFIED AT 2×, NOT ASSUMED"**. (Note: the brief for this extraction described *two* exceptions; the board documents three. The third is the OS-chrome exclusion.)

### 1. `tool/lasso` keeps 2.7

> `tool/lasso` keeps 2.7. Rendered weight is the wrong metric for a dotted mark. The dash is 0.1 on a 4.3 gap, so 98% of the circumference is empty and the perceived weight comes from dot diameter, not line weight — a round cap makes each dot roughly one stroke-width across. Dropping to 2.0 shrinks every dot by 26% against an unchanged gap, and side by side the ring visibly dissolves: it reads lighter than the solid 2.0 glyphs it was supposed to match. Matching ink, not attributes, means staying at 2.7.

**Confirmed in the markup:** the lasso circle carries `strokeWidth="2.7"` with no inline override, on both the icon board and in the live tool rail.

### 2. `board/hinge` keeps 1.9

> `board/hinge` keeps 1.9. The rule would push it to 2.4, a 26% jump, because it renders at 22×20 on a 26×24 viewBox. Tested side by side, the heavier frame closes in on the six r=1 interior dots and the mark reads as a blob at true size. It is also the one glyph that never appears beside another — it sits alone on the board peek edge — so matching the rail's weight buys nothing while interior clarity costs real legibility.

**Confirmed in the markup:** the hinge rect carries `strokeWidth="1.9"` with no inline override, both on the icon board and on the board-peek edge in "07 — Tutor · full screen". The arithmetic checks out: `2.0 ÷ (20/24) = 2.4`.

### 3. `os/wifi` and `os/battery` are excluded, not exempted

> `os/wifi` and `os/battery` are excluded, not exempted. The rule governs product glyphs; these are stand-ins for iPadOS chrome that ship as system assets. Forcing battery from 1.7 to 2.0 also fails on its own terms — its stroke sits on a 12.3pt-tall rect, so 2.0 is proportionally far heavier there than on a 21pt shape, and the gap between the outer stroke and the inner fill closes up.

---

## The recommendation that was documented but NOT applied

Transcribed verbatim from the section-08 warning block. **The code port may want to adopt this instead of the per-size table above.**

> Read this before applying the table: deriving the attribute per render size does not converge. Three glyphs are one asset drawn at two or three sizes, and no single strokeWidth can render 2.0 at more than one of them — send would need 2.18 at 22pt and 1.85 at 26pt. Per-size attributes are how the set drifted in the first place. The durable fix is to normalise the render size — **draw every product glyph on a 24 viewBox and render it at 24, so the scale is always 1.0 and the stroke is always exactly 2.0, one number with nothing to re-derive.** The table below is the tactical path if current render sizes must stay.

Why it was not applied — the board's own reasoning, from the geometry rules:

> viewBox 28 → 24 is NOT a pure re-fit — it rescales every path coordinate, so it is a redraw, not a container change → **24 and 28 both kept — normalise render size instead**

And the one place the free re-fit *was* taken:

> `composer/dismiss` is the one free re-fit — rendering it at 14 instead of 13 makes scale exactly 1.0 → **render 13 → 14, then stroke is a plain 2.0 instead of 2.15**

A SwiftUI port is not bound by the "redraw is expensive" constraint that a design file has — re-authoring the six 28-viewBox glyphs and the one 14-viewBox glyph onto a 24 grid is a mechanical coordinate scale (`×24/28` and `×24/14`) and would collapse the entire weight problem to a single constant.

---

## The two named dash textures

| name | dasharray | dashoffset | linecap | used by |
|---|---|---|---|---|
| `dash/dotted` | `0.1 4.3` | *(none declared)* | `round` | `tool/lasso` — the lasso tool glyph in the rail. Only user. |
| `dash/marching` | `4.6 3.9` | *(none declared)* | `butt` (default, not declared) | `ui/selection-marker` — the composer's attached-selection indicator (brand), and the same asset as the collapsed dock's select control (icon grey). |

The board's rationale for keeping both rather than unifying:

> Two dash textures KEPT and named — a tool and a state are different marks, and 4.6/3.9 on a r9.7 circle would read as four arcs, not dots → **`dash/dotted` 0.1 4.3 round · `dash/marching` 4.6 3.9 butt**

No `stroke-dashoffset` is declared anywhere in the set.

---

## Colour tokens referenced by the set

| token | value | role in the icon set |
|---|---|---|
| `--color-icon` | `#55565A` | Default icon stroke — tool rail glyphs and panel controls. 8 glyphs. |
| `--color-brand` | `#6051DC` | Accent glyphs — pen (selected state), selection-marker (live), dismiss, all four chips. 7 glyphs. |
| `--color-ink` | `#0C0E17` | board/hinge and both OS chrome glyphs. 3 glyphs. |
| `--color-pen-violet` | `#6051DC` | **Not used by any icon.** Shares its hex with `--color-brand` by coincidence — the board explicitly warns not to alias them. |

Board note on why `tool/pen` binds brand and not pen-violet:

> `tool/pen` violet means "tool is active", not "current ink" — no swatch shows a selected state, and the slot is `--color-brand-tint` → **`--color-brand`, not `--color-pen-violet` — identical today, diverges on retheme**

---

# tool/

Five glyphs on a 28pt frame, each centred in a 54pt slot.

> This is the least consistent group in the set: the pen is drawn entirely in fills, the highlighter mixes two fills with a stroked baseline, and the lasso runs a 2.7 stroke to keep its dotted circle from reading too light. The pen is the only glyph in the whole set that carries the brand colour as its resting state — it is shown here in its selected form, which is how it appears in the live rail.

---

## `tool/pen`

| field | value |
|---|---|
| purpose | Tool rail, slot 1 — the pen/draw tool. Shown in its **selected** state, which is its resting appearance in the live rail (the slot behind it is `--color-brand-tint`). The only glyph in the set whose resting colour is the brand violet. |
| viewBox | `0 0 28 28` |
| rendered size | **28 × 28** in product (attribute is `width="27" height="28"`, overridden by inline `style={{ width: '28px' }}`). The icon-board specimen has **no** override and renders **27 × 28**. |
| stroke width attribute | *none — fill-only glyph, no `stroke` anywhere* |
| **effective rendered stroke weight** | **N/A** — no stroke to normalise |
| stroke colour | — |
| fill | `var(--color-brand)` → `#6051DC` (markup attribute is a literal `fill="#6051DC"`; an inline `style={{ fill: 'var(--color-brand)' }}` overrides it and is what renders — same value today) |
| linecap / linejoin | n/a (fill only) |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M22.4 2.6a3 3 0 0 1 4.24 0l.76.76a3 3 0 0 1 0 4.24l-2.1 2.1-5-5 2.1-2.1Z" fill="#6051DC" style="fill: var(--color-brand)" />
<path d="M18.58 5.42l5 5L11.9 22.1l-5-5L18.58 5.42Z" fill="#6051DC" style="fill: var(--color-brand)" />
<path d="M5.86 18.14l5 5-6.53 1.72a.72.72 0 0 1-.88-.88l1.71-6.54Z" fill="#6051DC" style="fill: var(--color-brand)" />
```

> ⚠️ **Width discrepancy.** The board records this as resolved — *"Resolved — pen was 1pt narrower than its slot, now matches its four rail siblings: width 27 → 28 on a 28 viewBox"* — but the fix was applied as an **inline style override in the product artboards only**. The `width="27"` attribute is still there, and the icon-board specimen (and its own caption, `27×28 · viewBox 28 · fill`) still shows the un-fixed value. **The port should author this as a plain 28×28.**

---

## `tool/highlighter`

| field | value |
|---|---|
| purpose | Tool rail, slot 2 — the highlighter tool. |
| viewBox | `0 0 28 28` |
| rendered size | 28 × 28 |
| stroke width attribute | `2.2` (baseline path only; the two body shapes are fills) |
| **effective rendered stroke weight** | specimen: **2.2 × (28 ÷ 28) = 2.20** · product (inline `strokeWidth: '2'`): **2.00** |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | `var(--color-icon)` on the two body paths; baseline path is `fill="none"` |
| linecap / linejoin | baseline: `stroke-linecap="round"`; no linejoin declared anywhere (default `miter`) |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M18.1 3.9a2.7 2.7 0 0 1 3.82 0l2.18 2.18a2.7 2.7 0 0 1 0 3.82l-9.1 9.1-6-6 9.1-9.1Z" fill="var(--color-icon)" />
<path d="M8.5 13.6 14.5 19.6 12.3 21.8H6a1.1 1.1 0 0 1-1.1-1.1v-4.4L8.5 13.6Z" fill="var(--color-icon)" />
<path d="M4.6 25.4h18.8" fill="none" stroke="var(--color-icon)" stroke-width="2.2" stroke-linecap="round" />
```

---

## `tool/eraser`

| field | value |
|---|---|
| purpose | Tool rail, slot 3 — the eraser tool. |
| viewBox | `0 0 28 28` |
| rendered size | 28 × 28 |
| stroke width attribute | `2` (both paths) |
| **effective rendered stroke weight** | **2 × (28 ÷ 28) = 2.00** — already on target, no override anywhere |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | `none` on both paths |
| linecap / linejoin | body: none declared (default `butt` / `miter`) · baseline: `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M12.6 4.1a2.1 2.1 0 0 1 2.97 0l8.33 8.33a2.1 2.1 0 0 1 0 2.97l-5.36 5.36a2.1 2.1 0 0 1-2.97 0L7.24 12.43a2.1 2.1 0 0 1 0-2.97L12.6 4.1Z" fill="none" stroke="var(--color-icon)" stroke-width="2" />
<path d="M5.4 21.9h18.4" fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round" />
```

---

## `tool/lasso`  🔸 *exception 1 of 3*

| field | value |
|---|---|
| purpose | Tool rail, slot 4 — the lasso selection tool. |
| viewBox | `0 0 28 28` |
| rendered size | 28 × 28 |
| stroke width attribute | `2.7` |
| **effective rendered stroke weight** | **2.7 × (28 ÷ 28) = 2.70** — *deliberately left at 2.70, the set maximum for a product glyph.* See exception 1 above. |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | `none` |
| linecap / linejoin | `stroke-linecap="round"` (load-bearing — the round cap is what turns a 0.1 dash into a visible dot roughly one stroke-width across) |
| dash pattern | `stroke-dasharray="0.1 4.3"` · no `stroke-dashoffset` → texture **`dash/dotted`** |

**Elements, in document order:**

```svg
<circle cx="14" cy="14" r="9.7" fill="none" stroke="var(--color-icon)" stroke-width="2.7" stroke-linecap="round" stroke-dasharray="0.1 4.3" />
```

---

## `tool/center`

| field | value |
|---|---|
| purpose | Tool rail, bottom slot (below the divider and the pen-colour swatches / stroke-thickness indicator) — the **center-on-work** control that recenters the infinite board viewport. |
| viewBox | `0 0 24 24` |
| rendered size | 26 × 26 |
| stroke width attribute | `2` (both stroked elements) |
| **effective rendered stroke weight** | specimen: **2 × (26 ÷ 24) = 2.17** · product (inline `strokeWidth: '1.85'`): **1.85 × 1.0833 = 2.00** |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | outer ring `none`; centre dot filled `var(--color-icon)` |
| linecap / linejoin | ring: none declared · tick path: `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<circle cx="12" cy="12" r="7" fill="none" stroke="var(--color-icon)" stroke-width="2" />
<path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3" fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round" />
<circle cx="12" cy="12" r="1.9" fill="var(--color-icon)" />
```

---

# control/

> The most disciplined pair in the set, and the one to copy when drawing anything new. Both are the identical 21×17 rounded rect at radius 5 on a 28pt frame; the docked state adds a single vertical divider at x=11.2, which is exactly where the panel's own edge falls. **Draw them as one shape with a conditional second path rather than two separate assets — the rect must not shift by even a subpixel when the state toggles.**
>
> The divider is left of centre. It was at x=16.8 until the shell mirrored the panel to the left of the screen; the glyph is a map of the layout, so it mirrored with it.

---

## `control/dock`

| field | value |
|---|---|
| purpose | Tutor panel header, left control — dock the tutor panel to the side. |
| viewBox | `0 0 28 28` |
| rendered size | 28 × 28 |
| stroke width attribute | `2.1` (both elements) |
| **effective rendered stroke weight** | specimen: **2.1 × (28 ÷ 28) = 2.10** · product (inline `strokeWidth: '2'`): **2.00** |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | `none` on both |
| linecap / linejoin | none declared (default `butt` / `miter`) |
| dash pattern | none |

**Elements, in document order:**

```svg
<rect x="3.5" y="5.5" width="21" height="17" rx="5" fill="none" stroke="var(--color-icon)" stroke-width="2.1" />
<path d="M11.2 5.5V22.5" fill="none" stroke="var(--color-icon)" stroke-width="2.1" />
```

---

## `control/full`

| field | value |
|---|---|
| purpose | Tutor panel header, right control — expand the tutor panel to full screen. |
| viewBox | `0 0 28 28` |
| rendered size | 28 × 28 |
| stroke width attribute | `2.1` |
| **effective rendered stroke weight** | specimen: **2.1 × (28 ÷ 28) = 2.10** · product (inline `strokeWidth: '2'`): **2.00** |
| stroke colour | `var(--color-icon)` → `#55565A` |
| fill | `none` |
| linecap / linejoin | none declared (default `butt` / `miter`) |
| dash pattern | none |

**Elements, in document order:**

```svg
<rect x="3.5" y="5.5" width="21" height="17" rx="5" fill="none" stroke="var(--color-icon)" stroke-width="2.1" />
```

Byte-identical to `control/dock` minus the divider path.

---

# ui/

## `ui/selection-marker`

One asset, two colour states. Documented once here rather than twice.

> The dotted square that was documented separately as `dock/select` is byte-identical to the selection marker in the composer — same 24 viewBox, same stroke 2, same 4.6/3.9 dash. It is one asset in two colour states: `--color-brand` when a selection is live, `--color-icon` when the control is idle.

| field | value |
|---|---|
| purpose | (a) Composer input, leading icon — indicates a board selection is attached to the next message. Rendered in `--color-brand`. (b) The collapsed dock's **select** control. Rendered in `--color-icon`. |
| viewBox | `0 0 24 24` |
| rendered size | 24 × 24 (both states) |
| stroke width attribute | `2` |
| **effective rendered stroke weight** | **2 × (24 ÷ 24) = 2.00** — already on target, no override anywhere. One of only two glyphs that needed nothing. |
| stroke colour | **live/composer state:** `var(--color-brand)` → `#6051DC` · **idle/dock state:** `var(--color-icon)` → `#55565A`. In *both* cases the markup attribute is the literal `stroke="#6051DC"` and an inline style decides the real colour. |
| fill | `none` |
| linecap / linejoin | none declared → `butt` / `miter`. The butt cap is what makes `dash/marching` read as clean marching-ants segments. |
| dash pattern | `stroke-dasharray="4.6 3.9"` · no `stroke-dashoffset` → texture **`dash/marching`** |

**Elements, in document order — composer (brand) state:**

```svg
<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4" fill="none" stroke="#6051DC" stroke-width="2" stroke-dasharray="4.6 3.9" style="stroke: var(--color-brand)" />
```

**Elements, in document order — dock/idle (grey) state** (found in "08 — Tutor · in conversation"):

```svg
<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4" fill="none" stroke="#6051DC" stroke-width="2" stroke-dasharray="4.6 3.9" style="stroke: var(--color-icon)" />
```

> ⚠️ **This is the set's one genuine markup-vs-render colour disagreement.** The markup says `#6051DC` (violet); the inline style says `var(--color-icon)` and the mark **renders grey `#55565A`**. Every other override in the file resolves to the same value it replaced. The board flags exactly this instance:
>
> *"Identical-looking copies are NOT interchangeable — an inline style silently overrides the markup attribute."*
>
> **Port this as a single `SelectionMarker(tint:)` view with the colour injected**, never by copy-pasting the SVG.

---

# composer/

> Four assets. Three different stroke widths — 2, 1.9 and 2.5 — because each sits on a different ground, and none of them renders at the weight its attribute suggests. Send is the only glyph drawn in white, since it always rides a filled brand button; it is one asset at two sizes, 22 docked and 26 full screen. […] Dismiss is the smallest glyph in the set and the only one on a 14 viewBox.

---

## `composer/voice`  📐 *rendered at two sizes*

| field | value |
|---|---|
| purpose | Composer trailing control — voice / dictation input. |
| viewBox | `0 0 24 24` |
| rendered size | **20 × 20** in the docked in-conversation panel · **26 × 26** on the full-screen composer |
| stroke width attribute | `1.9` (icon board specimen and full-screen instance) · `2.4` (docked-panel instance — a genuinely different attribute, not an override) |
| **effective rendered stroke weight** | specimen @ 26: **1.9 × (26 ÷ 24) = 2.06** · product full screen @ 26 (inline `strokeWidth: '1.85'`): **1.85 × 1.0833 = 2.00** · product docked @ 20 (attribute `2.4`, no override): **2.4 × (20 ÷ 24) = 2.00** |
| stroke colour | `var(--color-icon)` → `#55565A` (bound directly in the markup — no literal hex, no override) |
| fill | `none` on all three paths |
| linecap / linejoin | capsule: `stroke-linejoin="round"` · cradle: `stroke-linecap="round"` · stem: `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M12 3.4a2.8 2.8 0 0 1 2.8 2.8v6a2.8 2.8 0 0 1-5.6 0v-6A2.8 2.8 0 0 1 12 3.4Z" fill="none" stroke="var(--color-icon)" stroke-width="1.9" stroke-linejoin="round" />
<path d="M5.6 11.4v.9a6.4 6.4 0 0 0 12.8 0v-.9" fill="none" stroke="var(--color-icon)" stroke-width="1.9" stroke-linecap="round" />
<path d="M12 18.7v2.6" fill="none" stroke="var(--color-icon)" stroke-width="1.9" stroke-linecap="round" />
```

### Size table

| context | rendered | strokeWidth attribute | inline override | effective |
|---|---|---|---|---|
| icon board specimen | 26 × 26 | `1.9` | — | 2.06 |
| Tutor · full screen | 26 × 26 | `1.9` | `1.85` | **2.00** |
| Tutor · in-conversation (docked) | 20 × 20 | `2.4` | — | **2.00** |

---

## `composer/send`  📐 *rendered at two sizes*

| field | value |
|---|---|
| purpose | Composer send button. Always rides a filled `--color-brand` circular button, which is why it is the only glyph drawn in white. |
| viewBox | `0 0 24 24` |
| rendered size | **22 × 22** in the docked panel (42pt button) · **26 × 26** on the full-screen composer (56pt button) |
| stroke width attribute | `2.5` (both instances — one asset, one attribute) |
| **effective rendered stroke weight** | specimen @ 26: **2.5 × (26 ÷ 24) = 2.71** ← *the set maximum before normalisation* · product full screen @ 26 (inline `strokeWidth: '1.85'`): **2.00** · product docked @ 22 (inline `strokeWidth: '2.18'`): **2.18 × (22 ÷ 24) = 2.00** |
| stroke colour | `#FFFFFF` — a literal hex, **not** token-bound. The only glyph in the set that does not bind a colour token. |
| fill | `none` on both paths |
| linecap / linejoin | stem: `stroke-linecap="round"` · chevron: `stroke-linecap="round"` + `stroke-linejoin="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M12 19.4V5.4" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" />
<path d="M5.8 11.6 12 5.4l6.2 6.2" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
```

### Size table

| context | rendered | strokeWidth attribute | inline override | effective |
|---|---|---|---|---|
| icon board specimen | 26 × 26 | `2.5` | — | 2.71 |
| Tutor · full screen | 26 × 26 | `2.5` | `1.85` | **2.00** |
| Tutor · docked panel | 22 × 22 | `2.5` | `2.18` | **2.00** |

This glyph is the board's own proof that per-size attributes don't converge: *"send would need 2.18 at 22pt and 1.85 at 26pt."*

---

## `composer/dismiss`  📐 *rendered at two sizes*

| field | value |
|---|---|
| purpose | Dismiss the attached-selection card that sits above the composer ("Selection attached ×"). The smallest glyph in the set and the only one on a 14 viewBox. |
| viewBox | `0 0 14 14` |
| rendered size | **14 × 14** in product (attributes are `width="13" height="13"`, overridden by inline `style={{ width: '14px', height: '14px' }}`). The icon-board specimen has **no** override and renders **13 × 13**. |
| stroke width attribute | `1.9` |
| **effective rendered stroke weight** | specimen @ 13: **1.9 × (13 ÷ 14) = 1.76** ← *the set minimum for a square glyph* · product @ 14 (inline `strokeWidth: '2'`): **2 × (14 ÷ 14) = 2.00** |
| stroke colour | `var(--color-brand)` → `#6051DC` (markup attribute is the literal `stroke="#6051DC"`; inline style overrides it to the token — same value today) |
| fill | `none` |
| linecap / linejoin | `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linecap="round" style="stroke: var(--color-brand)" />
```

> **This is the "one free re-fit."** The section-08 table prescribes `2.15` at a 13pt render; the product instead took the geometry-rules advice — render at **14** so scale is exactly 1.0 and the stroke is a plain **2.0**. The port should follow the product, not the table.

---

# chip/

> Uniform on paper, not on screen. All four are 24×24 on a 24 viewBox at stroke 1.9, and within a single screen they are perfectly consistent — but they render at 24 full screen and 22 in the docked panel, so the same attribute produces 1.90 rendered in one place and 1.74 in the other. The one deliberate exception inside the group is `confused`, whose question-mark dot is a filled circle rather than stroked — a rounded 1.9 cap would have read as a dash at this size. All four hardcoded `#6051DC` and now bind `var(--color-brand)`.

**All four share these values** and are 📐 *rendered at two sizes*:

| field | value |
|---|---|
| viewBox | `0 0 24 24` |
| rendered size | **24 × 24** on the full-screen suggestion grid · **22 × 22** in the docked in-conversation panel |
| stroke width attribute | `1.9` |
| **effective rendered stroke weight** | specimen @ 24: **1.9 × (24 ÷ 24) = 1.90** · product full screen @ 24 (inline `strokeWidth: '2'`): **2.00** · product docked @ 22 (inline `strokeWidth: '2.18'`): **2.18 × (22 ÷ 24) = 2.00** |
| stroke colour | `var(--color-brand)` → `#6051DC` (markup carries the literal hex; inline style binds the token — same value today) |
| dash pattern | none |

### Size table (identical for all four)

| context | rendered | strokeWidth attribute | inline override | effective |
|---|---|---|---|---|
| icon board specimen | 24 × 24 | `1.9` | — | 1.90 |
| Tutor · full screen | 24 × 24 | `1.9` | `2` | **2.00** |
| Tutor · docked panel | 22 × 22 | `1.9` | `2.18` | **2.00** |

---

## `chip/explain`

**Purpose:** suggestion chip — *"Explain this concept"*. A lightbulb.

| field | value |
|---|---|
| fill | `none` on both paths |
| linecap / linejoin | bulb: `stroke-linejoin="round"` · filament lines: `stroke-linecap="round"` |

**Elements, in document order:**

```svg
<path d="M12 3.2a6.4 6.4 0 0 0-3.8 11.55c.6.44.95 1.1.95 1.8v.25h5.7v-.25c0-.7.35-1.36.95-1.8A6.4 6.4 0 0 0 12 3.2Z" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linejoin="round" style="stroke: var(--color-brand)" />
<path d="M9.5 19.6h5M10.4 21.8h3.2" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linecap="round" style="stroke: var(--color-brand)" />
```

---

## `chip/example`

**Purpose:** suggestion chip — *"Give me an example"*. Two four-point sparkles.

| field | value |
|---|---|
| fill | `none` on both paths |
| linecap / linejoin | both paths: `stroke-linejoin="round"`; no linecap declared (closed shapes) |

**Elements, in document order:**

```svg
<path d="M10.2 3.4 12 8.2l4.8 1.8-4.8 1.8-1.8 4.8-1.8-4.8L3.6 10l4.8-1.8 1.8-4.8Z" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linejoin="round" style="stroke: var(--color-brand)" />
<path d="M17.6 14.2l.95 2.55 2.55.95-2.55.95-.95 2.55-.95-2.55-2.55-.95 2.55-.95.95-2.55Z" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linejoin="round" style="stroke: var(--color-brand)" />
```

---

## `chip/exercise`

**Purpose:** suggestion chip — *"Create an exercise"*. A pencil over an open square.

| field | value |
|---|---|
| fill | `none` on both paths |
| linecap / linejoin | frame: `stroke-linecap="round"` · pencil: `stroke-linejoin="round"` |

**Elements, in document order:**

```svg
<path d="M11.2 4.8H6.4A2.4 2.4 0 0 0 4 7.2v10.4a2.4 2.4 0 0 0 2.4 2.4h10.4a2.4 2.4 0 0 0 2.4-2.4v-4.6" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linecap="round" style="stroke: var(--color-brand)" />
<path d="M17.5 3.9a2.15 2.15 0 0 1 3.04 3.04L13.1 14.4l-4.05.95 1-4.05 7.45-7.4Z" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linejoin="round" style="stroke: var(--color-brand)" />
```

---

## `chip/confused`

**Purpose:** suggestion chip — *"I don't understand this"*. A question mark in a circle.

| field | value |
|---|---|
| fill | `none` on the ring and the hook; the question-mark **dot is a filled circle**, `fill: var(--color-brand)` (markup literal `#6051DC`) |
| linecap / linejoin | ring: none declared · hook: `stroke-linecap="round"` |

> The filled dot is the group's one deliberate internal exception: *"a rounded 1.9 cap would have read as a dash at this size."*

**Elements, in document order:**

```svg
<circle cx="12" cy="12" r="8.6" fill="none" stroke="#6051DC" stroke-width="1.9" style="stroke: var(--color-brand)" />
<path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.36c-.72.25-1.2.92-1.2 1.68v.36" fill="none" stroke="#6051DC" stroke-width="1.9" stroke-linecap="round" style="stroke: var(--color-brand)" />
<circle cx="11.6" cy="17.1" r="1.15" fill="#6051DC" style="fill: var(--color-brand)" />
```

---

# board/

## `board/hinge`  🔸 *exception 2 of 3*

> `board/hinge` is the odd one out in the whole set: the only glyph on a non-square 26×24 viewBox, with six filled dots at r=1 rather than stroked, which is why it holds its weight when the board peek shrinks it to 22×20.

| field | value |
|---|---|
| purpose | The grab/hinge affordance on the **board peek edge** — the sliver of whiteboard visible when the tutor is full screen. The one glyph that never appears beside another. |
| viewBox | `0 0 26 24` — **non-square** |
| rendered size | 22 × 20 |
| stroke width attribute | `1.9` |
| **effective rendered stroke weight** | uniform scale under `preserveAspectRatio` meet = `min(22/26, 20/24) = min(0.846, 0.833) = 0.833` → **1.9 × 0.833 = 1.58** ← *the set minimum, and the lower bound of the board's stated "1.58 to 2.71" span*. (Using the width ratio alone would give 1.61.) *Deliberately left at 1.9* — see exception 2 above. Normalising would require `2.0 ÷ 0.833 = 2.4`, a 26% jump. |
| stroke colour | `var(--color-ink)` → `#0C0E17` (token-bound in the markup — no literal hex, no override) |
| fill | frame rect `none`; six interior dots filled `var(--color-ink)` |
| linecap / linejoin | none declared (default `butt` / `miter`) |
| dash pattern | none |

**Elements, in document order:**

```svg
<rect x="2.1" y="2.6" width="21.8" height="18.8" rx="3.6" fill="none" stroke="var(--color-ink)" stroke-width="1.9" />
<circle cx="8" cy="9" r="1" fill="var(--color-ink)" />
<circle cx="13" cy="9" r="1" fill="var(--color-ink)" />
<circle cx="18" cy="9" r="1" fill="var(--color-ink)" />
<circle cx="8" cy="15" r="1" fill="var(--color-ink)" />
<circle cx="13" cy="15" r="1" fill="var(--color-ink)" />
<circle cx="18" cy="15" r="1" fill="var(--color-ink)" />
```

> **Do not stretch this into a square slot.** Board rule: *"Non-square glyphs stay non-square — a non-square mark centred in a square slot is correct, a stretched one is not."*

---

# os/ — ⛔ EXCLUDED FROM THE PRODUCT ICON SET

Section heading on the board reads **"06 · OS CHROME — DO NOT SHIP"**.

> These two are not product icons. They are stand-ins for the iPadOS status bar, drawn only so the screens read as a real device, and iPadOS supplies the real ones at runtime. **Do not port them, do not add them to an asset catalogue, and do not treat their geometry as a house rule** — battery in particular runs stroke 1.7 and a non-square 27×14 viewBox, which no product glyph should copy.

They are recorded here for completeness only. They are **excluded, not exempted** — the 2.0 rule does not reach them because it governs product glyphs.

---

## `os/wifi` ⛔

| field | value |
|---|---|
| purpose | iPadOS status bar stand-in. Replace with the system asset. |
| viewBox | `0 0 24 22` — **non-square** |
| rendered size | 22 × 20 |
| stroke width attribute | `1.9` |
| **effective rendered stroke weight** | uniform scale = `min(22/24, 20/22) = min(0.917, 0.909) = 0.909` → **1.9 × 0.909 = 1.73** |
| stroke colour | `var(--color-ink)` → `#0C0E17` |
| fill | arcs `none`; base dot filled `var(--color-ink)` |
| linecap / linejoin | all three arcs: `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<path d="M2.4 8.6a13 13 0 0 1 19.2 0" fill="none" stroke="var(--color-ink)" stroke-width="1.9" stroke-linecap="round" />
<path d="M5.7 12.1a8.5 8.5 0 0 1 12.6 0" fill="none" stroke="var(--color-ink)" stroke-width="1.9" stroke-linecap="round" />
<path d="M8.9 15.5a4.2 4.2 0 0 1 6.2 0" fill="none" stroke="var(--color-ink)" stroke-width="1.9" stroke-linecap="round" />
<circle cx="12" cy="18.8" r="1.5" fill="var(--color-ink)" />
```

---

## `os/battery` ⛔

| field | value |
|---|---|
| purpose | iPadOS status bar stand-in. Replace with the system asset. |
| viewBox | `0 0 27 14` — **non-square** |
| rendered size | 27 × 14 |
| stroke width attribute | `1.7` (shell rect) and `2` (terminal nub) — two different weights in one glyph |
| **effective rendered stroke weight** | scale = `min(27/27, 14/14) = 1.0` → shell **1.70**, nub **2.00** |
| stroke colour | `var(--color-ink)` → `#0C0E17` |
| fill | shell rect `none`; charge-level rect filled `var(--color-ink)`; nub `none` |
| linecap / linejoin | shell: none declared · nub: `stroke-linecap="round"` |
| dash pattern | none |

**Elements, in document order:**

```svg
<rect x="0.85" y="0.85" width="21.3" height="12.3" rx="3.4" fill="none" stroke="var(--color-ink)" stroke-width="1.7" />
<rect x="2.8" y="2.8" width="17.4" height="8.4" rx="1.9" fill="var(--color-ink)" />
<path d="M24.6 5.2v3.6" fill="none" stroke="var(--color-ink)" stroke-width="2" stroke-linecap="round" />
```

---

# Summary tables

## Every glyph, effective weight at every render size

| glyph | family | viewBox | rendered | sw attr | inline override | **effective** |
|---|---|---|---|---|---|---|
| pen | tool | 28×28 | 28×28 (attr 27, overridden) | — | — | fill only |
| highlighter | tool | 28×28 | 28×28 | 2.2 | 2 | **2.00** |
| eraser | tool | 28×28 | 28×28 | 2 | — | **2.00** |
| lasso | tool | 28×28 | 28×28 | 2.7 | — | **2.70** 🔸 |
| center | tool | 24×24 | 26×26 | 2 | 1.85 | **2.00** |
| dock | control | 28×28 | 28×28 | 2.1 | 2 | **2.00** |
| full | control | 28×28 | 28×28 | 2.1 | 2 | **2.00** |
| selection-marker | ui | 24×24 | 24×24 | 2 | — | **2.00** |
| voice · docked | composer | 24×24 | 20×20 | 2.4 | — | **2.00** |
| voice · full | composer | 24×24 | 26×26 | 1.9 | 1.85 | **2.00** |
| send · docked | composer | 24×24 | 22×22 | 2.5 | 2.18 | **2.00** |
| send · full | composer | 24×24 | 26×26 | 2.5 | 1.85 | **2.00** |
| dismiss | composer | 14×14 | 14×14 (attr 13, overridden) | 1.9 | 2 | **2.00** |
| explain · docked | chip | 24×24 | 22×22 | 1.9 | 2.18 | **2.00** |
| explain · full | chip | 24×24 | 24×24 | 1.9 | 2 | **2.00** |
| example · docked / full | chip | 24×24 | 22 / 24 | 1.9 | 2.18 / 2 | **2.00** |
| exercise · docked / full | chip | 24×24 | 22 / 24 | 1.9 | 2.18 / 2 | **2.00** |
| confused · docked / full | chip | 24×24 | 22 / 24 | 1.9 | 2.18 / 2 | **2.00** |
| hinge | board | 26×24 | 22×20 | 1.9 | — | **1.58** 🔸 |
| wifi ⛔ | os | 24×22 | 22×20 | 1.9 | — | 1.73 |
| battery ⛔ | os | 27×14 | 27×14 | 1.7 / 2 | — | 1.70 / 2.00 |

## Glyphs rendered at more than one size

| glyph | sizes | strokeWidth used at each |
|---|---|---|
| `composer/send` | 22, 26 | attribute `2.5` at both; effective **2.18** @ 22, **1.85** @ 26 |
| `composer/voice` | 20, 26 | attribute `2.4` @ 20 (no override); attribute `1.9` → effective **1.85** @ 26 |
| `chip/explain`, `chip/example`, `chip/exercise`, `chip/confused` | 22, 24 | attribute `1.9` at both; effective **2.18** @ 22, **2.0** @ 24 |
| `composer/dismiss` | 13 (board specimen), 14 (product) | `1.9` @ 13 specimen; effective **2.0** @ 14 in product |
| `tool/pen` | 27 (board specimen), 28 (product) | fill only, no stroke |
| `ui/selection-marker` | 24 only — *two colour states, not two sizes* | `2` |

## Markup colour ≠ rendered colour

| glyph / instance | markup attribute | inline style (wins) | renders | same value? |
|---|---|---|---|---|
| `ui/selection-marker` — dock/idle state | `stroke="#6051DC"` | `var(--color-icon)` | **`#55565A` grey** | ❌ **NO — genuine disagreement** |
| `ui/selection-marker` — composer/live state | `stroke="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `tool/pen` (3 paths) | `fill="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `composer/dismiss` | `stroke="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `chip/explain` (2 paths) | `stroke="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `chip/example` (2 paths) | `stroke="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `chip/exercise` (2 paths) | `stroke="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `chip/confused` (3 elements) | `stroke`/`fill="#6051DC"` | `var(--color-brand)` | `#6051DC` | ✅ yes |
| `composer/send` (2 paths) | `stroke="#FFFFFF"` | *none* | `#FFFFFF` | ✅ (untokenised literal) |

The board's own audit warning:

> Auditing colour — style search cannot enumerate these, because SVG presentation attributes are not computed CSS → **walk the tree and read JSX per path — never trust `find_nodes` here**

---

# Port checklist for SwiftUI

1. **Adopt the un-applied recommendation.** Re-author all 16 product glyphs on a `0 0 24 24` viewBox rendered at 24. The six 28-viewBox glyphs scale by `×24/28 = 0.857`; `composer/dismiss` scales by `×24/14 = 1.714`. Then `lineWidth` is a single constant `2.0` everywhere — no per-size derivation, nothing to drift.
2. **Keep the two exceptions after rescaling.** `tool/lasso` must keep its *perceived* ink — recompute its dash so dot diameter is preserved, don't just copy `0.1 4.3`. `board/hinge` must keep its lighter frame relative to its interior dots.
3. **Keep the three non-square glyphs non-square.** Centre them in a square slot; never stretch.
4. **`ui/selection-marker` is one view with an injected tint**, not two assets. Copy-pasting it is how the grey/violet mismatch happened in the first place.
5. **Ignore the `width`/`height` attributes on `tool/pen` and `composer/dismiss`** — they are stale (27 and 13). The rendered sizes are 28 and 14.
6. **`composer/send` is the only glyph with an untokenised colour** (`#FFFFFF`). Give it a token or an explicit "on-brand" role.
7. **Don't port `os/wifi` or `os/battery`.** Use the iPadOS status bar.

---

# Open questions / ambiguities

1. **Two exceptions or three?** The extraction brief described two deliberate exceptions (`tool/lasso` 2.7, `board/hinge` 1.9). The board documents **three**, under the heading *"THREE DOCUMENTED EXCEPTIONS"* — the third being that `os/wifi` and `os/battery` are *excluded, not exempted*. Arguably that is a scope statement rather than an exception; either reading is defensible, but the board's own count is three.

2. **`tool/pen`'s width fix is only half-applied.** The geometry rules claim it resolved: *"width 27 → 28 on a 28 viewBox."* In fact the `width="27"` attribute survives everywhere; the fix is an inline `width: 28px` present **only on the product artboards**. The icon-board specimen still renders 27 wide, and its own caption still reads `27×28`. Same pattern for `composer/dismiss` (`13` attribute, `14px` inline, board caption still `13×13`). Whoever exports from this file should treat the captions on the icon board as stale for these two.

3. **The section-08 table and the shipped product disagree on `composer/dismiss`.** The table prescribes `2.15` at a 13pt render; the product ships `2.0` at a 14pt render, following the geometry-rules "free re-fit" note instead. Both land on 2.0 effective, but the table was not updated. I have documented the product's choice as authoritative.

4. **`board/hinge`'s effective weight depends on which ratio you use.** Width ratio (22/26) gives 1.61; height ratio (20/24) gives 1.58. Under the default `preserveAspectRatio="xMidYMid meet"` the uniform scale is the smaller, so 1.58 — which matches the board's stated set minimum. Worth confirming that SwiftUI's chosen content mode reproduces `meet` and not a fill/stretch.

5. **`dash/dotted` and `dash/marching` are named on the board but are not tokens.** They exist only as literal `stroke-dasharray` values in the markup and as a line in the geometry table; `get_tokens` does not expose them. The port will need to define them itself.

6. **`composer/voice` has a genuinely different attribute at its two sizes** (`2.4` docked vs `1.9` full screen), unlike `send` and the chips which share one attribute and differ only by override. It is unclear whether that is intentional or a leftover; both currently resolve to 2.0 effective.

7. **`--color-pen-violet` and `--color-brand` are the same hex** (`#6051DC`) and the token descriptions explicitly warn not to alias them. No icon uses `--color-pen-violet` — `tool/pen`'s violet is `--color-brand` ("tool is active", not "current ink"). Preserve that distinction in the port; they are documented to diverge on retheme.

8. **The board is described as normalised, but the specimens are not.** Section 08 is written as a prescription ("→ set 2.0"), and the icon-board specimens still carry the pre-normalisation attributes. Only the product artboards carry the overrides. If someone exports icons from the icon board rather than from the screens, they will get the un-normalised set.

---

## Section 07 — Activity trail (added 2026-08-10)

Four glyphs, drawn for the activity trail's step rows. The set covered two of the seven step
types already: `tool/pen` for `update_board`, `ui/check` for `record_evidence`. These are the
other four.

| Glyph | Swift case | Step it marks |
| --- | --- | --- |
| `trail/eye` | `trailEye` | `view_board` — "Looked at the top left of the board" |
| `trail/search` | `trailSearch` | `search_memory` and `recent_sessions` — one glyph for both |
| `trail/plan` | `trailPlan` | `set_workspace` — "Set the plan: Fractions" |
| `trail/note` | `trailNote` | `remember` — "Saved a note" |

All four: **24 viewBox, effective stroke 2.0, `--color-icon`, stroke-only.** They are the first
glyphs authored on the board's own recommended 24 grid from the start rather than retrofitted
onto a 28, so the attribute at native size is a flat `2` with nothing to re-derive — which is
the argument section 08 makes and the earlier marks could not follow.

### Rendering at 16

Trail rows render these at **16**, where a 24 viewBox scales by 0.667 and the authored `2.0`
would land at 1.33. The attribute is compensated at the call site to **`3.0`** to reach the
set's effective 2.0. `tool/pen` shares those rows off a 28 viewBox and needs **`3.5`** for the
same result. Getting this wrong is visible: the first draft rendered the eye at 1.33 beside the
pen at 1.20 and they read as two different weights on adjacent rows.

`ui/chevron-down` is the precedent that settles what "correct at 16" means — it is authored on a
16 viewBox at stroke 2 and renders effective 2.0.

### Why `trail/eye` was redrawn

The first draft used control points at y 6.6 and a pupil at r2.7. Both work at 24 and both fail
at 16: with effective 2.0 the stroke closes the pupil into a blob, the same failure `tool/lasso`
carries a documented exception for. Rather than take a second exception the glyph was redrawn —
control points to 5.2 (lens 10.2 tall instead of 8.1) and pupil to r3.3 — so it survives the
rule with nothing special-cased.

### Rejected reuse

`tool/lasso` and `ui/selection-marker` both exist and both look like candidates for "the tutor
looked at the board". Neither was used. Both mean *the learner marqueed a region* — they belong
to the learner's own selection, drawn on board 14 in `--color-brand` — and reusing either would
have quietly said the wrong thing.
