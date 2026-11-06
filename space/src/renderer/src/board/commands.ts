/**
 * The board commands of the right-click menu and of the style pill's More menu:
 * one list feeds both, so the two menus cannot differ.
 */

import { isMac, shortcut } from '../platform'
import type { BoardKeyAction } from './clipboard'

export type BoardCommand = Exclude<BoardKeyAction, 'undo' | 'redo'>

/** What the commands depend on, when a menu opens. */
export interface CommandContext {
  /** Something is selected. */
  selection: boolean
  /** Some selected item is not locked. */
  editable: boolean
  /** The board clipboard holds items. */
  clipboard: boolean
  /** The board shows at least one item. */
  items: boolean
}

interface CommandDef {
  id: BoardCommand
  label: string
  /** The key, for the menu's hint. */
  keys: string
  /** The command can run: a menu leaves out the others (no disabled rows). */
  runs(context: CommandContext): boolean
}

const shift = (key: string): string => shortcut(isMac ? `⇧${key}` : `Shift+${key}`)

/** The commands in menu order, in groups with a line between them. */
const COMMAND_GROUPS: readonly (readonly CommandDef[])[] = [
  [
    { id: 'cut', label: 'Cut', keys: shortcut('X'), runs: (c) => c.editable },
    { id: 'copy', label: 'Copy', keys: shortcut('C'), runs: (c) => c.selection },
    { id: 'paste', label: 'Paste', keys: shortcut('V'), runs: (c) => c.clipboard },
    { id: 'duplicate', label: 'Duplicate', keys: shortcut('D'), runs: (c) => c.selection },
    { id: 'delete', label: 'Delete', keys: isMac ? '⌫' : 'Delete', runs: (c) => c.editable },
    { id: 'selectAll', label: 'Select all', keys: shortcut('A'), runs: (c) => !c.selection && c.items }
  ],
  [
    { id: 'front', label: 'Bring to front', keys: shift(']'), runs: (c) => c.editable },
    { id: 'back', label: 'Send to back', keys: shift('['), runs: (c) => c.editable }
  ]
]

export interface CommandRow {
  id: BoardCommand
  label: string
  keys: string
}

/** The commands that can run now, in groups; empty groups are left out. */
export function commandGroups(context: CommandContext): CommandRow[][] {
  return COMMAND_GROUPS.map((group) => group.filter((command) => command.runs(context)).map(({ id, label, keys }) => ({ id, label, keys }))).filter((group) => group.length > 0)
}

/** One command's label and keys, for a button that runs it (the style pill's Duplicate and Delete). */
export function commandRow(id: BoardCommand): CommandRow {
  const def = COMMAND_GROUPS.flat().find((command) => command.id === id) as CommandDef
  return { id, label: def.label, keys: def.keys }
}
