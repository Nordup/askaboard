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
 * Uncapped (the performance pill, the benchmark), only the GPU fence paces the
 * pictures, and the page shows the newest one it has.
 */
export const SURFACE = String.raw`
  let THREE = null, renderer = null, canvas = null, compositeMat = null, compositeScene = null, compositeCam = null;
  const surface = { width: 0, height: 0, dpr: 1, margin: 0, camera: null, seq: 0, dirty: false };
  let sent = 0, waiting = false, dead = false, uncapped = false;

  const sizeSurface = (m) => {
    surface.dpr = m.dpr;
    if (typeof m.margin === 'number') surface.margin = m.margin;
    surface.width = Math.max(1, Math.round((m.width + 2 * surface.margin) * m.dpr));
    surface.height = Math.max(1, Math.round((m.height + 2 * surface.margin) * m.dpr));
    surface.dirty = true;
  };

  /**
   * The canvas holds only what worlds cover. surface.width and height stay the space that crops and placements use, and a picture says
   * where it lies in that space. So a small world on a large board costs a small bitmap: here, on the page and in the window server.
   * A pan keeps the size: it grows at once in steps of GRID, and it shrinks only after SHRINK_AFTER pictures that all fit a smaller one.
   */
  const SHRINK_AFTER = 60;
  let canvasW = 0, canvasH = 0, roomy = 0, peakW = 0, peakH = 0;
  const fitCanvas = (W, H) => {
    const needW = Math.max(GRID, Math.ceil(W / GRID) * GRID), needH = Math.max(GRID, Math.ceil(H / GRID) * GRID);
    peakW = roomy ? Math.max(peakW, needW) : needW;
    peakH = roomy ? Math.max(peakH, needH) : needH;
    roomy++;
    if (needW > canvasW || needH > canvasH) {
      canvasW = Math.max(canvasW, needW); canvasH = Math.max(canvasH, needH);
    } else if (roomy < SHRINK_AFTER) return;
    else if (peakW === canvasW && peakH === canvasH) { roomy = 0; return; }
    else { canvasW = peakW; canvasH = peakH; }
    roomy = 0;
    renderer.setSize(canvasW, canvasH, false);
  };

  /** Where the outputs of these worlds fall on the surface, in whole pixels, or null when nowhere. */
  const coverOf = (list) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const w of list) {
      const d = w.drawn, p = placed(w), k = p.s / d.s;
      for (let i = 0; i < 4; i++) {
        const qx = (i & 1 ? d.crop.r : d.crop.l) * k, qy = (i & 2 ? d.crop.b : d.crop.t) * k;
        const x = p.cx + p.a * qx + p.c * qy, y = p.cy + p.b * qx + p.d * qy;
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
    l = Math.max(0, Math.floor(l)); t = Math.max(0, Math.floor(t)); r = Math.min(surface.width, Math.ceil(r)); b = Math.min(surface.height, Math.ceil(b));
    return r > l && b > t ? { l, t, r, b } : null;
  };

  /** Draw a world's output onto the canvas, whose top-left is (x, y) on the surface: premultiplied, with its opacity and its wipe. */
  const compositeWorld = (w, x, y) => {
    const d = w.drawn, p = placed(w), u = compositeMat.uniforms;
    const ox = d.crop.l, oy = d.crop.t, qw = d.crop.r - d.crop.l, qh = d.crop.b - d.crop.t;
    const scale = p.s / d.s;
    const toClipX = 2 / canvasW, toClipY = -2 / canvasH;
    u.origin.value.set((p.cx - x + (p.a * ox + p.c * oy) * scale) * toClipX - 1, (p.cy - y + (p.b * ox + p.d * oy) * scale) * toClipY + 1);
    u.axisX.value.set(p.a * qw * scale * toClipX, p.b * qw * scale * toClipY);
    u.axisY.value.set(p.c * qh * scale * toClipX, p.d * qh * scale * toClipY);
    const output = w.output;
    u.t.value = output.texture;
    u.used.value.set(output.useW / output.width, output.useH / output.height);
    u.edge.value.set(0.5 / output.width, 0.5 / output.height);
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
      uniforms: { t: { value: null }, used: { value: new THREE.Vector2(1, 1) }, edge: { value: new THREE.Vector2() }, opacity: { value: 1 }, reveal: { value: 1 }, span: { value: new THREE.Vector2(0, 1) }, origin: { value: new THREE.Vector2() }, axisX: { value: new THREE.Vector2() }, axisY: { value: new THREE.Vector2() } },
      vertexShader: 'uniform vec2 origin, axisX, axisY; varying vec2 vUv; void main(){ vUv = uv; vec2 q = vec2(uv.x, 1.0 - uv.y); gl_Position = vec4(origin + axisX * q.x + axisY * q.y, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D t; uniform float opacity, reveal; uniform vec2 span, used, edge; varying vec2 vUv;',
        // The output is larger than its picture: nothing past the picture's last pixel may join the filter.
        'void main(){ vec4 c = texture2D(t, clamp(vUv * used, edge, used - edge)); float k = opacity;',
        'if (reveal < 1.0) { float e = (vUv.x - span.x) / (span.y - span.x); k *= 1.0 - smoothstep(reveal * 1.2 - 0.2, reveal * 1.2, e); }',
        'gl_FragColor = c * k; }'
      ].join('\n')
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0), compositeMat);
    mesh.frustumCulled = false;
    compositeScene.add(mesh);
  };

  /**
   * A sharp picture at rest is the point of a still world. On a weak machine its size has a ceiling: one world's targets, with their samples and
   * with film's passes, fill the memory that the device has. deviceMemory gives 2, 4 or 8 and more; Safari gives nothing, and then the middle counts.
   */
  const CEILING_MP_PER_GB = 2, CEILING_FROM_GB = 8;
  const memoryGb = scope.navigator.deviceMemory || 4;
  const ceilingShare = (crop) => {
    if (memoryGb >= CEILING_FROM_GB) return 1;
    const pixels = (crop.r - crop.l) * (crop.b - crop.t);
    return Math.min(1, Math.sqrt((memoryGb * CEILING_MP_PER_GB * 1e6) / pixels));
  };

  /** What world w needs for this view: its crop, or null when none of its reach is on the surface. A world there gives back its output. */
  const planWorld = (w) => {
    const place = placed(w);
    if (!w.reach || w.stale) measureReach(w, false);
    const crop = cropFor(w, place);
    w.culled = !crop;
    if (!crop) {
      if (w.output) { giveOutput(w.output); w.output = null; w.drawn = null; }
      return null;
    }
    const old = w.drawn, same = old && Math.abs(old.s - place.s) < 1e-6;
    if (!w.stale && !w.sharpen && same && contains(old.crop, crop)) return null;
    // Quality falls only while a world moves. It renders sharp again when it rests.
    const zooming = !!old && !same;
    if (zooming) w.movedAt = sent;
    const quality = w.moving || zooming ? w.quality : 0, res = Math.min(QUALITY[quality], ceilingShare(crop));
    // A size stays on the grid at any resolution, so a change of crop or of quality meets the sizes that the pool already has.
    const W = Math.max(GRID, Math.ceil(((crop.r - crop.l) * res) / GRID) * GRID), H = Math.max(GRID, Math.ceil(((crop.b - crop.t) * res) / GRID) * GRID);
    const m = surface.margin * surface.dpr;
    const seen = place.cx + crop.r * Math.abs(place.a) + crop.b * Math.abs(place.c) > m && place.cx + crop.l * Math.abs(place.a) - crop.b * Math.abs(place.c) < surface.width - m
      && place.cy + crop.b > m && place.cy + crop.t < surface.height - m;
    return { w, place, crop, quality, W, H, pixels: W * H, seen };
  };

  /**
   * The first picture of a world must not stall the others on its shaders. So its programs start here, and three does not wait for them, and the
   * world draws once they are linked. Not three's compileAsync: it waits with the global setTimeout, and here a global timer belongs to a world.
   * COMPILE_MS: a driver with no answer must not hold a world back. New materials later compile in their render, as in three.
   */
  const COMPILE_MS = 4000;
  const prepareWorld = (plan) => {
    const { w, place, crop, W, H } = plan, direct = isDirect(lookOf(w)), samples = samplesAt(0);
    const target = takeOutput(W, H, direct, samples);
    let list;
    try { list = renderWorld(w, place.s, crop, innerOf(w, place.s, crop), target, samples, surface.dpr, true); } finally { giveOutput(target); }
    w.compiling = true;
    const started = realNow();
    const poll = () => {
      for (const m of list) {
        const program = renderer.properties.get(m).currentProgram;
        if (!program || program.isReady()) list.delete(m);
      }
      if (list.size && !dead && worlds.has(w.id) && realNow() - started < COMPILE_MS) { nativeSetTimeout(poll, 8); return; }
      w.compiling = false;
      w.prepared = true;
      schedule();
    };
    poll();
  };

  /** A world with no frame callback counts no ticks. Its first picture after setup counts as a frame, so the page knows that its setup ended. */
  const firstPicture = (w) => {
    if (!w.setUp || w.count > 0) return;
    w.count = 1;
    post({ type: 'alive', key: w.key, frames: w.count, tick: w.tick });
  };

  const renderPlan = (plan) => {
    const { w, place, crop, quality, W, H } = plan;
    const direct = isDirect(lookOf(w)), samples = samplesAt(quality);
    // A world that is stale can show something new. A new zoom or a sharp picture at rest cannot.
    if (w.stale) w.content++;
    if (w.output && fitsOutput(w.output, W, H, direct, samples)) useOutput(w.output, W, H);
    else {
      if (w.output) giveOutput(w.output);
      w.output = takeOutput(W, H, direct, samples);
    }
    renderWorld(w, place.s, crop, innerOf(w, place.s, crop), w.output, samples, surface.dpr);
    w.drawn = { s: place.s, crop, quality };
    w.stale = false;
    w.sharpen = false;
    w.moving = false;
    w.waited = 0;
    w.renders = (w.renders || 0) + 1;
    nextFence.push(w, (W * H) / 1e6);
    if (meter) meter.rendered++;
    w.shownPoints = measurePoints(w);
    firstPicture(w);
  };

  /**
   * Where the published points and the pins of w are now, in nominal board points from the anchor, with a flag for each: shown or not.
   * A world code error here stops that world.
   */
  const measurePoints = (w) => {
    const list = [];
    if (!w.parts.size && !w.pins.size) return list;
    const c = w.camera, v = new THREE.Vector3(), view = new THREE.Vector3();
    nominalCamera(w);
    w.scene.updateMatrixWorld();
    // v is a world point.
    const add = (name, shown) => {
      let seen = shown;
      view.copy(v).applyMatrix4(c.matrixWorldInverse);
      if (c.isPerspectiveCamera && view.z > -c.near) seen = false;
      v.applyMatrix4(c.matrixWorldInverse).applyMatrix4(c.projectionMatrix);
      const x = (v.x * w.w) / 2, y = (-v.y * w.h) / 2, r = w.reach;
      if (!r || (!r.full && (x < r.l || x > r.r || y < r.t || y > r.b))) seen = false;
      list.push([name, x, y, seen]);
    };
    const chain = (t) => { for (let o = t; o; o = o.parent) if (!o.visible) return false; return true; };
    for (const [name, part] of w.parts) {
      const t = part.target;
      if (t === null || t === undefined) continue;
      if (t.isObject3D) { t.getWorldPosition(v); add(name, chain(t)); }
      else if (t.isVector3) { v.copy(t).applyMatrix4(w.root.matrixWorld); add(name, true); }
      else {
        const at = inside(w, () => { try { return t(); } catch (e) { fail(w, e); return null; } });
        if (!at) continue;
        v.set(at[0], at[1], at[2]).applyMatrix4(w.root.matrixWorld);
        add(name, true);
      }
    }
    // A pin keeps its place on the part, and it hides when its surface faces away from the camera.
    const normal = new THREE.Vector3(), eye = new THREE.Vector3();
    for (const pin of w.pins.values()) {
      const part = w.parts.get(pin.part), t = part && part.target;
      if (!t || !t.isObject3D) continue;
      v.copy(pin.local).applyMatrix4(t.matrixWorld);
      normal.copy(pinNormal(pin, t)).transformDirection(t.matrixWorld);
      if (c.isPerspectiveCamera) eye.setFromMatrixPosition(c.matrixWorld).sub(v);
      else c.getWorldDirection(eye).negate();
      add('pin:' + pin.id, chain(t) && normal.dot(eye) > 0);
    }
    return list;
  };
  /** The points of all placed worlds on the board, for one picture. */
  const boardPoints = () => {
    const points = {}, from = {};
    for (const w of worlds.values()) {
      const p = w.placement;
      // Only a generation that shows speaks for its node: one that catches up unseen must not touch the old one's points.
      if (!p || !p.shown || (!w.parts.size && !w.pins.size) || w.failed || !(w.setUp || w.ran)) continue;
      if (from[w.key.node] > w.key.generation) continue;
      from[w.key.node] = w.key.generation;
      const m = p.matrix, cx = p.x + p.w / 2 + m[4] + w.moved.x, cy = p.y + p.h / 2 + m[5] + w.moved.y, own = {};
      // A world that waits for its turn shows its last output, so its points stay those of that output.
      for (const [name, x, y, seen] of w.drawn ? w.shownPoints : measurePoints(w)) own[name] = [cx + m[0] * x + m[2] * y, cy + m[1] * x + m[3] * y, seen];
      points[w.key.node] = own;
    }
    return points;
  };

  /**
   * One picture of the surface, when something changed. Worlds that need a render take turns inside a budget of GPU time:
   * visible worlds first, then the largest, and a world that waited moves up. So a heavy world cannot stall the others,
   * and a world that waits shows its last output. At least one world renders per picture.
   */
  const PICTURE_MS = 26;
  /** The worlds of the last picture. */
  let pictured = [];
  const paint = () => {
    if (!surface.camera || dead) return;
    let changed = surface.dirty;
    core = true;
    paintId++;
    painting = true;
    try {
      const plans = [];
      for (const w of worlds.values()) {
        const p = w.placement;
        if (!p || !p.shown || w.failed || !(w.setUp || w.ran)) continue;
        const began = meter ? realNow() : 0;
        if (w.ticked) {
          w.ticked = false;
          const changed = pictureChanged(w);
          if (meter) meter.checkMs += realNow() - began;
          if (changed) w.stale = true;
          w.moving = changed && w.timeMoved;
          if (w.moving) w.movedAt = sent;
          w.timeMoved = false;
        }
        // At rest a world goes sharp once, and then nothing renders.
        if (w.compiling) continue;
        if (!w.moving && w.drawn && w.drawn.quality > 0) w.sharpen = true;
        if (!w.stale && !w.sharpen && w.drawn && w.reach && !cropMoved(w)) continue;
        const planned = meter ? realNow() : 0;
        try {
          const plan = planWorld(w);
          if (plan) { if (w.prepared) plans.push(plan); else prepareWorld(plan); }
        } catch (e) { fail(w, e); }
        if (meter) meter.planMs += realNow() - planned;
      }
      plans.sort((a, b) => (b.seen ? 1 : 0) - (a.seen ? 1 : 0) || b.pixels * (1 + 2 * b.w.waited) - a.pixels * (1 + 2 * a.w.waited));
      let spent = 0, pixels = 0;
      skipped = 0;
      if (meter) meterBegin();
      for (const plan of plans) {
        const cost = costOf(plan.w, plan.pixels / 1e6);
        if (pixels > 0 && spent + cost > PICTURE_MS) { plan.w.waited++; skipped++; continue; }
        spent += cost;
        pixels += plan.pixels;
        try { renderPlan(plan); changed = true; } catch (e) { fail(plan.w, e); }
      }
      trimTargets();
      const list = [];
      for (const w of worlds.values()) if (w.placement && w.placement.shown && w.output && w.drawn && !w.culled) list.push(w);
      // An output that left or joined the picture is a change with no render: the page must not keep its pixels.
      if (list.length !== pictured.length || list.some((w) => !pictured.includes(w))) changed = true;
      if (!changed) { if (meter) meterDrop(); return; }
      pictured = list;
      list.sort((a, b) => a.placement.z - b.placement.z);
      const cover = coverOf(list);
      fitCanvas(cover ? cover.r - cover.l : 1, cover ? cover.b - cover.t : 1);
      const x = cover ? cover.l : 0, y = cover ? cover.t : 0;
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      if (cover) for (const w of list) compositeWorld(w, x, y);
      if (meter) meterStop();
      const bitmap = canvas.transferToImageBitmap();
      if (meter) meterEnd(pixels, skipped, canvasW * canvasH);
      surface.dirty = false;
      waiting = !uncapped;
      sent++;
      const box = { x: x / surface.dpr - surface.margin, y: y / surface.dpr - surface.margin, width: canvasW / surface.dpr, height: canvasH / surface.dpr };
      post({ type: 'picture', n: sent, seq: surface.seq, camera: surface.camera, box, bitmap, points: boardPoints() }, [bitmap]);
      fenced = nextFence;
      nextFence = [];
      watchGpu();
    } finally {
      painting = false;
      core = false;
    }
  };

  // A view moved. True when the output of w no longer covers what the surface needs.
  const cropMoved = (w) => {
    const p = placed(w);
    if (Math.abs(w.drawn.s - p.s) > 1e-6) return true;
    const crop = cropFor(w, p);
    return !!crop && !contains(w.drawn.crop, crop);
  };

  /** A still: its full reach with glow and floor, within these limits. */
  const STILL_MAX = 4096, STILL_PIXELS = 2000000;
  /** Render one still of world w, at its full reach, and read it before anything else uses the target. It needs no view. */
  const readStill = (w) => {
    if (dead) return null;
    announce(null);
    core = true;
    let target = null;
    try {
      measureReach(w, true);
      w.content++;
      const nominal = { l: -w.w / 2, t: -w.h / 2, r: w.w / 2, b: w.h / 2 };
      const reach = !w.reach ? null : w.reach.full ? nominal : w.reach;
      if (!reach) return null;
      // The glow's room is in board points, so the size in points does not depend on the scale.
      const glow = lookOf(w).bloom > 0 ? GLOW_ROOM : SOFT_ROOM / 2;
      const pw = reach.r - reach.l + 2 * glow, ph = reach.b - reach.t + 2 * glow;
      const s = Math.max(0.1, Math.min(Math.max(1, Math.min(2, surface.dpr)), Math.sqrt(STILL_PIXELS / (pw * ph)), (STILL_MAX - 2 * GRID) / Math.max(pw, ph)));
      const crop = snapped((reach.l - glow) * s, (reach.t - glow) * s, (reach.r + glow) * s, (reach.b + glow) * s);
      if (!crop) return null;
      const W = crop.r - crop.l, H = crop.b - crop.t;
      target = takeOutput(W, H, isDirect(lookOf(w)), samplesAt(0));
      // A still has no view, and s can be under the device pixel ratio: its line keeps the same width on the board.
      renderWorld(w, s, crop, w.reach.full ? crop : innerOf(w, s, crop), target, samplesAt(0), s);
      const read = readPixels(target, W, H);
      firstPicture(w);
      const points = {};
      for (const [name, x, y, seen] of measurePoints(w)) points[name] = [x + w.w / 2 + w.moved.x, y + w.h / 2 + w.moved.y, seen];
      // All that the answer says is fixed here. The world can resize or move while the pixels come back.
      return { read, W, H, x: crop.l / s + w.w / 2 + w.moved.x, y: crop.t / s + w.h / 2 + w.moved.y, w: W / s, h: H / s, points };
    } finally {
      if (target) giveOutput(target);
      trimTargets();
      core = false;
      announce(setting);
    }
  };
  /**
   * Copy a target's pixels on the GPU, now, and give them when the GPU is done. The copy is in the GL queue before this returns, so the
   * target can go back to the pool at once, and all worlds keep their frames. Not three's own read: it waits with the global setTimeout, and
   * here a global timer belongs to a world, and a paused world fires none.
   */
  const readPixels = (target, W, H) => {
    const gl = renderer.getContext(), buffer = gl.createBuffer(), state = renderer.state;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    state.bindFramebuffer(gl.FRAMEBUFFER, renderer.properties.get(target).__webglFramebuffer);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    state.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve) => {
      const poll = () => {
        if (dead || gl.isContextLost()) { resolve(null); return; }
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED) { nativeSetTimeout(poll, 2); return; }
        gl.deleteSync(sync);
        const data = new Uint8Array(W * H * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(buffer);
        resolve(data);
      };
      nativeSetTimeout(poll, 2);
    });
  };
  /** The picture of a still as a PNG. The rows flip in short turns, so the worlds on this worker do not wait for it. */
  const stillBlob = async (shot) => {
    const data = await shot.read, { W, H } = shot;
    if (!data) return null;
    const pixels = new Uint8ClampedArray(W * H * 4);
    let turn = realNow();
    for (let y = 0; y < H; y++) {
      if ((y & 31) === 0 && realNow() - turn > 4) { await nextTask(); turn = realNow(); }
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
  /** The captures of w at this moment. The picture is drawn now, in the same task as the tick, and all of the answer is fixed now. */
  const takeStill = (w) => {
    const requests = w.captures.splice(0);
    const tick = w.tick, empty = emptyStill(w);
    let shot = null;
    try { shot = readStill(w); } catch (e) { fail(w, e); }
    const answer = (blob) => {
      const still = shot ? { blob, x: shot.x, y: shot.y, w: shot.w, h: shot.h, points: shot.points } : empty;
      for (const request of requests) post({ type: 'frame', key: w.key, request, tick, still });
    };
    if (!shot) { answer(null); return; }
    stillBlob(shot).then(answer, () => answer(null));
  };

  // One frame in flight on the GPU. A fence says when the last picture is done, so the queue never grows and
  // the page's own paints do not wait behind a backlog of worlds.
  let gpuBusy = false;
  const gpu = { ms: 0 };
  /**
   * The steps of a moving world: its share of full resolution, and its anti-aliasing samples. Samples fall first, 0.5 is a pixel ratio of 1 on
   * a Retina screen, and a world at rest always has step 0. GPU_HIGH: the fence time per picture (ms) that a moving world must stay under.
   */
  const QUALITY = [1, 1, 0.85, 0.72, 0.6, 0.5], SAMPLES = [4, 2, 2, 2, 0, 0];
  const samplesAt = (quality) => Math.min(tune.msaa ?? 4, weakGpu && quality > 0 ? 0 : memoryGb < 4 ? 2 : SAMPLES[quality]);
  const GPU_HIGH = 14, DROP_AFTER = 5, RISE_AFTER = 30;
  /**
   * An Intel GPU shares a narrow bus with memory, and HDR targets with samples fill it. So a moving world there has no samples from its first
   * step, and it starts on that step. The picture at rest keeps its samples.
   */
  let weakGpu = false;
  const isIntegrated = (gl) => {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return /intel/i.test(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
  };
  /** What a fence takes with no work: it reads back late. So only the time over this is work of the worlds. */
  const FENCE_FLOOR = 5;
  /** A world's first guess, and the share of its time that it takes as fixed while it renders at one size only. */
  const COST_SLOPE = 3, COST_FIXED = 0.2, COST_KEEP = 0.95;
  /** Hysteresis: a rise must leave this share of the budget free. A drop soon after a rise doubles the wait before the next rise of that world. */
  const RISE_ROOM = 0.85, HOLD_FIRST = 60, HOLD_MOST = 960, BOUNCE = 120;
  let smooth = 0, slowPictures = 0, fastPictures = 0, skipped = 0;
  /** World and megapixels of each render of the picture that the GPU works on, then of the next one. */
  let fenced = [], nextFence = [];
  const newCost = () => ({ n: 0, x: 0, y: 0, xx: 0, xy: 0, fixed: 0, slope: COST_SLOPE });
  /** Ms of a render of w at mp megapixels. */
  const costOf = (w, mp) => w.cost.fixed + w.cost.slope * mp;
  /**
   * What w costs: passes and geometry that no resolution changes, and a share that grows with its pixels. A fading mean of (megapixels, ms) gives
   * the line, once the sizes differ enough to show one. Until then the line goes through the mean with a fixed share.
   */
  const learnCost = (w, mp, ms) => {
    const c = w.cost;
    c.n = c.n * COST_KEEP + 1; c.x = c.x * COST_KEEP + mp; c.y = c.y * COST_KEEP + ms; c.xx = c.xx * COST_KEEP + mp * mp; c.xy = c.xy * COST_KEEP + mp * ms;
    const spread = c.n * c.xx - c.x * c.x;
    if (spread > 0.01 * c.n * c.xx) {
      c.slope = Math.max(0, (c.n * c.xy - c.x * c.y) / spread);
      c.fixed = Math.max(0, (c.y - c.slope * c.x) / c.n);
    } else {
      c.fixed = (c.y / c.n) * COST_FIXED;
      c.slope = ((c.y / c.n) * (1 - COST_FIXED)) / Math.max(c.x / c.n, 1e-3);
    }
  };
  /** The time of a picture, shared over its worlds by what each should cost. */
  const learnPicture = (ms) => {
    const work = Math.max(0, ms - FENCE_FLOOR);
    let whole = 0;
    for (let i = 0; i < fenced.length; i += 2) whole += costOf(fenced[i], fenced[i + 1]);
    for (let i = 0; i < fenced.length; i += 2) learnCost(fenced[i], fenced[i + 1], whole > 0 ? (work * costOf(fenced[i], fenced[i + 1])) / whole : 0);
    fenced.length = 0;
  };
  /** The share of a world's megapixels at full quality. */
  const fullMp = (w) => (w.drawn ? ((w.drawn.crop.r - w.drawn.crop.l) * (w.drawn.crop.b - w.drawn.crop.t)) / 1e6 : 0);
  /** Ms that a world gives back between two steps of resolution. */
  const gainOf = (w, from, to) => w.cost.slope * fullMp(w) * (QUALITY[from] ** 2 - QUALITY[to] ** 2);
  /**
   * Each world keeps its own step. A slow stretch, or a world left waiting, lowers the moving world whose pixels cost most, at once, to what the
   * budget allows. A world whose time does not grow with its pixels stays sharp: a lower resolution would buy nothing. The time is smoothed and
   * clamped, so a spike from another app or a shader compile moves nothing. A rise comes only when the next step fits with room, and a world
   * that falls again soon after a rise waits longer each time, so no world swings between two steps.
   */
  const steer = (ms) => {
    learnPicture(ms);
    const high = tune.budget ?? GPU_HIGH;
    smooth += (Math.min(ms, high * 2) - smooth) * 0.15;
    const slow = smooth > high || skipped > 0;
    slowPictures = slow ? slowPictures + 1 : 0;
    fastPictures = slow ? 0 : fastPictures + 1;
    const last = QUALITY.length - 1;
    if (slowPictures >= DROP_AFTER && tune.adaptive !== 0) {
      slowPictures = 0;
      let pick = null, best = 0;
      // A render clears w.moving, so what moved in the last pictures counts.
      for (const w of worlds.values()) {
        if (sent - w.movedAt >= 3 || w.culled || w.quality >= last) continue;
        const gain = gainOf(w, w.quality, last);
        if (gain > best) { best = gain; pick = w; }
      }
      if (pick) {
        const from = pick.quality;
        pick.quality++;
        while (pick.quality < last && smooth - gainOf(pick, from, pick.quality) > high) pick.quality++;
        if (sent - pick.roseAt < BOUNCE) { pick.hold = Math.min(HOLD_MOST, Math.max(HOLD_FIRST, pick.hold * 2)); pick.heldUntil = sent + pick.hold; }
      }
    }
    if (fastPictures >= RISE_AFTER) {
      fastPictures = 0;
      let pick = null;
      for (const w of worlds.values()) if (w.quality > 0 && sent >= w.heldUntil && (!pick || fullMp(w) < fullMp(pick))) pick = w;
      if (pick && smooth + gainOf(pick, pick.quality - 1, pick.quality) < high * RISE_ROOM) { pick.quality--; pick.roseAt = sent; }
    }
  };
  const watchGpu = () => {
    const gl = renderer.getContext(), sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), start = realNow(), began = meter ? meter.began : 0;
    gl.flush();
    gpuBusy = true;
    const poll = () => {
      const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state !== gl.SIGNALED && !gl.isContextLost()) { nativeSetTimeout(poll, 1); return; }
      gl.deleteSync(sync);
      gpuBusy = false;
      gpu.ms = realNow() - start;
      if (meter) meterFence(gpu.ms, realNow() - began);
      steer(gpu.ms);
      kick();
    };
    // One wait for most of the time that the last fences took. A chain of short timers would pay for it twice: a poll per
    // millisecond, and after five nested timers the browser's clamp of 4 ms, which can make a picture miss the display's beat.
    nativeSetTimeout(poll, Math.max(1, smooth * 0.5));
  };

  // The frame loop.
  let loop = false, busyFrame = false, ticket = 0;
  const wanted = () => {
    if (waiting || gpuBusy || busyFrame || !renderer || dead) return false;
    if (surface.dirty && surface.camera) return true;
    for (const w of worlds.values()) {
      if (due(w)) return true;
      // A world below full quality has one sharp render still to come, even when no tick will ask for it.
      if ((w.stale || (w.drawn && w.drawn.quality > 0)) && !w.compiling && w.placement && w.placement.shown && !w.culled && !w.failed && (w.setUp || w.ran)) return true;
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
    if (loop) return;
    if (!wanted()) { wakeForTimers(); return; }
    loop = true;
    const mine = ++ticket;
    const go = () => { if (mine !== ticket) return; ticket++; loop = false; frame(); };
    if (uncapped) { nativeSetTimeout(go, 0); return; }
    nativeRaf(go);
    nativeSetTimeout(go, 100);
  };

  /** What the GPU holds, and the renders per world, for a check that nothing leaks. */
  const infoNow = () => {
    const renders = {};
    for (const w of worlds.values()) renders[w.key.node] = w.renders || 0;
    return { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs ? renderer.info.programs.length : 0, targets: shared.size + spareOutputs.length, renders };
  };

  /** Start the next frame now, in place of any wait: the page showed the last picture, so the next one reaches its next paint. */
  const kick = () => { if (!wanted()) return; ticket++; loop = false; frame(); };

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
    else if (m.type === 'stats') setStats(m.on);
    else if (m.type === 'uncapped') { uncapped = m.on || !!tune.uncapped; if (uncapped) waiting = false; }
    else if (m.type === 'ping') post({ type: 'pong', n: m.n, running: current ? current.key.node : last ? last.key.node : null, info: infoNow() });
    else {
      const w = m.key ? worlds.get(idOf(m.key)) : null;
      if (!w) {
        if (m.type === 'advance' || m.type === 'capture') post({ type: 'frame', key: m.key, request: m.request, tick: -1, still: { blob: null, x: 0, y: 0, w: 0, h: 0 } });
        if (m.type === 'pick') post({ type: 'picked', key: m.key, request: m.request, hit: null });
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
      } else if (m.type === 'pointer') pointerEvent(w, m.event);
      else if (m.type === 'pick') post({ type: 'picked', key: w.key, request: m.request, hit: w.failed ? null : pickedOf(pickAt(w, m.x, m.y)) });
      else if (m.type === 'pin') addPin(w, m.pin);
      else if (m.type === 'unpin') { w.pins.delete(m.id); w.stale = true; }
      else if (m.type === 'ink') addStroke(w, m.stroke);
      else if (m.type === 'inkgone') dropStroke(w, m.id);
      else if (m.type === 'advance') {
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
      watchLoaders();
      // Its own canvas, not the frame's: pictures reach the page by message, so nothing here is on screen.
      canvas = new OffscreenCanvas(1, 1);
      // No restore in place: the page starts a new worker and adds its worlds again.
      canvas.addEventListener('webglcontextlost', () => { if (dead) return; dead = true; post({ type: 'lost' }); });
      core = true;
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      renderer.debug.onShaderError = (gl, program, vs, fs) => {
        if (gl.isContextLost()) return;
        const info = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n');
        // Shaders compile inside a render, so the world being rendered is at fault. The runtime's own passes belong to nobody.
        const error = new Error('A shader did not compile:\n' + info.slice(0, 1500)), at = rendering || (core ? null : current || last);
        if (at) fail(at, error); else console.error(error);
      };
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(1);
      setTune(m.tune);
      weakGpu = !!tune.integrated || isIntegrated(renderer.getContext());
      uncapped = !!tune.uncapped;
      sizeSurface(m);
      watchResources();
      makeToon();
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
