// Beat 4: a cylinder with a cone taken out; its slice at the same h is a ring of the same area.
const { R, base, h, cx2 } = stage
const cyl = rect(cx2 - R, base - R, 2 * R, R, { name: "cylinder" })
const cone = polygon([[cx2 - R, base - R], [cx2, base], [cx2 + R, base - R]], { color: "warn", dash: true, closed: false })
const y = () => base - h.get()
const ringL = line(cx2 - R, y, () => cx2 - h.get(), y, { color: "accent", width: 6 })
const ringR = line(() => cx2 + h.get(), y, cx2 + R, y, { color: "accent", width: 6 })
stage.cyl = cyl

say("Now take a cylinder [[cyl]] and hollow out a cone [[cone]]; at the same height its slice is a ring [[ring]] with exactly that area.")
await mark("cyl")
draw(cyl, 1)
await mark("cone")
draw(cone, 0.9)
await mark("ring")
draw(ringL, 0.4)
draw(ringR, 0.4)
await tween(h, 40, 1.4) // both slices move together: the disc of beat 2 and this ring
