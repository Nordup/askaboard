/**
 * What agents read: the server instructions (sent at connect) and the guide
 * (get_guide). Our own wording. Keep it short and rule-shaped: agents follow
 * rules better than prose.
 */

export const SERVER_INSTRUCTIONS = `Learning Space is a desktop app: a shared canvas where a learner writes by hand (pen, highlighter) and you add material (cards, text, math, diagrams, images). Boards live as files in a local learning folder.
Call get_guide once before your first write: it has the HTML subset, the tokens and the placement rules.
Look before you act: get_canvas_info, then get_tree, then get_screenshot. Never guess what the learner wrote; to see new handwriting use get_changes and get_screenshot with target "changes".
The learner does the thinking. Give hints, questions and short explanations; do not hand over full answers unless asked.
The learner's handwriting comes in ink groups (g1, g2, …): use these ids like node ids. Put material beside their work with place: {right_of: "g3"}; never cover it unless you mark it on purpose. Read the overlaps in every write result.
Write small: one visual group per write_html call, then get_screenshot to check it, then fix with update_styles, set_text or move_nodes.
Everything is editable by both of you, and every write you make is one undo step for the learner.
When you are done with a piece of material, call finish_working.
Coordinates are board points: origin at the centre, +x right, +y down.`

export const GUIDE_SECTIONS: { topic: string; title: string; body: string }[] = [
  {
    topic: 'model',
    title: 'The board',
    body: `- A board is a tree of nodes: frame (a box that holds children), text, svg, image, and ink (pen strokes).
- Ink is the learner's handwriting (author "learner") or yours. Ink inside a frame moves with the frame.
- Every node has a stable id. get_tree shows ids, kinds, names and world bounds "x,y w×h".
- Ink groups: the app clusters strokes by distance and time into groups g1, g2, … (one per parent and author; each draw_ink call is its own group). A group keeps its id while the learner adds to it; merged groups keep the older id. Use a group id wherever you read or place: get_screenshot node_id, near, place, move_nodes, duplicate_nodes, delete_nodes.
- Top-level nodes sit at x, y on the board. Children of a flex frame are placed by the flex layout. Children of a frame without display:flex sit at their x, y inside the frame.`
  },
  {
    topic: 'html',
    title: 'HTML you can write',
    body: `- write_html takes a small HTML subset with inline styles only (style="…"). No <style>, no classes, no scripts.
- Boxes: <div>. A div with child elements becomes a frame. Use display:flex with flexDirection, gap, padding, alignItems, justifyContent.
- No margin, no grid, no tables, no float. Space things with gap and padding. A div without display:flex becomes a flex column.
- Text: <h1>…<h6>, <p>, <span>, <li>. A block with only inline content becomes one text node.
- Inside text: <b>/<strong> for bold, <i>/<em> for italic, <br> for a new line. Inline styles on <span> are dropped: style the whole block.
- Lists: <ul>/<ol> with <li> become a column of text lines with "•" or "1." prefixes.
- <pre> keeps whitespace and shows text literally (code).
- Names: layer-name="Hint 1" on any element gives the node a name; write_html returns a name → id map.
- Free placement inside a frame: give the children position:absolute; left:…px; top:…px and leave the frame without display:flex.
- Allowed style keys: width, height, min/max width and height, padding (and sides), gap, rowGap, columnGap, display (flex, block, none), flexDirection, flexWrap, alignItems, alignContent, justifyContent, alignSelf, flexGrow, flexShrink, flexBasis, background, backgroundColor, color, opacity, borderRadius, border (and sides, color, width, style), boxShadow, fontSize, fontWeight, fontStyle, fontFamily, lineHeight, letterSpacing, textAlign, textDecoration, textTransform, whiteSpace, overflow, objectFit. Others are dropped and listed in "ignored".
- Units: px for sizes and font sizes; lineHeight in px or a plain number. Boxes use border-box sizing.
- Frames: set a width and use height:fit-content so the frame grows with its content.`
  },
  {
    topic: 'math',
    title: 'Text markup and math',
    body: `- Text nodes store light markup: **bold**, *italic*, $inline math$ (KaTeX syntax, for example $T^2 \\propto a^3$).
- In write_html, write math as $…$ inside the text; it passes through. set_text takes the markup directly.
- A literal * or $ is written \\* or \\$ in set_text.`
  },
  {
    topic: 'svg',
    title: 'Diagrams (SVG)',
    body: `- Draw diagrams as inline <svg> with a viewBox. Give the svg a width and height in its style (or attributes).
- Give shapes ids (id="atom-a"): they are kept, and get_node_info lists them. Ids are scoped per drawing, so two drawings may both use "arrow".
- Markers and gradients work with url(#id) inside the same svg. No scripts, no foreignObject, no external links or images.
- Use the colour tokens (fill="var(--ls-accent)") so diagrams match the app.`
  },
  {
    topic: 'images',
    title: 'Images',
    body: `- <img src="https://…"> downloads the picture into the folder's assets/ (images only, up to 10 MB). data: URLs are saved there too.
- A path inside the learning folder (assets/orbit.png) is used as is.
- Give images a width and height (style or attributes), so the layout does not jump when they load.`
  },
  {
    topic: 'tokens',
    title: 'Colour and font tokens',
    body: `- Use these in any style value: var(--ls-card), var(--ls-card-2) (backgrounds), var(--ls-text), var(--ls-muted) (text), var(--ls-accent) (blue), var(--ls-good) (green), var(--ls-bad) (pink-red), var(--ls-warn) (yellow), var(--ls-border), var(--ls-font), var(--ls-mono).
- The canvas is dark. Literal colours work too; keep contrast high.
- Text sizes: 22–28px titles, 15–17px body, 13px for small notes. Avoid text under 12px.`
  },
  {
    topic: 'placement',
    title: 'Placement',
    body: `- place: {right_of | left_of | below | above | over: id, gap?: 32, align?: "start" | "center" | "end"} puts a thing relative to a node or ink group. create_frame, write_html (target_id "root"), duplicate_nodes, move_nodes ({node_id, place}) and draw_ink take it. A taken spot slides along that side, then the next side; the result's "placed" says what happened.
- Without place or x, y, create_frame and root writes find an empty spot beside "near" (or the learner's latest work), inside the learner's view when it fits.
- find_space({width, height, near?}) returns an empty rect (32 pt from everything) for x, y writes.
- Every write and move returns overlaps: [{id, kind, author, area_pct}] for what it now covers, and warnings such as "covers learner ink g3". Fix those with move_nodes unless you meant it (a mark with place over).
- Never cover the learner's ink with material unless they ask.
- get_screenshot with labels: true tags every group and top-level node with its id; grid: true adds board coordinates. Use them to match the image to ids and points.
- move_nodes moves anything, learner ink included: {node_id, place}, {node_id, x, y} (top-left in the parent's space), {node_id, dx, dy}, {node_id, parent_id, index} ("root" = top level) or {node_id, before|after}.`
  },
  {
    topic: 'ink',
    title: 'Drawing ink (marks on the learner\'s work)',
    body: `- draw_ink draws like a pen: natural pressure, a slight wobble. Use it for marks, not for text: write text with write_html.
- Shapes from a target's bounds: draw_ink({shape: "circle", target: "g3"}) circles a mistake; {shape: "tick", target: "g2"} or "cross" goes just right of it; {shape: "underline", target: "g4"}; {shape: "arrow", target: "g3", from_id: "n_hint"} points from your note to their work.
- Free drawing: strokes [[[x, y], …], …] or svg_path "M0 0 C 20 -30, 60 -30, 80 0"; place {over: "g3"} centres it on the target, {right_of: "g3"} puts it beside. Example arrow: svg_path "M0 0 L80 0 M66 -10 L80 0 L66 10", place {left_of: "g2"}.
- Colours: pink (bad) circles and crosses, green (good) ticks, accent otherwise. The default never matches the learner's pen colour.
- Each call is one undo step and one ink group: delete_nodes(["g7"]) removes that mark.
- Marks are feedback, so keep them few and clear. Prefer a question in a card over many marks.`
  },
  {
    topic: 'view',
    title: 'Moving the learner\'s view',
    body: `- focus({node_id}) glides the learner's view to a node or ink group; it zooms out only when needed. It does nothing when the target is already visible.
- Use it rarely: only when the learner must see something now (for example material you placed outside their view).
- Do not move the view while they write. focus skips itself while a stroke is in progress or within 2 s of the last one, and says so; then tell the learner where to look instead.`
  },
  {
    topic: 'workflow',
    title: 'Workflow',
    body: `1. Look: get_canvas_info (ink groups), get_tree, get_screenshot (target "viewport" or a node_id; labels: true to see the ids).
2. Make room: create_frame with place: {right_of: "g3"} (name it, for example "Kepler hint").
3. Fill it in small steps: write_html into the frame (insert_children), one group per call.
4. Check: get_screenshot with node_id of the frame. Fix what is wrong.
5. Edit, do not rewrite: update_styles, set_text and move_nodes keep ids and are cheap. Use get_html + write_html (mode "replace") for a bigger restructure; ids in data-id are kept.
6. finish_working when the piece is done (it removes your "working" outline).
- Each write is one undo step for the learner. They may change or delete your material: read get_changes before you edit it again.`
  },
  {
    topic: 'example',
    title: 'Example: an explanation card',
    body: `create_frame({ name: "Kepler hint", place: { right_of: "g3" } }) → { id: "n_abc", overlaps: [] }
write_html({ target_id: "n_abc", mode: "insert_children", html: \`
<h2 style="color: var(--ls-text)">Why does the period grow?</h2>
<p style="font-size: 16px; color: var(--ls-muted)">Compare two orbits: the outer planet travels <b>farther</b> and <i>slower</i>. Kepler found $T^2 \\propto a^3$.</p>
<div layer-name="Try it" style="display: flex; gap: 8px; padding: 12px; border-radius: 8px; background: var(--ls-card-2)">
  <p style="font-size: 15px">If $a$ doubles, by what factor does $T$ grow?</p>
</div>\` })
get_screenshot({ node_id: "n_abc" }) → check
draw_ink({ shape: "arrow", from_id: "n_abc", target: "g3" }) → points the card at their work
finish_working({ node_ids: ["n_abc"] })`
  }
]

export function guideText(topic?: string): string {
  const sections = topic ? GUIDE_SECTIONS.filter((section) => section.topic === topic) : GUIDE_SECTIONS
  if (!sections.length) throw new Error(`No guide topic "${topic}". Topics: ${GUIDE_SECTIONS.map((section) => section.topic).join(', ')}.`)
  return ['# Learning Space: the agent guide', '', ...sections.flatMap((section) => [`## ${section.title}`, section.body, ''])].join('\n')
}
