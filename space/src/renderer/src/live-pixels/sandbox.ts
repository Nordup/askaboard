import { runtimeCall } from './runtime'
import { WorkerLink, type CanvasSize, type HostEvents, type HostStart, type LiveFrame, type LiveHost } from './host'
import type { ItemClock, SceneView } from './clock'

/**
 * Canvas mode of live pixel items: the agent's code is the body of a draw
 * function that runs once per tick in a sandboxed worker, one per item. It
 * paints an OffscreenCanvas: on the board the item's <canvas> shows it
 * (transferControlToOffscreen: frames go from the worker to the compositor;
 * the board's main thread never runs the agent's code and never waits for
 * it); a step host (previews, stills) paints a canvas of the worker's own.
 *
 * The sandbox, in layers:
 * 1. A dedicated Worker: no DOM, no access to the app's objects, its own
 *    thread. An endless loop blocks only this worker; the board keeps
 *    running, and the host terminates the worker when it hangs off screen,
 *    is deleted or gets new code.
 * 2. Its script is a `data:` URL, so the worker has an opaque origin: no
 *    access to the app's storage (IndexedDB, caches, cookies) or to other
 *    workers' channels, and same-origin requests to the app are cross-origin.
 * 3. It inherits the page's Content-Security-Policy (index.html): no network
 *    outside the app origin, no learning-folder files (space-asset:), no eval.
 * 4. Before the agent's code runs, a prelude starts the tick runtime
 *    (runtime.ts: item time, seeded Math.random, ticks, captures), then
 *    removes the network, storage and worker APIs from the worker's global
 *    scope (fetch, XMLHttpRequest, WebSocket, importScripts, Worker,
 *    indexedDB, caches, navigator, …).
 * 5. The host accepts only its own message shapes from the worker.
 * The agent's code is inlined as a function body (no eval is needed, so the
 * page's CSP can stay strict).
 */

/**
 * The board colour tokens for canvas code, as CSS colour strings in the global
 * `colors` (colors.accent, colors.text, … colors.bg), read once from content.css.
 */
let colorCache: Record<string, string> | null = null
export function boardColors(): Record<string, string> {
  if (colorCache) return colorCache
  const probe = document.createElement('div')
  probe.className = 'board__content'
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const read = (name: string): string => style.getPropertyValue(name).trim()
  colorCache = {
    text: read('--ls-text'),
    muted: read('--ls-muted'),
    accent: read('--ls-accent'),
    good: read('--ls-good'),
    bad: read('--ls-bad'),
    warn: read('--ls-warn'),
    card: read('--ls-card'),
    card2: read('--ls-card-2'),
    border: read('--ls-border'),
    bg: read('--bg-canvas')
  }
  probe.remove()
  return colorCache
}

/** Agent-facing description of the function the code is the body of. */
export const CANVAS_SIGNATURE = 'function (ctx, t, w, h, params, dt)'

const BLOCKED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'importScripts',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'MessageChannel',
  'indexedDB',
  'caches',
  'cookieStore',
  'navigator',
  'Request',
  'Response',
  'Headers',
  'RTCPeerConnection',
  'RTCDataChannel',
  'FileSystemHandle',
  'FileSystemDirectoryHandle',
  'FileSystemFileHandle',
  'webkitRequestFileSystem',
  'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL',
  'webkitResolveLocalFileSystemSyncURL',
  'reportError',
  'postMessage',
  'close',
  'onmessage',
  'onerror',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent'
]

/**
 * The worker script. Placeholders: __RUNTIME__ (the tick runtime),
 * __BLOCKED__ (JSON array), __CODE__ (the agent's function body). Everything
 * the prelude and the runtime need is captured before the globals go.
 */
const TEMPLATE = `'use strict';
const __ls = (() => {
  const scope = self;
  const post = scope.postMessage.bind(scope);
  const listen = scope.addEventListener.bind(scope);
  const addListener = scope.EventTarget.prototype.addEventListener;
  const freeze = Object.freeze;
  const assign = Object.assign;
  const kind = { post, draws: true };
  const rt = __RUNTIME__;
  const blocked = __BLOCKED__;
  for (const name of blocked) {
    let target = scope;
    while (target) {
      try { delete target[name]; } catch (e) {}
      try { if (Object.prototype.hasOwnProperty.call(target, name)) Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
      target = Object.getPrototypeOf(target);
    }
  }
  return { post, listen, addListener, freeze, assign, kind, rt };
})();
let colors = Object.freeze({});
const __lsDraw = (function () { return function (ctx, t, w, h, params, dt) {
__CODE__
}; })();
(() => {
  const { post, listen, addListener, freeze, assign, kind, rt } = __ls;
  let canvas = null, ctx = null, w = 1, h = 1, scale = 1, params = freeze({});
  const state = {};
  kind.init = (m) => {
    canvas = m.canvas; ctx = canvas.getContext('2d');
    addListener.call(canvas, 'contextlost', () => post({ type: 'lost' }));
    w = m.w; h = m.h; scale = m.pw / Math.max(1e-6, m.w); params = freeze(assign({}, m.params)); colors = freeze(assign({}, m.colors));
    canvas.width = m.pw; canvas.height = m.ph;
  };
  kind.start = () => undefined;
  kind.tick = (t, dt) => {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    try { __lsDraw.call(state, ctx, t, w, h, params, dt); }
    catch (error) { ctx.restore(); rt.fail(error); return false; }
    ctx.restore();
    return true;
  };
  kind.params = (p) => { params = freeze(assign({}, p)); };
  kind.step = () => undefined;
  kind.resize = (m) => {
    w = m.w; h = m.h; scale = m.pw / Math.max(1e-6, m.w);
    if (canvas.width !== m.pw || canvas.height !== m.ph) { canvas.width = m.pw; canvas.height = m.ph; }
  };
  kind.capture = () => canvas.convertToBlob({ type: 'image/png' });
  kind.message = (m) => { if (m.type === 'ping') post({ type: 'pong' }); };
  listen('message', (event) => rt.handle(event.data));
})();
`

function workerSource(code: string): string {
  return TEMPLATE.replace('__RUNTIME__', () => runtimeCall('scope', 'kind'))
    .replace('__BLOCKED__', () => JSON.stringify(BLOCKED))
    .replace('__CODE__', () => code)
}

/** Lines before the agent's first line in the worker script. */
const CODE_LINE = ((prefix: string) => prefix.slice(0, prefix.indexOf('\u0000')).split('\n').length)(workerSource('\u0000'))

function workerUrl(code: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource(code))}`
}

/** "…:LINE:COL" positions in a worker error, mapped to the agent's lines. */
function mapLines(message: string): string {
  return message
    .replace(/data:text\/javascript[^\s):]*/g, 'code')
    .replace(/code:(\d+):(\d+)/g, (_, line: string, col: string) => `line ${Number(line) - CODE_LINE + 1}:${col}`)
    .split('\n')
    .filter((line) => !/^\s+at (kind\.tick|draw|runTick|liveFrame|redraw|advance|<anonymous>)/.test(line))
    .slice(0, 6)
    .join('\n')
}

function loadError(event: ErrorEvent): string {
  const where = event.lineno ? ` (line ${event.lineno - CODE_LINE + 1})` : ''
  return `${event.message || 'The canvas code failed to load.'}${where}`
}

/** One sandboxed worker running one canvas item. */
export class CanvasHost implements LiveHost {
  readonly element: HTMLCanvasElement | null
  private worker: Worker | null
  private link: WorkerLink
  private disposed = false

  constructor(start: HostStart, events: HostEvents, container: HTMLElement | null) {
    const size = start.size
    let offscreen: OffscreenCanvas
    if (container) {
      const canvas = document.createElement('canvas')
      canvas.className = 'node-live__canvas'
      canvas.width = size.pw
      canvas.height = size.ph
      container.prepend(canvas)
      this.element = canvas
      offscreen = canvas.transferControlToOffscreen()
    } else {
      this.element = null
      offscreen = new OffscreenCanvas(size.pw, size.ph)
    }
    const worker = new Worker(workerUrl(start.code), { name: 'live-canvas' })
    this.worker = worker
    const fail = (message: string): void => {
      this.stop()
      events.onError(message)
    }
    this.link = new WorkerLink((message) => this.worker?.postMessage(message), { ...events, onError: fail }, mapLines)
    worker.addEventListener('message', (event: MessageEvent) => this.link.receive(event.data))
    worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault()
      fail(loadError(event))
    })
    worker.addEventListener('messageerror', () => undefined)
    worker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        seed: start.seed,
        mode: start.mode,
        from: start.from,
        clock: start.clock,
        scene: start.scene,
        timeline: start.timeline,
        visible: start.visible,
        w: size.w,
        h: size.h,
        pw: size.pw,
        ph: size.ph,
        params: start.params,
        colors: boardColors()
      },
      [offscreen]
    )
  }

  follow(clock: ItemClock, scene: SceneView): void {
    this.worker?.postMessage({ type: 'clock', clock, scene })
  }

  goLive(clock: ItemClock, scene: SceneView, params: Record<string, number>): void {
    this.worker?.postMessage({ type: 'live', clock, scene, params })
  }

  run(on: boolean): void {
    this.worker?.postMessage({ type: 'run', on })
  }

  resize(size: CanvasSize): void {
    this.worker?.postMessage({ type: 'size', w: size.w, h: size.h, pw: size.pw, ph: size.ph })
  }

  setParams(params: Record<string, number>): void {
    this.worker?.postMessage({ type: 'params', params })
  }

  advance(to: number, capture: boolean): Promise<LiveFrame | null> {
    return this.link.request({ type: 'advance', to, capture })
  }

  capture(): Promise<LiveFrame | null> {
    return this.link.request({ type: 'capture' }, 1500)
  }

  setEntered(): void {
    // Canvas items take no input.
  }

  /** Terminate the worker (an endless loop ends here). The canvas keeps its last frame. */
  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.link.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.element?.remove()
  }
}

/**
 * Check canvas code without showing it: load it in a sandboxed worker and
 * report a syntax error, or null when the code loads. Runtime errors show
 * only when the code runs.
 */
export function canvasSyntaxError(code: string, ms = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(workerUrl(code), { name: 'live-canvas-check' })
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    const done = (result: string | null): void => {
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    // The worker answers the ping only when its script loaded; a load error comes first.
    const timer = setTimeout(() => done(null), ms)
    worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault()
      done(loadError(event))
    })
    worker.addEventListener('message', () => done(null))
    worker.postMessage({ type: 'ping' })
  })
}
