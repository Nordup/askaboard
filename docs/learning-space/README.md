# Learning Space — start here

Learning Space is a desktop app for learning with an AI agent on a shared
canvas. The core loop: the agent explains on the board with animations while
the learner talks with it (decision P15). An external agent (Claude Code,
Claude Desktop, ChatGPT and Codex) connects over MCP, sees the board, and
creates and edits material on it; the learner can also write and draw by
hand. The app has no AI inside, except an optional speech call with the
learner's own key (T34). All learning
lives in one local folder that the learner owns.

It is the third form of this project (iPad app → web client → Learning
Space) and, since 2026-10-24, **the main product** (decision P8). App code
in [`../../space/`](../../space/); work happens on `main`.

## Now: the launch (2026-11-06 → 2026-11-07)

**Read [`launch-plan.md`](launch-plan.md) first.** It is the current plan:
an open-source macOS app for people who already pay for an agent app,
with a new name, a voice server, analytics and a new website (P23, D7).
Where another doc disagrees, the launch plan wins.

## Status (2026-11-03)

| Area | State |
| --- | --- |
| Learning folder, many boards, ink with pressure | Done |
| Agents see the canvas (MCP server, screenshots, changes) | Done |
| One editable document: ink, frames, text with math, SVG, images; HTML ⇄ nodes | Done |
| Agent tools in Paper's style, ink groups, relative placement, agent ink, focus | Done |
| Folder setup (`AGENTS.md` template), editable folder guide | Done |
| Public plugin repo, stdio relay, plugin-first Connect popover | Done. The Codex plugin connects over HTTP and must stay a Codex plugin (I30) |
| One shared design system for menus | Done |
| The app reads `say()` lines aloud (Gemini TTS, the learner's key; T34, [`voice-lines-plan.md`](voice-lines-plan.md)) | Done. The founder approved the agent texts and the sound. All seven Attention scenes are voiced with Charon. A scene written before the voice stays silent until one new `write_scene` |
| The app cleans up after itself (T35, `space/src/main/storage.ts`): clips, code copies, records of gone boards, traces, caches. A board moved to the Trash takes its data with it | Done. The running app gets it at its next start. Finder's Put Back is not confirmed. On Linux the board and its data go to the freedesktop Trash with `.trashinfo` files (checked 2026-11-02); a restore from Files is not confirmed |
| Measurement: session trace, trace report, bench (S1–S4; P1–P3 on a busy board; V1 "drew while talking"; Claude or the Codex/GPT client; `--no-news-hook`) | Done: [`baseline.md`](baseline.md) |
| Fix 1: the brief (`space/resources/brief.md`, managed block in `AGENTS.md`), new tool descriptions | Done and measured |
| Board news: the agent app gets one line about what the learner drew since its last look, delivered once (decision I4) | Done and measured: in V1 the agent looked at the sketch in 4 of 4 runs (0 of 2 before) |
| `get_brief` and `get_guide`, one job each (decision T11) | Done and measured |
| The brief (`space/resources/brief.md`) | **v18** in Anthropic's style (decisions I16–I18, I21, I22), with every medium an equal choice (I31): find out what the person wants, read their work, explain by drawing one step at a time (with a calibration list of the defaults to avoid), what ink, worlds and HTML are each for, explain fully then check, preview before the person sees a scene. Drafts and their history: `drafts/brief-v*.md`, [`live-drawing-log.md`](live-drawing-log.md) |
| Tool descriptions, server instructions, plugin skill and the board reference (`guide.md`) in Anthropic's tool style (decision I19) | Done (2026-10-26). The three scene tools keep the approved I19/I22 wording, with only the changes the new tools need (I25, 2026-10-27; founder review R1 done). How to change an agent text later: [`writing-agent-text.md`](writing-agent-text.md), "Change an agent text without losing its intent or its voice" |
| Live drawing: one drawing medium in code ([`live-drawing-plan.md`](live-drawing-plan.md), decisions P11–P13) | Stages 1–4 done: scenes are the one way to write: `write_scene`, `preview_scene` and `play_scene` (T16; 12 tools); values, labels, named groups, preview, camera, pointer, the stage and beats, worlds (three.js, any library), `html()`, `image()`, edits, a floating script panel (the app reads the lines aloud, T34). Measured (2026-10-26, everything on): both GPT and Claude draw the EM wave in ink, step by step, with handwritten labels; GPT previews; Claude explains fully, then asks; practice sheets still use HTML |
| Lab switches for experiments: `council.mjs --no-code`, `--no-html`, `--brief <draft>` (`space/src/main/lab-switch.ts`) | Done; see [`working-guide.md`](working-guide.md), "Choosing lab tests" |
| Feature freeze (2026-10-26) | On: the founder tests everything by hand (worlds and the other media) and fixes what gets in the way. The perf work ended with the board tools (T21). One board model and one copy of each piece of scene logic: done (2026-10-27). G6 is done (B16–B22); G1 is parked (I28, row below); all open work, in batches: [`work-map.md`](work-map.md) |
| First real test (2026-10-26) | Done: one hour on neurons by voice; the synapse mechanism clicked for the founder for the first time. The founder calls the app an MVP, but not yet for friends ([`first-test-2026-10-26.md`](first-test-2026-10-26.md)). Gaps G1–G6: [`first-test-gaps.md`](first-test-gaps.md) |
| Scene speed (2026-10-26/27): the stage in V8 in a sandboxed process (T18), one contract for running code (B10), playback cost (B11), one compile per draft (B12), typed frames over a direct port (B13), stage-made ink points (B14), pen ink on its shape (B15) | Done and measured ([`perf-plan.md`](perf-plan.md)): EM wave write_scene 7.6–15.1 s → 0.5–0.9 s, preview about 0.1 s, start under 0.1 s, playback frame work 5.7 → 2.6 ms. Known playback limits: [`playback-pitfalls.md`](playback-pitfalls.md). Agents see what the script panel and the tool palette cover (T19) |
| Streamed scenes (2026-10-30/31): `write_scene` replies after seeds, a forward sweep streams samples to the board while the scene may play, one clock holds at what is ready, a preview computes only its moments (T25-T32, [`streaming-scenes-plan.md`](streaming-scenes-plan.md)). `write_scene` on the 191 s scene: 34 s → about 0.1 s. | Done and pushed. The largest wait left is model time. |
| Scene starts and replays (2026-11-03): every run for the board streams, a replay rebuilds only up to its scene, and an earlier object joins a sweep only when the scene can change it (T36, T37) | Done. On Attention, a replay of a dropped scene went from 5.8–9.4 s to 0.64–0.85 s, and a start that runs again from 18–36 s of sampling to 0.12 s. Checked in the app: stop and cancel during a long stream, a sweep that fails while the scene plays or in a replay after a restart, a cut scene, and a replay by step name (6.5 s → 0.67 s). |
| What agents read (2026-10-27): four board reads with one `part` address, summaries first and "Deeper:" lines, no caps (T20); `list_items`, `list_boards`, `open_board`, `move_board`, strict parameters, one word for one thing in all agent texts (T21) | Done ([`perf-plan.md`](perf-plan.md), group 2): on a 1,000-stroke board `get_changes` since 0 went from 182,835 to 471 characters, the overview from 5,567 to about 620. Texts and results: [`drafts/boards-tool-texts-2026-10-27/final.html`](drafts/boards-tool-texts-2026-10-27/final.html) |
| Scene files (2026-10-28): scenes as JS files in `boards/scenes/` with import and export (B16 step 1, B17); the lab runs agents like the real apps (W10) | Done and measured: Opus and GPT write every scene by file; scene code 5.9k and 7.0k characters against 8.7k and 9.7k, nothing written twice |
| Batch 1 (2026-10-28): errors come back at once (a late one since T31: in the next tool result), every place takes a live position, no checks in the build and no warnings (B18), `play_scene` without a wait (T23); HTML notes removed; handwriting for Cyrillic, accents and maths signs (2026-10-29) | Done ([`work-map.md`](work-map.md), batches A and F) |
| Scene record and reading panel (2026-10-29): a history per board, reads by scene and step after a restart (B16 step 2, B20); the reading panel for one scene and the scene pill (B19), as a teleprompter with a simpler menu (B21) | Done, two Sol reviews: [`drafts/record-ui-2026-10-29/`](drafts/record-ui-2026-10-29/README.md) (screenshots local only). Replay after a restart re-runs the scene (step 3, B22, done 2026-10-29) |
| Voice explainer experiment (2026-10-29/30): the ChatGPT voice conducts the steps (hold mode, I26), then one new thing per turn (I27) | Failed in the founder's tests and reverted; **parked** (I28). Voice asks, the agent makes a complete scene, the learner takes their time. The agent texts went back to `c9285e0`; the step controls (next, pause, replay from any step, cut) stay. What we learned and how to try again in a few months: [`voice-test-2026-10-29.md`](voice-test-2026-10-29.md) |
| Competitor and strategy check (2026-10-29) | Clicky (heyclicky.com) launched real-time graphics for learning on the screen: [`competitors.md`](competitors.md). The plan stays (decision P15): the core loop is the agent's explanation with animations while the learner talks with it. Screen overlay, phone photos, a continuous tutor and other devices are later layers ([`strategy.md`](strategy.md), "After Clicky") |
| Tool text reaches Codex whole (2026-10-31): the plugin stopped being an Agent Plugin, which Codex cut at 1,000 bytes (I30, plugin 0.1.2); unknown scene options are errors (B24); batch G closed with no change to the guide (T33) | Done. Tested through the plugin with the app's Codex binary. Not yet seen in a real voice session, and the board news hook in Codex is not confirmed |
| One world on the board (P18) | All slices are built (B25), and a world is the only way to run code on the board (P19): [`one-world-architecture.md`](one-world-architecture.md), [`one-world-plan.md`](one-world-plan.md). The goal is P16. It replaces the scene library track (W12). Study and proof code: [`drafts/library-landscape-2026-10-31/`](drafts/library-landscape-2026-10-31/README.md). Saved results: [`design-images/2026-10-31-frameless-proofs/`](design-images/2026-10-31-frameless-proofs/). |
| Rendering, performance and data safety (2026-11-01) | Done on `main`. Worlds use the toon look, the only look since 2026-11-02, on `WebGLRenderer` (P20, P22, A9), and four outside reviews are fixed (B26-B53, A6-A8). Measured on the M1 Air against `d6b153c`: a pan of the big board takes the renderer from 105% to 24% CPU, a page paint from 3.4 ms to 0.3 ms, the GPU from 65% to 16%, and the worst frame from 96 ms to 20 ms. World speed and start-up did not change in this round, and memory on boards is 20 to 60 MB higher because of the ink tiles. Not checked on an Intel GPU or an iPad. |
| Text and ink without a pen (2026-11-03, B56–B61): all words on the board in the agent's hand (typed text, `text()`, `html()`), mouse ink with width from speed, text rotate and scale, keys to end a text edit, old-board sizes follow the new font, the board's 100% is the old 85% | Committed on `main` (`04a6408`); checked with simulated input. The founder's own hand is the real test: [`no-pen-notes-task.md`](no-pen-notes-task.md) |
| Screen size and zoom on Linux (2026-11-03, B63–B65) | Committed on `main`. View > Interface Size is a per-machine page zoom; Automatic is 120% when the OS scale is below 1.5 (the founder's 1080p monitors) and 100% on a 2x screen. Below 1.5 dppx the board uses a heavier cut of the hand with the same metrics. A Ctrl/⌘ mouse-wheel notch zooms 15% with an 80 ms glide; a pinch keeps its exact mapping. Research: [`research.md`](research.md) §22. Checked with CDP input, built and dev. Not checked: a real hardware wheel, the Mac, a window move between screens of different scales. |
| Linux (2026-11-02/03, decision D6) | The app runs on Linux from source, one code base with macOS: [`../../space/README.md`](../../space/README.md), "On Linux". Checked on Manjaro (GNOME, Wayland, AMD GPU) with Claude Code and Codex sessions that drew scenes. A covered Wayland window gets no display frames, so scene events (end, pause steps, the queue, the voice) now run on a timer (B62). Check instances run under XWayland. Not checked: a pen tablet, KDE, X11 sessions. The plugin repo's 0.1.3 (Linux in the `.mcpb` manifest) waits for a push. |
| Perception (the old fix 2) | Mostly answered by board news; the rest deferred |
| Plain chat apps (ChatGPT web, Claude chat) with folder file tools | Later |
| App packaging and signing (macOS) | Now: the launch (D7) |
| Interactive embeds | Answered by worlds (decision P19) |
| Deeper editing (shapes inside SVG, style inspector) | Much later |

The web client (`web/`), the tutor backend (`server/`) and the iPad client
(`MathTutor/`) are paused, not deleted.

Numbered work: "fix 1/2", "improvement 1–4" and plan "item" numbers name
work that [`plan.md`](plan.md) and [`baseline.md`](baseline.md) describe.

## Read in this order

0. [`launch-plan.md`](launch-plan.md) — the current plan: the launch of
   2026-11-06/07.
1. [`idea.md`](idea.md) — the founder's original idea, part by part, in the
   founder's words. Why the app exists.
   - [`strategy.md`](strategy.md) — the founder's view (2026-10-26) of the
     bet, why the app alone is no moat, how we grow, and our values; and
     (2026-10-29) the core loop, why the pen is not the core, and the later
     layers.
   - [`streaming-scenes-plan.md`](streaming-scenes-plan.md) — how scenes stream to the board, with the founder's words and the measures. Read it before you change sampling, frames or the player.
   - [`competitors.md`](competitors.md) — studies of products near Learning
     Space, with sources: Clicky (2026-10-29).
   - [`in-app-agent-idea.md`](in-app-agent-idea.md) — the idea to try after
     the launch (2026-11-06): the agent works inside the app, as in T3 Code.
   - [`tutor-vision.md`](tutor-vision.md) — the founder's second message
     (2026-10-24), in the same form: the problems in the agent–canvas loop
     and the tutor the founder wants.
   - [`live-drawing-idea.md`](live-drawing-idea.md) — the founder's third
     message (2026-10-24): the choice of the first fixes, and the idea that
     agents draw with JavaScript strokes, played in sequences by a voice
     model (the idea that became live drawing; the app's own voice was later
     removed, decision T13, and came back as an API voice, T34).
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
   - [`perf-plan.md`](perf-plan.md) — the goal (fast, smooth work with an agent),
     the four groups of causes, what is done and what is next, and the commits.
   - [`scenes-and-voice-plan.md`](scenes-and-voice-plan.md) — the plan for
     G1 and G6 (2026-10-27): what the scene code does today, bundle 1 (a
     scene is a story that lasts), bundle 2 (the voice leads the story) and
     its research, and the questions for the founder.
   - [`work-map.md`](work-map.md) — all open work on scenes, speed and the
     voice in batches (2026-10-28): where each comes from, what we have,
     the solution and how it helps; what is done so far.
   - [`voice-lines-plan.md`](voice-lines-plan.md) — how the app reads scene
     lines aloud: one speech request per scene, one clock, the reasons and the
     open items (T34). Read it before you change the voice.
   - [`one-world-plan.md`](one-world-plan.md) — the current direction: agents
     create anything on the board and link anything, in three steps (P18).
   - [`one-world-design.md`](one-world-design.md) — what a world is and how a
     scene links to it.
   - [`one-world-architecture.md`](one-world-architecture.md) — how worlds are
     built: the surface, the worker, one frame, links, replay and failure.
   - [`library-plan.md`](library-plan.md) — the scene library track (replaced
     by P18; history).
   - [`playback-pitfalls.md`](playback-pitfalls.md) — the known failure
     classes of scene sampling and playback, where they live in the code and
     how to measure them. Read it when an animation glitches.
   - [`no-pen-notes-task.md`](no-pen-notes-task.md) — tools for a learner with
     a mouse or a trackpad, with the founder's words and a study of
     Excalidraw (2026-11-03): what is built, what is open.
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
| Seed | A moment of a dynamic object that runs in `write_scene`, before the reply. The end seed is the final state. |
| Sweep | The one forward pass over all moments of a scene, after the reply. |
| `readyThrough` | The time up to which every moment of a scene is complete on the board. The scene clock holds there. |
| Late note | What a sweep finds after the reply (a failure, a recipe that depends on call order, a log). It goes out in the next tool result. |
| Agent | An external AI program connected over MCP: Claude Code, Claude Desktop (chat), ChatGPT and Codex. |
| Learning folder | The folder that holds all learning: `AGENTS.md`, `plan.md`, `learner.md`, `sessions/`, `topics/`, `materials/`, `boards/`, `assets/`. The app keeps its own data in `.learning-space/`: scene records, code copies and voice clips. |
| Board | One `*.board.json` file: a document of items. `list_boards`, `open_board` and `move_board` work on boards; the other read tools work on the open board. |
| Item | One object on a board: `ink`, `frame`, `text`, `svg`, `image` or `live`. The agent texts say "item" (decision T21); the board file and the code call it a node, as in `board.node(id)`. |
| Part | The address word of `list_items` and `get_screenshot`: "view", "board", a region, ids, a scene, or an interval of changes (decision T20). |
| Draft | A scene that `write_scene` made and the learner does not see yet; `play_scene` "start" puts it on the board. Drafts live in app memory. |
| World | A board item a scene places with `world()`: plain three.js with no frame, on one GPU surface between the page content and the ink. It keeps running, follows the scene's clock, links to labels and arrows, and can take the learner's input. A world is the only way to run code on the board (decision P19), and toon is its only look (decision P22). |
| Lab switch | An environment flag that changes what agents see, for lab runs only: `LS_LAB_NO_CODE`, `LS_LAB_NO_HTML`, `LS_LAB_BRIEF` (council flags `--no-code`, `--no-html`, `--brief`). |
| Frame | A box item that holds other items (a card, a page). |
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
| Board news | One factual line that tells an agent app what the learner changed on a board since its last look (drew, erased, added, moved, resized, edited, deleted; a summary by area when there are many). Each change is delivered once (decision I4). |
| Last look | The point up to which an agent app knows the board's changes (the agent texts' word; the code calls it the change cursor). Results show it as c and a number, such as c336. `list_items` of the view or the board, `get_screenshot`, `get_changes` and `open_board` move it. Board news reports only the changes after it. |
| HTML material | What a scene's `html()` and `image()` make: the HTML converter's nodes (a root with its subtree). Drawn, its root fades in and its parts (the root's children) appear one after another. |
| Scene | A JavaScript program an agent writes with `write_scene` (a draft that the learner does not see) and plays with `play_scene`: it makes board items and a timeline of how they appear and change; the board plays it, and the items stay. |
| Stage | The one sandbox per board in which every scene program runs; the global `stage` keeps values and objects between programs. |
| Beat | A short scene (one sentence and its drawing) sent while another plays; scenes queue and follow each other without a gap. |
| Text line (`say`) | A sentence in a scene, shown to the learner in the reading panel, at a reading pace or, with the voice on, at the pace of its audio (T34). Each line belongs to the step whose time contains it. |
| Voice clip | One WAV file for one scene's lines in `.learning-space/voice/`, with a JSON file of the line places. The scene record keeps the answers, so a replay makes no API call. |
| Reading panel | The floating panel over the board for one scene (code: `ScriptPanel.tsx`): a step bar, the scene's lines as a slow teleprompter with a light on the words being read, replay step, pause and next. It fades after the scene and hides into the scene pill (decisions B19, B21). |
| Scene pill | The pill in the top bar: the playing scene, else the board's last scene, else a selected item's scene and step. Its menu lists the board's scenes. |
| Scene file | A scene program as a JavaScript file in `boards/scenes/`, with `import` and `export` (decision B16). |
| Scene record | The append-only history of a board's scenes in `.learning-space/scenes/<board id>.jsonl`; agents read items by scene and step from it after a restart (`"synapse#2"`). |
| Lab | `space/scripts/lab/`: an own app instance, scene recordings (MP4, filmstrip), beats, model councils and a gallery. |
| Council | A lab run in which a model works on a task with the scene tools and is then interviewed; its answers are customer proposals, not specs (decision W8). |
