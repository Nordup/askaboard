# Shell parity notes

The web shell now follows the current SwiftUI shell behavior in `UIState`, `BoardScreen`,
`TutorPanel`, and `TutorFullScreen`. Paper page 1 was read directly for its board values;
the reference artboards are `OR-0` (docked), `ZU-0` (full screen), `RJ-0` (collapsed),
`60P-0` (docked drawer), `3KT-0` (settings), and `69J-0` (full-screen sidebar), each
1376 × 1032. The running Swift source is authoritative when its current behavior differs
from an older Paper composition: full-screen tutor currently uses the panel-scale Orb and
content, not the larger gallery hero.

## Corrected port mismatches

- The first web pass did not preserve the Swift shell's eased, interruptible presentation
  and drawer transitions. Dock/collapse/full-screen and drawer/sidebar motion now share a
  sampled Swift spring; reduced-motion preferences settle immediately.
- Full-screen layout had drifted from the measured reading lane. The web app now retains the
  740px outer lane and 600px live panel-treatment lane, keeps the board mounted but hidden,
  and uses the board-peek edge as the way back. It does not add board action chrome.
- Native browser button styling showed through on drawer actions. `app.css` now resets
  buttons and controls before applying the source surface styles.
- Resizing now follows the source minimum, maximum, collapse threshold, keyboard increments,
  and double-click/Home reset. Session menus use a dismissible shield and keyboard handling;
  Settings uses custom source-styled pickers and destructive session reset calls the dedicated
  reset contract.
- The Composer remains mounted through docked, collapsed, and full-screen transitions; its
  per-session draft cache is owned by the tutor component. The visible voice controls are
  scoped to the active session, with a return-to-call pill for a call in another session.

## Measured shell geometry

Browser `getBoundingClientRect()` measurements at the Paper reference size (1376 × 1032):

| State | Measured bounds |
| --- | --- |
| Docked | Tutor x=28, w=337; rail x=389; board x=485, w=863; content y=28, h=976 |
| Full screen | Tutor surface x=0, w=1376; thread x=318, w=740; start lane x=388, w=600 |
| Full-screen Orb | x≈640, y≈198, 96 × 90; greeting starts y=328 |
| Full-screen composer | x=388, y=954, w=600, h=50 |
| Full-screen sidebar | sidebar w=296; tutor surface x=296; thread x=466, w=740; start lane x=536, w=600 |
| Collapsed | Tutor surface hidden; 132 × 64 tutor dock remains beside the selection affordance |
| Settings | Centered 760 × 560 window at x=308, y=236 |

At 1280 × 720 the dock and full-screen tutor still use the computed source lanes. With the
sidebar closed, the full-screen outer thread is centered at x=270/w=740; with it open, the
reserved sidebar moves the thread to x=407.5/w=740, and the composer sits at y=642. At 390 × 844,
the full-screen reading column is 244px wide at x=73 with the sidebar closed. When the 244px
sidebar minimum would leave less than a 244px reading column, the web shell keeps the tutor
at full width and presents the sidebar as an overlay. The existing sidebar toggle moves to
the visible chat strip so mouse users can close it; after closing, the original toggle is
available to reopen it. Its open preference stays set across resizing; at 1280 × 720 it
returns to the source's reserved-lane geometry (sidebar 275px, tutor x=275, thread
x=407.5/w=740, inner column x=477.5/w=600).

## Browser evidence

Playwright CLI screenshots are saved under `output/playwright/`:

- `shell-1376-docked.png`, `shell-1376-drawer.png`, `shell-1376-collapsed.png`
- `shell-1376-fullscreen.png`, `shell-1376-sidebar.png`, `shell-1376-settings.png`
- `shell-1280-docked.png`, `shell-1280-drawer.png`, `shell-1280-fullscreen.png`
- `shell-1280-fullscreen-sidebar.png`
- `shell-390-fullscreen.png`, `shell-390-fullscreen-sidebar.png`

Manual browser checks covered the session context menu opening from a row's context menu,
Escape dismissal, pointer resizing from 337px to 389px, double-click reset to 337px, and
fullscreen-to-board-peek return. At 390px, mouse-clicking the relocated toggle closes the
overlay and the restored panel toggle reopens it; the same open state was resized to 1280px
and measured in the restored reserved lane. Board
interaction/selection/history checks are recorded by the board worker in `BOARD_PARITY.md`.

Pure layout, resize, spring, reveal, and shell-state tests are included in
`src/shell/*.test.ts`. Validation on 2026-10-08: `npm test` passed (15 files, 74 tests), and
`npm run build` passed. Vite reports the existing large-chunk advisory; it does not fail the
build.
