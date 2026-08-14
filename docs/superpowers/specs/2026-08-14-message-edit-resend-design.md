# Long-press menu on a sent message: Copy, and Edit-and-resend

Date: 2026-08-14. Status: implemented in the same change.

## What this adds

A long press on the learner's own bubble opens the system context menu, on
both chat surfaces (panel and reading column). The menu has two items:

- **Copy** — puts the message text on the pasteboard.
- **Edit** — puts the message text back in the composer. When the learner
  sends it, the conversation restarts from that point: the app removes that
  turn and every turn after it, then sends the edited text as the new turn.
  This is the ChatGPT "edit" behaviour, without branches — the removed tail
  is gone.

Tutor messages get no menu. Edit is offered only on plain text turns: a turn
that carried files or a board selection cannot be resent faithfully as text,
so the menu shows Copy alone there.

## The decisions

**Native context menu, no custom chrome.** The menu is `contextMenu` on the
bubble. The design system draws nothing new; the one new piece of copy is a
note line in the composer's existing note slot.

**Edit arms a state; send performs the cut.** A tap on Edit destroys
nothing. It fills the composer and sets `TutorStore.editingMessageID`. The
truncation happens only when the learner sends. A note above the composer
says the state plainly: sending rewrites the conversation from that message,
and clearing the field cancels. Clearing the composer to empty is the cancel
gesture — the natural way to abandon a pre-filled draft — and a session
switch also cancels.

**The server transcript is replaced, not trimmed by index.** The server
rebuilds each turn's context from its own `messages` table, not from the
request (`server/app/api/turn.py`). A client-side cut alone would leave the
removed tail in the tutor's context. Index-anchored deletion is fragile:
a retried turn writes its learner row twice server-side, so client and
server ordinals drift. So the client sends the whole remaining prefix and
the server makes it the transcript: `PUT /v1/sessions/{id}/transcript`
deletes the session's `Message` rows and inserts the prefix at seq 0..n-1.
This is exact, idempotent, and it heals earlier drift. Transcripts are
text-only and small, so the payload cost is noise.

**The sync gates the turn.** `TutorStore` holds the prefix in
`pendingTranscriptSync` and awaits the `PUT` at the head of the turn task,
before the stream opens. If the sync fails, the turn fails with the thread's
normal error state, and the retry chip re-runs both. A turn sent against an
unsynced transcript would answer from a conversation the learner no longer
sees; failing loudly is better. A 404 counts as success — a session the
server never saw has nothing to cut.

## Flow

1. Long press on a learner bubble → menu → Edit.
2. `TutorActions.editMessage(id)` (BoardScreen): `composerText = message.text`,
   `store.beginEditingMessage(id:)`.
3. Composer note shows the editing state.
4. Send → `store.send` (or `store.evaluate`) passes its guards, then
   `consumePendingEdit()`: remove `messages[index...]`, drop their
   `selectionViews`, clear a dangling evaluation card, snapshot the prefix
   into `pendingTranscriptSync`, clear `editingMessageID`. The new learner
   turn appends as normal.
5. The turn task awaits `replaceTranscript` before it streams. Success
   clears `pendingTranscriptSync`; failure sets `errorMessage` and stops.
6. Retry re-runs the pending sync first when one is still owed.

## Not in scope

- Branching (keeping the removed tail), as ChatGPT does. The tail is gone.
- Edit on turns that carried attachments or a board selection.
- Copy on tutor messages — trivial to add later if wanted.
- Persistence of `pendingTranscriptSync` across a relaunch. If the app dies
  between a failed sync and its retry, the server keeps the stale tail until
  the next successful edit in that session. Accepted as rare.
