---
name: session-wrap-up
description: Update and clean the Learning Space documentation at the end of a working session — record decisions, research, lessons and status, and remove outdated lines.
when_to_use: When the founder says "wrap up", "update the docs", "document what we did", "end of session", or after a step of the plan is finished.
---

# Session wrap-up

Goal: the next agent can read `docs/learning-space/README.md` and know the
current state, the reasons, and what to do next. Nothing in the docs
contradicts the code or another doc.

Write in plain, short English (the founder's global rule: ASD-STE100 style).
Delegate reading to Haiku subagents; write the docs yourself.

## 1. Gather what changed

1. Find the last wrap-up: the date in the "Status (…)" line of
   `docs/learning-space/README.md`.
2. `git log --oneline --since=<that date>` on the current branch, and the same
   in `../learning-space-plugins` if it exists.
3. List, from the conversation and the log:
   - decisions the founder made (and the reasons);
   - research findings (with sources and dates);
   - new pitfalls and how they were solved;
   - founder preferences learned (design taste, workflow);
   - steps or features finished, and follow-ups left open.

## 2. Audit the docs against the code (Haiku, read-only)

Start one `Explore` subagent with `model: "haiku"` and this brief, filled in:

> Read-only audit of `docs/learning-space/*.md`, `AGENTS.md`, `CLAUDE.md`,
> `docs/README.md`, `space/README.md`, `space/resources/learning-folder/AGENTS.md`,
> `space/resources/guide.md`, `space/resources/instructions.md`, and
> `../learning-space-plugins/README.md`. CURRENT STATE: <the list from step 1>.
> Report outdated or contradictory lines with file:line and what is true now,
> and missing sections a newcomer would need. Check tool names against
> `space/src/main/mcp.ts` and file paths against the tree. Max 80 lines.

## 3. Update each document by its rule

| File | Rule |
| --- | --- |
| `docs/learning-space/README.md` | Update the status table and its date. Keep the reading order and glossary current. |
| `decisions.md` | Add new decisions to the right table. Never delete one: mark the old one **Replaced** and point to the new one. |
| `research.md` | Add findings with source and date. Mark facts that are no longer true. |
| `working-guide.md` | Add new pitfalls, check recipes and founder preferences. Remove recipes that no longer work. |
| `architecture.md` | Change only when structure changed (a process, a module's job, a data flow, a file location). No line numbers. |
| `design-system.md` | Add new shared parts, tokens and approved screens. Same commit as the CSS change. |
| `plan.md` | Mark finished steps, move items between "Open follow-ups", "Later" and done. |
| `idea.md` | Never rewrite the founder's words. Update only the status note at the top. |
| `step-3-*.md` | Historical. Touch only the status note. |
| `AGENTS.md` / `CLAUDE.md` | Only binding rules (what every agent must or must not do). Facts and history go to the docs above. |
| `space/README.md` | Run, connect, tool table, dev automation. Keep it under ~150 lines. |
| Templates (`space/resources/…`) | Fix tool names or behaviour that changed. They ship to users. |

## 4. Remove outdated lines

- Delete or correct every line the audit found. Do not add a correction below
  an outdated line.
- If two docs say the same thing, keep it in one place and link to it.
- Keep each file focused: if a section grows long and belongs elsewhere, move
  it.

## 5. Check for design drift

Run these searches (read-only) and fix or report findings:

- Hard-coded colours outside the token files:
  `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" space/src/renderer/src --include="*.tsx" --include="*.css" | grep -v -e tokens.css -e content.css`
- Menus or popovers that do not use the shared parts: new `className` values
  containing `menu`, `popover`, `pop`, `button` that are not in the menu
  system's comment block in `styles/app.css`.
- New spacing values in CSS that do not use a token or a `--menu-*` property.

## 6. Memory

Update the auto-memory only for facts the repo cannot hold (who the founder
is, how they like to work, cross-project context). Point to the docs instead
of copying them.

## 7. Commit and report

1. Commit the docs on their own: `docs: session wrap-up <YYYY-MM-DD>` (end the
   message with the attribution line from the system reminder).
2. Push only if the founder asked to push in this session.
3. Tell the founder in a few lines: which docs changed, what was removed as
   outdated, and the open follow-ups.
