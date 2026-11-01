import { show } from "./mol.js"

await show(`
molecule(
  world.look.gloss({ color: "#5b7fd6" }),
  world.look.gloss({ color: "#e8e4da" }),
  world.look.gloss({ color: "#9aa3b5" })
)
`)
