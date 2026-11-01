/**
 * The realm of the world worker. All worlds run here and share one `three`.
 * The clock rules of a world: item time, scene time, step events, a hold on
 * pause, and a tick grid of WORLD_TICK_HZ for previews. Playback is live and
 * has no grid: each display frame runs one frame at the clock's time now.
 *
 * Who owns the globals. performance.now, Date, Math.random, the timers and
 * requestAnimationFrame go to the world whose code runs at that moment (see
 * `owner`). A world's top level runs alone (`setupQueue`), so its code keeps
 * that link after an await. Later, in a tick, the link can be lost after an
 * await, and the globals go to the world that ran last. So agents use
 * world.time.
 */
export const REALM = String.raw`
  const perf = scope.performance;
  const realNow = perf.now.bind(perf);
  const origin = perf.timeOrigin;
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const nativeSetInterval = scope.setInterval.bind(scope);
  const nativeClearTimeout = scope.clearTimeout.bind(scope);
  const nativeRaf = typeof scope.requestAnimationFrame === 'function' ? scope.requestAnimationFrame.bind(scope) : (cb) => nativeSetTimeout(() => cb(realNow()), 16);
  const RealDate = scope.Date;
  const Channel = scope.MessageChannel;
  const TICK_MS = 1000 / hz;
  const tickOf = (t) => Math.max(0, Math.floor(t * hz + 1e-6));
  const nextTask = () => new Promise((resolve) => { const ch = new Channel(); ch.port1.onmessage = () => { ch.port1.close(); resolve(); }; ch.port2.postMessage(0); });

  /** The page's port. */
  let port = null;
  const post = (m, transfer) => { if (port) port.postMessage(m, transfer || []); };

  /** World id (node and generation) to world. */
  const worlds = new Map();
  const idOf = (key) => key.node + '#' + key.generation;

  // The world whose code runs now; the world in its top level; the world that ran last.
  let current = null, setting = null, last = null;
  // True while the runtime itself renders: the globals are real then, and no world's numbers are used.
  let core = false;
  const owner = () => (core ? null : current || setting || last);
  // Who runs, for the page: a worker in an endless loop answers no ping, so the page keeps the last of these.
  // Only changes go out. A paint does not reset it, so a world alone on a board costs no message per tick.
  let announced = null;
  const announce = (w) => {
    if (w === announced) return;
    announced = w;
    post({ type: 'running', running: w ? w.key : null });
  };
  /** Run fn as world w. */
  const inside = (w, fn) => {
    const previous = current;
    current = w;
    last = w;
    announce(w);
    try { return fn(); } finally { current = previous; }
  };

  // Seeded Math.random (sfc32), one state per world.
  const coreState = new Int32Array(4);
  const randomOf = (rs) => {
    const a = rs[0], b = rs[1], c = rs[2], d = rs[3];
    const t = (((a + b) | 0) + d) | 0;
    rs[3] = (d + 1) | 0;
    rs[0] = b ^ (b >>> 9);
    rs[1] = (c + (c << 3)) | 0;
    rs[2] = (((c << 21) | (c >>> 11)) + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const seedState = (rs, seed) => { rs[0] = 0x9e3779b9; rs[1] = 0x243f6a88; rs[2] = 0xb7e15162; rs[3] = seed | 0; for (let i = 0; i < 15; i++) randomOf(rs); };
  seedState(coreState, 1);
  Object.defineProperty(Math, 'random', { value: () => { const w = owner(); return randomOf(w ? w.rs : coreState); }, configurable: true, writable: true });

  // Time.
  try { Object.defineProperty(perf, 'now', { value: () => { const w = owner(); return w ? w.tickMs : realNow(); }, configurable: true, writable: true }); } catch (e) {}
  const dateNow = () => { const w = owner(); return w && w.stepping ? w.dateBase + w.tickMs : RealDate.now(); };
  function VDate(...a) {
    if (!new.target) return new RealDate(dateNow()).toString();
    return a.length ? new RealDate(...a) : new RealDate(dateNow());
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = dateNow; VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  scope.Date = VDate;

  // Timers: due in the item time of their world, fired at the start of its frame. Each world has a heap, by due time and then by age. A cancelled
  // timer stays in the heap until it comes to the top or until the cancelled ones are the most of it.
  let timerSeq = 0, timerOrder = 0;
  const sooner = (a, b) => a.due < b.due || (a.due === b.due && a.order < b.order);
  const heapAdd = (heap, timer) => {
    let i = heap.length;
    heap.push(timer);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!sooner(timer, heap[up])) break;
      heap[i] = heap[up];
      i = up;
    }
    heap[i] = timer;
  };
  const heapTake = (heap) => {
    const top = heap[0], last = heap.pop(), n = heap.length;
    if (!n) return top;
    let i = 0;
    for (;;) {
      let down = 2 * i + 1;
      if (down >= n) break;
      if (down + 1 < n && sooner(heap[down + 1], heap[down])) down++;
      if (!sooner(heap[down], last)) break;
      heap[i] = heap[down];
      i = down;
    }
    heap[i] = last;
    return top;
  };
  /** The next timer of w that still counts, or null. */
  const nextTimer = (w) => {
    const heap = w.timerHeap;
    while (heap.length && heap[0].cancelled) heapTake(heap);
    return heap.length ? heap[0] : null;
  };
  const addTimer = (w, cb, ms, args, every) => {
    if (typeof cb !== 'function') return 0;
    const id = ++timerSeq;
    const delay = Math.max(0, Number(ms) || 0);
    const timer = { id, due: w.tickMs + delay, cb, args, every: every ? Math.max(1, delay) : 0, order: timerOrder++, cancelled: false };
    w.timers.set(id, timer);
    heapAdd(w.timerHeap, timer);
    schedule();
    return id;
  };
  const cancelTimer = (w, id) => {
    const timer = w.timers.get(id);
    if (!timer) return;
    timer.cancelled = true;
    w.timers.delete(id);
    const heap = w.timerHeap;
    if (heap.length < 64 || heap.length < 2 * w.timers.size) return;
    const live = heap.filter((t) => !t.cancelled);
    heap.length = 0;
    for (const t of live) heapAdd(heap, t);
  };
  scope.setTimeout = (cb, ms, ...args) => { const w = owner(); return w ? addTimer(w, cb, ms, args, false) : nativeSetTimeout(cb, ms, ...args); };
  scope.setInterval = (cb, ms, ...args) => { const w = owner(); return w ? addTimer(w, cb, ms, args, true) : nativeSetInterval(cb, ms, ...args); };
  scope.clearTimeout = scope.clearInterval = (id) => { for (const w of worlds.values()) cancelTimer(w, id); };
  // The timers of w due by item time 'until', in order. True when one fired.
  const fireTimers = (w, until) => {
    let fired = false;
    for (let guard = 0; guard < 10000 && !w.failed; guard++) {
      const timer = nextTimer(w);
      if (!timer || timer.due > until) break;
      heapTake(w.timerHeap);
      if (timer.every) { timer.due += timer.every; timer.order = timerOrder++; heapAdd(w.timerHeap, timer); } else w.timers.delete(timer.id);
      fired = true;
      try { timer.cb(...timer.args); } catch (e) { fail(w, e); }
    }
    return fired;
  };

  let frameSeq = 0;
  scope.requestAnimationFrame = (cb) => {
    const w = owner();
    if (!w) return nativeRaf(cb);
    const id = ++frameSeq;
    w.callbacks.set(id, cb);
    schedule();
    return id;
  };
  scope.cancelAnimationFrame = (id) => { for (const w of worlds.values()) w.callbacks.delete(id); };

  /** Lines that new AsyncFunction puts before the code. */
  const HEADER_LINES = 2;
  /** A clean message: positions in the world's lines, no frames of the runtime. */
  const messageOf = (error) => {
    const text = error && error.stack ? String(error.stack) : error && error.message ? String(error.message) : String(error);
    return text
      .replace(/world\.js:(\d+):(\d+)/g, (_, line, col) => 'line ' + (Number(line) - HEADER_LINES) + ':' + col)
      .split('\n')
      .filter((line) => !/^\s+at .*(data:text|<anonymous>)/.test(line))
      .slice(0, 6)
      .join('\n');
  };

  const emptyStill = (w) => ({ blob: null, x: w.moved.x, y: w.moved.y, w: w.w, h: w.h });

  /** An error stops that world only. Its last output stays on the surface. */
  const fail = (w, error) => {
    if (!w || w.failed) return;
    w.failed = true;
    w.stale = false;
    post({ type: 'error', key: w.key, message: messageOf(error) });
    for (const request of w.captures.splice(0)) post({ type: 'frame', key: w.key, request, tick: w.tick, still: emptyStill(w) });
  };
  // An error that no world owns is a fault of the runtime: it goes to the console.
  const stray = (error) => { const w = owner(); if (w) fail(w, error); else console.error(error); };
  scope.addEventListener('error', (e) => { e.preventDefault(); stray(e.error || e.message); });
  scope.addEventListener('unhandledrejection', (e) => { e.preventDefault(); stray(e.reason); });

  const emit = (w, type, props) => {
    const list = w.events.get(type);
    if (!list) return;
    for (const fn of [...list]) inside(w, () => { try { fn(Object.assign({ type }, props)); } catch (e) { fail(w, e); } });
  };

  const setStep = (w, name) => {
    if (name === w.view.step) return;
    const previous = w.view.step;
    w.view.step = name;
    emit(w, 'step', { name, previous });
  };
  // Stepping: the params and the step of the timeline at tick k.
  const inputsAt = (w, k) => {
    if (!w.timeline) return;
    const t = k / hz;
    if (w.timeline.params) {
      const pick = paramsAtTime(w.timeline.params, t, BLEND_GAP);
      if (pick !== w.picked) { w.picked = pick; Object.assign(w.params, w.base, pick); }
    }
    let step = null;
    for (const entry of w.timeline.steps) if (entry[0] <= t + 1e-6) step = entry[1];
    setStep(w, step);
  };

  // Parts. publish(name, target) makes a part, and the reserved param part.<name>.reveal (0..1) drives it.
  // The page writes that param through tween and draw; agents never write it. The default is a fade by material opacity.
  const fades = new WeakMap();
  const fadeMaterial = (m, v) => {
    if (!fades.has(m)) fades.set(m, { opacity: m.opacity, transparent: m.transparent, uniform: m.uniforms && m.uniforms.opacity ? m.uniforms.opacity.value : null });
    const was = fades.get(m), transparent = was.transparent || v < 1;
    m.opacity = was.opacity * v;
    if (was.uniform !== null) m.uniforms.opacity.value = was.uniform * v;
    if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
  };
  /** A part's meshes get their own copy of a material that a mesh outside the part uses too. So parts fade apart. */
  const ownMaterials = (w, t) => {
    const mine = new Set(), others = new Set(), copies = new Map();
    t.traverse((o) => mine.add(o));
    w.scene.traverse((o) => { if (o.material && !mine.has(o)) for (const m of [].concat(o.material)) others.add(m); });
    const own = (m) => {
      if (!others.has(m)) return m;
      if (!copies.has(m)) {
        const copy = m.clone();
        if (fades.has(m)) fades.set(copy, fades.get(m));
        copies.set(m, copy);
      }
      return copies.get(m);
    };
    t.traverse((o) => { if (o.material) o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material); });
  };
  /** The reveal of each part's object. An object shows the product of the reveals over it, so a part inside a part fades with both. */
  const reveals = new WeakMap();
  const revealOf = (o) => {
    let v = 1;
    for (let p = o; p; p = p.parent) if (reveals.has(p)) v *= reveals.get(p);
    return v;
  };
  const fadePart = (w, part, v) => {
    const t = part.target;
    if (!t || !t.isObject3D) return;
    reveals.set(t, v);
    ownMaterials(w, t);
    t.traverse((o) => {
      const shown = revealOf(o);
      o.userData.lsFade = shown;
      if (o.material) for (const m of [].concat(o.material)) fadeMaterial(m, shown);
    });
    t.visible = v > 0;
  };
  /** Bring each part to its reserved param. Only a change does anything. */
  const syncParts = (w) => {
    for (const [name, part] of w.parts) {
      const raw = w.params['part.' + name + '.reveal'];
      const v = raw === undefined ? 1 : Math.max(0, Math.min(1, Number(raw) || 0));
      if (v === part.v) continue;
      part.v = v;
      w.stale = true;
      inside(w, () => { try { if (part.reveal) part.reveal(v); else fadePart(w, part, v); } catch (e) { fail(w, e); } });
    }
  };
  const partOf = (w, name) => {
    const key = String(name);
    if (!w.parts.has(key)) w.parts.set(key, { target: null, reveal: null, v: 1 });
    return w.parts.get(key);
  };

  // The drawing of a tick: the frame callbacks, then the captures of this tick.
  const drawTick = (w, dt) => {
    if (dt > 0) w.timeMoved = true;
    syncParts(w);
    const began = meter ? realNow() : 0;
    inside(w, () => {
      // Two maps and one list stay with the world, so a tick allocates none. A callback can ask for the next frame or end its own.
      const list = w.callbacks, frames = w.framesNow, asked = list.size;
      w.callbacks = w.callbacksNext;
      w.callbacksNext = list;
      const t = w.tickMs / 1000;
      try { for (const cb of list.values()) cb(w.tickMs); } catch (e) { list.clear(); fail(w, e); return; }
      list.clear();
      frames.length = 0;
      for (let i = 0; i < w.frames.length; i++) frames.push(w.frames[i]);
      try { for (let i = 0; i < frames.length; i++) frames[i](t, dt); } catch (e) { fail(w, e); return; }
      // A tick asks for a check, not for a render: most worlds at rest change nothing (picture.ts).
      if (asked || w.frames.length) {
        w.ticked = true;
        w.count++;
        if (w.count === 1) post({ type: 'alive', key: w.key, frames: w.count, tick: w.tick });
      }
    });
    if (meter) { meter.ticks++; meter.tickMs += realNow() - began; }
    if (!w.failed && w.captures.length) takeStill(w);
  };
  // One frame at item time ms: timers due by then, then the drawing. 'tick' is the grid tick of that time.
  const runAt = async (w, ms) => {
    const dt = w.ran ? (ms - w.tickMs) / 1000 : 0;
    w.ran = true;
    w.tickMs = ms;
    w.tick = tickOf(ms / 1000);
    if (w.timers.size && inside(w, () => fireTimers(w, ms))) { w.ticked = true; await nextTask(); }
    if (!w.failed) drawTick(w, dt);
  };
  // Step mode: tick k of the grid, with the timeline's inputs of that tick.
  const runTick = (w, k) => {
    if (w.stepping) inputsAt(w, k);
    return runAt(w, k * TICK_MS);
  };

  // Live mode: one frame per display frame, at the item time of that frame (no grid).
  const itemTimeNow = (w) => w.clock.t + (w.clock.rate * (origin + realNow() - w.clock.at)) / 1000;
  const moved = (w) => !w.ran || itemTimeNow(w) * 1000 > w.tickMs;
  /** A timer is work when it is due: one that waits costs no ticks. */
  const timerDue = (w) => {
    const timer = w.timers.size ? nextTimer(w) : null;
    return !!timer && timer.due <= itemTimeNow(w) * 1000;
  };
  const hasWork = (w) => (!w.ran && w.setUp) || w.frames.length > 0 || w.callbacks.size > 0 || timerDue(w);
  const due = (w) => w.running && !w.failed && !w.stepping && !w.busy && moved(w) && hasWork(w);
  const live = (w) => {
    w.busy = true;
    return runAt(w, Math.max(w.tickMs, itemTimeNow(w) * 1000)).then(() => { w.busy = false; }, (e) => { w.busy = false; fail(w, e); });
  };
  const held = (w) => !w.running || w.clock.rate === 0;
  // With nothing to draw, the worker sleeps until the next timer is due in real time. A change of clock schedules again.
  let wakeHandle = 0, wakeAt = Infinity;
  const wakeForTimers = () => {
    const now = realNow();
    let soonest = Infinity;
    for (const w of worlds.values()) {
      if (!w.timers.size || !w.running || w.failed || w.stepping || !(w.clock.rate > 0)) continue;
      const timer = nextTimer(w);
      if (timer) soonest = Math.min(soonest, now + (timer.due - itemTimeNow(w) * 1000) / w.clock.rate);
    }
    if (soonest === Infinity || soonest >= wakeAt) return;
    nativeClearTimeout(wakeHandle);
    wakeAt = soonest;
    wakeHandle = nativeSetTimeout(() => { wakeAt = Infinity; schedule(); }, Math.max(0, Math.ceil(soonest - now)));
  };
  // A held world draws its time again for new params or a new size: time does not move (dt 0).
  const redraw = (w) => {
    if (w.failed || w.busy || w.stepping) return;
    if (w.ran) drawTick(w, 0);
    schedule();
  };
  // A capture: what the world shows now. It runs no frame, so a held simulation does not move.
  const capture = (w) => {
    if (w.failed || w.busy || !w.captures.length) return;
    if (w.ran) takeStill(w);
    else if (!w.stepping) live(w).then(schedule);
  };

  // Step mode: the world's setup first, until it asks for a frame or a timer, or its top level ends (imports load in real time).
  const setupDone = async (w) => {
    while (!w.callbacks.size && !w.frames.length && !w.timers.size && !w.setUp && !w.failed) await new Promise((resolve) => nativeSetTimeout(resolve, 10));
  };
  const advance = async (w, request, to, wantStill) => {
    await setupDone(w);
    let queued = false;
    let yielded = realNow();
    while (!w.failed) {
      const next = w.tick < 0 ? Math.min(w.from, to) : w.tick + 1;
      if (next > to) break;
      if (next === to && wantStill) { w.captures.push(request); queued = true; }
      await runTick(w, next);
      await null;
      if (realNow() - yielded > 30) {
        await nextTask();
        yielded = realNow();
        post({ type: 'progress', key: w.key, tick: w.tick });
      }
    }
    if (w.failed) return;
    // Already at the tick (or past it): the picture it shows.
    if (wantStill && !queued) { w.captures.push(request); takeStill(w); }
    if (!wantStill) post({ type: 'at', key: w.key, request, tick: w.tick });
  };

  const follow = (w, m) => {
    w.clock = m.clock;
    w.view.t = m.scene.t; w.view.playing = !!m.scene.playing; w.view.active = !!m.scene.active; w.view.ended = !!m.scene.ended;
    setStep(w, m.scene.step === undefined ? null : m.scene.step);
  };

  const report = (w, values) => {
    let text;
    try { text = JSON.stringify(values); } catch (e) { throw new Error('report(values): values must be plain data'); }
    if (text && text.length > 4000) throw new Error('report(values): at most 4000 characters as JSON');
    w.reportValue = text === undefined ? null : JSON.parse(text);
    if (w.reportTimer) return;
    const send = () => { w.reportTimer = 0; w.lastReport = realNow(); post({ type: 'report', key: w.key, values: w.reportValue }); };
    const wait = 100 - (realNow() - w.lastReport);
    if (wait <= 0) send(); else w.reportTimer = nativeSetTimeout(send, wait);
  };

  const listen = (w, type, fn) => {
    if (!w.events.has(type)) w.events.set(type, new Set());
    w.events.get(type).add(fn);
    subscribe(w);
    return () => { w.events.get(type).delete(fn); subscribe(w); };
  };

  /** The world object of a world's code. */
  const worldApi = (w) => ({
    get scene() { return w.scene; },
    get root() { return w.root; },
    get camera() { return w.camera; },
    set camera(c) { w.camera = c; },
    get time() { return w.tickMs / 1000; },
    get data() { return w.data; },
    get node() { return w.key.node; },
    /** The nominal size in board points: [w, h]. */
    get size() { return [w.w, w.h]; },
    get colors() { return w.colors; },
    /** The same function as the on of a world's code. */
    on(type, fn) { return listen(w, type, fn); },
    /** The cursor over the world, as a CSS cursor. Empty: the board's own. */
    cursor(value) {
      const cursor = String(value || '');
      if (cursor === w.cursorNow) return;
      w.cursorNow = cursor;
      post({ type: 'cursor', key: w.key, value: cursor });
    },
    get strokes() { return w.strokes; },
    /** The nearest hit at a board point: part, point, local, object, distance. Null when none. */
    pick(x, y) { return pickAt(w, x, y); },
    /** A board point on a plane, the floor by default. */
    toWorld(x, y, plane) { return toWorld(w, x, y, plane); },
    /** A world point on the board: x, y, visible. */
    toBoard(point) { return toBoard(w, point); },
    /** Move the whole world: its anchor to a board point. For long trips: nothing stretches, because the camera stays. */
    anchor(x, y) { moveAnchor(w, x, y); },
    get look() { return w.look; },
    set look(v) { setLook(w, v); },
    get floor() { return w.floor; },
    set floor(v) { setFloor(w, v); },
    add(...objects) {
      for (const m of objects) {
        if (m.traverse) m.traverse((n) => { if (n.isMesh && n.castShadow === false && !n.userData.noShadow) { n.castShadow = true; n.receiveShadow = true; } });
        w.root.add(m);
      }
      w.stale = true;
      schedule();
      return objects[0];
    },
    /** fn(t, dt) on every tick. Returns the function that ends it. */
    frame(fn) {
      if (typeof fn !== 'function') throw new Error('world.frame(fn): fn is a function of (t, dt)');
      w.frames.push(fn);
      schedule();
      return () => { const i = w.frames.indexOf(fn); if (i >= 0) w.frames.splice(i, 1); };
    },
    /** Change how a part reveals: reveal(v), v from 0 to 1, in place of the fade. */
    part(name, options) {
      if (!options || typeof options.reveal !== 'function') throw new Error('world.part(name, { reveal }): reveal is a function of v, 0..1');
      partOf(w, name).reveal = options.reveal;
    },
    /** Set what the world can reach: r board points around its anchor, or "full" for the whole surface. No argument gives the measure back to the app. */
    reach(r) {
      if (r !== undefined && r !== 'full' && !(Number(r) > 0)) throw new Error('world.reach(r): r is a number of board points or "full"');
      w.reachSet = r === undefined ? null : r === 'full' ? 'full' : Number(r);
      w.stale = true;
      schedule();
    },
    /** Ask for a new picture after a change with no tick, such as a texture that loaded. */
    redraw() { w.stale = true; schedule(); }
  });

  const AsyncFunction = (async () => {}).constructor;
  const WORLD_ARGS = ['THREE', 'world', 'params', 'scene', 'item', 'colors', 'on', 'input', 'report', 'publish'];

  /** Top levels run one at a time. A top level that waits longer than this lets the next one start. */
  const SETUP_TURN_MS = 3000;
  let setupQueue = Promise.resolve();

  const setupWorld = async (w) => {
    const sceneApi = Object.freeze({
      get t() { return w.view.active ? w.tickMs / 1000 : w.view.t; },
      get playing() { return w.view.playing; },
      get active() { return w.view.active; },
      get ended() { return w.view.ended; },
      get step() { return w.view.step; }
    });
    const itemApi = Object.freeze({
      get w() { return w.w; },
      get h() { return w.h; },
      get dpr() { return surface.dpr; },
      get t() { return w.tickMs / 1000; }
    });
    const on = (type, fn) => listen(w, type, fn);
    const input = (mode) => {
      if (mode !== 'none' && mode !== 'enter' && mode !== 'direct') throw new Error('input(mode): mode is "none", "enter" or "direct"');
      post({ type: 'input', key: w.key, mode });
    };
    const publish = (name, target) => {
      if (!target || !(target.isObject3D || target.isVector3 || typeof target === 'function')) throw new Error('publish(name, target): target is an Object3D, a Vector3 or a function that gives [x, y, z]');
      partOf(w, name).target = target;
    };
    const args = [THREE, worldApi(w), w.params, sceneApi, itemApi, Object.freeze(w.colors), on, input, (values) => report(w, values), publish];
    setting = w;
    announce(w);
    let turn = 0;
    try {
      const code = new AsyncFunction(...WORLD_ARGS, "'use strict';" + compileBody(w.code) + '\n//# sourceURL=world.js');
      const main = inside(w, () => code(...args));
      main.then(
        () => { w.setUp = true; w.floorBuilt = false; w.stale = true; syncParts(w); if (held(w)) redraw(w); schedule(); },
        (e) => { w.setUp = true; fail(w, e); }
      );
      await Promise.race([main.catch(() => {}), new Promise((resolve) => { turn = nativeSetTimeout(resolve, SETUP_TURN_MS); })]);
    } catch (e) {
      w.setUp = true;
      fail(w, e);
    }
    nativeClearTimeout(turn);
    if (setting === w) setting = null;
    announce(setting);
  };

  const addPin = (w, pin) => {
    w.pins.set(pin.id, { id: pin.id, part: pin.part, local: new THREE.Vector3().fromArray(pin.local), normal: null });
    w.stale = true;
  };

  const addWorld = (m) => {
    const id = idOf(m);
    if (worlds.has(id)) return;
    const rs = new Int32Array(4);
    seedState(rs, m.seed);
    const stepping = m.mode === 'step';
    const from = Math.max(0, m.from | 0);
    const w = {
      id, key: { node: m.node, generation: m.generation }, code: m.code, w: m.w, h: m.h,
      params: Object.assign({}, m.params), base: Object.assign({}, m.params), picked: null, colors: Object.assign({}, m.colors),
      rs, stepping, from, tickMs: from * TICK_MS, tick: -1, ran: false, dateBase: RealDate.now(),
      clock: m.clock || { t: 0, at: 0, rate: 0 },
      view: Object.assign({ t: 0, playing: false, active: false, ended: true, step: null }, m.scene),
      timeline: m.timeline || null,
      timers: new Map(), timerHeap: [], callbacks: new Map(), callbacksNext: new Map(), framesNow: [], frames: [], events: new Map(), parts: new Map(), captures: [], data: m.data,
      pins: new Map(), strokes: [], wants: { pointer: false, ink: false }, moved: { x: 0, y: 0 },
      failed: false, setUp: false, running: true, busy: false, count: 0,
      reportTimer: 0, reportValue: undefined, lastReport: 0,
      cursorNow: '', ticked: false, timeMoved: false, pictureState: null, placement: null, stale: false, moving: false, movedAt: -9, culled: false, quality: 0, waited: 0, shownPoints: [], reachSet: null, reach: null, samples: 0,
      output: null, drawn: null, floorBuilt: false, place: {}, placeAt: -1, matrixAt: -1, content: 0, sharpen: false, cost: newCost(), roseAt: -Infinity, heldUntil: 0, hold: 0
    };
    if (w.view.step === undefined) w.view.step = null;
    for (const pin of m.pins || []) addPin(w, pin);
    if (stepping) Object.assign(w.view, { t: from / hz, playing: true, active: true, ended: false });
    dressWorld(w);
    worlds.set(id, w);
    if (stepping) inputsAt(w, from);
    post({ type: 'alive', key: w.key, frames: 0, tick: w.tick });
    setupQueue = setupQueue.then(() => (worlds.has(id) ? setupWorld(w) : undefined));
    schedule();
  };

  const removeWorld = (key) => {
    const w = worlds.get(idOf(key));
    if (!w) return;
    worlds.delete(w.id);
    w.failed = true;
    for (const request of w.captures.splice(0)) post({ type: 'frame', key: w.key, request, tick: w.tick, still: emptyStill(w) });
    if (last === w) last = null;
    if (setting === w) setting = null;
    if (announced === w) announce(setting);
    if (w.reportTimer) nativeClearTimeout(w.reportTimer);
    w.timers.clear(); w.timerHeap.length = 0; w.callbacks.clear(); w.frames.length = 0; w.events.clear(); w.parts.clear(); w.pins.clear(); w.strokes.length = 0;
    core = true;
    try { undressWorld(w); } finally { core = false; }
    surface.dirty = true;
    schedule();
  };

  nativeSetInterval(() => { for (const w of worlds.values()) post({ type: 'alive', key: w.key, frames: w.count, tick: w.tick }); }, 250);
`
