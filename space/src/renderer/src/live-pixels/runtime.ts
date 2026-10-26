import { BLEND_GAP, paramsAtTime } from '../live/params'
import { TICK_HZ } from './clock'

/**
 * The tick runtime of canvas and program workers: the worker half of the
 * live item contract (clock.ts, host.ts). The worker scripts of both kinds
 * (sandbox.ts, program.ts) call it first, before the agent's code exists,
 * and give it their own part (`kind`):
 *
 * - kind.post(message): to the page.
 * - kind.init(m): take the canvas, size, params and colours of the init message.
 * - kind.start(): run the agent's top level; a promise that settles when it ends.
 * - kind.tick(t, dt): the kind's own drawing in a tick (canvas items: the draw
 *   function); false when it failed.
 * - kind.draws: true when every tick draws (canvas items).
 * - kind.params(p), kind.step(name, previous), kind.resize(m), kind.message(m).
 * - kind.capture(): a promise of the canvas pixels as a PNG blob.
 *
 * What the runtime does:
 * - Seeds Math.random (sfc32) with the item's seed.
 * - Item time: performance.now() is the item time of the frame the item is
 *   at; requestAnimationFrame callbacks run in frames with that time;
 *   setTimeout and setInterval are due in item time and fire at the start of
 *   a frame. While stepping, Date is the date at the start plus item time.
 * - Live mode: each display frame runs one frame at the item clock's time
 *   now (the display's own rate, no grid); a held clock (a pause) runs
 *   nothing; off screen ("run" off) runs nothing.
 * - Step mode: "advance" runs every tick of the grid up to a tick with the
 *   timeline's params and steps, as fast as it computes, then holds there.
 *   "live" changes a step host on the board to live mode at the tick it
 *   reached (a seek or a replay: registry.ts).
 * - Capture: the pixels of a frame, taken in the same task as its drawing,
 *   with the grid tick of its time. A held item gives the pixels it shows
 *   now: a capture runs no frame callbacks and no drawing code.
 * - WebGL contexts keep their drawing buffer (preserveDrawingBuffer), so a
 *   program that draws once still gives a picture.
 * - Reports the number of GPU contexts the code made, and a lost one.
 *
 * Page → worker: init, clock, live {clock, scene, params}, run, params,
 * size, advance {id, to, capture}, capture {id}. Worker → page: alive {frames, tick}, frame {id, tick, blob},
 * at {id, tick}, progress {tick}, error {message}, gpu {contexts}, lost.
 */

const RUNTIME = `function (scope, kind, hz) {
  // The param evaluator of playback (live/params.ts), so a still and a pause of playback show the same params.
  const paramsAtTime = ${paramsAtTime.toString()};
  const BLEND_GAP = ${BLEND_GAP};
  const perf = scope.performance;
  const realNow = perf.now.bind(perf);
  const origin = perf.timeOrigin;
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const nativeSetInterval = scope.setInterval.bind(scope);
  const nativeRaf = typeof scope.requestAnimationFrame === 'function' ? scope.requestAnimationFrame.bind(scope) : (cb) => nativeSetTimeout(() => cb(realNow()), 16);
  const addListener = scope.EventTarget.prototype.addEventListener;
  const RealDate = scope.Date;
  const Channel = scope.MessageChannel;
  const TICK_MS = 1000 / hz;
  const tickOf = (t) => Math.max(0, Math.floor(t * hz + 1e-6));
  const nextTask = () => new Promise((resolve) => { const ch = new Channel(); ch.port1.onmessage = () => { ch.port1.close(); resolve(); }; ch.port2.postMessage(0); });

  // Seeded Math.random (sfc32). The state is a typed array: about as fast as the native one (closure variables are 3 times slower).
  const rs = new Int32Array(4);
  const random = () => {
    const a = rs[0], b = rs[1], c = rs[2], d = rs[3];
    const t = (((a + b) | 0) + d) | 0;
    rs[3] = (d + 1) | 0;
    rs[0] = b ^ (b >>> 9);
    rs[1] = (c + (c << 3)) | 0;
    rs[2] = (((c << 21) | (c >>> 11)) + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const seedRandom = (seed) => { rs[0] = 0x9e3779b9; rs[1] = 0x243f6a88; rs[2] = 0xb7e15162; rs[3] = seed | 0; for (let i = 0; i < 15; i++) random(); };
  Object.defineProperty(Math, 'random', { value: random, configurable: true, writable: true });

  // Item time.
  let tick = -1, tickMs = 0, from = 0, stepping = false;
  const dateBase = RealDate.now();
  try { Object.defineProperty(perf, 'now', { value: () => tickMs, configurable: true, writable: true }); } catch (e) {}
  const dateNow = () => (stepping ? dateBase + tickMs : RealDate.now());
  function VDate(...a) {
    if (!new.target) return new RealDate(dateNow()).toString();
    return a.length ? new RealDate(...a) : new RealDate(dateNow());
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = dateNow; VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  scope.Date = VDate;

  const timers = new Map();
  let timerSeq = 0, timerOrder = 0;
  const addTimer = (cb, ms, args, every) => {
    if (typeof cb !== 'function') return 0;
    const id = ++timerSeq;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { due: tickMs + delay, cb, args, every: every ? Math.max(1, delay) : 0, order: timerOrder++ });
    return id;
  };
  scope.setTimeout = (cb, ms, ...args) => addTimer(cb, ms, args, false);
  scope.setInterval = (cb, ms, ...args) => addTimer(cb, ms, args, true);
  scope.clearTimeout = scope.clearInterval = (id) => { timers.delete(id); };
  // The timers due by item time 'until', in order. True when one fired.
  const fireTimers = (until) => {
    let fired = false;
    for (let guard = 0; guard < 10000 && !failed; guard++) {
      let next = null;
      for (const entry of timers) if (entry[1].due <= until && (!next || entry[1].due < next[1].due || (entry[1].due === next[1].due && entry[1].order < next[1].order))) next = entry;
      if (!next) break;
      const timer = next[1];
      if (timer.every) { timer.due += timer.every; timer.order = timerOrder++; } else timers.delete(next[0]);
      fired = true;
      try { timer.cb(...timer.args); } catch (e) { fail(e); }
    }
    return fired;
  };

  const callbacks = new Map();
  let frameSeq = 0;
  scope.requestAnimationFrame = (cb) => { const id = ++frameSeq; callbacks.set(id, cb); return id; };
  scope.cancelAnimationFrame = (id) => { callbacks.delete(id); };

  // GPU contexts the code makes, and their loss.
  let contexts = 0;
  const counted = new WeakSet();
  const OC = scope.OffscreenCanvas;
  if (OC) {
    const getContext = OC.prototype.getContext;
    Object.defineProperty(OC.prototype, 'getContext', {
      configurable: true, writable: true,
      value: function (type, options) {
        // WebGL keeps its drawing buffer, so a program that draws once still gives a picture.
        const gl = type === 'webgl' || type === 'webgl2';
        const ctx = getContext.call(this, type, gl ? Object.assign({}, options, { preserveDrawingBuffer: true }) : options);
        if (ctx && !counted.has(this) && (type === 'webgl' || type === 'webgl2' || type === 'webgpu')) {
          counted.add(this);
          contexts++;
          kind.post({ type: 'gpu', contexts });
          if (type !== 'webgpu') addListener.call(this, 'webglcontextlost', () => kind.post({ type: 'lost' }));
        }
        return ctx;
      }
    });
  }
  if (scope.GPUAdapter) {
    const requestDevice = scope.GPUAdapter.prototype.requestDevice;
    scope.GPUAdapter.prototype.requestDevice = function (...a) {
      return requestDevice.apply(this, a).then((device) => {
        device.lost.then((info) => { if (!info || info.reason !== 'destroyed') kind.post({ type: 'lost' }); });
        return device;
      });
    };
  }

  // State.
  let failed = false, frames = 0, setUp = false, running = false, loop = 0, busy = false;
  let clock = { t: 0, at: 0, rate: 0 };
  const scene = { t: 0, playing: false, active: false, ended: true, step: null };
  let timeline = null, base = {}, picked = null;
  const captures = [];

  const fail = (error) => {
    if (failed) return;
    failed = true;
    const message = error && error.stack ? String(error.stack) : error && error.message ? String(error.message) : String(error);
    kind.post({ type: 'error', message });
    for (const id of captures.splice(0)) kind.post({ type: 'frame', id, tick, blob: null });
  };
  addListener.call(scope, 'error', (e) => { e.preventDefault(); fail(e.error || e.message); });
  addListener.call(scope, 'unhandledrejection', (e) => { e.preventDefault(); fail(e.reason); });

  const setStep = (name) => {
    if (name === scene.step) return;
    const previous = scene.step;
    scene.step = name;
    kind.step(name, previous);
  };
  // Stepping: the params and the step of the timeline at tick k.
  const inputsAt = (k) => {
    if (!timeline) return;
    const t = k / hz;
    if (timeline.params) {
      const pick = paramsAtTime(timeline.params, t, BLEND_GAP);
      if (pick !== picked) { picked = pick; kind.params(Object.assign({}, base, pick)); }
    }
    let step = null;
    for (const entry of timeline.steps) if (entry[0] <= t + 1e-6) step = entry[1];
    setStep(step);
  };

  const take = () => {
    const ids = captures.splice(0);
    const at = tick;
    let promise;
    try { promise = kind.capture(); } catch (e) { promise = Promise.reject(e); }
    Promise.resolve(promise).then(
      (blob) => { for (const id of ids) kind.post({ type: 'frame', id, tick: at, blob }); },
      () => { for (const id of ids) kind.post({ type: 'frame', id, tick: at, blob: null }); }
    );
  };
  // The drawing of a tick: the frame callbacks, then the kind's own drawing; captures of this tick.
  const draw = (dt) => {
    const list = [...callbacks.values()];
    callbacks.clear();
    for (const cb of list) { try { cb(tickMs); } catch (e) { fail(e); return; } }
    if (failed || kind.tick(tickMs / 1000, dt) === false) return;
    if (list.length || kind.draws) { frames++; if (frames === 1) kind.post({ type: 'alive', frames, tick }); }
    if (captures.length) take();
  };
  // One frame at item time ms: timers due by then, then the drawing. 'tick' is the grid tick of that time.
  let ran = false;
  const runAt = async (ms) => {
    const dt = ran ? (ms - tickMs) / 1000 : 0;
    ran = true;
    tickMs = ms;
    tick = tickOf(ms / 1000);
    if (timers.size && fireTimers(tickMs)) await nextTask();
    if (!failed) draw(dt);
  };
  // Step mode: tick k of the grid, with the timeline's inputs of that tick.
  const runTick = (k) => {
    if (stepping) inputsAt(k);
    return runAt(k * TICK_MS);
  };

  // Live mode: one frame per display frame, at the item time of that frame (no grid).
  const itemTimeNow = () => clock.t + (clock.rate * (origin + realNow() - clock.at)) / 1000;
  const moved = () => !ran || itemTimeNow() * 1000 > tickMs;
  const wanted = () => running && !failed && !stepping && (clock.rate > 0 || moved() || captures.length > 0);
  const schedule = () => { if (!loop && wanted()) loop = nativeRaf(liveFrame); };
  const live = () => {
    busy = true;
    runAt(Math.max(tickMs, itemTimeNow() * 1000)).then(() => { busy = false; schedule(); }, (e) => { busy = false; fail(e); });
  };
  const liveFrame = () => {
    loop = 0;
    if (!running || failed || stepping || busy) return;
    if (moved()) return live();
    if (captures.length) capture();
    schedule();
  };
  // A held item (paused, off screen) draws its time again for new params or a new size: time does not move (dt 0).
  const redraw = () => {
    if (failed || busy || stepping) return;
    if (!ran) live();
    else draw(0);
  };
  // A capture: the pixels the canvas shows now. It runs no frame, so a held simulation does not move.
  // Before the first frame (or while a frame runs), the next drawing takes the picture.
  const capture = () => {
    if (failed || busy || !captures.length) return;
    if (ran) take();
    else if (!stepping) live();
  };
  const held = () => !running || clock.rate === 0;

  // Step mode: the program's setup first, until it asks for a frame or a timer, or its top level ends (imports load in real time).
  const setupDone = async () => {
    while (!callbacks.size && !timers.size && !setUp && !failed) await new Promise((resolve) => nativeSetTimeout(resolve, 10));
  };
  const advance = async (id, to, capture) => {
    await setupDone();
    let queued = false;
    let yielded = realNow();
    while (!failed) {
      const next = tick < 0 ? Math.min(from, to) : tick + 1;
      if (next > to) break;
      if (next === to && capture) { captures.push(id); queued = true; }
      await runTick(next);
      await null;
      if (realNow() - yielded > 30) {
        await nextTask();
        yielded = realNow();
        kind.post({ type: 'progress', tick });
      }
    }
    if (failed) return;
    // Already at the tick (or past it): the picture it shows.
    if (capture && !queued) { captures.push(id); take(); }
    if (!capture) kind.post({ type: 'at', id, tick });
  };

  const init = (m) => {
    seedRandom(m.seed);
    stepping = m.mode === 'step';
    from = Math.max(0, m.from | 0);
    tickMs = from * TICK_MS;
    timeline = m.timeline || null;
    base = Object.assign({}, m.params);
    if (m.clock) clock = m.clock;
    if (m.scene) { Object.assign(scene, m.scene); scene.step = m.scene.step === undefined ? null : m.scene.step; }
    if (stepping) Object.assign(scene, { t: from / hz, playing: true, active: true, ended: false });
    running = !!m.visible;
    kind.init(m);
    if (stepping) inputsAt(from);
    nativeSetInterval(() => kind.post({ type: 'alive', frames, tick }), 250);
    kind.post({ type: 'alive', frames, tick });
    Promise.resolve(kind.start()).then(() => { setUp = true; }, (e) => { setUp = true; fail(e); });
    schedule();
  };

  const follow = (m) => {
    clock = m.clock;
    scene.t = m.scene.t; scene.playing = !!m.scene.playing; scene.active = !!m.scene.active; scene.ended = !!m.scene.ended;
    setStep(m.scene.step === undefined ? null : m.scene.step);
  };

  const handle = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') init(m);
    else if (m.type === 'clock') {
      follow(m);
      schedule();
    } else if (m.type === 'live') {
      // A step host on the board reached the tick of its clock: from here it follows the clock live, with the item's params.
      if (!stepping || failed) return;
      stepping = false;
      timeline = null;
      picked = null;
      base = Object.assign({}, m.params);
      kind.params(Object.assign({}, m.params));
      follow(m);
      schedule();
    } else if (m.type === 'run') {
      running = !!m.on;
      schedule();
    } else if (m.type === 'params') {
      base = Object.assign({}, m.params);
      kind.params(Object.assign({}, m.params));
      if (held() && running) redraw();
    } else if (m.type === 'size') {
      kind.resize(m);
      if (held() && running) redraw();
    } else if (m.type === 'advance') {
      advance(m.id, m.to | 0, !!m.capture).catch(fail);
    } else if (m.type === 'capture') {
      if (failed) { kind.post({ type: 'frame', id: m.id, tick, blob: null }); return; }
      captures.push(m.id);
      if (stepping || held()) capture();
      else {
        schedule();
        // A live item whose display frames do not come (a hidden window) gives the pixels it shows.
        nativeSetTimeout(() => { if (captures.includes(m.id)) capture(); }, 300);
      }
    } else kind.message(m);
  };

  return {
    handle,
    fail,
    scene,
    realNow,
    setTimeout: nativeSetTimeout,
    itemTime: () => tickMs / 1000,
    sceneTime: () => (scene.active ? tickMs / 1000 : scene.t),
    get failed() { return failed; }
  };
}`

/** The runtime as a call for a worker script: `(function (scope, kind, hz) {…})(scope, kind, TICK_HZ)`, which returns its handle. */
export function runtimeCall(scope: string, kind: string): string {
  return `(${RUNTIME})(${scope}, ${kind}, ${TICK_HZ})`
}
