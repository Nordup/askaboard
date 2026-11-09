/**
 * The two environments of the look: dark (the dark board, and every still for an
 * agent) and light (the light board of the learner's window, decision U22).
 *
 * The dark environment is the look of toon.ts as it is. The light one keeps every
 * material colour and the transparent background, and changes three things:
 * - no ink line;
 * - the shades of the bands: EXPOSURE · shade^CONTRAST in linear light, so the shade
 *   band of a pale object is clearly darker than the paper and the lit band stays
 *   just under it;
 * - a contact shadow just under the lowest point of what the world draws now: a
 *   depth render from that floor up, blurred, on a plane in the stage, black at low
 *   alpha. Not the fit of the floor (A6): it stands 10 % of the height lower, and the
 *   shadow of a tall world then floats apart from it.
 *   It renders only when the world's picture changed (measureReach places it), at
 *   SHADOW_TEXELS on its longest side, never on a pan.
 *
 * The page says which board it shows (message `theme`). A private surface never
 * hears it, and readStill renders dark on any surface: agents always see the dark board.
 */
export const GROUND = String.raw`
  /** The board of this surface is light. */
  let lightBoard = false;
  /** The shades of the light environment: LIGHT_EXPOSURE · shade^LIGHT_CONTRAST. The default shades 0.56, 0.78, 1 become 0.28, 0.55, 0.9. */
  const LIGHT_EXPOSURE = 0.9, LIGHT_CONTRAST = 2;
  /** The contact shadow: alpha; the height it sees, as a share of the world's height; texels on its longest side; blur in texels. */
  const SHADOW_ALPHA = 0.36, SHADOW_HEIGHT = 0.5, SHADOW_TEXELS = 128, SHADOW_BLUR = [2.4, 1];
  /** The shadow's floor lies this share of the world's size under its lowest point: it touches the world. */
  const CONTACT_GAP = 0.02;

  let groundDepth = null, groundBlur = null, blurScene = null, blurCamera = null, groundBox = null;

  const lightShades = (shades, out) => out.set(
    LIGHT_EXPOSURE * Math.pow(Math.max(0, shades[0]), LIGHT_CONTRAST),
    LIGHT_EXPOSURE * Math.pow(Math.max(0, shades[1]), LIGHT_CONTRAST),
    LIGHT_EXPOSURE * Math.pow(Math.max(0, shades[2]), LIGHT_CONTRAST)
  );

  /** Once, at the first light render: the parts that all worlds share. */
  const makeGround = () => {
    // Darkness falls from 1 at the floor to 0 at the top of what the camera sees.
    groundDepth = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false, transparent: true });
    groundDepth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), 1.0 - fragCoordZ );');
    };
    // A 9-tap Gaussian in 5 linear fetches, on alpha only.
    groundBlur = new THREE.ShaderMaterial({
      uniforms: { t: { value: null }, step: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D t; uniform vec2 step; varying vec2 vUv;',
        'void main() {',
        '  float a = texture2D(t, vUv).a * 0.2270270270;',
        '  a += (texture2D(t, vUv + step * 1.3846153846).a + texture2D(t, vUv - step * 1.3846153846).a) * 0.3162162162;',
        '  a += (texture2D(t, vUv + step * 3.2307692308).a + texture2D(t, vUv - step * 3.2307692308).a) * 0.0702702703;',
        '  gl_FragColor = vec4(0.0, 0.0, 0.0, a); }'
      ].join('\n'),
      depthTest: false, depthWrite: false, blending: THREE.NoBlending
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), groundBlur);
    quad.frustumCulled = false;
    blurScene = new THREE.Scene();
    blurScene.add(quad);
    blurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    groundBox = new THREE.Box3();
    commonParts.add(groundDepth).add(groundBlur).add(quad.geometry);
  };

  /** A world's parts of the shadow, at its first light render: a group in the stage with the camera that looks up and the plane that shows it. */
  const dressGround = (w) => {
    if (!groundDepth) makeGround();
    const group = new THREE.Group(), camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
    camera.rotation.x = Math.PI / 2;
    const target = () => {
      const t = new THREE.WebGLRenderTarget(SHADOW_TEXELS, SHADOW_TEXELS, { depthBuffer: false });
      t.texture.generateMipmaps = false;
      return t;
    };
    const targets = [target(), target()];
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: targets[0].texture, transparent: true, opacity: SHADOW_ALPHA, depthWrite: false })
    );
    // The plane faces down after the turn: a negative scale turns it to face up, and the picture of the camera lies on it the right way.
    plane.raycast = () => {};
    group.add(camera, plane);
    group.visible = false;
    w.stage.add(group);
    w.ground = { group, camera, plane, targets, placed: false, due: false, quiet: [], was: [] };
  };

  /** What shows: a visible material. A part at opacity 0 (a layer that fades in later) casts no shadow and moves no floor. */
  const shows = (m) => !!m && m.visible && !(m.transparent && m.opacity <= 0.01);
  /** In the reach walk (view.ts): whether object o is part of the footprint. A drawn part that does not show leaves the depth pass. */
  const groundShows = (w, o) => {
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return false;
    if (Array.isArray(o.material) ? o.material.some(shows) : shows(o.material)) return true;
    w.ground.quiet.push(o);
    return false;
  };

  /** Before the reach walk: true when it also measures the footprint, on the light board. */
  const beginFootprint = (w) => {
    if (!lightBoard) return false;
    if (!w.ground) dressGround(w);
    groundBox.makeEmpty();
    w.ground.quiet.length = 0;
    return true;
  };
  const footPoint = (x, y, z) => {
    const b = groundBox;
    if (x < b.min.x) b.min.x = x;
    if (x > b.max.x) b.max.x = x;
    if (y < b.min.y) b.min.y = y;
    if (y > b.max.y) b.max.y = y;
    if (z < b.min.z) b.min.z = z;
    if (z > b.max.z) b.max.z = z;
  };
  /** The eight corners of box b (min x, y, z, max x, y, z) under the 16 numbers e, to world space. */
  const footBox = (e, b) => {
    for (let c = 0; c < 8; c++) {
      const x = b[c & 1 ? 3 : 0], y = b[c & 2 ? 4 : 1], z = b[c & 4 ? 5 : 2];
      footPoint(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
  };

  /**
   * After the reach walk, on the light board: the shadow's place under the footprint, the bounds that reach holds (A6) in world space, so the
   * shadow follows every part that moves and nothing is measured twice. The plane covers the footprint and room for the blur. The texture
   * renders in the next renderWorld.
   */
  const placeGround = (w) => {
    const g = w.ground, box = groundBox;
    if (box.isEmpty() || !Number.isFinite(box.min.x + box.max.x + box.min.y + box.min.z + box.max.z)) { g.placed = false; return; }
    const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z, m = Math.max(dx, dz, 1e-3);
    const W = dx + 0.2 * m, D = dz + 0.2 * m, floor = box.min.y - CONTACT_GAP * Math.max(dy, m);
    g.group.position.set((box.min.x + box.max.x) / 2, floor, (box.min.z + box.max.z) / 2);
    g.plane.scale.set(W, -1, D);
    const c = g.camera;
    c.left = -W / 2; c.right = W / 2; c.top = D / 2; c.bottom = -D / 2;
    c.near = 0; c.far = Math.max(1e-3, box.min.y - floor + SHADOW_HEIGHT * Math.max(dy, 0.2 * m));
    c.updateProjectionMatrix();
    g.group.updateMatrixWorld(true);
    // Texels stay square: the long side has SHADOW_TEXELS.
    const long = Math.max(W, D), tw = Math.max(16, Math.round((SHADOW_TEXELS * W) / long / 8) * 8), th = Math.max(16, Math.round((SHADOW_TEXELS * D) / long / 8) * 8);
    for (const t of g.targets) if (t.width !== tw || t.height !== th) t.setSize(tw, th);
    g.placed = true;
    g.due = true;
  };

  /** The shadow's texture: what lies above the floor, from below, as alpha, then blurred. Before the world's own render, outside the look. */
  const renderGround = (w) => {
    const g = w.ground, scene = w.scene, [a, b] = g.targets;
    g.due = false;
    const saved = { stage: w.stage.visible, override: scene.overrideMaterial, background: scene.background };
    try {
      w.stage.visible = false;
      // The depth material draws every object: the parts that do not show now leave the pass.
      for (const o of g.quiet) { g.was.push(o.visible); o.visible = false; }
      scene.overrideMaterial = groundDepth;
      scene.background = null;
      renderer.setRenderTarget(a);
      drawWorld(w, g.camera);
    } finally {
      w.stage.visible = saved.stage;
      for (let i = 0; i < g.was.length; i++) g.quiet[i].visible = g.was[i];
      g.was.length = 0;
      scene.overrideMaterial = saved.override;
      scene.background = saved.background;
    }
    const u = groundBlur.uniforms;
    for (const k of SHADOW_BLUR) {
      u.t.value = a.texture; u.step.value.set(k / a.width, 0);
      renderer.setRenderTarget(b);
      renderer.render(blurScene, blurCamera);
      u.t.value = b.texture; u.step.value.set(0, k / a.height);
      renderer.setRenderTarget(a);
      renderer.render(blurScene, blurCamera);
    }
    u.t.value = null;
  };

  /** In renderWorld: the environment of this render. The shadow shows only on the light board. */
  const beginGround = (w, compileOnly) => {
    const g = w.ground;
    if (!g) return;
    g.group.visible = lightBoard && g.placed;
    if (g.group.visible && g.due && !compileOnly) renderGround(w);
  };
`
