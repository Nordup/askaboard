---
name: session-wrap-up
description: Update and clean the Learning Space documentation at the end of a working session — record decisions, research, lessons and status, and remove outdated lines.
when_to_use: When the founder says "wrap up", "update the docs", "document what we did", "end of session", or after a step of the plan is finished.
---

# Session wrap-up

Goal: the next agent can read `docs/README.md` and know the
current state, the reasons, and what to do next. Nothing in the docs
contradicts the code or another doc.

Write in plain, short English (the founder's global rule: ASD-STE100 style).
Delegate reading to Haiku subagents; write the docs yourself.

## 1. Gather what changed

1. Find the last wrap-up: the date in the "Status (…)" line of
   `docs/README.md`.
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

> Read-only audit of `docs/*.md`, `AGENTS.md`, `CLAUDE.md`,
> `docs/README.md`, `apps/desktop/README.md`, `apps/desktop/resources/learning-folder/AGENTS.md`,
> `apps/desktop/resources/guide.md`, `apps/desktop/resources/instructions.md`, `apps/desktop/src/main/mcp.ts` (tool descriptions), and
> `../learning-space-plugins/README.md`. CURRENT STATE: <the list from step 1>.
> Report outdated or contradictory lines with file:line and what is true now,
> and missing sections a newcomer would need. Check tool names against
> `apps/desktop/src/main/mcp.ts` and file paths against the tree. Max 80 lines.

## 3. Update each document by its rule

| File | Rule |
| --- | --- |
| `docs/README.md` | Update the short status and its date. Put details in the linked doc, not here. Keep the reading order and glossary current. |
| `decisions.md` | Add new decisions to the right table. Never delete one: mark the old one **Replaced** and point to the new one. |
| `launch-plan.md` / `work-map.md` | The roadmap and the open work. Mark finished items, and add new open items with the founder's words. |
| `working-guide.md` | Add new pitfalls, check recipes and founder preferences. Remove recipes that no longer work. |
| `architecture.md` | Change only when structure changed (a process, a module's job, a data flow, a file location). No line numbers. |
| `design-system.md` | Add new shared parts, tokens and approved screens. Same commit as the CSS change. |
| `docs/history/` | Finished plans, logs, research and drafts. Do not rewrite them. Change only a status note or a link path. Never rewrite the founder's words (`history/idea.md` and the other idea files). |
| `AGENTS.md` / `CLAUDE.md` | Only binding rules (what every agent must or must not do). Facts and history go to the docs above. |
| `apps/desktop/README.md` | Run, connect, tool table, dev automation. Keep it under ~150 lines. |
| Templates (`apps/desktop/resources/…`) | Fix tool names or behaviour that changed. They ship to users. |

## 4. Move finished plans to history

- A plan or a log moves to `docs/history/` when its work is done, when a new
  plan replaces it, or when it is a dated record. Use `git mv` and keep the
  file name.
- Fix every link to a moved file, and every link from it: `git grep` the
  file name in all tracked files, code comments included.
- Keep a draft in `docs/history/drafts/` only when the founder wants to keep it.

## 5. Remove outdated lines

- Delete or correct every line the audit found. Do not add a correction below
  an outdated line.
- If two docs say the same thing, keep it in one place and link to it.
- Keep each file focused: if a section grows long and belongs elsewhere, move
  it.

## 6. Check for design drift

Run these searches (read-only) and fix or report findings:

- Hard-coded colours outside the token files:
  `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" apps/desktop/src/renderer/src --include="*.tsx" --include="*.css" | grep -v -e tokens.css -e content.css`
- Menus or popovers that do not use the shared parts: new `className` values
  containing `menu`, `popover`, `pop`, `button` that are not in the menu
  system's comment block in `styles/app.css`.
- New spacing values in CSS that do not use a token or a `--menu-*` property.

## 7. Memory

Update the auto-memory only for facts the repo cannot hold (who the founder
is, how they like to work, cross-project context). Point to the docs instead
of copying them.

## 8. Commit and report

1. Commit the docs on their own: `docs: session wrap-up <YYYY-MM-DD>` (end the
   message with the attribution line from the system reminder).
2. Push only if the founder asked to push in this session.
3. Tell the founder in a few lines: which docs changed, what was removed as
   outdated, and the open follow-ups.
