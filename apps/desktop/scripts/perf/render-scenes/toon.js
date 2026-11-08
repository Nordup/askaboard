import { show } from "./mol.js"

await show(`
molecule(
  new THREE.MeshStandardMaterial({ color: "#5b7fd6" }),
  new THREE.MeshStandardMaterial({ color: "#e8e4da" }),
  new THREE.MeshStandardMaterial({ color: "#9aa3b5" })
)
`)
