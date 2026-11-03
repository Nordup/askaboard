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
   canvas. **One exception** (the founder's request, 2026-10-25): the script
   panel floats over the board, because the learner reads the scene's lines
   next to the drawing. The learner drags it where it is in the way least,
   and hides it into the scene pill.

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
  `--bg-elevated-2`, `--bg-hover`, `--bg-active`
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
  'Learning Hand' with the UI font as its fallback
- Snapshot (the image agents see): `--snapshot-grid`, `--snapshot-axis`,
  `--snapshot-label`, `--snapshot-label-outline`, `--snapshot-tag-outline`;
  preview_scene marks: `--snapshot-view` (the learner's view, 2 px
  outline), `--snapshot-covered-fill` and `--snapshot-covered-edge` (a
  part that app UI hides), `--snapshot-mark-bg`, `--snapshot-mark-text`,
  `--snapshot-mark-ring` (their 11 px tags).
  The frame marker colour in `SnapshotView.tsx` encodes the request id; it
  is data, not a design colour.
- Ink colours: `--ink-white`, `--ink-yellow`, `--ink-blue`, `--ink-green`,
  `--ink-pink`, `--ink-orange`
- Type: `--font-ui`, `--font-mono`, `--text-xs` … `--text-xl`, `--leading`,
  `--leading-current` (the reading view's lines)
- Space: `--space-1` … `--space-6`, `--space-8`
- Radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`,
  `--radius-pill`
- Shadow: `--shadow-float`, `--shadow-card`
- Layout: `--sidebar-width`, `--topbar-height`, `--titlebar-height`,
  `--palette-height`, `--pill-height`, `--pill-gap`, `--pill-action-size`,
  `--pill-label-max`, `--icon-button-size`, `--status-dot-size`,
  `--status-dot-size-small`, `--status-dot-ring`, `--item-pill-height`,
  `--item-pill-pad-left`, `--item-pill-gap`, `--item-pill-inset`,
  `--item-pill-ring`, `--script-panel-width`, `--script-panel-header`,
  `--script-panel-footer-pad`, `--step-bar-height`,
  `--step-bar-gap`, `--step-bar-radius`, `--step-bar-hit`,
  `--reading-view-height`, `--reading-view-gap`, `--reading-para-gap`,
  `--reading-said`, `--reading-next`, `--reading-light`,
  `--reading-light-ramp`
- Motion: `--fade` (the quiet fade in and out), `--into-pill` and
  `--into-pill-scale` (the panel shrinks into the scene pill),
  `--pill-flash` (the pill lights up once), `--reading-ease` (the reading
  view's scroll follows its target). Every fade and motion turns off
  under `prefers-reduced-motion`.

## The menu system

Every menu, popover and flyout uses it: the sidebar folder and board menus
(`Menu.tsx`), the agent popover (`AgentPill.tsx`), the scene pill's menu
(`ScenePill.tsx`), the performance pill's menu (`PerfPill.tsx`), the setup
flyout (`SetupMenu.tsx`). The reference comment block sits above `.menu` in
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
| `.menu__title` + `.menu__lede` | A title and one muted line |
| `.menu__item` (`--danger`, `--quiet`, `--current`) with `.menu__icon`, `.menu__label`, `.menu__hint` | A clickable row; the label is one line and ends with an ellipsis; `--current` is the row of what shows now (`--bg-active`, also on hover) |
| `.menu__list`, `.menu__row` with `.menu__name` (`--mono`) and `.menu__meta` (`--accent`, or `--mono` for a live number) or `.menu__control` | A plain row: name left, meta or one control right |
| `.menu__line` (`--warn`, `--error`) with `.menu__fix` | One short line under a row, with an inline text action |
| `.menu__status`, `.menu__spinner` | Inline status: a green check with text, or a spinner |
| `.menu__separator` | The hairline between groups |
| `.menu__footer` | A quiet text action on the left, a small button on the right |
| `.btn-sm` (`--quiet`), `.btn-text` | The one small button and its quiet text variant |

**Rules:**

- A menu component sets only its **position and width** (an instance class
  such as `.menu.agent-pop` or `.menu.setup-menu`). Nothing else.
- A part that is missing goes **into the shared system**, with a line in the
  comment block, so every menu can use it. Never style one menu alone.
- Menus open next to their anchor: below a top-bar control, or as a flyout
  12 px to the right of the sidebar, level with the row that opened it.
- One primary control per row. A problem is one short line with **Fix** or
  **Retry**, not a paragraph.
- Escape and a click outside close a menu; focus returns to the anchor.

## Pills

The top bar's status pills share `.pill` in `app.css` (the comment block
above `.pill--static`). The agent pill is a `.pill` button. The scene pill is
a `.pill.pill--static` holder of a toggle and one action. Parts: `.status-dot`
(`--live`, `--warn`, `--bad`, `--play`, `--error`), `.pill__label` (ends with an ellipsis),
`.pill--selected` (the pill speaks of a selected item: `--text-primary`),
`.pill__count` with `.pill__sep`, `.pill__time` (mono, tabular figures),
`.pill__action` (the one small icon button, 12 px lucide icon),
`.pill__toggle` (a plain button around the dot and text of a static pill;
the pill hovers with it) and `.pill--flash` (the pill lights up once).
`.pill--item` is a static pill on a board item, not in the top bar (the `--item-pill-*` tokens). A new pill uses these parts; a
missing part goes into the same block.

## Icon buttons and status dots

`.icon-button` is the one square icon button (`--icon-button-size`, 24 px,
tertiary, primary on hover); `.icon-button--strong` starts in secondary (a
panel header's controls). `.status-dot` is 7 px; `.status-dot--small` is
6 px (a panel header). The halo is `--status-dot-ring` wide (2 px; 3 px in an
item pill).

## Approved screens (reference)

- **Agent popover.** Default view: the agents list (status dot, name,
  "active now" / "12 min ago"), one "Connect an agent" row. Connect view:
  back arrow, three rows (Claude Code, Claude Desktop, ChatGPT and Codex),
  each with one control (Install, Installed, spinner), problems as one line
  with Fix, and one link "Manual setup and other agents".
- **Setup flyout.** A quiet sidebar row "Set up for learning" with an accent
  dot; the flyout lists the files (new / kept) and has one Set up button and
  a "Don't ask for this folder" text action.
- **Sidebar.** Folder header, boards list, file tree; rows share one height
  and type scale.
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
  from the nearer side), stays inside the canvas and ends above the tool
  palette.
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
