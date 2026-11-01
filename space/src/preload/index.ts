import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SpaceApi, type Unsubscribe } from '@shared/space-api'

// The preload runs sandboxed, so it cannot read package.json. The main
// process answers this one synchronous call before the page script runs.
const version = ipcRenderer.sendSync(IPC.appVersion) as string
const devHooks = ipcRenderer.sendSync(IPC.devHooks) === true
const worldTune = ipcRenderer.sendSync(IPC.worldTune) as SpaceApi['worldTune']
const frameLimitOff = ipcRenderer.sendSync(IPC.frameLimitOff) as SpaceApi['frameLimitOff']

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
  frameLimitOff,

  getInitialState: () => ipcRenderer.invoke(IPC.getInitialState),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  openFolder: (path) => ipcRenderer.invoke(IPC.openFolder, path),
  listFiles: () => ipcRenderer.invoke(IPC.listFiles),

  readBoard: (root, path) => ipcRenderer.invoke(IPC.readBoard, root, path),
  readRecovery: (root, path) => ipcRenderer.invoke(IPC.readRecovery, root, path),
  writeBoard: (root, path, text, info) => ipcRenderer.invoke(IPC.writeBoard, root, path, text, info),
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
  setCamera: (root, path, camera) => ipcRenderer.send(IPC.setCamera, root, path, camera),
  setLastBoard: (root, path) => ipcRenderer.send(IPC.setLastBoard, root, path),
  openSceneRecords: (path, id) => ipcRenderer.invoke(IPC.openSceneRecords, path, id),
  onSceneStories: (listener) => listen(IPC.sceneStories, listener),
  rebuildScenes: (sceneIds) => ipcRenderer.invoke(IPC.rebuildScenes, sceneIds),

  onFilesChanged: (listener) => listen(IPC.filesChanged, listener),
  onBoardChanged: (listener) => listen(IPC.boardChanged, listener),
  onMenuCommand: (listener) => listen(IPC.menuCommand, listener),
  onFlushRequest: (listener) => listen<void>(IPC.flushRequest, () => listener()),
  devClose: () => ipcRenderer.send(IPC.devClose),
  devCloseAnswer: (button) => ipcRenderer.send(IPC.devCloseAnswer, button),
  flushStarted: () => ipcRenderer.send(IPC.flushStarted),
  flushDone: (failed) => ipcRenderer.send(IPC.flushDone, failed),

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
  worldLog: (level, text) => ipcRenderer.send(IPC.worldLog, level, text),
  framesPort: () => ipcRenderer.send(IPC.framesPort)
}

// A MessagePort cannot cross the context bridge: the page gets it as a window message (renderer/live/frames.ts).
// The target origin is '*': a file:// page has an opaque origin, which no origin string matches (the message holds only the port, for this window).
const page = globalThis as unknown as { postMessage(message: string, targetOrigin: string, transfer: unknown[]): void }
ipcRenderer.on(IPC.framesPort, (event) => {
  page.postMessage('ls-frames-port', '*', event.ports)
})

contextBridge.exposeInMainWorld('space', api)
