import { Fragment } from 'react'
import { LOCK_KEY, TOOLS } from '../../tools'
import { allCommandGroups, KEYS, KEYS_PANEL_KEY, ZOOM_COMMANDS } from '../../board/commands'

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

type KeyPart = { cap: string } | { word: string }

/** One combo as caps, one per key: "⌘⇧]" is ⌘ ⇧ ], "Ctrl+Shift+Z" is Ctrl Shift Z, "Ctrl++" is Ctrl +. */
function comboCaps(combo: string): string[] {
  const caps: string[] = []
  let rest = combo
  for (;;) {
    const symbol = /^[⌘⇧⌥⌃]/.exec(rest)
    const named = symbol ? null : /^(Ctrl|Shift|Alt|Cmd)\+/.exec(rest)
    const found = symbol ?? named
    if (!found || found[0].length === rest.length) break
    caps.push(symbol ? found[0] : found[1])
    rest = rest.slice(found[0].length)
  }
  return [...caps, rest]
}

/** A key as the sheet shows it: caps, with "or" between two keys and a plain word for a gesture ("Space + drag"). */
function keyParts(keys: string): KeyPart[] {
  return keys.split(' or ').flatMap((one, index) => {
    const parts: KeyPart[] = index ? [{ word: 'or' }] : []
    for (const piece of one.split(' + ')) {
      if (/^[a-z]+$/.test(piece)) parts.push({ word: piece })
      else parts.push(...comboCaps(piece).map((cap) => ({ cap })))
    }
    return parts
  })
}

/** Settings > Keyboard shortcuts (? opens Settings here): the one list of the app's keys, as a sheet of key caps. */
export function ShortcutsSection() {
  return (
    <div className="menu__sheet">
      {groups().map((group) => (
        <Fragment key={group.heading}>
          <div className="menu__heading">{group.heading}</div>
          {group.rows.map((row) => (
            <div key={row.label} className="menu__sheet-line">
              <span className="menu__keys">
                {keyParts(row.keys).map((part, index) =>
                  'cap' in part ? (
                    <kbd key={index} className="menu__key">
                      {part.cap}
                    </kbd>
                  ) : (
                    <span key={index} className="menu__key-word">
                      {part.word}
                    </span>
                  )
                )}
              </span>
              <span className="menu__name">{row.label}</span>
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}
