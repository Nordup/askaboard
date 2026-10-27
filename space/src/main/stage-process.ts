import { join } from 'node:path'
import { app, MessageChannelMain, session, WebContentsView, type MessagePortMain, type Session } from 'electron'
import { parseFromStage, refusedHostId, refusedId, type FromStage, type ToStage } from '@shared/stage-protocol'
import pageScript from '../stage/page.ts?stage'
import workerScript from '../stage/worker.ts?stage'

/**
 * The stage process: a hidden, sandboxed Chromium renderer in which every
 * scene program runs, in V8 with its JIT (live-scene.ts drives it; the page is
 * stage/page.ts, the program's realm is the worker stage/worker.ts).
 *
 * It is a WebContentsView in no window (it never shows, and it does not keep
 * the app open) with its own in-memory session. The session serves only the
 * page and its two scripts, from memory, on ls-stage://stage/, with
 * cross-origin isolation (COOP and COEP: the worker blocks on a
 * SharedArrayBuffer) and a Content-Security-Policy that allows no network
 * request. Every other request is cancelled (fetch, WebSocket, WebRTC's
 * hosts), every permission is refused, downloads are cancelled, navigation
 * and new windows are refused. The page has no Node and no Electron API;
 * its preload (preload/stage.ts) only hands it its MessagePorts: one to the
 * main process, on which both sides check every message
 * (shared/stage-protocol.ts), and one to the board renderer for the frames of
 * scenes (live-scene.ts linkFrames), on which the board checks every chunk.
 *
 * A crash or an out-of-memory in this process does not touch the board:
 * live-scene.ts gets onGone, and the next program starts a new process and
 * rebuilds the stage from its log.
 */

export const STAGE_SCHEME = 'ls-stage'
/** For protocol.registerSchemesAsPrivileged (index.ts): a secure, standard origin, which cross-origin isolation needs. */
export const STAGE_SCHEME_PRIVILEGES = { scheme: STAGE_SCHEME, privileges: { standard: true, secure: true } }

const ORIGIN = `${STAGE_SCHEME}://stage`
const PAGE_URL = `${ORIGIN}/index.html`
const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Stage</title><script src="page.js"></script></head><body></body></html>'
const FILES = new Map<string, { body: string; type: string }>([
  ['/index.html', { body: PAGE_HTML, type: 'text/html; charset=utf-8' }],
  ['/page.js', { body: pageScript, type: 'text/javascript; charset=utf-8' }],
  ['/worker.js', { body: workerScript, type: 'text/javascript; charset=utf-8' }]
])
const HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  // eval: the worker runs the scene library and each program with it. blob: the throwaway worker that finds a parse error's line (page.ts).
  'content-security-policy': `default-src 'none'; script-src ${STAGE_SCHEME}: 'unsafe-eval'; worker-src ${STAGE_SCHEME}: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}
/** The page waits this long at most for its scripts and its port. */
const START_TIMEOUT_MS = 20_000

let stageSessionOnce: Session | null = null

/** The stage's own in-memory session, with every rule above (made once per app run). */
function stageSession(): Session {
  if (stageSessionOnce) return stageSessionOnce
  const ses = session.fromPartition('ls-stage', { cache: false })
  ses.protocol.handle(STAGE_SCHEME, (request) => {
    const url = new URL(request.url)
    const file = request.method === 'GET' && url.host === 'stage' ? FILES.get(url.pathname) : undefined
    if (!file) return new Response('Not found', { status: 404, headers: HEADERS })
    return new Response(file.body, { headers: { ...HEADERS, 'content-type': file.type } })
  })
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${ORIGIN}/`) || details.url.startsWith(`blob:${ORIGIN}/`)
    if (!allowed) console.warn(`stage: a request was refused: ${details.url.slice(0, 200)}`)
    callback({ cancel: !allowed })
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
  })
  ses.setSpellCheckerEnabled(false)
  stageSessionOnce = ses
  return ses
}

export class StageProcess {
  private view: WebContentsView | null = null
  private port: MessagePortMain | null = null
  private starting: Promise<void> | null = null

  /**
   * onMessage: every checked message from the page except "ready", with a reply function that sends only to that page (it does nothing after that process stopped).
   * onGone: the process stopped (a crash, an out-of-memory); it is not running any more. outOfMemory: V8 ran out of heap.
   */
  constructor(
    private readonly onMessage: (message: FromStage, reply: (answer: ToStage) => void) => void,
    private readonly onGone: (why: string, outOfMemory: boolean) => void
  ) {
    app.once('will-quit', () => this.stop())
  }

  get running(): boolean {
    return this.port !== null
  }

  /** Start the process (once); resolves when the page has its port and its settings. */
  start(init: Extract<ToStage, { t: 'init' }>): Promise<void> {
    if (this.port) return Promise.resolve()
    this.starting ??= this.launch(init).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  send(message: ToStage): void {
    this.port?.postMessage(message)
  }

  /** Hand the page a port to the board renderer, for frames (live-scene.ts linkFrames). The page answers "linked". */
  sendFramesPort(port: MessagePortMain): void {
    const view = this.view
    if (this.port && view && !view.webContents.isDestroyed()) view.webContents.postMessage('frames-port', null, [port])
    else port.close()
  }

  /** End the process now (nothing is reported to onGone). */
  stop(): void {
    const view = this.view
    this.view = null
    this.port?.close()
    this.port = null
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
  }

  private async launch(init: Extract<ToStage, { t: 'init' }>): Promise<void> {
    await app.whenReady()
    const started = Date.now()
    const view = new WebContentsView({
      webPreferences: {
        session: stageSession(),
        preload: join(__dirname, '../preload/stage.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
        images: false,
        webgl: false,
        plugins: false,
        spellcheck: false,
        enableWebSQL: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        // Hidden pages get slow timers and messages by default; the stage relays every host answer.
        backgroundThrottling: false
      }
    })
    this.view = view
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    let failStart: ((error: Error) => void) | null = null
    contents.on('render-process-gone', (_event, details) => {
      if (this.view !== view) return
      const why = `${details.reason}, exit code ${details.exitCode}`
      const wasRunning = this.port !== null
      this.stop()
      failStart?.(new Error(`the stage process stopped (${why})`))
      // V8 out of heap: Electron says "oom", or on macOS "crashed" with exit code 5 (seen for every heap-limit end).
      const outOfMemory = details.reason === 'oom' || (process.platform === 'darwin' && details.reason === 'crashed' && details.exitCode === 5)
      if (wasRunning) this.onGone(why, outOfMemory)
    })
    try {
      await contents.loadURL(PAGE_URL)
      const { port1, port2 } = new MessageChannelMain()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the stage page did not answer')), START_TIMEOUT_MS)
        failStart = (error) => {
          clearTimeout(timer)
          reject(error)
        }
        port1.on('message', (event) => {
          let message = parseFromStage(event.data)
          if (!message) {
            // Nothing waits forever on a refused message: a reply still settles its call, a question gets an error answer.
            console.warn('stage: a message of the wrong shape from the stage page was refused')
            const id = refusedId(event.data)
            const hid = refusedHostId(event.data)
            if (id !== null) message = { t: 'reply', id, ok: false, error: 'The stage sent a reply of the wrong shape or larger than the app takes.', line: null, file: null, ms: 0 }
            else if (hid !== null && this.port === port1) port1.postMessage({ t: 'answer', hid, text: JSON.stringify({ error: 'The question to the board was of the wrong shape or larger than the app takes.' }) } satisfies ToStage)
            if (!message) return
          }
          if (message.t === 'ready') {
            clearTimeout(timer)
            resolve()
          } else if (this.port === port1)
            this.onMessage(message, (answer) => {
              if (this.port === port1) port1.postMessage(answer)
            })
        })
        port1.start()
        contents.postMessage('stage-port', null, [port2])
      })
      failStart = null
      if (this.view !== view) throw new Error('the stage process stopped while it started')
      this.port = port1
      port1.postMessage(init)
      console.log(`stage: process ready in ${Date.now() - started} ms`)
    } catch (error) {
      if (this.view === view) this.stop()
      throw error
    }
  }
}
