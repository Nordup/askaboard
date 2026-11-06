# Learning Space — design system

The founder likes how the app looks. This file keeps it that way. Every
agent that changes the UI reads it first and follows it. The binding rule is
also in [`../../AGENTS.md`](../../AGENTS.md) ("Learning Space UI").

## Principles

1. **Dark only.** Calm near-black surfaces, thin hairlines, one blue accent.
   The look is close to the Codex app, Claude Desktop and Paper.
2. **Quiet.** One primary action per view. Short labels. No explanations in
   the UI when a link or a second view can hold them. If a screen needs a
   paragraph, the design is wrong.
3. **Compact and consistent.** The same row height, text sizes, spacing and
   buttons everywhere. A new screen is a new combination of existing parts,
   not new CSS.
4. **Mock up first.** Show the founder a mockup (an inline widget works),
   build only after approval, then compare a screenshot of the build with the
   mockup, spacing included.
5. **The canvas belongs to the learner.** UI does not cover the board: menus
   open beside the sidebar or under the top bar, never as cards on the
   canvas. **Two exceptions.** The script panel floats over the board (the
   founder's request, 2026-10-25), because the learner reads the scene's
   lines next to the drawing. The learner drags it where it is in the way
   least, and hides it into the scene pill. The search panel (⌘K, decision
   U7, 2026-11-06) and the Settings dialog (⌘,, U12) cover the window with
   a backdrop, because the learner opens them.

## Where the design lives

| What | File |
| --- | --- |
| All design tokens (colours, type, spacing, radii, shadows, layout sizes) | `space/src/renderer/src/styles/tokens.css` |
| All app UI styles, including the shared menu system and buttons | `space/src/renderer/src/styles/app.css` |
| Canvas and selection styles | `space/src/renderer/src/board/board.css` |
| Agent material on the board (theme tokens `--ls-*` that agents use in their HTML) | `space/src/renderer/src/board/content.css` |

**Never hard-code** a colour, font size, spacing value or radius in a
component or in a new CSS rule. Use a token. If no token fits, add one to
`tokens.css` and use it.

## Tokens (names, grouped)

- Surfaces: `--bg-app`, `--bg-sidebar`, `--bg-canvas`, `--bg-elevated`,
  `--bg-elevated-2`, `--bg-hover`, `--bg-active`; `--bg-field` and
  `--bg-field-hover` (white at 0.06 and 0.09: a control's soft fill, the
  select's trigger). Glass (U16): `--bg-glass`, `--bg-glass-2` (the two
  elevated surfaces at 0.93) with `--glass-filter` (blur 24 px, saturate
  140%) on popups only (menus, popovers, the dropdown list); a modal panel,
  a tooltip and every other surface are opaque
- Borders and canvas: `--border-subtle`, `--border-strong`, `--canvas-dot`,
  `--canvas-dot-pitch`, `--canvas-dot-solid`, `--preview-checker`
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`,
  `--text-on-accent`
- Accent and status: `--accent`, `--accent-hover`, `--accent-soft`,
  `--accent-ring`, `--accent-tile-from`, `--accent-tile-to`,
  `--accent-tile-border`, `--status-idle`, `--status-live`, `--status-warn`,
  `--status-bad`, `--status-idle-ring`, `--status-live-ring`,
  `--status-live-pulse`, `--status-error-ring`, `--status-warn-ring`,
  `--status-bad-ring`, `--status-play`, `--status-play-ring`
- Canvas tools: `--selection-fill`, `--selection-border`, `--lasso-fill`,
  `--eraser-ring`, `--eraser-halo`, `--swatch-edge`, `--handle-rotate-size`,
  `--handle-rotate-reach`, `--handle-rotate-stem`,
  `--handle-rotate-stem-width`
- The hand on the board: `--ls-hand` in `board/content.css`, the font
  'Learning Hand' with the UI font as its fallback; below 1.5 dppx,
  'Learning Hand Heavy' (same metrics, wider line, B64; the ratio
  includes Interface Size, B63)
- Snapshot (the image agents see): `--snapshot-grid`, `--snapshot-axis`,
  `--snapshot-label`, `--snapshot-label-outline`, `--snapshot-tag-outline`;
  preview_scene marks: `--snapshot-view` (the learner's view, 2 px
  outline), `--snapshot-covered-fill` and `--snapshot-covered-edge` (a
  part that app UI hides), `--snapshot-mark-bg`, `--snapshot-mark-text`,
  `--snapshot-mark-ring` (their 11 px tags).
  The frame marker colour in `SnapshotView.tsx` encodes the request id; it
  is data, not a design colour.
- Ink colours: `--ink-white`, `--ink-yellow`, `--ink-blue`, `--ink-green`,
  `--ink-pink`, `--ink-orange`, `--ink-lavender`
- Type: `--font-ui`, `--font-mono`, `--text-xs` … `--text-xl`, `--leading`,
  `--leading-current` (the reading view's lines)
- Space: `--space-half` (2px, stacked lines of one text block), `--space-1` …
  `--space-6`, `--space-8`
- Radius (U16, one notch rounder): `--radius-sm` 6, `--radius-md` 9,
  `--radius-lg` 12, `--radius-xl` 16, `--radius-pill`; `--popup-radius` 14
  (a menu, a popover, the dropdown list). An inner fill's radius is its
  outer radius less the padding between them (a menu row: 14 − 6 = 8)
- Shadow (U16, soft and wide, low contrast; ChatGPT app as the reference):
  `--shadow-float` (inner top line white 0.05, 0 12 40 black 0.24, 0 2 8
  black 0.14) for popups, tooltips, the script panel and toasts (the board
  pills have none, U13); `--shadow-card` (inner top line, 0 24 80 black 0.3, 0 4 16 black
  0.16) for the modal panels and the welcome card
- Layout: `--sidebar-width`, `--topbar-height`, `--titlebar-height`,
  the title row (see "Title row"): `--window-buttons-end`,
  `--window-buttons-gap`, `--title-row-inset`, `--title-button-size`,
  `--title-button-gap`, `--title-icon-size`;
  `--sidebar-row-height`, `--folder-row-height`,
  `--topbar-rename-width`,
  the board controls (U10, U13): `--tools-pill-height`, `--tool-size`,
  `--tool-icon-size`, `--corner-pill-height`, `--corner-button-size`,
  `--corner-icon-size`, `--corner-divider-height`, `--corner-divider-gap`,
  `--style-pill-height`, `--swatch-size`, `--swatch-dot`, `--option-size`,
  `--option-icon-size`, `--option-text-pad`, `--option-bar-width`,
  `--option-fill-size`, `--pill-bar-pad`, `--pill-divider-height`,
  `--pill-divider-gap`, `--zoom-label-min`, `--toast-bottom`; `--pill-height`, `--pill-gap`, `--pill-action-size`,
  `--pill-label-max`, `--icon-button-size`, `--status-dot-size`,
  `--status-dot-size-small`, `--status-dot-ring`, `--item-pill-height`,
  `--item-pill-pad-left`, `--item-pill-gap`, `--item-pill-inset`,
  `--item-pill-ring`, `--script-panel-width`, `--script-panel-header`,
  `--script-panel-footer-pad`, `--step-bar-height`,
  `--step-bar-gap`, `--step-bar-radius`, `--step-bar-hit`,
  `--reading-view-height`, `--reading-view-gap`, `--reading-para-gap`,
  `--reading-said`, `--reading-next`, `--reading-light`,
  `--reading-light-ramp`
- Modal panels: `--backdrop` (behind a modal panel), `--panel-margin-x`,
  `--panel-margin-y` (the least space to the window's edges),
  `--panel-field-height`, `--panel-row-height`; the search panel's
  `--search-panel-width`, `--search-panel-height`; the Settings dialog's
  `--settings-dialog-width`, `--settings-dialog-height`, `--panel-nav-width`,
  `--setting-field-width`, `--radio-size`, `--radio-dot`
- The select (U14): `--select-chevron-pad`, `--select-list-min-width`,
  `--select-list-radius`, `--select-list-pad`, `--select-option-height`,
  `--select-option-pad`
- The small control (U15), one look for the select's trigger and `.btn-sm`:
  `--control-height`, `--control-height-menu`, `--control-pad-x`,
  `--control-radius`
- Settings spacing (U15): `--settings-pane-pad-y`, `--settings-pane-pad-x`,
  `--settings-title-size`, `--settings-title-gap`, `--setting-row-pad-y`,
  `--setting-row-gap`, `--setting-desc-gap`, `--setting-desc-leading`,
  `--settings-group-gap`, `--settings-heading-gap`; the key sheet's
  `--keys-line-height`, `--keys-column-min`, `--keys-column-gap`,
  `--keys-caps-width`, `--keys-name-gap`, `--keycap-size`, `--keycap-pad`,
  `--keycap-radius`, `--keycap-gap`
- Scrollbars (U14): `--scrollbar-size`, `--scrollbar-thumb`,
  `--scrollbar-thumb-hover`
- Motion: `--fade` (the quiet fade in and out), `--into-pill` and
  `--into-pill-scale` (the panel shrinks into the scene pill),
  `--pill-flash` (the pill lights up once), `--reading-ease` (the reading
  view's scroll follows its target). Every fade and motion turns off
  under `prefers-reduced-motion`.

## The menu system

Every menu, popover and flyout uses it: the sidebar folder and board menus
(`Menu.tsx`), the agent popover (`AgentPill.tsx`), the scene pill's menu
(`ScenePill.tsx`), the performance pill's menu (`PerfPill.tsx`), the setup
flyout (`SetupMenu.tsx`), the search panel (`SearchPanel.tsx`) and the
Settings dialog (`settings/`). Both modal panels are the one `ModalPanel.tsx`
(backdrop, focus in and back, keys kept in the panel, Tab round the panel,
Escape and a backdrop press close). The reference comment block sits above `.menu` in
`app.css`.

**Spacing and type** come only from custom properties on `.menu`:
`--menu-pad`, `--menu-radius`, `--menu-item-pad`, `--menu-row-pad`,
`--menu-item-radius`, `--menu-font`, `--menu-meta-font`,
`--menu-heading-font`, `--menu-separator-margin`. They hold the compact look
the founder approved (6 px panel padding, rows about 22 px, 13 px text,
12 px meta text).

**Parts:**

| Part | Use |
| --- | --- |
| `.menu__heading` | Small uppercase section label |
| `.menu__title` + `.menu__lede` | A title and one muted line, or two (a second `.menu__lede` follows closely); long words wrap |
| `.menu__path` | A quiet one-line path at the top of a menu (`--text-tertiary`, meta size, ellipsis); `Menu.tsx` entry `{ path }` |
| `.menu__item` (`--danger`, `--quiet`, `--current`) with `.menu__icon`, `.menu__label`, `.menu__hint` | A clickable row; the label is one line and ends with an ellipsis; `--current` is the row of what shows now (`--bg-active`, also on hover). An empty `.menu__icon` keeps a row without an icon in the labels' column |
| `.menu__sub` | Dim text right after a `.menu__label` (a board's folder); a `.menu__hint` stays at the right |
| `.menu__match` | The part of a label that matches the typed text, in `--accent` |
| `.menu--panel` with `.menu__field` (`.menu__input`) and `.menu__scroll` | A modal panel over a `.backdrop`: opaque `--bg-elevated` as every menu (U14), `--radius-xl`, `--border-strong`, `--shadow-card`; a search field at the top (17 px icon, 15 px text, hairline under it); rows of `--panel-row-height` in a list that fills the panel and scrolls. The instance sets the panel's height. The selected row (`--current`) is the one fill: the pointer moves the selection, so hover paints nothing |
| `.menu__list`, `.menu__row` with `.menu__name` (`--mono`) and `.menu__meta` (`--accent`, or `--mono` for a live number) or `.menu__control` | A plain row: name left, meta or one control right |
| `.menu__select` (in a `.menu__select-root`) and its list `.menu--select` with `.menu__option` (`.menu__option-label`, `.menu__option-check`) | The app's own dropdown (`Select.tsx`, U14); see "Select" below. Never a native `<select>` |
| `.menu__switch`, `.menu__text`, `.menu__progress` (`.menu__progress-bar`) | Controls in a row: an on/off toggle, a small text field before its `.btn-sm`, a 90 × 4 px accent progress bar with a `%` `.menu__meta--mono` after it |
| `.menu--split` with `.menu__nav` (`.menu__nav-end`) and `.menu__pane` (`.menu__header`) | A modal panel in two parts: a section list (`--panel-nav-width`, a hairline at its right; `.menu__item` rows, the current one `--current`, a hover fill; `.menu__nav-end` pins rows at the bottom) and a pane: a header (the title at `--settings-title-size` in a `--panel-row-height` row, level with the first section row, a close `.icon-button`) over a `.menu__scroll`. Spacing: "Settings spacing" below |
| `.menu__setting` with `.menu__setting-row`, `.menu__setting-text` (`.menu__name`, `.menu__desc`), `.menu__radio`; `.menu__settings` | A setting: the name, a muted description under it (`--text-tertiary`, meta size, wraps), one `.menu__control` at the right, lines under it; a hairline between settings. A row with `role="radio"` is one choice (a 14 px `.menu__radio`, an accent dot when chosen); `.menu__settings` wraps such a group |
| `.menu__sheet` with `.menu__sheet-line`, `.menu__keys` (`.menu__key`, `.menu__key-word`) | A key sheet (Settings > Keyboard shortcuts, U15): headings and lines in columns; each line the key caps, then the name |
| `.menu__line` (`--warn`, `--error`) with `.menu__fix` | One short line under a row, with an inline text action |
| `.menu__status`, `.menu__spinner` | Inline status: a green check with text, or a spinner |
| `.menu__separator` | The hairline between groups |
| `.menu__footer` | A quiet text action on the left, a small button on the right |
| `.btn-sm` (`--quiet`), `.btn-text` | The one small button and its quiet text variant. `.btn-sm` is the small control (U15): one CSS rule with the select's trigger, see "Select" |

**Rules:**

- A menu component sets only its **position and width** (an instance class
  such as `.menu.agent-pop` or `.menu.setup-menu`). Nothing else.
- A part that is missing goes **into the shared system**, with a line in the
  comment block, so every menu can use it. Never style one menu alone.
- Menus open next to their anchor: below a top-bar control, or as a flyout
  12 px to the right of the sidebar, level with the row that opened it. A
  menu whose anchor is at the bottom opens above it (`Menu.tsx` `above`: the
  sidebar footer's folder menu). An anchor that opens and closes the menu
  passes `toggle`, so a press on it is not an outside press.
- One primary control per row. A problem is one short line with **Fix** or
  **Retry**, not a paragraph.
- Escape and a click outside close a menu; focus returns to the anchor.
- Focus goes back as it was (`lib/focus.ts`, `markFocus` at open,
  `returnFocus` at close): the focus ring shows again only when the
  element showed it at open time (the keyboard reached it). A menu or
  panel that the pointer opened leaves no ring, also after keys in it.
  Every menu, panel and flyout uses these two functions.
- Focus styles use `:focus-visible`, never `:focus`. Every `button` gets
  the one ring (`app.css`, `button:focus-visible`: 2 px `--accent-ring`,
  1 px offset): it shows for keyboard focus only, never after a mouse
  click. A control that holds the focus for its keys and shows its place
  with a fill (a modal panel, the select's list) shows no ring.

### Select

The app's own dropdown (decision U14, approved mockup, 2026-11-06):
`components/Select.tsx` with `value`, `options` (`{ value, label }`),
`onChange`, `label`. It replaces every native `<select>`.

- Trigger `.menu__select`: the small control (U15), one CSS rule shared
  with `.btn-sm` so the two cannot drift: `--control-height` (30 px),
  padding 0 `--control-pad-x` (12 px; the chevron side
  `--select-chevron-pad`, 10 px), `--control-radius` (10 px; in a popup menu its rows' `--menu-item-radius`), `--bg-field`
  with no border (hover, and open for the trigger: `--bg-field-hover`), 13 px
  `--text-primary`; disabled `--disabled-opacity`; the buttons'
  keyboard-only focus ring. The trigger adds a 14 px `ChevronDown` in
  `--text-secondary`, 8 px gap. In a popup menu (the agent popover, the setup
  flyout) the control is `--control-height-menu` (24 px), the height of the
  menu's rows. The text field `.menu__text` takes the same height and radius.
- List `.menu.menu--select`: fixed under the trigger, right-aligned to it,
  4 px gap; above it when there is less room below; at least
  `--select-list-min-width` (200 px) and the trigger's width;
  `--bg-glass-2` with `--glass-filter`, 1 px `--border-strong`, `--select-list-radius`
  (`--popup-radius`, 14 px), `--select-list-pad` (6 px); rows `.menu__option`
  `--select-option-height` (28 px), `--menu-item-radius` (8 px, concentric), `--select-option-pad`.
  The pointer and the keys move the one `--bg-active` fill
  (`data-active`); the chosen row has a 14 px `Check` at the right. The
  list has no max height of its own (U15): it shows every row up to the
  room in the window, then scrolls inside, with the chosen row in view at
  open.
- Keys: Enter, Space, ↓ or ↑ open; ↑ / ↓ move; Home / End; letters find
  a row by its first letters; Enter or Space chooses; Escape closes the
  list only (in a modal panel the panel stays open); Tab closes. ARIA: the
  trigger is a button with `aria-haspopup="listbox"` and `aria-expanded`;
  the list is a `listbox` with `option` rows and `aria-selected`.
- The list is rendered inside the trigger's root (no portal), so it stays
  inside a modal panel and its keys reach it first. Escape and a press
  outside close it through `useMenuDismiss` (`lib/dismiss.ts`), which
  also turns the drag strips off; a choice closes it with the hook's
  `dismiss`, and the focus goes back to the trigger as it was. A scroll
  outside the list, a resize or a window blur closes it.

### Scrollbars

One style for every scroll area (decision U14; `app.css`, "Scrollbars", at
the end of the file), as a macOS overlay scrollbar in our look: global
`::-webkit-scrollbar` rules, a `--scrollbar-size` (6 px) thumb,
`--radius-pill`, `--scrollbar-thumb` (white at 0.18),
`--scrollbar-thumb-hover` (white at 0.3) on hover; no track, no arrow
buttons, a transparent corner.

- The thumb is invisible at rest. It fades in (`--fade`) while the area is
  hovered or scrolls, and out again: `lib/scrollbars.ts` marks a scrolled
  element `data-scrolling` until 800 ms after its last scroll.
- `.scroll-area` is the one shared part for a scroll area (the sidebar
  list, the Settings pane and section list, the search list, the select's
  list, the pill popovers, the preview body). It reserves no gutter (U16):
  while it does not overflow, its right padding is its whole
  `--scroll-pad-end`, so a row's fill ends as far from the right edge as
  from the left. `lib/scrollbars.ts` marks every `.scroll-area`
  `data-overflow` while its content is taller than it (one resize and
  mutation observer for the page); the scrollbar then takes its width out of
  that padding, so the content never moves. `--scroll-pad-end` does not
  inherit: each area sets its own (a `.menu` its `--menu-pad`), and it is
  never less than `--scrollbar-size`.
  Its thumb keeps `--scroll-track-inset` (a menu's `--menu-radius`) clear
  of the top and bottom, so it never runs over a rounded edge (U15).
- Never style a scrollbar in one component.

## Pills

The top bar's status items (agent, scene, performance; still called pills in
code) share `.pill` in `app.css` (the comment block above `.pill--static`).
They have no border and no capsule (decision U9; the zoom percent was the model before it left the top bar, U10):
`--pill-height` (26 px), padding 0 `--space-2`, `--radius-sm`, `--bg-hover`
on hover, `--bg-active` while the popover is open. The popover opens under
the item, right-aligned. The agent pill is a `.pill` button. The scene pill is
a `.pill.pill--static` holder of a toggle and one action. Parts: `.status-dot`
(`--live`, `--warn`, `--bad`, `--play`, `--error`), `.pill__label` (ends with an ellipsis),
`.pill--selected` (the pill speaks of a selected item: `--text-primary`),
`.pill__count` with `.pill__sep`, `.pill__time` (mono, tabular figures),
`.pill__action` (the one small icon button, 12 px lucide icon),
`.pill__toggle` (a plain button around the dot and text of a static pill;
the pill hovers with it) and `.pill--flash` (the pill lights up once).
A new pill uses these parts; a
missing part goes into the same block.

## Board controls

The three quiet pills over the bottom of the canvas (decisions U10, U13;
approved mockup "bottom_controls_quiet_small_v8"; `BoardControls.tsx`, the
comment block above `.board-controls` in `app.css`). Each is a `.pill-bar`
(`--bg-elevated`, 1 px `--border-subtle`, `--radius-pill`, padding 0 4 px,
gap 2 px, `--shadow-float`, U16) with its own height. Parts: `.tool` (round button,
lucide icon at stroke 1.75; pressed: `--accent-soft` and `--accent`;
`.tool--quiet` is `--text-tertiary`), `.pill-bar__divider` (1 × 16 px,
margin 0 5 px), `.swatch` (24 px) with `.swatch__dot` (13 px), `.option`
(22 px, round, 14 px icon; pressed: `--bg-active`, `--text-primary`;
`.option--text` for a word (12 px), `.option__bar` for a width (as thick
as the step's shape line: 1.5, 2.5, 4 px), `.option__fill` for a fill (a
12 px square: outline, light tint, solid), `.option__line` for a line
style (a bar: solid, dashed, dotted)) and `.zoom-label` (min 42 px, mono
12 px). Icon sizes come from the tokens (`.tool > .lucide`, `.option >
.lucide`), not from the components.

- The corner pill (30 px) at the bottom left, 12 px in, centred on the tool
  pill's row: − % + , a divider (1 × 14 px, margin 0 4 px), undo and redo;
  24 px buttons, 14 px icons. A click on the % zooms to 100% (no menu; ⇧1
  and ⇧2 fit the board and the selection, founder 2026-11-06). The tool
  pill (40 px; 30 px buttons, 17 px icons; founder: "a little bit larger"): keep-tool lock, then the tools of `tools.ts TOOLS` with a divider
  between groups (Select and Hand; the shapes; Pen, Text and Eraser),
  centred on the canvas. The row is a grid `1fr auto 1fr` with a 12 px gap
  and margin, so on a narrow canvas the tool pill moves right and stays
  12 px after the corner pill.
- The style pill shows for a tool with style fields, or for a selection
  with the Select tool (`board/style.ts`): colours, fill, width, line,
  arrowheads (one, two, none: icons), pen or marker, text size (S M L XL,
  `.option--text`), font (Hand, Plain, Code, `.option--text`), align (three
  icons), with dividers between groups. Rectangle and ellipse: colour,
  fill, width, line; arrow: colour, width, line, heads; line: colour,
  width, line. For a selection it ends with Duplicate, Delete (only when an
  item may change) and More; when the whole pill would be wider than the
  canvas less 24 px, it shows More alone. The style pill is 36 px (28 px swatches with a 15 px dot, 26 px options); a chosen colour has the grey circle of every chosen option, no ring. The colours are the ones agents draw with most (white, the accent blue, lavender, yellow, green, pink; `tools.ts INK_COLORS`). It sits 8 px above the tool pill,
  centred on it, and shifts to stay 12 px inside the canvas.
- Width (Fine, Medium, Bold) is one step for every kind: a shape draws it
  at 1.5, 2.5 or 4 board points, the pen at 2, 3.5 or 6. Text sizes: S 18,
  M 24 (default), L 32, XL 44.
- Shapes (B71) are drawn on the board as ink: one even line with a gentle
  wobble, a rectangle with round corners (radius min(12, 0.15 × the shorter
  side)); a light fill is the colour at 0.18 alpha. A selected arrow or line has two round end handles in place
  of the box handles.
- The board menu (`BoardMenu.tsx`, the shared `Menu`): one command list
  (`board/commands.ts`) feeds the right-click menu (at the pointer) and the
  More menu (8 px above the style pill). Rows have key hints; a command
  that cannot run is left out, never greyed: Cut, Copy, Paste, Duplicate,
  Delete | Bring to front, Send to back; on the empty board Paste and
  Select all.
- Every button has the shared tooltip ("Tooltips"), with the key after
  the label: "Select V or 1", "Undo ⌘Z". The font words (Hand, Plain,
  Code) show their label, so they get none.
- The zoom % is only here, not in the top bar. A click on it opens the
  shared `Menu` 8 px above the corner pill: Zoom to 100% (⌘0), Zoom to fit
  (⇧1), Zoom to selection (⇧2, only with a selection). Both fits glide and
  never zoom in past 100%.
- `?` opens Settings > Keyboard shortcuts (see "Settings dialog"): the one
  list of the keys, from `TOOLS` and `board/commands.ts`.

## Icon buttons and status dots

`.icon-button` is the one square icon button (`--icon-button-size`, 24 px,
tertiary, primary on hover); `.icon-button--strong` starts in secondary (a
panel header's controls); `.icon-button--title` is a title-row button
(`--title-button-size`, 28 px, `--radius-md`, 16 px icon). A disabled icon
button (the `disabled` attribute; Back with no board before) is
`--text-tertiary` at `--disabled-opacity` (0.5), with no hover fill. It
keeps its tooltip: the shared tooltip shows on a disabled control as on
any other, so the name and the key stay findable. `.status-dot` is 7 px; `.status-dot--small` is
6 px (a panel header). The halo is `--status-dot-ring` wide (2 px; 3 px in an
item pill).

## Title row

The 44 px row across the top of the window: the sidebar strip (while the
sidebar shows, in a window, in full screen and off macOS) and the top bar.
Everything in it shares one centre line at 22 px.

- **The sidebar button has one place** (decision U9): the title lead
  starts at `--chrome-reserve` in every state, and the button is its
  third button (after Back and Forward). With the sidebar shown it is in the
  strip ("Hide sidebar"); with the sidebar hidden it leads the top bar
  ("Show sidebar"), at the same x. A click on it never moves it. A
  keyboard toggle keeps the focus on the button in its new home
  (`App.tsx`).
- **Back and Forward** (decision U11) come first, then the sidebar
  button, 4 px apart: lucide `ChevronLeft` and `ChevronRight` at 20 px
  with a 1.4 stroke (a chevron fills less of its box, so at 16 px it looks
  smaller than the other icons), `.icon-button--title`,
  tooltips "Back ⌘[" and "Forward ⌘]" (`KEYS.back`, `KEYS.forward` in
  `board/commands.ts`), disabled when there is nowhere to go. The three
  buttons are one group, the title lead (`.title-lead`,
  `components/TitleLead.tsx`): the strip shows it while the sidebar
  shows, the top bar while it is hidden. One component in both places,
  so the three keep the same x in both states.
- The rest of the strip is empty: no app name, no other icons. New board's
  row starts 4 px (`--space-1`) under the strip.

- The macOS window buttons: three 14 px circles at a 23 px pitch, x 16 to
  76 window px (`--window-buttons-end`), centre 22 px at 100 %. Measured
  in a window capture on 2026-11-06; measure again when macOS changes
  them.
- **At any Interface Size** (page zoom factor f): the native buttons do
  not zoom with the page, so main places them (`main/interface-size.ts`,
  `windowButtonPosition`, applied with `setWindowButtonPosition` at
  window creation and at each factor change). Their centre line is the
  row's centre, 22·f window px (y rounded to a whole px, so within
  0.5 px). x stays 16 window px at every factor, as macOS apps keep it.
  Main sends their right edge in CSS px (76 / f) with the shell state and
  the `windowButtons` event; the renderer sets `--window-buttons-end` on
  `.shell` from it. The 16 px gap is CSS, so it is 16·f window px.
  Measured at f = 1, 1.2 and 1.5 (2026-11-06): centre 22 / 26 / 33, gap
  16 / 19.2 / 24.05.
- The top bar draws its bottom line as an inset shadow, not a border, so
  its content box is 44 px high.
- Icon buttons in the row are `.icon-button--title`: a 28 px hit area
  (`--title-button-size`) with a 16 px icon (`--title-icon-size`).
- 4 px between neighbouring buttons (`--title-button-gap`).
- 16 px from the window buttons' right edge to the first button
  (`--window-buttons-gap`), so it starts at 92 px in a macOS window.
- 12 px edge inset in full screen, on Linux and on Windows
  (`--title-row-inset`), from the top bar's left edge (the sidebar's right
  edge while it shows). `.shell` sets `--chrome-reserve` to one of the
  two; the strip and the top bar with the sidebar hidden use it.
- 12 px (`--space-3`) from the last button to the board name.
- No save mark in normal work: only a failed save shows, "Not saved" in
  `--ink-pink` with an alert icon, 12 px after the board name
  (`.save-status`, an `aria-live` region that is empty otherwise).
- The status items on the right keep their own spacing (`.topbar__right`).

## Tooltips

No native `title` in app UI: it shows late, unstyled, and often shows
internal data (a path, an id). One shared tooltip instead
(`components/Tooltip.tsx`, the `.tooltip` comment block in `app.css`).

- A control asks for it with `{...tip(label, key)}`: two data attributes.
  `<Tooltips />`, mounted once in `App.tsx`, owns every listener, so a
  control adds none.
- Use it only to name an icon-only control or to give a shortcut: the
  title-row buttons, the board controls (Board controls), the pill and
  panel icon buttons, a step-bar segment's step name. Never for a path,
  an id, a raw value, or the visible label again. A truncated name (a
  sidebar board, a scene name) gets no tooltip.
- Icon-only buttons keep their `aria-label`; the tooltip is linked with
  `aria-describedby` while it shows (`role="tooltip"`).
- Shows after 500 ms of hover, at once when the pointer moves from one
  tooltip control to the next within 300 ms (as macOS), and on
  `:focus-visible`. Never on a press: a pressed control shows none until
  the pointer leaves it. Hides on leave, any key, a click, a scroll or
  wheel, and window blur.
- Look: `--bg-elevated-2`, 1 px `--border-strong`, `--radius-sm`,
  padding 4 px 8 px, `--text-xs` `--text-primary`; the shortcut after
  the label in `--text-tertiary` (`.tooltip__key`, 8 px before it);
  `--shadow-float`. Below the control with a 6 px gap
  (`--tooltip-gap`), above it when there is no room, 8 px inside the
  window (`--tooltip-margin`). `pointer-events: none`, in a portal.
- Words: sentence case; shortcuts from `platform.ts` `shortcut()`
  ("Hide sidebar ⌘B", "New board ⌘N", "Undo ⌘Z", "Back ⌘[").
- A disabled control keeps its tooltip (Back and Forward with nowhere to
  go): it still names the control and its key.

## Approved screens (reference)

- **Agent popover.** Default view: the agents list (status dot, name,
  "active now" / "12 min ago"), one "Connect an agent" row. Connect view:
  back arrow, three rows (Claude Code, Claude Desktop, ChatGPT and Codex),
  each with one control (Install, Installed, spinner), problems as one line
  with Fix, and one link "Manual setup and other agents".
- **Setup flyout.** A quiet sidebar row "Set up for learning" with an accent
  dot; the flyout lists the files (new / kept) and has one Set up button and
  a "Don't ask for this folder" text action.
- **Sidebar** (left-panel plan, decisions U6 and U9, 2026-11-06). Top to
  bottom: a 44 px strip (drag region) with only the title lead (Back and
  Forward, then the sidebar button, lucide `PanelLeft`,
  `SidebarToggle.tsx`; `TitleLead.tsx`, see "Title row"), its left edge at
  `--chrome-reserve`, 4 px above the rows; the rows New board (`SquarePen`,
  hint ⌘N) and Search boards (`Search`, hint ⌘K), both `.board-row
  .board-row--action` with `.board-row__hint`; the "Set up for learning" row
  and the guide-override note; the heading "Boards" and the boards list;
  the footer (top hairline; padding 4 px at the top, 8 px at the left,
  right and bottom): `.folder-row` (`--folder-row-height`, 32 px), one
  line: `Folder`, the folder name, and `ChevronsUpDown` (U11: no "Saved
  on this Mac" line). Rows are `--sidebar-row-height` (30 px), radius
  `--radius-md`. The footer opens the folder menu above it
  (`.menu.folder-menu`, the sidebar's width): the path as one quiet
  `.menu__path` line (`~` for home; longer than 32 characters:
  `~/…/<parent>/<folder>`), a separator, Reveal, Open Learning Folder…,
  Edit Board Guide…, Recent, then a separator, Settings (⌘,) and Keyboard
  shortcuts (?). No folder name, no lede. No folder: the
  footer reads "Open a folder". The boards list shows all boards up to
  15; above 15, the first 10 and "Show N more", and "Show less" when
  expanded.
- **Sidebar hidden** (⌘B, View > Hide Sidebar; main owns the setting). One
  column, at once. The top bar then starts with the title lead (Back,
  Forward, the sidebar button) and a New board button (4 px apart, in
  the one `.title-lead` group): at 92 px on macOS in a
  window, at 12 px in full screen and off macOS (`--chrome-reserve` on
  `.shell`, set by `data-window-buttons`; see "Title row"), the same x as
  the button in the strip with the sidebar shown. Then the board
  name, 12 px after the buttons; a new board's rename
  field shows in the top bar (`.topbar__rename`).
- **Scene pill** (decision B19, mockup v3, 2026-10-29; idle, selection and
  menu from mockup v5, 2026-10-29). Left of the agent pill, from the same
  parts and with the same open behaviour: a `.pill.pill--static` whose
  `.pill__toggle` (dot and text) opens the shared menu below it
  (`.menu.scene-pop`, 300 px, position and width only); Escape and a click
  outside close it. While a scene plays: the accent dot (idle grey when
  paused), "<step> · 2/3", the time (m:ss) and pause / resume. Otherwise it
  has no button: grey dot and the board's last scene name, from the scene
  records (also after a restart).
  - With an item selected that a scene drew, and nothing playing, the pill
    wakes up: "Step 3 · <the first line of that step>" (the label's
    ellipsis cuts it), in `--text-primary` (`.pill--selected`). It lights
    once (`.pill--flash`, `--accent-soft`, `--pill-flash` 450 ms) when the
    selected item's step changes. Deselect: back to the last scene name in
    grey. Clicking an item never opens the panel.
  - The menu: heading "Scenes", every scene of the board newest first
    (dropped scenes left out), one `.menu__item` row each with the scene
    name only (one line, ellipsis; no icon, no step count). The scene in the
    panel has `.menu__item--current` (`--bg-active`). Choosing one opens the
    panel with it in its ended state.
  - In a top bar narrower than 760 px the step name goes while a scene plays.
- **Reading panel** (`ScriptPanel.tsx`; decision B19, mockup v3, 2026-10-29;
  reading view from mockup v5, 2026-10-29; replaced the script panel of
  2026-10-25). One scene at a time, in a frame over the board:
  `--script-panel-width` (296 px), `--bg-elevated`, 1 px `--border-strong`,
  `--radius-lg`, `--shadow-float`, top right of the canvas by default. The
  learner drags it by its header; it keeps the place (localStorage, measured
  from the nearer side), stays inside the canvas and ends above the bottom
  row of the board controls.
  - Header, 34 px, padding 0 5 0 12 px, gap 8 px: the small status dot
    (6 px; accent with its ring while playing, idle grey otherwise), the
    scene name (12 px, secondary, ellipsis), one 24 px icon button, minus
    (hide).
  - Step bar under the header: padding 0 12 px, gap 3 px
    (`--step-bar-gap`), one segment per step, flex = the step's length,
    3 px high (`--step-bar-height`), radius 2 px (`--step-bar-radius`),
    track `--border-subtle`, fill `--accent` while playing and
    `--text-tertiary` when paused or ended. Each segment's click and hover
    band is 12 px high (`--step-bar-hit`); it looks the same. A click plays
    from that step; hover shows its name (title).
  - Reading view, 8 px below the step bar (`--reading-view-gap`): a fixed
    176 px (`--reading-view-height`), so the footer never moves. All the
    scene's lines in order, one paragraph each: 15 px, `--leading-current`
    1.6, `--text-primary`, 10 px apart (`--reading-para-gap`), 16 px side
    padding. No step titles.
    - The reading point never jumps. Each step starts at the middle of its
      first visual line (a step without lines starts where the next step
      with lines starts, so it holds there). During a step the point moves at an even pace to the
      start of the next step and arrives just as that step starts, so each
      step scrolls at its own speed. The last step goes to the middle of the
      last line. A pause stops it; a seek or a step-bar click moves it.
    - One focus point drives the scroll and the light (mockup v7,
      2026-10-29). The scroll keeps the focus in the middle of the view; at
      the start the text stays at the top, at the end at the bottom, and the
      light moves on to the first or the last line. The panel holds one focus
      state; its mode sets the focus:
      - Follow (a scene plays): the reading point.
      - Free (the wheel or the trackpad): the wheel moves the focus, within
        the middle of the first line and the middle of the last line. While
        a scene plays, the focus glides back to the reading point 3 s after
        the last wheel input (`--reading-return`), and the status says
        "Scrolled · back in a moment". While nothing plays, it stays.
      - Select (the learner selects an item of the scene that shows, and the
        scene does not play): the middle of the first line of the step that
        made the item, else of the step that changed it (the pill's lookup,
        `storyOfSelection`). The scroll puts that line 4 px below the top of
        the bright band (`--reading-band-offset`), so the step reads down
        through the light. No other highlight. A deselect moves nothing; an
        item of another scene changes nothing; while a scene plays, Follow
        owns the focus.
    - The shown focus and scroll follow their targets with an exponential
      ease (`--reading-ease`, 120 ms), so every change is smooth.
    - The light: a mask centred on the focus, full brightness ±14 px
      (`--reading-light`), a ramp to 60 px (`--reading-light-ramp`), alpha
      0.22 above (`--reading-said`) and 0.5 below (`--reading-next`).
    - A click on a line plays the scene from that line's own time (a replay,
      also after a restart). The only hover effect is the pointer cursor. A
      scene that cannot replay has no click and no pointer.
    - Ended (also a scene opened from the pill's menu): scrolled to the end,
      the light on the last line. Reduced motion: no ease; the mask stays.
  - Footer, padding 4 5 6 11 px (`--script-panel-footer-pad`): one status
    (11 px, tertiary): "Step 2 of 3", "Paused while you draw", "Paused at a
    pause", "Paused", "Scrolled · back in a moment", "Done" or "Done · cannot replay" (the app does not hold the scene); then 24 px icon buttons: replay step
    (rotate), pause / play (secondary), next step (skip-forward). Ended: only
    replay, which plays the whole scene again (none when the app no longer
    holds the scene). The status line is 24 px high, so the footer keeps its
    height without buttons.
  - The panel stays mounted and laid out, hidden, while it shows nothing,
    in the shape it has while a scene plays. Agents learn the part of the
    view it covers from this element's real box (`agent/covered.ts`).
  - It appears when a scene plays and fades about 4 s after the scene ends,
    not while the pointer is on it. A scene chosen from the pill's menu stays
    until it is hidden or a new scene plays.
  - Minus hides it into the pill: it shrinks toward the pill's centre and
    fades (`--into-pill` 260 ms, scale `--into-pill-scale` 0.06), then the
    pill lights up once in `--accent-soft` (`.pill--flash`, `--pill-flash`
    450 ms). Opening from the pill grows it out of the pill. A scene that
    starts after nothing played shows it again.

- **Performance pill** (the founder's approval, 2026-11-01). View > Show
  performance, a check mark that stays across restarts; off by default; no
  keyboard shortcut. While on, the pill sits left of the scene pill: a
  `.pill.pill--static` with `.pill__toggle`, a `.status-dot` and `.pill__time`
  text, "60 fps · 4.8 ms" (the board's frame rate, the wall time per picture),
  or "60 fps" with no world moving. The dot is `--live` at 55 fps or more,
  `--warn` from 40 to 55, `--bad` below 40. A click opens the shared menu
  below it (`.menu.perf-pop`, 264 px, position and width only); Escape and a
  click outside close it. Numbers change once per second.
  - Heading "Board": Frame rate, Slowest frame, Dropped, last 10 s.
  - Heading "Worlds": Pictures, Time per picture, Resolution, Pixels, Draws,
    triangles; with no world moving, one `.menu__line`, "No world moving".
  - Rows are `.menu__row`, `.menu__name` and `.menu__meta--mono`.
  - The pill reads `perf-meter.ts`, and the meter runs only while the pill
    shows.

- **Search panel** (`SearchPanel.tsx`; left-panel plan section 6, decision
  U7, mockup "learning_space_search_panel_mockup_v1", 2026-11-06). Opens
  from the sidebar's "Search boards" row and File > Search Boards… (⌘K),
  also with the sidebar hidden; a second ⌘K closes it. No folder: the menu
  item is disabled and ⌘K does nothing (the welcome card has the open
  action).
  - A `.backdrop` (`--backdrop`, rgba(0, 0, 0, 0.4)) over the whole window;
    it is no drag region, and the native window buttons stay above it. The
    panel `.menu.menu--panel.search-panel`: centred in the window both
    ways, 520 px wide (at most the window width − 32 px), a fixed height of
    min(460 px, window height − 64 px), opaque `--bg-elevated` (U14),
    1 px `--border-strong`, `--radius-xl`,
    `--shadow-card`.
  - Field: 46 px, lucide `Search` 17 px `--text-tertiary`, 15 px text,
    placeholder "Search boards", a hairline under it. It has the focus while
    the panel is open.
  - Empty field: `.menu__heading` "Actions" with New board (⌘N) and Open
    Learning Folder… (⌘O, the folder menu's label); "Recent boards" with the
    first 8 boards by edit time.
  - Typed text (trimmed): only boards whose name contains it
    (case-insensitive), names that start with it first, then by edit time;
    the match in `--accent` (`.menu__match`); up to 50 rows. The list
    fills the panel and scrolls; short results leave empty space under
    them. No match:
    a `.menu__line` `No boards match “…”` and the row `New board “…”` (the
    name main will give the file), which makes the board and opens it, with
    no rename step.
  - Rows: `.menu__item`, 32 px, `--radius-md`; every row has a 16 px
    icon (actions their own, a board row `LayoutDashboard`), its folder as `.menu__sub` for a board outside
    `boards/`, the short time (or the shortcut) as `.menu__hint`. The
    selected row is `.menu__item--current`; the first row starts selected
    and is selected again when the text changes.
  - Keys: ↑ / ↓ move the selection (no wrap; it scrolls into view), Enter
    runs the row, Escape closes; an IME composition keeps its keys. The
    pointer moves the selection; a click runs the row; a click on the
    backdrop closes. While it is open no board, tool or sidebar key acts,
    and the zoom items do not zoom the board; ⌘N and ⌘O close it and run.
    Opening it closes any open menu. A close gives the focus back to the
    element that had it (with the ring only if it had one at open), then
    the row's action runs.

- **Settings dialog** (decision U12, approved mockup, 2026-11-06;
  `components/settings/`, replaced the U8 panel). One centred
  `.menu.menu--panel.menu--split.settings-dialog` over a `.backdrop`
  (`ModalPanel.tsx`): `--settings-dialog-width` × `--settings-dialog-height`
  (760 × 600 px, tall enough for the key sheet), at most the window less `--panel-margin-x` /
  `--panel-margin-y` on each side.
  - Opens from Settings… (⌘,; the File menu off macOS), the folder menu's
    last items (a separator, "Settings" ⌘, and "Keyboard shortcuts" ?),
    the `?` key (at Keyboard shortcuts; `?` there closes it) and the voice
    notice (at Voice). ⌘, while it is open keeps its section. Escape, the
    close button and a backdrop press close it; the focus goes back as it
    was.
  - The section list (`.menu__nav`): lucide icons at 16 px, General
    (`SlidersHorizontal`), Voice (`Volume2`), Agents (`Bot`), Folder
    (`Folder`), Keyboard shortcuts (`Keyboard`); About (`Info`) at the
    bottom (`.menu__nav-end`). The pane: the section title in the header,
    then `.menu__setting` rows.
  - Settings spacing (U15; role-named tokens, every section uses them): the
    pane 24 px top and bottom, 28 px at the sides; the title 16 px, its row
    level with the first section row, 8 px under it; a setting row 16 px
    above and below its text, 16 px from the text to the control; 4 px from
    the name to the description (12 px `--text-tertiary`, line height 1.4);
    a group heading 20 px above, 4 px under. The section list: 24 px top
    and bottom, 12 px at the sides.
  - General: Interface size (a `Select`, "Automatic (N%)" and 80 %
    to 200 %, the labels of View > Interface Size), Show performance (a
    `.menu__switch`).
  - Voice: Read lines aloud (switch); Cloud voice and On this Mac · Kokoro
    as two `role="radio"` settings in a `.menu__settings` group (Kokoro:
    Install · N MB, the progress bar and percent, Installed and Remove, or
    an error line with Retry; it is chosen only when installed); Voice (a
    `Select` and the play icon button: the cloud voice's sample ships with
    the app and plays at once, U14; Kokoro makes its sample on the Mac);
    Pace (a `Select`); Gemini key ("Optional:
    your own key removes the daily limit": a password `.menu__text` and Save,
    or "Key saved" and Remove).
  - Agents: the agent popover's Connect rows (`ConnectAgents.tsx`, one
    component, here with a description per app) and "Manual setup and
    other agents".
  - Folder: the folder name with its path (`~`, shortened as in the folder
    menu) and Reveal; Change folder (Change folder…); Board guide (Edit);
    Set up for learning (Set up…, which opens the setup flyout, or "Set up"
    with a check). No folder: one row, "No folder open" with Open a folder.
  - Keyboard shortcuts (U15): a `.menu__sheet`. The groups Tools, Edit,
    View flow in two columns (one when the pane has no room for two
    `--keys-column-min` columns); a line is 30 px: the caps in a 76 px
    column, 12 px, then the name (a long name wraps, never an ellipsis). A
    cap: at least 20 × 20 px, padding 0 5 px, `--radius-sm`, `--bg-active`,
    11 px `--text-primary`, 3 px between caps; a combo is one cap per key
    (⌘ ⇧ ]); "or" and "drag" are plain tertiary words. The one list is
    `ShortcutsSection.tsx` (from `TOOLS` and `commands.ts`). The dialog is
    600 px tall so the two columns fit without scrolling; a smaller window
    shrinks the dialog, and then the sheet scrolls.
  - About: the product name with "Version N", and the license.
- **Voice notice.** At the cloud voice's daily limit the board's toast
  (`.toast--warn`: lucide `VolumeX` in `--status-warn`) says "Not enough
  voice credits left for today." with one text action
  (`.toast__action`) "Set up local voice", which opens Settings at Voice. At most
  once a day per app run.

- **Stopped world.** A world that fails or stops answering shows a quiet note
  at its place (`.node-live__note`).

## Words

- Sentence case for every label. Verb first for actions ("Install",
  "Set up", "Connect an agent").
- No "please", no "successfully", no exclamation marks.
- Errors say what happened and what to do, in one short line.
- Product names as the vendors write them: "Claude Code", "Claude Desktop",
  "ChatGPT and Codex".
- Words and shortcuts that differ by platform come from
  `src/renderer/src/platform.ts` (decision D6): `shortcut('O')` gives "⌘O" on
  macOS and "Ctrl+O" elsewhere; the file manager item is "Reveal in Finder"
  (macOS), "Open Containing Folder" (Linux) or "Show in Explorer" (Windows).
  Never write "⌘" or "Finder" in a component.

## Checklist for any UI change

1. Read this file.
2. Mock it up; get the founder's approval.
3. Build it only from tokens and shared parts. Add missing parts to the
   shared system.
4. Check it in dev mode; compare a screenshot with the mockup.
5. If you changed the system, update this file in the same commit.
