// One world and 60 s of writing: the memory scene plays it and replays it.
import { build, run } from "./mol.js"

const style = `
molecule(
  world.look.gloss("#5b7fd6"),
  world.look.gloss("#e8e4da"),
  world.look.gloss("#9aa3b5")
)
`

const w = world(build + style + run, { center: [0, 0], size: [420, 420], name: "molecule" })
await draw(w, 1)
for (let i = 0; i < 59; i++) {
  const x = i % 2 ? 270 : -560
  await draw(write(`line ${i + 1}`, { at: [x, -280 + (i % 28) * 20], size: 18 }), 1)
}
