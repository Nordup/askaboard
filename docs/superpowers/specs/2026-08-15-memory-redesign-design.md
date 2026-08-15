# Memory redesign — reliable recall

Date: 2026-08-15. Status: **approved by the founder** ("yeah implement that and we'll test how it works").
Founder principle: *the tutor must be able to read the entire history and find specific information and parts of it when needed — that is the livelihood of an intelligent tutor.* Nothing in the history is unreachable.
Inputs: `docs/research/memory/session-forensics.md` (the empirical failure), `docs/research/memory/memory-layer-weaknesses.md` (W1–W20), `docs/research/memory/chatgpt-memory-design.md` (the target behavior and field consensus).

## The principle

Copy what makes ChatGPT's recall feel reliable: **the recent past is precomputed and always present — never retrieved.** Retrieval serves only the old archive. Explicit notes are injected wholesale, never similarity-gated. Time is a first-class citizen. The model is told when and how to look further.

## 1. Episodes: append per activity window, not one per session id (fixes W1, W5, W6, forensics #1)

- Drop the one-episode-per-session invariant. An episode covers a **message range** of a session: `episodes(session_id, seq_from, seq_to, …)` with uniqueness on `(session_id, seq_from)`.
- Triggers to record the next window: session close, session switch, and the sweep when the newest message is ≥30 min old (`STALE_AFTER` drops from 1 h) AND at least one message is newer than the last episode's `seq_to`.
- A close mid-session is no longer fatal: it freezes only that window; later activity forms the next window.
- Voice sessions: the synced learner/tutor voice messages are the transcript (the live-transcript fix already lands real utterances; the relay's paraphrase is never recorded as the learner's words — fixes W16).

## 2. Rich episode summaries (fixes W3)

Per episode, one summarization call produces structured fields (new columns, JSONB where noted):
- `title` — short and specific ("Derived KE–temperature link; started v_rms for O₂").
- `narrative` — 150–300 tokens written from the full window transcript, **required to carry exact details**: problem statements, numbers, formulas reached, mistakes made, what was resolved.
- `next_steps` — open loops ("agreed: derive from collisions step by step next time").
- `topics` — text[].
- `embedding` — of title+narrative, used ONLY by the search tool.
The old 2–3-sentence `digest` column stays for compatibility until backfill completes, then reads switch to `narrative`. Backfill job: re-summarize existing episodes from their stored transcripts.

## 3. The standing block: deterministic, fresh, dated (fixes W2, W10, W12, forensics #3/#5)

Injected every turn, in the stable cache half, in this order:
1. **Date anchor + turn marker**: "Today is {ISO date, weekday}. This is the first turn of a new session." (first-turn only for the marker).
2. **Learner profile** — rebuilt after **every** episode extraction (now frequent) — entries keep dates; supersession resolves stale lines.
3. **SAVED NOTES** — every live explicit note, timestamped `[YYYY-MM-DD]`, injected wholesale. Never similarity-gated, never offered as supersession targets to the consolidator (fixes W13). Cap ~50 notes / ~1k tokens (oldest drop into the searchable store with a "notes overflow" line).
4. **RECENT SESSIONS** — the last 6 episode summaries, newest first: date + relative label ("yesterday", "3 days ago") + title + next_steps; the newest episode includes its full narrative. **Backstop:** if messages exist that no episode covers yet (extraction pending/failed), inject the raw transcript tail of that window instead — recall never depends on a background job having run.
5. Learner state (mastery snapshot), as today.

## 4. Archive tools (fixes W8, W9, W11; forensics #2/#4 propensity)

- `search_sessions(query, date_from?, date_to?, limit≤5)` — hybrid dense+FTS with an RRF floor over episode summaries; output cards: ISO date + relative label + title + narrative + provenance ("from session on …"). Includes total-match count.
- `search_history(query, date_from?, date_to?, limit≤8)` — full-text search over **every stored transcript** (Postgres FTS on messages/episode transcripts with `ts_headline` excerpts). Returns matching excerpts with session date + speaker + surrounding lines, so the tutor can find the exact place something was said and then `get_session` for the full context. The entire history is reachable — nothing ages out of search.
- `get_session(date_or_offset, part: summary | transcript, page?)` — reads the stored episode transcript, paged. Summaries answer "what happened"; transcripts answer "what exactly was said". This is the detail-recall path for anything older than RECENT SESSIONS.
- `list_sessions(limit, before_date?)` — recency browse with real pagination (replaces `recent_sessions`, which duplicated the standing block and had no offset).
- `search_memory` stays for atoms; output gains dates + provenance and a relevance floor; below-floor → "Nothing on file about that."
- `remember` keeps writing immediately AND the note enters SAVED NOTES on the very next turn (standing-block read, no rebuild dependency). `stated` refusals for explicit saves are dropped (the call itself is the explicit act — fixes W14). New `forget(note)` closes a note (fixes half of W19).

## 5. Propensity: the prompt teaches memory use (fixes W12, forensics #2/#4)

New `## MEMORY` section in SYSTEM_PROMPT: what the standing blocks are; RECENT SESSIONS covers the recent past — answer from it directly; for details beyond it, call `get_session`/`search_sessions` BEFORE answering; when the learner says "remember this", call `remember` and confirm only after the tool returns; never claim to have checked memory without a tool call in the same turn (the voice session's "it should return the planned next step from memory" must be impossible to say honestly without a lookup).

## 6. Robustness

- Backlog drain quarantines a poison episode after 3 failed extraction attempts (`extraction_attempts` column) and moves on; `/health` reports quarantined count (fixes W7).
- Transcript fed to summarization/extraction capped (tail-biased) at a fixed char budget.
- One-sided-transcript mitigation (W15): `fail_turn` records a `[reply lost]` tutor placeholder so windows read coherently.
- Evidence codes outside the curriculum (W4/W6 of forensics: physics refused): out of scope here; noted as follow-up — accept a generic `subject:<code>` bucket.

## Out of scope

KC vocabulary expansion; multi-worker distribution (W18); forgetting UI; profile token accounting (W20 — mitigated by dated entries and frequent rebuilds).

## Verification

- Unit: window-boundary selection; backstop injection when summaries missing; SAVED NOTES wholesale injection; quarantine.
- A LongMemEval-style regression script (`server/tests/test_memory_recall.py` with a scripted fake provider): recency question answered from RECENT SESSIONS; detail question triggers `get_session`; "remember this" note present in next turn's standing block.
- Live: re-run the founder's exact scenario — session, note, new session, "what did we do last time / pull my note".
