// Why is the volume of a sphere 4/3 π r³? Archimedes' slicing argument, drawn live:
// at every height h, a slice of the half sphere has the same area as a slice of
// a cylinder with a cone taken out. So half sphere = cylinder − cone = πr³ − ⅓πr³.
// Run it with run_scene (see the scene topic of get_guide).

const v = board.view
const R = 120
const ox = v.x + v.width / 2
const oy = v.y + v.height / 2 - 90
const S = [ox - 240, oy] // the sphere's centre
const C = [ox + 220, oy] // the centre of the cylinder's base
const k = 0.26 // how flat a circle looks from the side

// Half of a flat circle seen from the side: the front (lower) half or the back (upper) half.
const half = (cx, cy, rx, front) => `M${cx - rx} ${cy} A${rx} ${rx * k} 0 0 ${front ? 0 : 1} ${cx + rx} ${cy}`
// A flat ring between radii a > b, as one path (the inner circle runs the other way, so it is a hole).
const ring = (cx, cy, a, b) =>
  `M${cx - a} ${cy} A${a} ${a * k} 0 1 0 ${cx + a} ${cy} A${a} ${a * k} 0 1 0 ${cx - a} ${cy} Z ` +
  (b > 0.5 ? `M${cx - b} ${cy} A${b} ${b * k} 0 1 1 ${cx + b} ${cy} A${b} ${b * k} 0 1 1 ${cx - b} ${cy} Z` : '')

// ---------- 1. The sphere ----------
step('the sphere')
const ball = circle(S[0], S[1], R, { fill: ['#2b3a78', '#121733'], width: 3, name: 'sphere' })
await draw(ball, 1.4)
draw(path(half(S[0], S[1], R, false), { color: 'muted', width: 2, dash: [6, 7] }), 0.7)
await draw(path(half(S[0], S[1], R, true), { color: 'muted', width: 2 }), 0.7)
const radius = line(S[0], S[1], S[0] + R, S[1], { color: 'warn', width: 2.5 })
await draw(radius, 0.5)
await draw(write('r', { center: [S[0] + R / 2, S[1] - 16], size: 22, color: 'warn' }))
const question = write('V = ?', { center: [S[0], S[1] + R + 48], size: 30 })
await draw(question)
await wait(0.6)

// ---------- 2. One slice of the half sphere ----------
step('one slice')
const h = 0.55 * R
const a = Math.sqrt(R * R - h * h)
const y = S[1] - h
const disc = ellipse(S[0], y, a, a * k, { fill: 'accent', fillOpacity: 0.5, color: 'accent', width: 2.5 })
await draw(disc, 0.9)
const legs = polygon([[S[0], S[1]], [S[0], y], [S[0] + a, y]], { color: 'good', width: 2, dash: [5, 5], closed: false })
const hyp = line(S[0], S[1], S[0] + a, y, { color: 'warn', width: 2.5 })
await all(draw(legs, 0.9), draw(hyp, 0.9), fadeOut(radius, 0.6))
await all(
  draw(write('h', { center: [S[0] - 14, (S[1] + y) / 2], size: 20, color: 'good' }), 0.4),
  draw(write('r', { center: [S[0] + a / 2 + 14, (S[1] + y) / 2 + 6], size: 20, color: 'warn' }), 0.3)
)
const sphereArea = write('π(r² − h²)', { center: [S[0], S[1] - R - 50], size: 26, color: 'accent' })
await draw(sphereArea)
await wait(0.5)

// ---------- 3. The same slice of a cylinder minus a cone ----------
step('cylinder minus cone')
const top = C[1] - R
const cyl = { color: 'good', width: 2.5 }
const cylinder = group(
  line(C[0] - R, C[1], C[0] - R, top, cyl),
  path(half(C[0], top, R, false), cyl),
  path(half(C[0], top, R, true), cyl),
  line(C[0] + R, top, C[0] + R, C[1], cyl),
  path(half(C[0], C[1], R, true), cyl),
  path(half(C[0], C[1], R, false), { ...cyl, dash: [6, 7] })
)
await draw(cylinder, 2.2)
const cone = { color: 'pink', width: 2.5 }
await all(draw(line(C[0], C[1], C[0] - R, top, cone), 0.6), draw(line(C[0], C[1], C[0] + R, top, cone), 0.6))
const ringSlice = path(ring(C[0], C[1] - h, R, h), { fill: 'accent', fillOpacity: 0.5, color: 'accent', width: 2.5 })
await draw(ringSlice, 1.1)
const ringArea = write('πr² − πh²', { center: [C[0], S[1] - R - 50], size: 26, color: 'accent' })
await draw(ringArea)
const same = arrow(sphereArea.bounds.x + sphereArea.bounds.width + 24, S[1] - R - 50, ringArea.bounds.x - 24, S[1] - R - 50, { color: 'muted', width: 2 })
await draw(same, 0.6)
await draw(write('same area', { center: [ox - 10, S[1] - R - 74], size: 16, color: 'muted' }), 0.6)
await wait(0.6)

// ---------- 4. At every height ----------
step('every height')
const heights = [0.08, 0.2, 0.32, 0.44, 0.66, 0.78, 0.9]
async function stack(make) {
  for (const t of heights) {
    fillIn(make(t * R), 0.4)
    await wait(0.14)
  }
}
await Promise.all([
  stack((hh) => {
    const aa = Math.sqrt(R * R - hh * hh)
    return ellipse(S[0], S[1] - hh, aa, aa * k, { fill: 'accent', fillOpacity: 0.22, color: 'accent', width: 1.5, opacity: 0.8 })
  }),
  stack((hh) => path(ring(C[0], C[1] - hh, R, hh), { fill: 'accent', fillOpacity: 0.22, color: 'accent', width: 1.5, opacity: 0.8 }))
])
await wait(0.5)

// ---------- 5. Add the slices up ----------
step('the formula')
await erase(question, 0.6)
const lines = [
  '½ sphere = cylinder − cone',
  '= πr²·r − ⅓·πr²·r',
  '= ⅔ πr³'
]
let ly = S[1] + R + 36
const written = []
for (const text of lines) {
  const w = write(text, { at: [S[0] - R, ly], size: 24 })
  await draw(w)
  written.push(w)
  ly += 46
}
await wait(0.4)
const result = tex('V = 2 \\cdot \\tfrac{2}{3}\\pi r^3 = \\frac{4}{3}\\pi r^3', { center: [C[0] + 30, C[1] + R + 150], size: 34, color: 'warn' })
await draw(result, 1.2)
await draw(around(result, { color: 'warn' }), 0.9)
console.log('sphere at', S, 'cylinder at', C, 'formula bounds', result.bounds)
