import { Menu, type MenuEntry } from './Menu'
import { commandGroups, type BoardCommand, type CommandContext } from '../board/commands'

interface BoardMenuProps {
  /** Window CSS pixels: the menu's top-left corner, or with `above` its bottom-left corner. */
  x: number
  y: number
  above?: boolean
  /** What the commands depend on, taken when the menu opened. */
  context: CommandContext
  onCommand(command: BoardCommand): void
  onClose(): void
  /** The button that opens the menu (the style pill's More): a press on it is not an outside press. */
  toggle?: HTMLElement | null
}

/** True when the board menu would have a row for this context: an empty menu does not open. */
export function hasBoardMenu(context: CommandContext): boolean {
  return commandGroups(context).length > 0
}

/** The board's commands (board/commands.ts) in the shared menu: the right-click menu and the style pill's More menu. */
export function BoardMenu({ x, y, above, context, onCommand, onClose, toggle }: BoardMenuProps) {
  const entries: MenuEntry[] = commandGroups(context).flatMap((group, i) => [
    ...(i > 0 ? (['separator'] as const) : []),
    ...group.map((row) => ({ label: row.label, hint: row.keys, onSelect: () => onCommand(row.id) }))
  ])
  return <Menu x={x} y={y} above={above} entries={entries} onClose={onClose} toggle={toggle} />
}
