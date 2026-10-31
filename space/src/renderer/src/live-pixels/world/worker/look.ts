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
 * - Bloom is a pyramid and not UnrealBloomPass (measured: 37 ms to 12 ms per
 *   picture for all changes together on a MacBook Air). Its radii are in board points.
 * - The scene renders only the inner crop, and the rest of the crop holds only glow.
 * - The shadow on the floor has its own map (renderFloorShadow). Its blur grows
 *   with the height of what casts it, so the shadow is sharp at contact and soft
 *   far from it. The light's shadow map stays for objects on each other.
 */
export const LOOK = String.raw`
  const QUAD_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  const FILM = { name: 'film', exposure: 1, bloom: 0.26, threshold: 1.1, glowRadius: 0.32, dof: 0.5, shadows: true, shadow: 0.55, softness: 0.22, environment: 0.9, tone: true };
  const PLAIN = { name: 'plain', exposure: 1, bloom: 0, threshold: 1.1, glowRadius: 0.32, dof: 0, shadows: false, shadow: 0.55, softness: 0.22, environment: 0, tone: false };
  /** The scale the numbers of film.js were tuned at: 2 pixels per board point. */
  const FILM_SCALE = 2;
  /**
   * The look's bloom: radii in board points and their weights, measured against UnrealBloomPass of film.js at 2 pixels per point.
   * look.glowRadius 0.32 is that size; another value scales the radii. BLOOM_LEVELS: the most levels of the pyramid.
   */
  const BLOOM_REACH = [6, 20, 56, 144, 352], BLOOM_WEIGHT = [2.1, 1.4, 1.1, 0.85, 0.36], BLOOM_LEVELS = 10;
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
  let environment = null;
  let quadScene = null, quadCam = null, quad = null, dofMat = null, finalMat = null, floorMask = null, heightMat = null, brightMat = null, downMat = null, upMat = null;
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
    // Bloom: a pyramid. A bright pass, 13-tap down passes, tent up passes with one weight per level. UnrealBloomPass gave this look
    // and took half of the frame; a pyramid costs about half a screen of pixels, and its weights can follow the zoom.
    brightMat = new THREE.ShaderMaterial({ ...noTone(), uniforms: { t: { value: null }, px: { value: new THREE.Vector2() }, box: { value: new THREE.Vector4(0, 0, 1, 1) }, threshold: { value: 1.1 } }, vertexShader: QUAD_VS,
      fragmentShader: [
        'uniform sampler2D t; uniform vec2 px; uniform vec4 box; uniform float threshold; varying vec2 vUv;',
        'void main(){ vec2 u = (vUv - box.xy) / box.zw; if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
        'vec3 c = (texture2D(t, u + px * vec2(-1.0, -1.0)).rgb + texture2D(t, u + px * vec2(1.0, -1.0)).rgb + texture2D(t, u + px * vec2(-1.0, 1.0)).rgb + texture2D(t, u + px).rgb) * 0.25;',
        'float l = dot(c, vec3(0.299, 0.587, 0.114)); gl_FragColor = vec4(max(c, vec3(0.0)) * smoothstep(threshold, threshold + 0.01, l), 1.0); }'
      ].join('\n')
    });
    downMat = new THREE.ShaderMaterial({ ...noTone(), uniforms: { t: { value: null }, px: { value: new THREE.Vector2() } }, vertexShader: QUAD_VS,
      fragmentShader: [
        'uniform sampler2D t; uniform vec2 px; varying vec2 vUv;',
        'vec3 at(float x, float y){ return texture2D(t, vUv + px * vec2(x, y)).rgb; }',
        'void main(){ vec3 c = at(0.0, 0.0) * 0.125;',
        'c += (at(-2.0, -2.0) + at(2.0, -2.0) + at(-2.0, 2.0) + at(2.0, 2.0)) * 0.03125;',
        'c += (at(-2.0, 0.0) + at(2.0, 0.0) + at(0.0, -2.0) + at(0.0, 2.0)) * 0.0625;',
        'c += (at(-1.0, -1.0) + at(1.0, -1.0) + at(-1.0, 1.0) + at(1.0, 1.0)) * 0.125;',
        'gl_FragColor = vec4(c, 1.0); }'
      ].join('\n')
    });
    upMat = new THREE.ShaderMaterial({ ...noTone(), uniforms: { tD: { value: null }, tU: { value: null }, px: { value: new THREE.Vector2() }, weight: { value: 1 }, hasUp: { value: 0 } }, vertexShader: QUAD_VS,
      fragmentShader: [
        'uniform sampler2D tD, tU; uniform vec2 px; uniform float weight, hasUp; varying vec2 vUv;',
        'vec3 at(float x, float y){ return texture2D(tU, vUv + px * vec2(x, y)).rgb; }',
        'void main(){ vec3 c = texture2D(tD, vUv).rgb * weight;',
        'if (hasUp > 0.5) { c += at(0.0, 0.0) * 0.25 + (at(-1.0, 0.0) + at(1.0, 0.0) + at(0.0, -1.0) + at(0.0, 1.0)) * 0.125 + (at(-1.0, -1.0) + at(1.0, -1.0) + at(-1.0, 1.0) + at(1.0, 1.0)) * 0.0625; }',
        'gl_FragColor = vec4(c, 1.0); }'
      ].join('\n')
    });
    // The last pass: tone mapping, sRGB, premultiplied output with real alpha. The glow keeps its own alpha, so it joins any board.
    finalMat = new THREE.ShaderMaterial({ ...noTone(),
      uniforms: { tA: { value: null }, tB: { value: null }, box: { value: new THREE.Vector4(0, 0, 1, 1) }, glow: { value: 0 }, seed: { value: 0 }, toneMappingExposure: { value: 1 }, tone: { value: 1 } },
      vertexShader: QUAD_VS,
      fragmentShader: [
        '#include <tonemapping_pars_fragment>',
        'uniform sampler2D tA, tB; uniform vec4 box; uniform float seed, tone, glow; varying vec2 vUv;',
        'float n(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }',
        'vec3 tm(vec3 c){ vec3 v = max(c, vec3(0.0)); v = tone > 0.5 ? ACESFilmicToneMapping(v) : clamp(v, 0.0, 1.0);',
        ' return sRGBTransferOETF(vec4(v, 1.0)).rgb; }',
        'void main(){ vec2 u = (vUv - box.xy) / box.zw; vec4 a = u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0 ? vec4(0.0) : texture2D(tA, u);',
        'float al = clamp(a.a, 0.0, 1.0); vec3 S = al > 0.002 ? a.rgb / al : vec3(0.0);',
        'vec3 G = max(texture2D(tB, vUv).rgb, vec3(0.0)) * glow;',
        'vec3 sc = tm(S) * al; vec3 gl = tm(G) * (1.0 - al);',
        'vec3 c = sc + gl + (n(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.002, al + gl.r + gl.g + gl.b);',
        'float g = max(gl.r, max(gl.g, gl.b)); gl_FragColor = vec4(max(c, vec3(0.0)), clamp(al + g * (1.0 - al), 0.0, 1.0)); }'
      ].join('\n')
    });
    // What casts a shadow on the floor, seen from under the floor along the light.
    // Red is coverage and green is coverage times height. Mips average both, so any mip gives a blurred shadow and the mean height over a point.
    heightMat = new THREE.ShaderMaterial({ toneMapped: false, side: THREE.DoubleSide, blending: THREE.NoBlending,
      uniforms: { floorY: { value: 0 }, fade: { value: 1 } },
      vertexShader: 'uniform float floorY; varying float vH; void main(){ vec4 p = vec4(position, 1.0);\n#ifdef USE_INSTANCING\n p = instanceMatrix * p;\n#endif\n p = modelMatrix * p; vH = max(p.y - floorY, 0.0); gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: 'uniform float fade; varying float vH; void main(){ gl_FragColor = vec4(fade, vH * fade, 0.0, 1.0); }'
    });
    // A part that fades takes its shadow with it.
    heightMat.onBeforeRender = (r, sc, c, g, object) => {
      const fade = object.userData.lsFade === undefined ? 1 : object.userData.lsFade;
      if (fade !== heightMat.uniforms.fade.value) { heightMat.uniforms.fade.value = fade; heightMat.uniformsNeedUpdate = true; }
    };
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
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 3; key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
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
        'for (int i = 0; i < 8; i++) { float a = float(i) * 2.399963; float r = sqrt((float(i) + 0.5) / 8.0); vec2 d = vec2(cos(a), sin(a)) * r * spread; vec2 u = s + d;',
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

  /** Free what a world holds on the GPU. Shared textures stay: the environment, the floor's mask, the pool's targets. */
  const undressWorld = (w) => {
    const seen = new Set();
    const freeTexture = (t) => {
      if (!t || !t.isTexture || seen.has(t) || t === floorMask || t === environment || t.isRenderTargetTexture) return;
      seen.add(t);
      t.dispose();
    };
    w.scene.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      for (const m of [].concat(o.material || [])) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const value of Object.values(m)) freeTexture(value);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) freeTexture(u.value);
        m.dispose();
      }
      if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
      if ((o.isInstancedMesh || o.isLight) && o.dispose) o.dispose();
    });
    freeTexture(w.scene.background);
    freeTexture(w.scene.environment);
    if (w.output) { giveOutput(w.output); w.output = null; }
    w.drawn = null;
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
    const rt = new THREE.WebGLRenderTarget(W, H, targetOptions(0, true));
    rt.depthTexture = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    return rt;
  });
  const shadowTarget = () => sharedOf('floor-shadow', SHADOW_SIZE, SHADOW_SIZE, () => new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true }));

  /** Levels of the bloom pyramid of a W x H target: level 1 is half size. */
  const pyramidOf = (W, H) => sharedOf('pyramid', W, H, () => {
    const down = [null], up = [null];
    let w = W, h = H;
    for (let i = 1; i <= BLOOM_LEVELS && Math.min(w, h) > 3; i++) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      down.push(new THREE.WebGLRenderTarget(w, h, targetOptions(0, false)));
      up.push(new THREE.WebGLRenderTarget(w, h, targetOptions(0, false)));
    }
    return { down, up, dispose() { for (const t of down.concat(up)) if (t) t.dispose(); } };
  });
  /**
   * Weights per pyramid level for a scale in pixels per board point. BLOOM_REACH holds the radii of the look in board points, so the glow
   * keeps its size on the board at any zoom: each radius falls between two levels and shares its weight between them.
   */
  const bloomWeights = (scale, top, radius) => {
    const weights = new Array(top + 1).fill(0);
    for (let j = 0; j < BLOOM_REACH.length; j++) {
      const at = Math.max(1, Math.min(top, Math.log2(BLOOM_REACH[j] * scale * (radius / 0.32))));
      const i = Math.min(top - 1, Math.floor(at)), k = at - i;
      weights[i] += BLOOM_WEIGHT[j] * (1 - k);
      weights[i + 1] += BLOOM_WEIGHT[j] * k;
    }
    return weights;
  };
  /** The bloom of texture t, as a texture. */
  const renderBloom = (t, iW, iH, box, W, H, scale, look) => {
    const p = pyramidOf(W, H), top = p.down.length - 1, weights = bloomWeights(scale, top, look.glowRadius);
    let lo = 1;
    while (lo < top && weights[lo] === 0) lo++;
    brightMat.uniforms.t.value = t;
    brightMat.uniforms.px.value.set(0.5 / iW, 0.5 / iH);
    brightMat.uniforms.box.value.copy(box);
    brightMat.uniforms.threshold.value = look.threshold;
    pass(brightMat, p.down[1]);
    for (let i = 2; i <= top; i++) {
      downMat.uniforms.t.value = p.down[i - 1].texture;
      downMat.uniforms.px.value.set(1 / p.down[i - 1].width, 1 / p.down[i - 1].height);
      pass(downMat, p.down[i]);
    }
    // Level 2 or lower at any zoom: one bilinear step up from a far level would show as steps in the glow.
    const bottom = Math.min(lo, 2);
    for (let i = top; i >= bottom; i--) {
      const u = upMat.uniforms;
      u.tD.value = p.down[i].texture;
      u.weight.value = weights[i];
      u.hasUp.value = i < top ? 1 : 0;
      if (i < top) { u.tU.value = p.up[i + 1].texture; u.px.value.set(1 / p.up[i + 1].width, 1 / p.up[i + 1].height); }
      pass(upMat, p.up[i]);
    }
    return p.up[bottom].texture;
  };

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
  const renderWorld = (w, s, crop, inner, output) => {
    const look = w.look, camera = w.camera;
    // The output can be smaller than the crop (dynamic resolution). The scene covers only the inner crop: outside it there is only glow.
    const W = output.width, H = output.height, cw = crop.r - crop.l, ch = crop.b - crop.t, res = W / cw, scale = s * res;
    const iw = inner.r - inner.l, ih = inner.b - inner.t;
    const IW = Math.max(2, Math.min(W, Math.ceil(iw * res))), IH = Math.max(2, Math.min(H, Math.ceil(ih * res)));
    const box = new THREE.Vector4((inner.l - crop.l) / cw, (crop.b - inner.b) / ch, iw / cw, ih / ch);
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
      renderer.shadowMap.type = THREE.PCFShadowMap;
      w.scene.environment = look.environment > 0 ? environment : null;
      w.scene.environmentIntensity = look.environment;
      const lit = look.name !== 'plain';
      w.keyLight.visible = lit; w.rimLight.visible = lit;
      w.keyLight.castShadow = !!look.shadows;

      const on = floorOn(w);
      const floor = on && w.floorBuilt;
      w.floorGroup.visible = floor;
      aimCamera(w, s, inner);

      if (floor) {
        w.catcher.visible = !!look.shadows;
        if (look.shadows) renderFloorShadow(w, look);
        renderer.shadowMap.autoUpdate = saved.autoUpdate;
      }

      // Reflection: the world mirrored in the floor, into a half-size target.
      if (floor) {
        const root = w.root, sy = root.scale.y, py = root.position.y, castShadow = w.keyLight.castShadow;
        const mirror = mirrorTarget(Math.ceil(IW / 3), Math.ceil(IH / 3));
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
        r.spread.value.set(((12 * s) / FILM_SCALE) / iw, ((12 * s) / FILM_SCALE) / ih);
      }

      const scene = sceneTarget(IW, IH);
      renderer.setRenderTarget(scene);
      renderer.clear();
      renderer.render(w.scene, camera);

      let sharp = scene.texture;
      if (look.dof > 0 && camera.isPerspectiveCamera) {
        const a = flatTarget('a', IW, IH), u = dofMat.uniforms;
        u.tC.value = scene.texture; u.tD.value = scene.depthTexture;
        u.focus.value = w.bounds.isEmpty() ? 10 : camera.position.distanceTo(w.bounds.getCenter(reachVector()));
        u.ap.value = look.dof; u.near.value = camera.near; u.far.value = camera.far;
        u.px.value.set(1 / IW, 1 / IH); u.scale.value = scale / FILM_SCALE;
        pass(dofMat, a);
        sharp = a.texture;
      }
      const glow = look.bloom > 0 ? renderBloom(sharp, IW, IH, box, W, H, scale, look) : sharp;
      const u = finalMat.uniforms;
      u.tA.value = sharp; u.tB.value = glow;
      u.box.value.copy(box);
      u.glow.value = look.bloom > 0 ? look.bloom : 0;
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
