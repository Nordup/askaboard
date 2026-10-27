# Learning Space — start here

Learning Space is a desktop app for learning with an AI agent on a shared
canvas. The learner writes and draws by hand; an external agent (Claude Code,
Claude Desktop, ChatGPT and Codex) connects over MCP, sees the board, and
creates and edits material on it. The app has no AI inside. All learning
lives in one local folder that the learner owns.

It is the third form of this project (iPad app → web client → Learning
Space) and, since 2026-10-24, **the main product** (decision P8). App code
in [`../../space/`](../../space/); work happens on `main`.

## Status (2026-10-27)

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
| The brief (`space/resources/brief.md`) | **v18** in Anthropic's style (decisions I16–I18, I20–I22): find out what the person wants, read their work, explain by drawing one step at a time (with a calibration list of the defaults to avoid), what ink, code items and HTML are each for, explain fully then check, preview before the person sees a scene. Drafts and their history: `drafts/brief-v*.md`, [`live-drawing-log.md`](live-drawing-log.md) |
| Tool descriptions, server instructions, plugin skill and the board reference (`guide.md`) in Anthropic's tool style (decision I19) | Done (2026-10-26). The three scene tools keep the approved I19/I22 wording, with only the changes the new tools need (I25, 2026-10-27; founder review R1 done). How to change an agent text later: [`writing-agent-text.md`](writing-agent-text.md), "Change an agent text without losing its intent or its voice" |
| Live drawing: one drawing medium in code ([`live-drawing-plan.md`](live-drawing-plan.md), decisions P11–P13) | Stages 1–4 done: scenes are the one way to write: `write_scene`, `preview_scene` and `play_scene` (T16; 12 tools); values, labels, named groups, preview, camera, pointer, the stage and beats, program items (WebGL, three.js, any library), `html()`, `image()`, edits, a floating script panel (the app does not speak, T13). Measured (2026-10-26, everything on): both GPT and Claude draw the EM wave in ink, step by step, with handwritten labels; GPT previews; Claude explains fully, then asks; practice sheets still use HTML |
| Lab switches for experiments: `council.mjs --no-code`, `--no-html`, `--brief <draft>` (`space/src/main/lab-switch.ts`) | Done; see [`working-guide.md`](working-guide.md), "Choosing lab tests" |
| Feature freeze (2026-10-26) | On: the founder tests everything by hand (code items, shaders, the other media) and fixes what gets in the way. Next direction: the voice loop, a voice model and the scene driving each other ([`plan.md`](plan.md), "Current focus") |
| First real test (2026-10-26) | Done: one hour on neurons by voice; the synapse mechanism clicked for the founder for the first time. The founder calls the app an MVP, but not yet for friends ([`first-test-2026-10-26.md`](first-test-2026-10-26.md)). Gaps G1–G6 and the order of work: [`first-test-gaps.md`](first-test-gaps.md); G1 (voice ⇄ scene) is the next milestone |
| Scene speed (2026-10-26/27): the stage in V8 in a sandboxed process (T18), live items on one contract (B10), playback cost (B11), one compile per draft (B12), typed frames over a direct port (B13), stage-made ink points (B14), pen ink on its shape (B15) | Done and measured ([`perf-plan.md`](perf-plan.md)): EM wave write_scene 7.6–15.1 s → 0.5–0.9 s, preview about 0.1 s, start under 0.1 s, playback frame work 5.7 → 2.6 ms. Known playback limits: [`playback-pitfalls.md`](playback-pitfalls.md). Open: the script panel hides material in the top-right corner ([`plan.md`](plan.md)) |
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
   - [`strategy.md`](strategy.md) — the founder's view (2026-10-26) of the
     bet, why the app alone is no moat, how we grow, and our values.
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
   - [`first-test-2026-10-26.md`](first-test-2026-10-26.md) — the
     founder's first real test (neurons and synapses, by voice): what
     clicked, what did not, and the founder's words. The founder calls the
     app an MVP. [`first-test-gaps.md`](first-test-gaps.md) has the six
     gaps (G1–G6) with facts, fixes and the order of work.
   - [`scene-redesign.md`](scene-redesign.md) — the scene redesign
     (2026-10-26): the measured flaws of `run_scene` and the other tools,
     what we want from a scene, three directions and the open questions.
   - [`perf-plan.md`](perf-plan.md) — the perf environment (`space/scripts/perf/`),
     the baseline numbers, the speed work of 2026-10-26/27 and its results.
   - [`playback-pitfalls.md`](playback-pitfalls.md) — the known failure
     classes of scene sampling and playback, where they live in the code and
     how to measure them. Read it when an animation glitches.
   - [`handoff/`](handoff/) — the context of long sessions, to continue after
     a compaction.
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
| Node | One object on a board: `ink`, `frame`, `text`, `svg`, `image` or `live`. |
| Code item | A live item a scene places with `program()`, `shader()` or `canvas()`: a program that keeps running on the board and can take the learner's input. |
| Lab switch | An environment flag that changes what agents see, for lab runs only: `LS_LAB_NO_CODE`, `LS_LAB_NO_HTML`, `LS_LAB_BRIEF` (council flags `--no-code`, `--no-html`, `--brief`). |
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
| HTML material | What a scene's `html()` and `image()` make: the HTML converter's nodes (a root with its subtree). Drawn, its root fades in and its parts (the root's children) appear one after another. |
| Scene | A JavaScript program an agent writes with `write_scene` (a draft that the learner does not see) and plays with `play_scene`: it makes board items and a timeline of how they appear and change; the board plays it, and the items stay. |
| Stage | The one sandbox per board in which every scene program runs; the global `stage` keeps values and objects between programs. |
| Beat | A short scene (one sentence and its drawing) sent while another plays; scenes queue and follow each other without a gap. |
| Text line (`say`) | A sentence in a scene, shown to the learner at a reading pace in the script panel; nothing is spoken. |
| Script panel | The floating, draggable panel over the board that shows a scene's steps and text lines and lets the learner replay a step. |
| Program item | A board item (`program()` in a scene) that runs a whole program of its own: Canvas 2D, WebGL, WebGPU, three.js, any library; it follows the scene's clock and writes its own interaction (decision P12). |
| Lab | `space/scripts/lab/`: an own app instance, scene recordings (MP4, filmstrip), beats, model councils and a gallery. |
| Council | A lab run in which a model works on a task with the scene tools and is then interviewed; its answers are customer proposals, not specs (decision W8). |
