import { ipcRenderer } from 'electron'

/**
 * The preload of the stage page (main/stage-process.ts). The page has no
 * Electron API: this preload only hands it its MessagePorts, and does nothing
 * else: once, its port to the main process; and each time main links one, its
 * port to the board renderer for the frames of scenes (main/live-scene.ts).
 */
const page = globalThis as unknown as { location: { origin: string }; postMessage(message: string, targetOrigin: string, transfer: unknown[]): void }

ipcRenderer.once('stage-port', (event) => {
  page.postMessage('stage-port', page.location.origin, event.ports)
})

ipcRenderer.on('frames-port', (event) => {
  page.postMessage('frames-port', page.location.origin, event.ports)
})
