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
   canvas.

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
  `--accent-tile-border`, `--status-idle`, `--status-live`,
  `--status-idle-ring`, `--status-live-ring`, `--status-live-pulse`,
  `--status-error-ring`, `--status-play`, `--status-play-ring`
- Canvas tools: `--selection-fill`, `--lasso-fill`, `--eraser-ring`,
  `--eraser-halo`, `--presence-border`, `--presence-glow`,
  `--presence-border-peak`, `--presence-glow-peak`, `--swatch-edge`
- Snapshot (the image agents see): `--snapshot-grid`, `--snapshot-axis`,
  `--snapshot-label`, `--snapshot-label-outline`, `--snapshot-tag-outline`.
  The frame marker colour in `SnapshotView.tsx` encodes the request id; it
  is data, not a design colour.
- Ink colours: `--ink-white`, `--ink-yellow`, `--ink-blue`, `--ink-green`,
  `--ink-pink`, `--ink-orange`
- Type: `--font-ui`, `--font-mono`, `--text-xs` … `--text-xl`, `--leading`,
  `--text-caption` (scene captions only)
- Space: `--space-1` … `--space-6`, `--space-8`
- Radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`,
  `--radius-pill`
- Shadow: `--shadow-float`, `--shadow-card`, `--caption-halo` (a text
  shadow in the canvas colour: text on the canvas without a card)
- Layout: `--sidebar-width`, `--topbar-height`, `--titlebar-height`,
  `--palette-height`, `--pill-height`, `--pill-gap`, `--pill-action-size`,
  `--pill-label-max`, `--caption-width`
- Motion: `--fade` (the quiet fade in and out). Every fade turns off under
  `prefers-reduced-motion`.

## The menu system

Every menu, popover and flyout uses it: the sidebar folder and board menus
(`Menu.tsx`), the agent popover (`AgentPill.tsx`), the setup flyout
(`SetupMenu.tsx`). The reference comment block sits above `.menu` in
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
| `.menu__item` (`--danger`, `--quiet`) with `.menu__icon`, `.menu__label`, `.menu__hint` | A clickable row |
| `.menu__list`, `.menu__row` with `.menu__name` (`--mono`) and `.menu__meta` (`--accent`) or `.menu__control` | A plain row: name left, meta or one control right |
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
a `.pill.pill--static` holder of one control. Parts: `.status-dot`
(`--live`, `--play`, `--error`), `.pill__label` (ends with an ellipsis),
`.pill__count` with `.pill__sep`, `.pill__time` (mono, tabular figures) and
`.pill__action` (the one small icon button, 12 px lucide icon). A new pill
uses these parts; a missing part goes into the same block.

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
- **Scene pill and captions** (mockup A, 2026-10-25,
  `images/2026-10-25-scene-captions-mockup.png`). While a scene plays or is
  paused, a pill left of the agent pill shows the status dot (accent while
  playing, idle grey when paused), "<step> · 2/5", the time (m:ss) and one
  pause / resume button. In a top bar narrower than 760 px the step name
  goes. The tutor's words show as one or two centred lines 12 px above the
  tool palette: spoken words in primary text, the rest in tertiary, no card,
  `--caption-halo` for contrast. A longer line shows as two-line pages, like
  film subtitles. The line fades in, stays 1.2 s after its cue ends, then
  fades out.

## Words

- Sentence case for every label. Verb first for actions ("Install",
  "Set up", "Connect an agent").
- No "please", no "successfully", no exclamation marks.
- Errors say what happened and what to do, in one short line.
- Product names as the vendors write them: "Claude Code", "Claude Desktop",
  "ChatGPT and Codex".

## Checklist for any UI change

1. Read this file.
2. Mock it up; get the founder's approval.
3. Build it only from tokens and shared parts. Add missing parts to the
   shared system.
4. Check it in dev mode; compare a screenshot with the mockup.
5. If you changed the system, update this file in the same commit.
