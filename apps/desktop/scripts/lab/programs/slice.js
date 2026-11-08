// Archimedes' slice, live: one value h (the height of the cut) drives the disc
// in the half sphere, the ring in the cylinder-minus-cone, the triangle and
// every label. The cut slides; the two areas stay equal.

const v = board.view
const R = 110
const k = 0.28 // how flat a circle looks from the side
const ox = v.x + v.width / 2
const oy = v.y + v.height / 2 + 70
const S = [ox - 190, oy] // centre of the half sphere's base
const C = [ox + 190, oy] // centre of the cylinder's base

const h = value(0.3 * R)
const a = () => Math.sqrt(Math.max(0, R * R - h.get() ** 2)) // the disc's radius
const y = () => S[1] - h.get()
const area = () => (Math.PI * (1 - (h.get() / R) ** 2)).toFixed(2) // in units of r²

// A flat ring between radii big > small as one path (the inner circle runs the other way: a hole).
const ring = (cx, cy, big, small) =>
  `M${cx - big} ${cy} A${big} ${big * k} 0 1 0 ${cx + big} ${cy} A${big} ${big * k} 0 1 0 ${cx - big} ${cy} Z ` +
  (small > 0.5 ? `M${cx - small} ${cy} A${small} ${small * k} 0 1 1 ${cx + small} ${cy} A${small} ${small * k} 0 1 1 ${cx - small} ${cy} Z` : '')

// ---------- The two solids ----------
step('two solids')
say('On the left, half of a sphere of radius r. On the right, a cylinder with a cone taken out.')
const dome = path(`M${S[0] - R} ${S[1]} A${R} ${R} 0 0 1 ${S[0] + R} ${S[1]}`, { width: 3 })
const base = ellipse(S[0], S[1], R, R * k, { color: 'muted', width: 2 })
await draw(dome, 1.1)
await draw(base, 0.5)
group(dome, base, { name: 'half sphere' })

const top = C[1] - R
const cyl = group(
  line(C[0] - R, C[1], C[0] - R, top, { color: 'good' }),
  line(C[0] + R, C[1], C[0] + R, top, { color: 'good' }),
  ellipse(C[0], top, R, R * k, { color: 'good' }),
  ellipse(C[0], C[1], R, R * k, { color: 'muted', width: 2 }),
  line(C[0], C[1], C[0] - R, top, { color: 'warn', width: 2, dash: [6, 5] }),
  line(C[0], C[1], C[0] + R, top, { color: 'warn', width: 2, dash: [6, 5] }),
  { name: 'cylinder minus cone' }
)
await draw(cyl, 2.2)

// ---------- One cut at height h ----------
step('a cut at height h')
const disc = ellipse(S[0], y, a, () => a() * k, { fill: 'accent', fillOpacity: 0.45, color: 'accent', width: 2.5, name: 'disc' })
const ringShape = path(() => ring(C[0], C[1] - h.get(), R, h.get()), { fill: 'good', fillOpacity: 0.4, color: 'good', width: 2, name: 'ring' })
const legs = polygon(() => [[S[0], S[1]], [S[0], y()], [S[0] + a(), y()]], { color: 'muted', width: 2, dash: [5, 5], closed: false })
const hyp = line(S[0], S[1], () => S[0] + a(), y, { color: 'warn', width: 2.5 })
say('Cut both at the same height h.')
await all(fillIn(disc, 0.8), fillIn(ringShape, 0.8))
await all(draw(legs, 0.6), draw(hyp, 0.6))
await all(
  draw(label(() => [[S[0], S[1]], [S[0], y()]], 'h', { side: 'left', color: 'good', size: 20 }), 0.4),
  draw(label(() => [[S[0], S[1]], [S[0] + a(), y()]], 'r', { color: 'warn', size: 20 }), 0.4)
)

// ---------- The areas, live ----------
step('the areas')
await say('The disc has area pi times r squared minus h squared. So does the ring.')
const discArea = label(disc, () => `disc = ${area()} r²`, { color: 'accent', size: 22 })
const ringArea = label(ringShape, () => `ring = ${area()} r²`, { color: 'good', size: 22 })
await all(draw(discArea, 0.8), draw(ringArea, 0.8))
const hTag = write(() => `h = ${(h.get() / R).toFixed(2)} r`, { at: [ox - 60, oy + 60], size: 22, color: 'good' })
await draw(hTag, 0.6)

// ---------- Slide the cut ----------
step('slide the cut')
say('Now slide the cut up. Watch both areas shrink together.')
await tween(h, 0.92 * R, 3.5)
step('your turn', { pause: true })
say('And down again. At every height, the two slices match.')
await tween(h, 0.08 * R, 3.5)
await tween(h, 0.5 * R, 1.5)

// ---------- So the volumes match ----------
step('so the volumes match')
await say('Same slices at every height, so the same volume.')
const result = tex('V_{half} = \\pi r^3 - \\tfrac{1}{3}\\pi r^3 = \\tfrac{2}{3}\\pi r^3', { center: [ox, oy + 120], size: 28, name: 'result' })
await draw(result, 1.2)
await draw(around(result, { shape: 'underline' }), 0.5)
