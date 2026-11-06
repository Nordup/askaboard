/** Words and shortcut text that differ by platform, for text the learner reads. */

const platform = window.space.platform
export const isMac = platform === 'darwin'

/** A shortcut with the command key, for a hint or a title: macOS "⌘O", other platforms "Ctrl+O". */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

/** The menu label that shows a file in the system file manager. */
export const revealLabel = isMac ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Open Containing Folder'

/** The folder menu's open item: the sidebar footer's folder menu and the search panel's action. */
export const openFolderLabel = 'Open Learning Folder…'
