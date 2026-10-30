/**
 * The look of a world: the port of the film look of
 * docs/learning-space/drafts/library-landscape-2026-10-31/proofs/3d/lib/film.js.
 * Environment light, ACES tone mapping, soft shadows, a floor that catches a soft
 * shadow and a fading reflection, bloom, a shallow depth of field. Each part can
 * change: world.look = "plain", world.look.bloom = 0, world.floor = false.
 *
 * The differences from film.js:
 * - One world renders into a private output with real alpha, and not to a canvas.
 *   So the tone mapping is in the last pass here, not in three's output stage.
 * - A world has no box, so nothing here fades at a rectangular edge. The floor
 *   fades by its distance from the world, in world space.
 * - Shared passes take pixels and not shares of the target, so the size of a
 *   target never changes the picture.
 */
export const LOOK = String.raw`
  const QUAD_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  const FILM = { name: 'film', exposure: 1, bloom: 0.26, threshold: 1.1, glowRadius: 0.32, dof: 0.5, shadows: true, shadow: 0.55, softness: 0.22, environment: 0.9, tone: true };
  const PLAIN = { name: 'plain', exposure: 1, bloom: 0, threshold: 1.1, glowRadius: 0.32, dof: 0, shadows: false, shadow: 0.55, softness: 0.22, environment: 0, tone: false };
  /** The scale the numbers of film.js were tuned at: 2 pixels per board point. */
  const FILM_SCALE = 2;
  /** The floor's shadow map: size, its widest blur as a mip level, the layer of what casts a shadow. */
  const SHADOW_SIZE = 1024, SHADOW_TOP_LOD = 7, SHADOW_LAYER = 5;

  function envScene() {
    // A dark film studio: big soft panels, a cold key, a warm rim, a low fill.
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0.004, 0.005, 0.009);
    const panel = (w, h, pos, col, power) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(power), side: THREE.DoubleSide }));
      m.position.set(...pos); m.lookAt(0, 0, 0); sc.add(m);
    };
    panel(9, 5, [2, 9, 3], '#dfe9ff', 16);      // overhead soft box
    panel(3, 9, [-10, 2, 3], '#6e8bff', 9);     // cold side
    panel(2.2, 10, [10, 1, -3], '#ffc9a0', 14); // warm rim
    panel(14, 1.2, [0, -5, 9], '#ffffff', 2.5); // low strip, a line in every gloss
    panel(2, 2, [0, 3, -10], '#ff6b8b', 5);     // a small accent behind
    return sc;
  }

  // The parts that all worlds share. Made once, when the renderer exists.
  let environment = null, UnrealBloomPass = null;
  let quadScene = null, quadCam = null, quad = null, dofMat = null, copyMat = null, finalMat = null, floorMask = null, heightMat = null;
  const noTone = () => ({ toneMapped: false, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending });

  const makeLook = () => {
    const pm = new THREE.PMREMGenerator(renderer);
    environment = pm.fromScene(envScene(), 0.03).texture;
    pm.dispose();
    quadScene = new THREE.Scene();
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    quad.frustumCulled = false;
    quadScene.add(quad);
    dofMat = new THREE.ShaderMaterial({ ...noTone(),
      uniforms: { tC: { value: null }, tD: { value: null }, focus: { value: 10 }, ap: { value: 0.5 }, near: { value: 0.1 }, far: { value: 400 }, px: { value: new THREE.Vector2() }, scale: { value: 1 } },
      vertexShader: QUAD_VS,
      fragmentShader: [
        '#include <packing>',
        'uniform sampler2D tC, tD; uniform float focus, ap, near, far, scale; uniform vec2 px; varying vec2 vUv;',
        'float coc(vec2 u){ float z = -perspectiveDepthToViewZ(texture2D(tD, u).x, near, far); return clamp(abs(z - focus) / focus * ap * 26.0, 0.0, 11.0) * scale; }',
        'void main(){ float c0 = coc(vUv); vec4 sum = texture2D(tC, vUv); float w = 1.0;',
        'if (c0 < 0.4 || ap <= 0.0) { gl_FragColor = sum; return; }',
        // Most of a crop is empty: a pixel with nothing near it needs no blur.
        'float e = 0.0; for (int i = 0; i < 6; i++) { float a = float(i) * 1.0472; e = max(e, 1.0 - texture2D(tD, vUv + vec2(cos(a), sin(a)) * 11.0 * scale * px).x); }',
        'if (sum.a == 0.0 && e == 0.0) { gl_FragColor = sum; return; }',
        'for (int i = 1; i < 26; i++) { float a = float(i) * 2.399963; float r = sqrt(float(i) / 26.0) * c0; vec2 u = vUv + vec2(cos(a), sin(a)) * r * px;',
        '  float k = smoothstep(r - 1.0, r + 0.5, coc(u) + 0.5); sum += texture2D(tC, u) * k; w += k; }',
        'gl_FragColor = sum / w; }'
      ].join('\n')
    });
    copyMat = new THREE.ShaderMaterial({ ...noTone(), uniforms: { t: { value: null } }, vertexShader: QUAD_VS, fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }' });
    // The last pass: tone mapping, sRGB, premultiplied output with real alpha. The glow keeps its own alpha, so it joins any board.
    finalMat = new THREE.ShaderMaterial({ ...noTone(),
      uniforms: { tA: { value: null }, tB: { value: null }, seed: { value: 0 }, toneMappingExposure: { value: 1 }, tone: { value: 1 } },
      vertexShader: QUAD_VS,
      fragmentShader: [
        '#include <tonemapping_pars_fragment>',
        'uniform sampler2D tA, tB; uniform float seed, tone; varying vec2 vUv;',
        'float n(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }',
        'vec3 tm(vec3 c){ vec3 v = max(c, vec3(0.0)); v = tone > 0.5 ? ACESFilmicToneMapping(v) : clamp(v, 0.0, 1.0);',
        ' return sRGBTransferOETF(vec4(v, 1.0)).rgb; }',
        'void main(){ vec4 a = texture2D(tA, vUv); vec3 all3 = texture2D(tB, vUv).rgb;',
        'float al = clamp(a.a, 0.0, 1.0); vec3 S = al > 0.002 ? a.rgb / al : vec3(0.0);',
        'vec3 G = max(all3 - a.rgb, vec3(0.0));',
        'vec3 sc = tm(S) * al; vec3 gl = tm(G) * (1.0 - al);',
        'vec3 c = sc + gl + (n(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.002, al + gl.r + gl.g + gl.b);',
        'float g = max(gl.r, max(gl.g, gl.b)); gl_FragColor = vec4(max(c, vec3(0.0)), clamp(al + g * (1.0 - al), 0.0, 1.0)); }'
      ].join('\n')
    });
    // What casts a shadow on the floor, seen from under the floor along the light.
    // Red is coverage and green is coverage times height. Mips average both, so any mip gives a blurred shadow and the mean height over a point.
    heightMat = new THREE.ShaderMaterial({ toneMapped: false, side: THREE.DoubleSide, blending: THREE.NoBlending,
      uniforms: { floorY: { value: 0 } },
      vertexShader: 'uniform float floorY; varying float vH; void main(){ vec4 p = vec4(position, 1.0);\n#ifdef USE_INSTANCING\n p = instanceMatrix * p;\n#endif\n p = modelMatrix * p; vH = max(p.y - floorY, 0.0); gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: 'varying float vH; void main(){ gl_FragColor = vec4(1.0, vH, 0.0, 1.0); }'
    });
    // The floor's fade with distance from the world: long, with no end you can see.
    const c = new OffscreenCanvas(512, 512), g = c.getContext('2d');
    const r = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    for (const [p, col] of [[0, '#fff'], [0.55, '#aaa'], [1, '#000']]) r.addColorStop(p, col);
    g.fillStyle = r; g.fillRect(0, 0, 512, 512);
    floorMask = new THREE.CanvasTexture(c);
  };

  const pass = (mat, target) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(quadScene, quadCam);
  };

  const materials = {
    gloss: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12, ...x }),
    metal: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.22, metalness: 1, ...x }),
    glass: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.05, metalness: 0, transmission: 1, thickness: 0.6, ior: 1.45, ...x }),
    glow: (c, p = 3, x = {}) => new THREE.MeshStandardMaterial({ color: '#000', emissive: c, emissiveIntensity: p, roughness: 0.4, ...x }),
    skin: (c, x = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.48, metalness: 0, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(c).lerp(new THREE.Color('#fff'), 0.6), clearcoat: 0.35, clearcoatRoughness: 0.4, ...x })
  };

  /** A world's stage: its scene, camera, lights and floor. World code changes any of it. */
  const dressWorld = (w) => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    const camera = new THREE.PerspectiveCamera(24, w.w / w.h, 0.1, 400);
    camera.position.set(5, 2.2, 9);
    camera.lookAt(0, 0, 0);

    const key = new THREE.DirectionalLight('#e8efff', 2.6);
    key.position.set(4, 10, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 7; key.shadow.blurSamples = 20; key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
    const rim = new THREE.DirectionalLight('#ffd0ae', 1.4);
    rim.position.set(-6, 3, -7);

    // The floor: a black mirror that fades out, plus soft shadow. Nothing past its fade, so the board shows.
    const reflection = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { tR: { value: null }, tD: { value: null }, tM: { value: floorMask }, amount: { value: 0.3 }, spread: { value: new THREE.Vector2() }, toWorld: { value: new THREE.Matrix4() }, floorY: { value: 0 }, fadeH: { value: 1 } },
      vertexShader: 'varying vec2 vUv; varying vec4 vC; void main(){ vUv = uv; vC = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = vC; }',
      fragmentShader: [
        'uniform sampler2D tR, tD, tM; uniform float amount, floorY, fadeH; uniform vec2 spread; uniform mat4 toWorld; varying vec2 vUv; varying vec4 vC;',
        // The mirror image fades with its height above the floor: the far part of an object leaves no end you can see.
        'float fade(vec2 u){ vec4 p = toWorld * vec4(u * 2.0 - 1.0, texture2D(tD, u).x * 2.0 - 1.0, 1.0); float h = max(0.0, floorY - p.y / p.w) / fadeH; return exp(-h * h * 2.2); }',
        'void main(){ vec2 s = vC.xy / vC.w * 0.5 + 0.5; vec3 c = vec3(0.0); float tot = 0.0;',
        'for (int i = 0; i < 14; i++) { float a = float(i) * 2.399963; float r = sqrt(float(i) / 14.0); vec2 d = vec2(cos(a), sin(a)) * r * spread; vec2 u = s + d;',
        '  c += min(texture2D(tR, u).rgb, vec3(2.0)) * fade(u); tot += 1.0; }',
        'c = c / tot * texture2D(tM, vUv).r * amount; float m = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c, min(m, 1.0)); }'
      ].join('\n')
    });
    const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 96), reflection);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = 0.001;
    const catcher = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: { tS: { value: null }, toLight: { value: new THREE.Matrix4() }, texel: { value: 1 }, soft: { value: 0.2 }, opacity: { value: 0.55 } },
      vertexShader: 'varying vec3 vW; varying float vR; void main(){ vR = length(position.xy); vec4 p = modelMatrix * vec4(position, 1.0); vW = p.xyz; gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: [
        'uniform sampler2D tS; uniform mat4 toLight; uniform float texel, soft, opacity; varying vec3 vW; varying float vR;',
        'float lodOf(vec4 m){ return clamp(log2(max(m.g / m.r * soft, 1e-5) / texel), 1.0, ' + SHADOW_TOP_LOD.toFixed(1) + '); }',
        'void main(){ vec2 uv = (toLight * vec4(vW, 1.0)).xy * 0.5 + 0.5;',
        // The mean height of what stands over this point, then the blur that this height gives: the shadow is sharp at contact and wide far from it.
        'vec4 m = textureLod(tS, uv, ' + SHADOW_TOP_LOD.toFixed(1) + '); if (m.r < 1e-4) discard;',
        'float lod = lodOf(m); m = textureLod(tS, uv, lod); if (m.r > 1e-3) lod = min(lod, lodOf(m));',
        'float r = texel * pow(2.0, lod) * 0.7, c = 0.0;',
        'for (int i = 0; i < 8; i++) { float a = float(i) * 2.399963; c += textureLod(tS, uv + vec2(cos(a), sin(a)) * r * sqrt((float(i) + 0.5) / 8.0), lod).r; }',
        'gl_FragColor = vec4(0.0, 0.0, 0.0, opacity * c / 8.0 * (1.0 - smoothstep(0.45, 1.0, vR))); }'
      ].join('\n')
    });
    const shadowMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 96), catcher);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.renderOrder = -1;
    const lightView = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    lightView.layers.set(SHADOW_LAYER);
    const stage = new THREE.Group();
    const floorGroup = new THREE.Group();
    floorGroup.add(shadowMesh, floorMesh);
    stage.add(key, key.target, rim, floorGroup);
    scene.add(stage);

    Object.assign(w, { scene, root, camera, stage, keyLight: key, rimLight: rim, floorGroup, floorMesh, reflection, catcher, lightView, bounds: new THREE.Box3(), floorY: 0, lightSlope: new THREE.Vector2() });
    w.look = Object.assign({ key, rim }, FILM, materials);
    w.floor = true;
  };

  const undressWorld = (w) => {
    const seen = new Set();
    w.scene.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      for (const m of [].concat(o.material || [])) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const value of Object.values(m)) if (value && value.isTexture && value !== floorMask && value !== environment) value.dispose();
        m.dispose();
      }
      if (o.isInstancedMesh) o.dispose();
    });
    if (w.keyLight.shadow && w.keyLight.shadow.map) w.keyLight.shadow.map.dispose();
    if (w.output) { giveOutput(w.output); w.output = null; }
  };

  /** world.look = "plain", "film", or an object of changes. */
  const setLook = (w, value) => {
    if (value === 'plain') Object.assign(w.look, PLAIN);
    else if (value === 'film') Object.assign(w.look, FILM);
    else if (value && typeof value === 'object') Object.assign(w.look, value);
    else throw new Error('world.look: "film", "plain", or an object of changes');
    if (value === 'plain') w.floor = false;
    w.stale = true;
  };
  /** world.floor = false, true, or an object: y, the height of the floor. */
  const setFloor = (w, value) => {
    w.floor = value;
    w.floorBuilt = false;
    w.stale = true;
  };
  const floorOn = (w) => !!w.floor;

  /** Fit the floor and the key light to the world, as film.js does once. */
  const buildFloor = (w, box) => {
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() * 0.5;
    const given = typeof w.floor === 'object' && typeof w.floor.y === 'number';
    const y = given ? w.floor.y : box.min.y - (box.max.y - box.min.y) * 0.1;
    w.floorGroup.position.set(c.x, y, c.z);
    w.floorGroup.scale.setScalar(r * 1.6);
    w.keyLight.target.position.copy(c);
    const dir = new THREE.Vector3(0.35, 1, 0.45);
    w.keyLight.position.copy(c).add(dir.clone().multiplyScalar(r * 1.7));
    const k = w.keyLight.shadow.camera, e = r * 1.3;
    k.left = -e; k.right = e; k.top = e; k.bottom = -e; k.near = 0.1; k.far = r * 5; k.updateProjectionMatrix();
    const v = w.lightView, onFloor = new THREE.Vector3(c.x, y, c.z);
    v.left = -e; v.right = e; v.top = e; v.bottom = -e; v.near = 0.1; v.far = r * 5; v.updateProjectionMatrix();
    v.position.copy(onFloor).addScaledVector(dir.clone().normalize(), -r * 1.5);
    v.lookAt(onFloor);
    v.updateMatrixWorld();
    v.matrixWorldInverse.copy(v.matrixWorld).invert();
    w.floorSpan = 2 * e;
    w.floorY = y;
    w.floorHeight = r * 0.45;
        w.lightSlope.set(dir.x / dir.y, dir.z / dir.y);
    w.floorBuilt = true;
  };

  const targetOptions = (samples, depth) => ({ type: THREE.HalfFloatType, samples, depthBuffer: !!depth, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  const sceneTarget = (W, H) => sharedOf('scene', W, H, () => {
    const rt = new THREE.WebGLRenderTarget(W, H, targetOptions(4, true));
    rt.depthTexture = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    return rt;
  });
  const flatTarget = (name, W, H) => sharedOf(name, W, H, () => new THREE.WebGLRenderTarget(W, H, targetOptions(0, false)));
  const mirrorTarget = (W, H) => sharedOf('mirror', W, H, () => {
    const rt = new THREE.WebGLRenderTarget(W, H, targetOptions(2, true));
    rt.depthTexture = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    return rt;
  });
  const shadowTarget = () => sharedOf('floor-shadow', SHADOW_SIZE, SHADOW_SIZE, () => new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true }));
  const bloomOf = (W, H) => sharedOf('bloom', W, H, () => new UnrealBloomPass(new THREE.Vector2(W, H), 0.26, 0.32, 1.1));

  /** The floor's shadow: only casters, from under the floor. A world with no casters clears it. */
  const renderFloorShadow = (w, look) => {
    const target = shadowTarget();
    const view = w.lightView, u = w.catcher.uniforms;
    w.root.traverse((o) => { if (o.castShadow) o.layers.enable(SHADOW_LAYER); else o.layers.disable(SHADOW_LAYER); });
    w.scene.overrideMaterial = heightMat;
    heightMat.uniforms.floorY.value = w.floorY;
    renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(w.scene, view);
    } finally {
      w.scene.overrideMaterial = null;
    }
    u.tS.value = target.texture;
    u.toLight.value.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    u.texel.value = 1 / SHADOW_SIZE;
    u.soft.value = look.softness / w.floorSpan;
    u.opacity.value = look.shadow;
  };

  /** Render world w at scale s for a crop into output. Sets all renderer state that it needs and restores it. */
  const renderWorld = (w, s, crop, output) => {
    const look = w.look, camera = w.camera;
    const W = crop.r - crop.l, H = crop.b - crop.t;
    const saved = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, tone: renderer.toneMapping, exposure: renderer.toneMappingExposure,
      shadows: renderer.shadowMap.enabled, type: renderer.shadowMap.type, autoUpdate: renderer.shadowMap.autoUpdate, alpha: renderer.getClearAlpha()
    };
    try {
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = !!look.shadows;
      renderer.shadowMap.type = THREE.VSMShadowMap;
      w.scene.environment = look.environment > 0 ? environment : null;
      w.scene.environmentIntensity = look.environment;
      const lit = look.name !== 'plain';
      w.keyLight.visible = lit; w.rimLight.visible = lit;
      w.keyLight.castShadow = !!look.shadows;

      const on = floorOn(w);
      const floor = on && w.floorBuilt;
      w.floorGroup.visible = floor;
      aimCamera(w, s, crop);

      if (floor) {
        w.catcher.visible = !!look.shadows;
        if (look.shadows) renderFloorShadow(w, look);
        renderer.shadowMap.autoUpdate = saved.autoUpdate;
      }

      // Reflection: the world mirrored in the floor, into a half-size target.
      if (floor) {
        const root = w.root, sy = root.scale.y, py = root.position.y, castShadow = w.keyLight.castShadow;
        const mirror = mirrorTarget(W / 2, H / 2);
        root.scale.y = -sy; root.position.y = 2 * w.floorY - py; root.updateMatrixWorld(true);
        w.floorGroup.visible = false;
        w.keyLight.castShadow = false;
        renderer.shadowMap.autoUpdate = false;
        try {
          renderer.setRenderTarget(mirror);
          renderer.clear();
          renderer.render(w.scene, camera);
        } finally {
          renderer.shadowMap.autoUpdate = saved.autoUpdate;
          w.keyLight.castShadow = castShadow;
          root.scale.y = sy; root.position.y = py; root.updateMatrixWorld(true);
          w.floorGroup.visible = true;
        }
        const r = w.reflection.uniforms;
        r.tR.value = mirror.texture;
        r.tD.value = mirror.depthTexture;
        r.toWorld.value.copy(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
        r.floorY.value = w.floorY;
        r.fadeH.value = w.floorHeight;
        r.spread.value.set((12 * s) / FILM_SCALE / W, (12 * s) / FILM_SCALE / H);
      }

      const scene = sceneTarget(W, H);
      renderer.setRenderTarget(scene);
      renderer.clear();
      renderer.render(w.scene, camera);

      const a = flatTarget('a', W, H), b = flatTarget('b', W, H);
      if (look.dof > 0 && camera.isPerspectiveCamera) {
        const u = dofMat.uniforms;
        u.tC.value = scene.texture; u.tD.value = scene.depthTexture;
        u.focus.value = w.bounds.isEmpty() ? 10 : camera.position.distanceTo(w.bounds.getCenter(reachVector()));
        u.ap.value = look.dof; u.near.value = camera.near; u.far.value = camera.far;
        u.px.value.set(1 / W, 1 / H); u.scale.value = s / FILM_SCALE;
        pass(dofMat, a);
      } else {
        copyMat.uniforms.t.value = scene.texture;
        pass(copyMat, a);
      }
      copyMat.uniforms.t.value = a.texture;
      pass(copyMat, b);
      if (look.bloom > 0) {
        const bloom = bloomOf(W, H);
        bloom.strength = look.bloom; bloom.radius = look.glowRadius; bloom.threshold = look.threshold;
        bloom.render(renderer, null, b, 1 / 60, false);
      }
      const u = finalMat.uniforms;
      u.tA.value = a.texture; u.tB.value = b.texture;
      u.seed.value = w.tickMs % 97;
      u.toneMappingExposure.value = look.exposure;
      u.tone.value = look.tone ? 1 : 0;
      pass(finalMat, output);
    } finally {
      renderer.setRenderTarget(saved.target);
      renderer.autoClear = saved.autoClear;
      renderer.toneMapping = saved.tone;
      renderer.toneMappingExposure = saved.exposure;
      renderer.shadowMap.enabled = saved.shadows;
      renderer.shadowMap.type = saved.type;
      renderer.shadowMap.autoUpdate = saved.autoUpdate;
      renderer.setClearColor(0x000000, saved.alpha);
    }
  };
`
