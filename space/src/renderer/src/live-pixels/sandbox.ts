/**
 * Canvas mode of live pixel items: the agent's code runs in a sandboxed
 * worker, one per item, and paints an OffscreenCanvas that the item's
 * <canvas> shows (transferControlToOffscreen: frames go from the worker to
 * the compositor; the board's main thread never runs the agent's code and
 * never waits for it).
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
 * 4. Before the agent's code runs, a prelude removes the network, storage
 *    and worker APIs from the worker's global scope (fetch, XMLHttpRequest,
 *    WebSocket, importScripts, Worker, indexedDB, caches, navigator, …).
 * 5. The host accepts only its own message shapes from the worker.
 * The agent's code is inlined as a function body (no eval is needed, so the
 * page's CSP can stay strict).
 */

/**
 * The board colour tokens for canvas code, as CSS colour strings in the global
 * `colors` (colors.accent, colors.text, … colors.bg), read once from content.css.
 */
let colorCache: Record<string, string> | null = null
function boardColors(): Record<string, string> {
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

export interface CanvasHostEvents {
  onTick(frames: number): void
  onError(message: string): void
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
 * The worker script. Placeholders: __BLOCKED__ (JSON array), __CODE__ (the
 * agent's function body). Everything the prelude needs is captured before
 * the globals go.
 */
const TEMPLATE = `'use strict';
const __ls = (() => {
  const scope = self;
  const post = scope.postMessage.bind(scope);
  const listen = scope.addEventListener.bind(scope);
  const raf = scope.requestAnimationFrame.bind(scope);
  const caf = scope.cancelAnimationFrame.bind(scope);
  const perf = scope.performance;
  const now = perf.now.bind(perf);
  const freeze = Object.freeze;
  const assign = Object.assign;
  const blocked = __BLOCKED__;
  for (const name of blocked) {
    let target = scope;
    while (target) {
      try { delete target[name]; } catch (e) {}
      try { if (Object.prototype.hasOwnProperty.call(target, name)) Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
      target = Object.getPrototypeOf(target);
    }
  }
  return { post, listen, raf, caf, perf, now, freeze, assign };
})();
let colors = Object.freeze({});
const __lsDraw = (function () { return function (ctx, t, w, h, params, dt) {
__CODE__
}; })();
(() => {
  const { post, listen, raf, caf, perf, now, freeze, assign } = __ls;
  let canvas = null, ctx = null, w = 1, h = 1, scale = 1, params = freeze({}), start = 0;
  let running = false, handle = 0, frames = 0, lastTick = 0, last = 0, failed = false;
  const state = {};
  const fail = (error) => {
    failed = true;
    running = false;
    caf(handle);
    const message = error && error.stack ? String(error.stack) : String(error);
    post({ type: 'error', message });
  };
  const paint = () => {
    const at = perf.timeOrigin + now();
    const t = (at - start) / 1000;
    const dt = last ? (at - last) / 1000 : 0;
    last = at;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    try { __lsDraw.call(state, ctx, t, w, h, params, dt); }
    catch (error) { ctx.restore(); fail(error); return false; }
    ctx.restore();
    frames++;
    return true;
  };
  const frame = () => {
    if (!running) return;
    handle = raf(frame);
    if (!paint()) return;
    const at = now();
    if (at - lastTick > 250) { lastTick = at; post({ type: 'tick', frames }); }
  };
  const run = (on) => {
    if (failed) return;
    if (on && !running) { running = true; last = 0; handle = raf(frame); }
    else if (!on && running) { running = false; caf(handle); }
  };
  listen('message', (event) => {
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      canvas = m.canvas; ctx = canvas.getContext('2d');
      w = m.w; h = m.h; scale = m.scale; start = m.start; params = freeze(assign({}, m.params)); colors = freeze(assign({}, m.colors));
      canvas.width = m.pw; canvas.height = m.ph;
      post({ type: 'tick', frames });
    } else if (m.type === 'size') {
      w = m.w; h = m.h; scale = m.scale;
      if (canvas.width !== m.pw || canvas.height !== m.ph) { canvas.width = m.pw; canvas.height = m.ph; if (!running && !failed) paint(); }
    } else if (m.type === 'params') {
      params = freeze(assign({}, m.params));
    } else if (m.type === 'run') {
      run(!!m.on);
    } else if (m.type === 'ping') {
      post({ type: 'pong' });
    } else if (m.type === 'still') {
      if (!running && !failed) paint();
      canvas.convertToBlob({ type: 'image/png' }).then(
        (blob) => post({ type: 'still', id: m.id, blob }),
        () => post({ type: 'still', id: m.id, blob: null })
      );
    }
  });
})();
`

/** Lines before the agent's first line in the worker script. */
const CODE_LINE = TEMPLATE.slice(0, TEMPLATE.indexOf('__CODE__')).split('\n').length

function workerSource(code: string): string {
  return TEMPLATE.replace('__BLOCKED__', JSON.stringify(BLOCKED)).replace('__CODE__', () => code)
}

function workerUrl(code: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource(code))}`
}

/** "…:LINE:COL" positions in a worker error, mapped to the agent's lines. */
function mapLines(message: string): string {
  return message
    .replace(/data:text\/javascript[^\s):]*/g, 'code')
    .replace(/code:(\d+):(\d+)/g, (_, line: string, col: string) => `line ${Number(line) - CODE_LINE + 1}:${col}`)
    .split('\n')
    .filter((line) => !/^\s+at (frame|paint|<anonymous>)/.test(line))
    .slice(0, 6)
    .join('\n')
}

export interface CanvasSize {
  /** Board points. */
  w: number
  h: number
  /** Device pixels of the backing store. */
  pw: number
  ph: number
}

/** One sandboxed worker painting one <canvas>. */
export class CanvasHost {
  private worker: Worker | null
  private stills = new Map<number, (url: string | null) => void>()
  private nextStill = 1
  private disposed = false

  constructor(
    readonly canvas: HTMLCanvasElement,
    code: string,
    size: CanvasSize,
    params: Record<string, number>,
    start: number,
    private events: CanvasHostEvents
  ) {
    const offscreen = canvas.transferControlToOffscreen()
    const worker = new Worker(workerUrl(code), { name: 'live-canvas' })
    this.worker = worker
    worker.addEventListener('message', (event: MessageEvent) => this.receive(event.data))
    worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault()
      const where = event.lineno ? ` (line ${event.lineno - CODE_LINE + 1})` : ''
      this.events.onError(`${event.message || 'The canvas code failed to load.'}${where}`)
      this.stop()
    })
    worker.addEventListener('messageerror', () => undefined)
    worker.postMessage({ type: 'init', canvas: offscreen, w: size.w, h: size.h, pw: size.pw, ph: size.ph, scale: size.pw / Math.max(1e-6, size.w), params, start, colors: boardColors() }, [offscreen])
  }

  private receive(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const m = data as { type?: unknown; frames?: unknown; message?: unknown; id?: unknown; blob?: unknown }
    if (m.type === 'tick' && typeof m.frames === 'number') this.events.onTick(m.frames)
    else if (m.type === 'error' && typeof m.message === 'string') {
      this.events.onError(mapLines(m.message))
      this.stop()
    } else if (m.type === 'still' && typeof m.id === 'number') {
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
    return this.worker !== null
  }

  run(on: boolean): void {
    this.worker?.postMessage({ type: 'run', on })
  }

  resize(size: CanvasSize): void {
    this.worker?.postMessage({ type: 'size', w: size.w, h: size.h, pw: size.pw, ph: size.ph, scale: size.pw / Math.max(1e-6, size.w) })
  }

  setParams(params: Record<string, number>): void {
    this.worker?.postMessage({ type: 'params', params })
  }

  /** The current pixels as a PNG data URL; null when the worker does not answer within `ms`. */
  still(ms = 800): Promise<string | null> {
    const worker = this.worker
    if (!worker) return Promise.resolve(null)
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
      worker.postMessage({ type: 'still', id })
    })
  }

  /** Terminate the worker (an endless loop ends here). The canvas keeps its last frame. */
  stop(): void {
    this.worker?.terminate()
    this.worker = null
    for (const resolve of this.stills.values()) resolve(null)
    this.stills.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
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
      const where = event.lineno ? ` (line ${event.lineno - CODE_LINE + 1})` : ''
      done(`${event.message || 'The canvas code failed to load.'}${where}`)
    })
    worker.addEventListener('message', () => done(null))
    worker.postMessage({ type: 'ping' })
  })
}
