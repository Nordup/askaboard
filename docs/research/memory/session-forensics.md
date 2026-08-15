# Forensic report: why the tutor misremembered the previous session

Research artifact, 2026-08-15, read-only DB forensics agent. Sessions: **A** = `4e043165` (Aug 14 16:04 → Aug 15 07:45 UTC, 32 messages, gpt-5.6-sol), **B** = `a10a4422` (Aug 15 10:00 UTC, voice session, 23 messages, gpt-5.6-luna).

## Timeline

- Aug 14 16:04 — Session A starts; turn 1 ok (molecular speed vs temperature).
- 16:11 — learner re-sends; turn 2 fails "client disconnected".
- ~16:23 — the device rewrites the transcript down to ONE message (hypothesis: `PUT /transcript` after dead replies — the only message-delete path).
- **16:23:18 — the device sends `POST /sessions/A/close`. The episode freezes: `message_count=1`, transcript = the opening learner message only (573 chars).**
- 16:23–16:24 — extraction runs on that fossil; digest written; **last profile rebuild ever** (16:23:37).
- 17:09 → Aug 15 07:45 — the REAL session A: 16 successful turns, 31 messages — all AFTER the freeze. `uq_episodes_session` makes a second episode impossible. None of it can ever enter memory.
- Aug 15 06:33 — learner: *"I do wanna derive relationship from collisions step by step, but maybe next time, can you remember that?"* → `remember` succeeds; atom live + embedded; **profile not rebuilt (the remember path never rebuilds it)**.
- Aug 15 10:00 — Session B (voice). Four delegated turns. **Zero memory tool calls.**

## What the frozen digest said vs what session A actually did

Digest (the ONLY record of A): "…had not yet chosen a specific model or worked through a calculation; the next step is to distinguish temperature from molecular speed and introduce the relevant equations."

Actual session A: wrote and corrected `E_k = ½mv²`; converted 30°C→303.15 K; derived `Ē_k = ½m·v̄²`; was given `Ē_k = 3/2·k_B·T` (boxed, seq 21) at own request; resolved average vs r.m.s. speed; mid-way through `v_rms` for O₂ ("Try oxygen then air", seq 30). None of it in memory.

## Session B's four asks, wrong vs actual

Ask 1: "check the previous session… where we stopped?" → tutor: "You had not yet chosen a precise definition of 'molecular speed' or completed a numerical calculation… next step was to choose a model and reconstruct the formula."

| Claim | Reality (session A) |
|---|---|
| no definition of molecular speed chosen | chosen seq 4, refined to r.m.s. seq 22–27 |
| no numerical calculation | 303.15 K conversions done; v_rms in progress |
| next step: reconstruct the formula | formula already given and boxed at seq 21 |
| (omitted) | the saved next step: derive from collisions step by step |

Ask 2: "Can you pull it out from memory?" → the tutor invented a plan; the voice model even said "It's still running on my side… it should return the planned next step from memory" — no lookup existed. Asks 3–4: the tutor set up deriving the very formula session A had finished. Learner frustration on record: "No way." / "Why are you talking about".

## What was injected (identical for all four asks)

- Profile (rebuilt Aug 14 16:23, before 31 of A's 32 messages) including the stale, false line: "You do not currently remember the formula linking temperature with average molecular kinetic energy" — from a DELETED noon session, never superseded.
- RECENT SESSIONS: 8 digests; top = the one-message fossil; second = junk digest "2026-08-14: ready".
- Learner state: math KCs only — 3 of 6 `record_evidence` calls in A were REFUSED (physics codes not in the math-only curriculum table).
- **The saved note: nowhere in any request.**

## Tool ledger

Session A: 6× record_evidence (3 refused), 1× remember → "Saved." Session B: view_board 1, set_workspace 1, **memory tools 0**. Lifetime production history: `search_memory` and `recent_sessions` have NEVER been called.

## Saved-note trace

Text: "Next session, the learner wants to derive the ideal-gas temperature–kinetic-energy relationship from molecular collisions step by step." Row live, embedded, category=goal, source_session_id=A. Both retrieval arms verified to match it (FTS + dense). It never surfaced because (1) the profile is only rebuilt inside episode extraction, which can never run again for A, and (2) `search_memory` was never called.

## Failure points, ranked

1. Mid-session close froze the episode at 1/32 messages, permanently (certain).
2. The tutor never calls memory tools — zero lifetime calls; answered "pull it from memory" from the stale digest with full confidence (certain).
3. `remember` writes are invisible to the standing prompt until an unrelated extraction rebuilds the profile (certain).
4. A confident wrong digest suppresses the search that would refute it — the tool description says "answer from it directly when it covers the question" (high).
5. The stale profile line actively steered turns into re-teaching a finished derivation (high).
6. Physics evidence silently dropped — KC vocabulary is math-only (certain, contributory).
7. (hypothesis) The device transcript-replace before the close shrank the freeze to one message.

The founder's "gist right, details wrong" is exactly what the data predicts: older sessions' digests carried the topic; everything session A achieved lived in the 31 post-freeze messages no memory surface ever saw.
