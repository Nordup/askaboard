import { show } from "./mol.js"

await show(`
world.look = "plain"
studyLights()
molecule(
  new THREE.MeshLambertMaterial({ color: "#5b7fd6" }),
  new THREE.MeshLambertMaterial({ color: "#e8e4da" }),
  new THREE.MeshLambertMaterial({ color: "#9aa3b5" })
)
`)
