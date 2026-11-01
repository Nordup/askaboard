// Three worlds side by side, turning: the cost of worlds that take turns.
import { build, run } from "./mol.js"

const style = `
molecule(
  world.look.gloss("#5b7fd6"),
  world.look.gloss("#e8e4da"),
  world.look.gloss("#9aa3b5")
)
`

for (const x of [-390, 0, 390]) {
  const w = world(build + style + run, { center: [x, 0], size: [360, 360], name: `molecule ${x}` })
  await draw(w, 0.3)
}
