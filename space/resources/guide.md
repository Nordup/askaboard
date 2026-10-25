# Learning Space: the agent guide

## The board
<!-- topic: model -->
<!-- summary: The board as a tree of nodes and ink groups: kinds, ids, bounds and positions. -->

- A board is a tree of nodes: frame (a box that holds children), text, svg, image<!-- code-items -->, live (program, shader and canvas items)<!-- /code-items --> and ink (pen strokes).
- Ink is the learner's handwriting (author "learner") or yours. Ink inside a frame moves with the frame.
- Every node has a stable id. get_tree shows ids, kinds, names and world bounds "x,y w×h".
- Ink groups: the app clusters strokes by distance and time into groups g1, g2, … (one per parent and author; each ink object of a scene is its own group). A group keeps its id while the learner adds to it; merged groups keep the older id. A group id works wherever an item id does: board.node("g3") in a scene, get_screenshot node_id, get_node_info.
- Top-level nodes sit at x, y on the board. <!-- html -->Children of a flex frame are placed by the flex layout. Children of a frame without display:flex sit<!-- /html: Children of a frame sit --> at their x, y inside the frame.
- You write on the board with scenes (run_scene, topic "scene"): drawing, typeset text, <!-- html -->HTML material, <!-- /html -->pictures, copies, edits, moves and deletions all happen in a scene's program.<!-- html -->

## HTML material
<!-- topic: html -->
<!-- summary: The HTML subset of html() in a scene: tags, flex layout, names, parts, the accepted styles and units. -->

- html(markup, o) in a scene takes a small HTML subset with inline styles only (style="…"). No <style>, no classes, no scripts. get_html gives an existing node in the same subset.
- Boxes: <div>. A div with child elements becomes a frame. Use display:flex with flexDirection, gap, padding, alignItems, justifyContent.
- No margin, no grid, no tables, no float. Space things with gap and padding. A div without display:flex becomes a flex column.
- Text: <h1>…<h6>, <p>, <span>, <li>. A block with only inline content becomes one text node.
- Inside text: <b>/<strong> for bold, <i>/<em> for italic, <br> for a new line. Inline styles on <span> are dropped: style the whole block.
- Lists: <ul>/<ol> with <li> become a column of text lines with "•" or "1." prefixes.
- <pre> keeps whitespace and shows text literally (code).
- Names: layer-name="Hint 1" on any element gives the node a name; `obj.part("Hint 1")` finds a named part.
- One root: the markup becomes one item, its root node. Several top-level elements are put in one column frame (gap 12px); wrap them in one <div> to choose the layout. The root's children are its parts (`obj.parts`), in order.
- Free placement inside a frame: give the children position:absolute; left:…px; top:…px and leave the frame without display:flex.
- Style names work in camelCase or kebab-case (fontSize or font-size).
- Allowed style keys: width, height, min/max width and height, padding (and sides), gap, rowGap, columnGap, display (flex, block, none), flexDirection, flexWrap, alignItems, alignContent, justifyContent, alignSelf, flexGrow, flexShrink, flexBasis, background, backgroundColor, color, opacity, borderRadius, border (and sides, color, width, style), boxShadow, fontSize, fontWeight, fontStyle, fontFamily, lineHeight, letterSpacing, textAlign, textDecoration, textTransform, whiteSpace, overflow, objectFit. Others are dropped and listed in the run's warnings.
- Units: px for sizes and font sizes; lineHeight in px or a plain number. Boxes use border-box sizing.
- Frames: set a width and use height:fit-content so the frame grows with its content.<!-- /html -->

## Text markup and math
<!-- topic: math -->
<!-- summary: Text markup and math ($…$ in KaTeX syntax) in <!-- html -->html(), <!-- /html -->text() and edit(). -->

- Text nodes store light markup: **bold**, *italic*, $inline math$ (KaTeX syntax, for example $T^2 \propto a^3$).
- <!-- html -->In html(), write math as $…$ inside the text; it passes through. <!-- /html -->text() and edit(item, {text}) take the markup directly; tex() takes LaTeX without the dollars.
- A literal * or $ is written \* or \$ in markup.
- In a JavaScript string, a backslash is written twice: "$\\frac{1}{2}$".<!-- html -->

## Diagrams (SVG)
<!-- topic: svg -->
<!-- summary: Diagrams as inline SVG in html(): size, element ids, markers, gradients and colour. -->

- An inline <svg> with a viewBox in html() becomes an svg node. Give the svg a width and height in its style (or attributes).
- Give shapes ids (id="atom-a"): they are kept, and get_node_info lists them. Ids are scoped per drawing, so two drawings may both use "arrow".
- Markers and gradients work with url(#id) inside the same svg. No scripts, no foreignObject, no external links or images.
- Use the colour tokens (fill="var(--ls-accent)") so diagrams match the app. Shapes with fill or stroke "currentColor" follow the svg's color style, so edit(item, {style: {color}}) recolours them.
- draw() draws an svg's outlines along their length, one shape after another in document order, then shows the fills.
- The scene's own shapes (circle(), path(), …) are svg nodes too, made by the scene.<!-- /html -->

## Images
<!-- topic: images -->
<!-- summary: image()<!-- html --> and <img> in html()<!-- /html -->: https URLs, data: URLs or files in the learning folder. -->

- image(src, o) in a scene<!-- html -->, or <img src="…"> in html()<!-- /html -->: an https:// URL is downloaded into the folder's assets/ (images only, up to 10 MB); a data: URL is saved there too; a path inside the learning folder (assets/orbit.png) is used as it is.
- image() places the picture at o.at (top-left) or o.center, or in empty space. o.size: [w, h], or a width (the height keeps the picture's shape). Without o.size, the picture keeps its own size, made smaller to fit 480 points.
- A picture that does not download is a program error in image()<!-- html -->; in html() it is left out and named in the warnings<!-- /html -->.<!-- html -->
- In html(), give <img> a width and height (style or attributes).<!-- /html -->

## Colour and font tokens
<!-- topic: tokens -->
<!-- summary: The colour and font tokens of the dark board, and text sizes. -->

- Use these in any style value: var(--ls-card), var(--ls-card-2) (backgrounds), var(--ls-text), var(--ls-muted) (text), var(--ls-accent) (blue), var(--ls-good) (green), var(--ls-bad) (pink-red), var(--ls-warn) (yellow), var(--ls-border), var(--ls-font), var(--ls-mono).
- Scene colours take the names too: accent, good, bad, warn, text, muted (and white, yellow, blue, green, pink, orange, purple, teal).
- The canvas is dark. Literal colours work too; keep contrast high.
- Text sizes: 22–28px titles, 15–17px body, 13px for small notes. Avoid text under 12px.

## Placement
<!-- topic: placement -->
<!-- summary: Where scene material goes: at, center, space(), into frames, the warnings about overlaps and the view, screenshot labels. -->

- Creators take o.at (top-left) or o.center in board points. <!-- html -->html(), <!-- /html -->image() and copy() without them go to an empty place: space() near o.near, or near the learner's latest work in their view.
- space(w, h, o) returns an empty rect {x, y, width, height, at, center, visible}: 32 points from every item on the board and from what the scene has made so far, nearest to o.near (an object, a point or a rect) or to the learner's latest work, inside the learner's view when it fits (o.inView: false allows anywhere nearest).
- <!-- html -->html(markup, {into: frame}) puts material inside a frame of the board (o.index: its position among the children; o.mode "replace" puts it in place of an item). move<!-- /html: move -->(item, {into: frame}) moves an item into a frame. <!-- html -->In a flex frame the item joins the flow; in a free frame it keeps<!-- /html: It keeps --> its place on the board.
- An object's .bounds and .center (now, in board points) place the next thing beside it: `const b = a.bounds; text("…", {at: [b.x + b.width + 24, b.y]})`.
- Every run warns about text that a line or outline runs through, text over other text or items, and objects outside the learner's view; those warnings name the objects and times.
- get_screenshot with labels: true tags every group and top-level node with its id; grid: true adds board coordinates. Use them to match the image to ids and points.

## Marks on the learner's work (ink)
<!-- topic: ink -->
<!-- summary: Ink in scenes: marks on the learner's work, free strokes, the pen look and colours. -->

- Ink is what the learner writes with: a scene's stroke(), write() and around(), and any shape with pen: true, are ink, drawn stroke by stroke as a pen draws, slightly uneven. The learner can erase, lasso and move it like their own.
- Marks on their work: board.node("g3") is their ink group; around(g, {shape: "circle" | "box" | "underline"}) marks it; a tick or a cross is a short stroke() or path() with pen: true beside `g.bounds`; arrow(…, {pen: true}) points from your note to their line.
- Colours: bad (pink) for circles and crosses on mistakes, good (green) for ticks, accent otherwise. Choose a colour that differs from the learner's pen.
- Their ink can be acted on like any object: draw(g) traces it again, tween(g, {color}) recolours it, move(g, …) moves it, erase(g) or fadeOut(g) removes the whole group.

## Moving the learner's view
<!-- topic: view -->
<!-- summary: camera() in a scene: how and when to move the learner's view. -->

- camera({fit, to, zoom, pad}, s) in a scene glides the learner's view: fit (an object or [x, y, w, h]) and/or to (a centre) and/or zoom. board.view is their view now.
- Move it when they must see something now, for example material placed outside their view. Every run warns about objects outside the view.
- After the learner pans or zooms during a scene, its later camera moves are skipped.

## Live scenes (run_scene)
<!-- topic: scene -->
<!-- summary: run_scene and scene_control: every global of a scene program (drawing, text, <!-- html -->HTML material, <!-- /html -->pictures, copies, space, edits, moves into frames, deletion), its options, time, values, names, labels, camera, lines (say), pauses, preview and the queue. -->

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
**The stage.** Every program on a board runs in the same sandbox, one after another, each with its own time from 0. The global object `stage` keeps whatever a program puts on it (values, objects, functions, numbers) for the programs after it; top-level `const` and `let` stay local to their program. An object of an earlier program is on the board already: acting on it (draw, move, tween, fadeOut, label, …) or tweening a value its arguments read changes that same board item, and a scene starts from where the scenes before it left everything. `board.node(name or item id)` returns the earlier program's own object for items it made. An object whose items the learner erased is gone: draw or fade it in to bring it back. The stage starts new when the board changes, on `scene_control({action: "reset"})`, and when the app starts (run_scene's result then has `stage`).
```js
// one call
stage.h = value(0)
stage.disc = ellipse(0, () => -stage.h.get(), 80, 10, { fill: "accent" })
await draw(stage.disc)
// a later call
await tween(stage.h, 60, 2)   // the disc drawn by the earlier call rises
```
**Beats.** A scene can be short (one sentence and its drawing). Scenes sent while others play queue and play back to back, with no gap and no jump between them, while the next one is written. run_scene returns as soon as its program has run, with `starts_in_s` and `ends_in_s`.

`trace(() => [x, y], o)` is the path a moving point leaves: a line through the point's places from when it is made until now (options as path). `tween(obj, {width: 6, fillOpacity: 0.3}, s)` animates any numeric option of the object's creator. A function as an argument of `plot` (fn) reads values the same way. Changing objects are sampled 30 times a second while anything animates.

**Objects** are invisible until an action shows them (draw, fillIn, fadeIn, tween draw). An object that no action shows appears when it is made. Every object has `.bounds` {x, y, width, height}, `.center` [x, y] (at the current time), `.name`, `.kind`<!-- code-items -->; live items also `.params`<!-- /code-items -->.
- `stroke(points, o)`: ink through [[x, y] or [x, y, pressure 0..1], …]; a list of such lists makes several strokes.
- `line(x1, y1, x2, y2, o)`, `arrow(x1, y1, x2, y2, o)` (o.head: head length).
- `circle(cx, cy, r, o)`, `ellipse(cx, cy, rx, ry, o)`, `rect(x, y, w, h, o)` (o.radius: corner radius), `polygon(points, o)` (o.closed: false for an open polyline), `path(d, o)` (any SVG path "d").
- `plot(fn, o)`: the curve y = fn(x), o.x: [min, max] (default [-4, 4]); or fn(t) → [x, y] with o.t: [t0, t1]. o.at: the board point of (0, 0); o.unit: board points per unit (default 50; or [ux, uy]); o.y: [min, max] clips; o.samples (default 240). Maths y goes up.
- `write(text, o)`: handwriting, as ink. o.at: top-left, or o.center; o.size: cap height (default 28); o.slant (default 0.12). Letters, digits, + − × ÷ = ≠ ≈ ≤ ≥ ± √ ∫ ∑ ∞ ∂ → ° and Greek (π θ α …); "^2", "^{10}", "_1" or ² ₁ for small raised and lowered text.
- `tex(latex, o)`: typeset maths (KaTeX), as a text node. o.at (top-left) or o.center; o.size (default 30); o.color.
- `text(str, o)`: typeset text, as a text node, with **bold**, *italic* and $math$. o.at or o.center; o.size (default 22).
- `label(target, text, o)`: text placed next to target, clear of the scene's objects, the board's items and the view's edge. target: an object, a point [x, y], or a segment [[x1, y1], [x2, y2]]. o.at: a point on an object ([x, y], or a share 0..1 along its outline) or a share along the segment (default 0.5); o.side: "auto" (default), "center", above, below, left, right, above-left, above-right, below-left, below-right; o.gap (default 10). Handwritten; o.tex: true typesets it as maths, o.text: true as text. Other options as write/tex. It follows its target as the target moves or changes.
- `around(obj, o)`: a hand-drawn ink mark around an object: o.shape "circle" (default), "box" or "underline"; o.pad.<!-- code-items -->
- `shader(glsl, o)`, `canvas(src, o)`: live pixels, drawn by the board every frame: a GLSL fragment shader, or a 2D canvas program. o.at (top-left) or o.center; o.size [w, h] in board points (default [320, 200]); o.params {name: number}, animated with `tween(obj, {params: {name: n}}, s)` or given as values. After the scene the item keeps its final params. run_scene compiles every program before playback: a compile error is a program error at the line of the shader()/canvas() call, and the log counts lines inside your glsl or src.
  - `glsl`: GLSL ES 3.0 in Shadertoy form, `void mainImage(out vec4 fragColor, in vec2 fragCoord)`; fragCoord is in device pixels from the bottom-left, and fragColor.a 0 is transparent. Declared for you: `uniform float iTime` (seconds since the item appeared), `uniform vec3 iResolution` (pixel width, height, 1), `uniform int iFrame`, one `uniform float <name>` per param (names that are GLSL identifiers), and the board colours `const vec3 ls_text, ls_muted, ls_accent, ls_good, ls_bad, ls_warn, ls_card, ls_card2, ls_border, ls_bg`. A shader with its own `void main()` and `out vec4` runs as it is.
  - `src`: the body of `function (ctx, t, w, h, params, dt)`, called every frame in a sandboxed worker (no DOM, no network). ctx is a 2D context scaled to board points; t is seconds since the item appeared; w, h is the size in points; params holds the current params; dt is seconds since the last frame. `this` is one object kept between frames, for state. The global `colors` holds the board colours as CSS strings: text, muted, accent, good, bad, warn, card, card2, border, bg. The canvas is not cleared between frames.
- `program(src, o)`: a live item that runs your own JavaScript program with its canvas: 2D, WebGL 2, WebGPU, three.js, any library from a URL, the learner's pointer, the scene clock. Options as shader/canvas. get_guide topic "scene-code" has its globals.<!-- /code-items -->
<!-- html -->- `html(markup, o)`: board material from HTML (pages, cards, frames with layout, lists, exercises, math, inline SVG; topic "html"), the same nodes the board shows anywhere: one item, its root node. o.at (top-left) or o.center; without them, an empty place (space()) near o.near or the learner's latest work. o.into: a frame of the board (a node id or name, board.node(…), or html material of an earlier scene) to put it in, at o.index among the children (default: last); o.mode: "insert" (default) or "replace" (in place of o.into's item, which goes). o.name, o.opacity. Its size is measured before the program goes on, so .bounds is exact. `obj.parts` lists the root's children as objects, `obj.part(index or layer-name)` gives one; a part can be drawn, faded, erased, edited, marked and labelled, and moves with its material.
<!-- /html -->- `image(src, o)`: a picture (topic "images"): an https:// or data: URL, or a file path in the learning folder. o.at or o.center, o.size ([w, h] or a width), o.near, o.into, o.name.<!-- html --> It is html material with one <img>.<!-- /html -->
- `copy(item, o)`: a copy of any object or board item (with everything inside it), as an object of this scene: o.at (top-left), o.center, o.by ([dx, dy]); without them, an empty place beside the original (or near o.near). o.name. A copy of ink is ink, of material is material, of a group is a group.
- `space(w, h, o)`: an empty rect for new material, {x, y, width, height, at, center, visible}, clear of the board's items and of this scene's objects so far (topic "placement"). o.near: an object, a point or a rect; o.inView (default true).
- `group(...objs, {name})`: one object made of others; actions on it act on all of them (draw draws them one after another). It moves, scales and rotates around its own centre. A group with a name becomes one board item (a frame holding its items) that the learner moves as a whole.
- `board.node(id)`: an item already on the board, by node id, ink group id ("g3") or name (a name given in an earlier scene; the latest item with it). The actions work on it. `board.view` is the learner's view {x, y, width, height} now (after this scene's camera moves).

**Options** (o) of shapes and ink: color (accent, good, bad, warn, text, muted, white, yellow, blue, green, pink, orange, purple, teal, a token such as var(--ls-good), or any CSS colour; default text), width (default 3), opacity, dash (true or [8, 6]), fill (a colour, or a list of colours for a top-to-bottom gradient), fillOpacity, hatch (a colour: diagonal hatching), pen (true: the shape becomes ink, drawn as a pen draws, slightly uneven), jitter (wobble of ink, 0..1), tool ("highlighter"), name (the item's name on the board and in board.node).

**Actions** take a duration in seconds or {dur, ease}; ease is linear, in, out, inOut or smooth. Each returns something to `await`.
- `draw(obj, s)`: a pen draws it (ink along its strokes, shapes along their outline, then their fill; <!-- code-items -->text and live items wipe in<!-- /code-items: text wipes in --><!-- html -->; html material fades its root in, then shows its parts one after another, text wiping in and svg outlines drawn<!-- /html -->). Default: the speed of a hand.
- `fillIn(obj, s)`: the fill appears (and the outline, if not drawn yet). Default 0.6.
- `fadeIn(obj, s)`, `fadeOut(obj, s)`: default 0.5. Faded out, it is removed from the board at the end.
- `erase(obj, s)`: undraws it, then it is removed from the board. On board.node(…) it removes a whole item or ink group (the learner's too) with everything inside it; `fadeOut(obj, 0)` removes one at once.
- `move(obj, {to: [x, y]} or {by: [dx, dy]}, s)`: to puts its centre there. Default 0.8. `move(obj, {into: frame, index}, s)`: the item becomes a child of a frame (a node id or name, <!-- html -->board.node(…), or html material) and glides there: in a flex frame it joins the flow at index (default: last), in a free frame it keeps<!-- /html: or board.node(…)) and glides there: it keeps --> its place (or goes where to/by say).
- `edit(item, {text, style}, s)`: changes an item's text (text nodes: markup with **bold**, *italic*, $math$; text() and tex() objects) and its style (a CSS object<!-- html --> as in html()<!-- /html -->, numbers are px; null removes a key) from now. Text changes at once; colours, sizes, opacity and other lengths glide over s (default 0.5 with style, 0 for text only). <!-- html -->On board nodes, html material and parts every style key of the HTML subset works; on<!-- /html: On --> the scene's own shapes and ink, color and opacity (and fontSize for text()) change as tween does.
- `tween(obj, props, s)`: x, y (offset from where it was made), scale, rotate (degrees), opacity, color, draw (share drawn, 0..1),<!-- code-items --> params (live items),<!-- /code-items --> or any numeric option. `tween(value, n, s)` for values. Default 0.8.
- `camera({fit, to, zoom, pad}, s)`: the learner's view glides: fit (an object or [x, y, w, h], with pad, default 40) and/or to (a centre [x, y]) and/or zoom. Default 1. After the learner pans or zooms during the scene, its later camera moves are skipped.
- `point(target, s)`: a pointer glides to an object's centre or a point [x, y] and rests there; `point(null, s)` hides it. Default 0.6.
- `say(text, o)`: a line of text that the app shows to the learner from now, at a reading pace, in a panel over the board that the learner can move; nothing is spoken. It lasts as long as reading it takes: 3.5 words per second plus 0.3 s, at least 1 s. `await say(…)` waits until it ends. Marks in the text, `[[name]]`, are not shown; each stands for the moment the reader reaches the word after it, at the same pace (word k of a line: 0.3 + k / 3.5 s after the line starts).
  - `await mark(name)`: waits until that word (the latest line with the mark).
  - `say(text, {name: () => draw(obj)})`: runs the function at that word.
  - `say(text, {during: action or [actions]})`: stretches the actions over the whole line.
  ```js
  say("Out come [[he]] a helium nucleus and [[n]] a neutron", { during: tween(glow, 1) })
  await mark("he"); draw(he)
  await mark("n"); draw(n)
  ```
- `wait(s)`; `step(name, {pause})`: names this moment (returned as steps); with pause: true, playback stops here until scene_control resumes it. When the learner starts drawing, playback pauses at the next step (or at once when no step is left). `all(...actions)`: ends when all of them end.

**Playback and tools.** run_scene with `when: "queue"` (default) starts after the scenes that play or wait; `"now"` starts at once. `wait: "end"` returns when the scene has played to its end (`played: true`), or when playback stops at a pause before that (`played: false`; the status has `paused_by`: "pause step", "learner drawing" or "scene_control pause", with `paused_scene`, `paused_step`, `paused_t`). `preview: true` returns a storyboard image (the end of each step, and the end<!-- code-items -->; a program() item in a frame shows its program run from the moment the item appears up to that frame's moment, on a virtual clock that item.t, scene.t, performance.now(), Date.now(), new Date(), requestAnimationFrame, setTimeout and setInterval follow<!-- /code-items -->) and the warnings, draws nothing and leaves the stage as it was. Every run returns warnings for unknown options, text that a line, outline or ink of the scene runs through (checked against the drawn strokes and their width, at the steps and every half second; text inside a fill that no stroke crosses is not reported), text over other text, and objects outside the learner's view. A program error leaves the stage as it was before the program. scene_control: status, pause, resume, stop (jump to the end state), skip (drop the waiting scenes, their items and their programs), cancel (end programs that are still running; stop and skip do too), wait (until nothing plays, or a scene is paused; `paused_by` says why), replace (a waiting scene's program, by scene id; the scenes after it run again), replay (an earlier scene, or from a step: its items show as they were then and play forward), cut (the playing scene, after a step or now: the rest is not drawn, and the board and the stage keep its state at the cut), reset (a new, empty stage). replace, cut and skip are each one undo step for the learner. A program has no time limit: one that never ends runs until cancelled, and its run_scene call then returns "Cancelled" with nothing drawn.

`console.log(…)` goes to the result's log. <!-- code-items -->Text and live items keep<!-- /code-items: Text keeps --> no rotation, and existing frames and text keep their size and angle on the board: they rotate and scale while the scene plays only.<!-- code-items -->

## Program items (program())
<!-- topic: scene-code -->
<!-- summary: program(src, o): a live item that runs your own JavaScript program: canvas, 2D/WebGL 2/WebGPU, three.js and any library, scene clock, params, steps, learner input, report(). -->

`program(src, o)` in a scene makes a live item whose pixels come from your own program. Options as `canvas()`: o.at (top-left) or o.center, o.size [w, h] in board points (default [320, 200]), o.params {name: number}.

**How it runs.** `src` is JavaScript that runs once when the item appears on the board, in a worker of its own, and keeps running while the item exists. It owns its loop: `requestAnimationFrame(fn)` calls fn on the next display frame (calls wait while the item is outside the learner's view). Top-level `await`, `import` lines and `import()` work. The worker has the browser's worker APIs (OffscreenCanvas, typed arrays, fetch, WebAssembly, Worker for more threads, `navigator.gpu` for WebGPU), and no DOM. Network is open: fetch and import from any URL. The program runs in an origin of its own, apart from the app, the other items and the learning folder's files.

**Imports.** Served by the app, with no network: `three` (three.js 0.186.1), `three/webgpu`, `three/tsl`, `three/addons/…` (the same files as `three/examples/jsm/…`), and `ls/interact` (ready-made input code, topic "scene-interact"). Any other bare name loads from esm.sh (`import * as d3 from "d3"` loads https://esm.sh/d3); a full URL loads as it is.

**Globals.**
- `canvas`: the item's OffscreenCanvas: `canvas.getContext("2d" | "webgl2" | "webgpu")`. Its width and height are device pixels; the board sets them at the start and when the item's size on screen changes, then sends a "resize" event. canvas also has clientWidth and clientHeight (board points), getBoundingClientRect, style.cursor (the cursor over the item), setPointerCapture and addEventListener, so code written for a DOM canvas (three.js renderers and controls) takes canvas as its element. With three.js: `new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })`, `renderer.setClearColor(0x000000, 0)`, then `renderer.setPixelRatio(item.dpr)` and `renderer.setSize(item.w, item.h, false)`.
- Transparency: the item's canvas starts transparent, and transparent pixels show the board under the item. A WebGL or three.js context stays transparent with `alpha: true` and a clear alpha of 0 (three.js: the setClearColor above, and no `scene.background`). A context made without alpha (three.js's default), a clear alpha of 1, a `scene.background` or a painted background covers the board in the item's whole box.
- `item`: w and h (the size in board points), dpr (device pixels per board point), t (seconds since the program started).
- `params`: the item's params, one object updated in place before each display frame: the item's own values, or the values a scene's tween gives them at this moment (interpolated every frame).
- `scene`: the clock of the scene that plays the item (the latest scene that made or changed it). `scene.t`: scene seconds; it stops while playback is paused and jumps when the scene seeks or restarts, so what follows it stays in step with the scene's say() lines and steps. `scene.playing`, `scene.step` (the name of the last step() reached, or null), `scene.active` (a scene plays the item now), `scene.ended`. After the scene, t stays at its end, step at its last step, and ended is true; the item keeps them, so on a board opened later they are the same. The board keeps the params' final values. item.t and the frame loop run on through pauses and seeks.
- `colors`: the board colours as CSS strings: text, muted, accent, good, bad, warn, card, card2, border, bg.
- `on(type, fn)`: the same as canvas.addEventListener; it returns a function that removes the listener. Types: "step" (e.name, e.previous; when scene.step changes, also by a seek), "resize" (e.w, e.h, e.dpr), "enter" and "leave" (input "enter"), and the input events below.
- `input(mode)`: how the item takes the learner's pointer. "none" (the default): the pen draws on the item, and that ink becomes the item's child. "enter": the learner double-clicks the item (select tool) to give it the pointer, wheel and keys; Escape or a press outside the item gives them back to the board; a thin accent outline shows it meanwhile. "direct": the item always gets the pointer and the wheel over it; the pen does not draw there and the board does not pan there.
- Input events, dispatched on canvas: pointerdown, pointermove, pointerup, pointercancel, pointerenter, pointerleave, click, dblclick, contextmenu, wheel, keydown, keyup. Their fields: offsetX, offsetY (board points inside the item), clientX, clientY, movementX, movementY, button, buttons, pointerId, pointerType, pressure, shiftKey, ctrlKey, altKey, metaKey, deltaX, deltaY, deltaMode, key, code. The board does nothing with events the item gets.
- `report(values)`: plain data (at most 4000 characters as JSON) that get_node_info shows as `report`; the latest call wins.

**Errors.** run_scene runs each program for a moment before the scene plays: a syntax error, a failed import or an error in its first frames is a program error at the line of the program() call, with the line inside src. A later error stops the program: the item shows a quiet error note, and get_node_info gives state "error" with the message and its line.

## Ready-made input code (ls/interact)
<!-- topic: scene-interact -->
<!-- summary: The full source of ls/interact: orbit (three.js camera), panZoom (2D), draggable points, slider, hover/pick3d, for program() items to import or copy. -->

A program() item may `import { orbit, panZoom, draggable, slider, hover, pick3d } from "ls/interact"`. Nothing in it runs unless a program imports it, and the item gets pointer events only after `input("enter")` or `input("direct")`. This is its whole source; a program can also copy any part of it and change it.

<!-- include: live/interact.js --><!-- /code-items -->
