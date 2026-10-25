// Work on what is already on the board: the learner's ink group g1 (and g2 when present).
const g = board.node('g1')
console.log('g1 bounds', g.bounds)
step('look here')
const ring = around(g, { color: 'warn' })
await draw(ring, 0.9)
step('retrace')
await draw(g, 1.5)                                          // their strokes are drawn again, stroke by stroke
step('move it')
await move(group(g, ring), { by: [0, 80] }, 1)             // the learner's ink and the mark move together
await tween(g, { color: 'good' }, 0.6)
step('note')
const b = g.bounds
const note = write('nice!', { at: [b.x + b.width + 30, b.y], size: 26, color: 'good' })
await draw(note)
await wait(0.6)
await erase(ring, 0.6)
