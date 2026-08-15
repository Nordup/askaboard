# Memory rework — implementation plan

Spec: `docs/superpowers/specs/2026-08-15-memory-redesign-design.md`. Two parallel server packages with strict file ownership, then orchestrator integration (migration, tests, restart).

## Schema contract (both packages code against THIS; Package W implements the migration)

`episodes` gains (alembic 0007, purely additive except the constraint swap):
- `seq_from INT NOT NULL DEFAULT 1`, `seq_to INT NOT NULL DEFAULT 0` — the message-seq window this episode covers (backfill: `seq_from=1`, `seq_to=message_count`).
- `title TEXT NULL`, `narrative TEXT NULL`, `next_steps JSONB NULL`, `topics TEXT[] NULL`.
- `narrative_embedding HALFVEC(1024) NULL` (episode search arm; atoms keep their own).
- `extraction_attempts INT NOT NULL DEFAULT 0`, `quarantined_at TIMESTAMPTZ NULL`.
- Constraint: drop `uq_episodes_session`; add `uq_episodes_session_window UNIQUE (session_id, seq_from)`.
- `messages` gains a generated `fts tsvector` column + GIN index (for `search_history`).
- `memory_atoms` gains `explicit BOOLEAN NOT NULL DEFAULT FALSE` (remember-written notes; excluded from supersession; rendered in SAVED NOTES).

## Package W — write path (owns: `server/app/memory/jobs.py`, `extract.py`, `consolidate.py`, `profile.py`, `server/app/store/models.py`, `server/migrations/versions/0007_*.py`, `server/app/store/recorder.py`, `server/app/api/sessions.py`, `server/tests/test_memory_windows.py`)

1. Migration 0007 per the schema contract. Backfill existing episodes' windows; leave digest column in place.
2. Windowed episode recording: `_record_episode` records messages `seq > last episode.seq_to`; triggers = close, session switch close, sweep (STALE_AFTER → 30 min) when uncovered messages exist. A running-turn decline RESCHEDULES (next sweep tick covers it) instead of dropping. Remove the episode-exists early-return (it becomes "window empty → no-op").
3. Rich summarization: replace `DIGEST_PROMPT` with a structured call producing title / narrative (150–300 tokens, MUST carry exact details: problem statements, numbers, formulas, mistakes, outcomes) / next_steps / topics. Write `narrative_embedding`. Keep writing `digest` = first 2 sentences of narrative for compatibility.
4. Quarantine: extraction failure increments `extraction_attempts`; at 3, set `quarantined_at`, log, continue the drain past it. `/health` reports quarantined count.
5. Transcript char cap (tail-biased) for summarize/extract calls.
6. `consolidate`: atoms with `explicit=true` are never offered as supersession targets.
7. `recorder.fail_turn`: write a `[reply lost]` tutor Message so windows read coherently.
8. Backfill job: re-summarize existing episodes from stored transcripts (bounded, oldest last; runs behind the normal drain).
9. Tests (`test_memory_windows.py`, fake provider, no shared Neon test branch writes — use the project's existing test DB pattern; if that pattern uses the shared branch, keep tables session-scoped and unique-named): window selection across close/sweep/reopen; mid-session close freezes only its window; reschedule-on-running-turn; quarantine-and-continue; explicit-atom supersession exemption.

## Package R — read path (owns: `server/app/memory/retrieve.py`, `dispatch.py`, `server/app/tutor/tools.py`, `prompt.py`, `context.py`, `server/app/api/turn.py`, `server/app/config.py`, `server/tests/test_memory_read.py`, `server/tests/test_memory_recall.py`)

1. `_memory_sections` (turn.py) becomes the standing block per spec §3: date anchor ("Today is {ISO date} ({weekday})."), first-turn marker (first turn of this session = no prior tutor message in this session), profile, **SAVED NOTES** (all live `explicit=true` atoms, `[YYYY-MM-DD] text`, wholesale, ~1k-token cap with overflow line), **RECENT SESSIONS** (last 6 episodes newest-first: ISO date + relative label + title + next_steps; newest also gets full narrative; **backstop**: if uncovered messages exist for the latest closed/quiet window without a summary, inject that window's raw transcript tail instead), learner state as today. Keep the stable/volatile cache split intact — date anchor changes daily, so it goes at the TOP of the stable half (cache invalidates once per day, acceptable) or into the volatile half if simpler; pick volatile to preserve the cache.
2. New tools (tools.py + dispatch.py): `search_sessions`, `search_history` (messages FTS + ts_headline excerpts + session date + speaker), `get_session(date_or_offset, part, page)`, `list_sessions(limit, before_date?)` replacing `recent_sessions`. `search_memory` gains dates+provenance in output and an RRF relevance floor ("Nothing on file about that." becomes reachable). `remember` drops the stated-refusal for explicit saves, sets `explicit=true`, embeds as today; new `forget(text-or-note-reference)` closes a note (valid_to). Tool definitions remain constant per request.
3. Prompt: new `## MEMORY` section in SYSTEM_PROMPT per spec §5 (standing blocks explained; answer recent-past from RECENT SESSIONS; call get_session/search_history/search_sessions BEFORE answering detail questions about the past; "remember this" → call remember, confirm only after the tool returns; never claim a memory check without a tool call in the same turn).
4. Config: knobs for RECENT_SESSION_COUNT (6), notes cap, floor value, window staleness. Remove dead ones.
5. Tests: `test_memory_read.py` — sections composition (date anchor, saved notes wholesale, backstop injection, first-turn marker), tool handlers against a seeded scratch schema, search floor behavior, get_session paging. `test_memory_recall.py` — the founder-scenario regression with a scripted provider: recency question answered from RECENT SESSIONS; detail question triggers get_session; a note saved via remember appears in the next turn's SAVED NOTES.

## Shared rules

Match existing code style. Read the three research docs in `docs/research/memory/` first. Do not touch the other package's files; `models.py`/migration belong to W — R codes against the schema contract above. Run ONLY your own new test files with pytest. No commits, no branches. The user may edit concurrently; re-read files before editing. The production DB is not to be migrated or written by agents — the orchestrator applies the migration.

## Integration (orchestrator)

1. Reconcile, run both packages' tests + the existing memory tests.
2. Apply `alembic upgrade head` to the production DB after verifying 0007 is additive (constraint swap included); restart the server; smoke `/health`.
3. Commit + push. Live test with the founder: session → note → new session → "what did we do last time / pull my note / find where I said X".
