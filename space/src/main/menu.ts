import { Menu, type MenuItemConstructorOptions } from 'electron'

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
}

/**
 * The app menu. View > Zoom In / Zoom Out / Actual Size zoom the canvas, not
 * the page (there are no zoom roles). The Edit roles make text editing work in inputs;
 * the canvas handles ⌘Z / ⌘C / ⌘V itself when no input has focus.
 */
const SETUP_ITEM = 'setup-folder'

/** Folder-only menu items are enabled while a learning folder is open. */
export function setFolderOpen(open: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(SETUP_ITEM)
  if (item) item.enabled = open
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
