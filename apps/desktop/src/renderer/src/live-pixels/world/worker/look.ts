/**
 * What one world renders with: its stage, and one render call into its private
 * output. The look itself, the only one, is in toon.ts.
 */
export const LOOK = String.raw`
  /** The world whose render runs now. A failure in it belongs to this world. */
  let rendering = null;
  /** The world whose scene three walks now. What goes to the GPU in that walk belongs to this world. */
  let holding = null;
  /** The runtime's own parts: a render meets them too, and no world owns them. */
  const commonParts = new Set();
  const owners = new WeakMap();
  /**
   * Who owns what is on the GPU. three listens for 'dispose' on all it allocates, geometry, material, texture, render target, at the first use.
   * So that listener marks each resource once, also one that a world made and took out of its scene later, and nothing else needs a scan.
   * When a resource goes while another world still draws it, three uploads it again for that world, and that world then owns it.
   */
  const watchResources = () => {
    const dispatcher = THREE.EventDispatcher.prototype, on = dispatcher.addEventListener, send = dispatcher.dispatchEvent;
    dispatcher.addEventListener = function (type, fn) {
      if (type === 'dispose' && holding && !owners.has(this) && !commonParts.has(this)) { owners.set(this, holding); holding.held.add(this); }
      return on.call(this, type, fn);
    };
    // Only the event itself says that a resource left the GPU. A listener can leave with no disposal.
    dispatcher.dispatchEvent = function (event) {
      const w = event.type === 'dispose' ? owners.get(this) : null;
      if (w) { owners.delete(this); w.held.delete(this); }
      return send.call(this, event);
    };
  };
  const drawWorld = (w, camera) => {
    holding = w;
    try { renderer.render(w.scene, camera); } finally { holding = null; }
  };
  /** The programs that a render of w with this state needs. three starts them and does not wait. */
  const compileWorld = (w, camera) => {
    holding = w;
    try { return renderer.compile(w.scene, camera); } finally { holding = null; }
  };
  /** The measuring switches (SPACE_WORLD_TUNE), read once at boot. */
  let tune = {};

  const materials = {
    gloss: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12, ...x }),
    metal: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.22, metalness: 1, ...x }),
    glass: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.05, metalness: 0, transmission: 1, thickness: 0.6, ior: 1.45, ...x }),
    glow: (c, p = 3, x = {}) => new THREE.MeshStandardMaterial({ color: '#000', emissive: c, emissiveIntensity: p, roughness: 0.4, ...x }),
    skin: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.48, metalness: 0, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(c).lerp(new THREE.Color('#fff'), 0.6), clearcoat: 0.35, clearcoatRoughness: 0.4, ...x })
  };

  /** A world's stage: its scene, camera and lights. World code changes any of it. */
  const dressWorld = (w) => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    const camera = new THREE.PerspectiveCamera(24, w.w / w.h, 0.1, 400);
    camera.position.set(5, 2.2, 9);
    camera.lookAt(0, 0, 0);

    const key = new THREE.DirectionalLight('#ffffff', TOON_KEY);
    key.position.set(4, 10, 5);
    const stage = new THREE.Group();
    stage.add(key, key.target);
    scene.add(stage);

    Object.assign(w, { scene, root, camera, stage, floorY: 0, held: new Set() });
    w.look = Object.assign({ key }, materials, TOON_LOOK, { shades: [...TOON_LOOK.shades], steps: [...TOON_LOOK.steps] });
    dressToon(w);
  };

  /** Free what a world holds on the GPU, by owner: also what left its scene before this. The pool's targets and the common parts stay. */
  const undressWorld = (w) => {
    w.scene.traverse((o) => {
      if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
      if (o.isLight && o.dispose) o.dispose();
    });
    for (const resource of [...w.held]) {
      // A render target frees its own textures.
      if (resource.isRenderTargetTexture) continue;
      if (resource.dispose) resource.dispose(); else resource.dispatchEvent({ type: 'dispose' });
    }
    w.held.clear();
    if (w.output) { giveOutput(w.output); w.output = null; }
    w.drawn = null;
  };

  /** world.look = an object of changes. There is one look: saved code can name another, so a string does nothing, and neither does an unknown key. */
  const setLook = (w, value) => {
    if (!value || typeof value !== 'object') return;
    Object.assign(w.look, value);
    w.stale = true;
  };

  /**
   * Render world w at scale s for a crop into output. inkScale: pixels of the target per unit of look.outline, at full resolution. Sets all renderer state
   * that it needs and restores it. compileOnly: draw nothing, start the programs of this state, and return their materials.
   */
  const renderWorld = (w, s, crop, output, samples, inkScale, compileOnly) => {
    const camera = w.camera;
    rendering = w;
    // The output can be smaller than the crop (dynamic resolution).
    const W = output.useW, H = output.useH, res = W / (crop.r - crop.l);
    worldMatrices(w);
    const saved = { matrices: w.scene.matrixWorldAutoUpdate, target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha() };
    try {
      w.scene.matrixWorldAutoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      w.scene.environment = null;
      aimCamera(w, s, crop);
      beginGround(w, compileOnly);
      beginToon(w, w.look, W, H, inkScale * res, lightBoard);
      const target = samples ? multisampleTarget(W, H, samples) : output;
      renderer.setRenderTarget(target);
      if (compileOnly) return compileWorld(w, camera);
      drawWorld(w, camera);
      if (target !== output) copyPicture(target, output, W, H);
    } finally {
      endToon();
      rendering = null;
      w.scene.matrixWorldAutoUpdate = saved.matrices;
      renderer.setRenderTarget(saved.target);
      renderer.autoClear = saved.autoClear;
      renderer.setClearColor(0x000000, saved.alpha);
    }
  };
`
