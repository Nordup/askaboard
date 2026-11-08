# Askaboard docs: start here

This folder holds the working docs for the agents and the contributors who
build Askaboard: plans, decisions, the roadmap, the design and how-to guides.
These docs are not for users. Users get the [website](https://askaboard.com)
and the app.

Askaboard is a desktop app for learning with an AI agent on a shared board.
The agent explains on the board with animations, and the learner talks with
it (decision P15). An external agent (Claude Code, Claude Desktop, ChatGPT,
Codex) connects over MCP. The app has no AI inside, except the voice that
reads scene lines aloud (P1). All learning lives in one local folder that the
learner owns. The app code is in [`../apps/desktop/`](../apps/desktop/), and
work happens on `main`.

## Read in this order

1. [`launch-plan.md`](launch-plan.md): the current plan and the roadmap.
   Read it first. Where another doc disagrees, the launch plan wins (P23, D7).
2. [`architecture.md`](architecture.md): how the app fits together and where each part lives.
3. [`decisions.md`](decisions.md): every decision, with the reason and the rejected alternatives.
4. [`working-guide.md`](working-guide.md): how to build and check the app, the founder's preferences, and known pitfalls.
5. [`design-system.md`](design-system.md): the UI rules. Read it before any UI change.
6. [`writing-agent-text.md`](writing-agent-text.md): how to write the texts that agents read. Read it before you change one.

Reference docs, for when your work touches the topic:

| Doc | Topic |
| --- | --- |
| [`work-map.md`](work-map.md) | Open work on scenes, speed and the voice, in batches. |
| [`one-world-architecture.md`](one-world-architecture.md) | How worlds (three.js on the board) work. |
| [`playback-pitfalls.md`](playback-pitfalls.md) | Known failure classes of scene sampling and playback. Read it when an animation glitches. |
| [`agent-ink.md`](agent-ink.md) | The pen recipe of agent ink, with every parameter. |
| [`baseline.md`](baseline.md) | How we measure agent behaviour (trace, bench, scenarios) and the results. |
| [`release-guide.md`](release-guide.md) | The build, signing, GitHub release and website download steps. |
| [`website-plan.md`](website-plan.md) | The website in `apps/website/`. |
| [`launch-qa-2026-11-08.md`](launch-qa-2026-11-08.md) | The first-user check of the release and its open issues. |
| [`strategy.md`](strategy.md) | The founder's view of the bet, the core loop and how we grow. |
| [`competitors.md`](competitors.md) | Studies of products near Askaboard, with sources. |
| [`in-app-agent-idea.md`](in-app-agent-idea.md) | The idea to try after the launch: the agent works inside the app. |
| [`history/`](history/) | Finished plans, logs, research, drafts and old status tables. Read them for the reasons behind a decision. |

The brand kit is in [`../assets/brand/README.md`](../assets/brand/README.md) (D18, D20).

## Status (2026-11-08)

Done:

- **The app.** A learning folder with many boards, ink with pressure, and one editable document per board (ink, frames, text with math, SVG, images). Agents see the board through the MCP server (screenshots, changes, board news, I4).
- **Agent texts.** The brief v18 and the tool texts are in Anthropic's style (I16–I22, I31). The scene tools are `write_scene`, `preview_scene` and `play_scene` (T16).
- **Scenes.** Scenes are JavaScript files that stream to the board (T25–T32, T36, T37). A world is the only way to run code on the board (P18, P19), and toon is its only look (P22).
- **Voice.** The app reads `say()` lines aloud through our voice server, or with a local Kokoro voice (T34, T39, T40). The voice explainer is parked (I28).
- **Controls and chrome.** Mouse and trackpad tools (B69–B71, U10, U13, U18), the left panel (U6, U7), and the title row and Settings (U9–U17).
- **Launch.** Askaboard 0.1.0 is published as [`v0.1.0`](https://github.com/Nordup/askaboard/releases/tag/v0.1.0), notarized (D7, D14, D20). Plugins 0.1.4 are pushed. The backend runs at `https://api.askaboard.com` (P25, D23). Usage data goes to PostHog (P24). The website is live at `https://askaboard.com` (D8, D22). The repo is public, with the T3 Code layout (D21, D24).
- **Linux.** The app runs from source on Linux (D6). It is not checked on KDE, X11 or with a pen tablet.

Open:

- A clean-Mac install check of the release ([`launch-plan.md`](launch-plan.md), item 8; [`launch-qa-2026-11-08.md`](launch-qa-2026-11-08.md)).
- The "Later" list of [`launch-plan.md`](launch-plan.md): search indexing, the Claude Desktop extension, guide pages on the website, the voice price change before 2027-01-01.
- Open batches of [`work-map.md`](work-map.md).

The full status table of 2026-11-08, with all measurements, is in [`history/status-2026-11-08.md`](history/status-2026-11-08.md). The paused tutor and the iPad client are in the git history only (D24).

## How to keep these docs current

- **A decision** goes into [`decisions.md`](decisions.md), in the same commit as the change. Never delete a decision. Mark a replaced decision "Replaced" and name the new one.
- **The roadmap and open work** go into [`launch-plan.md`](launch-plan.md) or [`work-map.md`](work-map.md).
- **A plan or a log moves to `history/`** when its work is done, when a new plan replaces it, or when it is a dated record. Use `git mv` and keep the file name. Then fix the links to it.
- **A draft** goes into `history/drafts/` only when the founder wants to keep it.
- **This file** keeps a short status. Put the details in the linked doc.
- **At the end of a working session**, run the `session-wrap-up` skill ([`../.claude/skills/session-wrap-up/SKILL.md`](../.claude/skills/session-wrap-up/SKILL.md)).

## Related places

| Place | What |
| --- | --- |
| `apps/desktop/` | The Electron app. Its README covers running and dev automation. |
| `github.com/Nordup/askaboard-plugins` (checkout `../learning-space-plugins`) | Plugins for Claude Code, ChatGPT and Codex, Cursor; the Claude Desktop extension. |
| `apps/desktop/resources/learning-folder/` | The template copied into a learning folder at setup (`AGENTS.md`, `plan.md`, `learner.md`). |
| `apps/desktop/resources/brief.md`, `guide.md`, `instructions.md`; tool descriptions in `apps/desktop/src/main/mcp.ts` | The brief (`get_brief`), the board reference in topics (`get_guide`, decision T11), the server instructions and the tool descriptions. |
| `docs/reference/paper/` | Paper's agent interface, captured live. Local only (git-ignored). |
| `~/Projects/learning/learning-space` | The founder's own learning folder. Never use it for checks. |

## Glossary

| Term | Meaning |
| --- | --- |
| Seed | A moment of a dynamic object that runs in `write_scene`, before the reply. The end seed is the final state. |
| Sweep | The one forward pass over all moments of a scene, after the reply. |
| `readyThrough` | The time up to which every moment of a scene is complete on the board. The scene clock holds there. |
| Late note | What a sweep finds after the reply (a failure, a recipe that depends on call order, a log). It goes out in the next tool result. |
| Agent | An external AI program connected over MCP: Claude Code, Claude Desktop (chat), ChatGPT and Codex. |
| Learning folder | The folder that holds all learning: `AGENTS.md`, `plan.md`, `learner.md`, `sessions/`, `topics/`, `materials/`, `boards/`, `assets/`. The app keeps its own data in `.askaboard/`: scene records, code copies and voice clips. |
| Board | One `*.board.json` file: a document of items. `list_boards`, `open_board` and `move_board` work on boards; the other read tools work on the open board. |
| Item | One object on a board: `ink`, `shape` (the learner's rectangle, ellipse, arrow or line), `frame`, `text`, `svg`, `image` or `live`. The agent texts say "item" (decision T21); the board file and the code call it a node, as in `board.node(id)`. |
| Part | The address word of `list_items` and `get_screenshot`: "view", "board", a region, ids, a scene, or an interval of changes (decision T20). |
| Draft | A scene that `write_scene` made and the learner does not see yet; `play_scene` "start" puts it on the board. Drafts live in app memory. |
| World | A board item a scene places with `world()`: plain three.js with no frame, on one GPU surface between the page content and the ink. It keeps running, follows the scene's clock, links to labels and arrows, and can take the learner's input. A world is the only way to run code on the board (decision P19), and toon is its only look (decision P22). |
| Lab switch | An environment flag that changes what agents see, for lab runs only: `LS_LAB_NO_CODE`, `LS_LAB_NO_HTML`, `LS_LAB_BRIEF` (council flags `--no-code`, `--no-html`, `--brief`). |
| Frame | A box item that holds other items (a card, a page). |
| Ink group | A cluster of the learner's strokes with a short id (`g1`, `g2`). Agents place things relative to it. |
| Folder guide | `.askaboard/guide.md` in a learning folder: `get_guide` topic `folder` (or, with `mode: replace`, the whole board reference). |
| Relay | The command `~/.askaboard/bin/askaboard mcp` that connects stdio clients to the app. |
| Agent pill | The status control in the top bar; it opens the agents list and the connect view. |
| Plugin | The package in the plugin repo that installs the connection (and a small skill) into an agent client. |
| Brief | `apps/desktop/resources/brief.md`: what the space is for and how agents think about their part. The main text agents read: in a learning folder's `AGENTS.md`, or with `get_brief` for agents without it. |
| Managed block | The part of a folder's `AGENTS.md` between the "askaboard brief" markers. The app keeps it equal to the brief unless the learner edits it. |
| Trace | The JSONL record of one agent session's MCP calls, in `~/.askaboard/traces/`. |
| Bench | `apps/desktop/scripts/bench/run.mjs`: fixed scenarios (S1–S4, P1–P3, V1, …) run by a headless agent (Claude or Codex), to measure a change. |
| Look ratio | Learner ink area ÷ the area of the agent's screenshot of it; 1.0 is a perfect crop. |
| Board news | One factual line that tells an agent app what the learner changed on a board since its last look (drew, erased, added, moved, resized, edited, deleted; a summary by area when there are many). Each change is delivered once (decision I4). |
| Last look | The point up to which an agent app knows the board's changes (the agent texts' word; the code calls it the change cursor). Results show it as c and a number, such as c336. `list_items` of the view or the board, `get_screenshot`, `get_changes` and `open_board` move it. Board news reports only the changes after it. |
| HTML material | What a scene's `html()` and `image()` make: the HTML converter's nodes (a root with its subtree). Drawn, its root fades in and its parts (the root's children) appear one after another. |
| Scene | A JavaScript program an agent writes with `write_scene` (a draft that the learner does not see) and plays with `play_scene`: it makes board items and a timeline of how they appear and change; the board plays it, and the items stay. |
| Stage | The one sandbox per board in which every scene program runs; the global `stage` keeps values and objects between programs. |
| Beat | A short scene (one sentence and its drawing) sent while another plays; scenes queue and follow each other without a gap. |
| Text line (`say`) | A sentence in a scene, shown to the learner in the reading panel, at a reading pace or, with the voice on, at the pace of its audio (T34). Each line belongs to the step whose time contains it. |
| Voice clip | One WAV file for one scene's lines in `.askaboard/voice/`, with a JSON file of the line places. The scene record keeps the answers, so a replay makes no API call. |
| Reading panel | The floating panel over the board for one scene (code: `ScriptPanel.tsx`): a step bar, the scene's lines as a slow teleprompter with a light on the words being read, replay step, pause and next. It fades after the scene and hides into the scene pill (decisions B19, B21). |
| Scene pill | The pill in the top bar: the playing scene, else the board's last scene, else a selected item's scene and step. Its menu lists the board's scenes. |
| Scene file | A scene program as a JavaScript file in `boards/scenes/`, with `import` and `export` (decision B16). |
| Scene record | The append-only history of a board's scenes in `.askaboard/scenes/<board id>.jsonl`; agents read items by scene and step from it after a restart (`"synapse#2"`). |
| Lab | `apps/desktop/scripts/lab/`: an own app instance, scene recordings (MP4, filmstrip), beats, model councils and a gallery. |
| Council | A lab run in which a model works on a task with the scene tools and is then interviewed; its answers are customer proposals, not specs (decision W8). |
