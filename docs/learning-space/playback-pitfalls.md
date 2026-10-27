# Learning Space — playback and drawing pitfalls: where glitches come from

> Status (2026-10-27): a list of the failure classes we know in how scenes
> are sampled, sent and drawn, with the place in the code, how to see the
> fault, and how to measure it. Read it before you change sampling, ink
> points, frames, the player or the board's painting, and when the founder
> reports a glitch in an animation. Add a new class when you find one.

## How to check a playback change

- **Check motion, not stills.** A still frame can look right while the
  motion is wrong. On 2026-10-27 the ink-points speedup (996afec, B14)
  passed still-picture checks (similarity ≥ 0.992) while a pendulum's string
  came off its bob by up to 10 points in motion; the founder saw it by eye.
- **Measure an invariant over time.** Pause the scene at many times and
  read the scene state with the dev hook `__spaceDev.scene.snap()` (the
  overrides and ink of now; `space/src/renderer/src/App.tsx`). Example: the
  distance between a pen line's end and the shape it is attached to must stay
  near 0 at all times. A small script does it: replay the run, pause at many
  times through the dev hook, call `snap()`, and compute the distance (the
  2026-10-27 check had a maximum of 9.9 pt before the fix and 0.01 pt after).
- **Then check the pixels.** A screen recording (`scripts/perf/replay.mjs`
  records `video.mp4`) and a frame-by-frame comparison of the same moments
  show paint timing faults that the scene state cannot show.
- **"Point count changed" is a red flag.** When a comparison reports strokes
  with one point more or fewer, check the blending (class 1).

## Known failure classes

| # | Class | What you see | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | **Point count changes between samples.** The stage puts ink points on a grid along the length (`count = max(2, ceil(total/1.5))`, `space/src/shared/ink-points.ts`). A length on a grid step, even by rounding, flips the count between samples. | A pen line lags a shape that moves with it (string and bob), up to one sample step. | Blending in `space/src/renderer/src/live/player.ts` (dyn interpolation). | Fixed 2026-10-27 (42b16e8): strokes with different counts blend by share of length. Ink still holds when the number of strokes changes. |
| 2 | **Gaps between kept samples.** The stage drops a sample equal to the one before (`space/src/stage/live-prelude.js`, the sampling pass). If the gap grows past `BLEND_GAP`, the player holds instead of blending. | An object stops for one step at a turning point, while another moves. | `live-prelude.js` sampling; `player.ts` `BLEND_GAP`. | Fixed 2026-10-27 (42b16e8): the last sample of each run of equal samples is kept. |
| 3 | **Ink and shapes painted in different frames.** Shapes are DOM/SVG updates; ink is painted on a canvas. | A pen line about one display frame behind a shape (about 6 px at speed). | `space/src/renderer/src/board/Board.tsx` (`requestPaint`), the cached ink layers of B11 (`board/paint.ts`). | Fixed 2026-10-27 (4db961e): a playback frame paints its ink at once. Watch it if the ink layers change again. |
| 4 | **A shape's path changes structure between samples** (different commands or count). | The shape holds for one step instead of blending. | `player.ts` shape blending. | Open (rare). Same idea as class 1 would fix it. |
| 5 | **Live item params one frame late.** Params of shader, canvas and program items go through React state. | A live item lags the scene by one frame. | `space/src/renderer/src/live-pixels/` (`registry.ts`), `live/params.ts`. | Open. |
| 6 | **Preview and playback time grids differ.** Previews snap to a 60 Hz tick grid (B10); a pause can stop 2–4 ms before the reported time. | A preview and a paused frame of a stateful live item differ slightly. | `live-pixels/clock.ts`, `runtime.ts`. | Known limit (B10). |
| 7 | **The script panel covers the board's top-right corner (and the tool palette its bottom).** Agents do not know it is there and place material under it. | Labels and parts of drawings hidden in all four check runs of 2026-10-27. | The view in `list_items` (then `get_canvas_info`) and the view checks; `components/ScriptPanel.tsx`. | Fixed 2026-10-27: `list_items` (then `get_canvas_info`) and `board.view` list as `covered` the panel's full-height area (also before the first scene; the bar only while minimised; `ScriptPanel.tsx` `scriptPanelArea()`) and the bottom tool palette (`ToolPalette.tsx` `toolPaletteArea()`), via `agent/covered.ts`. `space()` and the auto side of `label()` keep clear of it, and `preview_scene` images hatch it. Material at explicit coordinates is the agent's choice. |
| 8 | **Recipes with side effects.** The scene library evaluates an object's recipe at every sample, object by object (T18, B13). A recipe that changes state sees that order; a rebuild skips sampling. | A scene that depends on counting its own calls can differ after a rebuild. | `live-prelude.js` sampling and rebuild. | Accepted: agents are not limited; the order is fixed. |

## The root of classes 1–6: the stage samples, the player blends

> Watch item, low priority (founder, 2026-10-27). Nothing is decided or
> measured here. Read it before you add another fix to the playback path.

The stage evaluates the agent's program 30 times per second
(`SAMPLE_FPS`, `space/src/stage/live-prelude.js`), and only where something
animates. It drops a sample that equals the one before. The player runs at
the display rate (60–120 Hz) and blends two samples (`blendD`,
`blendLines`, `BLEND_GAP` in `space/src/renderer/src/live/player.ts`).

Classes 1–6 all sit on this seam:

- The blend needs two samples with the same structure (classes 1 and 4).
- A rule for the gap between samples decides between a blend and a hold
  (class 2).
- The users of one sample paint it or get it at different times (classes 3
  and 5).
- Previews and playback read time on different grids (class 6).

Each fix so far is correct for its symptom, but the class is the seam. Before
you add a new fix here, check if a change can remove the seam instead.

### Ideas to remove the seam

1. **Sample at the display rate and never blend.** The stage samples 60
   times per second. The player shows the newest sample at or before the
   time. Each frame on the screen is then a real evaluation of the agent's
   code. This removes `blendD`, `blendLines`, `BLEND_GAP` and the rule that
   keeps the last of equal samples, and closes classes 1, 2 and 4.
   - Cost: about twice the evaluations in `write_scene`, and more frame data
     (the stage sends only objects that change).
   - Risk: judder when display frames and samples do not line up. On a
     120 Hz screen, each sample shows for two display frames.
   - Measure it with `scripts/perf/replay.mjs` on the pendulum and the EM
     wave: the write time, and the motion in `video.mp4` frame by frame.
2. **One clock for every user of a sample.** Previews, playback and live
   items take the same sample for the same time. Previews pick frames from
   the sample grid (class 6). A live item gets its params in the same tick
   as the frame, or gets the whole param track once and reads it at its own
   clock (class 5). `paramsAtTime` already runs inside the item worker
   (`live-pixels/runtime.ts`).
3. **One paint step per frame for all kinds.** Shapes, ink and live items
   change from one sample in one paint step. The fix of class 3 does this
   for ink; keep it as a rule for every new kind.

Rejected before: frames computed on demand at display time. That cannot
keep any agent JavaScript valid, and agents are never limited
([`drafts/on-demand-frames-2026-10-27.md`](drafts/on-demand-frames-2026-10-27.md)).

## Where the drawing pipeline lives

Stage (agent program, sampling, ink points) → frames (typed chunks over a
direct port, B13) → board (decode, one compile per draft, B12) → player
(units, blending, B11) → painting (shapes in the DOM, ink on canvases, live
items in their own workers, B10). Decisions T18, B10–B14 in
[`decisions.md`](decisions.md); the overview in
[`architecture.md`](architecture.md); the speed work in
[`perf-plan.md`](perf-plan.md).
