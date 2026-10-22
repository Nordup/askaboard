# TODO

Open questions and deferred work, with enough context to pick up cold.

## Tutor backend

### 1. A dead turn delays a session's memory by up to six hours

`_record_episode` now declines to record a session while it has a turn at
status="running" that started within `TURN_ASSUMED_DEAD_AFTER`, which closes the
race this entry was originally opened for: a close landing mid-turn used to
freeze the transcript short, permanently, because `uq_episodes_session` allows
no second attempt.

What is left is the other side of that trade. "running" is a claim made by a
process that can die, so the guard is bounded by age rather than trusted
outright — and a turn killed hard leaves its row saying "running" until the
fifteen minutes are up. A close arriving inside that window is declined, and
nothing retries it until `sweep_abandoned_sessions` reaches the session six
hours later. The learner gets their memory the same day rather than the same
minute, which is the right way round, but it is not free.

The fix, if it ever matters: have `turn.py` relabel abandoned turns on the way
in as well as on the way out — a new turn arriving for a session is proof the
previous one is over — or have the close reschedule itself once the blocking
turn leaves "running", instead of waiting for the sweep.

### 2. There is no way for the model to re-read the board scene

The tutor's semantic scene used to ride in every prompt. It no longer does: the
append-only prompt freezes it at session open and `app/tutor/ledger.py` appends
each turn's board actions — id, kind, anchor, a short label — so the ids the
model assigns stay in the log without the scene being re-sent. That closed the
cost (up to 15,000 tokens a turn, uncached) and the duplicate-stacking risk it
was there to prevent.

What is left is the case the log cannot reach. The device holds truth the server
does not: elements it dropped when its own scene hit `MAX_SCENE_CHARS`, and a
partial apply. And past `LOG_MAX_CHARS` the chain restarts, taking the earliest
board records with it. Today the model has no way to ask; the per-turn re-send
used to correct all of this silently.

A `get_board_scene` tool is the clean answer, and it is cheap. The part that
needs care is not the tool, it is discoverability — a tool the model never calls
is not a fix, and `step_back` on mini is the standing proof. Name it in the
`update_board` **ack**, not only in the tool list: that string is read at the one
moment the model has just acted on an id, which is exactly when "if you are
unsure an id is still on the board, call `get_board_scene` first" lands.
