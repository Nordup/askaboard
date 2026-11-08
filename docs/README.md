# Askaboard docs: start here

This folder holds the reference docs for the agents and the contributors who
build Askaboard: how the app works, the decisions and their reasons, the
design system and the guides. These docs are not for users. Users get the
[website](https://askaboard.com) and the app.

Askaboard is a desktop app for learning with an AI agent on a shared board.
The agent explains on the board with animations, and the learner talks with
it (decision P15). An external agent (Claude Code, Claude Desktop, ChatGPT,
Codex) connects over MCP. The app has no AI inside, except the voice that
reads scene lines aloud (P1). All learning lives in one local folder that the
learner owns. The app code is in [`../apps/desktop/`](../apps/desktop/), and
work happens on `main`.

## Read in this order

1. [`architecture.md`](architecture.md): how the app fits together and where each part lives.
2. [`decisions.md`](decisions.md): every decision, with the reason and the rejected alternatives.
3. [`working-guide.md`](working-guide.md): how to build and check the app, the founder's preferences, and known pitfalls.
4. [`design-system.md`](design-system.md): the UI rules. Read it before any UI change.
5. [`writing-agent-text.md`](writing-agent-text.md): how to write the texts that agents read. Read it before you change one.

Reference docs, for when your work touches the topic:

| Doc | Topic |
| --- | --- |
| [`one-world-architecture.md`](one-world-architecture.md) | How worlds (three.js on the board) work. |
| [`playback-pitfalls.md`](playback-pitfalls.md) | Known failure classes of scene sampling and playback. Read it when an animation glitches. |
| [`agent-ink.md`](agent-ink.md) | The pen recipe of agent ink, with every parameter. |
| [`release-guide.md`](release-guide.md) | The build, signing, GitHub release and website download steps. |

The brand kit is in [`../assets/brand/README.md`](../assets/brand/README.md) (D18, D20).

## Plans, research and history are private

The maintainers keep the current plan, the roadmap, research, logs, drafts
and history in the private repo `Nordup/askaboard-notes` (decision D26). Its
checkout is next to this repo, at `../askaboard-notes/`. When that folder
exists, read `../askaboard-notes/launch-plan.md` for the current plan before
you start. Open work for contributors goes into
[GitHub issues](https://github.com/Nordup/askaboard/issues).

## How to keep these docs current

- **Public docs hold what the code cannot show:** decisions and their reasons, constraints and traps.
- **Plans, research, logs, drafts and screenshots** go to the private notes repo, not to this repo.
- **A decision** goes into [`decisions.md`](decisions.md), in the same commit as the change. Never delete a decision. Mark a replaced decision "Replaced" and name the new one.
- **At the end of a working session**, run the `session-wrap-up` skill ([`../.claude/skills/session-wrap-up/SKILL.md`](../.claude/skills/session-wrap-up/SKILL.md)).

## Related places

| Place | What |
| --- | --- |
| `apps/desktop/` | The Electron app. Its README covers running and dev automation. |
| `github.com/Nordup/askaboard-plugins` (checkout `../learning-space-plugins`) | Plugins for Claude Code, ChatGPT and Codex, Cursor; the Claude Desktop extension. |
| `github.com/Nordup/askaboard-notes` (checkout `../askaboard-notes`) | Private: the plan, the roadmap, research, logs, drafts and history. |
| `apps/desktop/resources/learning-folder/` | The template copied into a learning folder at setup (`AGENTS.md`, `plan.md`, `learner.md`). |
| `apps/desktop/resources/brief.md`, `guide.md`, `instructions.md`; tool descriptions in `apps/desktop/src/main/mcp.ts` | The brief (`get_brief`), the board reference in topics (`get_guide`, decision T11), the server instructions and the tool descriptions. |
| `docs/reference/` | Local notes on other tools. Local only (git-ignored). |
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
