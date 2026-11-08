// The learner's ink group g4 is circled, then erased (the whole group goes).
const g = board.node('g4')
const ring = around(g, { color: 'bad' })
await draw(ring, 0.8)
say('Let us clear this and start again.')
await all(erase(g, 1), fadeOut(ring, 1))
