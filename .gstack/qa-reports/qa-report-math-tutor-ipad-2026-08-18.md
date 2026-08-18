# Math Tutor iPad session switching QA — 2026-08-18

## Result

PASS for the reported session-switch failure.

## Reproduction

1. Start with the tutor docked and a non-current recent session available.
2. Swipe left to hide the tutor dock completely.
3. Restore it from the tutor orb.
4. Swipe right to reveal Sessions.
5. Press a non-current recent-session row while the finger drifts 11 points.

Before the fix, 11 points fell between the row's 10-point tap allowance and the drawer pan's 12-point commit threshold, so neither action ran.

## Fix verified

The session row now uses the drawer pan's own 12-point intent threshold. This removes the silent 10–12 point interval without changing the pan threshold.

## Automated evidence

- Exact hide → restore → Sessions → 11-point drift → switch-session UI regression: 3/3 fresh-launch iterations passed.
- Final clean exact regression run: passed.
- Row tap/pan threshold contract unit test: passed.
- Reopened dock touch regression: passed.
- Sessions drawer board/tool-rail hit-area regression: passed.
- Whiteboard pan does not scroll docked chat regression: passed.
- `git diff --check`: passed.

## Device status

The signed final build installed successfully on the paired physical `iPad (2)` (6th generation). Automatic launch was denied because the iPad was locked; unlock it and open Math Tutor to hand-test the same sequence. Simulator validation used an iPad Pro 13-inch simulator on iOS 26.4.

## Scope note

The repository already contained extensive unrelated uncommitted work. It was preserved; no commit was created.
