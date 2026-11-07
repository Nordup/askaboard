// Why the sky is blue: sunlight, air molecules, scattering, your eye.
const RED = "#ff6b5b", GREEN = "#7bd88f", BLUE = "#5aa9ff", SUN = "#ffd25a"
const GROUND = 320, EYE = [0, 258]

function wave(x0, x1, yc, len, amp, o) {
  const pts = []
  for (let x = x0; x <= x1; x += 2) pts.push([x, yc + amp * Math.sin((x - x0) / len * 2 * Math.PI)])
  return polygon(pts, { closed: false, width: 3, ...o })
}

// sky wash, made first so it sits at the back
const wash = rect(-610, -440, 1220, GROUND + 440, { fill: BLUE, fillOpacity: 0.13, width: 0 })

// 1. sunlight is a mix of waves
const sun = circle(-490, 0, 46, { fill: SUN, color: SUN, width: 2 })
const inR = wave(-430, -26, -16, 62, 8, { color: RED })
const inG = wave(-430, -26, 0, 44, 8, { color: GREEN })
const inB = wave(-430, -26, 16, 26, 8, { color: BLUE })

await say("Sunlight looks white, but it is a mix of every colour.", { during: fillIn(sun, 1) })
say("Each colour is a wave. Red light has [[r]] long waves, blue light has [[b]] short ones.")
await mark("r"); draw(inR, 2.2); draw(inG, 2.2)
await mark("b"); await draw(inB, 2.2)

// 2. the air
step("air")
const mol = group(circle(-6, 0, 8, { fill: "#e8e8e8", width: 0 }), circle(7, 0, 8, { fill: "#e8e8e8", width: 0 }))
const dots = []
let seed = 0
const rnd = () => (Math.sin(++seed * 91.7) * 43758.5) % 1
const spots = []
while (spots.length < 22) {
  const x = -380 + Math.abs(rnd()) * 940, y = -170 + Math.abs(rnd()) * 400
  if (Math.abs(y) < 50) continue
  if (y > 190 && Math.abs(x) < 70) continue
  if (x > 225 && y < -100) continue
  if (spots.some(p => Math.hypot(p[0] - x, p[1] - y) < 80)) continue
  spots.push([x, y])
}
for (const [x, y] of spots) dots.push(circle(x, y, 5, { fill: "#cfcfcf", width: 0, opacity: 0.55 }))
await say("The air is made of tiny molecules of nitrogen and oxygen, far smaller than one light wave.", {
  during: (async () => { await fadeIn(mol, 0.6); await all(...dots.map(d => fadeIn(d, 1.2))) })()
})
await wait(0.3)

// 3. scattering: blue is shaken off in all directions, red goes on
step("scatter")
const angles = [-150, -110, -70, -30, 30, 150, 60, 120]
const blueRays = angles.map(a => {
  const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180)
  return arrow(22 * c, 22 * s, 100 * c, 100 * s, { color: BLUE, width: 3, head: 10 })
})
const redRays = angles.map(a => {
  const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180)
  return arrow(22 * c, 22 * s, 42 * c, 42 * s, { color: RED, width: 2, head: 6, opacity: 0.6 })
})
const outR = wave(26, 560, -16, 62, 8, { color: RED })
const outG = wave(26, 560, 0, 44, 8, { color: GREEN, opacity: 0.7 })
const outB = wave(26, 560, 16, 26, 8, { color: BLUE, opacity: 0.28 })
await say("When a wave passes a molecule, it makes the molecule's electrons shake, and the molecule throws a little of that light off in every direction.", {
  during: tween(mol, { scale: 1.25 }, 0.4)
})
await tween(mol, { scale: 1 }, 0.3)
await say("Short blue waves shake it much harder: blue is thrown off about five times more than red.", {
  during: all(...blueRays.map(r => draw(r, 1.4)), ...redRays.map(r => draw(r, 1.4)))
})
await say("So most of the red goes straight on, while the blue gets spread around the sky.", {
  during: all(draw(outR, 2.5), draw(outG, 2.5), draw(outB, 2.5))
})
await wait(0.4)

// 4. you, looking up
step("your eye")
const ground = line(-600, GROUND, 600, GROUND, { color: "#8a8a8a", width: 2 })
const head = circle(EYE[0], EYE[1] + 6, 12, { width: 2.5 })
const body = polygon([[0, 276], [0, 300]], { closed: false, width: 2.5 })
const legs = polygon([[-11, GROUND], [0, 300], [11, GROUND]], { closed: false, width: 2.5 })
const arms = polygon([[-13, 296], [0, 284], [13, 296]], { closed: false, width: 2.5 })
const toEye = arrow(0, 24, 0, 238, { color: BLUE, width: 4, head: 12 })
await say("Now you, standing here, looking up at this patch of sky, away from the Sun.", {
  during: (async () => { await draw(ground, 0.8); await draw(head, 0.4); await all(draw(body, 0.3), draw(arms, 0.3), draw(legs, 0.3)) })()
})
await say("No sunlight comes straight at you from there. What reaches your eye is only the light the air threw sideways, and that is mostly blue.", {
  during: draw(toEye, 2)
})
await wait(0.3)

// 5. every molecule does it
step("whole sky")
const rays = spots.map(([x, y]) => {
  const dx = EYE[0] - x, dy = EYE[1] - y, d = Math.hypot(dx, dy)
  return line(x + dx / d * 9, y + dy / d * 9, EYE[0] - dx / d * 22, EYE[1] - dy / d * 22, { color: BLUE, width: 1.5, opacity: 0.55 })
})
await say("Every molecule in the air does the same, so wherever you look, blue light comes at you from all over the sky.", {
  during: all(...rays.map(r => draw(r, 2.2)), ...spots.map(([x, y]) => fadeIn(circle(x, y, 5, { fill: BLUE, width: 0 }), 1.5)))
})
await say("That is the blue of the sky: sunlight, sorted by the air.", { during: fadeIn(wash, 2) })
