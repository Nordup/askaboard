import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC, type BoardSaveInfo, type Camera, type MenuCommand, type Snapshot } from '@shared/space-api'
import type { WorldTune } from '@shared/world-tune'
import { FolderSession } from './folder'
import { AgentServer } from './mcp'
import { SnapshotRenderer } from './snapshot'
import { LIVE_SCHEME_PRIVILEGES, registerLiveItemProtocol } from './live-item-protocol'
import { STAGE_SCHEME_PRIVILEGES } from './stage-process'
import { installMenu, setFolderOpen } from './menu'
import { FOLDER_SETTINGS_DIR, folderOverrides, onOverridesRead } from './guide'
import { SETUP_MARKER, applySetup, isSetUp, setupPlan } from './setup'
import { refreshBriefBlock } from './brief-block'
import { installShim, writeRelayState } from './agent-home'
import { agentClients, connectAgentClient, isAgentClientAction, isAgentClientId } from './connect'
import * as store from './state'

/** The colour of the window before the renderer paints. Keep it equal to --bg-app. */
const BACKGROUND = '#111113'

/** Dev hook: write a PNG of the window to this path after load. */
const capturePath = process.env.SPACE_CAPTURE
/** Dev hook: quit after the capture. */
const captureQuit = process.env.SPACE_CAPTURE_QUIT === '1'
/** Dev hook: milliseconds between page load and capture (default 1000). */
const captureDelay = Number(process.env.SPACE_CAPTURE_DELAY ?? 1000) || 1000
/** Dev hook: open this learning folder at launch (overrides the last folder). */
const launchFolder = process.env.SPACE_FOLDER
/** Dev hook: a file (relative to the folder) to show in the preview at launch. */
const launchOpen = process.env.SPACE_OPEN ?? null
/** Lab hook: show the window without activating the app, so a lab instance never takes focus or switches the desktop. */
const noFocus = process.env.SPACE_NO_FOCUS === '1'

/**
 * Dev hook: Chromium remote debugging on 127.0.0.1:<port>, plus the page hook
 * window.__spaceDev, for scripts/drive.mjs. Ignored in packaged builds.
 */
const remoteDebugPort = (() => {
  const raw = process.env.SPACE_REMOTE_DEBUG
  if (!raw || app.isPackaged) return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`SPACE_REMOTE_DEBUG="${raw}" is not a valid port; remote debugging is off`)
    return null
  }
  return port
})()
if (remoteDebugPort !== null) {
  app.commandLine.appendSwitch('remote-debugging-port', String(remoteDebugPort))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  // Check scripts drive the window while the learner works in front of it. A
  // covered window must keep rendering, or CDP input waits forever for a frame.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  console.log(`remote debugging on 127.0.0.1:${remoteDebugPort} (dev hook)`)
}

/** Measuring switches of the world surface, for the render benchmark (scripts/perf/README.md). Never in a packaged app. */
const worldTune: WorldTune | null = (() => {
  const raw = process.env.SPACE_WORLD_TUNE
  if (!raw || app.isPackaged) return null
  try {
    return JSON.parse(raw) as WorldTune
  } catch {
    console.error(`SPACE_WORLD_TUNE is not JSON: ${raw}`)
    return null
  }
})()

/**
 * Image nodes load learning-folder files as space-asset://folder/<relative path>.
 * The handler resolves the path through the folder's path guard, so a URL can
 * never read outside the open folder.
 */
const ASSET_SCHEME = 'space-asset'
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }, LIVE_SCHEME_PRIVILEGES, STAGE_SCHEME_PRIVILEGES])

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      if (!session) return new Response('No learning folder is open.', { status: 404 })
      const url = new URL(request.url)
      const rel = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
      const { data, type } = await session.readAsset(rel)
      return new Response(new Uint8Array(data), { headers: { 'content-type': type, 'cache-control': 'no-cache' } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Not found', { status: 404 })
    }
  })
}

let mainWindow: BrowserWindow | null = null
let session: FolderSession | null = null
let quitting = false

const snapshots = new SnapshotRenderer()

const agentServer = new AgentServer({
  snapshots,
  webContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  status: (status) => send(IPC.agentStatus, status),
  activity: (activity) => send(IPC.agentActivity, activity),
  folderRoot: () => session?.root ?? null,
  shownBoard: () => (session ? store.getLastBoard(session.root) : null),
  folder: () => session,
  // This instance owns the port: point the relay at it and refresh its offline tool list.
  listening: () => {
    void agentServer
      .catalog()
      .then((catalog) => writeRelayState(agentServer.port, catalog))
      .catch((error) => console.error(`agent home: could not write relay.json/tools.json: ${String(error)}`))
  }
})

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// The watcher skips hidden folders, so .learning-space changes reach the UI
// when an agent reads the guide or connects (and when the folder opens).
onOverridesRead((root) => {
  if (root && session?.root === root) send(IPC.guideOverrides, folderOverrides(root))
})

function requireSession(): FolderSession {
  if (!session) throw new Error('No learning folder is open.')
  return session
}

/** The app state for the renderer. Only the initial state carries SPACE_OPEN. */
async function snapshot(initial = false): Promise<Snapshot> {
  const folder = session
    ? await (async () => {
        const tree = await session.listFiles()
        const last = store.getLastBoard(session.root)
        const lastExists = last ? await session.resolvePath(last).then(() => true, () => false) : false
        return {
          root: session.root,
          name: session.name,
          tree,
          lastBoard: lastExists ? last : null,
          setUp: await isSetUp(session),
          setupDontAsk: store.getSetupDontAsk(session.root)
        }
      })()
    : null
  return { folder, recent: store.recentFolders(), devOpen: initial && folder ? launchOpen : null }
}

async function openFolder(path: string): Promise<void> {
  const next = await FolderSession.open(path)
  session?.stopWatching()
  session = next
  store.rememberFolder(next.root)
  setFolderOpen(true)
  next.startWatching({
    filesChanged: (tree) => send(IPC.filesChanged, tree),
    boardChanged: (change) => send(IPC.boardChanged, change)
  })
  // Keep the brief block in AGENTS.md current (an edited block stays as it is).
  await next
    .resolvePath(SETUP_MARKER, { allowMissing: true })
    .then(refreshBriefBlock)
    .catch((error) => console.error(`brief block: ${String(error)}`))
}

async function showOpenDialog(): Promise<Snapshot | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Learning Folder',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  await openFolder(result.filePaths[0])
  return snapshot()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Open SPACE_FOLDER, or else the last folder, if it still exists. */
async function openInitialFolder(): Promise<void> {
  const candidates = [launchFolder ? resolve(launchFolder) : null, store.lastFolder()]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (!isDirectory(candidate)) {
      console.error(`folder not found: ${candidate}`)
      continue
    }
    try {
      await openFolder(candidate)
      console.log(`opened folder ${session?.root}`)
      return
    } catch (error) {
      console.error(`could not open ${candidate}: ${String(error)}`)
    }
  }
}

/** Every invoke handler runs through this, so errors reach the renderer as plain messages. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await fn(...(args as A))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${channel} failed: ${message}`)
      throw new Error(message)
    }
  })
}

function isCamera(value: unknown): value is Camera {
  const camera = value as Camera
  return (
    !!camera &&
    Array.isArray(camera.center) &&
    camera.center.length === 2 &&
    camera.center.every((n) => Number.isFinite(n)) &&
    Number.isFinite(camera.zoom) &&
    camera.zoom > 0
  )
}

function registerIpc(): void {
  ipcMain.on(IPC.appVersion, (event) => {
    event.returnValue = app.getVersion()
  })
  ipcMain.on(IPC.devHooks, (event) => {
    event.returnValue = remoteDebugPort !== null
  })
  ipcMain.on(IPC.worldTune, (event) => {
    event.returnValue = worldTune
  })

  handle(IPC.getInitialState, () => snapshot(true))
  handle(IPC.getAgentStatus, () => agentServer.status())
  handle(IPC.getAgentClients, () => agentClients())
  handle(IPC.connectAgentClient, (id: unknown, action: unknown) => {
    if (!isAgentClientId(id)) throw new Error('Unknown agent app.')
    if (!isAgentClientAction(action)) throw new Error('Unknown connect action.')
    return connectAgentClient(id, action)
  })
  handle(IPC.openFolderDialog, () => showOpenDialog())
  handle(IPC.openRecent, async (path: unknown) => {
    if (typeof path !== 'string' || !store.isRecent(path)) throw new Error('That folder is not in the recent list.')
    await openFolder(path)
    return snapshot()
  })
  handle(IPC.listFiles, () => requireSession().listFiles())
  handle(IPC.importAsset, (src: unknown) => {
    if (typeof src !== 'string' || !src.trim()) throw new Error('An image src is required.')
    return requireSession().importAsset(src)
  })

  handle(IPC.readBoard, (path: string) => requireSession().readBoard(path))
  handle(IPC.writeBoard, async (path: string, text: string, info?: BoardSaveInfo) => {
    const start = performance.now()
    await requireSession().writeBoard(path, text)
    const writeMs = performance.now() - start
    const serializeMs = typeof info?.serializeMs === 'number' ? info.serializeMs.toFixed(1) : '?'
    console.log(`save: ${path} serialise ${serializeMs} ms, ${Math.round(Buffer.byteLength(text) / 1024)} kB, write ${writeMs.toFixed(1)} ms`)
    agentServer.boardSaved(path, info?.learnerEdit ?? null)
  })
  // The file side of the one board-change operation (renderer App.tsx changeBoard): the
  // agent server's drafts, change cursors, stage and board cache move or end with the file.
  handle(IPC.createBoard, (name?: unknown, folder?: unknown) => requireSession().createBoard(name, folder))
  handle(IPC.renameBoard, async (path: string, newName: string) => {
    const current = requireSession()
    const target = await current.renameBoard(path, newName)
    store.renameBoardState(current.root, path, target)
    if (target !== path) agentServer.boardMoved(path, target)
    return target
  })
  handle(IPC.deleteBoard, async (path: string) => {
    const current = requireSession()
    await current.deleteBoard(path)
    store.forgetBoardState(current.root, path)
    agentServer.boardMoved(path, null)
  })

  handle(IPC.readFile, (path: string) => requireSession().readPreview(path))
  handle(IPC.revealInFinder, (path: string) => requireSession().reveal(path))

  handle(IPC.setupPlan, () => setupPlan(requireSession()))
  handle(IPC.applySetup, async () => {
    const result = await applySetup(requireSession())
    console.log(`setup: created ${result.created.join(', ') || 'nothing'}`)
    return result
  })
  handle(IPC.setSetupDontAsk, (value: unknown) => store.setSetupDontAsk(requireSession().root, value === true))
  handle(IPC.getShowPerformance, () => store.getShowPerformance())
  handle(IPC.getUncappedFrames, () => ({ on: store.getUncappedFrames(), launched: uncappedAtLaunch }))
  handle(IPC.setUncappedFrames, (on: unknown) => store.setUncappedFrames(on === true))
  handle(IPC.boardGuidePath, async () => {
    const rel = `${FOLDER_SETTINGS_DIR}/guide.md`
    const full = await requireSession().resolvePath(rel, { allowMissing: true })
    return statSync(full, { throwIfNoEntry: false })?.isFile() ? rel : null
  })

  handle(IPC.getGuideOverrides, () => folderOverrides(session?.root ?? null))

  handle(IPC.getCamera, async (path: string) => {
    const current = requireSession()
    await current.resolvePath(path, { allowMissing: true })
    return store.getCamera(current.root, path)
  })
  ipcMain.on(IPC.setCamera, (_event, path: unknown, camera: unknown) => {
    if (!session || typeof path !== 'string' || !isCamera(camera)) return
    store.setCamera(session.root, path, { center: [camera.center[0], camera.center[1]], zoom: camera.zoom })
  })
  handle(IPC.openSceneRecords, async (path: unknown, id: unknown) => {
    const current = requireSession()
    if (typeof path !== 'string') throw new Error('A board path is required.')
    await current.resolvePath(path)
    const stories = await agentServer.records.openBoard(path, typeof id === 'string' && id ? id : null)
    // The board's stage is rebuilt from its records now, so the first scene call after a restart does not wait for it.
    agentServer.boardMounted(path)
    return stories
  })
  // The board window replays scenes restored from the records: their programs run again first (main/mcp.ts ensureMemories).
  handle(IPC.rebuildScenes, async (sceneIds: unknown) => {
    if (!Array.isArray(sceneIds) || !sceneIds.every((id) => typeof id === 'string')) throw new Error('Scene ids are required.')
    await agentServer.rebuildScenes(sceneIds as string[])
  })
  ipcMain.on(IPC.setLastBoard, (_event, path: unknown) => {
    if (!session) return
    store.setLastBoard(session.root, typeof path === 'string' ? path : null)
  })
  // The board window's renderer asks for its port to the stage (frames of scenes); only the main window gets one.
  ipcMain.on(IPC.framesPort, (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) agentServer.linkBoard(event.sender)
  })
}

function sendMenuCommand(command: MenuCommand): void {
  send(IPC.menuCommand, command)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Learning Space',
    backgroundColor: BACKGROUND,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Dev hook: see remoteDebugPort.
      backgroundThrottling: remoteDebugPort === null
    }
  })

  win.once('ready-to-show', () => (noFocus ? win.showInactive() : win.show()))

  // Links that open a new window go to the system browser, never to a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The page itself never navigates away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // Before the window closes, the renderer saves its open board.
  let flushed = false
  win.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    const finish = (): void => {
      if (flushed) return
      flushed = true
      clearTimeout(timer)
      ipcMain.removeListener(IPC.flushDone, finish)
      win.destroy()
    }
    const timer = setTimeout(finish, 2000)
    ipcMain.on(IPC.flushDone, finish)
    win.webContents.send(IPC.flushRequest)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The hidden snapshot window must not keep the app alive without its main window.
    snapshots.dispose()
  })

  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void capture(win, capturePath), captureDelay)
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

async function capture(win: BrowserWindow, path: string): Promise<void> {
  try {
    const image = await win.webContents.capturePage()
    await writeFile(path, image.toPNG())
    console.log(`captured ${path}`)
  } catch (error) {
    console.error(`capture failed: ${String(error)}`)
    process.exitCode = 1
  }
  if (captureQuit) app.quit()
}

store.loadState()

/** The switches need a restart, so they follow what was saved at launch: for a user with the pill off, the frame limit stays. */
const uncappedAtLaunch = (store.getShowPerformance() && store.getUncappedFrames()) || !!worldTune?.uncapped
if (uncappedAtLaunch) {
  app.commandLine.appendSwitch('disable-frame-rate-limit')
  app.commandLine.appendSwitch('disable-gpu-vsync')
}
registerIpc()

void app.whenReady().then(async () => {
  installMenu({
    openFolder: () => {
      void showOpenDialog()
        .then((result) => result && send(IPC.folderOpened, result))
        .catch((error) => console.error(`open folder failed: ${String(error)}`))
    },
    newBoard: () => sendMenuCommand('new-board'),
    setupFolder: () => sendMenuCommand('setup-folder'),
    zoom: (step) => sendMenuCommand(step === 'in' ? 'zoom-in' : step === 'out' ? 'zoom-out' : 'zoom-reset'),
    selectAll: () => sendMenuCommand('select-all'),
    showPerformance: store.getShowPerformance(),
    setShowPerformance: (on) => {
      store.setShowPerformance(on)
      sendMenuCommand(on ? 'show-performance' : 'hide-performance')
    }
  })
  registerAssetProtocol()
  registerLiveItemProtocol()
  await openInitialFolder()
  setFolderOpen(session !== null)
  await installShim().catch((error) => console.error(`agent home: could not write the shim: ${String(error)}`))
  agentServer.start()
  mainWindow = createWindow()
  // The snapshot window loads once the board is up, so an agent's first screenshot is as fast as the later ones.
  mainWindow.webContents.once('did-finish-load', () => setTimeout(() => snapshots.warm(), 2000))
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (quitting || process.platform !== 'darwin' || captureQuit) app.quit()
})

app.on('will-quit', () => {
  session?.stopWatching()
  store.saveStateNow()
  void agentServer.stop()
  snapshots.dispose()
})
