import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SpaceApi, type Unsubscribe } from '@shared/space-api'

// The preload runs sandboxed, so it cannot read package.json. The main
// process answers this one synchronous call before the page script runs.
const version = ipcRenderer.sendSync(IPC.appVersion) as string
const devHooks = ipcRenderer.sendSync(IPC.devHooks) === true
const worldTune = ipcRenderer.sendSync(IPC.worldTune) as SpaceApi['worldTune']

function listen<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: SpaceApi = {
  platform: process.platform,
  version,
  devHooks,
  worldTune,

  getInitialState: () => ipcRenderer.invoke(IPC.getInitialState),
  openFolderDialog: () => ipcRenderer.invoke(IPC.openFolderDialog),
  openRecent: (path) => ipcRenderer.invoke(IPC.openRecent, path),
  listFiles: () => ipcRenderer.invoke(IPC.listFiles),

  readBoard: (path) => ipcRenderer.invoke(IPC.readBoard, path),
  writeBoard: (path, text, info) => ipcRenderer.invoke(IPC.writeBoard, path, text, info),
  createBoard: (name, folder) => ipcRenderer.invoke(IPC.createBoard, name, folder),
  renameBoard: (path, newName) => ipcRenderer.invoke(IPC.renameBoard, path, newName),
  deleteBoard: (path) => ipcRenderer.invoke(IPC.deleteBoard, path),

  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  revealInFinder: (path) => ipcRenderer.invoke(IPC.revealInFinder, path),

  setupPlan: () => ipcRenderer.invoke(IPC.setupPlan),
  applySetup: () => ipcRenderer.invoke(IPC.applySetup),
  setSetupDontAsk: (value) => ipcRenderer.invoke(IPC.setSetupDontAsk, value),
  getShowPerformance: () => ipcRenderer.invoke(IPC.getShowPerformance),
  getUncappedFrames: () => ipcRenderer.invoke(IPC.getUncappedFrames),
  setUncappedFrames: (on) => ipcRenderer.invoke(IPC.setUncappedFrames, on),
  boardGuidePath: () => ipcRenderer.invoke(IPC.boardGuidePath),
  getGuideOverrides: () => ipcRenderer.invoke(IPC.getGuideOverrides),
  onGuideOverrides: (listener) => listen(IPC.guideOverrides, listener),

  getCamera: (path) => ipcRenderer.invoke(IPC.getCamera, path),
  setCamera: (path, camera) => ipcRenderer.send(IPC.setCamera, path, camera),
  setLastBoard: (path) => ipcRenderer.send(IPC.setLastBoard, path),
  openSceneRecords: (path, id) => ipcRenderer.invoke(IPC.openSceneRecords, path, id),
  onSceneStories: (listener) => listen(IPC.sceneStories, listener),
  rebuildScenes: (sceneIds) => ipcRenderer.invoke(IPC.rebuildScenes, sceneIds),

  onFolderOpened: (listener) => listen(IPC.folderOpened, listener),
  onFilesChanged: (listener) => listen(IPC.filesChanged, listener),
  onBoardChanged: (listener) => listen(IPC.boardChanged, listener),
  onMenuCommand: (listener) => listen(IPC.menuCommand, listener),
  onFlushRequest: (listener) => listen<void>(IPC.flushRequest, () => listener()),
  flushDone: () => ipcRenderer.send(IPC.flushDone),

  getAgentStatus: () => ipcRenderer.invoke(IPC.getAgentStatus),
  onAgentStatus: (listener) => listen(IPC.agentStatus, listener),
  onAgentActivity: (listener) => listen(IPC.agentActivity, listener),
  onAgentRequest: (listener) => listen(IPC.agentRequest, listener),
  replyAgent: (reply) => ipcRenderer.send(IPC.agentReply, reply),
  getAgentClients: () => ipcRenderer.invoke(IPC.getAgentClients),
  connectAgentClient: (id, action) => ipcRenderer.invoke(IPC.connectAgentClient, id, action),

  importAsset: (src) => ipcRenderer.invoke(IPC.importAsset, src),
  onSnapshotRequest: (listener) => listen(IPC.snapshotRequest, listener),
  snapshotReady: (reply) => ipcRenderer.send(IPC.snapshotReady, reply),
  sceneEvent: (event) => ipcRenderer.send(IPC.sceneEvent, event),
  framesPort: () => ipcRenderer.send(IPC.framesPort)
}

// A MessagePort cannot cross the context bridge: the page gets it as a window message (renderer/live/frames.ts).
// The target origin is '*': a file:// page has an opaque origin, which no origin string matches (the message holds only the port, for this window).
const page = globalThis as unknown as { postMessage(message: string, targetOrigin: string, transfer: unknown[]): void }
ipcRenderer.on(IPC.framesPort, (event) => {
  page.postMessage('ls-frames-port', '*', event.ports)
})

contextBridge.exposeInMainWorld('space', api)
