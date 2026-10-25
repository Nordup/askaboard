// live: canvas  size: 560x340  params: speed=1 count=1400 swirl=1.4
// A flowing vector field: particles drift along v(x, y, t) and leave fading
// trails, so the streamlines appear by themselves. The field turns slowly with
// time. speed: how fast particles move, count: how many, swirl: how strongly
// the field curls around its vortices.
// The body of function (ctx, t, w, h, params, dt); `this` keeps state between
// frames; `colors` holds the board colour tokens.
const S = this
const n = Math.max(1, Math.round(params.count))
const W = ctx.canvas.width
if (!S.p || S.p.length !== n || S.W !== W) {
  S.W = W
  S.p = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, life: Math.random() * 200 }))
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, w, h)
}
// Fade the old trails.
ctx.globalAlpha = 0.06
ctx.fillStyle = colors.bg
ctx.fillRect(0, 0, w, h)
ctx.globalAlpha = 1

const field = (x, y) => {
  const u = (x / w) * 6, v = (y / h) * 4, s = t * 0.15
  // Rotating cells (from a stream function) plus a steady drift to the right.
  const vx = Math.sin(v * params.swirl + s) * Math.cos(u * 0.7 - s) + 0.6
  const vy = Math.cos(u * params.swirl - s * 1.3) * Math.sin(v * 0.8 + s)
  return [vx, vy]
}

const step = 60 * params.speed * Math.min(dt || 1 / 60, 0.05)
ctx.lineWidth = 1.1
ctx.lineCap = 'round'
for (const p of S.p) {
  const [vx, vy] = field(p.x, p.y)
  const nx = p.x + vx * step, ny = p.y + vy * step
  const fast = Math.min(1, Math.hypot(vx, vy) / 1.6)
  ctx.strokeStyle = fast > 0.55 ? colors.warn : colors.accent
  ctx.globalAlpha = 0.35 + 0.55 * fast
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(nx, ny)
  ctx.stroke()
  p.x = nx
  p.y = ny
  p.life -= 1
  if (p.x < 0 || p.x > w || p.y < 0 || p.y > h || p.life < 0) {
    p.x = Math.random() * w
    p.y = Math.random() * h
    p.life = 120 + Math.random() * 200
  }
}
ctx.globalAlpha = 1
