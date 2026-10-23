import type { BoardNode } from './types'

/**
 * The in-app clipboard: copied node subtrees (roots detached to top level at
 * their world position). Paste gives them fresh ids.
 */
let internalClipboard: { nodes: BoardNode[]; roots: string[] } = { nodes: [], roots: [] }

export function writeNodeClipboard(copied: { nodes: BoardNode[]; roots: string[] }): void {
  internalClipboard = structuredClone(copied)
}

export function readNodeClipboard(): { nodes: BoardNode[]; roots: string[] } {
  return structuredClone(internalClipboard)
}

export function hasNodeClipboard(): boolean {
  return internalClipboard.roots.length > 0
}

export type BoardKeyAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'selectAll'

/** Map a key event to a board action. The caller rejects editable targets first. */
export function boardKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  options: { hasSelection: boolean; hasClipboard: boolean }
): BoardKeyAction | null {
  const key = event.key.toLowerCase()
  const modified = event.metaKey || event.ctrlKey
  if (event.altKey) return null
  if (modified && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (event.ctrlKey && key === 'y') return 'redo'
  if (modified && key === 'x') return options.hasSelection ? 'cut' : null
  if (modified && key === 'c') return options.hasSelection ? 'copy' : null
  if (modified && key === 'v') return options.hasClipboard ? 'paste' : null
  if (modified && key === 'd') return options.hasSelection ? 'duplicate' : null
  if (modified && key === 'a') return 'selectAll'
  if (!modified && (event.key === 'Delete' || event.key === 'Backspace') && options.hasSelection) return 'delete'
  return null
}
