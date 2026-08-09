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

### 7. A close can freeze a transcript that is still being written

`TutorStore.endSessionOnServer` suppresses the close when a turn is in flight,
which is the client half of a problem that only the server can actually solve.

`POST /v1/sessions/{id}/close` schedules `_record_episode`, which reads
`sessions` and `messages` the moment it runs. Nothing there asks whether a turn
is still writing into them, and `uq_episodes_session` makes whatever it reads
the only episode that session will ever have. So a close that lands mid-turn
freezes a torn transcript permanently, and every later turn in that session is
never remembered.

The device cannot close this hole from its side. It cancels its own stream on a
switch, but the server is another process and may still be several seconds into
a reply — and a close sent from a *different* device, or a retry, has no idea a
turn is running at all. The client guard only means the common case does not
trip it.

The fix belongs in `_record_episode`: refuse to record while the session has a
turn with no end recorded, and leave it for `sweep_abandoned_sessions`. The
client guard can stay as cheap insurance, but it should stop being the only
thing standing there.
