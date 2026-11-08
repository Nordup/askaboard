# Askaboard

A shared space where a learner works through problems with an AI agent that
can see the board, draw on it, and talk. The goal is the learner's own
understanding, not finished answers. **Askaboard is the main product**
(decision P8, 2026-10-24); work happens on `main`. The founder's own
words in `docs/` come first.

**Now (2026-11-06/07): the launch.** Read
[`docs/launch-plan.md`](docs/launch-plan.md)
first: an open-source macOS app, the Askaboard name and brand (D18, D20), a voice server,
PostHog analytics and a new website.

**Start at [`docs/README.md`](docs/README.md).**
It gives the status, the reading order and a glossary. Before you change
any text that agents read (the brief, instructions, tool descriptions), read
`docs/writing-agent-text.md`.

## Where things live

| Path | What | Status |
| --- | --- | --- |
| `apps/desktop/` | Askaboard: Electron canvas app with no AI inside (except the voice, decision P1); agents connect over MCP | **Main product.** Docs in `docs/` |
| `../learning-space-plugins` | Public plugin repo (`github.com/Nordup/askaboard-plugins`): Claude Code, ChatGPT and Codex, Cursor plugins; Claude Desktop extension. Keep it a Codex plugin: no `plugin.json` or `mcp.json` at the plugin root (decision I30) | Active, separate repo |
| `../learning-space-backend` | Private backend repo (P25): FastAPI, Postgres and Caddy in Docker on the Hetzner box, `https://api.askaboard.com`. `POST /v1/speech` (the voice, a daily cap per user) and `POST /batch/` (usage data to PostHog). Deploy steps are in its README | Active, separate private repo |
| `apps/website/` | The Askaboard website (Next.js; D8, [`website-plan.md`](docs/website-plan.md)) | Active; Vercel deployment authorized |
| `assets/brand/` | Logo, icon and brand files | Active |
| `docs/` | Askaboard docs: status, plans, decisions, design and guides. Finished plans, logs, research and drafts are in `docs/history/` | Active |
| (git history) | The paused built-in tutor (`web/`, `server/`, `design/`, `scripts/`, its docs), the SwiftUI iPad client and the tutor's landing page | **Removed** from the tree 2026-11-08 (D24); restore from history if needed |

## Run it

```sh
cd apps/desktop && npm install && npm run dev   # dev app (React StrictMode); MCP on 127.0.0.1:47821
cd apps/desktop && npm run build                # type-check + bundle + relay
```

## Hard rules

- **No tests: do not write them and do not run them** (rule from 2026-10-23). The founder chose this for iteration speed (about 10x). Do not add test files, test scripts or test dependencies, and do not update existing tests. A hook blocks `pytest`, `vitest`, `jest`, `npm test`, `playwright test`, `xcodebuild test`/`build-for-testing` and `swift test`. Verify by building (`npm run build`) and by using the real app end to end (computer use, the built-in browser, the app's own MCP tools). The founder tests by hand and iterates fast.
- **Fix the bug class, not the instance.** Point guards get reverted. Restructure the unit so the failure is impossible.
- **The agents are part of the system we design** (decision W11). What they read, which tools and libraries they get, and how they write are ours to design, as the app is. Never answer a speed or quality question with "the app is not the slow part" or "that is model time": find the part of the loop that causes it, the agent's part included.
- **Askaboard UI is designed in code** under one design system (below and `docs/design-system.md`). Mock up a change and get the founder's approval before building it.
- **Record decisions.** A product or architecture decision goes into `docs/decisions.md` in the same commit; a replaced decision is marked "Replaced", not deleted.
- **Wrap up each working session** with the procedure in `.claude/skills/session-wrap-up/SKILL.md` (Claude runs it as the `session-wrap-up` skill; other agents follow the file): update the Askaboard docs and remove outdated lines.
- **The working tree is often dirty with the user's own work.** Never `git checkout`/`git restore`/`stash` a file to undo your edits — remove your own change with an edit. Re-read files before editing; the user edits and builds concurrently.
- **No check, test, debug or iteration images in git** (founder, 2026-10-29). `.gitignore` ignores images outside the asset folders; never `git add -f` an image. An approved design screenshot that should stay goes to `docs/design-images/`, and only when the founder asks for it.
- **Agent behaviour is tested and examples are made only through the lab** (founder, 2026-11-07). To see how an agent behaves in the app, or to make an example board (launch videos, demos), run `node scripts/lab/council.mjs --client claude --model opus --effort medium --brief-only --task "<the user's exact sentence>"` from `apps/desktop/` (details: `docs/working-guide.md`, "Choosing lab tests"). The prompt is only the sentence a real user would type; everything else comes from the app's brief, guide and MCP tools. Never build your own environment for an agent, and never give it a long prompt of your own. The learner's own work that a run starts from is a scene program that the app's own code turns into the learner's ink (`--learner-board`; decision D17). The website's use cases come from the lab too: the site plays the agent's own scene file, unchanged, with its voice, in the browser with JavaScript (`apps/desktop/scripts/lab/export-scene.mjs`; decisions D16, D17). Never record a video of a scene for the site.
- Ask before pushing.

## Askaboard UI (`apps/desktop/`)

- **Read `docs/design-system.md` before any UI change.**
- **Dark only, one design system.** App colours, spacing and radii come from `apps/desktop/src/renderer/src/styles/tokens.css`; the `--ls-*` tokens that agents use in board material live in `apps/desktop/src/renderer/src/board/content.css`. Never hard-code a colour or a spacing value in a component.
- **Every menu and popover uses the shared menu system** in `apps/desktop/src/renderer/src/styles/app.css` (comment block above `.menu`): the `--menu-*` custom properties set all spacing and type, and screens are built from the shared parts (`.menu__heading`, `.menu__title`/`.menu__lede`, `.menu__item`, `.menu__row`, `.menu__line`, `.menu__status`, `.menu__separator`, `.menu__footer`) and the one small button (`.btn-sm`, `.btn-text`). A menu component may set only its own position and width. A missing part is added to the shared system, not to one menu.
- **Keep it quiet:** one primary action per view, short labels, details behind a link or a second view. Mock up new UI first and get the founder's approval before building it.

# Agent coordination

How Claude sessions split work (Opus implements, Haiku reads and checks) is in `CLAUDE.md`.

# Deployment policy

- Never create, save, publish, or deploy this project through ChatGPT Sites or OpenAI Sites.
- Do not call Sites project, version, access, or deployment tools for this repository.
