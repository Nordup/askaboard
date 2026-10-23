import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '@shared/space-api'

/** The colour of the window before the renderer paints. Keep it equal to --bg-app. */
const BACKGROUND = '#111113'

/** Dev hook: write a PNG of the window to this path after load. */
const capturePath = process.env.SPACE_CAPTURE
/** Dev hook: quit after the capture. */
const captureQuit = process.env.SPACE_CAPTURE_QUIT === '1'
/** Dev hook (step 1): open this learning folder at launch. Read only for now. */
const launchFolder = process.env.SPACE_FOLDER

ipcMain.on(IPC.appVersion, (event) => {
  event.returnValue = app.getVersion()
})

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
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // Links that open a new window go to the system browser, never to a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void capture(win, capturePath), 1000)
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

void app.whenReady().then(() => {
  if (launchFolder) console.log(`SPACE_FOLDER=${launchFolder} (folder support arrives in step 1)`)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || captureQuit) app.quit()
})
