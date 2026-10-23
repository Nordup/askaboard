# Learning Space — start here

Learning Space is a desktop app for learning with an AI agent on a shared
canvas. The learner writes and draws by hand; an external agent (Claude Code,
Claude Desktop, ChatGPT and Codex) connects over MCP, sees the board, and
creates and edits material on it. The app has no AI inside. All learning
lives in one local folder that the learner owns.

It is the third form of this project (iPad app → web client → Learning
Space) and the active line of work: branch `learning-space`, app code in
[`../../space/`](../../space/).

## Status (2026-10-24)

| Area | State |
| --- | --- |
| Learning folder, many boards, ink with pressure | Done |
| Agents see the canvas (MCP server, screenshots, changes) | Done |
| One editable document: ink, frames, text with math, SVG, images; HTML ⇄ nodes | Done |
| Agent tools in Paper's style, ink groups, relative placement, agent ink, focus | Done |
| Folder setup (`AGENTS.md` template), editable board guide | Done |
| Public plugin repo, stdio relay, plugin-first Connect popover | Done |
| One shared design system for menus | Done |
| Tutor quality (prompting, visual variety) | The founder iterates |
| Plain chat apps (ChatGPT web, Claude chat) with folder file tools | Later |
| App packaging, signing, auto-update | Later |
| Interactive embeds (live HTML simulations) | Much later |
| Deeper editing (shapes inside SVG, style inspector) | Much later |

The web client (`web/`), the tutor backend (`server/`) and the iPad client
(`MathTutor/`) are paused, not deleted.

## Read in this order

1. [`idea.md`](idea.md) — the founder's original idea, part by part, in the
   founder's words. Why the app exists.
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

Historical detail: [`step-3-research.md`](step-3-research.md) and
[`step-3-design.md`](step-3-design.md) (the editable-document design and how
the live-frame idea was rejected).

## Related places

| Place | What |
| --- | --- |
| `space/` | The Electron app. Its README covers running and dev automation. |
| `github.com/Nordup/learning-space-plugins` (checkout `../learning-space-plugins`) | Plugins for Claude Code, ChatGPT and Codex, Cursor; the Claude Desktop extension. |
| `space/resources/learning-folder/` | The template copied into a learning folder at setup (`AGENTS.md`, `plan.md`, `learner.md`). |
| `space/resources/guide.md`, `instructions.md` | The board guide and server instructions every agent reads. |
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
| Board guide | The instructions agents read with `get_guide`; extendable per folder in `.learning-space/guide.md`. |
| Relay | The command `~/.learning-space/bin/learning-space mcp` that connects stdio clients to the app. |
| Agent pill | The status control in the top bar; it opens the agents list and the connect view. |
| Plugin | The package in the plugin repo that installs the connection (and a small skill) into an agent client. |
