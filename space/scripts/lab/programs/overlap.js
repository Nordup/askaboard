// A deliberate overlap: text written across a circle's outline (for the warning check).
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2]
const ring = circle(c[0], c[1], 80, { color: 'accent' })
await draw(ring, 0.8)
await draw(write('crossing the line', { at: [c[0] + 40, c[1] - 12], size: 24 }), 1)
await draw(write('far away', { at: [c[0] + 5000, c[1]], size: 24 }), 0.5)
