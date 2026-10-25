// Queue, part A: a ball and its name. Sent first; queue-b.js is sent right after it.
const v = board.view
const c = [v.x + v.width / 2 - 150, v.y + v.height / 2]
step('ball')
const ball = circle(c[0], c[1], 60, { fill: 'accent', fillOpacity: 0.35, color: 'accent', name: 'ball' })
await draw(ball, 1.2)
await draw(label(ball, 'ball', { side: 'above', color: 'accent' }), 0.6)
await wait(0.5)
