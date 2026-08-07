# 06 — States & Settings

Code-ready transcription of the five boards added to **"AI Whiteboard Tutor — Design System, Components & Page"** after the original nine:

- **10 — Settings** (1376 × 1032)
- **11 — First run · no API key** (1376 × 1032) — **deleted 2026-08-08**
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
2. [Board 11 — First run · no API key](#board-11--first-run--no-api-key) *(deleted)*
3. [Board 12 — Session plan · panel](#board-12--session-plan--panel)
4. [Board 13 — Session plan · full screen](#board-13--session-plan--full-screen)
5. [Board 14 — Components · Tutor states](#board-14--components--tutor-states)
6. [New components introduced](#new-components-introduced)
7. [Five new icons](#five-new-icons)
8. [Values that are not tokens](#values-that-are-not-tokens)
9. [Open questions](#open-questions)

---

# Board 10 — Settings

> **Rewritten.** This section used to describe a full-screen page and opened by insisting the
> board *"is **not a modal and not a sheet**"*. It is a modal now. What survives that reversal
> is the reason behind it: a sheet was rejected because *"a sheet is a card with an edge"* and
> the product separates by elevation, never by stroke. **The window has no edge either** — it
> is `--color-surface` on `--radius-3xl`, lifted by a new elevation level and nothing else. The
> old region map, `select/option`, and the `Irreversible` section are gone; the paragraphs
> below replace them. Ported in `MathTutor/Features/Settings/`.

## Purpose / app state

The settings surface, drawn **over** the board rather than in place of it. Screen 05 stays
behind, blurred and whitened, so the student can see the work they are leaving. Reached from
`btn/settings` — in the panel controls on boards 11 / 12, and alone in the screen's top-right
corner on boards 07 and 13 — and from the auth-error recovery chip on board 14 ("Open
Settings" → *"the API key pane, field focused"*, a destination that no longer exists — see
board 14).

Dismissed by the close control in the sidebar, or by tapping the backdrop. There is no
drag-to-dismiss: the window is not a sheet and has no grabber to suggest one.

## Backdrop

| Property | Value |
| --- | --- |
| Content | Screen 05, unmodified — rail, board, tutor panel |
| Blur | `filter: blur(2px)` — **CSS blur is the full width of the Gaussian; a SwiftUI port halves it to `1`**, the same conversion `box-shadow` needs |
| Scrim | `#FFFFFF66` — white at 0.4 over the blur, full bleed |

**White, not ink**, and this is the one value here most likely to be "corrected" back. A dark
scrim was drawn first and turned the board and panel into a single grey field; whitening keeps
the rail's pen colours and the ink legible as *your work, still there*, which is the entire
argument for not covering the screen.

## The window

| Property | Value |
| --- | --- |
| Size | **760 × 520** — both free values, sized to content |
| Position | **(308, 256)** = `(1376 − 760) ÷ 2` and `28 + (976 − 520) ÷ 2`. Centred in the safe width and in the content band; a port derives these rather than transcribing them |
| Radius | `var(--radius-3xl)` 28 — the two big surfaces' radius, and at 760 × 520 this is larger than either |
| Fill | `var(--color-surface)` `#FFFFFF` |
| Elevation | **04 · Modal** — `#14143216 0 16 40 + #1414320E 0 4 12`. New level; see `01-foundations.md §5.1a` |
| Layout | `display: flex`, `overflow: clip` |

`overflow: clip` is load-bearing rather than defensive: the sidebar paints a square block, so
without it the sidebar's corners sit outside the window's radius.

## Sidebar (216 × full height)

| Property | Value |
| --- | --- |
| Width | **216**, `flex-shrink: 0` |
| Fill | `var(--color-surface-panel)` `#FCFCFC` |
| Border | `border-right: 1px solid var(--color-divider)` — **inside** the 216, `border-box`. The one stroke in the window, and the sanctioned one: `--color-divider` is *"hairline rules inside a surface"* |
| Padding | `20` block, `16` inline |
| Gap | `24` (`--space-gap`) between the close control and the nav |

Children, in order:

- **`btn/close`** — 36 × 36, no fill, no radius, the same nothing `btn/dock` is drawn with.
  Glyph `ui/cross` at 22. **A port must give it a 44pt tap target**; a bare glyph hands the
  button an 11.2-of-24 hit area.
- **Nav** — `flex-column`, `gap: 2` (off-scale and deliberate: the items are 44pt targets and
  a token gap would open a dead lane between them).

### `nav/item` — NEW component

| Property | Value |
| --- | --- |
| Size | 184 × 44 (`216 − 16 × 2`), fills the column |
| Padding | `padding-inline: 12` |
| Radius | `var(--radius-lg)` 14 |
| Fill · selected | `var(--color-brand-tint)` `#E6E3F9` |
| Fill · default | none |
| Label · selected | `--text-label` 15 / 18 · **600** · `var(--color-ink)` |
| Label · default | 15 / 18 · **500** · `var(--color-ink-secondary)` |

The fill and radius are the rail's selected tool slot, applied to a different kind of slot —
not a fourth spend of the brand colour. Unlike the retired `select/option`, **the label changes
with the state too**: a nav item is read one at a time down a column, and three identically
styled labels with a rectangle behind one of them does not read as a selection.

**A port must make the whole 184 × 44 hit-testable.** A `.clear` fill is not tappable, so the
default items otherwise collapse to the width of their text.

Three items, and they are the four old sections re-cut: **Tutor** (the two pickers), **API
key** (the field and its removal), **Session** (the reset). `Irreversible` does not survive as
a group — removing a key belongs to owning a key, resetting belongs to owning a session — and
its shared caption is restated in each pane's own lede, in that pane's terms.

## Pane (544 × full height)

`544 = 760 − 216`; padding 32 on all sides, so the **measure is 480** and nothing inside
carries a width of its own.

### Header — pinned, not hugged

| Child | Value |
| --- | --- |
| Title | `--text-title` 26 / 34 · 600 · `--tracking-tight` · `--color-ink` |
| Gap | 10 |
| Lede | `--text-label` 15 / **`--leading-control` 22** · 400 · `--color-ink-secondary` |
| Padding-bottom | 28 |

`34 + 10 + 22 × 2 + 28 = **116**`, **fixed**. Every lede is written to two lines at the 480
measure, but the API-key one is short — left to hug, the rule under the header would jump 22pt
between panes and the window would read as three different windows.

15 in the *control* line box, not the label's 18: this is the only paragraph in the window that
wraps, and 18 sets two lines of 15pt copy tighter than the face draws them.

### `row/setting` — NEW component

| Property | Value |
| --- | --- |
| Size | 480 × **120**, rule above each row |
| Rule | `1px var(--color-divider)` on the **top** edge, so the first row's rule doubles as the header's |
| Label | `--text-body` 17 / 22 · **600** · `--color-ink` |
| Caption | `--text-label` 15 / 18 · 400 · `--color-ink-secondary`, `margin-top: 4` |
| Value | `--text-body` 17 / 22 · **500** · `--color-ink` |
| Chevron | `ui/chevron-down` at 16, in a **fixed 20pt slot**, `flex-shrink: 0` |

The label is the question and the value the answer, which is why the value sits a weight below
it. The chevron's slot is fixed and not a gap: values are different widths, and a gap would put
each row's mark in a different column.

`22 + 4 + 18 = 44` of content in a 120 box — the rest is air, split by the centring.

**The design does not draw the open state.** Board 10 shows `Luna ▾` and stops, so the picker
itself is the platform's; inventing a bespoke popover would introduce the container type the
original board 10 rejected sheets for. The trade is real and worth stating: the six effort
captions ("Fastest replies", "Deep reasoning", …) are no longer on the screen.

### `field/key` — **deleted 2026-08-08**

Deleted from the board and from the port, along with the whole **API key** pane it was the
content of. The app holds no OpenAI key — the backend does — and the backend's address is a
constant in `BackendConfiguration`, not something a student sets. So there is no credential
for this field to hold and no server for a second field to name: the window is Tutor and
Session, and nothing in the product asks about a deployment.

Two consequences worth recording, because they were the interesting parts of the component:

- **`--font-mono` is documentation-only again.** The masked key was the single case that
  overturned Typography's rule that the mono face *"must never reach a screen"* — a run of 24
  identical bullets is unreadable at a proportional pitch. Nothing on a screen sets mono now,
  so the original rule holds with nothing exempted from it. `01-foundations.md`'s font table
  is updated to match.
- **The brand budget went back where it came from.** `Replace` had inherited the allowance
  `btn/send`'s violet disc held; with the field gone the spend simply disappears rather than
  moving somewhere else, so the three sanctioned brand uses are unchanged.

### `btn/destructive` — one context, not two

| | was | now |
| --- | --- | --- |
| Height | 56 | **44** |
| Padding-inline | 28 | **20** |
| Radius | `--radius-full` | `var(--radius-lg)` 14 |
| Fill | `--color-surface-bubble`, **no shadow** | **`--color-surface`, elevation 03** |
| Label | 17 / 22 · 500 | 15 / 18 · 600 · `--color-ink` |

Only `Reset this session` remains; `Remove API key` went with the pane it lived in.

**This is a loss and should be recorded as one.** The old rule was that everything safe is
lifted off the surface and the things that destroy are the only things that sit *in* it — a
flat grey pill meant "this one is different" without spending a colour. Beside a 56pt white
field, that pill was the loudest object in the pane rather than the most careful one, so it was
matched to the field and the shape signal is gone with nothing in its place. The field it was
matched to is now deleted, so the button's 44 / 20 / `--radius-lg` geometry is inherited from
a component that no longer exists — worth revisiting if the Session pane is ever redesigned.

The warning now rests entirely on the pane's lede, which is what the `Irreversible` heading and
caption used to do — *"the entire destructive signal is carried by the section heading and the
caption"* — but with no help. The button still spends **no colour**; `--color-incorrect` says
*"NOT for destructive, warning or validation UI."* Strengthening the signal is a design
decision, not a code one.

There is still **no confirmation dialog**: *"'cannot be undone' is asserted, but no dialog
exists."* That used to also be a statement about the system's limits, because there was no
modal pattern to put one in. There is one now — this window — and whether an irreversible
action deserves a second one on top of it is a question the design has not been asked.

## All literal copy on board 10

```
Tutor
Session
Tutor
How the tutor thinks and speaks. Changes apply to your next message; the conversation so far is left alone.
Tutor model
Which route answers you
Luna
Reasoning effort
How long it thinks before replying
High
Session
Resetting clears the conversation and the goal it was working towards. It does not touch your board or its ink.
Reset this session
```

Six strings were removed with the API key pane on 2026-08-08: the nav item and heading
`API key`, the lede *"Kept in this device's Keychain. It is sent to OpenAI and nowhere else."*,
the masked literal `sk-proj-••••••••••••••••••••••••7Q4F`, `Replace`, and `Remove API key`.
Nothing replaced them — the pane is gone rather than reworded.

The model and effort names (Sol / Terra / Luna, None → Max) and their captions still exist in
`SettingsOption`; they now appear in the picker rather than on the board.

There is **no designer prose written on board 10** — it is a pure screen board, like 05–08.

## Board 10b — Settings · Session pane

A companion artboard holding the **Session** pane at the same 760 × 520, so the destructive
button stays specified. Not a screen; it has no backdrop. It held the **API key** pane as well
until that pane was deleted, which is why its name lost the plural.

---

# Board 11 — First run · no API key

## Purpose / app state

> **Deleted 2026-08-08 — the board is gone from the Paper file and the state is gone from the
> app.** The condition it drew no longer exists: the app holds no OpenAI key, the backend does,
> and the backend's address is a constant rather than a setting. There is no credential a
> student could supply, so "not set up yet" is not a state the panel can be in — it either
> reaches its tutor or a turn fails, and a failed turn is board 14's thread failure, not a
> screen of its own. `NoAPIKeyState.swift` was deleted with it.
>
> The section is kept as a record, and two things in it outlived the board: **`btn/primary`**
> below, which boards 12 and 13 use for the plan's tail, and the **tool rail geometry** measured
> here, which [Open questions](#open-questions) still refers to. Everything else describes a
> screen that no longer exists.

Cold start: the app has launched, the board and rail are fully live and drawable, but the tutor cannot think because no OpenAI key is stored. **The tutor panel is the only thing in a special state** — the shell is untouched, so the student can draw immediately and is not blocked by a modal.

Board 14 explicitly distinguished this from the auth error: *"board 11 no-key state — that is onboarding, this is a broken key."* With onboarding deleted, only the failure remains.

## Screen frame

| Property | Value |
| --- | --- |
| Size | 1376 × 1032 |
| Background | `var(--color-surface-screen)` `#F8F8F8` |

## Region map

| Region | x | y | w | h | Reuse |
| --- | --- | --- | --- | --- | --- |
| Status bar | 0 | 16 | 1376 | 24 | **Reused from 05** verbatim |
| Whiteboard canvas | 124 | 28 | 863 | 976 | **Reused from 05** — `--radius-3xl` 28, `overflow: clip`, fill `--color-surface-canvas`, elevation **01 Canvas** `#14143209 0px 2px 6px`. Contains only the dot grid — **no ink**. |
| Tool rail | 28 | 28 | 72 | **628** | **Reused from screen 08's rail**, not screen 05's — see note below |
| Tutor chat panel | 1011 | 28 | 337 | 976 | **Reused from 05 / `02 §5`** — `--radius-3xl` 28, fill `--color-surface-panel`, elevation **02 Panel**, `padding-top: 18`, `flex column`, `align-items: center` |

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

Flow arithmetic: `18 (padding-top) + 32 + 248 (orb margin-top) + 90 + 40 (--spacing-10) + 156 = 584`. The button is then **absolutely positioned** at local y 900, so `900 + 58 + 18 = 976` ✔ — i.e. the primary button is bottom-anchored with the standard 18 pt panel inset, exactly where the composer sits on screens 05 / 08.

The orb's x of **120.5** is `(337 − 96) ÷ 2` — a consequence of centre alignment, not a designed half-pixel. In SwiftUI, centre it; do not hard-code 120.5.

### Panel controls — expanded variant (**`btn/settings` is new here**)

| Property | Value |
| --- | --- |
| Frame | 301 × 32 at panel-local (18, 18), `display: flex`, `align-items: center`, **`justify-content: space-between`** |
| Left group `Layout controls` | 78 × 32, `display: flex`, `align-items: center`, `gap: 14` → `btn/dock` (32) + 14 + `btn/full-screen` (32) = 78 |
| Right | **`btn/settings`** 32 × 32 |

`btn/dock` and `btn/full-screen` are **reused unchanged from `02 §6`** (28 × 28 glyph on viewBox `0 0 28 28`, `stroke var(--color-icon)`, markup 2.1 → inline override 2). **`btn/settings` is new**: same 32 × 32 bare button, same 28 × 28 icon slot, new glyph `control/settings` (see [Five new icons](#five-new-icons)), `stroke-width 2` → 2.00 rendered.

**The row's layout changes from `justify-content: flex-start` (boards 05 / 08) to `space-between`.** This is a real change to a documented component, not just an addition.

### Orb — reused, `panel` size

Exactly the `panel` variant from `02 §11`: frame 96 × 90; halo 190 × 180 at `left −47, top −49` with alphas 75 % / 70 % and third ellipse `27% 26%`; body 54 × 42, `gap: 18`, `padding-top: 5`, `--radius-full`, the standard three-stop oklab body gradient; two 7 × 7 `#FFFFFF` eyes; **no mouth**. Elevation none.

### `No-key state` — block (301 × 156), **deleted 2026-08-08**

Specified below as a record only. Nothing renders it.

`display: flex`, `flex-direction: column`, `align-items: center`, width 301.

| Child | Width | Type | Spacing |
| --- | --- | --- | --- |
| Title | **301** | `--text-title` 26 / `--leading-title` 34 · 600 · `--tracking-tight` · `var(--color-ink)`, `text-align: center` | — |
| Body | **277** | `--text-body` 17 / **`--leading-snug` 24** · 400 · `var(--color-ink-secondary)`, `text-align: center` | `margin-top: var(--spacing-3)` 12 |
| Pointer | **277** | `--text-label` 15 / `--leading-label` 18 · 400 · `var(--color-ink-secondary)`, `text-align: center` | `margin-top: var(--spacing-5)` 20 |

Arithmetic: `34 + 12 + 72 (3 × 24) + 20 + 18 = 156` ✔

The **277** measure (= 301 − 24) is the same narrowed measure the panel greeting on board 05 uses; the 17 / 24 pairing is the "short and centred" leading from `01 §2.4`, not the 17 / 25 of running message text.

No fill, no radius, no shadow — text sitting directly on the panel, per the "the tutor is the voice of the panel" rule.

## `btn/primary` — NEW component (panel variant) — **survives board 11's deletion**

Introduced here and still in the product: boards 12 and 13 use it for the plan's tail. Its
panel height came down **58 → 50** with the composer pill (see `03-chat-components.md`), and it
is still derived from the composer rather than set independently — that derivation is the whole
point of the number, and it outlived the slot-sharing it was originally justified by.

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

## All literal copy on board 11 — **deleted 2026-08-08**

Four strings, none of them replaced:

```
One thing before we start
I need an OpenAI API key to think with. It is kept in this device's Keychain and never leaves it.
Get one at platform.openai.com
Add your API key
```

This is where the copy-correctness defect `Open questions 9` raised finally lands: the key's
storage promise was stated twice, once here in first person ("kept in this device's Keychain and
never leaves it") and once on board 10 in third person ("Kept in this device's Keychain. It is
sent to OpenAI and nowhere else."). The two sentences were **not** identical and the first was
false. Both are now deleted along with the key itself, so the defect is resolved by removal
rather than by choosing a wording.

There was **no designer prose written on board 11**.

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
| Whiteboard canvas | 124 | 28 | 863 | 976 | **Reused from 05** — elevation 01, `--color-surface-canvas`, radius 28, `overflow: clip` |
| ↳ Handwritten ink | 281 | 215 | 548 | 641 | canvas-local (157, 147) — **the same ink asset and position as screens 05 / 08** |
| Tool rail | 28 | 28 | 72 | 628 | **Identical to board 11** (see that section — the board is deleted, the measurement is kept) |
| Tutor chat panel | 1011 | 28 | 337 | 976 | **Reused from 05** |

## Tutor panel internals

| # | Child | Panel-local x, y | Size | Absolute x, y |
| --- | --- | --- | --- | --- |
| 1 | `Panel controls` | 18, 18 | 301 × 32 | 1029, 86 |
| 2 | `Thread` | 18, 50 | 301 × **786** | 1029, 118 |
| 3 | `Composer` | 18, 860 | 301 × 58 | 1029, 928 |

`18 + 32 + 826 + 24 + 58 + 18 = 976` — note the **24 pt gap between the thread's bottom (local 876) and the composer (local 900)**. Screen 08's thread is 850 and abuts the composer directly. See [Open questions](#open-questions).

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

### `btn/primary` — panel variant, introduced on board 11 (which is deleted; the component is not)

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
| Board peek | 0 | 28 | 68 | 976 | **Reused from 07 / `02 §10`** verbatim, faked shadow and all |
| Panel controls | 352 | 28 | **996** | 32 | **settings-only variant**, `justify-content: flex-end` — see below |
| Thread · wide | 352 | **100** | 740 | **800** | new width, see below |
| Composer · wide | 352 | 924 | 740 | 80 | **Reused from `03 §1.3` / board 07** unchanged |

Column x 352 → 1092, width 740, centred past the peek exactly as board 07: `68 + (1376 − 68 − 740) ÷ 2 = 352`.

**Vertical stack:** controls `68 → 100` · thread `100 → 900` · **24 pt gap** · composer `924 → 1004`. The composer's bottom lands on 1004 = the safe-band bottom, identical to board 07.

There is **no tool rail and no whiteboard canvas** on this board — only the peek, as on board 07.

### Panel controls — settings-only variant (changed 2026-08-07)

**996 × 32 at (352, 28)**, `display: flex`, `align-items: center`, **`justify-content: flex-end`**. One child: **`btn/settings`** 32 × 32, glyph `control/settings` 28 × 28, `stroke-width 2`.

`Layout controls` — `btn/dock` + `btn/full-screen` — **is gone from this board.** Neither had work to do here: the board peek on the left edge is already the way back to the board, and `btn/full-screen` was a control for the state you are already in. Boards 11 and 12 keep both, because the docked panel has no peek and no other route to either state.

**The row is 996 wide, not 740, and that is the whole point of the change.** It runs from the reading column's left edge to `1348` — the screen's own `--space-edge` lane, the same line the docked panel's right edge lands on — so `flex-end` puts the gear at **x 1316** in the screen's top-right corner rather than at x 1060, 224 pt short of it in the middle of the white.

The 32 pt band survives the row losing two of its three children: it is what holds the thread's top at `y = 100`, and without it the thread would scroll its oldest message under the gear.

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
| Glyph | `control/settings · vb 28 · rendered 22 · stroke 2.55 → 2.00 · var(--color-icon)` |
| Destination | ~~`board 10 — Settings, OpenAI API key section, field focused`~~ — **stale.** There is no key pane to open. What an auth failure should offer instead is undecided; see [Open questions](#open-questions). |
| Copy rule | `name who refused, never "an error occurred" — the tutor is not a system` |
| Distinct from | ~~`board 11 no-key state — that is onboarding, this is a broken key`~~ — onboarding is deleted, so this is the only credential failure left |

**This row used to read `stroke 2.18` and to be the one glyph row on this board missing the `→ 2.00` its three siblings carry** — `2.18 × 22 ÷ 28 = 1.71`, below the target. Corrected on 2026-08-07 when the glyph was redrawn as a cog; `2.545` is what renders 2.0 at that size.

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
| **`btn/primary`** | ~~11 (no-key CTA)~~ · 12 (`plan/panel` tail) · 13 (`plan/full-screen` tail) | **301 × 58** panel (fill width, no padding) · **hug × 64** full-screen (`padding-inline: 32`, measured 220) | **Yes** — two named scales, brand fill + elevation 03 + `--radius-full` at both. Label 17 / 22 · 600 panel, 20 / 24 · 600 full-screen, `#FFFFFF`. |
| **`btn/destructive`** | 10 (Session pane only, since the API key pane was deleted) | **hug × 44**, `padding-inline: 20` | **Yes**, and it now has two contexts. `--color-surface` fill, `var(--radius-lg)` 14, **elevation 03**, label 15 / 18 · 600 · `--color-ink`. Still carries **no danger colour** — but the flat-and-unlifted shape that used to *be* the danger signal is gone; see the board 10 section. |
| ~~**`select/option`**~~ | — | — | **Retired with the old board 10** and deleted from the port rather than left unused. Its selection rule survives in `nav/item`: same `--radius-lg` 14, same `--color-brand-tint`. |
| **`nav/item`** | 10 (sidebar ×3) | **184 × 44**, `padding-inline: 12` | **Yes.** Radius 14; selected = `--color-brand-tint` + label 15 / 18 · 600 · `--color-ink`; default = no fill + 15 / 18 · 500 · `--color-ink-secondary`. Unlike `select/option`, the label changes with the state. |
| **`row/setting`** | 10 (Tutor pane ×2) | **measure × 120**, rule on the top edge | **Yes.** Label 17 / 22 · 600 over caption 15 / 18 · 400; trailing value 17 / 22 · 500 plus `ui/chevron-down` 16 in a **fixed 20pt slot**. The slot is what keeps the marks in one lane. |
| **Numbered lane** (`plan/step` · `plan/outcome` · evaluation finding) | 12 · 13 · 14 | Panel: **22 slot + 14 gap + 265 text = 301**, slot height 25 · Full screen: **24 slot + 16 gap + 700 text = 740**, slot height 24 | **Yes — explicitly.** Board 14: *"identical to plan/outcome, so the two align."* One primitive, leading slot parameterised (digit `Text` or 22/24 px glyph). |
| **`state/thinking`** | 14 | Height **25** (one body line box), width auto; dots **6 × 6**, gap 8; optional status line 15 / 18 · 600 with 4 pt gap | **Yes** — one component, two variants (bare / with status line). |
| **`state/streaming`** | 14 | Caret **2 × 22**, gap **2** after the last glyph; the text itself is `msg/tutor` unchanged | **Yes** — caret is a decoration on `msg/tutor`, not a wrapper. |
| `plan/panel` | 12 | **301 × 605** | Layout, not a control. Seven-child column; port as a view, not a component. |
| `plan/full-screen` | 13 | **740 × 608** | As above, at the wider scale. |
| `state/error · network` / `· auth` | 14 | Specimen **301 × 151** / **301 × 176** | **One component, two configurations** — board 14: *"identical structure — only the copy and the glyph change."* |
| `state/evaluation` | 14 | Specimen **301 × 316** | Composite of reused parts + the numbered lane. |
| `field/key` | 10 | **740 × 80** | Not new — a re-skin of `Composer · wide`. |
| Panel controls · **with `btn/settings`** | 11 · 12 (reduced to `btn/dock` only on 10, to `btn/settings` only on 13) | 301 × 32 panel · 996 × 32 on 13 | Existing component, **new third button and new `justify-content: space-between`**. Its membership is now the variable: three buttons docked, one on 10, one on 13. |
| `btn/voice` **38** in the panel composer | 12 (and already on screen 08) | 38 × 38, glyph 20 × 20 | Not new to the file, but new relative to `03-chat-components.md §7.4`, which says voice is full-screen-only. |

---

# Five new icons

All five are read directly off the live nodes. Attributes are given exactly as authored; where a product node carries an **inline `strokeWidth` override**, both the markup value and the override are listed, and **the override is what renders**.

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

A six-tooth cog around an open centre. Used as the third panel control on boards 11 / 12, as the lone screen-corner control on boards 07 and 13, and as the auth-error recovery glyph on board 14.

**Redrawn 2026-08-07.** It used to be a "sliders" mark — two horizontal rules, each split around a knob. The redraw also settled the open question below it: the chip instance now carries `2.545`, which is what renders 2.0 at 22 on a 28 viewBox, so **every product glyph in the file is on target and no glyph carries an anomaly.**

| Property | Panel control (11 · 12) · screen corner (07 · 13) | Auth-error chip (14) |
| --- | --- | --- |
| viewBox | `0 0 28 28` | `0 0 28 28` |
| Render size | **28 × 28** | **22 × 22** |
| `stroke-width` | **2** | **2.545** |
| Effective weight | `2 × 28/28 =` **2.00** | `2.545 × 22/28 =` **2.00** |
| `stroke` | `var(--color-icon)` → `#55565A` | `var(--color-icon)` → `#55565A` |
| `fill` | `none` on both elements | `none` on both elements |

**Elements — 1 path + 1 circle, complete (panel-control instance shown; the chip instance is byte-identical apart from `width`/`height` and `stroke-width`):**

```svg
<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M10.89 7.34L11.17 4.13L16.83 4.13L17.11 7.34L18.22 7.98L21.13 6.61L23.96 11.52L21.32 13.36L21.32 14.64L23.96 16.48L21.13 21.39L18.22 20.02L17.11 20.66L16.83 23.87L11.17 23.87L10.89 20.66L9.78 20.02L6.87 21.39L4.04 16.48L6.68 14.64L6.68 13.36L4.04 11.52L6.87 6.61L9.78 7.98Z"
        fill="none" stroke="var(--color-icon)" stroke-width="2" stroke-linejoin="round" />
  <circle cx="14" cy="14" r="3.27"
          fill="none" stroke="var(--color-icon)" stroke-width="2" />
</svg>
```

**The geometry, and why it is only a handful of numbers.** The cog is a single closed polygon of 24 points — six teeth × 4 corners — swept around centre `(14, 14)`:

| | Value | Why |
| --- | --- | --- |
| Teeth | **6** | Eight blur into a bumpy circle at the 22 the recovery chip draws. |
| Tip radius | **10.27** | Puts the ink at 82% of the box, matching `control/dock` beside it in the panel row. |
| Root radius | **7.35** | Leaves the teeth 2.9 units proud, which still reads against a 2.0 stroke. |
| Tooth half-angle | **16°** at the tip, **25°** at the root | The taper is what makes it read as a cog rather than a lobed circle. |
| Centre circle | **r 3.27** | Keeps a visible hole at 22. |

**`stroke-linejoin="round"` is load-bearing** — the tooth corners are rounded by the stroke, not by the geometry, so the path stays 24 plain points. A miter join spikes every tip.

**No rects, no lines, no dash arrays, no `stroke-linecap` anywhere in this glyph.**

---

## Icon summary

| Glyph | viewBox | Render | `stroke-width` | Effective | Elements | Colour binding |
| --- | --- | --- | --- | --- | --- | --- |
| `ui/check` | `0 0 24 24` | 22 · 24 | 2.18 · 2 | **2.00** · **2.00** | 1 path | `var(--color-icon)` |
| `ui/cross` | `0 0 24 24` | 22 | 2.18 | **2.00** | 1 path (2 subpaths) | `var(--color-icon)` |
| `ui/retry` | `0 0 24 24` | 22 | 2.18 | **2.00** | 2 paths | `var(--color-icon)` |
| `control/settings` | `0 0 28 28` | 28 · 22 | 2 · 2.545 | **2.00** · **2.00** | 1 path + 1 circle | `var(--color-icon)` |

All four are **stroke-only, no fills, and all four bind `var(--color-icon)`** — none of them ever uses `var(--color-brand)`. This is the point board 14 is making: the new glyph set is deliberately colourless.

`control/settings` stays on the 28 grid its `control/` siblings use rather than taking `04-icons.md`'s standing recommendation to re-author everything onto 24. The recommendation existed to stop one attribute rendering two weights at two sizes; the cog's redraw settled that directly, and the port normalises weight in points anyway, so the grid is now an authoring choice and consistency with `control/dock` and `control/full` wins.

---

---

## `ui/chevron-down`

The disclosure mark on `row/setting`, and the twenty-first glyph in the set. **The only one
authored on a 16 grid** rather than board 04's recommended 24: it is the smallest mark in the
product, and a 24 viewBox rendered at 16 would need a 3.0 design stroke to land on 2.0
effective — further from the set's own weights than simply drawing it at its render size.

| Property | Value |
| --- | --- |
| viewBox | `0 0 16 16` |
| Render size | 16 |
| Scale | **exactly 1.0**, so markup weight and rendered weight are both `2` |
| `d` | `M4 6.5 8 10.5 12 6.5` |
| Stroke | `var(--color-icon)`, `stroke-width 2`, `linecap round`, `linejoin round` |
| Bounds | **8 × 4**, symmetric about x = 8 |

**It has no specimen on board 04**, because it is drawn inside the row on board 10. That is not
an anomaly — `ui/check`, `ui/cross` and `ui/retry` were read off boards 13 / 14 and
`control/settings` off board 11. Board 04 is *"the original sixteen"*, not the set;
`design/icons.json` names the source board for every glyph.

The 8 × 4 bounds mean it covers only a quarter of its viewBox vertically, which trips the
port's "every glyph fills its frame" check. That check now carries a documented per-glyph floor
for it: a disclosure caret is an intrinsically flat mark, and redrawing it to fill two fifths
vertically would make it a wedge.

# Values that are not tokens

The designer flagged six deliberately un-tokenised, component-internal values. **All six verified against the live nodes.**

| # | Value | Component | Verified? | Stated justification (from the boards) |
| --- | --- | --- | --- | --- |
| 1 | **Thinking dot 6 × 6** | `state/thinking` | ✔ Three `6 × 6` frames, `border-radius: var(--radius-full)`, fill `var(--color-icon)`, `gap: var(--spacing-2)` 8 | Spec row, verbatim: **`6 × 6 · radius-full · NO TOKEN — component-internal`**. Supporting row: `Fill: var(--color-icon) #55565A — a mark, not content`. The dot is smaller than any spacing step and exists only inside this indicator. |
| 2 | **Streaming caret 2 × 22, gap 2** | `state/streaming` | ✔ `2 × 22` frame, `--radius-full`, fill `var(--color-ink)`; parent row `gap: 2px`, `height: 25px` | Two spec rows, verbatim: **`2 × 22 · radius-full · var(--color-ink) · NO TOKEN — component-internal`** and **`2 after the last glyph — NO TOKEN, optical`**. The height *is* derived: **`22 = var(--leading-control), optically centred in the 25 line box`** — i.e. only the 2 pt width and the 2 pt gap are free values. |
| 3 | ~~**`select/option` 236 × 90**~~ *(retired — kept for the derivation)* | Board 10 | ✔ `width: 236px`, `height: 90px`, `flex-shrink: 0`, `padding-block: 20`, `padding-inline: 22` | No prose exists on board 10, so the justification is arithmetic and must be read off the layout: **236 is derived — `(740 − 16 × 2) ÷ 3 = 236`**, the only width that fits three options across the 740 column at a `--spacing-4` gap. **90 is free** and is what the 20 / 24 / 4 / 22 / 20 stack needs. The padding pair (20 / 22) is off-scale on the inline axis and has no token. |
| 4 | **`btn/destructive` height 56** | Board 10 | ✔ `height: 56px`, `padding-inline: 28`, no shadow | No prose. 56 is **not** a spacing step and does not match the 58 of `btn/primary` or the 62 of a chip — it is a third control height. `padding-inline: 28` equals `--space-edge`'s value but is written as a raw literal, so it is not a token reference. |
| 5 | **`btn/primary` 58 / 64** | ~~Board 11~~ · 12 · 13 | ✔ Panel `301 × 58`; full-screen `hug × 64`, `padding-inline: var(--spacing-8)` 32 | No prose, but **58 is derived**: it is exactly the panel composer's height (`03 §1.1`). It was justified by the button occupying the composer's slot when the composer was not there (board 11, now deleted); the derivation survives as the plan tail sitting on the composer's rhythm on board 12. The port carries 50, the pill's current height. **64 is free** — it is *not* the full-screen composer's 80, so the CTA is deliberately lighter than the input at that scale. |
| 6 | **Full-screen message spec — tutor 21 / 30, student bubble max-width 520, padding 16 / 24** | Board 13 `Thread · wide` | ✔ `msg/tutor` `--text-lead` 21 / `--leading-lead` 30; bubble `max-width: 520px`, `padding-block: 16px`, `padding-inline: 24px`; text 21 / 30 | Board 14 Unresolved, verbatim: **"the panel-scale message spec has been carried up to the 740 column for the first time (msg/tutor 21 / 30, msg/student bubble max-width 520, padding 16 / 24); board 03 only ever specced the 301 column, so the full-screen thread was undefined until now."** 21 / 30 are existing tokens (`--text-lead` / `--leading-lead`); **520, 16 and 24 are the free values** — 520 ≈ 70 % of 740, the same ratio the panel's 224 has to 301 (74 %). |

## Additional un-tokenised values found on these boards (not on the designer's list)

| Value | Where | Note |
| --- | --- | --- |
| `field/key` `padding-left: 18` / `padding-right: 16` | 10 | 18 equals `--space-panel-inset` by coincidence; binding it would move the field when that token moves. |
| `row/setting` height **120** · `nav/item` gap **2** · pane title→lede gap **10** | 10 | All three free and component-internal. The 2 is deliberate: the items are 44pt targets and a token gap would open a dead lane. |
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

**Extension the boards do not address:** `btn/destructive` on board 10 has the same problem in a more dangerous place. "Reset this session" is irreversible and is rendered as a neutral `#F2F2F6` pill. If a semantic role is added under Option B, decide at the same time whether it also applies there.

## 2. ~~`control/settings` renders at 1.71, below the 2.0 target~~ RESOLVED

The auth-error recovery chip used to render `control/settings` at **22 on a 28 viewBox with
`stroke-width: 2.18`** → **1.71 effective**, and its spec row was the one glyph row on board 14
missing the `→ 2.00` its three siblings carry — which read like the value had been copied from the
24-viewBox glyphs without re-deriving.

**Settled 2026-08-07.** The glyph was redrawn as a six-tooth cog and the chip instance now carries
**2.545**, which is exactly what renders 2.0 at 22 on a 28 viewBox. Every product glyph in the file
is now on target, and no glyph carries a recorded anomaly.

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

## 9. ~~The API-key privacy sentence is stated two different ways~~ — **resolved 2026-08-08 by deletion**

- Board 11: *"It is kept in this device's Keychain and never leaves it."*
- Board 10: *"Kept in this device's Keychain. It is sent to OpenAI and nowhere else."*

The board-10 sentence was accurate; the board-11 sentence was not — the key necessarily left the device on every request. Both boards' sentences are now deleted along with the key itself: the app holds no OpenAI credential to make a promise about. Neither wording ships.

## 10. States that are still undrawn

Nothing in the file specifies:

- pressed / disabled / loading for `btn/primary`, `btn/destructive` or `nav/item`;
- **the open state of `row/setting`'s picker** — board 10 draws `Luna ▾` and stops, so the port uses the platform menu;
- a confirmation step for either destructive action ("cannot be undone" is asserted, but no dialog exists — and `01 §7` bars borders and this system has no modal pattern at all);
- what an auth failure offers now that there is no key pane to send anyone to — board 14's recovery chip still reads `Open Settings` and points at a destination that was deleted;
- a full-screen variant of `state/thinking`, `state/streaming`, either error state, or `state/evaluation` — board 14 draws every specimen at the 301 column only, even though board 13 has now defined a 740 thread;
- how a `plan/*` block behaves once it has scrolled up and a new exchange follows it (it is a flow child of the thread, so presumably it just scrolls, but nothing says whether it stays interactive).
