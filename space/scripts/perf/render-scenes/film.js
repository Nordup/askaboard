import { show } from "./mol.js"

await show(`
world.look = "film"
molecule(world.look.gloss("#5b7fd6"), world.look.gloss("#e8e4da"), world.look.gloss("#9aa3b5"))
`)
