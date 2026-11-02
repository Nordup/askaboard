import { Menu, type MenuItemConstructorOptions } from 'electron'
import { PACES, VOICES, type PaceName } from './voice'

export interface MenuActions {
  openFolder(): void
  newBoard(): void
  /** File > Set Up Folder for Learning…: the renderer shows the setup preview. */
  setupFolder(): void
  zoom(step: 'in' | 'out' | 'reset'): void
  /** ⌘A: the focused text field's text, or all nodes on the board. */
  selectAll(): void
  /** View > Show performance: its state at launch, and the change. */
  showPerformance: boolean
  setShowPerformance(on: boolean): void
  /** View > Read Lines Aloud, Voice and Pace: their state at launch, and the changes. They count for new scenes. setReadLinesChecked sets the first one later. */
  readLines: boolean
  setReadLines(on: boolean): void
  voice: string
  setVoice(voice: string): void
  pace: PaceName
  setPace(pace: PaceName): void
}

/**
 * The app menu. View > Zoom In / Zoom Out / Actual Size zoom the canvas, not
 * the page (there are no zoom roles). The Edit roles make text editing work in inputs;
 * the canvas handles ⌘Z / ⌘C / ⌘V itself when no input has focus.
 */
const SETUP_ITEM = 'setup-folder'
const READ_LINES_ITEM = 'read-lines'

/** Folder-only menu items are enabled while a learning folder is open. */
export function setFolderOpen(open: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(SETUP_ITEM)
  if (item) item.enabled = open
}

/** View > Read Lines Aloud shows this. */
export function setReadLinesChecked(on: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(READ_LINES_ITEM)
  if (item) item.checked = on
}

export function installMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Learning Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => actions.newBoard() },
        { id: SETUP_ITEM, label: 'Set Up Folder for Learning…', enabled: false, click: () => actions.setupFolder() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        // Not the selectAll role: on the canvas ⌘A selects nodes; in a text field the renderer selects its text.
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => actions.selectAll() }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom('in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom('out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => actions.zoom('reset') },
        { type: 'separator' },
        { label: 'Show performance', type: 'checkbox', checked: actions.showPerformance, click: (item) => actions.setShowPerformance(item.checked) },
        { type: 'separator' },
        { id: READ_LINES_ITEM, label: 'Read Lines Aloud', type: 'checkbox', checked: actions.readLines, click: (item) => actions.setReadLines(item.checked) },
        { label: 'Voice', submenu: VOICES.map((voice) => ({ label: voice, type: 'radio' as const, checked: voice === actions.voice, click: () => actions.setVoice(voice) })) },
        { label: 'Pace', submenu: (Object.keys(PACES) as PaceName[]).map((pace) => ({ label: PACES[pace].label, type: 'radio' as const, checked: pace === actions.pace, click: () => actions.setPace(pace) })) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
