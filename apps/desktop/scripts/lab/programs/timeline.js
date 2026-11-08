// The timeline: actions with await run one after another; without await they
// start together. Two async functions keep their own time side by side.
const v = board.view
const x0 = v.x + v.width / 2 - 260
const y0 = v.y + v.height / 2 - 120

step('one after another')
for (let i = 0; i < 4; i++) await draw(circle(x0 + i * 70, y0, 26, { color: 'accent' }), 0.4)

step('together')
const row = []
for (let i = 0; i < 4; i++) row.push(rect(x0 - 26 + i * 70, y0 + 60, 52, 52, { color: 'good', fill: 'good', fillOpacity: 0.25, radius: 8 }))
await all(...row.map((r) => draw(r, 0.8)))

step('two hands')
async function wave(y, color) {
  const pts = []
  for (let k = 0; k <= 60; k++) pts.push([x0 - 26 + k * 4.5, y + Math.sin(k / 6) * 14])
  const s = stroke(pts, { color, width: 4 })
  await draw(s, 1.2)
  await move(s, { by: [300, 0] }, 0.8)
}
await Promise.all([wave(y0 + 160, 'warn'), (async () => { await wait(0.4); await wave(y0 + 200, 'pink') })()])

step('change')
await all(...row.map((r, i) => tween(r, { rotate: 45 + i * 15, scale: 0.7 }, 0.8)))
await tween(group(...row), { y: -30, color: 'warn' }, 0.6)
const f = plot((x) => Math.sin(x) * 1.2, { x: [-Math.PI, Math.PI], at: [x0 + 520, y0 + 60], unit: 40, color: 'accent', width: 3 })
await draw(f, 1.5)
console.log('done at', f.bounds)
