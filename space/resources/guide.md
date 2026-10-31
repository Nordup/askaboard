# Learning Space: the agent guide

## The board
<!-- topic: model -->
<!-- summary: The board model: item kinds, ids, ink groups, bounds and positions. -->

- The board is a tree of items: frame (a box that holds children), text, svg, image<!-- code-items -->, world<!-- /code-items --> and ink (pen strokes).
- Ink is the learner's handwriting (author "learner") or yours. Ink inside a frame moves with the frame.
- Every item has a stable id. list_items returns ids, kinds, names and world bounds as "x,y w×h".
- Ink groups: strokes come in groups g1, g2, …. A group holds the strokes of one parent (the top level or one frame) and one author; each ink object of a scene is a group of its own. A group keeps its id while the learner adds to it, merged groups keep the older id, and ids are not reused. A group id works wherever an item id does: board.node("g3") in a scene, the part of list_items and get_screenshot, and the id of get_item.
- Top-level items sit at their x, y on the board. <!-- html -->Children of a flex frame are placed by the flex layout. Children of a free frame sit<!-- /html: Children of a frame sit --> at their x, y inside the frame.
- All writing on the board happens in scenes (write_scene, preview_scene, play_scene; topic "scene"): drawing, typeset text, <!-- html -->HTML material, <!-- /html -->pictures, copies, edits, moves and deletions are all steps of a scene's program.<!-- html -->

## HTML material
<!-- topic: html -->
<!-- summary: html(): material to read and keep (pages, exercises, tables, cards) as board items: the HTML subset, tags, layout, names, parts, style keys and units. -->

Use html() for material the learner reads and keeps: pages, exercises, tables, cards.

html(markup, o) in a scene (topic "scene") turns a small HTML subset into board items. get_item with as "html" returns an existing item in the same subset.

- Styles are inline only (style="…"): no <style>, no classes, no scripts.
- Boxes: a <div> with child elements becomes a frame. Layout comes from display:flex with flexDirection, gap, padding, alignItems and justifyContent. There is no margin, grid or float; spacing comes from gap and padding. A <table> draws its cells one under another; for rows and columns, use flex.
- A div without display:flex becomes a flex column, unless one of its children has position:absolute. Then it is a free frame: each child with position:absolute; left:…px; top:…px sits at that place. In a flex frame, position:absolute is ignored and the flex layout places the child.
- Text: <h1>…<h6>, <p>, <span>, <li>. A block with only inline content becomes one text item. Inside text, <b>/<strong> is bold, <i>/<em> is italic and <br> is a new line. A style on an inline tag (<span>, <b>, <i>, …) is not kept; styles apply to the whole block. Other inline tags (<sub>, <code>, <a>, …) keep their text, not their format.
- Lists: <ul>/<ol> with <li> become a column of text lines with "•" or "1." prefixes.
- <pre> keeps whitespace and shows its text literally (code).
- Names: layer-name="Hint 1" on any element names its item; `obj.part("Hint 1")` returns that part.
- One root: the markup becomes one item, its root item. The root's children are its parts (`obj.parts`), in order. Several top-level elements are put in one column frame with gap 12px; one <div> around them sets another layout.
- Style keys work in camelCase or kebab-case (fontSize or font-size). Accepted: width, height, min/max width and height, padding (and sides), gap, rowGap, columnGap, display (flex, block, none), flexDirection, flexWrap, alignItems, alignContent, justifyContent, alignSelf, flexGrow, flexShrink, flexBasis, background, backgroundColor, color, opacity, borderRadius, border (and sides, color, width, style), boxShadow, fontSize, fontWeight, fontStyle, fontFamily, lineHeight, letterSpacing, textAlign, textDecoration, textTransform, whiteSpace, overflow, objectFit, and position, left and top as above. Other keys are ignored.
- Units: px, em, rem (16px) and % work as in CSS; vw and vh follow the app window, so do not use them. lineHeight in px or a plain number. Boxes use border-box sizing.
- A frame with a width and height:fit-content grows with its content.<!-- /html -->

## Text markup and math
<!-- topic: math -->
<!-- summary: Text markup and math ($…$, KaTeX syntax) in <!-- html -->html(), <!-- /html -->text() and edit(). -->

- Text items store light markup: **bold**, *italic*, $inline math$ (KaTeX syntax, for example $T^2 \propto a^3$).
- <!-- html -->html() passes $…$ in its text through. <!-- /html -->text() and edit(item, {text}) take the markup directly; tex() takes LaTeX without the dollars.
- \* and \$ give a literal * or $.
- In a JavaScript string, a backslash is written twice: "$\\frac{1}{2}$".<!-- html -->

## Diagrams (SVG)
<!-- topic: svg -->
<!-- summary: Inline SVG in html(): size, element ids, markers, gradients, colour and how draw() shows it. -->

- An inline <svg> with a viewBox in html() becomes an svg item. It needs a width and height, in its style or as attributes.
- Shape ids (id="atom-a") are kept, and get_item lists them. Ids are scoped per drawing, so two drawings can both use "arrow".
- Markers and gradients work with url(#id) inside the same svg. Scripts, foreignObject, external links and images are not kept.
- Colour tokens work as attribute values (fill="var(--ls-accent)"; topic "tokens"). A fill or stroke of "currentColor" follows the svg's color style, so edit(item, {style: {color}}) recolours those shapes.
- draw() draws the outlines along their length, one shape after another in document order, then shows the fills.
- The scene's own shapes (circle(), path(), …) are svg items too.<!-- /html -->

## Images
<!-- topic: images -->
<!-- summary: image()<!-- html --> and <img> in html()<!-- /html -->: sources, size, and what happens when a download fails. -->

- image(src, o) in a scene<!-- html -->, or <img src="…"> in html()<!-- /html -->: an https:// URL is downloaded into the learning folder's assets/ (PNG, JPEG, GIF, WebP, AVIF or SVG, up to 10 MB); a data: URL is saved there too; a path inside the learning folder (assets/orbit.png) is used as it is.
- image() places the picture at o.at (top-left) or o.center; without them, in an empty place near o.near (topic "placement"). o.size: [w, h], or a width (the height keeps the picture's shape). Without o.size, the picture keeps its own size, reduced to fit 480 points. o.into puts it in a frame (topic "placement"); o.name names it.
- A picture that does not download, or a folder path with no file, is a program error in image()<!-- html --> and in html()<!-- /html -->.<!-- html -->
- In html(), <img> needs a width and height, in its style or as attributes.<!-- /html -->

## Colour and font tokens
<!-- topic: tokens -->
<!-- summary: The colour and font tokens of the dark board, and the colour names that scenes accept. -->

- The board is dark. These tokens work in any style value: var(--ls-card), var(--ls-card-2) (backgrounds), var(--ls-text), var(--ls-muted) (text), var(--ls-accent) (blue), var(--ls-good) (green), var(--ls-bad) (pink-red), var(--ls-warn) (yellow), var(--ls-border), var(--ls-bg) (the board's background), var(--ls-font), var(--ls-mono).
- Scene colour options take names: accent, good, bad, warn, text, muted, card, card-2, border and bg (the tokens; bg is the board's own background, to cover what lies behind a shape), and white, yellow, blue, green, pink, red, orange, purple and teal. A token such as var(--ls-good) or any literal CSS colour works too.

## Placement
<!-- topic: placement -->
<!-- summary: Where scene material goes: at and center, space(), into frames, and screenshot labels. -->

- Creators take o.at (top-left) or o.center: a point [x, y] in board points, or an object (its centre). <!-- html -->html(), <!-- /html -->image() and copy() without them go to an empty place: space() near o.near, or near the learner's latest work in their view.
- space(w, h, o) returns an empty rect {x, y, width, height, at, center, visible}. It is 32 points from every item on the board and from what the scene has made so far, nearest to o.near (an object, a point or a rect) or to the learner's latest work, and inside the learner's view when it fits. o.inView (default true): false allows the nearest place anywhere.
- <!-- html -->html(markup, {into: frame}) puts material inside a frame of the board. o.into is an item id or name, board.node(…), or html material of an earlier scene; o.index is its position among the children (default: last); o.mode is "insert" (default) or "replace" (in place of o.into's item, which goes). move<!-- /html: move -->(item, {into: frame}) moves an item into a frame. <!-- html -->In a flex frame the item joins the flow; in a free frame it keeps<!-- /html: It keeps --> its place on the board.
- An object's .bounds and .center give its place now, in board points (topic "scene").
- To see overlaps and objects outside the learner's view, look at the scene with preview_scene (topic "scene", "Playback and tools").
- get_screenshot with labels: true tags every group and top-level item with its id; grid: true adds board coordinates.

## Marks on the learner's work (ink)
<!-- topic: ink -->
<!-- summary: Ink in scenes: what makes ink, how it is drawn, and acting on the learner's ink groups. -->

- Ink is what the learner writes with. A scene's stroke(), write() and around() make ink, and so does any shape with pen: true. Ink is drawn stroke by stroke as a pen draws, slightly uneven. The learner can erase, lasso and move it like their own.
- board.node("g3") returns the learner's ink group g3. around(g, {shape: "circle" | "box" | "underline"}) draws an ink mark around it. A tick or a cross is a short stroke() or path() with pen: true, placed from `g.bounds`; arrow(…, {pen: true}) is an ink arrow.
- The learner's ink acts like any object: draw(g) traces it again, tween(g, {color}) recolours it, move(g, …) moves it, and erase(g) or fadeOut(g) removes the whole group.

## Moving the learner's view
<!-- topic: view -->
<!-- summary: camera() in a scene: its options, board.view, and when camera moves are skipped. -->

- `camera({fit, to, zoom, pad}, s)` glides the learner's view: fit (an object or [x, y, w, h], with pad, default 40) and/or to (a centre: an object or [x, y]) and/or zoom. Default 1 s. Given as a function (to: () => ball), the view follows it until the next camera().
- board.view is the learner's view {x, y, width, height} now (after this scene's camera moves).
- board.view.covered (when present) lists the parts of the view that the app's script panel and tool palette cover while scenes play; the learner cannot see material there.
- After the learner pans or zooms during a scene, its later camera moves are skipped.

## Live scenes (write_scene, preview_scene, play_scene)
<!-- topic: scene -->
<!-- summary: write_scene, preview_scene and play_scene: every global of a scene program (drawing, text, <!-- html -->HTML material, <!-- /html -->pictures, copies, space, edits, moves into frames, deletion), its options, time, values, names, labels, camera, lines (say), pauses, previews and the queue. -->

write_scene runs a scene program and keeps it as a draft; play_scene plays it and controls playback, and preview_scene shows it before it plays ("Playback and tools" below). A scene program is the body of an async function, or a module in a scene file (topic "scene-files"). These globals are all it has, plus plain JavaScript (Math, arrays, functions; Math.random is seeded per run, and Date reads the scene's clock; there are no web APIs such as fetch, timers, Intl, WeakRef or FinalizationRegistry). Points are board points [x, y]; +y is down.

**Time.** Every action starts now. `await` waits for its end; without `await`, the next line starts at the same moment:
```js
const a = circle(0, 0, 60), b = circle(150, 0, 60)
draw(a)              // a and b are drawn together
await draw(b)        // the next line starts when b is done
await all(fadeOut(a), move(b, { to: [0, 0] }))
```
Async functions run side by side, each with its own time: `await Promise.all([left(), right()])`. The scene lasts until its last action ends; the board after the scene is its state at the end.

**Values and changing objects.** `value(n)` is a number that changes over time: `v.get()` returns its value now, `v.set(n)` jumps now, `tween(v, n, s)` glides to n. Any argument or option of a creator can be a value or a function of values; the object is drawn again as they change, and `.bounds` and `.center` follow:
```js
const h = value(0)
const bar = rect(0, () => -h.get(), 40, () => h.get(), { fill: "accent" })
const tag = write(() => "h = " + h.get().toFixed(1), { at: () => [56, -h.get() - 14] })
await tween(h, 80, 3)
```
`trace(() => [x, y], o)` is the path a moving point leaves: a line through the point's places from when it is made until now (options as path). `tween(obj, {width: 6, fillOpacity: 0.3}, s)` animates any numeric option of the object's creator. A function given to `plot` (fn) reads values the same way.

**The stage.** Every program on a board runs in the same sandbox, one after another, each with its own time from 0. The global object `stage` keeps whatever a program puts on it (values, objects, functions, numbers) for the programs after it; top-level `const` and `let` stay local to their program. An object of an earlier program is on the board already: acting on it (draw, move, tween, fadeOut, label, …) or tweening a value its arguments read changes that same board item, and a scene starts from where the scenes before it left everything. `board.node(name or item id)` returns the earlier program's own object for items it made. An object whose items the learner erased is gone; draw or fade it in to bring it back. The stage starts new on `play_scene({action: "reset"})` (the write_scene result then has `stage`). When the board changes or the app starts, the app runs the board's scenes again from its records, so their objects and `stage` values are there as before.
```js
// one call
stage.k = value(1)
stage.wave = plot(x => Math.sin(stage.k.get() * x), { unit: 40 })
await draw(stage.wave)
// a later call
await tween(stage.k, 3, 2)   // the curve drawn by the earlier call gets shorter waves
```

**Objects** are invisible until an action shows them (draw, fillIn, fadeIn, tween draw). An object that no action shows appears when it is made. Every object has `.bounds` {x, y, width, height} and `.center` [x, y] (both at the current time), `.name` and `.kind`<!-- code-items -->; worlds also have `.point`, `.value` and `.part`<!-- /code-items -->.
- `stroke(points, o)`: ink through [[x, y] or [x, y, pressure 0..1], …]; a list of such lists makes several strokes.
- `line(x1, y1, x2, y2, o)`, `arrow(x1, y1, x2, y2, o)` (o.head: head length).
- `circle(cx, cy, r, o)`, `ellipse(cx, cy, rx, ry, o)`, `rect(x, y, w, h, o)` (o.radius: corner radius), `polygon(points, o)` (o.closed: false for an open polyline), `path(d, o)` (any SVG path "d").
- `plot(fn, o)`: the curve y = fn(x), with o.x: [min, max] (default [-4, 4]); or fn(t) → [x, y] with o.t: [t0, t1]. o.at: the board point of (0, 0); o.unit: board points per unit (default 50, or [ux, uy]); o.y: [min, max] clips; o.samples (default 240). Maths y goes up.
- `write(text, o)`: handwriting, as ink. o.at: top-left, or o.center; o.size: cap height (default 28); o.slant (default 0.12). Latin with accents, Cyrillic, Greek, digits, punctuation (… — “ ” « »), arrows (→ ⇒ ⇔ ↺) and maths signs (∀ ∃ ∈ ⊆ ∪ ∧ ¬ ℝ ℕ ✓ …); any other character is drawn as a pen line from the board font; "^2", "^{10}", "_1" or ² ₁ for small raised and lowered text.
- `tex(latex, o)`: typeset maths (KaTeX), as a text item. o.at (top-left) or o.center; o.size (default 30); o.color.
- `text(str, o)`: typeset text, as a text item, with **bold**, *italic* and $math$ (topic "math"). o.at or o.center; o.size (default 22).
- `label(target, text, o)`: text placed next to target, clear of the scene's objects, the board's items and the view's edge. target: an object, a point [x, y], or a segment [[x1, y1], [x2, y2]]. o.at: a point on an object ([x, y], or a share 0..1 along its outline), or a share along the segment (default 0.5). o.side: "auto" (default), "center", above, below, left, right, above-left, above-right, below-left, below-right. o.gap (default 10). The label is handwritten; o.tex: true typesets it as maths, o.text: true as text. Other options as write or tex. It follows its target as the target moves or changes.
- `around(target, o)`: a hand-drawn ink mark around an object, a point [x, y] or a board rect {x, y, width, height}, such as a part of a picture. o.shape: "circle" (default), "box" or "underline"; o.pad (default 8 points plus 8% of the target's larger side; 20 points around a point).<!-- code-items -->
- `world(src, o)`: anything you build with code: plain three.js that sits on the board with no frame and casts a soft shadow on it. It links to the board through `.point(name)`, `.value(name)` and `.part(name)`. Read topic "scene-world" before your first world.<!-- /code-items -->
<!-- html -->- `html(markup, o)`: board material from HTML (topic "html"): frames with layout, text, lists, math, inline SVG and pictures, made of the same items as the rest of the board. It returns one item, its root item. o.at (top-left) or o.center; without them, an empty place (topic "placement"). o.into, o.index and o.mode put it into a frame or in place of an item (topic "placement"). o.name, o.opacity. `.bounds` is exact at once. `obj.parts` lists the root's children as objects, and `obj.part(index or layer-name)` returns one. A part can be drawn, faded, erased, edited, marked and labelled, and it moves with its material.
<!-- /html -->- `image(src, o)`: a picture from an https:// or data: URL, or from a file path in the learning folder (topic "images").
- `copy(item, o)`: a copy of any object or board item (with everything inside it), as an object of this scene. o.at (top-left), o.center, o.by ([dx, dy]); without them, an empty place beside the original (or near o.near). o.name. A copy of ink is ink, a copy of material is material, and a copy of a group is a group.
- `space(w, h, o)`: an empty rect for new material, clear of the board's items and of this scene's objects so far (topic "placement").
- `group(...objs, {name})`: one object made of others; actions on it act on all of them (draw draws them one after another). It moves, scales and rotates around its own centre. An object is in one group at a time; group() of the same objects again returns the same group. A group with a name becomes one board item (a frame that holds its items), which the learner moves as a whole.
- `board.node(id)`: an item already on the board, by item id, ink group id ("g3") or name (a name given in an earlier scene; the latest item with it). The actions work on it. `board.view`: the learner's view now (topic "view").

**Options** (o) of shapes and ink: color (a colour name or token from topic "tokens", or any CSS colour; default text; a value that is not a colour draws in the text colour; "none" draws nothing, for fill and hatch too), width (default 3; a filled shape with width 0 or color "none" has no outline), opacity, dash (true or [8, 6]), fill (a colour, or a list of colours for a top-to-bottom gradient), fillOpacity, hatch (a colour: diagonal hatching), pen (true: the shape is drawn as a pen draws, slightly uneven; with a fill, the fill fades in once the outline is drawn), jitter (wobble of ink, 0..1), tool ("highlighter"), name (the item's name on the board and in board.node).

**Actions** take a duration in seconds or {dur, ease}; ease is linear, in, out, inOut or smooth. Each returns something to `await`.
- `draw(obj, s)`: a pen draws it: ink along its strokes, shapes along their outline and then their fill<!-- code-items -->, text and worlds wipe in<!-- /code-items: , text wipes in --><!-- html -->; html material fades its root in, then shows its parts one after another, text wiping in and svg outlines drawn<!-- /html -->. Default: the speed of a hand.
- `fillIn(obj, s)`: the fill appears (and the outline, if not drawn yet). Default 0.6.
- `fadeIn(obj, s)`, `fadeOut(obj, s)`: default 0.5. An object faded out is removed from the board at the end.
- `erase(obj, s)`: undraws it, then removes it from the board. On board.node(…) it removes a whole item or ink group (the learner's too) with everything inside it; `fadeOut(obj, 0)` removes one at once.
- `move(obj, {to: an object or [x, y]} or {by: [dx, dy]}, s)`: to puts its centre there; a function here is read once, when the move starts. Default 0.8. `move(obj, {into: frame, index}, s)`: the item becomes a child of a frame (an item id or name, <!-- html -->board.node(…), or html material) and glides there: in a flex frame it joins the flow at index (default: last); in a free frame it keeps<!-- /html: or board.node(…)) and glides there: it keeps --> its place (or goes where to or by says).
- `edit(item, {text, style}, s)`: changes an item's text (text items: markup with **bold**, *italic*, $math$; text() and tex() objects) and its style (a CSS object<!-- html --> as in html()<!-- /html -->, numbers are px; null removes a key) from now. Text changes at once; colours, sizes, opacity and other lengths glide over s (default 0.5 with style, 0 for text only). <!-- html -->On board items, html material and parts, every style key of the HTML subset works; on<!-- /html: On --> the scene's own shapes and ink, color and opacity (and fontSize for text()) change as tween changes them.
- `tween(obj, props, s)`: x, y (offset from where it was made), scale, rotate (degrees), opacity, color, draw (share drawn, 0..1),<!-- code-items --> params (worlds),<!-- /code-items --> or any numeric option. `tween(value, n, s)` for values. Default 0.8.
- `camera({fit, to, zoom, pad}, s)`: glides the learner's view (topic "view"). Default 1.
- `point(target, s)`: a pointer glides to an object's centre or a point [x, y] and rests there; given a function (() => bob), it follows what the function returns until the next point(); `point(null, s)` hides it. Default 0.6.
- `say(text, o)`: a line of text that the app shows to the learner from now, at a reading pace, in a panel over the board that the learner can move; nothing is spoken. It lasts as long as reading it takes: 3.5 words per second plus 0.3 s, at least 1 s. `await say(…)` waits until it ends. Marks in the text, `[[name]]`, are not shown; each stands for the moment the reader reaches the word after it, at the same pace.
  - `await mark(name)`: waits until that word (in the latest line with the mark).
  - `say(text, {name: () => draw(obj)})`: runs the function at that word.
  - `say(text, {during: action or [actions]})`: stretches the actions over the whole line. `during` also takes the result of an async function, such as `(async () => { … })()`; that runs at its own pace and is not stretched.
  ```js
  say("Out come [[he]] a helium nucleus and [[n]] a neutron", { during: tween(glow, 1) })
  await mark("he"); draw(he)
  await mark("n"); draw(n)
  ```
- `wait(s)`. `step(name, {pause})`: names this moment (returned as steps; say() lines before the first step() make a first step named after the scene, and step numbers count it); with pause: true, playback stops here until play_scene "resume" or "next". When the learner starts drawing, playback pauses at the next step (or at once when no step is left). `all(...actions)`: ends when all of them end; it also takes the results of async functions, and then gives a promise that ends when all of them end.

**Playback and tools.**
- Drafts: write_scene runs the program and keeps the result as a draft under its name, which the learner does not see. play_scene `start` puts the draft on the board. To change a scene on the board, write it again under its name and start it: it is replaced in place, as one undo step. The new version does not need to erase the items of the old version or of later scenes.
- Queue: play_scene `start` with `when: "queue"` (default) starts after the scenes that play or wait, back to back with no gap and no jump between them; `"now"` starts at once. It returns at once, with `starts_in_s` and `ends_in_s`.
- preview_scene returns one image of a draft or of a scene on the board: at the end (default), at the end of a step, at a time, at a list of moments, or at every step (`at: "steps"`); framed on the scene, the learner's view, a region, or a close-up of items<!-- code-items -->; worlds show as they are at that moment, and the same preview gives the same picture when a world uses no network, input or real time<!-- /code-items -->. It draws nothing and leaves the stage as it was.
- An unknown option is ignored.
- Errors: a program error leaves the stage as it was before the program. An error returns at once, also from a function that runs in parallel or that moves an object. A program that waits on something that never happens fails with an error. A program has no time limit: one that never ends runs until play_scene `cancel`, and its call then returns "Cancelled" with nothing drawn.
- play_scene actions: start (a draft, by name); status; pause; resume; next (jump to the next step and play on); stop (jump to the end state); clear_queue (drop the waiting scenes, their items and their programs); cancel (end programs that are still running; stop and clear_queue do too); replay (a scene that has played, or from a step: its items show as they were then and play forward); cut (the playing scene, after a step or now: the rest is not drawn, and the board and the stage keep its state at the cut); reset (a new, empty stage). start, cut and clear_queue are each one undo step for the learner.

`console.log(…)` goes to the result's log. <!-- code-items -->Text and worlds keep<!-- /code-items: Text keeps --> no rotation, and existing frames and text keep their size and angle on the board: they rotate and scale only while the scene plays.<!-- code-items -->

## Scene files and libraries
<!-- topic: scene-files -->
<!-- summary: Scene programs as JavaScript files in boards/scenes/: when to use a file or inline code, components in lib/, import and export, when the app reads the files. -->

A scene program can be a file in `boards/scenes/` of the learning folder, and files can import each other. You write and change the files with your own file tools, as you write any program. Later scenes, later sessions and other agents read them and build on them.

**File or code.**
- Prefer a file. Write the scene to `boards/scenes/`, such as `pendulum/swing.js`, and call write_scene with `file`. To change the scene, edit the file and call write_scene again with the same name and file: you send only the change, not the whole program.
- Use `code` only for a few lines that you will not change (one mark, one label, a camera move), or when you have no file tools.
- Put what more than one scene uses (a pendulum, a neuron, labelled axes, a colour scheme) in `boards/scenes/lib/` and import it. Copy a scene file to start a new scene from it.

**Modules.**
- A file uses JavaScript module syntax: `export` functions, objects and values, and `import` them from other files: `import { pendulum } from "lib/pendulum.js"` (from the root of `boards/scenes/`) or `import { arrow } from "./arrows.js"` (from the file's own folder). Inline code can import files too.
- Imports name files in `boards/scenes/` only: no packages and no URLs (a world loads libraries itself, topic "scene-world"). `import()` takes a literal path.
- The scene globals (draw, write, value, stage, board, …) work in every module, as in inline code. A component is a function that makes objects and acts on them, such as `export async function pendulum(at, length) { … }`. Top-level `await` works in the file that write_scene runs.

**When the app reads the files.** Only at write_scene. A later edit of a file changes nothing on the board until you call write_scene again.

**State.** Every module runs again for each scene program, so the variables of a module start new each time. What later programs need goes on `stage` (topic "scene").

**Errors** name the file and the line, such as `lib/pendulum.js line 12: …`.

## Worlds (world())
<!-- topic: scene-world -->
<!-- summary: world(src, o): everything you build with code: three-dimensional models, fields, simulations, and things the learner can touch. Plain three.js that sits on the board with no frame and links to labels, arrows and ink. Read it before your first world. -->

Creates a world: plain three.js that lives on the board itself. A world is how you build anything that needs code: a model with real light and material, a field, a fluid, particles, a simulation, a shader, a picture drawn by code, or something the learner turns or drags. Everything you know about three.js applies here, and any library works.

A world has no frame. It sits on the board, casts a soft shadow on it, and can reach anywhere. You write only what is specific to the idea, because the app provides the renderer, the render loop, the camera, the light and the floor. Do not create a renderer or a canvas.

```js
const atom = world(`
  const nucleus = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), world.look.glow("#ffb56b"))
  world.add(nucleus)
  publish("nucleus", nucleus)
  world.frame(t => { nucleus.position.y = params.height * Math.sin(t) })
`, { center: [0, 0], params: { height: 1 } })

await draw(atom, 1.5)
await label(atom.point("nucleus"), "the nucleus")
await tween(atom.value("height"), 2, 3)
```

**Usage:**
- `src` runs once, when the world appears. `THREE` is already there, and `import` lines work: `three/addons/…` and `ls/interact` come from the app, and any other name comes from esm.sh, as in `import * as d3 from "d3"`. `fetch`, WebAssembly and `Worker` work too.
- Options: `at` (top-left) or `center`; `size`, [w, h] in board points, default [480, 360]; `params`, numbers that the scene can change; `data`, any JSON value, read as `world.data`. `size` sets the scale of the view at the camera's target. It is not a limit on what the world can draw.
- Put what changes over time in `world.frame(fn)`, not in a loop of your own. fn gets (t, dt) in scene time, so the world holds on a pause and stays in step with the story. A seek back runs your code again from the start, so build the world at the top level, and work out motion from t where you can. A simulation that adds up its steps replays as well, as long as it uses no real time, input or network.
- Use `world.add(...objects)` to add objects, and `world.camera`, `world.scene` and `world.root` as you would in three.js. Call `world.redraw()` after a change that happens outside a frame, such as a texture that has loaded.
- The app measures how far a world reaches, so that nothing is cut off. When a shader moves vertices, the app cannot see that: tell it with `world.reach(r)`, in board points, or `world.reach("full")`.

**How a world looks.** A world starts with a film look: soft image-based light, tone mapping, soft shadows and a gentle glow, and a floor that catches the shadow and a fading reflection. This is what makes an object feel real on the board, so keep it unless the idea asks for something else.
- `world.look.gloss(c)`, `.metal(c)`, `.glass(c)`, `.glow(c)` and `.skin(c)` make materials that suit it. Any three.js material works too.
- Change one part with `world.look.bloom = 0`. For flat work, where colours must stay exact, use `world.look = "plain"`.
- `world.floor = false` removes the floor, and `world.floor = { y }` sets its height.

**Link a world to the board.** A world and the board are one space, so use the links: they are what make a world part of the explanation and not a picture beside it. In the world, `publish(name, target)` names something: an Object3D, a Vector3, or a function that gives [x, y, z]. In the scene:
- `atom.point(name)` is a point that goes wherever a scene takes a point: `label`, the ends of `arrow` and `line`, `point`, `camera({to})` and `around`. The item follows the point as it moves, also after the scene ends, and it fades while the point is hidden.
- `atom.value(name)` is a value bound to `params[name]`, so `tween` and `.get()` work on it.
- `atom.part(name)` lets `draw`, `fadeIn`, `fadeOut` and `erase` act on one part, so a model can grow piece by piece. `world.part(name, { reveal: v => … })` in the world changes how a part appears; v goes from 0 to 1.

**Let the learner touch it.** Turning a model, dragging a part or changing a value with their own hand often teaches more than watching.
- `input("direct")`: a press on an object goes to the world, and a press beside it goes to the board. Use it for something that is there to be handled. `input("enter")`: the learner double-clicks to go in, and Escape leaves. Use it when the pen should still draw over the world. The default is `input("none")`: the pen draws, and a mark on a part stays on that part as it turns. You are told which part the learner marked.
- `on("pointerdown" | "pointermove" | "pointerup" | "wheel", fn)` gives events from the whole board: e.x and e.y in board points, e.hit (the nearest object and its part), e.ground (the point on the floor) and e.ray. `ls/interact` has ready-made orbit, drag and slider code (topic "scene-interact").
- `world.pick(x, y)`, `world.toWorld(x, y)` and `world.toBoard(point)` convert between the board and the world.
- `world.anchor(x, y)` moves the whole world to a board point. Use it for an object that travels far across the board, because it does not stretch the view.
- `on("ink", fn)` gets each stroke that the learner draws, as stroke.points on the board and stroke.world on the floor, so a drawn line can become a track, a wall or a path. `world.strokes` lists them. A scene can pass in ink that is already there with `board.node("g3").points` and `data`.

**Anything else code can draw.** A world is not only for three dimensions. For a picture drawn by code, draw on an `OffscreenCanvas` and show it as a `THREE.CanvasTexture` on a plane. For a shader, use a `THREE.ShaderMaterial`. For both, `world.look = "plain"` keeps the colours exact.

**Errors.** A syntax error or an error in the first frames is a program error at the line of the world() call. A later error stops that world only: it shows a quiet note, and get_item gives the message and the line.

## Ready-made input code (ls/interact)
<!-- topic: scene-interact -->
<!-- summary: The full source of ls/interact: orbit, draggable, slider and hover, for a world to import or copy. -->

A world can `import { orbit, draggable, slider, hover } from "ls/interact"`. Set up orbit last, because a helper that takes a press stops it from reaching orbit. Below is the whole source, so you can see how it works, or copy a part and change it.

<!-- include: live/interact.js --><!-- /code-items -->
