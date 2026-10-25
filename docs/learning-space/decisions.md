# Learning Space — decision log

Every decision that shaped the app, with the reason and the alternatives
that were rejected. Newest decisions are at the end of each section. When a
decision changes, do not delete it: mark it **Replaced** and add the new
decision below it.

Dates are 2026-10-23 to 2026-10-24 unless stated otherwise.

## Product

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| P1 | The app has **no AI inside**. External agents (Codex, Claude Code, Claude Desktop, later ChatGPT) connect over MCP. | The founder observed that the agent apps already do conversation, research, voice and writing well. The missing part is a shared visual space. | Keep the built-in tutor backend (paused, not deleted). |
| P2 | **Paper (paper.design) is the reference product.** Copy its proven patterns instead of inventing new ones. | Paper is a canvas built for humans and agents together, and it has iterated on agent tools for a long time. | Designing the agent interface from scratch. |
| P3 | **Replaced by P7.** **The learner does the thinking.** Agents give hints and questions first, and point at the exact step. | Carried over from `../product-vision.md`. It is in the board guide, the skill and the `AGENTS.md` template. | An answer-giving assistant. |
| P4 | **One learning folder holds all learning,** local first, synced with Git by the founder. The folder is the memory. | The founder already works this way with Codex in a folder. Files are portable and readable by any agent. | A database, as in the old tutor; cloud storage now. |
| P5 | **Any subject.** No subject-specific features. | The founder learns many subjects (astronomy, nuclear physics, maths). | A maths-only tool. |
| P6 | **Replaced by P8.** **Experiment on its own branch** `learning-space`, cut from `codex/web-client`. | The founder asked for an experiment. The web board code was on that branch. | Working on `main` or on `codex/web-client`. |
| P7 | **A shared space for learning with a smart model; the role follows the learner's intent** (2026-10-24). A tutor that holds back answers is one role. Others are an explainer that gives material, a partner to argue or reason with, or a judge of a drawing. The agent reads which one the learner wants. | The founder: "we shouldn't always say that you're a teacher … there are different roles what a person could want." The goal is a space to learn with a model that draws and explains what is easier to see than to hear. | A fixed tutor role with hints first (P3). |
| P8 | **Learning Space is the main product** (2026-10-24). The branch `learning-space` merges into `main`; work continues on `main`. The iPad, web and server tutor stay paused, not deleted. | After the brief (fix 1) the founder watched an agent draw and explain a sphere step by step and judged it far better than anything the iPad tutor did. | Keeping Learning Space as an experiment beside the built-in tutor (P6). |
| P9 | **Direction (order changed by P10): the step-by-step build-up becomes a property of the app, not a habit of the model** (2026-10-25). The app draws agent material in front of the learner (the animated build-up, `plan.md` item 1). **The mockup is not approved yet.** | With the same brief and tools, GPT writes a drawing as 2–3 SVG pieces and draws no ink, and Claude builds it in ~14 pieces, mostly ink, but slowly (`baseline.md`). More brief text cannot make two models behave the same. | More brief text about the build-up; tool rules that force small writes. |
| P10 | **Live drawing comes before the animated build-up** (2026-10-25). The JavaScript stroke-drawing experiment (`plan.md` item 1) runs first; the animated build-up follows and is designed on the engine that the experiment gives. | The founder: the build-up "should come after testing the live drawing with JavaScript, because on that depends how the engine's gonna look like". A build-up made now for SVG and ink could be replaced by the drawing engine. | The animated build-up first (P9 as written on 2026-10-25). |
| P11 | **One drawing medium in code** (2026-10-25). The agent writes a JavaScript program that makes board items (ink, vector shapes with fills, text, live canvases and shaders, later 3D) and a timeline of changes to them and to items already on the board. The program runs in a sandbox; the app keeps the clock and plays the timeline; the result stays as editable board items. Plan: `live-drawing-plan.md`. | The founder: a medium "flexible as a canvas, even as a shader", animation and control "as powerful as possible", "all that should be just in code". Research (`research.md` §15): videos made by agents take minutes and are fixed; iframes are opaque (B5); no canvas product has a timeline for objects. A program that returns data keeps the board editable and lets the app pause, step and replay. | A stroke-only pen API (`live-drawing-idea.md`); opaque live HTML frames (B4); rendered videos (HyperFrames, Remotion, Manim). |

## Platform

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| A1 | **Electron + Vite + React + TypeScript**, macOS first. | Paper is Electron. Electron gives full file access, a Node process for the MCP server, and pixel capture of any region. | Tauri (no region capture without native code); a browser-only app (cannot capture HTML content, no file access). |
| A2 | **Reuse ink code from `web/src/board/` by copying,** not importing. | The products diverge; the paused web client must not break. | A shared package. |
| A3 | **MCP server inside the main process,** Streamable HTTP on `127.0.0.1:47821/mcp`. Host and Origin checks; no token. | Same model as Paper. A web page cannot reach it (Origin/Host checks). A local program could already read the folder directly, so a token adds little. | A token in every client config (setup friction). Revisit if the server is ever exposed (ChatGPT tunnel). |
| A4 | **A stdio relay command** `~/.learning-space/bin/learning-space mcp`, rewritten by the app on every launch. | Claude Code plugins, Cursor and the Claude Desktop extension start a command. The relay lists tools from a cache when the app is closed and reconnects when it opens. Same model as Paper's `~/.paper/bin/paper mcp`. | HTTP only (the Claude Desktop chat cannot use a local URL). |
| A5 | **Dark theme only,** an IDE-like look close to Codex, Claude Desktop and Paper. Designed in code, not in Paper. | The founder's taste; no Paper subscription. | A light theme; reusing the iPad design. |

## The board

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| B1 | **Many boards per folder.** A board is any `*.board.json` file; new boards go to `boards/`. | The founder asked for many boards; the folder structure stays free. | One board per folder. |
| B2 | **Board file: one node per line,** rounded numbers, camera not stored. | Small Git diffs; the camera would change the file on every pan. | Pretty-printed JSON; camera in the file. |
| B3 | **Every item has a `seq`; removals leave tombstones.** `since` is exclusive. | Agents need "what changed since I last looked", including erased ink. | Whole-board hashes (the old tutor's approach). |
| B4 | **Replaced:** live HTML frames in sandboxed iframes. | First proposal: unlimited, interactive material. | — |
| B5 | **One editable document of nodes** (`ink`, `frame`, `text`, `svg`, `image`). Agent HTML is **converted** into nodes, as in Paper. The learner and the agent have the same rights on every node. | The founder tried live frames and found them rigid and uneditable. A live test of Paper showed that Paper converts HTML too (scripts and classes do not survive). Conversion gives full control over rendering and editing. | Live iframes (B4); Paper-style conversion with no ink. |
| B6 | **A node's style is a whitelisted CSS object** that maps 1:1 to inline CSS. The browser does flex layout. | HTML ⇄ nodes conversion becomes trivial in both directions; no custom layout engine. | A custom style model. |
| B7 | **Ink drawn on a frame becomes its child** and moves with it. | Removes the "rigid" feeling: material and the learner's notes are one object. | Loose ink only. |
| B8 | **Interactive embeds (live, sandboxed HTML) come much later,** as a separate node kind. CDN libraries and HTTPS images will be allowed then. | The founder wants interactivity eventually, but editability first. | Interactivity now. |

## Agent tools

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| T1 | **Paper's tool shapes:** `get_tree`, `get_node_info`, `get_html`, `write_html` (insert_children / replace), `update_styles`, `set_text`, `move_nodes`, `duplicate_nodes`, `delete_nodes`, `finish_working`, `get_screenshot`, `get_guide`. Our own wording. **The `get_guide` part: see T11.** | Proven with real agents. | A new tool vocabulary. |
| T2 | **Additions Paper lacks:** region screenshots, measured bounds in every write result, ink groups, relative placement, `find_space`, overlap reports, `draw_ink`, `focus`. | Learning needs precise pointing at the learner's work. | Coordinates only. |
| T3 | **Screenshots are real pixels** from a hidden snapshot window that renders any region, also off screen. | Content nodes are DOM; an ink-only render missed them. | `capturePage` of the visible window only. |
| T4 | **Ink groups `g1`, `g2`, …** with stable ids; agents place things relative to them. | Models place by reference far better than by coordinates (research: tldraw, 2026 papers). | Raw coordinates. |
| T5 | **Overlaps are reported, not blocked.** | Agents sometimes mark the learner's work on purpose (`place: over`). | Hard refusal (the old tutor). |
| T6 | **`focus` never moves the view while the learner writes.** | The learner keeps control of the camera. | Free camera moves. |
| T7 | **Every agent write is one undo step** for the learner. | The learner can always take back what the agent did. | Per-node history. |
| T8 | **All agent-controlled sizes are bounded** (`src/shared/limits.ts`), checked in the MCP schema and again in the renderer. | A buggy agent must not freeze the canvas. | Trusting agent input. |
| T9 | **Image downloads:** https only, private and local addresses refused per hop, the checked IP pinned, no cookies, image types only, size cap. | Agents choose URLs; the app must not become a local network probe. | Plain `fetch`. |
| T10 | **Replaced by T11.** **`get_guide` becomes `get_brief`, with one job** (2026-10-25): it takes no parameters and returns the brief (`brief.md`) plus the folder's `.learning-space/guide.md`, for agents that do not have the folder's `AGENTS.md`. The board reference (`resources/guide.md`, removed) moved into the descriptions it belongs to: the HTML subset, styles, math, SVG, images and colour tokens into `write_html`; ink into `draw_ink`; placement into the `place` parameter; ink groups into `get_canvas_info`. Every tool description stays under 4,096 characters (Claude Code's cut for tools loaded up front). | Agents with the brief in `AGENTS.md` still called `get_guide` for the reference, 1–3 extra rounds a session, and rounds drive latency. Paper keeps its rules in a guide tool, but no Paper source states why (capture in `reference/paper/`, `paper.design/docs/mcp`, `paper-design/agent-plugins`, checked 2026-10-25). The likely reason is size: Paper's guide is about 20,000 characters, as large as all 37 of its descriptions together, and no description could hold it. Our reference was about 7,000 characters, so it fits in the descriptions; the cost is about 4,500 more characters in every request's tool list. | Keep the reference topics (extra rounds); put the reference in the server instructions (cut at 4,096 and shared with the orientation); put it in the brief (behaviour and facts mixed, I1). |
| T11 | **Two tools, one job each: `get_brief` and `get_guide`** (2026-10-25, replaces T10): `get_brief` takes no parameters and returns only the brief (`brief.md`), for agents without the folder's `AGENTS.md`. `get_guide` returns the board reference (`resources/guide.md`, restored) by `topic`, as Paper's `get_guide` does: its description lists every topic with a one-line summary (model, html, math, svg, images, tokens, placement, ink, view); without a topic it returns all of it. The brief is not a topic. The folder's `.learning-space/guide.md` is the topic `folder` (with `mode: replace`, the whole reference), so agents in the folder, which never call `get_brief`, also read it. Tool descriptions are lean again and follow Anthropic's guidance (what the tool does, when it fits, each parameter, what it returns), and name the topic for details. Style names work in kebab-case and camelCase. | The founder: two tools, one job each; the separate guide gave better boards (GPT bench, `baseline.md`, the last two sections). | The reference in the tool descriptions (T10); one guide with the brief as a topic (before T10); the whole reference in one call as the main way. |

## Folder and instructions

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| F1 | **Folder setup is offered, never automatic.** A quiet sidebar row opens a menu with the file list. | The founder sometimes opens folders by mistake. | Automatic setup; a modal card on the canvas (too loud). |
| F2 | **One instruction file: `AGENTS.md`** in the learning folder. No `CLAUDE.md`. | Codex reads `AGENTS.md`; Claude Code reads it natively since v2.1.277 when no `CLAUDE.md` exists. | Both files. |
| F3 | **The board guide is editable per folder** (`.learning-space/guide.md`, `instructions.md`; `mode: replace` allowed). Since T11, `guide.md` is `get_guide` topic `folder` (or, with `mode: replace`, the whole reference). A sidebar mark shows when it is active. | The founder iterates on prompting without rebuilds. The mark keeps a foreign folder from changing agent behaviour unnoticed. | Guide only in code. |
| F4 | **Dropped:** `save_snapshot` (board images into files). | The founder did not want it. | — |
| F5 | **Deferred:** folder file tools (`list_files`, `read_file`, `write_file`) for agents outside the folder. | Codex and Claude Code already have file access in the folder. Needed only for plain chat apps. | Building them now. |

## Talking to agents

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| I1 | **Agent-facing text explains intent and purpose to an intelligent agent; it does not set limits** (2026-10-24). No word budgets, no "allowed / not allowed" lists, no warnings in tool results that police style. The text says what the space is for, what each medium is good for, and why, as one would brief a capable person. | The founder: the agent writes text-heavy cards because "we haven't explained it correctly" (the guide's workflow starts with a card), not because models need control. Models act on intent, and they get more capable every few months, so the wording matters more over time. Hard rules make the space inflexible. | Word limits and style reports in write results (proposed for fix 1 and rejected). |
| I2 | **One story across every agent-facing surface:** the brief (`brief.md`, see I3), the server instructions (`instructions.md`), the board reference (`guide.md`, `get_guide`, T11), the tool descriptions (`mcp.ts`), the plugin skill and the folder `AGENTS.md` template. | The agent reads all of them; mixed messages (for example a card-first workflow next to "do not reuse one card layout") confuse it. | Fixing one file at a time. |

| I3 | **The brief has one source, `space/resources/brief.md`, and reaches agents two ways** (2026-10-24): as a managed block in the learning folder's `AGENTS.md` (always in context for Codex and Claude Code) and with `get_brief` for agents outside a folder (T11; first built as `get_guide` topic `brief`). The block's start line carries a hash of the body the app wrote; the app rewrites the block when the folder opens and the brief is newer, and leaves it alone when the learner edited it. Server instructions stay a short orientation; tool descriptions hold facts only. | Claude Code cuts server instructions at 4,096 characters; Codex loads `AGENTS.md` up to 32 KiB. A copy made once at setup would go stale in every existing folder. The learner keeps everything outside the block. | The brief in server instructions (cut); a one-time copy in `AGENTS.md` (stale); an import (Codex has none). |
| I4 | **Board news, delivered once** (2026-10-25): when the learner drew or erased strokes, the agent app gets one factual line ("Board news for "Stars", since your last look or news 2 min ago: the learner drew 9 strokes: ink group g12 (…) right of your SVG …"): through the plugins' `UserPromptSubmit` hook (`learning-space news --client <label>`, route `GET /news`) before the prompt, or as the first line of its next tool result. Each change is delivered once per agent app and board (kept across connections and restarts); a look (`get_screenshot`, `get_changes`) also counts as delivered. A new connection's change cursor starts at the app's last look. | Real session 1 and the V1 baseline: the learner drew while talking, the request did not mention the board, and the agent made no tool call at all. Only a push before the prompt reaches an agent that does not call a tool. Once, not until looked at (founder, 2026-10-25): a line that repeats until the agent looks pushes it to look at changes that often do not matter, and costs context. | A sentence in the brief (cannot reach a turn with no tool call); news per MCP session (each `codex exec` / `claude -p` is a new session); repeating the line until the agent looks (built first, replaced the same day); instructions in the line (decision I1: facts only). |
| I5 | **Brief v3 adds "Thinking with a pen"** (2026-10-25): a short brief section describes the experience of a drawing that grows with the explanation. The agent chooses to build a figure in a few steps or to place it whole, when that serves the person better. | In the first real voice sessions the drawing arrived whole, and the learner saw no build-up (`sessions-2026-10-24.md`). Result on GPT: 3–5 pieces instead of 2, still no ink (`baseline.md`). | Drafts that the founder rejected: too specific or rigid (one drawing walked through step by step, `writing-agent-text.md`), too abstract, or biased towards ink. |

## Distribution

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| D1 | **A public plugin repo,** `github.com/Nordup/learning-space-plugins`, modelled on `paper-design/agent-plugins`: Claude Code, Codex and Cursor plugins, a Claude Desktop `.mcpb`, validators, CI. | Easy install and updates for other people later. | Copy-paste commands only. |
| D2 | **One version source** (`package.json`) synced into every manifest. | Paper's manifest versions drift; ours cannot. | Per-file versions. |
| D3 | **A small `learning-space` skill** in the plugin. | For agents opened outside a learning folder. Paper ships no skill; its instructions live in the MCP server, as ours do. | No skill; a large skill. |
| D4 | **The Connect popover is plugin-first.** Default view: the agents list. A second view installs the plugin (Claude Code, ChatGPT and Codex) or the extension (Claude Desktop) with one button each. Manual setup links to the plugin README. | The founder opens it once to install, then only to see agents. Hand-made entries and plugins together double the tools. | Hand-made `mcp add` buttons; long manual-setup text in the app. |
| D5 | **Deferred:** ChatGPT web/app (needs OpenAI's Secure MCP Tunnel or a public tunnel plus a token), app packaging and auto-update. | Not needed for the founder's daily use yet. | — |

## Design system

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| U1 | **One shared menu system** (`--menu-*` properties, shared parts, one small button). Every menu and popover is built from it. | Separate menus drifted apart; the founder wants one consistent look. | Per-menu CSS. |
| U2 | **Quiet UI:** one primary action per view, short labels, details behind a link or a second view. **Mock up first,** build after approval. | Two rejected designs had too much text and too many buttons. The mockup-first flow produced designs the founder approved. | Building first and fixing after. |

## How we work

| # | Decision | Why |
| --- | --- | --- |
| W1 | **No tests:** none written, none run (a hook blocks test runners). Verify by building and by using the real app. | Iteration speed (the founder's estimate: about 10x). |
| W2 | **Opus subagents implement** (medium effort, one or two at a time); **Haiku subagents read, research and check;** implementation subagents start their own Haiku agents. | Cost and context. |
| W3 | **The main session never runs hands-on checks.** A failing check gets its cause fixed or reported. | A main-session click-through cost about 50k tokens of main-model input. |
| W4 | **Checks run in dev mode too** (React StrictMode). | A dev-only bug once passed every built-app check. |
| W5 | **Agents drive the app with `space/scripts/drive.mjs`,** not computer use. | Background computer use cannot drag on a window that is not in front, and subagents cannot approve full-screen control. |
| W6 | **Measure changes to agent behaviour** (2026-10-24): an always-on session trace (`~/.learning-space/traces/`, every MCP call with timing, the screenshots agents received, the learner's edits) and a bench of 4 fixed scenarios run by a headless agent, twice, before and after a change. Results in `baseline.md`. | The founder could not tell why the product felt bad; numbers and board images made the effect of the brief visible. The trace stays on the founder's machine; nothing is sent anywhere. |
| W7 | **Live drawing is explored on the branch `live-drawing`** (2026-10-25), an exception to work on `main` (P8). Stages 1–2 merged into `main` on 2026-10-25 at the founder's request ("the videos are astonishingly good"); each later stage merges into `main` when it is built and measured. | The founder asked for a branch for an ambitious experiment that may fail. | Work on `main`. |
