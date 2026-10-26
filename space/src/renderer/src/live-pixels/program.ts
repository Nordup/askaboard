import { LIVE_ORIGIN, programBody } from '@shared/live-libs'
import { boardColors } from './sandbox'
import { runtimeCall } from './runtime'
import { WorkerLink, type CanvasSize, type HostEvents, type HostStart, type LiveFrame, type LiveHost } from './host'
import type { ItemClock, SceneView } from './clock'

/**
 * Program mode of live pixel items: the agent's code is a whole program. It
 * runs once, in a worker, with the item's OffscreenCanvas, and owns its
 * contexts (2D, WebGL 2, WebGPU) and its state. Its loop
 * (requestAnimationFrame), timers and time run in ticks of item time
 * (runtime.ts, clock.ts).
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
 * The page talks to the worker through the port (the host protocol, host.ts,
 * plus input state); the worker answers with alive ticks, errors, frames,
 * report() values and its input mode. The board's main thread never runs the
 * agent's code and never waits for it.
 */

/** The worker script. __RUNTIME__ is the tick runtime; __CODE__ is the agent's program as an async function body (shared/live-libs.ts programBody). */
const TEMPLATE = `'use strict';
(() => {
  const scope = self;
  const toFrame = scope.postMessage.bind(scope);
  let port = null;
  const post = (m) => { if (port) { try { port.postMessage(m); } catch (e) { post({ type: 'error', message: 'report: values must be plain data' }); } } };
  const kind = { post, draws: false };
  const rt = __RUNTIME__;
  let canvas = null, w = 1, h = 1, pw = 1, ph = 1;
  const params = {};
  const colors = {};
  const scene = Object.freeze({
    get t() { return rt.sceneTime(); },
    get playing() { return rt.scene.playing; },
    get active() { return rt.scene.active; },
    get ended() { return rt.scene.ended; },
    get step() { return rt.scene.step; }
  });
  const item = Object.freeze({
    get w() { return w; },
    get h() { return h; },
    get dpr() { return pw / Math.max(1e-6, w); },
    get t() { return rt.itemTime(); }
  });

  const emit = (type, props) => {
    if (!canvas) return;
    const e = new Event(type, { cancelable: true });
    for (const k in props) if (k !== 'type') { try { Object.defineProperty(e, k, { value: props[k], enumerable: true }); } catch (x) {} }
    try { canvas.dispatchEvent(e); } catch (error) { rt.fail(error); }
  };
  let lastReport = 0, reportTimer = 0, reportValue;
  const sendReport = () => { reportTimer = 0; lastReport = rt.realNow(); post({ type: 'report', values: reportValue }); };
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
      const wait = 100 - (rt.realNow() - lastReport);
      if (wait <= 0) sendReport(); else reportTimer = rt.setTimeout(sendReport, wait);
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

  kind.init = (m) => {
    w = m.w; h = m.h; pw = m.pw; ph = m.ph;
    Object.assign(params, m.params);
    Object.assign(colors, m.colors);
    Object.freeze(colors);
    m.canvas.width = pw; m.canvas.height = ph;
    shim(m.canvas);
    canvas = m.canvas;
  };
  kind.start = () => main();
  kind.tick = () => true;
  kind.params = (p) => { Object.assign(params, p); };
  kind.step = (name, previous) => emit('step', { name, previous });
  kind.resize = (m) => {
    const resized = m.pw !== pw || m.ph !== ph || m.w !== w || m.h !== h;
    w = m.w; h = m.h; pw = m.pw; ph = m.ph;
    if (canvas && (canvas.width !== pw || canvas.height !== ph)) { canvas.width = pw; canvas.height = ph; }
    if (resized) emit('resize', { w, h, dpr: item.dpr });
  };
  kind.capture = () => canvas.convertToBlob({ type: 'image/png' });
  kind.message = (m) => { if (m.type === 'entered') emit(m.on ? 'enter' : 'leave', {}); };

  scope.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'input' && m.event && typeof m.event.type === 'string') { emit(m.event.type, m.event); return; }
    if (m.type !== 'init' || port) return;
    port = m.port;
    port.onmessage = (e) => rt.handle(e.data);
    rt.handle(m);
  });

  const main = async function () {
__CODE__
  };
})();
`

function programSource(code: string): string {
  return TEMPLATE.replace('__RUNTIME__', () => runtimeCall('scope', 'kind')).replace('__CODE__', () => code)
}

/** Lines before the agent's first line in the worker script. */
const CODE_LINE = ((prefix: string) => prefix.slice(0, prefix.indexOf('\u0000')).split('\n').length)(programSource('\u0000'))

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function programUrl(code: string): string {
  return `data:text/javascript;base64,${base64(programSource(programBody(code)))}`
}

/** "…:LINE:COL" positions of the worker script in an error, as the agent's lines. */
function mapLines(message: string): string {
  return message
    .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'code')
    .replace(/code:(\d+):(\d+)/g, (_, line: string, col: string) => `line ${Number(line) - CODE_LINE + 1}:${col}`)
    .split('\n')
    .filter((line) => !/^\s+at (draw|runTick|liveFrame|redraw|advance|emit|handle|Object\.dispatchEvent|<anonymous>|EventTarget\.dispatchEvent)\b/.test(line))
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

/** One item frame and its worker. A step host's frame sits in a hidden box of its own. */
export class ProgramHost implements LiveHost {
  readonly element: HTMLIFrameElement | null
  private readonly frame: HTMLIFrameElement
  /** A step host's hidden box (removed with the host). */
  private box: HTMLElement | null = null
  private port: MessagePort | null
  private channel = new MessageChannel()
  private link: WorkerLink
  private started = false
  private disposed = false

  constructor(
    private start: HostStart,
    private events: HostEvents,
    container: HTMLElement | null
  ) {
    listen()
    const frame = document.createElement('iframe')
    frame.className = 'node-live__frame'
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('aria-hidden', 'true')
    frame.src = `${LIVE_ORIGIN}/frame.html`
    this.frame = frame
    if (container) {
      this.element = frame
      container.prepend(frame)
    } else {
      this.element = null
      const box = document.createElement('div')
      box.style.cssText = `position:fixed;left:0;top:0;width:${Math.max(1, Math.round(start.size.w))}px;height:${Math.max(1, Math.round(start.size.h))}px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden`
      box.appendChild(frame)
      document.body.appendChild(box)
      this.box = box
    }
    if (frame.contentWindow) byWindow.set(frame.contentWindow, this)
    this.port = this.channel.port1
    const fail = (message: string): void => {
      this.stop()
      events.onError(message)
    }
    this.link = new WorkerLink((message) => this.port?.postMessage(message), { ...events, onError: fail }, mapLines)
    this.port.onmessage = (event) => this.receive(event.data)
  }

  /** A message from the frame (ready, load errors, Escape). */
  fromFrame(data: unknown): void {
    if (!data || typeof data !== 'object' || this.disposed) return
    const m = data as { type?: unknown; message?: unknown; line?: unknown }
    if (m.type === 'ready' && !this.started) {
      this.started = true
      const s = this.start
      const init = {
        seed: s.seed,
        mode: s.mode,
        from: s.from,
        clock: s.clock,
        scene: s.scene,
        timeline: s.timeline,
        visible: s.visible,
        w: s.size.w,
        h: s.size.h,
        pw: s.size.pw,
        ph: s.size.ph,
        params: s.params,
        colors: boardColors()
      }
      this.frame.contentWindow?.postMessage({ type: 'start', url: programUrl(s.code), port: this.channel.port2, init }, '*', [this.channel.port2])
    } else if (m.type === 'load-error') {
      this.stop()
      this.events.onError(loadError(typeof m.message === 'string' ? m.message : '', typeof m.line === 'number' ? m.line : 0))
    } else if (m.type === 'escape') this.events.onEscape?.()
  }

  private receive(data: unknown): void {
    if (this.link.receive(data) || !data || typeof data !== 'object') return
    const m = data as { type?: unknown; mode?: unknown; values?: unknown }
    if (m.type === 'input' && (m.mode === 'none' || m.mode === 'enter' || m.mode === 'direct')) this.events.onInput?.(m.mode)
    else if (m.type === 'report') this.events.onReport?.(m.values)
  }

  follow(clock: ItemClock, scene: SceneView): void {
    this.port?.postMessage({ type: 'clock', clock, scene })
  }

  goLive(clock: ItemClock, scene: SceneView, params: Record<string, number>): void {
    this.port?.postMessage({ type: 'live', clock, scene, params })
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

  advance(to: number, capture: boolean): Promise<LiveFrame | null> {
    return this.link.request({ type: 'advance', to, capture })
  }

  capture(): Promise<LiveFrame | null> {
    return this.link.request({ type: 'capture' }, 1500)
  }

  setEntered(on: boolean): void {
    this.port?.postMessage({ type: 'entered', on })
    if (on) {
      this.frame.focus()
      this.frame.contentWindow?.postMessage({ type: 'focus' }, '*')
    }
  }

  /** End the worker. The frame keeps its last picture. */
  stop(): void {
    this.frame.contentWindow?.postMessage({ type: 'stop' }, '*')
    this.port?.close()
    this.port = null
    this.link.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    for (const [win, host] of byWindow) if (host === this) byWindow.delete(win)
    this.frame.remove()
    this.box?.remove()
  }
}
