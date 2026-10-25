import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC, type SnapshotReply, type SnapshotRequest } from '@shared/space-api'

/**
 * Pixel screenshots of any board region, content and ink together.
 *
 * A hidden offscreen window loads the renderer in snapshot mode
 * (`?snapshot=1`). For each request it draws the board nodes with the same
 * content layer and ink painter as the app, sized to the output image, waits
 * for fonts, math and images, and answers; then this class captures the page.
 * It works for regions far off screen and while the app window is in the
 * background. The window is made once and reused.
 */

const READY_TIMEOUT_MS = 8000
const LOAD_TIMEOUT_MS = 10000
/** How many captures to try (16 ms apart) before giving up on a fresh frame. */
const MARKER_TRIES = 60

/** The marker colour for a request id: the page uses the same formula (SnapshotView). */
export function markerColor(id: number): [number, number, number] {
  return [id % 256, Math.floor(id / 256) % 256, 255]
}

/** True when the pixel at (0, row) of the captured image has the marker colour. */
function markerMatches(image: Electron.NativeImage, row: number, want: [number, number, number]): boolean {
  const { width, height } = image.getSize()
  if (row >= height || width < 1) return false
  const bitmap = image.toBitmap() // BGRA
  const at = row * width * 4
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2
  return near(bitmap[at + 2], want[0]) && near(bitmap[at + 1], want[1]) && near(bitmap[at], want[2])
}
/** The window closes after this long without a capture. */
const IDLE_CLOSE_MS = 5 * 60_000

export interface SnapshotResult {
  png: Buffer
  width: number
  height: number
  missingImages: number
  ms: number
}

/**
 * capturePage, retried once on a fresh frame. The compositor can fail a
 * single capture (seen as UnknownVizError); the next frame works.
 */
async function grab(win: BrowserWindow): Promise<Electron.NativeImage> {
  try {
    const image = await win.webContents.capturePage()
    if (!image.isEmpty()) return image
    console.warn('snapshot: capturePage returned an empty image; retrying once')
  } catch (error) {
    console.warn(`snapshot: capturePage failed (${error instanceof Error ? error.message : String(error)}); retrying once`)
  }
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return win.webContents.capturePage()
}

export class SnapshotRenderer {
  private window: BrowserWindow | null = null
  private loading: Promise<BrowserWindow> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve(reply: SnapshotReply): void; timer: NodeJS.Timeout }>()
  private idleTimer: NodeJS.Timeout | null = null
  /** One capture at a time: the window has one size. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor() {
    ipcMain.on(IPC.snapshotReady, (event, reply: SnapshotReply) => {
      if (!this.window || event.sender !== this.window.webContents) return
      const entry = reply && this.pending.get(reply.requestId)
      if (!entry) return
      this.pending.delete(reply.requestId)
      clearTimeout(entry.timer)
      entry.resolve(reply)
    })
  }

  private open(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return Promise.resolve(this.window)
    if (this.loading) return this.loading
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      useContentSize: true,
      enableLargerThanScreen: true,
      frame: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('closed', () => {
      if (this.window === win) this.window = null
    })
    this.loading = new Promise<BrowserWindow>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The snapshot renderer did not load.')), LOAD_TIMEOUT_MS)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        this.window = win
        resolve(win)
      })
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer)
        reject(new Error(`The snapshot renderer failed to load (${code} ${description}).`))
      })
      const devUrl = process.env.ELECTRON_RENDERER_URL
      if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}?snapshot=1`)
      else void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { snapshot: '1' } })
    }).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** Draw and capture one region. Width and height are output pixels. */
  capture(request: Omit<SnapshotRequest, 'requestId'>): Promise<SnapshotResult> {
    const run = this.queue.then(() => this.captureNow(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async captureNow(request: Omit<SnapshotRequest, 'requestId'>): Promise<SnapshotResult> {
    const started = Date.now()
    const win = await this.open()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_CLOSE_MS)
    const requestId = this.nextId++
    // One extra row for the frame marker (see below), and one more on every other request: the window
    // changes size for every capture, so it always presents a new frame, never one from an earlier capture.
    win.setContentSize(request.width, request.height + 1 + (requestId % 2))
    // A storyboard frame with program items computes each program up to the frame's moment (sim): no time
    // limit here; each picture ends itself when its program stops moving on (renderer/live-pixels/LiveView.tsx).
    const computes = (request.playback?.clocks ?? []).some(([, clock]) => !!(clock as { sim?: unknown } | null)?.sim)
    const reply = await new Promise<SnapshotReply>((resolve) => {
      if (computes) {
        this.pending.set(requestId, { resolve, timer: setTimeout(() => undefined, 0) })
        win.webContents.send(IPC.snapshotRequest, { ...request, requestId } satisfies SnapshotRequest)
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ requestId, ok: false, error: `The snapshot did not finish within ${READY_TIMEOUT_MS / 1000} s.` })
      }, READY_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timer })
      win.webContents.send(IPC.snapshotRequest, { ...request, requestId } satisfies SnapshotRequest)
    })
    if (!reply.ok) throw new Error(reply.error)
    // An offscreen page presents its frames late, so a capture can show an
    // older frame. The page sets a marker pixel (one row below the image) to
    // a colour from the request id in the same task that paints the ink;
    // capture until the marker matches, then crop it off.
    const want = markerColor(requestId)
    let image = await grab(win)
    for (let tries = 0; tries < MARKER_TRIES && !markerMatches(image, request.height, want); tries++) {
      win.webContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 16))
      image = await grab(win)
    }
    if (!markerMatches(image, request.height, want)) {
      // Never an old frame: resize once more to force a new one, else fail.
      win.setContentSize(request.width, request.height + 3)
      for (let tries = 0; tries < MARKER_TRIES && !markerMatches(image, request.height, want); tries++) {
        win.webContents.invalidate()
        await new Promise((resolve) => setTimeout(resolve, 16))
        image = await grab(win)
      }
      if (!markerMatches(image, request.height, want)) throw new Error('The screenshot could not be drawn (the snapshot window showed an older frame). Take it again.')
    }
    image = image.crop({ x: 0, y: 0, width: Math.min(request.width, image.getSize().width), height: Math.min(request.height, image.getSize().height) })
    const size = image.getSize()
    if (size.width !== request.width || size.height !== request.height) {
      image = image.resize({ width: request.width, height: request.height, quality: 'best' })
    }
    return { png: image.toPNG(), width: request.width, height: request.height, missingImages: reply.missingImages, ms: Date.now() - started }
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}
