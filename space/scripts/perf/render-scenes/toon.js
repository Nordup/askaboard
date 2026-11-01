import { show } from "./mol.js"

await show(`
world.look = "plain"
studyLights()
const bands = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat)
bands.minFilter = THREE.NearestFilter
bands.magFilter = THREE.NearestFilter
bands.needsUpdate = true
molecule(
  new THREE.MeshToonMaterial({ color: "#5b7fd6", gradientMap: bands }),
  new THREE.MeshToonMaterial({ color: "#e8e4da", gradientMap: bands }),
  new THREE.MeshToonMaterial({ color: "#9aa3b5", gradientMap: bands })
)
hull("#efeadf")
`)
