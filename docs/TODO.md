# TODO

Open questions and deferred work, with enough context to pick up cold.

## Session switcher (board 15a)

Board 15a shipped as the switcher: the open session's name in `Panel controls`,
dropping a menu of recent sessions above a `New session` row. The mechanism works
and the storage underneath it is real — a file per session in
`Application Support/MathTutor/Sessions/`, an `index.json` beside it, and a
one-time migration off the old single `session.json`. What follows is what board
15a does **not** answer. The visual design is expected to change before these are
settled; none of them is blocked on that.

### 1. Delete and rename have no home

The menu's rows are tap-to-switch and nothing else. There is no way to remove a
session or give it a name of your own from anywhere in the product.

`TutorStore.resetSession()` deletes the open session as a side effect of Settings'
reset — that is the only delete path, and it can only ever reach the session you
are already looking at. `SessionPersistence.delete(id:)` is general and already
tested; it has no caller that can name another session.

Renaming is a larger question than it looks: `LearningSession.title` is **derived**
(plan title → learner's first line → "New session") and deliberately not stored, so
a custom name means a new stored field that has to win over the derivation and stay
won when the plan changes. See the doc comment on `LearningSession.title`.

### 2. The list has no floor

`SessionMenu.visibleRows` is 6. Session seven exists, is saved, is in the index —
and cannot be reached from the UI at all. The menu does not scroll and there is no
"see all".

This was a deliberate floor under "a handful, recent-first", not a considered
limit. It needs one of: a scroller in the menu, a separate sessions screen, or a
retention rule that actually removes old sessions.

### 3. Switching mid-turn cancels the turn

`TutorStore.closeCurrentSession(saving:)` cancels the in-flight request task on any
switch. A learner who switches while the tutor is writing loses the rest of that
reply; the partial text is saved into the session it belonged to.

That is the safe behaviour, not the right one. A streaming turn mutates
`session.messages` on every delta, so a turn left running would keep writing into a
session nobody is looking at, and its `.done` would persist that over whatever the
switch had already written. Letting the turn finish **into its own session** is the
better answer and needs the turn to hold its own session reference rather than
reading `self.session` — a real change to `requestTutor`.

### 4. Settings' reset now means something narrower

`resetSession()` used to be "wipe everything", because there was only ever one
session. It now deletes the open session and leaves every other one alone.

The Settings copy has not been rewritten to say that, and the destructive control
in board 10's Session pane is still worded for the old meaning. There is probably a
second action here too — "delete all sessions" — which does not exist.

### 5. Board 15a is not transcribed into `docs/design-system/`

`docs/design-system/` is described in the README as the exact transcription of the
Paper file, and `design/reference/` holds the screens at 1× for pixel-diffing.
Neither has board 15a. The switcher's measurements live only in
`SessionSwitcherMetrics` and in the Paper file itself.

Deliberately deferred: the visual design is expected to change, and transcribing a
board twice is the waste this note exists to avoid. Do it once 15a settles.

Two values in code already differ from what 15a was first drawn at, and the
mockup was corrected to match rather than the other way round — both are noted at
their definitions: the row meta is `--text-label` 15, not 13 (15 is the documented
floor: *"nothing goes below this"*), and the menu uses the existing `.modal`
elevation rather than a sixth shadow recipe.

### 6. The switcher is panel-only

Screen 07 (tutor full screen) has no controls row, so it has no session title and
no switcher. The board peek returns to the docked panel in one tap, so this is
survivable, but a learner working full-screen cannot see which session they are in.

Board 15a was drawn for the panel only. Screen 07 would need its own placement.

### 7. A dead turn delays a session's memory by up to six hours

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

### 8. There is no way for the model to re-read the board scene

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
