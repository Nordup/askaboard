// Camera and pointer: the view glides to a detail, a pointer rests on it, the
// view pulls back. Also one live-pixels item with a parameter that changes.

const v = board.view
const cx = v.x + v.width / 2
const cy = v.y + v.height / 2

step('overview')
const left = circle(cx - 260, cy, 70, { color: 'accent', name: 'left circle' })
const right = rect(cx + 180, cy - 60, 160, 120, { color: 'good', radius: 12, name: 'right box' })
await all(draw(left, 0.8), draw(right, 0.8))
const tiny = write('look closely', { center: [cx + 260, cy], size: 10, color: 'warn' })
await draw(tiny, 0.6)

step('zoom in')
await camera({ fit: right, pad: 30 }, 1.2)
await point(tiny, 0.6)
await wait(0.8)
await point([cx + 200, cy - 40], 0.5)
await wait(0.4)

step('wave')
await camera({ to: [cx, cy + 40], zoom: 1 }, 1)
point(null, 0.3)
const wave = shader('void main(){ gl_FragColor = vec4(0.2, 0.3, 0.6, 1.0); }', { center: [cx, cy + 150], size: [240, 90], params: { k: 1 }, name: 'wave' })
await fadeIn(wave, 0.5)
await tween(wave, { params: { k: 4 } }, 2)
await point(wave, 0.5)
await wait(0.6)
