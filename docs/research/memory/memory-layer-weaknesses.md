# Memory layer: structural map + weakness list

Research artifact, 2026-08-15, Explore agent, read-only. Paths relative to repo root. This is the code-level diagnosis behind the founder-reported symptoms ("cannot recall the previous session's details"; "an explicitly saved note seemed never retrieved").

## Architecture (as shipped)

- **Write path**: `POST /v1/sessions/{id}/close` → `schedule_session_close` → `run_session_close` (`server/app/memory/jobs.py:512`): `_record_episode` → `sweep_abandoned_sessions` → `run_extraction_backlog`. `_record_episode` (`jobs.py:225-308`) writes `Episode(transcript, …)` once per session (`uq_episodes_session`), refuses silently if an episode exists / session unknown / a turn is running <15 min / zero messages. Abandoned sessions swept when last message >1 h old (`STALE_AFTER`, `jobs.py:64`) AND no episode exists yet.
- **Extraction** (`jobs.py:311-372`): digest = 2–3 sentences (`DIGEST_PROMPT`, `jobs.py:110-115`); `extract_atoms` (6 categories, 10–30 words, drops `stated != true` except `episode_ref` — `extract.py:176`, `schema.py:65`); `consolidate` (ADD/SUPERSEDE/NOOP, cosine candidates ≥0.35); `rebuild_profile`; embeddings written synchronously (`text-embedding-3-small`, 1024d halfvec).
- **Read path per turn** (`api/turn.py:91-115` `_memory_sections`): exactly three blocks — profile (≤350 words instructed), `mastery.snapshot(limit=8)`, last 12 episode digests (`retrieve.py:158/178`). **No vector search on the turn path.** Atoms reach the model only via the portrait or via a model-chosen `search_memory` call.
- **Tools**: `search_memory` = hybrid RRF (dense + fts, K=60, limit 8, **no relevance floor**, output `- [category] text` — no dates); `recent_sessions` = the same digests, limit clamp [1,20], no offset; `remember` = direct INSERT + embed + commit (bypasses consolidation, never rebuilds the portrait); `record_evidence` → Elo.
- **Timing**: periodic sweep every 5 min; startup drain; backlog drains oldest-first and **re-raises on first failure** (`jobs.py:479`) so one poison episode halts everything newer.

## The 20 weaknesses (W1–W20)

**W1 — One episode per session id, forever, while the client reopens the same session across days.** The iPad restores `index.lastOpened` (`SessionPersistence.swift:85`); new sessions only via the switcher. Day 1: sweep fires at +1 h → episode → extracted. Day 2+: same session id continues, but the sweep filter (`Episode.id IS NULL`, `jobs.py:421`) and the one-shot uniqueness mean **nothing after day 1 is ever digested, extracted, or folded into the profile again. Memory freezes.** The dominant failure.

**W2 — `remember` writes never reach the prompt.** The only prompt-side reader of atoms is the portrait, rebuilt exclusively inside `_extract_episode` (`jobs.py:369`). With W1, a saved note is permanently absent from standing context; retrievable only if the model calls `search_memory` AND it outranks 7 other atoms. The tool replies "Saved. You can tell the learner you will remember it." — misleading.

**W3 — Digests are 2–3 sentences; `Episode.transcript` is written and never read back.** No tool/endpoint/section surfaces a past transcript. "Recall the previous session in detail" is architecturally impossible.

**W4 — The `stated` filter discards tutor observations.** Five of six categories require the learner to have said it; pedagogy ("kept dropping signs") is dropped.

**W5 — Turn-in-flight suppression on both sides, no reschedule.** Client suppresses close (`TutorStore.swift:920-927`); server declines while a turn runs (`jobs.py:272-277`); recovery only via the 1 h sweep. docs/TODO.md says "six hours" — stale by 6×.

**W6 — Backgrounding/termination never close a session** (deliberate, `TutorStore.swift:894-897`). For a learner who never uses the switcher, only the sweep creates episodes — once per id (W1).

**W7 — One failing episode halts the backlog permanently** (oldest-first, re-raise). No transcript length cap feeds `_digest`/`extract_atoms` — the W1 ever-growing transcript is the likely poison. Visibility: `/health` only.

**W8 — No relevance floor on `search_memory`.** ≥8 live atoms → always 8 rows; "Nothing on file" near-unreachable; a relevant note can sit at rank 9 invisibly.

**W9 — Search results carry no dates/provenance** (`dispatch.py:233`). The model cannot say "you told me this last session".

**W10 — No current-date anchor in the prompt.** Digest lines are `%Y-%m-%d`; "last session / yesterday / three weeks ago" cannot be resolved.

**W11 — `recent_sessions` duplicates the standing block; no offset; sessions ≥21 unreachable.** The tool description promises what the parameter cannot do.

**W12 — Nothing tells the model to consult memory at session start.** No first-turn marker; strong instructions live only in tool descriptions.

**W13 — A remembered atom can be silently superseded by later extraction** (offered as supersession target, `consolidate.py:325-335`).

**W14 — `remember` refuses `stated=false`** outside `episode_ref`; the model often says "noted" in prose while the write was refused.

**W15 — Failed turns leave one-sided transcripts** (tutor message only written on success, `recorder.py:209-212`); episode transcripts degrade.

**W16 — Voice mode records the relay's paraphrase, not the learner's words.** `send_to_tutor.request` becomes the `Message`; extraction then asserts `stated=true` about words the learner did not say. (Voice-mode integration must sync real utterances into the transcript.)

**W17 — 40 s memory budget can starve the one call that matters** (embedding round-trips count against it).

**W18 — Single-process assumptions** (in-process drain locks, sweeps duplicated per worker).

**W19 — Deleting a session keeps its atoms** — unattributable, un-deletable; no forget tool.

**W20 — Portrait size instructed, not bounded**; synthesis input unbounded as the store grows.

## Symptom decomposition

- "Cannot recall the previous session's details" = W1 × W3 × W10 × W12. **W1 makes the others moot — fix first.**
- "Saved note never retrieved" = W2 × W8 × W12 × W13. **W2 is load-bearing.**

## Cheapest structural levers (agent's scoping)

1. Episodes append per time-window, not per session id.
2. Rebuild the portrait (or a "recently remembered" standing section) on the `remember` path.
3. Current date + first-turn marker in the prompt.
4. `recent_sessions` offset + dates; relevance floor + dates in `search_memory` output.
5. A `read_session` tool over the transcripts that are already stored and never read.

## Docs vs code

README memory section accurate on pipeline/triggers/budgets; silent on W1/W2. docs/TODO.md stale on sweep timing (6 h vs 1 h). The 2026-08-09 memory plan promised per-turn hybrid retrieval — never became a turn-path read.
