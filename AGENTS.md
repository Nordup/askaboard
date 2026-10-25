# Learn AI (codebase name: MathTutor)

A shared space where a learner works through problems with an AI agent that
can see the board, draw on it, and talk. The goal is the learner's own
understanding, not finished answers. **Learning Space is the main product**
(decision P8, 2026-10-24); work happens on `main`. `docs/product-vision.md`
was written for the paused built-in tutor; for Learning Space, the founder's
own words in `docs/learning-space/` come first.

**Start at [`docs/learning-space/README.md`](docs/learning-space/README.md).**
It gives the status, the reading order and a glossary. Before you change
any text that agents read (the brief, instructions, tool descriptions), read
`docs/learning-space/writing-agent-text.md`.

## Where things live

| Path | What | Status |
| --- | --- | --- |
| `space/` | Learning Space: Electron canvas app with no AI inside; agents connect over MCP | **Main product.** Docs in `docs/learning-space/` |
| `../learning-space-plugins` | Public plugin repo (`github.com/Nordup/learning-space-plugins`): Claude Code, ChatGPT and Codex, Cursor plugins; Claude Desktop extension | Active, separate repo |
| `web/` | React/TypeScript/Vite client for the built-in tutor | **Paused** |
| `server/` | FastAPI tutor backend (Python, `uv`, Postgres/Neon); holds provider keys | **Paused** |
| `MathTutor/`, `MathTutorTests/`, `MathTutorUITests/` | SwiftUI iPad client | **Paused**, preserved |
| `design/`, `docs/design-system/` | Exports/transcriptions of the Paper design file (paused clients) | Generated — never the first thing you edit |
| `landing-page/`, `landing/` | Marketing page | Local-only (see Deployment policy) |
| `docs/` | Vision, TODO, research; `docs/learning-space/` for the active app; older specs under `docs/superpowers/` | |

## Run it

Learning Space:

```sh
cd space && npm install && npm run dev   # dev app (React StrictMode); MCP on 127.0.0.1:47821
cd space && npm run build                # type-check + bundle + relay
```

Paused tutor stack (only when working on it):

```sh
python3 scripts/web-dev.py        # web + API + local Postgres (port 55432); prints URL and access code
python3 scripts/web-dev.py --qa   # same, with dummy provider keys (no paid calls)
```

- Server deps: `cd server && uv sync`. Secrets live in `server/.env` (never print or commit them).

## Hard rules

- **No tests: do not write them and do not run them** (rule from 2026-10-23). The founder chose this for iteration speed (about 10x). Do not add test files, test scripts or test dependencies, and do not update existing tests. A hook blocks `pytest`, `vitest`, `jest`, `npm test`, `playwright test`, `xcodebuild test`/`build-for-testing` and `swift test`. Verify by building (`npm run build`, `uv run python -c "import …"`, `xcrun swiftc -parse`) and by using the real app end to end (computer use, the built-in browser, the app's own MCP tools). The founder tests by hand and iterates fast.
- **Fix the bug class, not the instance.** Point guards get reverted. Restructure the unit so the failure is impossible.
- **Learning Space UI is designed in code** under one design system (below and `docs/learning-space/design-system.md`). Mock up a change and get the founder's approval before building it.
- **Record decisions.** A product or architecture decision goes into `docs/learning-space/decisions.md` in the same commit; a replaced decision is marked "Replaced", not deleted.
- **Wrap up each working session** with the procedure in `.claude/skills/session-wrap-up/SKILL.md` (Claude runs it as the `session-wrap-up` skill; other agents follow the file): update the Learning Space docs and remove outdated lines.
- **The working tree is often dirty with the user's own work.** Never `git checkout`/`git restore`/`stash` a file to undo your edits — remove your own change with an edit. Re-read files before editing; the user edits and builds concurrently.
- Ask before pushing.

## Learning Space UI (`space/`)

- **Read `docs/learning-space/design-system.md` before any UI change.**
- **Dark only, one design system.** App colours, spacing and radii come from `space/src/renderer/src/styles/tokens.css`; the `--ls-*` tokens that agents use in board material live in `space/src/renderer/src/board/content.css`. Never hard-code a colour or a spacing value in a component.
- **Every menu and popover uses the shared menu system** in `styles/app.css` (comment block above `.menu`): the `--menu-*` custom properties set all spacing and type, and screens are built from the shared parts (`.menu__heading`, `.menu__title`/`.menu__lede`, `.menu__item`, `.menu__row`, `.menu__line`, `.menu__status`, `.menu__separator`, `.menu__footer`) and the one small button (`.btn-sm`, `.btn-text`). A menu component may set only its own position and width. A missing part is added to the shared system, not to one menu.
- **Keep it quiet:** one primary action per view, short labels, details behind a link or a second view. Mock up new UI first and get the founder's approval before building it.

## Tutor backend, web and iPad clients (paused)

These rules apply only when someone works on the paused tutor stack.

- **The prompt is append-only within a session.** Turn N+1 must be a byte-prefix extension of turn N. Never re-inject memory, profile, mastery or board state mid-session: state a fact once, then append deltas.
- **Never fence the live turn.** Replayed text (history, memory, files) is quoted as data by `app/tutor/quoting.py`; the learner's current message goes as its own `user` message, or the model sees no request and calls no tools.
- **Memory writes stay the model's job.** No regex/code-side "remember this" detectors. If the tutor fails to save something, fix propensity (read `llm_calls.request` and the reasoning summary), not plumbing. Read `docs/superpowers/specs/2026-08-15-memory-redesign-design.md` before touching memory code.
- **Visual changes to the paused clients start in Paper** (file `01KZAH9BZ4FRZXKG2309B7SSRG`), then get re-extracted to code.
- **Voice cost is a product constraint** (~$0.28/min unoptimized). Prefer caching, truncation and metering. Do not propose routing to cheaper models — they were rejected because they misread intent and break board output.
- **Run exactly one backend process.** The `view_board` rendezvous is in-process; a `--reload` restart mid-turn makes the board POST 404 and the tutor says it can't see the board. Check `logs/server.log` for a restart before blaming the client.
- The tutor's system prompt is backend code: `server/app/tutor/prompt.py`. Web checks: `cd web && npm run build`.

### iPad client

- The Xcode project is generated: after adding or renaming Swift files, run `xcodegen generate` and commit the regenerated `project.pbxproj`. No two Swift files may share a basename.
- `ScreenLayout` derives every position from the real window size; the design boards' absolute numbers are one evaluation of that rule, not constants.
- Device install, the compiled-in token and the tailnet backend URL are documented in `README.md` → "Install on a paired iPad".

# Agent coordination

How Claude sessions split work (Opus implements, Haiku reads and checks) is in `CLAUDE.md`.

# Deployment policy

- Never create, save, publish, or deploy this project through ChatGPT Sites or OpenAI Sites.
- Do not call Sites project, version, access, or deployment tools for this repository.
- Landing-page work must remain local-only unless the user explicitly revokes this rule in a future request.
