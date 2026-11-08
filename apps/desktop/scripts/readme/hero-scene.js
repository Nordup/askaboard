// The README hero image's board (apps/desktop/scripts/readme/hero-image.mjs plays it): the website hero
// (apps/website/components/hero: scene.ts drawings, layout.ts places) rebuilt with the board's own
// ink and items, in its still state. Board points = the hero's design units, origin at the centre.
// The places differ from the site's: the site's windows are left out (the drawings stay loose at the
// same angles), the Download button's space under the subline is filled, and the lower-left corner
// stays free for the Claude Code window that the composite puts in front of it.
const PLACES = {
  waves: { x: -340, y: -250, r: -2.8, s: 0.92 },
  cube: { x: 505, y: -224, r: 5, s: 0.92 },
  neuron: { x: -640, y: 40, r: -6.8, s: 0.86 },
  earth: { x: 574, y: 205, r: 4.2, s: 0.92 },
  sun: { x: 110, y: 292, r: 0, s: 1.2 },
  planet: { x: -150, y: 265, r: 0, s: 1.05 },
  squiggle: { x: 104, y: -258, r: 0, s: 1 },
  voice: { x: 505, y: -66, r: 0, s: 1 },
  hint: { x: 365.5, y: 453, r: 0, s: 1 }
}
const TAU = Math.PI * 2
const D = Math.PI / 180
const LABEL_SCALE = 0.74
const BAR = 28

// ---------- geometry (copied from lib/board/kit.ts and scene.ts) ----------
function arc(cx, cy, r, a0 = 0, a1 = TAU, n = 0) {
  const steps = n || Math.max(8, Math.ceil((Math.abs(a1 - a0) * r) / 4))
  return Array.from({ length: steps + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / steps; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] })
}
function oval(cx, cy, rx, ry, rot = 0, a0 = 0, a1 = TAU) {
  const steps = Math.max(12, Math.ceil((Math.abs(a1 - a0) * Math.max(rx, ry)) / 4))
  const c = Math.cos(rot), s = Math.sin(rot)
  return Array.from({ length: steps + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / steps; const x = rx * Math.cos(a), y = ry * Math.sin(a); return [cx + x * c - y * s, cy + x * s + y * c] })
}
const wave = (x0, x1, y, amp, len, phase, tilt = 0) => { const out = []; for (let x = x0; x <= x1 + 0.01; x += 2.5) out.push([x, y + tilt * (x - x0) + amp * Math.sin(((x - x0) / len) * TAU - phase)]); return out }
function arrowLines(x1, y1, x2, y2, head = 7) {
  const l = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / l, uy = (y2 - y1) / l
  const wing = (a) => [x2 - head * (ux * Math.cos(a) - uy * Math.sin(a)), y2 - head * (uy * Math.cos(a) + ux * Math.sin(a))]
  return [[[x1, y1], [x2, y2]], [wing(0.45), [x2, y2], wing(-0.45)]]
}
function dashes(x1, y1, x2, y2, on = 5, off = 4) {
  const l = Math.hypot(x2 - x1, y2 - y1), out = []
  for (let s = 0; s < l; s += on + off) { const e = Math.min(l, s + on); out.push([[x1 + ((x2 - x1) * s) / l, y1 + ((y2 - y1) * s) / l], [x1 + ((x2 - x1) * e) / l, y1 + ((y2 - y1) * e) / l]]) }
  return out
}

// ---------- a sprite: its place on the board ----------
function sprite(place, w, h, win, inner = { x: 0, y: 0, r: 0, s: 1 }) {
  const c = Math.cos(place.r * D), sn = Math.sin(place.r * D)
  const ic = Math.cos(inner.r), is = Math.sin(inner.r)
  // local (body) point -> board point
  const T = ([px, py]) => {
    const qx = inner.x + (px * ic - py * is) * inner.s, qy = inner.y + (px * is + py * ic) * inner.s
    const lx = (qx - w / 2) * place.s, ly = (qy + (win ? BAR : 0) - h / 2) * place.s
    return [place.x + lx * c - ly * sn, place.y + lx * sn + ly * c]
  }
  const k = place.s * inner.s
  const rot = place.r + inner.r / D
  const g = {
    T, k,
    pen(lines, color = 'text', width = 3, jitter = 0.3) { return stroke(lines.map((l) => l.map(T)), { color, width: width * k, jitter }) },
    line(pts, color, width, jitter = 0.25) { return stroke([pts.map(T)], { color, width: width * k, jitter }) },
    seg(x1, y1, x2, y2, color, width, dash) { const a = T([x1, y1]), b = T([x2, y2]); return line(a[0], a[1], b[0], b[1], dash ? { color, width: width * k, dash } : { color, width: width * k }) },
    dot(x, y, r, color = 'text', alpha = 1) { const p = T([x, y]); return circle(p[0], p[1], r * k, { color: 'none', fill: color, fillOpacity: alpha }) },
    async label(text, size, x, y, color = 'text', o = {}) {
      const p = T([x, y])
      const w = write(text, { size: size * LABEL_SCALE * k, color, ...(o.center ? { center: p } : { at: p }) })
      if (Math.abs(rot) > 0.01) await tween(w, { rotate: rot }, 0)
      return w
    }
  }
  return g
}

// ---------- the windows ----------
async function wavesWindow() {
  const g = sprite(PLACES.waves, 400, 200, true)
  const phase = 0.9
  g.line(wave(32, 168, 46, 10, 46, phase, 0.01), 'yellow', 2.6)
  g.line(wave(34, 170, 84, 9, 46, phase, 0.01), 'blue', 2.6)
  g.line(wave(246, 378, 66, 27, 44, phase), 'pink', 2.6)
  g.pen([[[180, 36], [187, 40], [188, 54], [189, 62], [196, 66], [189, 70], [188, 80], [187, 92], [180, 96]]], 'text', 2.4, 0.2)
  g.pen(arrowLines(207, 66, 234, 66), 'text', 2.4, 0.2)
  await g.label('two waves', 15, 106, 127, 'text', { center: true })
  await g.label('(interference)', 15, 106, 146, 'text', { center: true })
  await g.label('constructive', 15, 312, 120, 'text', { center: true })
  await g.label('interference', 15, 316, 139, 'text', { center: true })
}

async function neuronWindow() {
  const g = sprite(PLACES.neuron, 270, 505, true, { x: 28, y: 4, r: 0, s: 1 })
  const soma = [62, 172]
  const dendrites = [
    [soma, [46, 142], [32, 114], [22, 92], [10, 70]], [[32, 114], [44, 94], [42, 72]], [[22, 92], [4, 88]],
    [soma, [66, 136], [70, 106], [72, 80], [66, 56]], [[70, 106], [88, 88], [96, 66]], [[72, 80], [86, 62]],
    [soma, [86, 150], [108, 130], [128, 112], [140, 94]], [[108, 130], [130, 138], [148, 132]], [[128, 112], [126, 90]],
    [soma, [90, 174], [118, 180], [140, 172]], [[118, 180], [134, 198]],
    [soma, [38, 174], [16, 168], [-2, 162]], [[16, 168], [4, 188]],
    [soma, [44, 194], [24, 208], [6, 216]]
  ]
  const axon = [[62, 182], [61, 214], [60, 246], [59, 278], [58, 310], [57, 342], [56, 374], [56, 402]]
  const ends = [[20, 448], [36, 462], [56, 466], [76, 460], [94, 446]]
  const capsule = (cx, y0, y1, r = 6) => [...arc(cx, y0 + r, r, Math.PI, TAU, 10), [cx + r, y1 - r], ...arc(cx, y1 - r, r, 0, Math.PI, 10), [cx - r, y0 + r]]
  await g.label('neuron', 18, 84, 30, 'text', { center: true })
  g.pen(dendrites, 'yellow', 2.2, 0.3)
  g.pen([arc(soma[0], soma[1], 7, 0, TAU, 18)], 'pink', 2.2, 0.15)
  g.dot(soma[0], soma[1], 2.4, 'pink')
  g.pen([axon], 'yellow', 2.2, 0.2)
  g.pen([0, 1, 2, 3, 4].map((i) => capsule(60 - i, 218 + i * 32, 242 + i * 32)), 'green', 2.2, 0.15)
  g.pen(ends.map((e) => [[56, 402], [(56 + e[0]) / 2 + 2, (402 + e[1]) / 2 - 4], e]), 'pink', 2.2, 0.25)
  g.pen(ends.map((e) => arc(e[0], e[1] + 4, 4, 0, TAU, 10)), 'pink', 2, 0.1)
  await g.label('dendrite', 14, 180, 108, 'text', { center: true })
  await g.label('(receive)', 14, 182, 126, 'text', { center: true })
  await g.label('axon', 14, 154, 292, 'text', { center: true })
  await g.label('(send)', 14, 158, 311, 'text', { center: true })
  g.pen(arrowLines(130, 302, 80, 304, 6), 'text', 2, 0.2)
  await g.label('synapse', 14, 166, 430, 'text', { center: true })
  await g.label('(to next neuron)', 13, 164, 449, 'text', { center: true })
}

async function cubeWindow() {
  const g = sprite(PLACES.cube, 286, 170, true)
  const f = { x: 40, y: 40, s: 46 }, b = { x: f.x + 20, y: f.y - 14 }
  const solid = [
    [[f.x, f.y], [f.x + f.s, f.y], [f.x + f.s, f.y + f.s], [f.x, f.y + f.s], [f.x, f.y]],
    [[f.x, f.y], [b.x, b.y], [b.x + f.s, b.y], [b.x + f.s, b.y + f.s], [f.x + f.s, f.y + f.s]],
    [[f.x + f.s, f.y], [b.x + f.s, b.y]]
  ]
  const hidden = [...dashes(b.x, b.y, b.x, b.y + f.s), ...dashes(b.x, b.y + f.s, b.x + f.s, b.y + f.s), ...dashes(b.x, b.y + f.s, f.x, f.y + f.s)]
  g.pen(solid, 'blue', 2.2, 0.15)
  g.pen(hidden, 'blue', 1.8, 0.1)
  g.pen(arrowLines(128, 58, 162, 58), 'yellow', 2.4, 0.2)
  await g.label('cube', 16, 64, 118, 'text', { center: true })
  await g.label('rotate', 16, 220, 118, 'text', { center: true })
  // the turning cube, still: yaw 0.55, tilt -0.42
  const corners = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z])
  const edges = []
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) if (corners[i].filter((v, k) => v !== corners[j][k]).length === 1) edges.push([i, j])
  const yaw = 0.55, tilt = -0.42, half = 25
  const p = corners.map(([x, y, z]) => {
    const x1 = x * Math.cos(yaw) + z * Math.sin(yaw), z1 = -x * Math.sin(yaw) + z * Math.cos(yaw)
    const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt), z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt)
    return [220 + x1 * half, 60 + y2 * half, z2]
  })
  let far = 0
  for (let i = 1; i < 8; i++) if (p[i][2] > p[far][2]) far = i
  for (const [i, j] of edges) { const back = i === far || j === far; g.seg(p[i][0], p[i][1], p[j][0], p[j][1], 'blue', back ? 1.6 : 2.2, back ? [4, 5] : null) }
}

async function earthWindow() {
  const g = sprite(PLACES.earth, 450, 330, true)
  const top = [222, 20], left = [26, 139], eye = [222, 134]
  const beam = [[top[0], top[1] + 12], [eye[0], eye[1] - 6]]
  const long = [[left[0] + 12, left[1]], [eye[0] - 8, eye[1]]]
  const scatter = [[[84, 136], [102, 108]], [[126, 136], [144, 108]], [[168, 135], [186, 107]]]
  g.pen([arc(225, 330, 250, Math.PI + 0.46, TAU - 0.46)], 'blue', 2.2, 0.2)
  g.pen([arc(225, 336, 200, Math.PI + 0.36, TAU - 0.36)], 'green', 2.4, 0.2)
  g.pen([arc(top[0], top[1], 11, 0, TAU, 20)], 'yellow', 2.2, 0.15)
  g.pen([beam, ...arrowLines(top[0], 60, top[0], 76, 6).slice(1)], 'yellow', 2.6, 0.15)
  g.pen([arc(left[0], left[1], 11, 0, TAU, 20)], 'yellow', 2.2, 0.15)
  g.pen([long, ...arrowLines(40, 139, 62, 138.5, 6).slice(1)], 'orange', 2.6, 0.15)
  g.pen(scatter.flatMap(([a, b]) => arrowLines(a[0], a[1], b[0], b[1], 6)), 'blue', 2, 0.15)
  g.pen([oval(eye[0], eye[1], 7, 4), [[eye[0] + 0.5, eye[1]], [eye[0] - 0.5, eye[1]]]], 'text', 1.8, 0.05)
  await g.label('short path', 13.5, 246, 18, 'text')
  await g.label('through air', 13.5, 246, 37, 'text')
  await g.label('air', 13, 352, 84, 'blue', { center: true })
  await g.label('(thickness exaggerated)', 11.5, 368, 102, 'blue', { center: true })
  await g.label('long path through air', 12.5, 118, 164, 'orange', { center: true })
  await g.label('Earth', 15, 238, 184, 'green', { center: true })
  await g.label('blue sky: light scattered toward you', 14.5, 222, 236, 'blue', { center: true })
  await g.label('red sunset: light left in the direct beam', 14.5, 232, 263, 'orange', { center: true })
}

// ---------- the loose ink ----------
function sunInk() {
  const g = sprite(PLACES.sun, 170, 100, false)
  const sun = [118, 45]
  g.pen([arc(82, 198, 132, -2.18, -0.96)], 'green', 2.4, 0.25)
  g.pen([arc(sun[0], sun[1], 15, 0, TAU, 28)], 'yellow', 2.4, 0.2)
  for (const d of [175, -145, -100, -60, -25, 20]) {
    const a = d * D
    g.line([[sun[0] + 21 * Math.cos(a), sun[1] + 21 * Math.sin(a)], [sun[0] + 30 * Math.cos(a), sun[1] + 30 * Math.sin(a)]], 'yellow', 2.4)
  }
}

function planetInk() {
  const g = sprite(PLACES.planet, 125, 115, false)
  const c = [62, 66], rot = -0.36
  g.pen([oval(c[0], c[1], 40, 11, rot, Math.PI, TAU)], 'blue', 2.2, 0.15)
  g.pen([arc(c[0], c[1], 17, 0, TAU, 28)], 'yellow', 2.4, 0.2)
  g.pen([oval(c[0], c[1], 40, 11, rot, 0, Math.PI)], 'blue', 2.2, 0.15)
  for (const [x, y] of [[27, 19], [45, 27], [82, 12], [15, 43], [114, 100]]) g.dot(x, y, 1.6, 'text', 0.8)
}

function squiggleInk() {
  const g = sprite(PLACES.squiggle, 165, 45, false)
  g.line(wave(8, 157, 30, 8, 50, 0, -0.09), 'yellow', 2.4)
}

async function voiceInk() {
  // In the site's "move things around" place, size and turn: the agent's voice, a note and a speaker.
  const SCALE = 1.45, w = 175 * SCALE, h = 85 * SCALE
  const place = PLACES.voice
  const words = sprite(place, w, h, false, { x: 64 * SCALE, y: 26 * SCALE, r: -0.2, s: SCALE })
  await words.label('it explains', 16, 0, 0, 'text', { center: true })
  await words.label('out loud', 16, 4, 22, 'text', { center: true })
  const g = sprite(place, w, h, false, { x: 0, y: 0, r: 0, s: SCALE })
  // the speaker, as pen ink in the text colour; the sound waves in yellow, like the hand's ticks were
  g.pen([[[128, 47], [134, 47], [134, 57], [128, 57], [128, 47]], [[134, 47], [143, 40], [143, 64], [134, 57]]], 'text', 1.9, 0.15)
  for (const r of [6, 11, 16]) g.pen([arc(145, 52, r, -0.75, 0.75, 10)], 'yellow', 2, 0.15)
}

async function pillHint() {
  const g = sprite(PLACES.hint, 225, 100, false)
  await g.label('draw, write,', 22, 140, 42, 'text', { center: true })
  await g.label('make shapes', 22, 146, 72, 'text', { center: true })
  // the app's tool palette is pinned to the window's foot: the hint sits beside its right end, the arrow turned down to it
  const line = [[62, 60], [44, 62], [28, 70], [16, 82], [9, 94]]
  g.line(line, 'yellow', 2.6)
  const [tx, ty] = line[4], [px, py] = line[3], a = Math.atan2(ty - py, tx - px)
  for (const side of [0.5, -0.5]) g.line([[tx - 9 * Math.cos(a + side), ty - 9 * Math.sin(a + side)], [tx, ty]], 'yellow', 2.6)
}


// ---------- the headline (Hero.module.css .head, .title, .sub) ----------
function headline() {
  html(`<div style="width:1000px;display:flex;flex-direction:column;align-items:center;gap:19px">
  <p style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,system-ui,sans-serif;font-size:94px;line-height:88px;font-weight:700;letter-spacing:-0.022em;color:#ffffff;text-align:center">Ask anything.<br>Learn anything.</p>
  <p style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',Inter,system-ui,sans-serif;font-size:31px;line-height:37px;font-weight:400;letter-spacing:0.06em;color:#ffffff;text-align:center">A shared canvas for learning with your AI.</p>
</div>`, { at: [-500, -113], name: 'Headline' })
}

await wavesWindow()
await neuronWindow()
await cubeWindow()
await earthWindow()
sunInk()
planetInk()
squiggleInk()
await voiceInk()
await pillHint()
headline()
// the view: the hero's framing (the reference's scale), a little lower so the layout clears the app's top bar
await camera({ to: [0, 75], zoom: 0.725 }, 0.2)
