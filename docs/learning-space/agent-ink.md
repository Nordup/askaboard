# How agent ink is made

This page records how the app turns an agent's pen shape into ink: the
pipeline, every parameter and default, and the evidence on a real board.
The learner's shapes (decision B71) and the colour swatches of the style
pill use the same recipe through the same functions. Use this page to
reproduce the look later, for example for other icons.

The founder (2026-11-07): "can you preserve exactly how they're made so we
can reproduce them later? … for even for those like icons, use the same
style of ink."

Terms:

- **Pen shape**: a scene's `circle`, `ellipse`, `rect`, `line`, `arrow`,
  `polygon` or `path` with `{ pen: true }`. Without a fill, it becomes ink.
- **Pressure**: a number from 0 to 1 on each ink point. The painter makes
  the line thicker where the pressure is higher.
- **Taper**: the length at each end of a stroke where the pressure rises
  from a low value, or falls to a low value.
- **Board point**: the unit of board coordinates.

## The pipeline, step by step

All references are to `space/src/`.

1. **The outline.** The scene library builds the path as absolute SVG
   segments (`shared/pen-shapes.ts`; the stage gets these functions through
   `stage/worker.ts` `G.__shared`).
   - Circle and ellipse: `ellipseSegments` (`pen-shapes.ts:14`). Four cubic
     arcs (constant 0.5522847498), then `Z`. The path starts at the left,
     at (cx − rx, cy), and goes down first (clockwise on screen).
   - Rectangle: `rectSegments` (`pen-shapes.ts:32`). With a radius r > 0 it
     starts at (x + r, y) on the top side and goes clockwise, with an arc at
     each corner. With r = 0 it starts at the top-left corner. A scene's
     `rect()` has **no default radius** (r = 0, `stage/live-prelude.js:985`);
     an agent gives `radius` itself.
   - Line: one straight segment (`live-prelude.js` `line`).
   - Arrow: the shaft, then one stroke from one wing over the tip to the
     other wing (`live-prelude.js:913`, `known` at `:931`). The head size is
     `arrowHead` (`pen-shapes.ts:41`): max(10, min(22, 0.2 × length,
     5 × width)). The wings turn 0.45 radians off the shaft
     (`arrowWings`, `pen-shapes.ts:46`).
   - Coordinates round to 0.01 (`f2`, `pen-shapes.ts:11`).
2. **Flatten.** `flattenPath(segments, 'ink')`
   (`shared/path-geometry.ts:171`) makes one polyline per subpath. A curve
   gets enough steps to stay within 0.25 board points of the true curve
   (`FLAT_TOLERANCE`, `:29`; Wang's formula, `wangSteps`, `:224`). `Z` adds
   the start point again (`:192`), so a closed loop ends where it began.
3. **Sample.** `polylineInk` (`shared/ink-points.ts:63`) walks all the
   polylines as one length.
   - It takes max(2, ceil(total / 1.5)) steps (`inkSteps`, `:18`).
   - It skips a segment with no length (equal ends in single precision,
     `:76`).
   - A jump longer than 3 × step + 0.5 starts a new stroke (`:28`). This is
     how an arrow's head becomes its own stroke.
   - `simplify` (`:44`) keeps the first point, each point at least
     `INK_STEP` = 2.5 board points (`:15`) from the last kept one, and the
     last point.
   - The stage calls it in `shapeObject` (`live-prelude.js:858`): a pen
     shape without a fill becomes `kind: 'ink'`, with jitter 0.3 when the
     scene gives none (`:841`) and width 3 when it gives none (`styleOf`,
     `:341`).
4. **Humanize.** The board compiles each stroke with
   `humanize(points, jitter, mulberry32(strokeSeed(key, points)))`
   (`renderer/src/live/compile.ts:525`, `:541`). `humanize` is in
   `renderer/src/board/hand.ts:103`.
   - Wobble (`wobbled`, `hand.ts:66`): the line is split into steps of at
     most 2.5 board points. Each point moves along the line's normal by
     amplitude × (0.7 × sin(s / 23 + φ1) + 0.3 × sin(s / 7.3 + φ2)), where
     s is the length along the line. The amplitude is 2.2 × jitter
     (`PEN_WOBBLE`, `:60`): 0.66 board points at jitter 0.3.
   - Taper: min(18, 0.18 × the stroke length) (`:106`).
   - Base pressure: 0.5 + 0.1 × random (`:109`).
   - Ends: rise = min(1, s / taper), fall = min(1, (length − s) /
     (1.4 × taper)), ends = 0.25 + 0.75 × min(rise, fall) (`:113`). The
     fall is longer than the rise, as a pen that lifts slowly.
   - Pressure = clamp(base × ends + 0.05 × sin(s / 31 + φ3), 0.08, 1),
     rounded to 0.01 (`:114`).
   - The random source gives four numbers per stroke, in this order: φ1,
     φ2, φ3, base. The same seed always gives the same stroke.
   - A closed loop is not closed again after the wobble. Its two ends lie
     near each other (the wobble differs a little at s = 0 and s = length),
     and the taper makes both ends thin. The loop does not overlap itself.
5. **Paint.** The painter (`renderer/src/board/paint.ts`) draws ink with
   varying pressure as one curve piece per sample (`:292`): from the
   midpoint before the sample, through the sample as the control point, to
   the midpoint after it (`writePiece`, `:93`), with round caps. Each
   piece is width × `pressureWidth(p)` wide (`strokePieces`, `:115`).
   `pressureWidth(p)` = 0.35 + 1.3 × p (`board/geometry.ts:82`). So at
   pressure 0.5 the line is 1.0 × the width, and at the 0.08 floor it is
   0.45 × the width.

A pen shape **with a fill** is different: the board draws its outline as
one even line with the wobble and no pressure (`compile.ts` `handPath`,
`hand.ts` `handLine`), and the fill shows after the outline.

## Parameters and defaults

| Parameter | Value | Where |
| --- | --- | --- |
| Jitter (no `jitter` option) | 0.3 | `live-prelude.js:841`, `compile.ts:525`, `hand.ts PEN_JITTER` |
| Width (no `width` option) | 3 board points | `live-prelude.js:341` |
| Wobble amplitude | 2.2 × jitter (0.66 at 0.3) | `hand.ts:60` |
| Wobble waves | periods 2π × 23 and 2π × 7.3 board points | `hand.ts:60` |
| Wobble mix | 0.7 and 0.3 | `hand.ts:78` |
| Taper | min(18, 0.18 × length) | `hand.ts:106` |
| Fall length | 1.4 × taper | `hand.ts:113` |
| Base pressure | 0.5 to 0.6 | `hand.ts:109` |
| Pressure ripple | 0.05 × sin(s / 31 + φ3) | `hand.ts:114` |
| Pressure range | 0.08 to 1 | `hand.ts:114` |
| Sampling | max(2, ceil(length / 1.5)) steps | `ink-points.ts:18` |
| Stroke split | jump > 3 × step + 0.5 | `ink-points.ts:28` |
| Simplify | points at least 2.5 apart | `ink-points.ts:15` |
| Flattening | within 0.25 board points | `path-geometry.ts:29` |
| Painted width | width × (0.35 + 1.3 × p) | `geometry.ts:82` |
| Loop start | ellipse: left middle; rounded rect: (x + r, y) | `pen-shapes.ts` |
| Loop close | `Z` repeats the start; no overlap | `path-geometry.ts:192` |
| Arrow head | max(10, min(22, 0.2 × length, 5 × width)), wings ±0.45 rad | `pen-shapes.ts:41`, `:46` |
| Rect radius | 0 unless the scene gives one | `live-prelude.js:985` |

## Evidence on a real board

The founder's board `boards/Neuron.board.json` (learning folder
`/Users/nordup/Projects/learning/learning-space`), checked 2026-11-07:

- Ring `s_s13wugjj`: colour #6e8bff, width 3, 92 points, about 86 × 86
  (r 43). It starts at the left middle of its box. The gap between its
  start and its end is 0.1. First pressures 0.12, 0.19, 0.27, 0.34; last
  0.26, 0.20, 0.18.
- Myelin box `s_zzc0w2l8`: colour #e8cb7e, width 3, about 67 × 49, 68
  points. It starts at x 18.5, y 0 of its box (the agent gave radius about
  18.5). First pressures 0.11, 0.18, 0.25, 0.32; last 0.18, 0.13, 0.11.

The same recipe on a circle of r 43 gives 91 points, an end gap of about
0.3 to 0.4, and first pressures 0.15 to 0.17 that rise by about 0.07 per
point.

## The learner's shapes

`renderer/src/board/shapes.ts` `makeGeometry` builds a learner's shape
with the same functions, in the shape's local coordinates (its x, y is
0, 0):

1. The outline: `rectSegments(0, 0, w, h, r)` or
   `ellipseSegments(w / 2, h / 2, w / 2, h / 2)`, then
   `flattenPath(…, 'ink')`. A line is one segment. An arrow is the shaft and
   the head as in step 1 above, with `arrowHead(length, width)`. A second
   head (heads "both") is its own stroke at the start.
2. The ink: `hand.ts penInk(lines, mulberry32(node.seed))`, which is
   `polylineInk`, then `humanize` at jitter 0.3 for each stroke. The strokes
   of one shape take their random numbers from one source, seeded by the
   node's `seed`.
3. The rectangle radius is min(12, 0.2 × the shorter side). A scene's
   `rect()` has no default radius, so this is the learner's own value.
4. The widths stay the shape table: Fine 1.5, Medium 2.5, Bold 4
   (`tools.ts SHAPE_WIDTHS`). An agent's default is 3.
5. A dashed or dotted line is the humanized line cut by its length. Each
   dash and dot keeps the pressure of the line at its place, so dashes near
   the start and the end are thinner.
6. A fill follows the flattened outline without the wobble.
7. The existing ink painter draws the strokes with pressure (step 5 above).

## Ink glyphs (the colour swatches)

`renderer/src/components/InkGlyph.tsx` draws a small path in the same ink
for the app's controls.

- `InkGlyph` takes absolute segments, a width, a seed and a view box. It
  runs `flattenPath` and `penInk` with `mulberry32(seed)`, then writes one
  SVG curve piece per sample with the painter's rule (`writePiece`) and
  round caps. It draws in `currentColor`, and SVG keeps it sharp on any
  screen.
- `PenRing` is a colour swatch: `ellipseSegments(0, 0, 7, 7)` (a circle of
  r 7) at width 3, in the box −9.5 … 9.5. The CSS size is `--swatch-dot`
  (15 px), so the nominal line is about 2.4 px and about 2.6 px at the
  usual pressure. The seed is `strokeSeed('swatch:' + colour id, [])`, so
  each colour keeps its own ring.
- A new icon in this ink: give `InkGlyph` its path (from
  `shared/pen-shapes.ts` or your own segments), width 3 and a fixed seed,
  and size it with a token.
