// A point turns around a circle; its height traces a sine wave (values, trace,
// a changing plot and changing typeset maths).
const v = board.view
const c = [v.x + v.width / 2 - 260, v.y + v.height / 2]
const R = 70
const angle = value(0)
const px = () => c[0] + R * Math.cos(angle.get())
const py = () => c[1] - R * Math.sin(angle.get())
step('circle')
await draw(circle(c[0], c[1], R, { color: 'muted', width: 2 }), 0.8)
const dot = circle(px, py, 6, { fill: 'accent', color: 'accent' })
const spoke = line(c[0], c[1], px, py, { color: 'accent', width: 2 })
await all(fadeIn(dot, 0.3), draw(spoke, 0.3))
const x0 = c[0] + R + 40
const wave = trace(() => [x0 + angle.get() * 40, py()], { color: 'warn', width: 3 })
const link = line(px, py, () => x0 + angle.get() * 40, py, { color: 'muted', width: 1.5, dash: [4, 4] })
const readout = tex(() => `\\theta = ${(angle.get() / Math.PI).toFixed(2)}\\pi`, { at: [c[0] - 60, c[1] + R + 30], size: 26 })
const amp = value(1)
const model = plot((x) => amp.get() * Math.sin(x), { at: [x0, c[1]], unit: [40, R], x: [0, 4 * Math.PI], color: 'good', width: 1.5, dash: [6, 6], opacity: 0.6 })
step('turn')
say('Turn the point. Its height draws a sine wave.')
fadeIn(link, 0.3)
fadeIn(readout, 0.3)
await tween(angle, 4 * Math.PI, 8, )
step('stretch')
await draw(model, 0.8)
await tween(amp, 0.5, 1.5)
await tween(amp, 1, 1.5)
await draw(label(wave, 'sin θ', { at: 0.35, color: 'warn' }), 0.6)
