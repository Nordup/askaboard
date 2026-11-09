/**
 * The look of every world: flat bands of light and a thin ink line, in one pass to
 * an 8-bit target. An unlit material and a ShaderMaterial pass through it unchanged.
 *
 * Bands. A compile hook on Material swaps the fragment shader of the lit materials
 * (TOONED) while a world renders, so an agent's material objects stay as they are
 * and stay live. The light loop is three's: every light of the world adds to one
 * sum, and the sum falls into one of three bands.
 *
 * Ink. A back-face hull, pushed out in screen pixels by one shared material. A hook
 * on Mesh collects what three really draws, and the last object of the render list
 * draws the hulls. So the hulls sit in the same render call as the scene: they get
 * its anti-aliasing and its depth, with no pass of their own and no program change
 * per mesh. Line and Points are no Mesh, so they get none. Rigid meshes that share a
 * geometry share one instanced hull, which is one draw (inkBatches).
 *
 * What a world's code can change, from one value to all of it:
 * - world.look.shades, .steps, .soft, .outline, .ink, .see, and any light;
 * - world.look.fragment: another fragment shader for all its toon materials;
 * - material.onBeforeCompile: it runs after this hook and sees the toon shader;
 * - material.userData.toon = false: three's own shader for that material, no ink;
 * - a ShaderMaterial: this file does not touch it.
 */
export const TOON = String.raw`
  const TOON_LOOK = {
    /** Brightness of the shade, middle and lit band; the light levels between them; half the width of a step. */
    shades: [0.56, 0.78, 1], steps: [0.4, 0.62], soft: 0.012,
    /** Ink: width in CSS pixels, 0 for none, and colour. see: the opacity of a material with transmission. */
    outline: 1.2, ink: '#efeadf', see: 0.32, fragment: null
  };
  /** The two lights of the look. The hemisphere and the key sum to about 1 where a surface faces the light. */
  const TOON_KEY = 1.5, TOON_SKY = '#ffffff', TOON_GROUND = '#8d8d96', TOON_FILL = 1.15;
  const TOONED = { MeshStandardMaterial: 1, MeshPhysicalMaterial: 1, MeshLambertMaterial: 1, MeshPhongMaterial: 1, MeshToonMaterial: 1 };

  const TOON_FRAGMENT = [
    '#undef STANDARD', '#undef USE_CLEARCOAT', '#undef USE_IRIDESCENCE',
    'uniform vec3 diffuse, emissive, toonShades; uniform vec2 toonSteps; uniform float opacity, toonSoft, toonGlass;',
    'varying vec3 vViewPosition;',
    '#include <common>', '#include <color_pars_fragment>', '#include <uv_pars_fragment>', '#include <map_pars_fragment>', '#include <alphamap_pars_fragment>',
    '#include <alphatest_pars_fragment>', '#include <alphahash_pars_fragment>', '#include <emissivemap_pars_fragment>', '#include <fog_pars_fragment>',
    '#include <bsdfs>', '#include <lights_pars_begin>', '#include <normal_pars_fragment>', '#include <bumpmap_pars_fragment>', '#include <normalmap_pars_fragment>',
    '#include <clipping_planes_pars_fragment>',
    'struct ToonLight { float unused; };',
    'void toonDirect(const in IncidentLight light, const in vec3 p, const in vec3 n, const in vec3 v, const in vec3 c, const in ToonLight m, inout ReflectedLight r) {',
    '  r.directDiffuse += saturate(dot(n, light.direction)) * light.color * RECIPROCAL_PI; }',
    'void toonIndirect(const in vec3 irradiance, const in vec3 p, const in vec3 n, const in vec3 v, const in vec3 c, const in ToonLight m, inout ReflectedLight r) {',
    '  r.indirectDiffuse += irradiance * RECIPROCAL_PI; }',
    '#define RE_Direct toonDirect',
    '#define RE_IndirectDiffuse toonIndirect',
    'float toonBand(float level) {',
    '  float low = smoothstep(toonSteps.x - toonSoft, toonSteps.x + toonSoft, level), high = smoothstep(toonSteps.y - toonSoft, toonSteps.y + toonSoft, level);',
    '  return mix(mix(toonShades.x, toonShades.y, low), toonShades.z, high); }',
    'void main() {',
    '  vec4 diffuseColor = vec4(diffuse, opacity);',
    '  #include <clipping_planes_fragment>',
    '  ReflectedLight reflectedLight = ReflectedLight(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0));',
    '  vec3 totalEmissiveRadiance = emissive;',
    '  ToonLight material;',
    '  #include <map_fragment>', '  #include <color_fragment>', '  #include <alphamap_fragment>', '  #include <alphatest_fragment>', '  #include <alphahash_fragment>',
    '  #include <normal_fragment_begin>', '  #include <normal_fragment_maps>', '  #include <emissivemap_fragment>',
    '  #include <lights_fragment_begin>', '  #include <lights_fragment_end>',
    '  #ifdef TOON_GLASS', '  diffuseColor.a *= toonGlass;', '  #endif',
    '  vec3 light = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
    '  float level = max(light.r, max(light.g, light.b));',
    // A glow keeps its hue: a flat bright colour, not a white one.
    '  float over = max(1.0, max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b)));',
    '  vec3 outgoingLight = diffuseColor.rgb * light / max(level, 1e-4) * toonBand(level) + totalEmissiveRadiance / over;',
    '  #include <opaque_fragment>', '  #include <colorspace_fragment>', '  #include <fog_fragment>', '  #include <premultiplied_alpha_fragment>',
    '}'
  ].join('\n');

  const INK_VERTEX = [
    '#undef FLIP_SIDED',
    'uniform vec2 inkWidth; attribute vec3 lsInk;',
    '#include <common>', '#include <batching_pars_vertex>', '#include <morphtarget_pars_vertex>', '#include <skinning_pars_vertex>',
    'void main() {',
    '  #include <morphinstance_vertex>', '  #include <batching_vertex>',
    '  #include <beginnormal_vertex>', '  objectNormal = lsInk;', '  #include <morphnormal_vertex>', '  #include <skinbase_vertex>', '  #include <skinnormal_vertex>', '  #include <defaultnormal_vertex>',
    '  #include <begin_vertex>', '  #include <morphtarget_vertex>', '  #include <skinning_vertex>', '  #include <project_vertex>',
    '  gl_Position.xy += normalize(transformedNormal.xy + vec2(1e-6, 0.0)) * inkWidth * gl_Position.w;',
    '}'
  ].join('\n');
  const INK_FRAGMENT = ['uniform vec3 inkColor; uniform float inkAlpha;', 'void main() { gl_FragColor = vec4(inkColor, inkAlpha);', '#include <colorspace_fragment>', '}'].join('\n');

  // The world that renders now, or null. Hooks read it, so everything else pays one check.
  let toonWorld = null, inkMaterial = null, inkGeometry = null;
  const inkQueue = [];

  const isToon = (m) => !!TOONED[m.type] && m.userData.toon !== false;

  /** One shadow of a plane is no line: a sheet of paper or a picture on a plane has no ink. */
  const hasBody = (g) => {
    if (g.userData.lsBody !== undefined) return g.userData.lsBody;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, x = b.max.x - b.min.x, y = b.max.y - b.min.y, z = b.max.z - b.min.z;
    return (g.userData.lsBody = Math.min(x, y, z) > 1e-4 * Math.max(x, y, z));
  };

  /**
   * The direction of each vertex's push: one per position, the mean of the faces that meet there. A hull that follows split
   * normals opens at a hard edge, and a box then has a gap at each corner. Once per geometry, and again when its size changes.
   */
  const weldInk = (g) => {
    const p = g.attributes.position, n = g.attributes.normal;
    if (!p || !n || !hasBody(g) || (g.attributes.lsInk && g.attributes.lsInk.count === p.count)) return;
    const b = g.boundingBox, q = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1e-9) * 1e-4;
    const sum = new Map(), keys = new Float64Array(p.count), out = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      // Grid cells of 1/10000 of the size: three numbers under 65536 fit one exact key.
      const key = Math.round((p.getX(i) - b.min.x) / q) + Math.round((p.getY(i) - b.min.y) / q) * 65536 + Math.round((p.getZ(i) - b.min.z) / q) * 4294967296;
      let at = sum.get(key);
      if (!at) sum.set(key, (at = [0, 0, 0]));
      at[0] += n.getX(i); at[1] += n.getY(i); at[2] += n.getZ(i);
      keys[i] = key;
    }
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = sum.get(keys[i]), length = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / length; out[i * 3 + 1] = y / length; out[i * 3 + 2] = z / length;
    }
    g.setAttribute('lsInk', new THREE.BufferAttribute(out, 3));
  };

  /** Meshes of one geometry from this count share one instanced draw of their hulls. */
  const INK_BATCH = 2;
  /** The number of this render: a mesh with this number has its hull in a batch. */
  let inkRender = 0;
  const inkFull = () => {
    const u = inkMaterial.uniforms.inkAlpha;
    if (u.value !== 1) { u.value = 1; inkMaterial.uniformsNeedUpdate = true; }
  };
  /**
   * The batch of a geometry, in the world's stage. three uploads an instance matrix when it walks the scene, so a batch is an object of the scene,
   * and the walk of the look finds its meshes before that. Its matrix stays the identity: its instances hold world matrices.
   */
  const inkBatch = (w, geometry, n) => {
    let batch = w.inkBatches.get(geometry);
    if (batch && batch.instanceMatrix.count < n) { w.inkGroup.remove(batch); batch.dispose(); batch = null; }
    if (!batch) {
      batch = new THREE.InstancedMesh(geometry, inkMaterial, Math.ceil(n * 1.5));
      batch.frustumCulled = false;
      batch.renderOrder = 1e9;
      batch.matrixAutoUpdate = false;
      batch.matrixWorldAutoUpdate = false;
      batch.onBeforeRender = inkFull;
      w.inkGroup.add(batch);
      w.inkBatches.set(geometry, batch);
    }
    return batch;
  };
  /** A mesh whose hull fits a batch: rigid, one material, in full opacity, with no mirror in its matrix and no hook of its own on the render. */
  const inkRigid = (o, camera) => {
    const m = o.material;
    return !o.isInstancedMesh && !o.isSkinnedMesh && !o.morphTargetInfluences && !Array.isArray(m) && isToon(m) && m.visible && m.depthWrite && !!o.geometry.attributes.lsInk
      && (!m.transparent || m.opacity === 1) && o.onBeforeRender === THREE.Mesh.prototype.onBeforeRender && o.layers.test(camera.layers) && o.matrixWorld.determinant() > 0;
  };
  /** Before a render: every mesh that shows gets its ink directions, and meshes that share a geometry get their batch. */
  const gatherInk = (w, camera) => {
    const lists = w.inkLists;
    for (const list of lists.values()) list.length = 0;
    const walk = (o) => {
      if (!o.visible || o === w.inkPass || o === w.inkGroup) return;
      if (o.isMesh) {
        weldInk(o.geometry);
        if (inkRigid(o, camera)) {
          let list = lists.get(o.geometry);
          if (!list) lists.set(o.geometry, (list = []));
          list.push(o);
        }
      }
      for (const child of o.children) walk(child);
    };
    walk(w.scene);
    inkRender++;
    for (const [geometry, list] of lists) {
      const n = list.length;
      if (n < INK_BATCH) {
        const old = w.inkBatches.get(geometry);
        if (old) old.visible = false;
        if (!n) {
          if (old) { w.inkGroup.remove(old); old.dispose(); w.inkBatches.delete(geometry); }
          lists.delete(geometry);
        }
        continue;
      }
      const batch = inkBatch(w, geometry, n), matrices = batch.instanceMatrix, out = matrices.array;
      // Nothing that moved means no upload, and an upload takes only the instances in use.
      let moved = batch.count !== n || !batch.lsInkFilled;
      for (let i = 0, k = 0; i < n; i++, k += 16) {
        const e = list[i].matrixWorld.elements;
        // out holds floats and e holds doubles: only the rounded number can match.
        for (let j = 0; j < 16; j++) {
          const v = Math.fround(e[j]);
          if (out[k + j] !== v) { out[k + j] = v; moved = true; }
        }
        list[i].lsInkRender = inkRender;
      }
      batch.count = n;
      batch.visible = true;
      if (moved) {
        batch.lsInkFilled = true;
        matrices.clearUpdateRanges();
        matrices.addUpdateRange(0, n * 16);
        matrices.needsUpdate = true;
      }
    }
  };

  const drawInk = (r, scene, camera) => {
    const u = inkMaterial.uniforms;
    for (let i = 0; i < inkQueue.length; i += 4) {
      const m = inkQueue[i + 3], alpha = m.transparent ? m.opacity : 1;
      if (alpha !== u.inkAlpha.value) { u.inkAlpha.value = alpha; inkMaterial.uniformsNeedUpdate = true; }
      r.renderBufferDirect(camera, scene, inkQueue[i + 1], inkMaterial, inkQueue[i], inkQueue[i + 2]);
    }
    inkQueue.length = 0;
  };

  /** The last object of a world's render list: it draws the hulls. */
  const inkPass = () => {
    const pass = new THREE.Mesh(inkGeometry, inkMaterial);
    pass.frustumCulled = false;
    pass.renderOrder = 1e9;
    pass.onBeforeRender = drawInk;
    return pass;
  };

  /** Once, when three is here. The hooks live on the prototypes, so they reach every material and mesh of every world. */
  const makeToon = () => {
    const material = THREE.Material.prototype, physical = THREE.MeshPhysicalMaterial.prototype;
    const compile = function (shader, r) {
      if (toonWorld && isToon(this)) {
        const u = toonWorld.toonUniforms, look = toonWorld.look;
        shader.fragmentShader = (this.isMeshPhysicalMaterial && glassOf(this) ? '#define TOON_GLASS\n' : '') + (look.fragment || TOON_FRAGMENT);
        Object.assign(shader.uniforms, u);
      }
      if (this.lsCompile) this.lsCompile(shader, r);
    };
    // A world's own hook stays in an own field, so picture.ts still sees it, and it runs after the toon shader is in.
    Object.defineProperty(material, 'onBeforeCompile', { configurable: true, get() { return compile; }, set(fn) { this.lsCompile = fn; } });
    material.customProgramCacheKey = function () {
      const own = this.lsCompile ? this.lsCompile.toString() : '';
      if (!toonWorld || !isToon(this)) return own;
      return 'toon' + (this.isMeshPhysicalMaterial && glassOf(this) ? ' glass ' : ' ') + (toonWorld.look.fragment || '') + own;
    };
    // Glass in this look is a plain see-through surface: three sees no transmission, so it runs no transmission pass.
    const transmission = Object.getOwnPropertyDescriptor(physical, 'transmission');
    const glassOf = (m) => transmission.get.call(m) > 0;
    Object.defineProperty(physical, 'transmission', { configurable: true, set: transmission.set, get() { return toonWorld && isToon(this) ? 0 : transmission.get.call(this); } });
    Object.defineProperty(physical, 'transparent', { configurable: true, set(v) { this._transparent = v; }, get() { return this._transparent || (!!toonWorld && isToon(this) && glassOf(this)); } });

    THREE.Mesh.prototype.onBeforeRender = function (r, scene, camera, geometry, m, group) {
      if (toonWorld && toonWorld.inkOn && isToon(m) && m.depthWrite && geometry.attributes.lsInk && this.lsInkRender !== inkRender) inkQueue.push(this, geometry, group, m);
    };
    inkMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, toneMapped: false, vertexShader: INK_VERTEX, fragmentShader: INK_FRAGMENT,
      uniforms: { inkWidth: { value: new THREE.Vector2() }, inkColor: { value: new THREE.Color() }, inkAlpha: { value: 1 } }
    });
    inkGeometry = new THREE.BufferGeometry();
    inkGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    inkGeometry.setDrawRange(0, 0);
    commonParts.add(inkMaterial).add(inkGeometry);
  };

  /** The world's parts of the look. */
  const dressToon = (w) => {
    const hemi = new THREE.HemisphereLight(TOON_SKY, TOON_GROUND, TOON_FILL);
    const pass = inkPass(), batches = new THREE.Group();
    w.stage.add(hemi, pass, batches);
    w.inkPass = pass;
    w.inkGroup = batches;
    w.inkBatches = new Map();
    w.inkLists = new Map();
    w.toonFragment = TOON_LOOK.fragment;
    w.toonUniforms = { toonShades: { value: new THREE.Vector3() }, toonSteps: { value: new THREE.Vector2() }, toonSoft: { value: 0 }, toonGlass: { value: 1 } };
  };

  /**
   * A program belongs to a look.fragment and a material keeps the uniforms of its last compile, and three skips the compile hook for a program it has.
   * So a change of look.fragment frees these programs, and each material compiles again through the hook.
   */
  const recompileToon = (w) => {
    w.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) if (TOONED[m.type]) m.dispose(); });
  };

  /** Before a render. W, H: the target. px: device pixels per CSS pixel of the target. light: the light environment (ground.ts): other shades, no ink. */
  const beginToon = (w, look, W, H, px, light) => {
    const u = w.toonUniforms, ink = inkMaterial.uniforms, width = look.outline * px, inked = look.outline > 0 && !light;
    if (light) lightShades(look.shades, u.toonShades.value); else u.toonShades.value.fromArray(look.shades);
    u.toonSteps.value.fromArray(look.steps);
    u.toonSoft.value = look.soft;
    u.toonGlass.value = look.see;
    if (w.toonFragment !== look.fragment) { w.toonFragment = look.fragment; recompileToon(w); }
    ink.inkWidth.value.set((2 * width) / W, (2 * width) / H);
    ink.inkColor.value.set(look.ink);
    ink.inkAlpha.value = 1;
    w.inkOn = inked;
    w.inkPass.visible = w.inkGroup.visible = inked;
    // Before the render: three uploads a geometry's buffers when it walks the scene.
    if (inked) gatherInk(w, w.camera);
    toonWorld = w;
  };
  const endToon = () => { toonWorld = null; inkQueue.length = 0; };
`
