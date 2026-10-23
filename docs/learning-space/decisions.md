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
| P3 | **The learner does the thinking.** Agents give hints and questions first, and point at the exact step. | Carried over from `../product-vision.md`. It is in the board guide, the skill and the `AGENTS.md` template. | An answer-giving assistant. |
| P4 | **One learning folder holds all learning,** local first, synced with Git by the founder. The folder is the memory. | The founder already works this way with Codex in a folder. Files are portable and readable by any agent. | A database, as in the old tutor; cloud storage now. |
| P5 | **Any subject.** No subject-specific features. | The founder learns many subjects (astronomy, nuclear physics, maths). | A maths-only tool. |
| P6 | **Experiment on its own branch** `learning-space`, cut from `codex/web-client`. | The founder asked for an experiment. The web board code was on that branch. | Working on `main` or on `codex/web-client`. |

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
| T1 | **Paper's tool shapes:** `get_tree`, `get_node_info`, `get_html`, `write_html` (insert_children / replace), `update_styles`, `set_text`, `move_nodes`, `duplicate_nodes`, `delete_nodes`, `finish_working`, `get_screenshot`, `get_guide`. Our own wording. | Proven with real agents. | A new tool vocabulary. |
| T2 | **Additions Paper lacks:** region screenshots, measured bounds in every write result, ink groups, relative placement, `find_space`, overlap reports, `draw_ink`, `focus`. | Learning needs precise pointing at the learner's work. | Coordinates only. |
| T3 | **Screenshots are real pixels** from a hidden snapshot window that renders any region, also off screen. | Content nodes are DOM; an ink-only render missed them. | `capturePage` of the visible window only. |
| T4 | **Ink groups `g1`, `g2`, …** with stable ids; agents place things relative to them. | Models place by reference far better than by coordinates (research: tldraw, 2026 papers). | Raw coordinates. |
| T5 | **Overlaps are reported, not blocked.** | Agents sometimes mark the learner's work on purpose (`place: over`). | Hard refusal (the old tutor). |
| T6 | **`focus` never moves the view while the learner writes.** | The learner keeps control of the camera. | Free camera moves. |
| T7 | **Every agent write is one undo step** for the learner. | The learner can always take back what the agent did. | Per-node history. |
| T8 | **All agent-controlled sizes are bounded** (`src/shared/limits.ts`), checked in the MCP schema and again in the renderer. | A buggy agent must not freeze the canvas. | Trusting agent input. |
| T9 | **Image downloads:** https only, private and local addresses refused per hop, the checked IP pinned, no cookies, image types only, size cap. | Agents choose URLs; the app must not become a local network probe. | Plain `fetch`. |

## Folder and instructions

| # | Decision | Why | Rejected alternatives |
| --- | --- | --- | --- |
| F1 | **Folder setup is offered, never automatic.** A quiet sidebar row opens a menu with the file list. | The founder sometimes opens folders by mistake. | Automatic setup; a modal card on the canvas (too loud). |
| F2 | **One instruction file: `AGENTS.md`** in the learning folder. No `CLAUDE.md`. | Codex reads `AGENTS.md`; Claude Code reads it natively since v2.1.277 when no `CLAUDE.md` exists. | Both files. |
| F3 | **The board guide is editable per folder** (`.learning-space/guide.md`, `instructions.md`; `mode: replace` allowed). A sidebar mark shows when it is active. | The founder iterates on prompting without rebuilds. The mark keeps a foreign folder from changing agent behaviour unnoticed. | Guide only in code. |
| F4 | **Dropped:** `save_snapshot` (board images into files). | The founder did not want it. | — |
| F5 | **Deferred:** folder file tools (`list_files`, `read_file`, `write_file`) for agents outside the folder. | Codex and Claude Code already have file access in the folder. Needed only for plain chat apps. | Building them now. |

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
