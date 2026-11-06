import { LOCK_KEY, TOOLS } from '../../tools'
import { allCommandGroups, KEYS, KEYS_PANEL_KEY, ZOOM_COMMANDS } from '../../board/commands'
import { SettingGroup } from './parts'

interface KeyRow {
  label: string
  keys: string
}

/** The groups: the tools from TOOLS, the board commands from commands.ts, then the view keys. */
function groups(): { heading: string; rows: KeyRow[] }[] {
  const tools: KeyRow[] = [
    ...TOOLS.map((tool) => ({ label: tool.label, keys: tool.digit ? `${tool.key} or ${tool.digit}` : tool.key })),
    { label: 'Keep tool', keys: LOCK_KEY }
  ]
  const edit: KeyRow[] = [{ label: 'Undo', keys: KEYS.undo }, { label: 'Redo', keys: KEYS.redo }, ...allCommandGroups().flat()]
  const view: KeyRow[] = [
    { label: 'Zoom in', keys: KEYS.zoomIn },
    { label: 'Zoom out', keys: KEYS.zoomOut },
    ...ZOOM_COMMANDS,
    { label: 'Pan', keys: 'Space + drag' },
    { label: 'Back', keys: KEYS.back },
    { label: 'Forward', keys: KEYS.forward },
    { label: 'Deselect, or back to Select', keys: 'Esc' },
    { label: 'Keyboard shortcuts', keys: KEYS_PANEL_KEY }
  ]
  return [
    { heading: 'Tools', rows: tools },
    { heading: 'Edit', rows: edit },
    { heading: 'View', rows: view }
  ]
}

/** Settings > Keyboard shortcuts (? opens Settings here): the one list of the app's keys. */
export function ShortcutsSection() {
  return (
    <>
      {groups().map((group) => (
        <SettingGroup key={group.heading} heading={group.heading}>
          {group.rows.map((row) => (
            <div key={row.label} className="menu__row">
              <span className="menu__name">{row.label}</span>
              <span className="menu__meta menu__meta--mono">{row.keys}</span>
            </div>
          ))}
        </SettingGroup>
      ))}
    </>
  )
}
