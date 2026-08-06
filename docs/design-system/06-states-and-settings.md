# 06 — States & Settings

Code-ready transcription of the five boards added to **"AI Whiteboard Tutor — Design System, Components & Page"** after the original nine:

- **10 — Settings** (1376 × 1032)
- **11 — First run · no API key** (1376 × 1032)
- **12 — Session plan · panel** (1376 × 1032)
- **13 — Session plan · full screen** (1376 × 1032)
- **14 — Components · Tutor states** (1680 × fit-content → **3359**)

Every number and colour below came from `get_computed_styles` / `get_jsx` / `get_node_info`. Screenshots were used only to confirm structure. **Off-grid values are deliberate and are reported exactly as found — do not round or snap to the 4px scale.**

Read this document alongside:

- `01-foundations.md` — tokens, elevation scale, the 28 / 24 / 18 layout rule, screen anatomy.
- `02-shell-components.md` — tool rail, panel shell, panel controls, orb, board peek.
- `03-chat-components.md` — composer, messages, thread, scroll fade, suggestion chips.
- `04-icons.md` — the stroke-weight rule (target **2.0 rendered** = `strokeWidth × rendered ÷ viewBox`).
- `05-screens.md` — screens 05 / 06 / 07 / 08 region maps.

Where a board uses a component already specified in 02 / 03 / 05, this document names it and gives only position, size and per-screen overrides.

---

## Table of contents

1. [Board 10 — Settings](#board-10--settings)
2. [Board 11 — First run · no API key](#board-11--first-run--no-api-key)
3. [Board 12 — Session plan · panel](#board-12--session-plan--panel)
4. [Board 13 — Session plan · full screen](#board-13--session-plan--full-screen)
5. [Board 14 — Components · Tutor states](#board-14--components--tutor-states)
6. [New components introduced](#new-components-introduced)
7. [Four new icons](#four-new-icons)
8. [Values that are not tokens](#values-that-are-not-tokens)
9. [Open questions](#open-questions)

---

# Board 10 — Settings

## Purpose / app state

The settings surface. It is **not a modal and not a sheet** — it is the full-screen tutor layout (board 07's shell) with its reading content replaced. The board peek stays pinned to the left as the way back, and the panel-controls row is reduced to a single `btn/dock` — the only exit.

Reached from `btn/settings` in the panel controls on boards 11 / 12 / 13, and from the **auth-error recovery chip** on board 14 ("Open Settings" → *"board 10 — Settings, OpenAI API key section, field focused"*).

## Screen frame

| Property | Value |
| --- | --- |
| Size | 1376 × 1032 |
| Background | **`#FFFFFF`** — literal, *not* `var(--color-surface-screen)`. Same exception board 07 takes. |
| Layout | `overflow: clip`, absolute children |

## Region map (absolute, inside the 1376 × 1032 frame)

| Region | x | y | w | h | Notes |
| --- | --- | --- | --- | --- | --- |
| Status bar | 0 | 16 | 1376 | 24 | **Reused from 05** verbatim (`9:41 AM` / `Tue May 21` / wifi / `100%` / battery). Left group at x 30, right group at x 1251, gap 12 / `--spacing-2`. |
| Board peek | 0 | 68 | 68 | 936 | **Reused from 07 / `02 §10`** verbatim, including the faked blurred-duplicate edge shadow (`left 3, top 2`, `blur(5px)`, `opacity 0.11`, fill `#141432`) and `board/hinge` at local (23, 22), 22 × 20. Dot-grid path fill `#F1F1F1`. |
| Panel controls | 352 | 68 | 740 | 32 | **Reduced variant** — see below. |
| Title `Settings` | 352 | 124 | 740 | 48 | `--text-display` 40 / `--leading-display` 48 · 600 · `--tracking-tight` · `--color-ink` |
| Section — Tutor model | 352 | 220 | 740 | 124 | |
| Section — Reasoning effort | 352 | 392 | 740 | 230 | |
| Section — OpenAI API key | 352 | 670 | 740 | 136 | |
| Section — Irreversible | 352 | 850 | 740 | 112 | Content bottom = **962**. The safe band ends at 1004, so there is **42 pt of unused slack** — this screen is top-aligned, not stretched. |

Column: **x 352 → 1092, width 740** = `var(--container-column)`, i.e. board 07's centring rule `68 + (1376 − 68 − 740) ÷ 2 = 352`. No board 07 element other than the peek and status bar survives.

**Vertical rhythm between blocks:** controls → title **24** · title → §1 **48** · §1 → §2 **48** · §2 → §3 **48** · §3 → §4 **44**. The last gap is 44, not 48 — see [Open questions](#open-questions).

## Panel controls — reduced variant (new configuration, not a new component)

| Property | Value |
| --- | --- |
| Frame | 740 × 32 at (352, 68), `display: flex`, `align-items: center`, **`justify-content: flex-start`**, `gap: 14px` |
| Children | **`btn/dock` only** — 32 × 32, no fill, no radius, no shadow. Glyph 28 × 28, viewBox `0 0 28 28`, `stroke var(--color-icon)`, markup `stroke-width 2.1` with inline override **`2`** (→ 2.00 rendered). |
| Absent | `btn/full-screen`, `btn/settings` |

`btn/dock` is **reused unchanged from `02 §6`**; only the row's membership changes. The `gap: 14` survives even though there is one child.

## Section — Tutor model (740 × 124 at 352, 220)

```
Section (flex column, width 740)
├─ Heading  "Tutor model"           740 × 18
└─ Options  740 × 90                margin-top 16 (--spacing-4)
   flex row, gap 16 (--spacing-4)
   ├─ select/option · default   236 × 90   "Sol"   / "Focused route"
   ├─ select/option · default   236 × 90   "Terra" / "Balanced route"
   └─ select/option · selected  236 × 90   "Luna"  / "Default route"
```

Arithmetic: `18 + 16 + 90 = 124`. Row width `236 × 3 + 16 × 2 = 740` exactly.

**Heading type (used by all four sections):** `--text-label` 15 / `--leading-label` 18 · **600** · `--color-ink`.

## Section — Reasoning effort (740 × 230 at 352, 392)

```
Section (flex column, width 740)
├─ Heading  "Reasoning effort"      740 × 18
└─ Options  740 × 196               margin-top 16
   flex row, flex-wrap: wrap, gap 16 (both axes)
   row 1: None / Low / Medium
   row 2: High (selected) / X-High / Max
```

Arithmetic: `18 + 16 + 196 = 230`; grid `90 × 2 + 16 = 196`. **The 2 × 3 grid is produced by wrapping a 740 row, not by a grid definition** — the same technique board 07's suggestion grid uses.

| Option | Title | Caption |
| --- | --- | --- |
| 1 | `None` | `Fastest replies` |
| 2 | `Low` | `Light reasoning` |
| 3 | `Medium` | `Balanced depth` |
| 4 **(selected)** | `High` | `Deep reasoning` |
| 5 | `X-High` | `Extra-deep reasoning` |
| 6 | `Max` | `Maximum depth` |

## `select/option` — NEW component

The only genuinely new *surface* on this board.

| Property | Value |
| --- | --- |
| Size | **236 × 90**, `flex-shrink: 0` — both fixed, **NO TOKEN** |
| Padding | `padding-block: 20`, `padding-inline: 22` — **no token for either** |
| Layout | `display: flex`, `flex-direction: column` |
| Radius | `var(--radius-lg)` **14** — same as suggestion chips |
| Fill · default | `var(--color-surface)` `#FFFFFF` |
| Fill · selected | **`var(--color-brand-tint)` `#E6E3F9`** |
| Border | none |
| Shadow | **elevation 03 Control** — `#1414320D 0px 2px 6px, #14143208 0px 1px 2px` — **identical in both states** |
| Title | `--text-body-lg` 20 / `--leading-snug` 24 · **500** (`--font-weight-medium`) · `var(--color-ink)` — **identical in both states** |
| Caption | `--text-body` 17 / `--leading-control` 22 · 400 · `var(--color-ink-secondary)`, `margin-top: var(--spacing-1)` 4 — **identical in both states** |

**Child arithmetic:** `20 + 24 + 4 + 22 + 20 = 90` ✔ · content width `236 − 22 × 2 = 192` ✔

**States:** exactly two — `default` and `selected`. **The only difference is the fill.** No border, no ring, no checkmark, no weight change, no shadow change. This is consistent with the rail's selected tool slot (`--color-brand-tint` on a 14pt radius) and is the third and fourth sanctioned uses of brand colour in the chrome. No hover / pressed / disabled state is drawn.

## Section — OpenAI API key (740 × 136 at 352, 670)

```
Section (flex column, width 740)
├─ Heading  "OpenAI API key"                                   740 × 18
├─ Caption  "Kept in this device's Keychain. It is sent to
│            OpenAI and nowhere else."                          740 × 18   margin-top 4
└─ field/key  740 × 80                                                     margin-top 16
```

Arithmetic: `18 + 4 + 18 + 16 + 80 = 136` ✔

**Caption type (shared by §3 and §4):** `--text-label` 15 / `--leading-label` 18 · **400** · `var(--color-ink-secondary)`.

### `field/key` — a re-skin of `Composer · wide`, not a new component

Box model is **identical to `Composer · wide` (`03 §1.3`)**: 740 × 80, `padding-left: var(--spacing-8)` 32, `padding-right: var(--spacing-3)` 12, `gap: 18`, `border-radius: var(--radius-full)`, fill `var(--color-surface)`, elevation **03 Control**, `display: flex; align-items: center`.

| Child | Size | Detail |
| --- | --- | --- |
| Key text | `flex-grow: 1`, measured 622 × 30 at local (32, 25) | **`--text-lead` 21 / `--leading-lead` 30 · 400 · `var(--color-ink)`** — note **`--color-ink`, not `--color-ink-tertiary`**: this is a filled field, not a placeholder |
| `btn/send` 56 | 56 × 56 | **Reused from `03 §7.2`** — `var(--color-brand)` fill, `--radius-full`, shadow `#1414320F 0px 2px 6px, #1414320A 0px 1px 2px`, glyph 26 × 26 on viewBox `0 0 24 24`, markup `stroke-width 2.5` with inline override **`1.85`** (→ 2.00 rendered), stroke `#FFFFFF` |

**Literal value, verbatim:** `sk-proj-••••••••••••••••••••••••7Q4F` — `sk-proj-` + **24 × U+2022 BULLET** + `7Q4F`. Only the last four characters are revealed.

No focused / empty / error state for this field is drawn anywhere in the file.

## Section — Irreversible (740 × 112 at 352, 850)

```
Section (flex column, width 740)
├─ Heading  "Irreversible"                                      740 × 18
├─ Caption  "Both take effect immediately and cannot be undone.
│            Neither one touches your board or its ink."         740 × 18   margin-top 4
└─ Actions  740 × 56                                                        margin-top 16
   flex row, align-items center, gap 16 (--spacing-4)
   ├─ btn/destructive  170 × 56   "Remove API key"
   └─ btn/destructive  183 × 56   "Reset this session"
```

Arithmetic: `18 + 4 + 18 + 16 + 56 = 112` ✔

## `btn/destructive` — NEW component

| Property | Value |
| --- | --- |
| Size | **height 56** fixed, **width hugs content**, `flex-shrink: 0` |
| Padding | `padding-inline: 28` — **no token** (28 happens to equal `--spacing-7` / `--space-edge`, but it is written as a literal here) |
| Layout | `display: flex`, `align-items: center` |
| Radius | `var(--radius-full)` |
| Fill | **`var(--color-surface-bubble)` `#F2F2F6`** |
| Border | none |
| Shadow | **none** — deliberately flat; it does not read as a floating control |
| Label | `--text-body` 17 / `--leading-control` 22 · **500** · `var(--color-ink)` |

**Width arithmetic:** `"Remove API key"` label 114 + 28 × 2 = **170** ✔ · `"Reset this session"` label 127 + 28 × 2 = **183** ✔

**States:** only the resting state is drawn. No pressed, no disabled, no confirmation dialog.

**Naming note.** The component is named `btn/destructive`, but it carries **no red, no colour, and no visual danger signal at all** — it is a bubble-grey pill. The entire destructive signal is carried by the section heading ("Irreversible") and the caption. This is the same "no semantic colour" constraint board 14 raises for correctness; see [Open questions](#open-questions).

## All literal copy on board 10

```
9:41 AM
Tue May 21
100%
Settings
Tutor model
Sol
Focused route
Terra
Balanced route
Luna
Default route
Reasoning effort
None
Fastest replies
Low
Light reasoning
Medium
Balanced depth
High
Deep reasoning
X-High
Extra-deep reasoning
Max
Maximum depth
OpenAI API key
Kept in this device's Keychain. It is sent to OpenAI and nowhere else.
sk-proj-••••••••••••••••••••••••7Q4F
Irreversible
Both take effect immediately and cannot be undone. Neither one touches your board or its ink.
Remove API key
Reset this session
```

There is **no designer prose written on board 10** — it is a pure screen board, like 05–08.

---

# Board 11 — First run · no API key

## Purpose / app state

Cold start: the app has launched, the board and rail are fully live and drawable, but the tutor cannot think because no OpenAI key is stored. **The tutor panel is the only thing in a special state** — the shell is untouched, so the student can draw immediately and is not blocked by a modal.

Board 14 explicitly distinguishes this from the auth error: *"board 11 no-key state — that is onboarding, this is a broken key."*

## Screen frame

| Property | Value |
| --- | --- |
| Size | 1376 × 1032 |
| Background | `var(--color-surface-screen)` `#F8F8F8` |

## Region map

| Region | x | y | w | h | Reuse |
| --- | --- | --- | --- | --- | --- |
| Status bar | 0 | 16 | 1376 | 24 | **Reused from 05** verbatim |
| Whiteboard canvas | 124 | 68 | 863 | 936 | **Reused from 05** — `--radius-3xl` 28, `overflow: clip`, fill `--color-surface-canvas`, elevation **01 Canvas** `#14143209 0px 2px 6px`. Contains only the dot grid — **no ink**. |
| Tool rail | 28 | 68 | 72 | **628** | **Reused from screen 08's rail**, not screen 05's — see note below |
| Tutor chat panel | 1011 | 68 | 337 | 936 | **Reused from 05 / `02 §5`** — `--radius-3xl` 28, fill `--color-surface-panel`, elevation **02 Panel**, `padding-top: 18`, `flex column`, `align-items: center` |

Horizontal lanes are the canonical docked lanes: `0–28 edge · 28–100 rail · 100–124 gap · 124–987 board · 987–1011 gap · 1011–1348 panel · 1348–1376 edge`.

### Tool rail geometry as measured on this board

`height: fit-content` → **628**. Container: `padding-block: 9`, `flex column`, `align-items: center`, `border-radius: var(--radius-2xl)` 20, fill `--color-surface-panel`, elevation 02. **The container has no `gap`** — children carry `margin-top` instead:

| Child | Size | Spacing |
| --- | --- | --- |
| Tools (4 × 54 × 54) | 54 × **226.5** | `gap: 3.5` |
| Divider | 46 × **1.5** | `margin-top: 11.5`, fill `--color-divider` |
| Swatches (5 × 27 × 27) | 27 × 243 | `margin-top: 19.5`, `gap: 27` |
| Thickness | 36 × 5 | `margin-top: 29`, radius 2.5, fill `--color-pen-black` |
| `tool/center` | 54 × 54 | `margin-top: 19.5` |

`9 + 226.5 + 11.5 + 1.5 + 19.5 + 243 + 29 + 5 + 19.5 + 54 + 9 = 627.5` → reported **628**.

This matches the **screen-08 rail (627.5)** documented in `05-screens.md`, not the canonical screen-05 rail (617, gap 0 / gap 27, container `gap: 12`). Boards 11 and 12 are byte-identical to each other here. See [Open questions](#open-questions).

## Tutor panel internals

| # | Child | Panel-local x, y | Size | Absolute x, y |
| --- | --- | --- | --- | --- |
| 1 | `Panel controls` | 18, 18 | 301 × 32 | 1029, 86 |
| 2 | `Orb` (panel size) | **120.5**, 298 | 96 × 90 | **1131.5**, 366 |
| 3 | `No-key state` | 18, 428 | 301 × 156 | 1029, 496 |
| 4 | `btn/primary` | 18, **860** (absolute) | 301 × 58 | 1029, 928 |

Flow arithmetic: `18 (padding-top) + 32 + 248 (orb margin-top) + 90 + 40 (--spacing-10) + 156 = 584`. The button is then **absolutely positioned** at local y 860, so `860 + 58 + 18 = 936` ✔ — i.e. the primary button is bottom-anchored with the standard 18 pt panel inset, exactly where the composer sits on screens 05 / 08.

The orb's x of **120.5** is `(337 − 96) ÷ 2` — a consequence of centre alignment, not a designed half-pixel. In SwiftUI, centre it; do not hard-code 120.5.

### Panel controls — expanded variant (**`btn/settings` is new here**)

| Property | Value |
| --- | --- |
| Frame | 301 × 32 at panel-local (18, 18), `display: flex`, `align-items: center`, **`justify-content: space-between`** |
| Left group `Layout controls` | 78 × 32, `display: flex`, `align-items: center`, `gap: 14` → `btn/dock` (32) + 14 + `btn/full-screen` (32) = 78 |
| Right | **`btn/settings`** 32 × 32 |

`btn/dock` and `btn/full-screen` are **reused unchanged from `02 §6`** (28 × 28 glyph on viewBox `0 0 28 28`, `stroke var(--color-icon)`, markup 2.1 → inline override 2). **`btn/settings` is new**: same 32 × 32 bare button, same 28 × 28 icon slot, new glyph `control/settings` (see [Four new icons](#four-new-icons)), `stroke-width 2` → 2.00 rendered.

**The row's layout changes from `justify-content: flex-start` (boards 05 / 08) to `space-between`.** This is a real change to a documented component, not just an addition.

### Orb — reused, `panel` size

Exactly the `panel` variant from `02 §11`: frame 96 × 90; halo 190 × 180 at `left −47, top −49` with alphas 75 % / 70 % and third ellipse `27% 26%`; body 54 × 42, `gap: 18`, `padding-top: 5`, `--radius-full`, the standard three-stop oklab body gradient; two 7 × 7 `#FFFFFF` eyes; **no mouth**. Elevation none.

### `No-key state` — NEW block (301 × 156)

`display: flex`, `flex-direction: column`, `align-items: center`, width 301.

| Child | Width | Type | Spacing |
| --- | --- | --- | --- |
| Title | **301** | `--text-title` 26 / `--leading-title` 34 · 600 · `--tracking-tight` · `var(--color-ink)`, `text-align: center` | — |
| Body | **277** | `--text-body` 17 / **`--leading-snug` 24** · 400 · `var(--color-ink-secondary)`, `text-align: center` | `margin-top: var(--spacing-3)` 12 |
| Pointer | **277** | `--text-label` 15 / `--leading-label` 18 · 400 · `var(--color-ink-secondary)`, `text-align: center` | `margin-top: var(--spacing-5)` 20 |

Arithmetic: `34 + 12 + 72 (3 × 24) + 20 + 18 = 156` ✔

The **277** measure (= 301 − 24) is the same narrowed measure the panel greeting on board 05 uses; the 17 / 24 pairing is the "short and centred" leading from `01 §2.4`, not the 17 / 25 of running message text.

No fill, no radius, no shadow — text sitting directly on the panel, per the "the tutor is the voice of the panel" rule.

## `btn/primary` — NEW component (panel variant)

| Property | Value |
| --- | --- |
| Size | **301 × 58** — width `var(--container-panel-content)`, **height 58, NO TOKEN** |
| Layout | `display: flex`, `align-items: center`, `justify-content: center` |
| Padding | **none** — the label is centred, not inset |
| Radius | `var(--radius-full)` |
| Fill | `var(--color-brand)` `#6051DC` |
| Border | none |
| Shadow | **elevation 03 Control** — `#1414320D 0px 2px 6px, #14143208 0px 1px 2px` |
| Label | `--text-body` 17 / `--leading-control` 22 · **600** · **`#FFFFFF` literal** (not `var(--color-surface)`) |

**58 is the panel composer's height** (`03 §1.1`), so the button occupies the composer's slot exactly. That is the whole reason for the number.

**States:** resting only. No pressed, no disabled, no loading.

## All literal copy on board 11

```
9:41 AM
Tue May 21
100%
One thing before we start
I need an OpenAI API key to think with. It is kept in this device's Keychain and never leaves it.
Get one at platform.openai.com
Add your API key
```

Note the copy discipline: the key's storage promise is stated **twice**, once here in first person ("kept in this device's Keychain and never leaves it") and once on board 10 in third person ("Kept in this device's Keychain. It is sent to OpenAI and nowhere else."). The two sentences are **not** identical and the board-10 one is strictly more accurate — see [Open questions](#open-questions).

There is **no designer prose written on board 11**.

---

# Board 12 — Session plan · panel

## Purpose / app state

The tutor has agreed a plan for the session and is showing it **inside the thread, as a message**, at panel scale. The student's request is still visible above it. The board carries the student's real work (the vector diagram), so this is mid-session, not onboarding.

The plan is **not a card, not a modal, and not a panel takeover** — it is a flow child of `Thread`, subject to the same 22 pt message gap and the same scroll fade as any message.

## Screen frame

| Property | Value |
| --- | --- |
| Size | 1376 × 1032 |
| Background | `var(--color-surface-screen)` `#F8F8F8` |

## Region map

| Region | x | y | w | h | Reuse |
| --- | --- | --- | --- | --- | --- |
| Status bar | 0 | 16 | 1376 | 24 | **Reused from 05** |
| Whiteboard canvas | 124 | 68 | 863 | 936 | **Reused from 05** — elevation 01, `--color-surface-canvas`, radius 28, `overflow: clip` |
| ↳ Handwritten ink | 281 | 215 | 548 | 641 | canvas-local (157, 147) — **the same ink asset and position as screens 05 / 08** |
| Tool rail | 28 | 68 | 72 | 628 | **Identical to board 11** (see that section) |
| Tutor chat panel | 1011 | 68 | 337 | 936 | **Reused from 05** |

## Tutor panel internals

| # | Child | Panel-local x, y | Size | Absolute x, y |
| --- | --- | --- | --- | --- |
| 1 | `Panel controls` | 18, 18 | 301 × 32 | 1029, 86 |
| 2 | `Thread` | 18, 50 | 301 × **786** | 1029, 118 |
| 3 | `Composer` | 18, 860 | 301 × 58 | 1029, 928 |

`18 + 32 + 786 + 24 + 58 + 18 = 936` — note the **24 pt gap between the thread's bottom (local 836) and the composer (local 860)**. Screen 08's thread is 810 and abuts the composer directly. See [Open questions](#open-questions).

`Panel controls` is the **expanded variant with `btn/settings`**, identical to board 11.

### `Thread` — reused from `03 §5` with one measured difference

| Property | Value |
| --- | --- |
| Size | **301 × 786** (screen 08: 301 × 810) |
| Position | `absolute` (18, 50) |
| Layout | `flex` column, **`justify-content: flex-end`**, `overflow: clip` |
| Gap | `var(--space-message-gap)` **22** |
| Padding | **none** — screen 08's thread carries `padding-bottom: 18`; this one does not (the 24 pt gap to the composer replaces it) |

Children, in order:

| # | Node | Thread-local y | h | Absolute y | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `msg/tutor` | **−12** | 50 | 106 | Overflows the thread's top edge by 12 and is clipped — it is the oldest visible message |
| 2 | `msg/student` | 60 | 99 | 178 | |
| 3 | `plan/panel` | 181 | 605 | 299 | |
| — | `Scroll fade` | absolute 0, 0 | 301 × 72 | 118 | Last child, painted over the messages |

Gap check: `−12 + 50 = 38`, `+22 = 60` ✔ · `60 + 99 = 159`, `+22 = 181` ✔ · `181 + 605 = 786` ✔

`msg/tutor` and `msg/student` are **reused from `03 §3.1` / `§3.3`** unchanged: tutor is a bare `Text`, 301 wide, 17 / 25 · 400 · `--color-ink`, no padding, no fill; student is a 301-wide row with `justify-content: flex-end` holding a bubble with `max-width: 224`, `padding-block: 12`, `padding-inline: 16`, `--radius-bubble` 18, fill `--color-surface-bubble`, text 17 / 25 · 400 · `--color-ink`. Bubble height `12 + 25 × 3 + 12 = 99` ✔

`Scroll fade` is **reused from `03 §6`** verbatim, including the untokenised gradient: `linear-gradient(in oklab 180deg, oklab(99.1% 0 0) 0%, oklab(99.1% 0 0) 34%, oklab(99.1% 0 0 / 72%) 62%, oklab(99.1% 0 0 / 0%) 100%)`.

### `Composer` — reused from screen 08, structurally simplified

Screen 08's composer is a `position: relative` wrapper holding an absolutely-positioned `Input`. **On board 12 it is a single flat frame** — the wrapper is gone. Every value is otherwise the same:

| Property | Value |
| --- | --- |
| Size | 301 × 58, `position: absolute` at panel-local (18, 860) |
| Padding | `padding-left: 20`, `padding-right: 8` |
| Gap | 12 |
| Radius | `var(--radius-full)` · Fill `var(--color-surface)` · Shadow **03 Control** |

| Child | Size | Detail |
| --- | --- | --- |
| Marquee icon | 24 × 24 | viewBox `0 0 24 24`; `<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4" fill="none" stroke-width="2" stroke-dasharray="4.6 3.9"/>`; stroke bound to **`var(--color-brand)`** (raw attribute `#6051DC`) |
| Placeholder | `flex-grow: 1` | `Ask anything...` — 17 / `--leading-control` 22 · 400 · `var(--color-ink-tertiary)` |
| `btn/voice` | **38 × 38** | Bare hit area, no fill/radius/shadow. Glyph 20 × 20 on viewBox `0 0 24 24`, `stroke var(--color-icon)`, `stroke-width 2.4` (→ 2.00 rendered) |
| `btn/send` | 42 × 42 | `var(--color-brand)`, `--radius-full`, **no shadow**. Glyph 22 × 22, viewBox `0 0 24 24`, markup `stroke-width 2.5` with inline override **`2.18`** (→ 2.00 rendered), stroke `#FFFFFF` |

This matches `05-screens.md`'s screen-08 composer exactly (voice 38 at x 201, send 42 at x 251). It **contradicts `03-chat-components.md §7.4`**, which states voice exists only at full-screen scale and flags the asymmetry as unresolved — that note is now stale in one direction. See [Open questions](#open-questions).

## `plan/panel` — NEW block (301 × 605)

`display: flex`, `flex-direction: column`, `flex-shrink: 0`, width 301. No fill, no radius, no shadow, no padding — **it sits directly on the panel like any tutor message.**

| # | Child | Size | Spacing above | Type |
| --- | --- | --- | --- | --- |
| 1 | Kicker `Session plan` | 301 × 18 | — | `--text-label` 15 / `--leading-label` 18 · **600** · `var(--color-ink-secondary)` |
| 2 | Title `Vectors, in four moves` | 301 × 34 | `var(--spacing-2)` 8 | `--text-title` 26 / `--leading-title` 34 · 600 · `--tracking-tight` · `var(--color-ink)` |
| 3 | Goal | 301 × 50 | `var(--spacing-3)` 12 | `--text-body` 17 / `--leading-body` 25 · 400 · `var(--color-ink-secondary)` (2 lines) |
| 4 | `Steps` | 301 × 186 | `var(--spacing-5)` 20 | flex column, `gap: var(--spacing-3)` 12 |
| 5 | Outcomes label `What success looks like` | 301 × 18 | `var(--spacing-6)` 24 | `--text-label` 15 / 18 · **600** · `var(--color-ink-secondary)` |
| 6 | `Outcomes` | 301 × 141 | `var(--spacing-3)` 12 | flex column, `gap: var(--spacing-2)` 8 |
| 7 | `btn/primary` | 301 × 58 | `var(--spacing-6)` 24 | see below |

**Full arithmetic:** `18 + 8 + 34 + 12 + 50 + 20 + 186 + 24 + 18 + 12 + 141 + 24 + 58 = 605` ✔

### `Steps` (301 × 186) — 4 × `plan/step`, `gap: 12`

`50 + 12 + 25 + 12 + 50 + 12 + 25 = 186` ✔ (rows 1 and 3 wrap to two lines)

### `Outcomes` (301 × 141) — 3 × `plan/outcome`, `gap: 8`

`50 + 8 + 50 + 8 + 25 = 141` ✔ (rows 1 and 2 wrap to two lines)

### The shared numbered lane — panel scale

Both `plan/step` and `plan/outcome` are the **same lane**, differing only in what fills the leading slot:

```
Row: display: flex, align-items: flex-start, gap: 14
├─ leading slot   22 wide × 25 tall,  flex-shrink: 0
└─ text          265 wide,            flex-shrink: 0
                 --text-body 17 / --leading-body 25 · 400 · var(--color-ink)
```

`22 + 14 + 265 = 301` ✔ — **the lane is exactly the panel content width.**

| | `plan/step` leading slot | `plan/outcome` leading slot |
| --- | --- | --- |
| Content | `Text` "1"…"4" | `ui/check` SVG, 22 × 22 |
| Style | `--text-label` 15 · **600** · `var(--color-ink-secondary)`, **explicit `height: 25px` and `line-height: 25px`** so the digit sits on the body line box | frame `display: flex, align-items: center, justify-content: center`, `height: 25`, `width: 22` |

The 25 pt slot height is the point: **the number and the check both sit on the same 25 pt line box as the first line of the text**, so multi-line rows stay top-aligned and single-line rows look optically centred.

Board 14 states this lane is shared a third way: *"Lane: 22 slot + 14 gap + 265 text — identical to plan/outcome, so the two align"* for evaluation findings.

### `btn/primary` — panel variant, reused from board 11

Identical spec (301 × 58, `--radius-full`, `var(--color-brand)`, elevation 03, label 17 / 22 · 600 · `#FFFFFF`), with `margin-top: var(--spacing-6)` 24 instead of absolute positioning. Label: `Start on the board`.

## All literal copy on board 12

```
9:41 AM
Tue May 21
100%
Nice work on that diagram — the arrow and the labels are both in the right place.
i want to actually understand vectors, not just plug in numbers
Session plan
Vectors, in four moves
Read any 2D vector off a diagram and write it as components.
1
Draw axes and one arrow from the origin
2
Read its x and y parts off the grid
3
Slide the arrow somewhere else and check what changed
4
Add two vectors tip-to-tail
What success looks like
You can name the parts of any drawn vector
You can say why moving one doesn't change it
You can add two of them by hand
Start on the board
Ask anything...
```

There is **no designer prose written on board 12**.

---

# Board 13 — Session plan · full screen

## Purpose / app state

The same plan state as board 12, at full-screen scale. **This is the first board in the file to define a thread at the 740 column** — board 03 only ever specced the 301 column, and board 14 says so explicitly (see [Values that are not tokens](#values-that-are-not-tokens)).

## Screen frame

| Property | Value |
| --- | --- |
| Size | 1376 × 1032 |
| Background | **`#FFFFFF`** — literal, matching board 07 and board 10 |

## Region map

| Region | x | y | w | h | Reuse |
| --- | --- | --- | --- | --- | --- |
| Status bar | 0 | 16 | 1376 | 24 | **Reused from 05** |
| Board peek | 0 | 68 | 68 | 936 | **Reused from 07 / `02 §10`** verbatim, faked shadow and all |
| Panel controls | 352 | 68 | 740 | 32 | expanded variant, `justify-content: space-between` |
| Thread · wide | 352 | **100** | 740 | **800** | new width, see below |
| Composer · wide | 352 | 924 | 740 | 80 | **Reused from `03 §1.3` / board 07** unchanged |

Column x 352 → 1092, width 740, centred past the peek exactly as board 07: `68 + (1376 − 68 − 740) ÷ 2 = 352`.

**Vertical stack:** controls `68 → 100` · thread `100 → 900` · **24 pt gap** · composer `924 → 1004`. The composer's bottom lands on 1004 = the safe-band bottom, identical to board 07.

There is **no tool rail and no whiteboard canvas** on this board — only the peek, as on board 07.

### Panel controls — expanded variant at full-screen width

740 × 32 at (352, 68), `display: flex`, `align-items: center`, **`justify-content: space-between`**.

- Left: `Layout controls` 78 × 32 — `btn/dock` + `gap: 14` + `btn/full-screen`, both 32 × 32 with 28 × 28 glyphs.
- Right: **`btn/settings`** 32 × 32, glyph `control/settings` 28 × 28, `stroke-width 2`.

Same components as boards 11 / 12; only the container width changes.

### `Composer · wide` — reused verbatim

740 × 80, `padding-left: var(--spacing-8)` 32, `padding-right: var(--spacing-3)` 12, `gap: 18`, `--radius-full`, `var(--color-surface)`, elevation **03 Control**.

| Child | Size | Detail |
| --- | --- | --- |
| Placeholder | `flex-grow: 1` | `Ask me anything...` — `--text-lead` 21 / **26** · 400 · `var(--color-ink-tertiary)` (26 is a raw line-height, not `--leading-lead` 30 — same as board 07) |
| `btn/voice` | 52 × 52 | bare hit area, glyph 26 × 26 on viewBox `0 0 24 24`, `stroke var(--color-icon)`, markup 1.9 → inline override **1.85** |
| `btn/send` | 56 × 56 | `var(--color-brand)`, `--radius-full`, shadow `#1414320F 0px 2px 6px, #1414320A 0px 1px 2px`, glyph 26 × 26, markup 2.5 → inline override **1.85** |

**There is no marquee / attachment icon in the full-screen composer** — same omission as board 07.

## `Thread · wide` — NEW (740 × 800)

The 740-column thread, previously undefined.

| Property | Value |
| --- | --- |
| Size | **740 × 800**, `position: absolute` at (352, 100) |
| Layout | `flex` column, **`justify-content: flex-end`**, `overflow: clip` |
| Gap | `var(--space-message-gap)` **22** — **unchanged from panel scale** |
| Padding | none |

| # | Node | Thread-local y | h | Absolute y |
| --- | --- | --- | --- | --- |
| 1 | `msg/tutor` | 26 | 30 | 126 |
| 2 | `msg/student` | 78 | 92 | 178 |
| 3 | `plan/full-screen` | 192 | 608 | 292 |
| — | `Scroll fade` | absolute 0, 0 | 740 × 72 | 100 |

Gap check: `26 + 30 = 56`, `+22 = 78` ✔ · `78 + 92 = 170`, `+22 = 192` ✔ · `192 + 608 = 800` ✔

### `msg/tutor` at 740 — NEW spec

| Property | Value |
| --- | --- |
| Node | bare `Text` — **no bubble, no container**, same rule as panel scale |
| Width | **740** fixed |
| Type | **`--text-lead` 21 / `--leading-lead` 30 · 400 · `var(--color-ink)`** |
| Padding / fill / shadow | none |

### `msg/student` at 740 — NEW spec

```
Row     740 wide, display: flex, justify-content: flex-end
└─ Bubble   max-width: 520          <- NEW
            padding-block: 16, padding-inline: 24      <- NEW
            border-radius: var(--radius-bubble) 18
            background: var(--color-surface-bubble) #F2F2F6
            no shadow
   └─ Text  --text-lead 21 / --leading-lead 30 · 400 · var(--color-ink)
```

Measured: 2 wrapped lines → bubble `16 + 30 × 2 + 16 = 92` ✔, text box 472 wide (= 520 − 24 × 2).

**Scaling table, panel → full screen:**

| | Panel (301) | Full screen (740) |
| --- | --- | --- |
| Tutor text | 17 / 25 | **21 / 30** |
| Student text | 17 / 25 | **21 / 30** |
| Bubble max-width | 224 | **520** |
| Bubble padding | block 12 / inline 16 | **block 16 / inline 24** |
| Bubble radius | 18 | **18 (unchanged)** |
| Message gap | 22 | **22 (unchanged)** |

Both the radius and the message gap deliberately do **not** scale.

### `Scroll fade` at 740 — same component, different white

`740 × 72`, absolute (0, 0), last child of the thread.

`linear-gradient(in oklab 180deg, oklab(100% 0 0) 0%, oklab(100% 0 0) 34%, oklab(100% 0 0 / 72%) 62%, oklab(100% 0 0 / 0%) 100%)`

`oklab(100% 0 0)` = **`#FFFFFF`**, because the full-screen background is white — where the panel version fades from `oklab(99.1% 0 0)` = `#FCFCFC`. **The same untokenised-gradient warning from `03 §6` applies, now with two hard-coded whites instead of one.**

## `plan/full-screen` — NEW block (740 × 608)

Same seven-child structure as `plan/panel`, every value stepped up.

| # | Child | Size | Spacing above | Type |
| --- | --- | --- | --- | --- |
| 1 | Kicker `Session plan` | 740 × 25 | — | `--text-body` 17 / `--leading-body` 25 · **600** · `var(--color-ink-secondary)` |
| 2 | Title | 740 × 48 | `var(--spacing-2)` **8** | `--text-display` 40 / `--leading-display` 48 · 600 · `--tracking-tight` · `var(--color-ink)` |
| 3 | Goal | 740 × 30 | `var(--spacing-4)` **16** | `--text-lead` 21 / `--leading-lead` 30 · 400 · `var(--color-ink-secondary)` |
| 4 | `Steps` | 740 × 156 | `var(--spacing-10)` **40** | flex column, `gap: var(--spacing-5)` 20 |
| 5 | Outcomes label | 740 × 25 | `var(--spacing-10)` **40** | `--text-body` 17 / 25 · **600** · `var(--color-ink-secondary)` |
| 6 | `Outcomes` | 740 × 96 | `var(--spacing-5)` **20** | flex column, `gap: var(--spacing-3)` 12 |
| 7 | `btn/primary` | **220 × 64** | `var(--spacing-10)` **40** | see below |

**Full arithmetic:** `25 + 8 + 48 + 16 + 30 + 40 + 156 + 40 + 25 + 20 + 96 + 40 + 64 = 608` ✔

`Steps`: `24 × 4 + 20 × 3 = 156` ✔ · `Outcomes`: `24 × 3 + 12 × 2 = 96` ✔ — **every row is a single line at this width**, which is why the numbers are so much tidier than the panel's.

### The shared numbered lane — full-screen scale

```
Row: display: flex, align-items: flex-start, gap: var(--spacing-4) 16
├─ leading slot   24 wide × 24 tall,  flex-shrink: 0
└─ text          700 wide,            flex-shrink: 0
                 --text-body-lg 20 / --leading-snug 24 · 400 · var(--color-ink)
```

`24 + 16 + 700 = 740` ✔

| | `plan/step` leading slot | `plan/outcome` leading slot |
| --- | --- | --- |
| Content | `Text` "1"…"4" | `ui/check` SVG, **24 × 24** |
| Style | `--text-body` **17** · 600 · `var(--color-ink-secondary)`, explicit `height: 24px` / `line-height: 24px` | frame `display: flex, align-items: center, justify-content: center`, 24 × 24 |

Note the number steps **15 → 17** while the body steps **17 → 20**: the number stays quieter than the text it labels at both scales.

### `btn/primary` — full-screen variant

| Property | Value |
| --- | --- |
| Size | **height 64, width hugs content** (measured **220** for `Start on the board`), `flex-shrink: 0` |
| Alignment | **`align-self: flex-start`** — it does *not* stretch to the 740 column |
| Padding | `padding-inline: var(--spacing-8)` 32 |
| Radius / fill / shadow | `var(--radius-full)` · `var(--color-brand)` · elevation **03 Control** — identical to the panel variant |
| Label | `--text-body-lg` 20 / `--leading-snug` 24 · **600** · `#FFFFFF` literal |

Width arithmetic: label 156 + 32 × 2 = **220** ✔

**Panel → full-screen diff:** `301 × 58` full-bleed, no padding, label 17 / 22 → `hug × 64`, `padding-inline: 32`, label 20 / 24. The height goes 58 → 64 and the sizing model changes from *fill* to *hug*.

## All literal copy on board 13

```
9:41 AM
Tue May 21
100%
Nice work on that diagram — the arrow and the labels are both in the right place.
i want to actually understand vectors, not just plug in numbers
Session plan
Vectors, in four moves
Read any 2D vector off a diagram and write it as components.
1
Draw axes and one arrow from the origin
2
Read its x and y parts off the grid
3
Slide the arrow somewhere else and check what changed
4
Add two vectors tip-to-tail
What success looks like
You can name the parts of any drawn vector
You can say why moving one doesn't change it
You can add two of them by hand
Start on the board
Ask me anything...
```

Copy is **word-for-word identical to board 12** except the composer placeholder (`Ask anything...` → `Ask me anything...`), which matches the existing panel / full-screen split from `03 §1.4`.

There is **no designer prose written on board 13**.

---

# Board 14 — Components · Tutor states

## Purpose

The documentation board for everything the tutor does that is **not** a finished message. It is the only one of the five new boards that carries designer prose, and the prose is where the decisions live.

## Board frame and layout

| Property | Value |
| --- | --- |
| Size | 1680 × **fit-content → 3359** |
| Background | `var(--color-surface)` `#FFFFFF` |
| Layout | `flex` column, `align-items: center`, `padding-block: 80`, `gap: 80` |
| Content width | **1520** (= 1680 − 80 × 2) |

| Block | y | h |
| --- | --- | --- |
| Board header | 80 | 192 |
| Section — Thinking | 352 | 849 |
| Section — Errors | 1281 | 838 |
| Section — Evaluation | 2199 | 652 |
| Unresolved | 2931 | 348 |

`80 + 192 + 80 + 849 + 80 + 838 + 80 + 652 + 80 + 348 + 80 = 3359` ✔

**All of board 14 is documentation chrome** (`--font-doc` Montserrat titles, `--font-mono` IBM Plex Mono spec values, 13 px eyebrows) — none of it ships. Only the specimens inside the stages are product.

### Documentation chrome typography (reference only)

| Element | Style |
| --- | --- |
| Eyebrow | `--font-sans` 13 / 16 · 600 · `--tracking-wide` 0.06em · `var(--color-ink-tertiary)` |
| Board title | **`--font-doc`** 40 / 48 · 600 · `--tracking-tight` · `var(--color-ink)` |
| Section title | **`--font-doc`** 34 / 42 · 600 · `--tracking-tight` · `var(--color-ink)` |
| Blurb | `--font-sans` 17 / **26** · 400 · `var(--color-ink-secondary)`, width **860** |
| Header/section-head gap | `var(--spacing-3)` 12 |
| Section internal gap | **36** |

### Specimen stage (the grey card each state sits in)

| Property | Value |
| --- | --- |
| Layout | `display: flex`, `align-items: center`, `justify-content: center`, `min-width: 389`, `padding: 44`, height hugs |
| Radius | **20** (raw, not `--radius-2xl`'s semantic use) |
| Fill | `var(--color-surface-panel)` `#FCFCFC` — it stands in for the tutor panel |
| Inner width | **301** — every specimen is shown at panel scale |

`389 = 301 + 44 × 2`. Each `state/*` row is `display: flex`, `align-items: flex-start`, `gap: 48`, with the stage on the left and a 1083-wide spec column on the right.

### Spec column and spec rows

Spec column: 1083 wide, `flex` column, `padding-top: 4`; title block `padding-bottom: 14` holding a 19 / 24 · 600 · `--color-ink` label. Each spec row: `display: flex`, `align-items: baseline`, `justify-content: space-between`, `gap: 24`, `padding-block: 9`, `box-shadow: var(--color-divider) 0px 1px 0px` (a 1 px hairline rule under every row **except the last**). Key = `--font-sans` 15 / 18 · 400 · `var(--color-ink-secondary)`; value = **`--font-mono`** 15 / 18 · 500 · `var(--color-ink)`, right-aligned, wrapping.

Measured row height **37** (nominal `9 + 18 + 9 = 36`; the mono value box rounds to 19). Title block **38**.

---

## Board header — prose, verbatim

> **COMPONENTS · Tutor states**
>
> "Everything the tutor does that is not a finished message: thinking, streaming, failing, and reporting back on the student's work. None of these gets a container. The rule from board 03 holds — the tutor is the voice of the panel, not a participant in a chat log — so a state is expressed by a mark, a lane and a line of copy, never by a card. There is no semantic colour anywhere in this system, so correctness is carried by glyph shape, not by red and green."

---

## Section 01 — Thinking & streaming (1520 × 849 at y 352)

Children: `Section head` (y 0, h 212) · `state/thinking` (y 248, h 301) · `state/streaming` (y 585, h 264). Gap 36.

### Prose, verbatim

> **01 — THINKING & STREAMING · Thinking, then streaming**
>
> "Before the first token there is a three-dot mark sitting exactly where the reply will begin, on the same 25pt line box a message would occupy — so nothing moves when the text arrives. Once tokens are arriving the dots are gone and the text simply grows, with a 2pt caret pinned to the end of it. When the tutor is doing something specific rather than just answering — reading the board, for instance — a status line names the task above the dots, because at Max reasoning effort a silent wait is indistinguishable from a hang."

### `state/thinking` — NEW component

Stage 389 × 182; specimen **301 × 94**, `flex` column, `gap: var(--space-message-gap)` 22. The stage shows **both variants stacked**: the bare dots, then the status-line form.

**Variant A — bare dots (the default):**

```
Row   height 25, display: flex, align-items: center, gap: var(--spacing-2) 8
├─ Dot   6 × 6   border-radius: var(--radius-full)   background: var(--color-icon)
├─ Dot   6 × 6
└─ Dot   6 × 6
```

Width `6 × 3 + 8 × 2 = 34`, but the frame's **width is auto** — the mark hugs.

**Variant B — with status line:**

```
Column, gap: var(--spacing-1) 4
├─ Status text   "Reading your board"
│                --text-label 15 / --leading-label 18 · 600 · var(--color-ink-secondary)
└─ Dot row       height 25, gap 8, three 6 × 6 dots
```

Height `18 + 4 + 25 = 47` ✔ · specimen total `25 + 22 + 47 = 94` ✔

**Spec table, verbatim:**

| Key | Value |
| --- | --- |
| Size | `width auto, height 25 — one body line box` |
| Dot | `6 × 6 · radius-full · NO TOKEN — component-internal` |
| Gap | `var(--spacing-2) 8` |
| Fill | `var(--color-icon) #55565A — a mark, not content` |
| Status line | `15 / 18 · 600 · var(--color-ink-secondary) · gap 4 above dots` |
| Elevation | `none — no fill, no container` |
| Motion | `opacity 0.35 → 1 → 0.35, 1.2s loop, 160ms stagger — spec, not drawn` |

**The 25 pt height is the whole idea**: the indicator occupies exactly one `--leading-body` line box, so replacing it with the first line of the reply causes zero layout shift.

**Relation to `btn/orb` 46.** Screen 08 currently uses a 46 × 46 orb at the tail of the thread as its thinking indicator (`05-screens.md`, message 10). `state/thinking` is a different, smaller mark. See [Open questions](#open-questions).

### `state/streaming` — NEW component

Stage 389 × 163; specimen **301 × 75**, `flex` column, **no gap**.

```
Column, width 301
├─ Text (completed lines)   301 wide, --text-body 17 / --leading-body 25 · 400 · var(--color-ink)
└─ Live line   height 25, display: flex, align-items: center, gap: 2
   ├─ Text (partial)   17 / 25 · 400 · var(--color-ink)
   └─ Caret            2 × 22   border-radius: var(--radius-full)   background: var(--color-ink)
```

Specimen: 2 completed lines (50) + live line (25) = **75** ✔

**Spec table, verbatim:**

| Key | Value |
| --- | --- |
| Node | `msg/tutor exactly — the growing text IS the message` |
| Caret | `2 × 22 · radius-full · var(--color-ink) · NO TOKEN — component-internal` |
| Caret height | `22 = var(--leading-control), optically centred in the 25 line box` |
| Caret gap | `2 after the last glyph — NO TOKEN, optical` |
| Thread behaviour | `thread stays justify-content: flex-end — text grows upward, composer never moves` |
| Motion | `caret opacity 1 → 0 → 1, 1.06s step — no fade on the text itself` |

The caret is a **rounded 2 pt bar**, not a text cursor, and it takes `--color-ink` — the same colour as the text it trails.

---

## Section 02 — Failure & recovery (1520 × 838 at y 1281)

Children: `Section head` (y 0, h 238) · `state/error · network` (y 274, h 264) · `state/error · auth` (y 574, h 264). Gap 36.

### Prose, verbatim

> **02 — FAILURE & RECOVERY · When it fails**
>
> "A failure is a tutor message, not a system alert: same 17/25 text, same left edge, no box, no colour. What follows it is a suggestion chip — the component that already means 'this is the thing to tap next' — carrying the one action that fixes it. The only departure from the chip's normal appearance is the glyph colour: recovery chips take var(--color-icon), not var(--color-brand), because a repair is not a suggestion. The precedent is ui/selection-marker, which is already one asset in two colour states. Under the chip, one line of 15/18 secondary copy says what was NOT lost, because that is the actual question a student has."

### Shared structure of both error states

```
Column, width 301
├─ Message      301 wide, --text-body 17 / --leading-body 25 · 400 · var(--color-ink)
├─ Recovery chip   301 × 62      margin-top: var(--spacing-4) 16
└─ Reassurance  301 wide, --text-label 15 / --leading-label 18 · 400 · var(--color-ink-secondary)
                                 margin-top: var(--spacing-3) 12
```

### Recovery chip — `chip/suggestion · panel` with one override

Every box-model value is **reused unchanged from `03 §8.1`**: 301 × 62, `padding-left: 18` (**no right padding**), `gap: 14`, `border-radius: var(--radius-lg)` 14, fill `var(--color-surface)`, shadow **03 Control**, `display: flex`, `align-items: center`, icon slot 22 × 22, label `--text-body` 17 / `--leading-control` 22 · **500** · `var(--color-ink)`.

**The single override:** glyph stroke is **`var(--color-icon)` `#55565A`** instead of `var(--color-brand)` `#6051DC`. Stroke width 2.18 (→ 2.00 rendered at 22 on a 24 viewBox), matching `04-icons.md`'s prescription for panel-scale chip glyphs.

### `state/error · network`

Stage 389 × 239; specimen 301 × 151 = `25 + 16 + 62 + 12 + 36` ✔ (reassurance wraps to 2 lines).

Copy: message `I couldn't reach the tutor service just now.` · chip `Try again` (glyph **`ui/retry`**) · reassurance `Nothing was lost — what you wrote is still in the composer.`

**Spec table, verbatim:**

| Key | Value |
| --- | --- |
| Message | `msg/tutor unchanged — 17 / 25 · 400 · var(--color-ink)` |
| Action | `chip · panel · 301 × 62 · radius-lg · elevation 03 — reused as-is` |
| Glyph | `ui/retry · vb 24 · rendered 22 · stroke 2.18 → 2.00 · var(--color-icon)` |
| Why not brand | `a repair is not a suggestion — and the violet budget is spent elsewhere` |
| Gaps | `message → chip 16 · chip → reassurance 12` |
| Not used | `no red, no icon badge, no banner, no modal — var(--color-pen-red) is ink, not UI` |

### `state/error · auth`

Stage 389 × 264; specimen 301 × 176 = `50 + 16 + 62 + 12 + 36` ✔ (message wraps to 2 lines).

Copy: message `OpenAI turned that down — the key looks wrong, or it has expired.` · chip `Open Settings` (glyph **`control/settings`**) · reassurance `Your conversation is safe. Replace the key and pick up where we stopped.`

**Spec table, verbatim:**

| Key | Value |
| --- | --- |
| Difference | `identical structure — only the copy and the glyph change` |
| Glyph | `control/settings · vb 28 · rendered 22 · stroke 2.18 · var(--color-icon)` |
| Destination | `board 10 — Settings, OpenAI API key section, field focused` |
| Copy rule | `name who refused, never "an error occurred" — the tutor is not a system` |
| Distinct from | `board 11 no-key state — that is onboarding, this is a broken key` |

**Note the glyph row does not claim → 2.00.** `2.18 × 22 ÷ 28 = 1.71` rendered — below the 2.0 target. See [Open questions](#open-questions).

---

## Section 03 — Evaluation feedback (1520 × 652 at y 2199)

Children: `Section head` (y 0, h 212) · `state/evaluation` (y 248, h 404). Gap 36.

### Prose, verbatim

> **03 — EVALUATION FEEDBACK · Looking at your work**
>
> "The student lassoes part of the board and asks; the tutor answers about that region. The attached-selection bubble above the reply is doing the pointing, so the reply never has to say 'in your diagram'. A verdict sentence comes first, then findings on a 22 / 14 lane — the same lane the session plan uses — one line each. Correct and incorrect are told apart by glyph shape only, both in var(--color-icon). Order is fixed: what is right, then what is not, then one thing to do. Never lead with the mistake."

### `state/evaluation` — NEW composite

Stage 389 × 404; specimen **301 × 316**, `flex` column, `gap: var(--space-message-gap)` 22.

```
Column 301, gap 22
├─ msg/student · with selection      301 × 96    (reused verbatim from 03 §3.4)
└─ Reply block                       301 × 198   flex column, no gap
   ├─ Verdict      301 wide, 17 / 25 · 400 · var(--color-ink)
   ├─ Findings     301 × 91      margin-top: var(--spacing-4) 16
   │               flex column, gap: var(--spacing-2) 8
   └─ Next move    301 wide, 17 / 25 · 400 · var(--color-ink)
                   margin-top: var(--spacing-4) 16
```

Arithmetic: reply block `25 + 16 + 91 + 16 + 50 = 198` ✔ · specimen `96 + 22 + 198 = 316` ✔ · findings `25 × 3 + 8 × 2 = 91` ✔

**`msg/student · with selection` is reused unchanged from `03 §3.4`** — including the copied-from-the-composer 67 pt card height:

```
Row                    301 × 96   flex, justify-content: flex-end
└─ Bubble stack        224 × 96   position: relative
   ├─ [z0] card        224 × 67   absolute 0,0   radius 29/29/0/0   fill --color-brand-tint-soft
   │                              padding-left 20 / right 16, align-items: flex-start
   │  └─ label row     188 × 38   padding-top 6, padding-inline 3, align-items: center
   │     └─ "Selection"           15 / 18 · 600 · var(--color-brand)
   └─ [z1] bubble      224 × 58   absolute 0,38  radius --radius-bubble 18  fill --color-surface-bubble
                                  padding-inline 20
      └─ text                     17 / --leading-control 22 · 400 · var(--color-ink)
```

(The card here uses the composer's **29** top radius rather than board 03's stated 18 — the same copy artefact `03 §3.4` flags. Recorded as measured.)

### Findings lane — the third user of the shared numbered lane

```
Row: display: flex, align-items: flex-start, gap: 14
├─ mark slot   22 wide × 25 tall,  flex: center/center
│              ui/check  (correct)  OR  ui/cross  (incorrect)
│              22 × 22 SVG, viewBox 0 0 24 24, stroke 2.18 → 2.00, stroke var(--color-icon)
└─ text       265 wide, --text-body 17 / --leading-body 25 · 400 · var(--color-ink)
```

`22 + 14 + 265 = 301` ✔ — pixel-identical to `plan/outcome` at panel scale, which is exactly what the spec row asserts.

**Both marks are `var(--color-icon)` `#55565A`. There is no colour difference between a correct and an incorrect finding.**

Copy, in the fixed order the prose mandates:

| # | Mark | Text |
| --- | --- | --- |
| 1 | `ui/check` | `The arrow starts at the origin` |
| 2 | `ui/check` | `Both axes are labelled` |
| 3 | `ui/cross` | `(x, y) labels the tip, not the arrow` |

**Spec table, verbatim:**

| Key | Value |
| --- | --- |
| Context | `msg/student · with selection, reused unchanged — it does the pointing` |
| Structure | `verdict → findings → one next move · gaps 16 / 8 / 16` |
| Lane | `22 slot + 14 gap + 265 text — identical to plan/outcome, so the two align` |
| Mark · correct | `ui/check · vb 24 · rendered 22 · stroke 2.18 → 2.00 · var(--color-icon)` |
| Mark · incorrect | `ui/cross · vb 24 · rendered 22 · stroke 2.18 → 2.00 · var(--color-icon) — SAME COLOUR` |
| Elevation | `none — a report card here would make the tutor a third party` |
| Findings cap | `4 max, one line each — beyond that it is a lesson, not feedback` |

### Full evaluation copy, verbatim

```
Selection
does this bit look right?
Almost. Two of the three parts are right.
The arrow starts at the origin
Both axes are labelled
(x, y) labels the tip, not the arrow
Move the label onto the arrow itself and it's exactly right.
```

---

## Unresolved block (1520 × 348 at y 2931)

| Property | Value |
| --- | --- |
| Frame | 1520 wide, `padding-block: 30`, `padding-inline: 36`, `gap: var(--spacing-3)` 12 |
| Radius | 20 |
| Fill | `var(--color-surface-screen)` `#F8F8F8` |
| Border | **`box-shadow: var(--color-divider) 0px 0px 0px 1px inset`** — a 1 px inset ring. Documentation affordance only; **there are no borders in the product.** |

Text widths: eyebrow 1448 (= 1520 − 72), paragraphs **1100**.

### Paragraph 1 — "Correctness has no colour", verbatim

> "Correctness has no colour, and this is the one place the system's own rules pull against the product. Foundations says pen colours belong to the drawing and take no part in the UI palette, and there is no semantic role in the token set, so a wrong answer and a right one are told apart here by a check and a cross in the same grey. That is legible, but it is the weakest signal on any of these boards, and it is carrying the most important meaning in a tutoring app. Either accept that findings are read, not scanned — the copy is doing the work and the marks only index it — or add exactly one semantic role and spend it here. Do not solve it by reaching for var(--color-pen-red): that would make the interface speak in the same colour the student draws in, on a screen where their drawing is the subject."

Type: `--font-sans` 17 / 26 · 400 · `var(--color-ink)`.

### Paragraph 2 — two things settled, verbatim

> "Two smaller things settled here rather than left open. Recovery chips take var(--color-icon) glyphs instead of var(--color-brand), following ui/selection-marker's precedent of one asset in two colour states — if that reads as a chip variant rather than a state, it needs a row on board 03. And the panel-scale message spec has been carried up to the 740 column for the first time (msg/tutor 21 / 30, msg/student bubble max-width 520, padding 16 / 24); board 03 only ever specced the 301 column, so the full-screen thread was undefined until now."

Type: `--font-sans` 15 / **23** · 400 · `var(--color-ink-secondary)`.

---

# New components introduced

| Component | Where used | Size(s) | Reusable by design? |
| --- | --- | --- | --- |
| **`btn/primary`** | 11 (no-key CTA, absolute at panel-local 18/860) · 12 (`plan/panel` tail) · 13 (`plan/full-screen` tail) | **301 × 58** panel (fill width, no padding) · **hug × 64** full-screen (`padding-inline: 32`, measured 220) | **Yes** — two named scales, brand fill + elevation 03 + `--radius-full` at both. Label 17 / 22 · 600 panel, 20 / 24 · 600 full-screen, `#FFFFFF`. |
| **`btn/destructive`** | 10 (Irreversible section only) | **hug × 56**, `padding-inline: 28` | **Yes**, but only one context exists. `--color-surface-bubble` fill, `--radius-full`, **no shadow**, label 17 / 22 · 500 · `--color-ink`. Carries **no danger colour**. |
| **`select/option`** | 10 (Tutor model ×3, Reasoning effort ×6) | **236 × 90** fixed, `padding-block 20 / padding-inline 22` | **Yes** — two states (`default` / `selected`) differing only in fill (`--color-surface` → `--color-brand-tint`). Radius 14, elevation 03 in both states. |
| **Numbered lane** (`plan/step` · `plan/outcome` · evaluation finding) | 12 · 13 · 14 | Panel: **22 slot + 14 gap + 265 text = 301**, slot height 25 · Full screen: **24 slot + 16 gap + 700 text = 740**, slot height 24 | **Yes — explicitly.** Board 14: *"identical to plan/outcome, so the two align."* One primitive, leading slot parameterised (digit `Text` or 22/24 px glyph). |
| **`state/thinking`** | 14 | Height **25** (one body line box), width auto; dots **6 × 6**, gap 8; optional status line 15 / 18 · 600 with 4 pt gap | **Yes** — one component, two variants (bare / with status line). |
| **`state/streaming`** | 14 | Caret **2 × 22**, gap **2** after the last glyph; the text itself is `msg/tutor` unchanged | **Yes** — caret is a decoration on `msg/tutor`, not a wrapper. |
| `plan/panel` | 12 | **301 × 605** | Layout, not a control. Seven-child column; port as a view, not a component. |
| `plan/full-screen` | 13 | **740 × 608** | As above, at the wider scale. |
| `state/error · network` / `· auth` | 14 | Specimen **301 × 151** / **301 × 176** | **One component, two configurations** — board 14: *"identical structure — only the copy and the glyph change."* |
| `state/evaluation` | 14 | Specimen **301 × 316** | Composite of reused parts + the numbered lane. |
| `field/key` | 10 | **740 × 80** | Not new — a re-skin of `Composer · wide`. |
| Panel controls · **with `btn/settings`** | 11 · 12 · 13 (and reduced to `btn/dock` only on 10) | 301 × 32 panel · 740 × 32 full screen | Existing component, **new third button and new `justify-content: space-between`**. |
| `btn/voice` **38** in the panel composer | 12 (and already on screen 08) | 38 × 38, glyph 20 × 20 | Not new to the file, but new relative to `03-chat-components.md §7.4`, which says voice is full-screen-only. |

---

# Four new icons

All four are read directly off the live nodes. Attributes are given exactly as authored; where a product node carries an **inline `strokeWidth` override**, both the markup value and the override are listed, and **the override is what renders**.

Effective rendered weight = `strokeWidth × (renderSize ÷ viewBoxSize)`; the set's target is **2.0**.

---

## `ui/check`

Correct-finding mark; also the bullet for `plan/outcome`.

| Property | Panel scale (12, 14) | Full-screen scale (13) |
| --- | --- | --- |
| viewBox | `0 0 24 24` | `0 0 24 24` |
| Render size | **22 × 22** | **24 × 24** |
| `stroke-width` | **2.18** | **2** |
| Effective weight | `2.18 × 22/24 =` **2.00** | `2 × 24/24 =` **2.00** |
| `stroke` | `var(--color-icon)` → `#55565A` | `var(--color-icon)` → `#55565A` |
| `fill` | `none` | `none` |
| `stroke-linecap` | `round` | `round` |
| `stroke-linejoin` | `round` | `round` |

**Paths — 1 path, complete:**

```svg
<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M4.8 12.6 9.8 17.6 19.2 6.9"
        fill="none"
        stroke="var(--color-icon)"
        stroke-width="2.18"
        stroke-linecap="round"
        stroke-linejoin="round" />
</svg>
```

Verbatim `d`: `M4.8 12.6 9.8 17.6 19.2 6.9`

No circles, rects, lines, dash arrays, or fills. No inline style override — the `2.18` / `2` difference is in the attribute itself, per render size.

---

## `ui/cross`

Incorrect-finding mark. **Same colour as `ui/check` — the shape is the entire signal.**

| Property | Value |
| --- | --- |
| viewBox | `0 0 24 24` |
| Render size | **22 × 22** (only size in the file) |
| `stroke-width` | **2.18** → effective `2.18 × 22/24 =` **2.00** |
| `stroke` | `var(--color-icon)` → `#55565A` |
| `fill` | `none` |
| `stroke-linecap` | `round` |
| `stroke-linejoin` | **not declared** (defaults to `miter`) |

**Paths — 1 path with two subpaths, complete:**

```svg
<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"
        fill="none"
        stroke="var(--color-icon)"
        stroke-width="2.18"
        stroke-linecap="round" />
</svg>
```

Verbatim `d`: `M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6`

Both strokes are drawn as **one path element with two `M` subpaths** — not two separate `<path>` elements. The cross is symmetric about (12, 12) with an 11.2 pt half-diagonal. No circles, rects, or lines.

---

## `ui/retry`

Network-error recovery glyph — an open circular arrow with an arrowhead at the top right.

| Property | Value |
| --- | --- |
| viewBox | `0 0 24 24` |
| Render size | **22 × 22** |
| `stroke-width` | **2.18** on both paths → effective `2.18 × 22/24 =` **2.00** |
| `stroke` | `var(--color-icon)` → `#55565A` |
| `fill` | `none` on both paths |

**Paths — 2 paths, complete:**

```svg
<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M20.4 12a8.4 8.4 0 1 1-2.46-5.94"
        fill="none"
        stroke="var(--color-icon)"
        stroke-width="2.18"
        stroke-linecap="round" />
  <path d="M20.6 3.4v4.9h-4.9"
        fill="none"
        stroke="var(--color-icon)"
        stroke-width="2.18"
        stroke-linecap="round"
        stroke-linejoin="round" />
</svg>
```

Verbatim `d` values:

1. `M20.4 12a8.4 8.4 0 1 1-2.46-5.94` — `stroke-linecap="round"`, **no `stroke-linejoin`**
2. `M20.6 3.4v4.9h-4.9` — `stroke-linecap="round"` **and** `stroke-linejoin="round"`

No circles, rects, or lines. Note path 1 is an arc (`a` command, large-arc-flag 1, sweep-flag 1) around an implied centre of (12, 12) with r = 8.4.

---

## `control/settings`

Two horizontal rules, each with a draggable knob — a "sliders" mark. Used as the third panel control on boards 11 / 12 / 13, and as the auth-error recovery glyph on board 14.

| Property | Panel control (11 · 12 · 13) | Auth-error chip (14) |
| --- | --- | --- |
| viewBox | `0 0 28 28` | `0 0 28 28` |
| Render size | **28 × 28** | **22 × 22** |
| `stroke-width` | **2** | **2.18** |
| Effective weight | `2 × 28/28 =` **2.00** ✔ | `2.18 × 22/28 =` **1.71** ⚠ (see Open questions) |
| `stroke` | `var(--color-icon)` → `#55565A` | `var(--color-icon)` → `#55565A` |
| `fill` | `none` on every element | `none` on every element |

**Elements — 2 paths + 2 circles, complete (panel-control instance shown; the chip instance is byte-identical apart from `width`/`height` and `stroke-width`):**

```svg
<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M4.4 10H13M21 10h2.6"
        fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round" />
  <circle cx="17" cy="10" r="3"
          fill="none" stroke="var(--color-icon)" stroke-width="2" />
  <path d="M4.4 18H7M15 18h8.6"
        fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linecap="round" />
  <circle cx="11" cy="18" r="3"
          fill="none" stroke="var(--color-icon)" stroke-width="2" />
</svg>
```

Verbatim `d` values:

1. `M4.4 10H13M21 10h2.6` — upper rule, split around the knob. `stroke-linecap="round"`, no linejoin.
2. `M4.4 18H7M15 18h8.6` — lower rule, split around the knob. `stroke-linecap="round"`, no linejoin.

Circles, verbatim and complete:

| # | `cx` | `cy` | `r` | `fill` | `stroke` | `stroke-width` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `17` | `10` | `3` | `none` | `var(--color-icon)` | `2` (panel) / `2.18` (chip) |
| 2 | `11` | `18` | `3` | `none` | `var(--color-icon)` | `2` (panel) / `2.18` (chip) |

**No rects, no lines, no dash arrays, no `stroke-linejoin` anywhere in this glyph.** Both rules leave a 4 pt clear gap either side of their knob (`13 → 21` around cx 17; `7 → 15` around cx 11), which is `r 3 + 1` of air.

---

## Icon summary

| Glyph | viewBox | Render | `stroke-width` | Effective | Elements | Colour binding |
| --- | --- | --- | --- | --- | --- | --- |
| `ui/check` | `0 0 24 24` | 22 · 24 | 2.18 · 2 | **2.00** · **2.00** | 1 path | `var(--color-icon)` |
| `ui/cross` | `0 0 24 24` | 22 | 2.18 | **2.00** | 1 path (2 subpaths) | `var(--color-icon)` |
| `ui/retry` | `0 0 24 24` | 22 | 2.18 | **2.00** | 2 paths | `var(--color-icon)` |
| `control/settings` | `0 0 28 28` | 28 · 22 | 2 · 2.18 | **2.00** · **1.71** | 2 paths + 2 circles | `var(--color-icon)` |

All four are **stroke-only, no fills, and all four bind `var(--color-icon)`** — none of them ever uses `var(--color-brand)`. This is the point board 14 is making: the new glyph set is deliberately colourless.

Per `04-icons.md`'s standing recommendation, a SwiftUI port should re-author `control/settings` onto a 24 grid (× 24/28 on every coordinate) and render every product glyph at 24 with a flat `stroke-width: 2` — which also removes the 1.71 anomaly.

---

# Values that are not tokens

The designer flagged six deliberately un-tokenised, component-internal values. **All six verified against the live nodes.**

| # | Value | Component | Verified? | Stated justification (from the boards) |
| --- | --- | --- | --- | --- |
| 1 | **Thinking dot 6 × 6** | `state/thinking` | ✔ Three `6 × 6` frames, `border-radius: var(--radius-full)`, fill `var(--color-icon)`, `gap: var(--spacing-2)` 8 | Spec row, verbatim: **`6 × 6 · radius-full · NO TOKEN — component-internal`**. Supporting row: `Fill: var(--color-icon) #55565A — a mark, not content`. The dot is smaller than any spacing step and exists only inside this indicator. |
| 2 | **Streaming caret 2 × 22, gap 2** | `state/streaming` | ✔ `2 × 22` frame, `--radius-full`, fill `var(--color-ink)`; parent row `gap: 2px`, `height: 25px` | Two spec rows, verbatim: **`2 × 22 · radius-full · var(--color-ink) · NO TOKEN — component-internal`** and **`2 after the last glyph — NO TOKEN, optical`**. The height *is* derived: **`22 = var(--leading-control), optically centred in the 25 line box`** — i.e. only the 2 pt width and the 2 pt gap are free values. |
| 3 | **`select/option` 236 × 90** | Board 10 | ✔ `width: 236px`, `height: 90px`, `flex-shrink: 0`, `padding-block: 20`, `padding-inline: 22` | No prose exists on board 10, so the justification is arithmetic and must be read off the layout: **236 is derived — `(740 − 16 × 2) ÷ 3 = 236`**, the only width that fits three options across the 740 column at a `--spacing-4` gap. **90 is free** and is what the 20 / 24 / 4 / 22 / 20 stack needs. The padding pair (20 / 22) is off-scale on the inline axis and has no token. |
| 4 | **`btn/destructive` height 56** | Board 10 | ✔ `height: 56px`, `padding-inline: 28`, no shadow | No prose. 56 is **not** a spacing step and does not match the 58 of `btn/primary` or the 62 of a chip — it is a third control height. `padding-inline: 28` equals `--space-edge`'s value but is written as a raw literal, so it is not a token reference. |
| 5 | **`btn/primary` 58 / 64** | Boards 11 · 12 · 13 | ✔ Panel `301 × 58`; full-screen `hug × 64`, `padding-inline: var(--spacing-8)` 32 | No prose, but **58 is derived**: it is exactly the panel composer's height (`03 §1.1`), so the button occupies the composer's slot when the composer is not there (board 11) or sits on the same rhythm when it is (board 12). **64 is free** — it is *not* the full-screen composer's 80, so the CTA is deliberately lighter than the input at that scale. |
| 6 | **Full-screen message spec — tutor 21 / 30, student bubble max-width 520, padding 16 / 24** | Board 13 `Thread · wide` | ✔ `msg/tutor` `--text-lead` 21 / `--leading-lead` 30; bubble `max-width: 520px`, `padding-block: 16px`, `padding-inline: 24px`; text 21 / 30 | Board 14 Unresolved, verbatim: **"the panel-scale message spec has been carried up to the 740 column for the first time (msg/tutor 21 / 30, msg/student bubble max-width 520, padding 16 / 24); board 03 only ever specced the 301 column, so the full-screen thread was undefined until now."** 21 / 30 are existing tokens (`--text-lead` / `--leading-lead`); **520, 16 and 24 are the free values** — 520 ≈ 70 % of 740, the same ratio the panel's 224 has to 301 (74 %). |

## Additional un-tokenised values found on these boards (not on the designer's list)

| Value | Where | Note |
| --- | --- | --- |
| `select/option` `padding-block: 20` / `padding-inline: 22` | 10 | 22 is off the 4 px scale. |
| `field/key` text colour `--color-ink` at 21 / 30 | 10 | The one place `--text-lead` is used for a *filled* value rather than a placeholder. |
| Numbered-lane slot `22 × 25` (panel) and gap `14` | 12 · 14 | 14 already exists un-tokenised as the panel-controls gap and the chip icon→label gap. |
| Numbered-lane slot `24 × 24` and gap `16` (full screen) | 13 | 16 = `--spacing-4`, used by name. |
| Recovery chip glyph stroke `2.18` | 14 | Prescribed by `04-icons.md`, not free. |
| `btn/primary` label colour `#FFFFFF` literal | 11 · 12 · 13 | `--color-surface` resolves to the same hex; the design writes the literal. |
| Board-14 documentation stage `radius 20`, `padding 44`, row gap `48`, section gap `36` | 14 | Documentation chrome; never ships. |

---

# Open questions

## 1. Correctness has no colour — the designer's own open question

**Transcribed in full, verbatim, from the board's `UNRESOLVED — DECIDE BEFORE BUILD` block:**

> "Correctness has no colour, and this is the one place the system's own rules pull against the product. Foundations says pen colours belong to the drawing and take no part in the UI palette, and there is no semantic role in the token set, so a wrong answer and a right one are told apart here by a check and a cross in the same grey. That is legible, but it is the weakest signal on any of these boards, and it is carrying the most important meaning in a tutoring app. Either accept that findings are read, not scanned — the copy is doing the work and the marks only index it — or add exactly one semantic role and spend it here. Do not solve it by reaching for var(--color-pen-red): that would make the interface speak in the same colour the student draws in, on a screen where their drawing is the subject."

**The board's recommendation, restated:** it offers exactly **two** acceptable resolutions and one prohibition.

- **Option A — accept it.** Findings are *read*, not scanned; the copy carries the meaning and `ui/check` / `ui/cross` merely index the lines. Ship as drawn: both marks in `var(--color-icon)` `#55565A`.
- **Option B — add exactly one semantic role** to the token set and spend it here, and nowhere else.
- **Prohibited either way:** reusing `var(--color-pen-red)` `#E33E38`. The stated reason is that it would make the interface speak in the same colour the student draws in, on a screen where the drawing is the subject. (This is consistent with `01 §7` rule 3, "pen colours are not UI colours".)

**Corroborating evidence that Option A is the current state of the file:** the `state/evaluation` spec row for the incorrect mark ends in the shouted annotation **`— SAME COLOUR`**, and the board header says *"There is no semantic colour anywhere in this system, so correctness is carried by glyph shape, not by red and green."* The design as drawn is Option A; the question is whether that survives contact with users.

**Extension the boards do not address:** `btn/destructive` on board 10 has the same problem in a more dangerous place. "Remove API key" and "Reset this session" are irreversible and are rendered as neutral `#F2F2F6` pills. If a semantic role is added under Option B, decide at the same time whether it also applies there.

## 2. `control/settings` renders at 1.71, below the 2.0 target

The auth-error recovery chip renders `control/settings` at **22 on a 28 viewBox with `stroke-width: 2.18`** → **1.71 effective**, against the set's 2.0 target. Note the board's own spec row for that glyph reads `control/settings · vb 28 · rendered 22 · stroke 2.18 · var(--color-icon)` — it **omits the `→ 2.00`** that the `ui/retry`, `ui/check` and `ui/cross` rows all carry, which suggests the value was copied from the 24-viewBox glyphs without re-deriving. To render 2.0 at 22 on a 28 viewBox the attribute must be **2.545**. Adopting `04-icons.md`'s standing recommendation (re-author onto a 24 grid, render at 24, flat `stroke-width: 2`) removes the problem entirely.

## 3. Board 12's thread is 786, not 810 — and gains a 24 pt gap

Screen 08: `Thread` 301 × **810** at panel-local y 50, `padding-bottom: 18`, abutting the composer at 860.
Board 12: `Thread` 301 × **786** at panel-local y 50, **no padding**, leaving a **24 pt gap** before the composer at 860.

Both close the panel's 936 arithmetic, so neither is broken, but they are not the same layout and a single `TutorPanel` view cannot produce both. Board 13 uses the same 24 pt gap (`Thread · wide` 100 → 900, composer at 924). **Recommendation: adopt the boards-12/13 rule — thread height = available space − 24 − composer height, no bottom padding** — and treat screen 08's `810 + padding-bottom: 18` as the older construction. Worth confirming with the designer.

## 4. Board 12's plain composer shows the marquee icon in brand violet

`03 §1.2` documents a real state change: the marquee icon is `var(--color-icon)` grey in the **plain** composer and `#6051DC` violet in the **with-attached-selection** composer. Board 12 has **no attachment card**, yet its marquee icon is bound to `var(--color-brand)`. `05-screens.md` records the same thing on screen 08 and calls it deliberate ("a persistent affordance, not a state indicator"). So the file now contains two mutually exclusive readings of the same glyph. **Decide which is true before building**, because one of them makes the icon a state and the other makes it a button.

## 5. `03 §7.4`'s "voice is full-screen only" is stale

Board 12's panel composer contains `btn/voice` **38 × 38** (glyph 20 × 20, `stroke-width 2.4` → 2.00), exactly as `05-screens.md` records for screen 08 and as `04-icons.md` lists under `composer/voice · in-conversation panel`. The `UNRESOLVED — DECIDE BEFORE BUILD` note in `03-chat-components.md §7.4` — "dictation silently disappears when the tutor is not full-screen" — **is no longer true of the file**. The asymmetry that survives is only that the *panel greeting* state (board 05) has no voice button while the *in-conversation* panel does. Update board 03 or drop the note.

## 6. Tool rail — RESOLVED, and this section previously had it backwards

~~Boards 11 / 12 have drifted from a canonical 617.~~ **They have not. 627.5 is canonical and
617 is the corrupted state.** Corrected 2026-08-06 after cross-checking four independent
measurements; the original claim here was inherited from board 09 and is wrong.

The evidence, in order of authority:

1. **Board 02 says so in its own words**, in a note it marks RESOLVED:
   > "was snapped to 617 during authoring (gap 12 + margin-top 8/16/8, Tools gap 0, divider 1)
   > and reverted to 627.5. Cause: `duplicate_nodes` quantises off-scale values to the 4px
   > scale and rewrites the SOURCE node, not just the clone. **A future export reading 617 is
   > this regression, not a redesign.**"
2. **All four live screens measure 627.5** — 05, 06 and 08 verified individually by node, not
   by tree summary (tree summaries round to 628).
3. **Board 09's own numbers do not sum to 617.** Its parts total 593. It is internally
   inconsistent, which is what a stale transcription looks like.
4. Boards 11 / 12 were built by copying the live screens, so they inherited the correct value.

| | Live screens 05 / 06 / 08 · boards 11 / 12 | Board 09's stale table |
| --- | --- | --- |
| Container gap | 0 (steps are per-child `margin-top`) | `gap: 12` |
| Tools stack gap | **3.5** | 0 |
| Divider height | **1.5** | 1 |
| Swatches gap | 27 | 27 |
| Total height | **627.5** | 617 (does not sum) |

**The 54pt pitch is not broken by the 3.5 gap.** The pitch the design talks about is the
*swatch* column — 27pt circles on a 27pt gap, giving a 54pt tap target around a 27pt dot. The
tool slots are already 54 × 54 each; the 3.5 between them is separation, not pitch.

**Build the rail at 627.5.** `01 §8.1` recommends the opposite and is superseded by this note.

## 7. `state/thinking` and the 46 pt `btn/orb` both claim the thinking role

`05-screens.md` documents `btn/orb` (46 × 46) as the thinking indicator at the tail of screen 08's thread. Board 14 introduces `state/thinking` — a 25 pt-tall, width-auto three-dot mark — for the same moment, with a spec row that says the growing text *is* the message and a rationale built entirely around zero layout shift. **The two cannot both be the thinking state.** Nothing on board 14 mentions the orb. Likely intent: the orb is the *presence* mark (it appears in the greeting and the collapsed dock) and the dots are the *working* mark, but this is inference. Ask.

## 8. Board 10's section rhythm breaks on the last gap

Blocks are separated by 48 / 48 / 48 / **44**. Every other value on the board is a clean multiple of 4 and the first three gaps agree, so the 44 reads as an off-by-4 rather than a decision. Content also stops at y 962 with 42 pt of unused safe band below it, so there is no packing pressure forcing the tighter gap. **Recommend 48 throughout** unless the designer says otherwise.

## 9. The API-key privacy sentence is stated two different ways

- Board 11: *"It is kept in this device's Keychain and never leaves it."*
- Board 10: *"Kept in this device's Keychain. It is sent to OpenAI and nowhere else."*

The board-10 sentence is accurate; the board-11 sentence is not — the key necessarily leaves the device on every request. This is a copy correctness issue, not a design one, but it should be fixed before the first-run screen ships.

## 10. States that are still undrawn

Nothing in the file specifies:

- pressed / disabled / loading for `btn/primary`, `btn/destructive` or `select/option`;
- a confirmation step for either destructive action ("cannot be undone" is asserted, but no dialog exists — and `01 §7` bars borders and this system has no modal pattern at all);
- focused / empty / invalid states for `field/key`;
- what board 11's screen looks like *after* `Add your API key` is tapped (no key-entry surface exists — board 10's `field/key` is shown already filled);
- a full-screen variant of `state/thinking`, `state/streaming`, either error state, or `state/evaluation` — board 14 draws every specimen at the 301 column only, even though board 13 has now defined a 740 thread;
- how a `plan/*` block behaves once it has scrolled up and a new exchange follows it (it is a flow child of the thread, so presumably it just scrolls, but nothing says whether it stays interactive).
