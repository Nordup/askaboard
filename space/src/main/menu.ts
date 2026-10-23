import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  openFolder(): void
  newBoard(): void
  zoom(step: 'in' | 'out' | 'reset'): void
  /** ⌘A: the focused text field's text, or all nodes on the board. */
  selectAll(): void
}

/**
 * The app menu. View > Zoom In / Zoom Out / Actual Size zoom the canvas, not
 * the page (there are no zoom roles). The Edit roles make text editing work in inputs;
 * the canvas handles ⌘Z / ⌘C / ⌘V itself when no input has focus.
 */
export function installMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Learning Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => actions.newBoard() },
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
