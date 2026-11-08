// Queue, part B: sent while A plays; it starts when A ends, finds A's ball by its name and moves it.
const ball = board.node('ball')
step('roll')
await move(ball, { by: [300, 0] }, 1.5)
const mark = write('rolled', { at: [ball.center[0] - 40, ball.center[1] + 80], color: 'good' })
await draw(mark, 0.8)
