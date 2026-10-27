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
  near 0 at all times. Script: the scratchpad `measure.mjs` of 2026-10-27
  (copy it into `space/scripts/perf/` when it is needed again).
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
| 7 | **The script panel covers the board's top-right corner.** Agents do not know it is there and place material under it. | Labels and parts of drawings hidden in all four check runs of 2026-10-27. | The view in `get_canvas_info` and the view checks; `components/ScriptPanel.tsx`. | Open: give agents a view without the panel's area. |
| 8 | **Recipes with side effects.** The scene library evaluates an object's recipe at every sample, object by object (T18, B13). A recipe that changes state sees that order; a rebuild skips sampling. | A scene that depends on counting its own calls can differ after a rebuild. | `live-prelude.js` sampling and rebuild. | Accepted: agents are not limited; the order is fixed. |

## Where the drawing pipeline lives

Stage (agent program, sampling, ink points) → frames (typed chunks over a
direct port, B13) → board (decode, one compile per draft, B12) → player
(units, blending, B11) → painting (shapes in the DOM, ink on canvases, live
items in their own workers, B10). Decisions T18, B10–B14 in
[`decisions.md`](decisions.md); the overview in
[`architecture.md`](architecture.md); the speed work in
[`perf-plan.md`](perf-plan.md).
