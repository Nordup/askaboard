# Learn AI (codebase name: MathTutor)

A shared whiteboard where a learner works through problems with an AI tutor that
can see the board, draw on it, and talk. The goal is the learner's own
understanding, not finished answers. `docs/product-vision.md` is the source of
truth for product direction and language.

## Where things live

| Path | What | Status |
| --- | --- | --- |
| `web/` | React/TypeScript/Vite desktop client | **Active product** — see `web/README.md` |
| `server/` | FastAPI tutor backend (Python, `uv`, Postgres/Neon) — the only thing that holds provider keys | Active — see `server/README.md` |
| `MathTutor/`, `MathTutorTests/`, `MathTutorUITests/` | SwiftUI iPad client | **Paused**, preserved; its behavior is the reference the web port follows |
| `design/`, `docs/design-system/` | Exports/transcriptions of the Paper design file | Generated — never the first thing you edit |
| `landing-page/`, `landing/` | Marketing page | Local-only (see Deployment policy) |
| `docs/` | Vision, TODO, research, specs/plans under `docs/superpowers/` | |

## Run it

```sh
python3 scripts/web-dev.py        # web + API + local Postgres (port 55432); prints URL and access code
python3 scripts/web-dev.py --qa   # same, with dummy provider keys (no paid calls)
```

- Server deps: `cd server && uv sync`. Secrets live in `server/.env` (never print or commit them).
- Web checks: `cd web && npm run build` (type-check + bundle).
- The tutor's system prompt is backend code: `server/app/tutor/prompt.py`. Changing the clients never changes tutor behavior.

## Hard rules

- **Do not run test suites.** A hook blocks `pytest`, `xcodebuild test`/`build-for-testing` and `swift test`. Write the tests, verify by building/importing (`uv run python -c "import …"`, `npm run build`, `xcrun swiftc -parse`), and give the user the exact command to run. The server suite is DB-bound and takes ~1 h; slow is not hung.
- **The prompt is append-only within a session.** Turn N+1 must be a byte-prefix extension of turn N. Never re-inject memory, profile, mastery or board state mid-session: state a fact once, then append deltas. Pin changes here with a multi-turn prefix-sweep test.
- **Never fence the live turn.** Replayed text (history, memory, files) is quoted as data by `app/tutor/quoting.py`; the learner's current message goes as its own `user` message, or the model sees no request and calls no tools.
- **Memory writes stay the model's job.** No regex/code-side "remember this" detectors. If the tutor fails to save something, fix propensity (read `llm_calls.request` and the reasoning summary), not plumbing. Read `docs/superpowers/specs/2026-08-15-memory-redesign-design.md` before touching memory code.
- **Fix the bug class, not the instance.** Point guards get reverted. Restructure the unit so the failure is impossible and add a sweep/invariant test over the failing dimension.
- **Visual changes start in Paper** (file `01KZAH9BZ4FRZXKG2309B7SSRG`), then get re-extracted to code. Never code-first.
- **Voice cost is a product constraint** (~$0.28/min unoptimized). Prefer caching, truncation and metering. Do not propose routing to cheaper models — they were rejected because they misread intent and break board output.
- **Run exactly one backend process.** The `view_board` rendezvous is in-process; a `--reload` restart mid-turn makes the board POST 404 and the tutor says it can't see the board. Check `logs/server.log` for a restart before blaming the client.
- **The working tree is often dirty with the user's own work.** Never `git checkout`/`git restore`/`stash` a file to undo your edits — remove your own change with an edit. Re-read files before editing; the user edits and builds concurrently.
- Ask before pushing.

## iPad client (paused)

- The Xcode project is generated: after adding or renaming Swift files, run `xcodegen generate` and commit the regenerated `project.pbxproj`. No two Swift files may share a basename.
- `ScreenLayout` derives every position from the real window size; the design boards' absolute numbers are one evaluation of that rule, not constants.
- Device install, the compiled-in token and the tailnet backend URL are documented in `README.md` → "Install on a paired iPad".

# Agent coordination

- Treat a subagent's `running` status as authoritative. Reading, investigation, dependency resolution, builds, and tests may produce no visible edits or messages for several minutes.
- Give a running DeepSeek worker at least 20 minutes of cumulative grace, or at least 30 minutes for retrieval-heavy work and builds/full test suites. Wait in calls of at most 60 seconds to remain responsive; repeated wait timeouts do not indicate failure.
- Do not interrupt or replace the worker during that grace period. Afterward, send one status request and wait at least 10 additional minutes. Interrupt only with affirmative evidence of a hang, an explicit blocker/failure, a user request to stop, or a concrete safety/conflicting-write risk. Never infer a stall only from reading time, silence, or an unchanged worktree.
- When restarting delegated work at the user's request, discard the interrupted attempt's uncommitted implementation and launch a fresh subagent from the clean baseline.

# Deployment policy

- Never create, save, publish, or deploy this project through ChatGPT Sites or OpenAI Sites.
- Do not call Sites project, version, access, or deployment tools for this repository.
- Landing-page work must remain local-only unless the user explicitly revokes this rule in a future request.
