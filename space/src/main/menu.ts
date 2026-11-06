import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { PACES, VOICES, type PaceName } from './voice'
import { INTERFACE_SIZES, percent, type InterfaceSize } from './interface-size'

export interface MenuActions {
  openFolder(): void
  newBoard(): void
  /** File > Search Boards… (⌘K): the renderer opens the search panel, or closes it when it is open. */
  searchBoards(): void
  /** File > Set Up Folder for Learning…: the renderer shows the setup preview. */
  setupFolder(): void
  zoom(step: 'in' | 'out' | 'reset'): void
  /** ⌘A: the focused text field's text, or all nodes on the board. */
  selectAll(): void
  /** View > Hide Sidebar / Show Sidebar: the state at launch, and the toggle (setSidebarMenu follows it later). */
  sidebarHidden: boolean
  toggleSidebar(): void
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
  /** Settings… (⌘,): the renderer opens the Settings panel. */
  openSettings(): void
  /** View > Interface Size: the setting, the automatic factor for the window's display, and the changes. The menu is built again after each change. */
  interfaceSize: InterfaceSize
  automaticSize: number
  setInterfaceSize(size: InterfaceSize): void
  stepInterfaceSize(direction: 1 | -1): void
}

/**
 * The app menu. View > Zoom In / Zoom Out / Actual Size zoom the canvas, not
 * the page (there are no zoom roles); View > Interface Size zooms the page (interface-size.ts). The Edit roles make text editing work in inputs;
 * the canvas handles ⌘Z / ⌘C / ⌘V itself when no input has focus.
 */
const SETUP_ITEM = 'setup-folder'
const SEARCH_ITEM = 'search-boards'
const READ_LINES_ITEM = 'read-lines'
const SETTINGS_ITEM = 'settings'
const voiceItem = (voice: string): string => `voice:${voice}`
const paceItem = (pace: string): string => `pace:${pace}`
/** Two items, one visible at a time: a menu item's label does not change after the menu is built on macOS. */
const HIDE_SIDEBAR_ITEM = 'hide-sidebar'
const SHOW_SIDEBAR_ITEM = 'show-sidebar'

/** Folder-only menu items are enabled while a learning folder is open. */
export function setFolderOpen(open: boolean): void {
  for (const id of [SETUP_ITEM, SEARCH_ITEM]) {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    if (item) item.enabled = open
  }
}

/** View > Read Lines Aloud shows this. */
export function setReadLinesChecked(on: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(READ_LINES_ITEM)
  if (item) item.checked = on
}

/** View > Voice and Pace show these (a change from the Settings panel). */
export function setVoiceMenu(voice: string, pace: string): void {
  const menu = Menu.getApplicationMenu()
  const voiceEntry = menu?.getMenuItemById(voiceItem(voice))
  const paceEntry = menu?.getMenuItemById(paceItem(pace))
  if (voiceEntry) voiceEntry.checked = true
  if (paceEntry) paceEntry.checked = true
}

/** View > Hide Sidebar or Show Sidebar, whichever fits the sidebar now. */
export function setSidebarMenu(hidden: boolean): void {
  const menu = Menu.getApplicationMenu()
  const hide = menu?.getMenuItemById(HIDE_SIDEBAR_ITEM)
  const show = menu?.getMenuItemById(SHOW_SIDEBAR_ITEM)
  if (hide) hide.visible = !hidden
  if (show) show.visible = hidden
}

/** Dev hook: the sidebar item that shows now; with click, choose it first. */
export function devSidebarMenu(click: boolean): string | null {
  const menu = Menu.getApplicationMenu()
  const item = [menu?.getMenuItemById(HIDE_SIDEBAR_ITEM), menu?.getMenuItemById(SHOW_SIDEBAR_ITEM)].find((entry) => entry?.visible)
  if (!item) return null
  if (click) item.click()
  return [menu?.getMenuItemById(HIDE_SIDEBAR_ITEM), menu?.getMenuItemById(SHOW_SIDEBAR_ITEM)].find((entry) => entry?.visible)?.label ?? null
}

/** Dev hook: choose a menu item by id, as its click or accelerator does. */
export function devClickMenu(id: string): boolean {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id)
  if (!item || !item.visible || !item.enabled) return false
  item.click()
  return true
}

export function installMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin'
  const sidebarKey: Partial<MenuItemConstructorOptions> = isMac ? {} : { accelerator: 'CmdOrCtrl+B', registerAccelerator: false }
  const settingsItem: MenuItemConstructorOptions = { id: SETTINGS_ITEM, label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() }
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Learning Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.openFolder() },
        { label: 'New Board', accelerator: 'CmdOrCtrl+N', click: () => actions.newBoard() },
        // A second ⌘K closes the panel: the accelerator reaches the menu also while the panel's field has focus.
        { id: SEARCH_ITEM, label: 'Search Boards…', accelerator: 'CmdOrCtrl+K', enabled: false, click: () => actions.searchBoards() },
        { id: SETUP_ITEM, label: 'Set Up Folder for Learning…', enabled: false, click: () => actions.setupFolder() },
        { type: 'separator' },
        ...(isMac ? [] : [settingsItem, { type: 'separator' as const }]),
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
        // ⌘B is a renderer key (App.tsx), so bold in a text box keeps it: on macOS a menu accelerator would take the key first.
        // Linux and Windows show the hint only (registerAccelerator: false).
        { id: HIDE_SIDEBAR_ITEM, label: 'Hide Sidebar', visible: !actions.sidebarHidden, ...sidebarKey, click: () => actions.toggleSidebar() },
        { id: SHOW_SIDEBAR_ITEM, label: 'Show Sidebar', visible: actions.sidebarHidden, ...sidebarKey, click: () => actions.toggleSidebar() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom('in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom('out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => actions.zoom('reset') },
        {
          label: 'Interface Size',
          submenu: [
            { label: 'Larger', accelerator: 'CmdOrCtrl+Alt+=', click: () => actions.stepInterfaceSize(1) },
            { label: 'Smaller', accelerator: 'CmdOrCtrl+Alt+-', click: () => actions.stepInterfaceSize(-1) },
            { type: 'separator' },
            { id: 'interface-size-auto', label: `Automatic (${percent(actions.automaticSize)})`, accelerator: 'CmdOrCtrl+Alt+0', type: 'radio', checked: actions.interfaceSize === 'auto', click: () => actions.setInterfaceSize('auto') },
            // Ids for the dev hook (drive.mjs menu interface-size-120): the percent.
            ...INTERFACE_SIZES.map((size) => ({ id: `interface-size-${Math.round(size * 100)}`, label: percent(size), type: 'radio' as const, checked: actions.interfaceSize === size, click: () => actions.setInterfaceSize(size) }))
          ]
        },
        { type: 'separator' },
        { label: 'Show performance', type: 'checkbox', checked: actions.showPerformance, click: (item) => actions.setShowPerformance(item.checked) },
        { type: 'separator' },
        { id: READ_LINES_ITEM, label: 'Read Lines Aloud', type: 'checkbox', checked: actions.readLines, click: (item) => actions.setReadLines(item.checked) },
        { label: 'Voice', submenu: VOICES.map((voice) => ({ id: voiceItem(voice), label: voice, type: 'radio' as const, checked: voice === actions.voice, click: () => actions.setVoice(voice) })) },
        { label: 'Pace', submenu: (Object.keys(PACES) as PaceName[]).map((pace) => ({ id: paceItem(pace), label: PACES[pace].label, type: 'radio' as const, checked: pace === actions.pace, click: () => actions.setPace(pace) })) },
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
