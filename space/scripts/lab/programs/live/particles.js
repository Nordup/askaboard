// live: canvas  size: 460x340  params: count=260 gravity=0.4 heat=1
// A gas in a box: hard balls that collide elastically, pulled down by gravity.
// Colour shows speed (blue slow, green middle, yellow fast), so the dense slow
// layer at the bottom and the fast molecules above it are visible.
// count: number of balls, gravity: downward pull, heat: the starting speed.
const S = this
const n = Math.max(1, Math.round(params.count))
const r = 4.2
if (!S.b || S.b.length !== n) {
  S.b = Array.from({ length: n }, () => {
    const a = Math.random() * Math.PI * 2, v = (0.6 + Math.random()) * 90 * params.heat
    return { x: r + Math.random() * (w - 2 * r), y: r + Math.random() * (h - 2 * r), vx: Math.cos(a) * v, vy: Math.sin(a) * v }
  })
}
const step = Math.min(dt || 1 / 60, 1 / 30)
const g = params.gravity * 200
const B = S.b
for (const p of B) {
  p.vy += g * step
  p.x += p.vx * step
  p.y += p.vy * step
  if (p.x < r) { p.x = r; p.vx = Math.abs(p.vx) }
  if (p.x > w - r) { p.x = w - r; p.vx = -Math.abs(p.vx) }
  if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy) }
  if (p.y > h - r) { p.y = h - r; p.vy = -Math.abs(p.vy) }
}
// Collisions through a grid of cells, so the cost grows with n, not n².
const cell = 2 * r, cols = Math.ceil(w / cell), grid = new Map()
B.forEach((p, i) => {
  const key = Math.floor(p.x / cell) + Math.floor(p.y / cell) * cols
  const list = grid.get(key)
  if (list) list.push(i)
  else grid.set(key, [i])
})
for (let i = 0; i < n; i++) {
  const p = B[i], cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(cx + dx + (cy + dy) * cols) ?? []) {
        if (j <= i) continue
        const q = B[j], ex = q.x - p.x, ey = q.y - p.y, d2 = ex * ex + ey * ey
        if (d2 === 0 || d2 > 4 * r * r) continue
        const d = Math.sqrt(d2), nx = ex / d, ny = ey / d
        const rel = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny
        const push = (2 * r - d) / 2
        p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push
        if (rel > 0) { p.vx -= rel * nx; p.vy -= rel * ny; q.vx += rel * nx; q.vy += rel * ny }
      }
    }
  }
}
ctx.fillStyle = colors.bg
ctx.fillRect(0, 0, w, h)
ctx.strokeStyle = colors.border
ctx.lineWidth = 1.5
ctx.strokeRect(0.75, 0.75, w - 1.5, h - 1.5)
for (const p of B) {
  const v = Math.min(1, Math.hypot(p.vx, p.vy) / (180 * Math.max(0.3, params.heat)))
  ctx.fillStyle = v > 0.66 ? colors.warn : v > 0.33 ? colors.good : colors.accent
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fill()
}
