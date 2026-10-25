import { LIVE_ORIGIN, programBody } from '@shared/live-libs'
import { boardColors, type CanvasSize } from './sandbox'

/**
 * Program mode of live pixel items: the agent's code is a whole program. It
 * runs once, in a worker, with the item's OffscreenCanvas, and owns its loop
 * (requestAnimationFrame), its contexts (2D, WebGL 2, WebGPU) and its state.
 *
 * Where it runs: a sandboxed iframe of live-item://host/frame.html
 * (main/live-item-protocol.ts) per item. The frame is an opaque origin of its
 * own, apart from the app's page, storage, files and other items, and has no
 * Content-Security-Policy: the program may fetch and import from any URL.
 * The frame creates the worker (a data: URL built here), hands it the canvas
 * and a MessagePort to this page, and forwards the pointer, wheel and key
 * events it receives. It receives them only while the item takes input
 * (input "direct", or "enter" while entered); otherwise the frame lets the
 * pointer through to the board (the learner's pen draws on the item).
 *
 * The page talks to the worker through the port: size, params, the scene
 * clock, visibility, input state and stills; the worker answers with alive
 * ticks, errors, stills, report() values and its input mode. The board's
 * main thread never runs the agent's code and never waits for it.
 */

export type LiveInput = 'none' | 'enter' | 'direct'

/** The scene clock of an item: the scene that plays it now (player.ts). */
export interface LiveClock {
  t: number
  playing: boolean
  step: string | null
  /** The scene's duration. */
  end: number
  /** Storyboard frames only: run the program up to this moment (see ProgramSim). */
  sim?: ProgramSim
}

export interface ProgramHostEvents {
  onTick(frames: number): void
  onError(message: string): void
  onInput(mode: LiveInput): void
  onReport(values: unknown): void
  onEscape(): void
  /** A storyboard run (sim) moved on. */
  onProgress?(): void
}

/** The worker script. __CODE__ is the agent's program as an async function body (shared/live-libs.ts programBody). */
const TEMPLATE = `'use strict';
(() => {
  const scope = self;
  const nativeRaf = scope.requestAnimationFrame.bind(scope);
  const perf = scope.performance;
  const realNow = perf.now.bind(perf);
  // A storyboard frame runs the program on a virtual clock (sim): now() is that clock while it is set.
  let vnow = null;
  const now = () => (vnow === null ? realNow() : vnow);
  try { Object.defineProperty(perf, 'now', { value: now, configurable: true, writable: true }); } catch (e) {}
  // On the virtual clock, Date and timers follow it too: Date.now() and new Date() are the real date at the
  // start of the run plus the virtual time, and setTimeout/setInterval fire when the virtual time reaches them.
  const RealDate = Date;
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const nativeClearTimeout = scope.clearTimeout.bind(scope);
  const nativeSetInterval = scope.setInterval.bind(scope);
  const nativeClearInterval = scope.clearInterval.bind(scope);
  let dateBase = 0;
  const timers = new Map();
  let nextTimer = 1e9;
  const virtualize = () => {
    dateBase = RealDate.now();
    const dateNow = () => (vnow === null ? RealDate.now() : dateBase + vnow);
    function VDate(...a) {
      if (!new.target) return new RealDate(dateNow()).toString();
      return a.length ? new RealDate(...a) : new RealDate(dateNow());
    }
    VDate.prototype = RealDate.prototype;
    VDate.now = dateNow;
    VDate.parse = RealDate.parse;
    VDate.UTC = RealDate.UTC;
    scope.Date = VDate;
    const add = (cb, ms, args, every) => {
      if (typeof cb !== 'function') return 0;
      const id = nextTimer++;
      const delay = Math.max(0, Number(ms) || 0);
      timers.set(id, { due: (vnow || 0) + delay, cb, args, every: every ? Math.max(1, delay) : 0, order: id });
      return id;
    };
    const clear = (id) => { if (timers.has(id)) timers.delete(id); else { nativeClearTimeout(id); nativeClearInterval(id); } };
    scope.setTimeout = (cb, ms, ...args) => add(cb, ms, args, false);
    scope.setInterval = (cb, ms, ...args) => add(cb, ms, args, true);
    scope.clearTimeout = clear;
    scope.clearInterval = clear;
  };
  // The virtual timers due by the virtual time now, in order. True when one fired.
  const fireTimers = () => {
    let fired = false;
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const [id, timer] of timers) if (timer.due <= vnow && (!next || timer.due < next[1].due || (timer.due === next[1].due && timer.order < next[1].order))) next = [id, timer];
      if (!next) break;
      const [id, timer] = next;
      if (timer.every) { timer.due += timer.every; timer.order = nextTimer++; } else timers.delete(id);
      fired = true;
      try { timer.cb(...timer.args); } catch (e) { fail(e); return fired; }
    }
    return fired;
  };
  // A task boundary, so promise continuations of fired timers run before the next virtual frame (no 4 ms clamp).
  const nextTask = () => new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); });
  const toFrame = scope.postMessage.bind(scope);
  let port = null;
  const post = (m) => { if (port) { try { port.postMessage(m); } catch (e) { post({ type: 'error', message: 'report: values must be plain data' }); } } };
  let canvas = null, w = 1, h = 1, pw = 1, ph = 1, start = 0;
  let visible = false, failed = false, frames = 0, simulating = false;
  const params = {};
  const colors = {};
  const clock = { t: 0, at: 0, playing: false, active: false, ended: true, step: null };
  const scene = Object.freeze({
    get t() { return clock.playing ? clock.t + (now() - clock.at) / 1000 : clock.t; },
    get playing() { return clock.playing; },
    get active() { return clock.active; },
    get ended() { return clock.ended; },
    get step() { return clock.step; }
  });
  const item = Object.freeze({
    get w() { return w; },
    get h() { return h; },
    get dpr() { return pw / Math.max(1e-6, w); },
    get t() { return (perf.timeOrigin + now() - start) / 1000; }
  });
  const fail = (error) => {
    if (failed) return;
    failed = true;
    const message = error && error.stack ? String(error.stack) : error && error.message ? String(error.message) : String(error);
    post({ type: 'error', message });
  };
  scope.addEventListener('error', (e) => { e.preventDefault(); fail(e.error || e.message); });
  scope.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fail(e.reason); });

  // requestAnimationFrame: the program's callbacks wait while the item is off screen.
  const pending = new Map();
  let nextId = 1, scheduled = 0;
  const stills = [];
  const schedule = () => { if (!scheduled && !simulating && visible && !failed && pending.size) scheduled = nativeRaf(runFrame); };
  const takeStills = () => {
    const ids = stills.splice(0);
    if (!ids.length) return;
    let promise;
    try { promise = canvas.convertToBlob({ type: 'image/png' }); } catch (e) { promise = Promise.reject(e); }
    promise.then((blob) => { for (const id of ids) post({ type: 'still', id, blob }); }, () => { for (const id of ids) post({ type: 'still', id, blob: null }); });
  };
  const runFrame = (ts) => {
    scheduled = 0;
    const list = [...pending.values()];
    pending.clear();
    for (const cb of list) { try { cb(ts); } catch (e) { fail(e); return; } }
    if (list.length) frames++;
    takeStills();
    schedule();
  };
  scope.requestAnimationFrame = (cb) => { const id = nextId++; pending.set(id, cb); schedule(); return id; };
  scope.cancelAnimationFrame = (id) => { pending.delete(id); };

  const emit = (type, props) => {
    if (!canvas) return;
    const e = new Event(type, { cancelable: true });
    for (const k in props) if (k !== 'type') { try { Object.defineProperty(e, k, { value: props[k], enumerable: true }); } catch (x) {} }
    try { canvas.dispatchEvent(e); } catch (error) { fail(error); }
  };
  let lastReport = 0, reportTimer = 0, reportValue;
  const sendReport = () => { reportTimer = 0; lastReport = now(); post({ type: 'report', values: reportValue }); };
  const api = {
    params, scene, item, colors,
    input(mode) {
      if (mode !== 'none' && mode !== 'enter' && mode !== 'direct') throw new Error('input(mode): mode is "none", "enter" or "direct"');
      post({ type: 'input', mode });
    },
    report(values) {
      let text;
      try { text = JSON.stringify(values); } catch (e) { throw new Error('report(values): values must be plain data'); }
      if (text && text.length > 4000) throw new Error('report(values): at most 4000 characters as JSON');
      reportValue = text === undefined ? null : JSON.parse(text);
      if (reportTimer) return;
      const wait = 100 - (now() - lastReport);
      if (wait <= 0) sendReport(); else reportTimer = nativeSetTimeout(sendReport, wait);
    },
    on(type, fn, options) { canvas.addEventListener(type, fn, options); return () => canvas.removeEventListener(type, fn, options); }
  };
  for (const key of Object.keys(api)) Object.defineProperty(scope, key, { value: api[key], enumerable: true, writable: false, configurable: false });

  const shim = (c) => {
    const style = {};
    let cursor = '';
    Object.defineProperty(style, 'cursor', { get: () => cursor, set: (v) => { cursor = String(v); toFrame({ type: 'cursor', value: cursor }); }, enumerable: true });
    const rect = () => ({ left: 0, top: 0, x: 0, y: 0, right: w, bottom: h, width: w, height: h });
    const noop = () => {};
    Object.defineProperties(c, {
      style: { value: style },
      clientWidth: { get: () => w }, clientHeight: { get: () => h },
      offsetWidth: { get: () => w }, offsetHeight: { get: () => h },
      getBoundingClientRect: { value: rect },
      setPointerCapture: { value: noop }, releasePointerCapture: { value: noop }, hasPointerCapture: { value: () => false },
      getRootNode: { value: () => c }, ownerDocument: { get: () => c },
      focus: { value: noop }, blur: { value: noop }
    });
    Object.defineProperty(scope, 'canvas', { value: c, enumerable: true, writable: false, configurable: false });
  };

  const setClock = (m) => {
    const before = clock.step;
    if (m.clock) {
      clock.t = m.clock.t; clock.at = now(); clock.playing = !!m.clock.playing; clock.step = m.clock.step ?? null;
      clock.active = true; clock.ended = false;
    } else if (clock.active) {
      clock.t = typeof m.end === 'number' ? m.end : clock.t; clock.playing = false; clock.active = false; clock.ended = true;
    }
    if (clock.step !== before) emit('step', { name: clock.step, previous: before });
  };

  const handle = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'size') {
      const resized = m.pw !== pw || m.ph !== ph || m.w !== w || m.h !== h;
      w = m.w; h = m.h; pw = m.pw; ph = m.ph;
      if (canvas && (canvas.width !== pw || canvas.height !== ph)) { canvas.width = pw; canvas.height = ph; }
      if (resized) emit('resize', { w, h, dpr: item.dpr });
    } else if (m.type === 'params') {
      Object.assign(params, m.params);
    } else if (m.type === 'clock') {
      setClock(m);
    } else if (m.type === 'run') {
      visible = !!m.on;
      schedule();
    } else if (m.type === 'entered') {
      emit(m.on ? 'enter' : 'leave', {});
    } else if (m.type === 'still') {
      stills.push(m.id);
      if (!pending.size || !visible) takeStills();
    }
  };

  scope.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'input' && m.event && typeof m.event.type === 'string') { emit(m.event.type, m.event); return; }
    if (m.type !== 'init' || canvas) return;
    port = m.port;
    port.onmessage = (e) => handle(e.data);
    w = m.w; h = m.h; pw = m.pw; ph = m.ph; start = m.start;
    Object.assign(params, m.params);
    Object.assign(colors, m.colors);
    Object.freeze(colors);
    if (m.clock !== undefined) setClock({ clock: m.clock, end: m.clock ? m.clock.end : undefined });
    // No scene plays the item: it rests where its scene ended (a reopened board), not at t = 0.
    if (!m.clock && m.rest) { clock.t = m.rest.t; clock.step = m.rest.step; }
    visible = !!m.visible;
    m.canvas.width = pw; m.canvas.height = ph;
    shim(m.canvas);
    canvas = m.canvas;
    nativeSetInterval(() => post({ type: 'alive', frames }), 250);
    post({ type: 'alive', frames });
    if (m.check) return;
    if (m.sim) {
      // The virtual clock starts before the program's first line, so its setup sees it too.
      simulating = true;
      vnow = 0;
      start = perf.timeOrigin;
      virtualize();
    }
    const running = main();
    running.catch(fail);
    if (m.sim) simulate(m.sim, running).catch(fail);
  });

  // Storyboard frames (sim): run the program from the moment the item appeared (sim.from, scene time) to
  // the frame's moment (sim.to) on a virtual clock, 30 frames a second, with the scene's params of each
  // moment, as fast as it computes; then hold the clock there, so the picture is the program's own state
  // at that moment (its integrators, damped cameras and anything it keeps from frame to frame).
  const simulate = async (sim, running) => {
    let setUp = false;
    running.then(() => { setUp = true; }, () => { setUp = true; });
    const samples = Array.isArray(sim.params) ? sim.params : [];
    const steps = Array.isArray(sim.steps) ? sim.steps : [];
    const at = (st) => {
      if (samples.length) {
        let pick = samples[0];
        for (const sample of samples) { if (sample[0] <= st + 1e-6) pick = sample; else break; }
        Object.assign(params, pick[1]);
      }
      let step = null;
      for (const entry of steps) if (entry[0] <= st + 1e-6) step = entry[1];
      setClock({ clock: { t: st, playing: true, step } });
      clock.at = vnow;
    };
    at(sim.from);
    // The program's setup: until it asks for its first frame, waits for a timer, or its top level ends (imports load in real time).
    while (!pending.size && !timers.size && !setUp && !failed) await new Promise((resolve) => nativeSetTimeout(resolve, 10));
    const total = Math.max(0, sim.to - sim.from) * 1000;
    const stepMs = 1000 / 30;
    let lastYield = realNow();
    for (let k = 1; !failed; k++) {
      const v = Math.min(total, k * stepMs);
      vnow = v;
      at(sim.from + v / 1000);
      if (fireTimers()) await nextTask();
      if (failed) return;
      const list = [...pending.values()];
      pending.clear();
      for (const cb of list) { try { cb(v); } catch (e) { fail(e); return; } }
      if (realNow() - lastYield > 100) {
        post({ type: 'sim', share: total ? v / total : 1 });
        await nextTask();
        lastYield = realNow();
      }
      if (v >= total) break;
    }
    setClock({ clock: { t: sim.to, playing: false, step: clock.step } });
    simulating = false;
    post({ type: 'sim', share: 1 });
    schedule();
  };

  const main = async function () {
__CODE__
  };
})();
`

/** A node's rest clock (LiveNode.rest, from the board file), checked. */
function restOf(rest: unknown): { t: number; step: string | null } | null {
  if (!rest || typeof rest !== 'object') return null
  const { t, step } = rest as { t?: unknown; step?: unknown }
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null
  return { t, step: typeof step === 'string' ? step : null }
}

/** Lines before the agent's first line in the worker script. */
const CODE_LINE = TEMPLATE.slice(0, TEMPLATE.indexOf('__CODE__')).split('\n').length

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function programUrl(code: string): string {
  return `data:text/javascript;base64,${base64(TEMPLATE.replace('__CODE__', () => programBody(code)))}`
}

/** "…:LINE:COL" positions of the worker script in an error, as the agent's lines. */
function mapLines(message: string): string {
  return message
    .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'code')
    .replace(/code:(\d+):(\d+)/g, (_, line: string, col: string) => `line ${Number(line) - CODE_LINE + 1}:${col}`)
    .split('\n')
    .filter((line) => !/^\s+at (runFrame|emit|handle|Object\.dispatchEvent|<anonymous>|EventTarget\.dispatchEvent)\b/.test(line))
    .slice(0, 6)
    .join('\n')
}

function loadError(message: string, line: number): string {
  const where = line ? ` (line ${line - CODE_LINE + 1})` : ''
  return `${(message || 'The program failed to load.').replace(/^Uncaught /, '')}${where}`
}

// ---------- Frame messages: one listener for every item frame ----------

const byWindow = new Map<Window, ProgramHost>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('message', (event) => {
    const source = event.source as Window | null
    const host = source ? byWindow.get(source) : undefined
    if (host && event.origin === 'null') host.fromFrame(event.data)
  })
}

export interface ProgramStart {
  code: string
  size: CanvasSize
  params: Record<string, number>
  start: number
  visible: boolean
  clock?: LiveClock | null
  /** With no clock: the scene clock the item rests at (LiveNode.rest), so scene.t and scene.step are those of its scene's end. */
  rest?: { t: number; step?: string } | null
  /** Load and set up only: the program does not run (the syntax check). */
  check?: boolean
  /** A storyboard frame: run from the item's first moment to the frame's moment on a virtual clock (see simulate in the worker). */
  sim?: ProgramSim | null
}

/** Run a program over scene time [from, to] (s): params samples [t, params] and steps [at, name] of the scene. */
export interface ProgramSim {
  from: number
  to: number
  params: Array<[number, Record<string, number>]> | null
  steps: Array<[number, string]>
}

/** One item frame and its worker. */
export class ProgramHost {
  readonly frame: HTMLIFrameElement
  private port: MessagePort | null
  private channel = new MessageChannel()
  private stills = new Map<number, (url: string | null) => void>()
  private nextStill = 1
  private started = false
  private disposed = false
  private hadClock = false
  private clockEnd = 0

  constructor(
    container: HTMLElement,
    private start: ProgramStart,
    private events: ProgramHostEvents
  ) {
    listen()
    const frame = document.createElement('iframe')
    frame.className = 'node-live__frame'
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('aria-hidden', 'true')
    frame.src = `${LIVE_ORIGIN}/frame.html`
    this.frame = frame
    container.prepend(frame)
    if (frame.contentWindow) byWindow.set(frame.contentWindow, this)
    this.port = this.channel.port1
    this.port.onmessage = (event) => this.receive(event.data)
    this.hadClock = !!start.clock
    if (start.clock) this.clockEnd = start.clock.end
    else if (start.rest) this.clockEnd = start.rest.t
  }

  /** A message from the frame (ready, load errors, Escape). */
  fromFrame(data: unknown): void {
    if (!data || typeof data !== 'object' || this.disposed) return
    const m = data as { type?: unknown; message?: unknown; line?: unknown }
    if (m.type === 'ready' && !this.started) {
      this.started = true
      const s = this.start
      const init = { w: s.size.w, h: s.size.h, pw: s.size.pw, ph: s.size.ph, params: s.params, start: s.start, colors: boardColors(), visible: s.visible, clock: s.clock ?? null, rest: restOf(s.rest), check: !!s.check, sim: s.sim ?? null }
      this.frame.contentWindow?.postMessage({ type: 'start', url: programUrl(s.code), port: this.channel.port2, init }, '*', [this.channel.port2])
    } else if (m.type === 'load-error') {
      this.events.onError(loadError(typeof m.message === 'string' ? m.message : '', typeof m.line === 'number' ? m.line : 0))
      this.stop()
    } else if (m.type === 'escape') this.events.onEscape()
  }

  private receive(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const m = data as { type?: unknown; frames?: unknown; message?: unknown; id?: unknown; blob?: unknown; mode?: unknown; values?: unknown }
    if (m.type === 'alive' && typeof m.frames === 'number') this.events.onTick(m.frames)
    else if (m.type === 'sim') this.events.onProgress?.()
    else if (m.type === 'error' && typeof m.message === 'string') {
      this.events.onError(mapLines(m.message))
      this.stop()
    } else if (m.type === 'input' && (m.mode === 'none' || m.mode === 'enter' || m.mode === 'direct')) this.events.onInput(m.mode)
    else if (m.type === 'report') this.events.onReport(m.values)
    else if (m.type === 'still' && typeof m.id === 'number') {
      const resolve = this.stills.get(m.id)
      if (!resolve) return
      this.stills.delete(m.id)
      if (!(m.blob instanceof Blob)) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(m.blob)
    }
  }

  get alive(): boolean {
    return this.port !== null
  }

  run(on: boolean): void {
    this.port?.postMessage({ type: 'run', on })
  }

  resize(size: CanvasSize): void {
    this.port?.postMessage({ type: 'size', w: size.w, h: size.h, pw: size.pw, ph: size.ph })
  }

  setParams(params: Record<string, number>): void {
    this.port?.postMessage({ type: 'params', params })
  }

  /** The scene clock now, or null when no scene plays the item. */
  setClock(clock: LiveClock | null): void {
    if (!clock && !this.hadClock) return
    this.hadClock = !!clock
    if (clock) this.clockEnd = clock.end
    this.port?.postMessage({ type: 'clock', clock, end: this.clockEnd })
  }

  setEntered(on: boolean): void {
    this.port?.postMessage({ type: 'entered', on })
    if (on) {
      this.frame.focus()
      this.frame.contentWindow?.postMessage({ type: 'focus' }, '*')
    }
  }

  /** The current pixels as a PNG data URL; null when the worker does not answer within `ms`. */
  still(ms = 1500): Promise<string | null> {
    const port = this.port
    if (!port) return Promise.resolve(null)
    const id = this.nextStill++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.stills.delete(id)
        resolve(null)
      }, ms)
      this.stills.set(id, (url) => {
        clearTimeout(timer)
        resolve(url)
      })
      port.postMessage({ type: 'still', id })
    })
  }

  /** End the worker. The frame keeps its last picture. */
  stop(): void {
    this.frame.contentWindow?.postMessage({ type: 'stop' }, '*')
    this.port?.close()
    this.port = null
    for (const resolve of this.stills.values()) resolve(null)
    this.stills.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    for (const [win, host] of byWindow) if (host === this) byWindow.delete(win)
    this.frame.remove()
  }
}

/**
 * Check a program before a scene plays it: run it for a moment in a hidden
 * frame and return its first error (syntax, a failed import, a runtime error
 * in its setup or first frames), or null.
 */
export function programError(code: string, params: Record<string, number>, size: [number, number] = [320, 200], ms = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden'
    document.body.appendChild(box)
    let host: ProgramHost | null = null
    const done = (result: string | null): void => {
      clearTimeout(timer)
      host?.dispose()
      box.remove()
      resolve(result)
    }
    const timer = setTimeout(() => done(null), ms)
    host = new ProgramHost(
      box,
      { code, size: { w: size[0], h: size[1], pw: size[0], ph: size[1] }, params, start: performance.timeOrigin + performance.now(), visible: true, clock: null },
      {
        // Set up and a few frames painted: it runs. A program with no frame loop passes at the time limit.
        onTick: (frames) => {
          if (frames >= 3) done(null)
        },
        onError: (message) => done(message),
        onInput: () => undefined,
        onReport: () => undefined,
        onEscape: () => undefined
      }
    )
  })
}
