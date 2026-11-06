import type { BoardNode, TextNode } from './types'

/**
 * The board's clipboards. The in-app clipboard holds copied node subtrees
 * (roots detached to top level at their world position); paste gives them
 * fresh ids. A copy also puts the plain text of its text items on the system
 * clipboard (or clears it), and remembers that text: a later paste of the
 * same text is "our own copy" and pastes the items, other text or an image
 * is something new (pasteContent).
 */
let internalClipboard: { nodes: BoardNode[]; roots: string[] } = { nodes: [], roots: [] }

/** The system clipboard text that the last board copy wrote (line ends as "\n"), or null before the first copy. */
let ownText: string | null = null
/** The system clipboard holds text or an image: refreshed on focus, after a copy and after a paste (refreshSystemClipboard). */
let systemHas = false

/** Copy items to the board clipboard, and their text to the system clipboard (empty text when they hold none). */
export function writeNodeClipboard(copied: { nodes: BoardNode[]; roots: string[] }): void {
  internalClipboard = structuredClone(copied)
  const text = copied.nodes
    .filter((node): node is TextNode => node.kind === 'text' && typeof (node as TextNode).text === 'string' && (node as TextNode).text.trim() !== '')
    .map((node) => node.text.trim())
    .join('\n\n')
  ownText = normalize(text)
  systemHas = text !== ''
  window.space.writeClipboardText(text)
}

export function readNodeClipboard(): { nodes: BoardNode[]; roots: string[] } {
  return structuredClone(internalClipboard)
}

export function hasNodeClipboard(): boolean {
  return internalClipboard.roots.length > 0
}

/** A paste has something: board items, or text or an image on the system clipboard (as last read: no wait). */
export function canPaste(): boolean {
  return hasNodeClipboard() || systemHas
}

/** Read again whether the system clipboard holds something (another app may have copied). */
export function refreshSystemClipboard(): void {
  void window.space.clipboardHasContent().then(
    (has) => (systemHas = has),
    () => undefined
  )
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** What a paste puts on the board. */
export type PasteContent = { kind: 'items' } | { kind: 'text'; text: string } | { kind: 'image'; file: File }

/**
 * What a paste event's data pastes: our own copy pastes the board items; an image pastes the image, unless
 * the clipboard also holds text of several words (a copy from a document, which may carry a picture of
 * itself) that is not the image's file name; other text pastes as a text item; nothing new pastes the
 * board items. Null: nothing to paste.
 */
export function pasteContent(data: DataTransfer): PasteContent | null {
  const text = normalize(data.getData('text/plain')).replace(/\s+$/, '')
  const trimmed = text.trim()
  const items = hasNodeClipboard()
  const image = [...data.files].find((file) => file.type.startsWith('image/'))
  // A copy of items without text cleared the clipboard: an image there now is new.
  if (items && text === ownText && (text !== '' || !image)) return { kind: 'items' }
  if (image && (!trimmed || /^\S+$/.test(trimmed) || trimmed === image.name)) return { kind: 'image', file: image }
  if (trimmed) return { kind: 'text', text: text.replace(/^\s*\n/, '') }
  return items ? { kind: 'items' } : null
}

export type BoardKeyAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'selectAll' | 'front' | 'back'

/** Map a key event to a board action. The caller rejects editable targets first. */
export function boardKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  options: { hasSelection: boolean }
): BoardKeyAction | null {
  const key = event.key.toLowerCase()
  const modified = event.metaKey || event.ctrlKey
  if (event.altKey) return null
  if (modified && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (event.ctrlKey && key === 'y') return 'redo'
  if (modified && key === 'x') return options.hasSelection ? 'cut' : null
  if (modified && key === 'c') return options.hasSelection ? 'copy' : null
  // ⌘V is no key action: the DOM paste event (Board) is the one way in, for the key and the Edit menu alike.
  if (modified && key === 'd') return options.hasSelection ? 'duplicate' : null
  if (modified && key === 'a') return 'selectAll'
  // By the key's place: Shift turns ] and [ into other characters on most layouts.
  if (modified && event.shiftKey && event.code === 'BracketRight') return options.hasSelection ? 'front' : null
  if (modified && event.shiftKey && event.code === 'BracketLeft') return options.hasSelection ? 'back' : null
  if (!modified && (event.key === 'Delete' || event.key === 'Backspace') && options.hasSelection) return 'delete'
  return null
}
