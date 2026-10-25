# Learning Space — start here

Learning Space is a desktop app for learning with an AI agent on a shared
canvas. The learner writes and draws by hand; an external agent (Claude Code,
Claude Desktop, ChatGPT and Codex) connects over MCP, sees the board, and
creates and edits material on it. The app has no AI inside. All learning
lives in one local folder that the learner owns.

It is the third form of this project (iPad app → web client → Learning
Space) and, since 2026-10-24, **the main product** (decision P8). App code
in [`../../space/`](../../space/); work happens on `main`.

## Status (2026-10-25)

| Area | State |
| --- | --- |
| Learning folder, many boards, ink with pressure | Done |
| Agents see the canvas (MCP server, screenshots, changes) | Done |
| One editable document: ink, frames, text with math, SVG, images; HTML ⇄ nodes | Done |
| Agent tools in Paper's style, ink groups, relative placement, agent ink, focus | Done |
| Folder setup (`AGENTS.md` template), editable folder guide | Done |
| Public plugin repo, stdio relay, plugin-first Connect popover | Done |
| One shared design system for menus | Done |
| Measurement: session trace, trace report, bench (S1–S4; P1–P3 on a busy board; V1 "drew while talking"; Claude or the Codex/GPT client; `--no-news-hook`) | Done: [`baseline.md`](baseline.md) |
| Fix 1: the brief (`space/resources/brief.md`, managed block in `AGENTS.md`), new tool descriptions | Done and measured |
| Board news: the agent app gets one line about what the learner drew since its last look, delivered once (decision I4) | Done and measured: in V1 the agent looked at the sketch in 4 of 4 runs (0 of 2 before) |
| `get_brief` and `get_guide`, one job each (decision T11) | Done and measured |
| Brief v3: the section "Thinking with a pen" (decision I5) | Done and measured: GPT still builds a drawing in 2–3 SVG pieces, with no ink |
| Brief v4: scenes, living code items, the words beside the drawing (decision I6) | Done (2026-10-25); not yet measured with the brief alone |
| Live drawing: one drawing medium in code ([`live-drawing-plan.md`](live-drawing-plan.md), decisions P11, P12) | Stages 1–3 done (2026-10-25): `run_scene` and `scene_control`, values, labels, named groups, preview, camera, pointer, the stage and beats, live pixels and program items (WebGL, three.js, any library), text lines at a reading pace in a floating script panel (the app does not speak, decision T13). Results: [`live-drawing-log.md`](live-drawing-log.md). Next: the founder's testing, a feature freeze, polish |
| The animated build-up: older material (`draw_ink`, SVG) also builds up in front of the learner (decision P9) | Part of live drawing stage 4 |
| Perception (the old fix 2) | Mostly answered by board news; the rest deferred |
| Plain chat apps (ChatGPT web, Claude chat) with folder file tools | Later |
| App packaging, signing, auto-update | Later |
| Interactive embeds | Answered by program items (decision P12) |
| Deeper editing (shapes inside SVG, style inspector) | Much later |

The web client (`web/`), the tutor backend (`server/`) and the iPad client
(`MathTutor/`) are paused, not deleted.

Numbered work: "fix 1/2", "improvement 1–4" and plan "item" numbers name
work that [`plan.md`](plan.md) and [`baseline.md`](baseline.md) describe.

## Read in this order

1. [`idea.md`](idea.md) — the founder's original idea, part by part, in the
   founder's words. Why the app exists.
   - [`tutor-vision.md`](tutor-vision.md) — the founder's second message
     (2026-10-24), in the same form: the problems in the agent–canvas loop
     and the tutor the founder wants.
   - [`live-drawing-idea.md`](live-drawing-idea.md) — the founder's third
     message (2026-10-24): the choice of the first fixes, and the idea that
     agents draw with JavaScript strokes, played in sequences by a voice
     model (the idea that became live drawing; the app's own voice was later
     removed, decision T13).
   - [`live-drawing-plan.md`](live-drawing-plan.md) — the expedition plan
     (2026-10-25): one drawing medium in code, four stages, the lab and the
     model councils. [`live-drawing-log.md`](live-drawing-log.md) has what
     each stage built and measured, and the founder's reviews.
   - [`baseline.md`](baseline.md) — how we measure agent behaviour on the
     board (trace, bench, scenarios) and the results.
   - [`sessions-2026-10-24.md`](sessions-2026-10-24.md) — the founder's
     first real voice sessions after the brief: how the ChatGPT voice path
     works, what went well, and why the step-by-step drawing did not appear.
   - [`writing-agent-text.md`](writing-agent-text.md) — how to write and
     improve what agents read (the brief, instructions, tool descriptions),
     with the founder's own words. Read it before you touch any of them.
2. [`architecture.md`](architecture.md) — how the app fits together and
   where each thing lives.
3. [`design-system.md`](design-system.md) — the UI rules. Required before
   any UI change.
4. [`decisions.md`](decisions.md) — every decision, with the reason and the
   rejected alternatives.
5. [`working-guide.md`](working-guide.md) — how to build and check things
   here, the founder's preferences, and the pitfalls we hit.
6. [`research.md`](research.md) — what we learned about Paper, the agent
   clients, placement, and security.
7. [`plan.md`](plan.md) — the step plan, what each step delivered, and the
   "later" list.
8. [`drafts/`](drafts/README.md) — drafts of agent-facing text: the approved
   drafts and their history. They are not the live text.

Historical detail: [`step-3-research.md`](step-3-research.md) and
[`step-3-design.md`](step-3-design.md) (the editable-document design and how
the live-frame idea was rejected).

## Related places

| Place | What |
| --- | --- |
| `space/` | The Electron app. Its README covers running and dev automation. |
| `github.com/Nordup/learning-space-plugins` (checkout `../learning-space-plugins`) | Plugins for Claude Code, ChatGPT and Codex, Cursor; the Claude Desktop extension. |
| `space/resources/learning-folder/` | The template copied into a learning folder at setup (`AGENTS.md`, `plan.md`, `learner.md`). |
| `space/resources/brief.md`, `guide.md`, `instructions.md`; tool descriptions in `space/src/main/mcp.ts` | The brief (`get_brief`), the board reference in topics (`get_guide`, decision T11), the server instructions and the tool descriptions. |
| `docs/learning-space/reference/paper/` | Paper's agent interface, captured live. Local only (git-ignored). |
| `~/Projects/learning/learning-space` | The founder's own learning folder. Never use it for checks. |

## Glossary

| Term | Meaning |
| --- | --- |
| Agent | An external AI program connected over MCP: Claude Code, Claude Desktop (chat), ChatGPT and Codex. |
| Learning folder | The folder that holds all learning: `AGENTS.md`, `plan.md`, `learner.md`, `sessions/`, `topics/`, `materials/`, `boards/`, `assets/`. |
| Board | One `*.board.json` file: a document of nodes. |
| Node | One object on a board: `ink`, `frame`, `text`, `svg` or `image`. |
| Frame | A box node that holds other nodes (a card, a page). |
| Ink group | A cluster of the learner's strokes with a short id (`g1`, `g2`). Agents place things relative to it. |
| Folder guide | `.learning-space/guide.md` in a learning folder: `get_guide` topic `folder` (or, with `mode: replace`, the whole board reference). |
| Relay | The command `~/.learning-space/bin/learning-space mcp` that connects stdio clients to the app. |
| Agent pill | The status control in the top bar; it opens the agents list and the connect view. |
| Plugin | The package in the plugin repo that installs the connection (and a small skill) into an agent client. |
| Brief | `space/resources/brief.md`: what the space is for and how agents think about their part. The main text agents read: in a learning folder's `AGENTS.md`, or with `get_brief` for agents without it. |
| Managed block | The part of a folder's `AGENTS.md` between the "learning-space brief" markers. The app keeps it equal to the brief unless the learner edits it. |
| Trace | The JSONL record of one agent session's MCP calls, in `~/.learning-space/traces/`. |
| Bench | `space/scripts/bench/run.mjs`: fixed scenarios (S1–S4, P1–P3, V1, …) run by a headless agent (Claude or Codex), to measure a change. |
| Look ratio | Learner ink area ÷ the area of the agent's screenshot of it; 1.0 is a perfect crop. |
| Board news | One factual line that tells an agent app what the learner drew or erased on a board since its last look. Each change is delivered once (decision I4). |
| Change cursor | The point up to which an agent app knows the board's changes. Board news reports only the changes after it. |
| Last look | The agent app's last `get_screenshot` or `get_changes` on a board. It moves the change cursor. |
| Animated build-up | The planned stage 4 feature: older agent material (`draw_ink`, SVG from `write_html`) also builds up in front of the learner, through the scene engine (decision P9). |
| Scene | A JavaScript program an agent sends with `run_scene`: it makes board items and a timeline of how they appear and change; the board plays it, and the items stay. |
| Stage | The one sandbox per board in which every scene program runs; the global `stage` keeps values and objects between programs. |
| Beat | A short scene (one sentence and its drawing) sent while another plays; scenes queue and follow each other without a gap. |
| Text line (`say`) | A sentence in a scene, shown to the learner at a reading pace in the script panel; nothing is spoken. |
| Script panel | The floating, draggable panel over the board that shows a scene's steps and text lines and lets the learner replay a step. |
| Program item | A board item (`program()` in a scene) that runs a whole program of its own: Canvas 2D, WebGL, WebGPU, three.js, any library; it follows the scene's clock and writes its own interaction (decision P12). |
| Lab | `space/scripts/lab/`: an own app instance, scene recordings (MP4, filmstrip), beats, model councils and a gallery. |
| Council | A lab run in which a model works on a task with the scene tools and is then interviewed; its answers are customer proposals, not specs (decision W8). |
