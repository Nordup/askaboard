# Learning Space: the agent guide

## The board
<!-- topic: model -->
<!-- summary: The board as a tree of nodes and ink groups: kinds, ids, bounds and positions. -->

- A board is a tree of nodes: frame (a box that holds children), text, svg, image, and ink (pen strokes).
- Ink is the learner's handwriting (author "learner") or yours. Ink inside a frame moves with the frame.
- Every node has a stable id. get_tree shows ids, kinds, names and world bounds "x,y w×h".
- Ink groups: the app clusters strokes by distance and time into groups g1, g2, … (one per parent and author; each draw_ink call is its own group). A group keeps its id while the learner adds to it; merged groups keep the older id. Use a group id wherever you read or place: get_screenshot node_id, near, place, move_nodes, duplicate_nodes, delete_nodes.
- Top-level nodes sit at x, y on the board. Children of a flex frame are placed by the flex layout. Children of a frame without display:flex sit at their x, y inside the frame.

## HTML you can write
<!-- topic: html -->
<!-- summary: The HTML subset of write_html: tags, flex layout, names, the accepted styles and units. -->

- write_html takes a small HTML subset with inline styles only (style="…"). No <style>, no classes, no scripts.
- Boxes: <div>. A div with child elements becomes a frame. Use display:flex with flexDirection, gap, padding, alignItems, justifyContent.
- No margin, no grid, no tables, no float. Space things with gap and padding. A div without display:flex becomes a flex column.
- Text: <h1>…<h6>, <p>, <span>, <li>. A block with only inline content becomes one text node.
- Inside text: <b>/<strong> for bold, <i>/<em> for italic, <br> for a new line. Inline styles on <span> are dropped: style the whole block.
- Lists: <ul>/<ol> with <li> become a column of text lines with "•" or "1." prefixes.
- <pre> keeps whitespace and shows text literally (code).
- Names: layer-name="Hint 1" on any element gives the node a name; write_html returns a name → id map.
- Free placement inside a frame: give the children position:absolute; left:…px; top:…px and leave the frame without display:flex.
- Style names work in camelCase or kebab-case (fontSize or font-size).
- Allowed style keys: width, height, min/max width and height, padding (and sides), gap, rowGap, columnGap, display (flex, block, none), flexDirection, flexWrap, alignItems, alignContent, justifyContent, alignSelf, flexGrow, flexShrink, flexBasis, background, backgroundColor, color, opacity, borderRadius, border (and sides, color, width, style), boxShadow, fontSize, fontWeight, fontStyle, fontFamily, lineHeight, letterSpacing, textAlign, textDecoration, textTransform, whiteSpace, overflow, objectFit. Others are dropped and listed in "ignored".
- Units: px for sizes and font sizes; lineHeight in px or a plain number. Boxes use border-box sizing.
- Frames: set a width and use height:fit-content so the frame grows with its content.

## Text markup and math
<!-- topic: math -->
<!-- summary: Text markup and math ($…$ in KaTeX syntax) in write_html and set_text. -->

- Text nodes store light markup: **bold**, *italic*, $inline math$ (KaTeX syntax, for example $T^2 \propto a^3$).
- In write_html, write math as $…$ inside the text; it passes through. set_text takes the markup directly.
- A literal * or $ is written \* or \$ in set_text.

## Diagrams (SVG)
<!-- topic: svg -->
<!-- summary: Diagrams as inline SVG: size, element ids, markers and gradients. -->

- Draw diagrams as inline <svg> with a viewBox. Give the svg a width and height in its style (or attributes).
- Give shapes ids (id="atom-a"): they are kept, and get_node_info lists them. Ids are scoped per drawing, so two drawings may both use "arrow".
- Markers and gradients work with url(#id) inside the same svg. No scripts, no foreignObject, no external links or images.
- Use the colour tokens (fill="var(--ls-accent)") so diagrams match the app.

## Images
<!-- topic: images -->
<!-- summary: Images from https URLs, data: URLs or files in the learning folder. -->

- <img src="https://…"> downloads the picture into the folder's assets/ (images only, up to 10 MB). data: URLs are saved there too.
- A path inside the learning folder (assets/orbit.png) is used as is.
- Give images a width and height (style or attributes), so the layout does not jump when they load.

## Colour and font tokens
<!-- topic: tokens -->
<!-- summary: The colour and font tokens of the dark board, and text sizes. -->

- Use these in any style value: var(--ls-card), var(--ls-card-2) (backgrounds), var(--ls-text), var(--ls-muted) (text), var(--ls-accent) (blue), var(--ls-good) (green), var(--ls-bad) (pink-red), var(--ls-warn) (yellow), var(--ls-border), var(--ls-font), var(--ls-mono).
- The canvas is dark. Literal colours work too; keep contrast high.
- Text sizes: 22–28px titles, 15–17px body, 13px for small notes. Avoid text under 12px.

## Placement
<!-- topic: placement -->
<!-- summary: place, near, find_space, overlaps, screenshot labels and move_nodes. -->

- place: {right_of | left_of | below | above | over: id, gap?: 32, align?: "start" | "center" | "end"} puts a thing relative to a node or ink group. create_frame, write_html (target_id "root"), duplicate_nodes, move_nodes ({node_id, place}) and draw_ink take it. A taken spot slides along that side, then the next side; the result's "placed" says what happened.
- Without place or x, y, create_frame and root writes find an empty spot beside "near" (or the learner's latest work), inside the learner's view when it fits.
- find_space({width, height, near?}) returns an empty rect (32 pt from everything) for x, y writes.
- Every write and move returns overlaps: [{id, kind, author, area_pct}] for what it now covers, and warnings such as "covers learner ink g3". Fix those with move_nodes unless you meant it (a mark with place over).
- Never cover the learner's ink with material unless they ask.
- get_screenshot with labels: true tags every group and top-level node with its id; grid: true adds board coordinates. Use them to match the image to ids and points.
- move_nodes moves anything, learner ink included: {node_id, place}, {node_id, x, y} (top-left in the parent's space), {node_id, dx, dy}, {node_id, parent_id, index} ("root" = top level) or {node_id, before|after}.

## Drawing ink (marks on the learner's work)
<!-- topic: ink -->
<!-- summary: draw_ink: marks from the bounds of a target, free strokes and colours. -->

- draw_ink draws like a pen: natural pressure, a slight wobble.
- Shapes from a target's bounds: draw_ink({shape: "circle", target: "g3"}) circles a mistake; {shape: "tick", target: "g2"} or "cross" goes just right of it; {shape: "underline", target: "g4"}; {shape: "arrow", target: "g3", from_id: "n_hint"} points from your note to their work.
- Free drawing: strokes [[[x, y], …], …] or svg_path "M0 0 C 20 -30, 60 -30, 80 0"; place {over: "g3"} centres it on the target, {right_of: "g3"} puts it beside. Example arrow: svg_path "M0 0 L80 0 M66 -10 L80 0 L66 10", place {left_of: "g2"}.
- Colours: pink (bad) circles and crosses, green (good) ticks, accent otherwise. The default never matches the learner's pen colour.
- Each call is one undo step and one ink group: delete_nodes(["g7"]) removes that mark.

## Moving the learner's view
<!-- topic: view -->
<!-- summary: focus: how and when to move the learner's view. -->

- focus({node_id}) glides the learner's view to a node or ink group; it zooms out only when needed. It does nothing when the target is already visible.
- Use it rarely: only when the learner must see something now (for example material you placed outside their view).
- Do not move the view while they write. focus skips itself while a stroke is in progress or within 2 s of the last one, and says so; then tell the learner where to look instead.

## Live scenes (run_scene)
<!-- topic: scene -->
<!-- summary: run_scene and scene_control: every global of a scene program, its options, time, values, names, labels, camera, speech, pauses, preview and the queue. -->

A scene program is the body of an async function. These globals are all it has (plus plain JavaScript: Math, arrays, functions; Math.random is seeded per run). Points are board points [x, y]; +y is down.

**Time.** Every action starts now. `await` waits for its end; without `await` the next line starts at the same moment:
```js
const a = circle(0, 0, 60), b = circle(150, 0, 60)
draw(a)              // a and b are drawn together
await draw(b)        // the next line starts when b is done
await all(fadeOut(a), move(b, { to: [0, 0] }))
```
Async functions run side by side, each with its own time: `await Promise.all([left(), right()])`. The scene lasts until its last action ends; the board after the scene is its state at the end.

**Values and changing objects.** `value(n)` is a number that changes over time: `v.get()` (its value now), `v.set(n)` (jumps now), `tween(v, n, s)` (glides to n). Any argument or option of a creator may be a value or a function of values; the object is drawn again as they change, and `.bounds`/`.center` follow:
```js
const h = value(0)
const disc = ellipse(0, () => -h.get(), () => Math.sqrt(R * R - h.get() ** 2), 10, { fill: "accent" })
const tag = write(() => "h = " + h.get().toFixed(1), { at: () => [R + 20, -h.get() - 14] })
await tween(h, 80, 3)
```
`trace(() => [x, y], o)` is the path a moving point leaves: a line through the point's places from when it is made until now (options as path). `tween(obj, {width: 6, fillOpacity: 0.3}, s)` animates any numeric option of the object's creator. A function as an argument of `plot` (fn) reads values the same way. Changing objects are sampled 30 times a second while anything animates.

**Objects** are invisible until an action shows them (draw, fillIn, fadeIn, tween draw). An object that no action shows appears when it is made. Every object has `.bounds` {x, y, width, height}, `.center` [x, y] (at the current time), `.name`, `.kind`; live items also `.params`.
- `stroke(points, o)`: ink through [[x, y] or [x, y, pressure 0..1], …]; a list of such lists makes several strokes.
- `line(x1, y1, x2, y2, o)`, `arrow(x1, y1, x2, y2, o)` (o.head: head length).
- `circle(cx, cy, r, o)`, `ellipse(cx, cy, rx, ry, o)`, `rect(x, y, w, h, o)` (o.radius: corner radius), `polygon(points, o)` (o.closed: false for an open polyline), `path(d, o)` (any SVG path "d").
- `plot(fn, o)`: the curve y = fn(x), o.x: [min, max] (default [-4, 4]); or fn(t) → [x, y] with o.t: [t0, t1]. o.at: the board point of (0, 0); o.unit: board points per unit (default 50; or [ux, uy]); o.y: [min, max] clips; o.samples (default 240). Maths y goes up.
- `write(text, o)`: handwriting, as ink. o.at: top-left, or o.center; o.size: cap height (default 28); o.slant (default 0.12). Letters, digits, + − × ÷ = ≠ ≈ ≤ ≥ ± √ ∫ ∑ ∞ ∂ → ° and Greek (π θ α …); "^2", "^{10}", "_1" or ² ₁ for small raised and lowered text.
- `tex(latex, o)`: typeset maths (KaTeX), as a text node. o.at (top-left) or o.center; o.size (default 30); o.color.
- `text(str, o)`: typeset text, as a text node, with **bold**, *italic* and $math$. o.at or o.center; o.size (default 22).
- `label(target, text, o)`: text placed next to target, clear of the scene's objects, the board's items and the view's edge. target: an object, a point [x, y], or a segment [[x1, y1], [x2, y2]]. o.at: a point on an object ([x, y], or a share 0..1 along its outline) or a share along the segment (default 0.5); o.side: "auto" (default), "center", above, below, left, right, above-left, above-right, below-left, below-right; o.gap (default 10). Handwritten; o.tex: true typesets it as maths, o.text: true as text. Other options as write/tex. It follows its target as the target moves or changes.
- `around(obj, o)`: a hand-drawn ink mark around an object: o.shape "circle" (default), "box" or "underline"; o.pad.
- `shader(glsl, o)`, `canvas(src, o)`: live pixels, drawn by the board every frame: a GLSL fragment shader, or a 2D canvas program. o.at (top-left) or o.center; o.size [w, h] (default [320, 200]); o.params {name: number}, animated with `tween(obj, {params: {name: n}}, s)` or given as values.
- `group(...objs, {name})`: one object made of others; actions on it act on all of them (draw draws them one after another). It moves, scales and rotates around its own centre. A group with a name becomes one board item (a frame holding its items) that the learner moves as a whole.
- `board.node(id)`: an item already on the board, by node id, ink group id ("g3") or name (a name given in an earlier scene; the latest item with it). The actions work on it. `board.view` is the learner's view {x, y, width, height} now (after this scene's camera moves).

**Options** (o) of shapes and ink: color (accent, good, bad, warn, text, muted, white, yellow, blue, green, pink, orange, purple, teal, a token such as var(--ls-good), or any CSS colour; default text), width (default 3), opacity, dash (true or [8, 6]), fill (a colour, or a list of colours for a top-to-bottom gradient), fillOpacity, hatch (a colour: diagonal hatching), pen (true: the shape becomes ink, with a hand's wobble), jitter (wobble of ink, 0..1), tool ("highlighter"), name (the item's name on the board and in board.node).

**Actions** take a duration in seconds or {dur, ease}; ease is linear, in, out, inOut or smooth. Each returns something to `await`.
- `draw(obj, s)`: a pen draws it (ink along its strokes, shapes along their outline, then their fill; text and live items wipe in). Default: the speed of a hand.
- `fillIn(obj, s)`: the fill appears (and the outline, if not drawn yet). Default 0.6.
- `fadeIn(obj, s)`, `fadeOut(obj, s)`: default 0.5. Faded out, it is removed from the board at the end.
- `erase(obj, s)`: undraws it, then it is removed from the board.
- `move(obj, {to: [x, y]} or {by: [dx, dy]}, s)`: to puts its centre there. Default 0.8.
- `tween(obj, props, s)`: x, y (offset from where it was made), scale, rotate (degrees), opacity, color, draw (share drawn, 0..1), params (live items), or any numeric option. `tween(value, n, s)` for values. Default 0.8.
- `camera({fit, to, zoom, pad}, s)`: the learner's view glides: fit (an object or [x, y, w, h], with pad, default 40) and/or to (a centre [x, y]) and/or zoom. Default 1. After the learner pans or zooms during the scene, its later camera moves are skipped.
- `point(target, s)`: a pointer glides to an object's centre or a point [x, y] and rests there; `point(null, s)` hides it. Default 0.6.
- `say(text)`: a spoken line from now; it lasts as long as the system voice takes to say it (when speech is off: about 2.6 words per second, and nothing is spoken). `await say(…)` waits until it ends.
- `wait(s)`; `step(name, {pause})`: names this moment (returned as steps); with pause: true, playback stops here until scene_control resumes it. When the learner starts drawing, playback pauses at the next step (or at once when no step is left). `all(...actions)`: ends when all of them end.

**Playback and tools.** run_scene with `when: "queue"` (default) starts after the scenes that play or wait; `"now"` starts at once. `preview: true` returns a storyboard image (the end of each step, and the end) and the warnings, and draws nothing. Every run returns warnings for unknown options, text that overlaps shapes or other text, and objects outside the learner's view. scene_control: status, pause, resume, stop (jump to the end state), skip (drop the waiting scenes and their items).

`console.log(…)` goes to the result's log. Text and live items keep no rotation, and existing frames and text keep their size and angle on the board: they rotate and scale while the scene plays only.
