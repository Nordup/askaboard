import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { interfaceSizeLabel, type SettingsChange, type SettingsSnapshot } from '@shared/space-api'

export interface MenuActions {
  openFolder(): void
  newBoard(): void
  /** View > Back / Forward (⌘[ / ⌘]): the renderer moves through its board history (U11). */
  back(): void
  forward(): void
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
  /** Settings… (⌘,): the renderer opens the Settings dialog. */
  openSettings(): void
  /**
   * The settings items (View > Interface Size, Show performance, Read Lines Aloud, Voice, Pace) show the snapshot of
   * main/settings.ts and change through its one path. Every change there builds the menu again, so the items never
   * keep a state of their own.
   */
  settings: SettingsSnapshot
  changeSettings(change: SettingsChange): void
  stepInterfaceSize(direction: 1 | -1): void
}

/**
 * The app menu. View > Zoom In / Zoom Out / Actual Size zoom the canvas, not
 * the page (there are no zoom roles); View > Interface Size zooms the page (interface-size.ts). The Edit roles make text editing work in inputs;
 * the canvas handles ⌘Z / ⌘C itself when no input has focus, and pastes on the page's paste event (Edit > Paste and ⌘V).
 */
const SETUP_ITEM = 'setup-folder'
const SEARCH_ITEM = 'search-boards'
const SETTINGS_ITEM = 'settings'
const voiceItem = (voice: string): string => `voice:${voice}`
const paceItem = (pace: string): string => `pace:${pace}`
/** Two items, one visible at a time: a menu item's label does not change after the menu is built on macOS. */
const HIDE_SIDEBAR_ITEM = 'hide-sidebar'
const SHOW_SIDEBAR_ITEM = 'show-sidebar'
const BACK_ITEM = 'back'
const FORWARD_ITEM = 'forward'
/** What the renderer last said of Back and Forward: a menu built again (Interface Size) starts from it. */
const history = { back: false, forward: false }

/** View > Back and Forward are enabled as the title row's buttons are (the renderer sends each change). */
export function setHistoryMenu(back: boolean, forward: boolean): void {
  history.back = back
  history.forward = forward
  const menu = Menu.getApplicationMenu()
  const backEntry = menu?.getMenuItemById(BACK_ITEM)
  const forwardEntry = menu?.getMenuItemById(FORWARD_ITEM)
  if (backEntry) backEntry.enabled = back
  if (forwardEntry) forwardEntry.enabled = forward
}

/** Folder-only menu items are enabled while a learning folder is open. */
export function setFolderOpen(open: boolean): void {
  for (const id of [SETUP_ITEM, SEARCH_ITEM]) {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    if (item) item.enabled = open
  }
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

/** Dev hook: the menu item with this id as it shows now (drive.mjs menu-state). */
export function devMenuItem(id: string): { label: string; checked: boolean; enabled: boolean; visible: boolean } | null {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id)
  return item ? { label: item.label, checked: item.checked, enabled: item.enabled, visible: item.visible } : null
}

export function installMenu(actions: MenuActions): void {
  const { general, voice } = actions.settings
  const change = actions.changeSettings
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
        // ⌘[ and ⌘] have no text-field behaviour, so the menu may take them first; ⌘⇧[ and ⌘⇧] (send to back, bring to front) are other keys.
        { id: BACK_ITEM, label: 'Back', accelerator: 'CmdOrCtrl+[', enabled: history.back, click: () => actions.back() },
        { id: FORWARD_ITEM, label: 'Forward', accelerator: 'CmdOrCtrl+]', enabled: history.forward, click: () => actions.forward() },
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
            { id: 'interface-size-auto', label: interfaceSizeLabel('auto', general.automaticSize), accelerator: 'CmdOrCtrl+Alt+0', type: 'radio', checked: general.interfaceSize === 'auto', click: () => change({ interfaceSize: 'auto' }) },
            // Ids for the dev hook (drive.mjs menu interface-size-120): the percent.
            ...general.interfaceSizes.map((size) => ({ id: `interface-size-${Math.round(size * 100)}`, label: interfaceSizeLabel(size, general.automaticSize), type: 'radio' as const, checked: general.interfaceSize === size, click: () => change({ interfaceSize: size }) }))
          ]
        },
        { type: 'separator' },
        { id: 'show-performance', label: 'Show performance', type: 'checkbox', checked: general.showPerformance, click: (item) => change({ showPerformance: item.checked }) },
        { type: 'separator' },
        { id: 'read-lines', label: 'Read Lines Aloud', type: 'checkbox', checked: voice.readLines, click: (item) => change({ readLines: item.checked }) },
        // The voices of the chosen model (Settings > Voice), as the dialog's select shows them.
        { label: 'Voice', submenu: voice.voices.map((name) => ({ id: voiceItem(name), label: name, type: 'radio' as const, checked: name === voice.voice, click: () => change({ voice: name }) })) },
        { label: 'Pace', submenu: voice.paces.map((pace) => ({ id: paceItem(pace.id), label: pace.label, type: 'radio' as const, checked: pace.id === voice.pace, click: () => change({ pace: pace.id }) })) },
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
