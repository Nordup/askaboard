<!-- learning-space brief: placeholder (the app puts the brief here at setup) -->

# This learning folder

This folder is a personal learning repository. One person learns here with you over many sessions. Everything that should outlive a session lives in these files. The learner owns the folder and changes this part of the file as they learn what works for them.

## Files

| Path | What it holds | Who updates it |
| --- | --- | --- |
| `plan.md` | The direction: goals, current focus, next steps, topic list. | You, with the learner's agreement. |
| `learner.md` | Durable facts about the learner: background, level, how they like to learn, gaps and misconceptions. | You, when you learn something that will matter next time. |
| `sessions/` | One log per session: `YYYY-MM-DD-short-topic.md`. | You, at the end of each session. |
| `topics/<topic>/` | Notes per subject or topic: `notes.md` with what the learner now understands, in their words where possible. | You and the learner. |
| `materials/` | Sources and readings: files, and `materials/sources.md` with links and one line on each. | You, when you use a source. |
| `boards/` | Learning Space boards. | The app. |
| `assets/` | Images placed on boards. The app creates it when the first image is added. | The app. |

Create a folder or file from this table when you first need it.

## At the start of a session

1. Read `plan.md`, `learner.md` and the newest file in `sessions/`.
2. Look at the open board.
3. Say in one or two sentences where you left off, and ask what the learner
   wants to do today.

## At the end of a session

When the learner says they are done, or the session reaches a natural end:

1. Find out what happened, even if this conversation started late: read
   today's files in `sessions/`, and look at the open board (`get_changes`
   with `since: 0`, `list_items` with part "board", `get_screenshot`).
   `list_boards` shows which other boards changed today. The boards hold the
   learner's work.
2. Write `sessions/YYYY-MM-DD-short-topic.md` (or update today's file):
   - what we worked on, and which boards;
   - what the learner now understands (concrete, in their words if possible);
   - mistakes and misconceptions that came up;
   - open questions;
   - the next step.
3. Update `plan.md` (current focus, next steps) and `learner.md` (only
   durable facts).
4. Update `topics/<topic>/notes.md` with what settled.
5. Keep every file short and current. Rewrite stale lines instead of adding
   new ones below them.

## Rules

- Write in plain Markdown.
- Never delete or overwrite the learner's own notes. Add or suggest instead.
- If this folder is a Git repository, do not commit or push unless the
  learner asks.
