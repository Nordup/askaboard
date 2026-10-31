/**
 * The surface of the world worker: one WebGLRenderer on an OffscreenCanvas. One
 * frame (architecture section 3): tick the worlds that are due, render the worlds
 * that changed, composite their outputs in board order, send one picture.
 *
 * Tick and render are separate. A camera move or a change in another world only
 * composites again. It advances no world and, when the world's output still
 * covers what the surface needs, it does not render that world.
 *
 * On demand. With nothing to tick and no change, nothing renders. The next
 * frame starts on "presented", when the GPU finished the last one, so a slow
 * page gets fewer pictures, and a world never fills the GPU ahead of the page.
 */
export const SURFACE = String.raw`
  let THREE = null, renderer = null, canvas = null, compositeMat = null, compositeScene = null, compositeCam = null;
  const surface = { width: 0, height: 0, dpr: 1, margin: 0, camera: null, seq: 0, dirty: false };
  let sent = 0, waiting = false;

  const sizeSurface = (m) => {
    surface.dpr = m.dpr;
    if (typeof m.margin === 'number') surface.margin = m.margin;
    surface.width = Math.max(1, Math.round((m.width + 2 * surface.margin) * m.dpr));
    surface.height = Math.max(1, Math.round((m.height + 2 * surface.margin) * m.dpr));
    renderer.setPixelRatio(1);
    renderer.setSize(surface.width, surface.height, false);
    surface.dirty = true;
  };

  /** Draw a world's output onto the canvas: premultiplied, with its opacity and its wipe. */
  const compositeWorld = (w) => {
    const d = w.drawn, p = placed(w), u = compositeMat.uniforms;
    const ox = d.crop.l, oy = d.crop.t, qw = d.crop.r - d.crop.l, qh = d.crop.b - d.crop.t;
    const scale = p.s / d.s;
    const toClipX = 2 / surface.width, toClipY = -2 / surface.height;
    u.origin.value.set((p.cx + (p.a * ox + p.c * oy) * scale) * toClipX - 1, (p.cy + (p.b * ox + p.d * oy) * scale) * toClipY + 1);
    u.axisX.value.set(p.a * qw * scale * toClipX, p.b * qw * scale * toClipY);
    u.axisY.value.set(p.c * qh * scale * toClipX, p.d * qh * scale * toClipY);
    u.t.value = w.output.texture;
    u.opacity.value = Math.max(0, Math.min(1, w.placement.opacity));
    u.reveal.value = Math.max(0, Math.min(1, w.placement.reveal));
    // The wipe runs over what the world reaches, so it does not move when the crop moves.
    const reach = w.reach && !w.reach.full ? w.reach : { l: -w.w / 2, r: w.w / 2 };
    u.span.value.set((reach.l * d.s - ox) / qw, (reach.r * d.s - ox) / qw);
    renderer.render(compositeScene, compositeCam);
  };

  const makeSurface = () => {
    compositeScene = new THREE.Scene();
    compositeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    compositeMat = new THREE.ShaderMaterial({
      toneMapped: false, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: { t: { value: null }, opacity: { value: 1 }, reveal: { value: 1 }, span: { value: new THREE.Vector2(0, 1) }, origin: { value: new THREE.Vector2() }, axisX: { value: new THREE.Vector2() }, axisY: { value: new THREE.Vector2() } },
      vertexShader: 'uniform vec2 origin, axisX, axisY; varying vec2 vUv; void main(){ vUv = uv; vec2 q = vec2(uv.x, 1.0 - uv.y); gl_Position = vec4(origin + axisX * q.x + axisY * q.y, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D t; uniform float opacity, reveal; uniform vec2 span; varying vec2 vUv;',
        'void main(){ vec4 c = texture2D(t, vUv); float k = opacity;',
        'if (reveal < 1.0) { float e = (vUv.x - span.x) / (span.y - span.x); k *= 1.0 - smoothstep(reveal * 1.2 - 0.2, reveal * 1.2, e); }',
        'gl_FragColor = c * k; }'
      ].join('\n')
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), compositeMat);
    mesh.frustumCulled = false;
    compositeScene.add(mesh);
  };

  /** Render world w for this view if it needs it. False when it cannot show anything now. */
  const prepare = (w) => {
    const p = placed(w);
    const old = w.drawn;
    if (!w.reach || (floorOn(w) && !w.floorBuilt) || (w.stale && w.samples++ % SAMPLE_EVERY === 0)) sampleReach(w);
    const crop = cropFor(w, p);
    w.culled = !crop;
    if (!crop) return false;
    const same = old && Math.abs(old.s - p.s) < 1e-6;
    if (!w.stale && same && contains(old.crop, crop)) return true;
    // Resolution falls only while a world moves. It renders sharp again when it rests.
    const res = w.moving || (old && !same) ? QUALITY[quality] : 1;
    const W = Math.ceil(((crop.r - crop.l) * res) / 2) * 2, H = Math.ceil(((crop.b - crop.t) * res) / 2) * 2;
    if (!w.output || w.output.width !== W || w.output.height !== H) {
      if (w.output) giveOutput(w.output);
      w.output = takeOutput(W, H);
    }
    renderWorld(w, p.s, crop, innerOf(w, p.s, crop), w.output);
    w.drawn = { s: p.s, crop, res };
    w.stale = false;
    w.moving = false;
    return true;
  };

  /**
   * Where the published points of w are now, in nominal board points from the anchor, with a flag for each: shown or not.
   * A world code error here stops that world.
   */
  const measurePoints = (w) => {
    const list = [];
    if (!w.parts.size) return list;
    const c = w.camera, v = new THREE.Vector3();
    nominalCamera(w);
    w.scene.updateMatrixWorld();
    for (const [name, part] of w.parts) {
      const t = part.target;
      if (t === null || t === undefined) continue;
      let seen = true;
      if (t.isObject3D) {
        t.getWorldPosition(v);
        for (let o = t; o; o = o.parent) if (!o.visible) seen = false;
      } else if (t.isVector3) v.copy(t).applyMatrix4(w.root.matrixWorld);
      else {
        const at = inside(w, () => { try { return t(); } catch (e) { fail(w, e); return null; } });
        if (!at) continue;
        v.set(at[0], at[1], at[2]).applyMatrix4(w.root.matrixWorld);
      }
      const view = v.clone().applyMatrix4(c.matrixWorldInverse);
      if (c.isPerspectiveCamera && view.z > -c.near) seen = false;
      v.applyMatrix4(c.matrixWorldInverse).applyMatrix4(c.projectionMatrix);
      const x = (v.x * w.w) / 2, y = (-v.y * w.h) / 2, r = w.reach;
      if (!r || (!r.full && (x < r.l || x > r.r || y < r.t || y > r.b))) seen = false;
      list.push([name, x, y, seen]);
    }
    return list;
  };
  /** The points of all placed worlds on the board, for one picture. */
  const boardPoints = () => {
    const points = {};
    for (const w of worlds.values()) {
      const p = w.placement;
      if (!p || !w.parts.size || w.failed || !(w.setUp || w.ran)) continue;
      const m = p.matrix, cx = p.x + p.w / 2 + m[4], cy = p.y + p.h / 2 + m[5], own = {};
      for (const [name, x, y, seen] of measurePoints(w)) own[name] = [cx + m[0] * x + m[2] * y, cy + m[1] * x + m[3] * y, seen && p.shown];
      points[w.key.node] = own;
    }
    return points;
  };

  /** One picture of the surface, when something changed. */
  const paint = () => {
    if (!surface.camera) return;
    let changed = surface.dirty;
    const list = [];
    core = true;
    try {
      for (const w of worlds.values()) {
        const p = w.placement;
        if (!p || !p.shown) continue;
        const ready = (w.setUp || w.ran) && !w.failed;
        if (ready && !w.moving && w.drawn && w.drawn.res < 1) w.stale = true;
        const stale = w.stale;
        if (ready) {
          try {
            if (stale || !w.drawn || !w.reach || cropMoved(w)) { if (prepare(w) && stale) changed = true; }
          } catch (e) { fail(w, e); }
        }
        if (w.drawn && w.output) list.push(w);
      }
      trimTargets();
      if (!changed) return;
      changed = false;
      list.sort((a, b) => a.placement.z - b.placement.z);
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      for (const w of list) compositeWorld(w);
      const bitmap = canvas.transferToImageBitmap();
      surface.dirty = false;
      waiting = true;
      sent++;
      post({ type: 'picture', n: sent, seq: surface.seq, camera: surface.camera, bitmap, points: boardPoints() }, [bitmap]);
      watchGpu();
    } finally { core = false; }
  };

  // A view moved. True when the output of w no longer covers what the surface needs.
  const cropMoved = (w) => {
    const p = placed(w);
    if (Math.abs(w.drawn.s - p.s) > 1e-6) return true;
    const crop = cropFor(w, p);
    return !!crop && !contains(w.drawn.crop, crop);
  };

  /** Render one still of world w, at its full reach, and read it before anything else uses the target. */
  const STILL_MAX = 4096;
  const readStill = (w) => {
    core = true;
    let target = null;
    try {
      sampleReach(w);
      if (!w.reach || w.reach.full) w.reach = { l: -w.w / 2, t: -w.h / 2, r: w.w / 2, b: w.h / 2, full: false };
      const reach = w.reach;
      let s = Math.max(1, Math.min(2, surface.dpr));
      const pad = room(w, s);
      const needed = Math.max((reach.r - reach.l) * s + 2 * pad, (reach.b - reach.t) * s + 2 * pad);
      if (needed > STILL_MAX) s = Math.max(0.25, s * ((STILL_MAX - 2 * pad - 2 * GRID) / needed));
      const crop = snapped(reach.l * s - pad, reach.t * s - pad, reach.r * s + pad, reach.b * s + pad);
      if (!crop) return null;
      const W = crop.r - crop.l, H = crop.b - crop.t;
      target = takeOutput(W, H);
      renderWorld(w, s, crop, innerOf(w, s, crop), target);
      const data = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(target, 0, 0, W, H, data);
      const points = {};
      for (const [name, x, y, seen] of measurePoints(w)) points[name] = [x + w.w / 2, y + w.h / 2, seen];
      return { data, W, H, s, crop, points };
    } finally {
      if (target) giveOutput(target);
      core = false;
    }
  };
  const stillBlob = (shot) => {
    const { data, W, H } = shot;
    const pixels = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const from = (H - 1 - y) * W * 4, to = y * W * 4;
      for (let x = 0; x < W * 4; x += 4) {
        const a = data[from + x + 3], k = a ? 255 / a : 0;
        pixels[to + x] = data[from + x] * k; pixels[to + x + 1] = data[from + x + 1] * k; pixels[to + x + 2] = data[from + x + 2] * k; pixels[to + x + 3] = a;
      }
    }
    const c = new OffscreenCanvas(W, H);
    c.getContext('2d').putImageData(new ImageData(pixels, W, H), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  };
  /** The captures of w at this moment. The pixels are read now, in the same task as the tick. */
  const takeStill = (w) => {
    const requests = w.captures.splice(0);
    const tick = w.tick;
    let shot = null;
    try { shot = readStill(w); } catch (e) { fail(w, e); }
    const answer = (blob) => {
      const still = shot ? { blob, x: shot.crop.l / shot.s + w.w / 2, y: shot.crop.t / shot.s + w.h / 2, w: shot.W / shot.s, h: shot.H / shot.s, points: shot.points } : emptyStill(w);
      for (const request of requests) post({ type: 'frame', key: w.key, request, tick, still });
    };
    if (!shot) { answer(null); return; }
    stillBlob(shot).then(answer, () => answer(null));
  };

  // One frame in flight on the GPU. A fence says when the last picture is done, so the queue never grows and
  // the page's own paints do not wait behind a backlog of worlds.
  let gpuBusy = false;
  const gpu = { ms: 0 };
  /** Shares of full resolution while worlds move, and the GPU time per picture (ms) that moves between them. */
  const QUALITY = [1, 0.85, 0.72, 0.6, 0.5];
  const GPU_HIGH = 14, GPU_LOW = 8.5, DROP_AFTER = 5, RISE_AFTER = 45;
  let quality = 0, slowPictures = 0, fastPictures = 0;
  const steer = (ms) => {
    slowPictures = ms > GPU_HIGH ? slowPictures + 1 : 0;
    fastPictures = ms < GPU_LOW ? fastPictures + 1 : 0;
    if (slowPictures >= DROP_AFTER && quality < QUALITY.length - 1) { quality++; slowPictures = 0; }
    if (fastPictures >= RISE_AFTER && quality > 0) { quality--; fastPictures = 0; }
  };
  const watchGpu = () => {
    const gl = renderer.getContext(), sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), start = realNow();
    gl.flush();
    gpuBusy = true;
    const poll = () => {
      const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state !== gl.SIGNALED && !gl.isContextLost()) { nativeSetTimeout(poll, 1); return; }
      gl.deleteSync(sync);
      gpuBusy = false;
      gpu.ms = realNow() - start;
      steer(gpu.ms);
      kick();
    };
    nativeSetTimeout(poll, 1);
  };

  // The frame loop.
  let loop = false, busyFrame = false;
  const wanted = () => {
    if (waiting || gpuBusy || !renderer) return false;
    if (surface.dirty && surface.camera) return true;
    for (const w of worlds.values()) {
      if (due(w)) return true;
      if (w.stale && w.placement && w.placement.shown && !w.culled && !w.failed && (w.setUp || w.ran)) return true;
    }
    return false;
  };
  const frame = async () => {
    if (busyFrame) return;
    busyFrame = true;
    try {
      for (const w of [...worlds.values()]) if (due(w)) await live(w);
      if (!waiting) paint();
    } finally {
      busyFrame = false;
      schedule();
    }
  };
  /** The next display frame, or a timer when display frames do not come (a hidden frame). */
  const schedule = () => {
    if (loop || !wanted()) return;
    loop = true;
    let done = false;
    const go = () => { if (done) return; done = true; loop = false; frame(); };
    nativeRaf(go);
    nativeSetTimeout(go, 100);
  };

  /** Start the next frame now. The page showed the last picture, so the next one reaches its next paint. */
  const kick = () => { if (!loop && wanted()) frame(); };

  const handle = (m) => {
    if (m.type === 'view') {
      surface.camera = m.camera;
      surface.seq = m.seq;
      surface.dirty = true;
      const shown = new Set();
      for (const p of m.placements) {
        const w = worlds.get(idOf(p));
        if (!w) continue;
        shown.add(w);
        w.placement = p;
        w.culled = false;
      }
      for (const w of worlds.values()) if (!shown.has(w)) w.placement = null;
    } else if (m.type === 'resize') sizeSurface(m);
    else if (m.type === 'presented') { if (m.n === sent) { waiting = false; kick(); } }
    else if (m.type === 'add') addWorld(m.world);
    else if (m.type === 'remove') removeWorld(m.key);
    else if (m.type === 'ping') post({ type: 'pong', n: m.n, running: current ? current.key.node : last ? last.key.node : null });
    else {
      const w = m.key ? worlds.get(idOf(m.key)) : null;
      if (!w) {
        if (m.type === 'advance' || m.type === 'capture') post({ type: 'frame', key: m.key, request: m.request, tick: -1, still: { blob: null, x: 0, y: 0, w: 0, h: 0 } });
        return;
      }
      if (m.type === 'clock') follow(w, m);
      else if (m.type === 'live') {
        // A step world reached the tick of its clock: from here it follows the clock live, with the item's params.
        if (!w.stepping || w.failed) return;
        w.stepping = false;
        w.timeline = null;
        w.picked = null;
        w.base = Object.assign({}, m.params);
        Object.assign(w.params, m.params);
        syncParts(w);
        follow(w, m);
      } else if (m.type === 'run') w.running = !!m.on;
      else if (m.type === 'params') {
        w.base = Object.assign({}, m.params);
        Object.assign(w.params, m.params);
        syncParts(w);
        if (held(w) && w.running) redraw(w);
      } else if (m.type === 'size') {
        const resized = m.w !== w.w || m.h !== w.h;
        w.w = m.w; w.h = m.h; w.stale = true;
        if (resized) emit(w, 'resize', { w: w.w, h: w.h, dpr: surface.dpr });
        if (held(w) && w.running) redraw(w);
      } else if (m.type === 'advance') {
        advance(w, m.request, m.to | 0, !!m.capture).catch((e) => fail(w, e));
      } else if (m.type === 'capture') {
        if (w.failed) { post({ type: 'frame', key: w.key, request: m.request, tick: w.tick, still: emptyStill(w) }); return; }
        w.captures.push(m.request);
        if (w.stepping || held(w)) capture(w);
        else {
          // A live world whose display frames do not come gives what it shows now.
          schedule();
          nativeSetTimeout(() => { if (w.captures.includes(m.request)) capture(w); }, 300);
        }
      }
    }
    schedule();
  };

  // Boot: the port comes in the init of the frame (FRAME_HTML), as for a program. The messages wait for three.
  const inbox = [];
  let booted = false, booting = false;
  const boot = async (m) => {
    booting = true;
    try {
      THREE = await import(resolveLibrary('three'));
      // Its own canvas, not the frame's: pictures reach the page by message, so nothing here is on screen.
      canvas = new OffscreenCanvas(1, 1);
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); post({ type: 'lost' }); });
      core = true;
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      renderer.debug.onShaderError = (gl, program, vs, fs) => {
        const info = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n');
        fail(current || last, new Error('A shader did not compile:\n' + info.slice(0, 1500)));
      };
      renderer.setClearColor(0x000000, 0);
      sizeSurface(m);
      makeLook();
      makeSurface();
      core = false;
      booted = true;
      post({ type: 'ready' });
      for (const queued of inbox.splice(0)) handle(queued);
    } catch (e) {
      core = false;
      console.error(e);
      post({ type: 'lost' });
    }
  };

  const receive = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') { if (!booting) boot(m); return; }
    if (!booted) inbox.push(m); else handle(m);
  };

  scope.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object' || m.type !== 'init' || port) return;
    port = m.port;
    port.onmessage = (e) => receive(e.data);
    if (typeof m.width === 'number') receive(m);
  });
`
