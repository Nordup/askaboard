import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type BoardSaveInfo, type Camera, type FailedSave, type MenuCommand, type Snapshot } from '@shared/space-api'
import type { WorldTune } from '@shared/world-tune'
import { FolderSession } from './folder'
import { AgentServer } from './mcp'
import { SnapshotRenderer } from './snapshot'
import { LIVE_SCHEME_PRIVILEGES, grantWorldFiles, registerLiveItemProtocol, revokeWorldFiles, worldBytesRead } from './live-item-protocol'
import { STAGE_SCHEME_PRIVILEGES } from './stage-process'
import { devClickMenu, devSidebarMenu, installMenu, setFolderOpen, setReadLinesChecked, setSidebarMenu } from './menu'
import { automaticSize, interfaceFactor, stepSize, type InterfaceSize } from './interface-size'
import { FOLDER_SETTINGS_DIR, folderOverrides, onOverridesRead } from './guide'
import { SETUP_MARKER, applySetup, isSetUp, setupPlan } from './setup'
import { refreshBriefBlock } from './brief-block'
import { cleanFolder, cleanTraces, limitDiskCache, removedBoardData, trimCodeCache } from './storage'
import { boardIdOf } from './scene-store'
import { installShim, writeRelayState } from './agent-home'
import { dropRecovery, keepRecovery, moveRecovery, readRecovery } from './recovery'
import { agentClients, connectAgentClient, isAgentClientAction, isAgentClientId } from './connect'
import * as store from './state'
import * as analytics from './analytics'
import { hasVoiceKey } from './voice'
import { resourcePath } from './resources'

/** The colour of the window before the renderer paints. Keep it equal to --bg-app. */
const BACKGROUND = '#111113'
/** A renderer that does not answer a close in this time is not responding: the window closes. */
const FLUSH_ANSWER_MS = 2000
/** The time a renderer that answered has for its saves. */
const FLUSH_SAVE_MS = 30000

/** Dev hook: write a PNG of the window to this path after load. */
const capturePath = process.env.SPACE_CAPTURE
/** Dev hook: quit after the capture. */
const captureQuit = process.env.SPACE_CAPTURE_QUIT === '1'
/** Dev hook: milliseconds between page load and capture (default 1000; 0 is valid). */
const captureDelay = (() => {
  const delay = Number(process.env.SPACE_CAPTURE_DELAY ?? 1000)
  return Number.isFinite(delay) ? delay : 1000
})()
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
  // These switches change only Chromium's own throttling: on Wayland the
  // compositor sends a covered window no frame callbacks, and frames stop. The
  // scene clock's events (end, queue, pause, voice) run on a timer
  // (live/player.ts schedule()), so a scene still ends there.
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
 * Image nodes load learning-folder files as space-asset://folder/<relative path>, and
 * the voice of said lines loads its clips the same way (stream and the byte ranges let an
 * <audio> element seek). The handler resolves the path through the folder's path guard,
 * so a URL can never read outside the open folder.
 */
const ASSET_SCHEME = 'space-asset'
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }, LIVE_SCHEME_PRIVILEGES, STAGE_SCHEME_PRIVILEGES])

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      if (!session) return new Response('No learning folder is open.', { status: 404 })
      const url = new URL(request.url)
      const rel = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
      const { data, type } = await session.readAsset(rel)
      const headers = { 'content-type': type, 'cache-control': 'no-cache', 'accept-ranges': 'bytes' }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
      if (range && start <= end) return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) } })
      return new Response(new Uint8Array(data), { headers: { ...headers, 'content-length': String(data.length) } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Not found', { status: 404 })
    }
  })
}

let mainWindow: BrowserWindow | null = null
let session: FolderSession | null = null
/**
 * Every folder opened in this run, by root. A board read or write names its folder and
 * goes to it here, so a write made while another folder opens cannot land in that folder.
 */
const sessions = new Map<string, FolderSession>()
/** The folder the learner picked in the dialog last: besides the recent list, the one folder the renderer may open. */
let pickedFolder: string | null = null
let quitting = false
/** Dev hook: answers the open close dialog. */
let answerCloseDialog: ((button: number) => void) | null = null

const snapshots = new SnapshotRenderer()

const agentServer = new AgentServer({
  snapshots,
  webContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  status: (status) => send(IPC.agentStatus, status),
  activity: (activity) => send(IPC.agentActivity, activity),
  folderRoot: () => session?.root ?? null,
  readLines: readLinesNow,
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

/** View > Hide Sidebar: main owns it. A change is saved at once and reaches the menu and the renderer here. */
function setSidebarHidden(hidden: boolean): void {
  if (hidden !== store.getSidebarHidden()) store.setSidebarHidden(hidden)
  setSidebarMenu(hidden)
  send(IPC.sidebarHidden, hidden)
}

/** What the menu and the renderer show of Read Lines Aloud. */
let readLinesShown: boolean | null = null

/** Read Lines Aloud as it stands, the one way to read it: with no saved choice it follows the key, which can come or go while the app runs. A change reaches the menu and the renderer here. */
function readLinesNow(): boolean {
  const on = store.readLinesOn()
  if (on !== readLinesShown) {
    readLinesShown = on
    setReadLinesChecked(on)
    send(IPC.readLines, on)
  }
  return on
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

function sessionOf(root: unknown): FolderSession {
  const found = typeof root === 'string' ? sessions.get(root) : undefined
  if (!found) throw new Error('That learning folder was not opened.')
  return found
}

/** The app state for the renderer. Only the initial state carries SPACE_OPEN. */
async function snapshot(initial = false): Promise<Snapshot> {
  const folder = session
    ? await (async () => {
        const tree = await session.listFiles()
        const boards = await session.boardList()
        const last = store.getLastBoard(session.root)
        const lastExists = last ? await session.resolvePath(last).then(() => true, () => false) : false
        return {
          root: session.root,
          name: session.name,
          tree,
          boards,
          lastBoard: lastExists ? last : null,
          setUp: await isSetUp(session),
          setupDontAsk: store.getSetupDontAsk(session.root)
        }
      })()
    : null
  return { folder, recent: store.recentFolders(), devOpen: initial && folder ? launchOpen : null }
}

/**
 * Make a folder the open one. With a window, the renderer calls this inside its folder
 * switch (App.tsx switchFolder), after it saved the folder it leaves: every route
 * (the menu, the dialog, the recent list) goes that way.
 */
/** How the open folder was opened, for folder.opened (main/analytics.ts). */
type FolderVia = 'launch' | 'dialog' | 'recent' | 'menu'
let folderVia: FolderVia = 'launch'

async function openFolder(path: string, via: FolderVia): Promise<void> {
  const opened = await FolderSession.open(path)
  const next = sessions.get(opened.root) ?? opened
  sessions.set(next.root, next)
  session?.stopWatching()
  session = next
  folderVia = via
  analytics.record('folder.opened', { via, setUp: false })
  store.rememberFolder(next.root)
  setFolderOpen(true)
  void cleanFolder(next, agentServer.records).catch((error) => console.error(`storage: ${String(error)}`))
  // A scan under way when the folder changes reports nothing: its folder is not the open one.
  next.startWatching({
    filesChanged: (tree) => {
      if (session === next) send(IPC.filesChanged, tree)
    },
    boardChanged: (change) => {
      if (session === next) send(IPC.boardChanged, change)
    },
    boardsChanged: (list) => {
      if (session === next) send(IPC.boardsChanged, list)
    }
  })
  // Keep the brief block in AGENTS.md current (an edited block stays as it is).
  await next
    .resolvePath(SETUP_MARKER, { allowMissing: true })
    .then(refreshBriefBlock)
    .catch((error) => console.error(`brief block: ${String(error)}`))
}

async function pickFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Learning Folder',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  pickedFolder = result.canceled ? null : (result.filePaths[0] ?? null)
  return pickedFolder
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The window opens while the first folder opens. Its first state waits for this. */
let firstFolder: Promise<void> = Promise.resolve()

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
      await openFolder(candidate, 'launch')
      console.log(`opened folder ${session?.root}`)
      return
    } catch (error) {
      console.error(`could not open ${candidate}: ${String(error)}`)
    }
  }
}

/** The message comes from the board page itself, not from a frame in it or another window. */
function fromBoardPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame
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
  ipcMain.on(IPC.devClose, () => {
    if (remoteDebugPort !== null) mainWindow?.close()
  })
  ipcMain.on(IPC.devFullScreen, (_event, on: unknown) => {
    if (remoteDebugPort !== null && typeof on === 'boolean') mainWindow?.setFullScreen(on)
  })
  ipcMain.on(IPC.devSidebarMenu, (event, click: unknown) => {
    event.returnValue = remoteDebugPort !== null ? devSidebarMenu(click === true) : null
  })
  ipcMain.on(IPC.devClickMenu, (event, id: unknown) => {
    event.returnValue = remoteDebugPort !== null && typeof id === 'string' ? devClickMenu(id) : false
  })
  ipcMain.on(IPC.getShellState, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    event.returnValue = { sidebarHidden: store.getSidebarHidden(), fullScreen: win?.isFullScreen() ?? false, homeDir: homedir() }
  })
  ipcMain.on(IPC.setSidebarHidden, (event, hidden: unknown) => {
    if (event.sender === mainWindow?.webContents && typeof hidden === 'boolean') setSidebarHidden(hidden)
  })
  ipcMain.on(IPC.devCloseAnswer, (_event, button: unknown) => {
    if (remoteDebugPort !== null && typeof button === 'number') answerCloseDialog?.(button)
  })
  ipcMain.on(IPC.worldLog, (event, level: unknown, text: unknown) => {
    if (fromBoardPage(event) && typeof level === 'string' && typeof text === 'string') agentServer.worldLog(level, text)
  })
  ipcMain.on(IPC.worldFilesGrant, (event, token: unknown) => {
    if (fromBoardPage(event)) grantWorldFiles(token, session)
    event.returnValue = true
  })
  ipcMain.on(IPC.worldFilesRevoke, (event, token: unknown) => {
    if (fromBoardPage(event)) revokeWorldFiles(token)
  })
  ipcMain.handle(IPC.worldBytesRead, (event, token: unknown, ms: unknown) => (fromBoardPage(event) ? worldBytesRead(token, ms) : 0))
  ipcMain.on(IPC.worldTune, (event) => {
    event.returnValue = worldTune
  })
  ipcMain.on(IPC.frameLimitOff, (event) => {
    event.returnValue = uncappedAtLaunch ? screen.getPrimaryDisplay().displayFrequency || 60 : null
  })

  handle(IPC.getInitialState, async () => {
    await firstFolder
    return snapshot(true)
  })
  handle(IPC.getAgentStatus, () => agentServer.status())
  handle(IPC.getAgentClients, () => agentClients())
  handle(IPC.connectAgentClient, (id: unknown, action: unknown) => {
    if (!isAgentClientId(id)) throw new Error('Unknown agent app.')
    if (!isAgentClientAction(action)) throw new Error('Unknown connect action.')
    return connectAgentClient(id, action)
  })
  handle(IPC.pickFolder, () => pickFolder())
  handle(IPC.openFolder, async (path: unknown) => {
    if (typeof path !== 'string' || (path !== pickedFolder && !store.isRecent(path))) throw new Error('That folder is not in the recent list.')
    await openFolder(path, path === pickedFolder ? 'dialog' : 'recent')
    return snapshot()
  })
  handle(IPC.listFiles, () => requireSession().listFiles())
  handle(IPC.getBoards, () => requireSession().boardList())
  handle(IPC.importAsset, (src: unknown) => {
    if (typeof src !== 'string' || !src.trim()) throw new Error('An image src is required.')
    return requireSession().importAsset(src)
  })

  handle(IPC.readBoard, (root: unknown, path: string) => sessionOf(root).readBoard(path))
  handle(IPC.readRecovery, (root: unknown, path: string) => readRecovery(sessionOf(root).root, path))
  handle(IPC.writeBoard, async (root: unknown, path: string, text: string, info?: BoardSaveInfo) => {
    const start = performance.now()
    const folder = sessionOf(root)
    await folder.writeBoard(path, text)
    await dropRecovery(folder.root, path)
    const writeMs = performance.now() - start
    const serializeMs = typeof info?.serializeMs === 'number' ? info.serializeMs.toFixed(1) : '?'
    console.log(`save: ${path} serialise ${serializeMs} ms, ${Math.round(Buffer.byteLength(text) / 1024)} kB, write ${writeMs.toFixed(1)} ms`)
    // The agent server works on the open folder: a late save of the folder before is not its news.
    if (folder === session) agentServer.boardSaved(path, info?.learnerEdit ?? null)
  })
  // The file side of the one board-change operation (renderer App.tsx changeBoard): the
  // agent server's drafts, change cursors, stage and board cache move or end with the file.
  handle(IPC.createBoard, async (name?: unknown, folder?: unknown) => {
    const current = requireSession()
    const path = await current.createBoard(name, folder)
    analytics.boardCreated(current.root, path)
    return path
  })
  handle(IPC.renameBoard, async (path: string, newName: string) => {
    const current = requireSession()
    const target = await current.renameBoard(path, newName)
    store.renameBoardState(current.root, path, target)
    if (target !== path) {
      agentServer.boardMoved(path, target)
      await moveRecovery(current.root, path, target)
    }
    return target
  })
  handle(IPC.deleteBoard, async (path: string) => {
    const current = requireSession()
    // The id is in the file, so it is read before the file goes.
    const id = await current.resolvePath(path).then(boardIdOf)
    await current.deleteBoard(path)
    store.forgetBoardState(current.root, path)
    agentServer.boardMoved(path, null)
    await dropRecovery(current.root, path)
    if (id) void removedBoardData(current, agentServer.records, id).catch((error) => console.error(`storage: the data of ${path} stays: ${String(error)}`))
  })

  handle(IPC.readFile, (path: string) => requireSession().readPreview(path))
  handle(IPC.revealInFinder, (path: string) => requireSession().reveal(path))

  handle(IPC.setupPlan, () => setupPlan(requireSession()))
  handle(IPC.applySetup, async () => {
    const result = await applySetup(requireSession())
    analytics.record('folder.opened', { via: folderVia, setUp: true })
    console.log(`setup: created ${result.created.join(', ') || 'nothing'}`)
    return result
  })
  handle(IPC.setSetupDontAsk, (value: unknown) => store.setSetupDontAsk(requireSession().root, value === true))
  handle(IPC.getShowPerformance, () => store.getShowPerformance())
  handle(IPC.getReadLines, readLinesNow)
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
  ipcMain.on(IPC.setCamera, (_event, root: unknown, path: unknown, camera: unknown) => {
    if (typeof root !== 'string' || !sessions.has(root) || typeof path !== 'string' || !isCamera(camera)) return
    store.setCamera(root, path, { center: [camera.center[0], camera.center[1]], zoom: camera.zoom })
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
  ipcMain.on(IPC.setLastBoard, (_event, root: unknown, path: unknown) => {
    if (typeof root !== 'string' || !sessions.has(root)) return
    store.setLastBoard(root, typeof path === 'string' ? path : null)
    if (typeof path === 'string') analytics.boardShown(root, path)
  })
  // The board window's renderer asks for its port to the stage (frames of scenes); only the main window gets one.
  ipcMain.on(IPC.framesPort, (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) agentServer.linkBoard(event.sender)
  })
}

function sendMenuCommand(command: MenuCommand): void {
  send(IPC.menuCommand, command)
}

/** Ask the renderer to save: the boards it could not save, or null when it does not answer. */
function askToSave(win: BrowserWindow): Promise<FailedSave[] | null> {
  return new Promise((resolve) => {
    const finish = (failed: FailedSave[] | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IPC.flushStarted, started)
      ipcMain.removeListener(IPC.flushDone, done)
      resolve(failed)
    }
    let timer = setTimeout(() => finish(null), FLUSH_ANSWER_MS)
    const started = (event: IpcMainEvent): void => {
      if (event.sender !== win.webContents) return
      clearTimeout(timer)
      timer = setTimeout(() => finish(null), FLUSH_SAVE_MS)
    }
    const done = (event: IpcMainEvent, failed: unknown): void => {
      if (event.sender === win.webContents) finish(Array.isArray(failed) ? (failed as FailedSave[]) : [])
    }
    ipcMain.on(IPC.flushStarted, started)
    ipcMain.on(IPC.flushDone, done)
    try {
      win.webContents.send(IPC.flushRequest)
    } catch {
      finish(null)
    }
  })
}

/**
 * The close of the window. The renderer saves, and main hears each board that failed:
 * its text goes to a recovery file, and the learner chooses to try again or to close.
 * A renderer that does not answer cannot hold the window.
 */
async function saveAndClose(win: BrowserWindow): Promise<void> {
  for (;;) {
    const failed = await askToSave(win)
    if (!failed?.length) break
    const kept = await Promise.all(failed.map((board) => keepRecovery(board.root, board.path, board.text))).then(
      () => true,
      (error: unknown) => {
        console.error(`recovery: could not keep ${failed.map((board) => board.path).join(', ')}: ${String(error)}`)
        return false
      }
    )
    console.log(`close: could not save ${failed.map((board) => board.path).join(', ')}`)
    // Dev hook: a check answers the sheet (drive.mjs close-answer); the sheet closes as a cancel does.
    const abort = new AbortController()
    let answered: number | null = null
    answerCloseDialog = (button) => {
      answered = button
      abort.abort()
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: "Couldn't save your board",
      ...(kept ? { detail: 'A copy is kept, and it comes back when you open this board again.' } : {}),
      buttons: ['Try again', 'Close anyway'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      signal: abort.signal
    })
    answerCloseDialog = null
    if ((answered ?? response) !== 0) break
  }
  if (!win.isDestroyed()) win.destroy()
}

/** After the window's first load: the snapshot window, then the stage. */
const SNAPSHOT_WARM_MS = 2000
const STAGE_WARM_MS = 3000

/** The smallest page the layout is made for, in CSS pixels; the window's minimum grows with Interface Size (within the screen). */
const MIN_PAGE = [960, 600] as const

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_PAGE[0],
    minHeight: MIN_PAGE[1],
    show: false,
    title: 'Learning Space',
    backgroundColor: BACKGROUND,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 15 }, // 14 px buttons centred on the 44 px title row (tokens.css --window-buttons-end)
    // Linux and Windows draw the application menu as a bar inside the window, above the app's own top bar.
    // Hidden, it shows on Alt, and its accelerators keep working.
    autoHideMenuBar: process.platform !== 'darwin',
    ...(process.platform === 'linux' ? { icon: resourcePath('icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The voice of a scene starts with the scene, not with a click.
      autoplayPolicy: 'no-user-gesture-required',
      // Dev hook: see remoteDebugPort.
      backgroundThrottling: remoteDebugPort === null
    }
  })

  win.once('ready-to-show', () => (noFocus ? win.showInactive() : win.show()))
  // The sidebar button moves left when the window buttons go (full screen on macOS).
  const sendFullScreen = (on: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.fullScreen, on)
  }
  win.on('enter-full-screen', () => sendFullScreen(true))
  win.on('leave-full-screen', () => sendFullScreen(false))

  // View > Interface Size: this window's own page zoom, not the origin's (the snapshot window shares the origin).
  win.webContents.setZoomMode('isolated')
  win.webContents.on('did-navigate', () => applyInterfaceSize(win))
  win.on('move', () => applyInterfaceSize(win)) // 'moved' fires on macOS and Windows only
  applyInterfaceSize(win)

  // Links that open a new window go to the system browser, never to a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The page itself never navigates away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // Before the window closes, the renderer saves. destroy() does not come back here.
  let closing = false
  win.on('close', (event) => {
    event.preventDefault()
    if (closing) return
    closing = true
    void saveAndClose(win)
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

/**
 * The switches need a restart, so they follow what was saved at launch: for a user with the pill off, the frame limit stays.
 * They last for the process, so when the pill closes, renderer/src/frame-pace.ts keeps the display's rate.
 */
const uncappedAtLaunch = (store.getShowPerformance() && store.getUncappedFrames()) || !!worldTune?.uncapped
if (uncappedAtLaunch) {
  app.commandLine.appendSwitch('disable-frame-rate-limit')
  app.commandLine.appendSwitch('disable-gpu-vsync')
}
limitDiskCache()
registerIpc()

/** The automatic interface size that the menu shows (the screen module works only once the app is ready). */
let menuAutomaticSize = 1

/** The app menu with the settings as they stand. It is built again when Interface Size changes, so its radio items and the automatic percent stay true. */
function buildMenu(): void {
  installMenu({
    openFolder: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendMenuCommand('open-folder')
        return
      }
      // No window (macOS keeps the app): nothing is open that must be saved.
      void pickFolder()
        .then((path) => (path ? openFolder(path, 'menu') : undefined))
        .catch((error) => console.error(`open folder failed: ${String(error)}`))
    },
    newBoard: () => sendMenuCommand('new-board'),
    searchBoards: () => sendMenuCommand('search-boards'),
    setupFolder: () => sendMenuCommand('setup-folder'),
    zoom: (step) => sendMenuCommand(step === 'in' ? 'zoom-in' : step === 'out' ? 'zoom-out' : 'zoom-reset'),
    selectAll: () => sendMenuCommand('select-all'),
    sidebarHidden: store.getSidebarHidden(),
    toggleSidebar: () => setSidebarHidden(!store.getSidebarHidden()),
    showPerformance: store.getShowPerformance(),
    setShowPerformance: (on) => {
      store.setShowPerformance(on)
      sendMenuCommand(on ? 'show-performance' : 'hide-performance')
    },
    readLines: readLinesNow(),
    setReadLines: (on) => {
      store.setReadLines(on)
      readLinesNow()
    },
    voice: store.getVoice(),
    setVoice: store.setVoice,
    pace: store.getPace(),
    setPace: store.setPace,
    interfaceSize: store.getInterfaceSize(),
    automaticSize: menuAutomaticSize,
    setInterfaceSize,
    stepInterfaceSize: (direction) => setInterfaceSize(stepSize(interfaceFactor(store.getInterfaceSize(), liveMainWindow()), direction))
  })
  setFolderOpen(session !== null)
}

const liveMainWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

function setInterfaceSize(size: InterfaceSize): void {
  store.setInterfaceSize(size)
  buildMenu()
  applyInterfaceSize(liveMainWindow())
}

/**
 * View > Interface Size on the main window: the page zoom from the setting, and the menu's automatic percent. The window
 * is zoom-isolated (createWindow), so the snapshot window on the same origin stays at 100% and agent screenshots do not change.
 */
function applyInterfaceSize(win: BrowserWindow | null): void {
  const automatic = automaticSize(win)
  if (automatic !== menuAutomaticSize) {
    menuAutomaticSize = automatic
    buildMenu()
  }
  if (!win || win.isDestroyed()) return
  const factor = interfaceFactor(store.getInterfaceSize(), win)
  if (Math.abs(win.webContents.getZoomFactor() - factor) < 1e-6) return
  win.webContents.setZoomFactor(factor)
  const { width, height } = screen.getDisplayMatching(win.getBounds()).workAreaSize
  win.setMinimumSize(Math.min(Math.round(MIN_PAGE[0] * factor), width), Math.min(Math.round(MIN_PAGE[1] * factor), height))
}

void app.whenReady().then(async () => {
  buildMenu()
  const displaysChanged = (): void => applyInterfaceSize(liveMainWindow())
  screen.on('display-metrics-changed', displaysChanged)
  screen.on('display-added', displaysChanged)
  screen.on('display-removed', displaysChanged)
  registerAssetProtocol()
  registerLiveItemProtocol(() => session)
  // Disk work runs beside the first paint, not before it.
  analytics.start()
  firstFolder = openInitialFolder().then(() => {
    setFolderOpen(session !== null)
    agentServer.start()
    analytics.record('app.boot.heartbeat', { recentFolderCount: store.recentFolders().length, readLinesOn: store.readLinesOn(), voiceSource: hasVoiceKey() ? 'own_key' : 'off' })
  })
  void installShim().catch((error) => console.error(`agent home: could not write the shim: ${String(error)}`))
  void cleanTraces().catch((error) => console.error(`storage: ${String(error)}`))
  void trimCodeCache().catch((error) => console.error(`storage: ${String(error)}`))
  mainWindow = createWindow()
  // The hidden helpers load once the board is up and has settled, so an agent's first screenshot and first scene are as fast as the later ones.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => snapshots.warm(), SNAPSHOT_WARM_MS)
    setTimeout(() => agentServer.warmStage(), STAGE_WARM_MS)
  })
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
