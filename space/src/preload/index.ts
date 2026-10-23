import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type SpaceApi } from '@shared/space-api'

// The preload runs sandboxed, so it cannot read package.json. The main
// process answers this one synchronous call before the page script runs.
const version = ipcRenderer.sendSync(IPC.appVersion) as string

const api: SpaceApi = {
  platform: process.platform,
  version
}

contextBridge.exposeInMainWorld('space', api)
