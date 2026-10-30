/**
 * The realm of the world worker. All worlds run here and share one `three`.
 * Worlds keep the clock rules of live-pixels/runtime.ts and clock.ts: item
 * time, scene time, step events, a hold on pause, the tick grid for previews.
 * The difference: runtime.ts owns a whole worker, and here each rule is per
 * world.
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
  /** Run fn as world w. */
  const inside = (w, fn) => {
    const previous = current;
    current = w;
    last = w;
    try { return fn(); } finally { current = previous; }
  };

  // Seeded Math.random (sfc32), one state per world. The same generator as runtime.ts.
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

  // Timers: due in the item time of their world, fired at the start of its frame.
  let timerSeq = 0, timerOrder = 0;
  const addTimer = (w, cb, ms, args, every) => {
    if (typeof cb !== 'function') return 0;
    const id = ++timerSeq;
    const delay = Math.max(0, Number(ms) || 0);
    w.timers.set(id, { due: w.tickMs + delay, cb, args, every: every ? Math.max(1, delay) : 0, order: timerOrder++ });
    schedule();
    return id;
  };
  scope.setTimeout = (cb, ms, ...args) => { const w = owner(); return w ? addTimer(w, cb, ms, args, false) : nativeSetTimeout(cb, ms, ...args); };
  scope.setInterval = (cb, ms, ...args) => { const w = owner(); return w ? addTimer(w, cb, ms, args, true) : nativeSetInterval(cb, ms, ...args); };
  scope.clearTimeout = scope.clearInterval = (id) => { for (const w of worlds.values()) w.timers.delete(id); };
  // The timers of w due by item time 'until', in order. True when one fired.
  const fireTimers = (w, until) => {
    let fired = false;
    for (let guard = 0; guard < 10000 && !w.failed; guard++) {
      let next = null;
      for (const entry of w.timers) if (entry[1].due <= until && (!next || entry[1].due < next[1].due || (entry[1].due === next[1].due && entry[1].order < next[1].order))) next = entry;
      if (!next) break;
      const timer = next[1];
      if (timer.every) { timer.due += timer.every; timer.order = timerOrder++; } else w.timers.delete(next[0]);
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

  const emptyStill = (w) => ({ blob: null, x: 0, y: 0, w: w.w, h: w.h });

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

  // The drawing of a tick: the frame callbacks, then the captures of this tick.
  const drawTick = (w, dt) => {
    inside(w, () => {
      const list = [...w.callbacks.values()];
      w.callbacks.clear();
      const t = w.tickMs / 1000;
      for (const cb of list) { try { cb(w.tickMs); } catch (e) { fail(w, e); return; } }
      for (const fn of [...w.frames]) { try { fn(t, dt); } catch (e) { fail(w, e); return; } }
      if (list.length || w.frames.length) {
        w.stale = true;
        w.count++;
        if (w.count === 1) post({ type: 'alive', key: w.key, frames: w.count, tick: w.tick });
      }
    });
    if (!w.failed && w.captures.length) takeStill(w);
  };
  // One frame at item time ms: timers due by then, then the drawing. 'tick' is the grid tick of that time.
  const runAt = async (w, ms) => {
    const dt = w.ran ? (ms - w.tickMs) / 1000 : 0;
    w.ran = true;
    w.tickMs = ms;
    w.tick = tickOf(ms / 1000);
    if (w.timers.size && inside(w, () => fireTimers(w, ms))) { w.stale = true; await nextTask(); }
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
  const hasWork = (w) => (!w.ran && w.setUp) || w.frames.length > 0 || w.callbacks.size > 0 || w.timers.size > 0;
  const due = (w) => w.running && !w.failed && !w.stepping && !w.busy && moved(w) && hasWork(w);
  const live = (w) => {
    w.busy = true;
    return runAt(w, Math.max(w.tickMs, itemTimeNow(w) * 1000)).then(() => { w.busy = false; }, (e) => { w.busy = false; fail(w, e); });
  };
  const held = (w) => !w.running || w.clock.rate === 0;
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

  /** The world object of a world's code. */
  const worldApi = (w) => ({
    get scene() { return w.scene; },
    get root() { return w.root; },
    get camera() { return w.camera; },
    set camera(c) { w.camera = c; },
    get time() { return w.tickMs / 1000; },
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
    const on = (type, fn) => {
      if (!w.events.has(type)) w.events.set(type, new Set());
      w.events.get(type).add(fn);
      return () => w.events.get(type).delete(fn);
    };
    const input = (mode) => {
      if (mode !== 'none' && mode !== 'enter' && mode !== 'direct') throw new Error('input(mode): mode is "none", "enter" or "direct"');
      post({ type: 'input', key: w.key, mode });
    };
    const publish = (name, target) => { w.published.set(String(name), target); };
    const args = [THREE, worldApi(w), w.params, sceneApi, itemApi, Object.freeze(w.colors), on, input, (values) => report(w, values), publish];
    setting = w;
    let turn = 0;
    try {
      const code = new AsyncFunction(...WORLD_ARGS, "'use strict';" + compileBody(w.code) + '\n//# sourceURL=world.js');
      const main = inside(w, () => code(...args));
      main.then(
        () => { w.setUp = true; w.floorBuilt = false; w.stale = true; if (held(w)) redraw(w); schedule(); },
        (e) => { w.setUp = true; fail(w, e); }
      );
      await Promise.race([main.catch(() => {}), new Promise((resolve) => { turn = nativeSetTimeout(resolve, SETUP_TURN_MS); })]);
    } catch (e) {
      w.setUp = true;
      fail(w, e);
    }
    nativeClearTimeout(turn);
    if (setting === w) setting = null;
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
      timers: new Map(), callbacks: new Map(), frames: [], events: new Map(), published: new Map(), captures: [],
      failed: false, setUp: false, running: true, busy: false, count: 0,
      reportTimer: 0, reportValue: undefined, lastReport: 0,
      placement: null, stale: false, culled: false, reachSet: null, reach: null, samples: 0,
      output: null, drawn: null, floorBuilt: false
    };
    if (w.view.step === undefined) w.view.step = null;
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
    undressWorld(w);
    surface.dirty = true;
    schedule();
  };

  nativeSetInterval(() => { for (const w of worlds.values()) post({ type: 'alive', key: w.key, frames: w.count, tick: w.tick }); }, 250);
`
