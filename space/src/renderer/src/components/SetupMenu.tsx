import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SetupItem, SetupPlan } from '@shared/space-api'
import { errorMessage } from '../lib/errors'

interface SetupMenuProps {
  /** The element the menu hangs under (the sidebar setup row, or the folder header). */
  anchor: HTMLElement | null
  /** The anchor opens and closes the menu itself, so a click on it is not an outside click. */
  anchorToggles: boolean
  /** Changes when the folder changes on disk, so the list reloads. */
  version: number
  onSetUp(): Promise<void>
  /** Outside click, Escape, or "Nothing to add". */
  onClose(): void
  /** "Don't ask for this folder". */
  onDontAsk(): void
}

/** The three working folders share one line. */
const GROUPED_DIRS = ['sessions', 'topics', 'materials']

interface Line {
  key: string
  label: string
  isNew: boolean
}

/**
 * The lines the menu lists. boards/ and .learning-space/ are left out: setup
 * still creates them, but they add noise here.
 */
function lines(items: SetupItem[]): Line[] {
  const shown = items.filter((item) => item.path !== 'boards' && !item.path.startsWith('.learning-space'))
  const result: Line[] = []
  const grouped = shown.filter((item) => item.kind === 'dir' && GROUPED_DIRS.includes(item.path))
  for (const item of shown) {
    if (grouped.includes(item)) {
      if (item === grouped[0])
        result.push({ key: 'dirs', label: grouped.map((dir) => `${dir.path}/`).join(' '), isNew: grouped.some((dir) => !dir.exists) })
      continue
    }
    result.push({ key: item.path, label: item.kind === 'dir' ? `${item.path}/` : item.path, isNew: !item.exists })
  }
  return result
}

/** "Set up this folder": the files setup adds, in the app's menu style. */
export function SetupMenu({ anchor, anchorToggles, version, onSetUp, onClose, onDontAsk }: SetupMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })

  useEffect(() => {
    let current = true
    window.space.setupPlan().then(
      (next) => {
        if (!current) return
        setPlan(next)
        setError(null)
      },
      (reason: unknown) => current && setError(errorMessage(reason))
    )
    return () => {
      current = false
    }
  }, [version])

  // A flyout beside the sidebar: 12px right of its edge, top aligned with the anchor, inside the window.
  // With the sidebar hidden (File > Set Up Folder for Learning…), it opens at the left, under the top bar.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const shown = anchor && anchor.getClientRects().length > 0 ? anchor : null
    const base = shown?.getBoundingClientRect()
    const sidebar = shown?.closest('.sidebar')?.getBoundingClientRect()
    const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
    const left = sidebar ? sidebar.right + 12 : base ? base.right + 12 : 12
    const top = base ? base.top : (topbar?.bottom ?? 0) + 12
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))
    })
  }, [anchor, plan])

  useEffect(() => {
    const down = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if (anchorToggles && anchor?.contains(target)) return
      onClose()
      // Focus goes back to the anchor unless the click lands on something that takes focus.
      if (!(target instanceof Element && target.closest('button, input, textarea, select, a, [tabindex]'))) anchor?.focus({ preventScroll: true })
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        anchor?.focus()
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [anchor, anchorToggles, onClose])

  const nothingToAdd = plan !== null && plan.items.every((item) => item.exists)

  const setUp = async (): Promise<void> => {
    if (nothingToAdd) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await onSetUp()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div ref={ref} className="menu setup-menu" role="dialog" aria-label="Set up this folder" style={position}>
      <div className="menu__title">Set up this folder</div>
      <div className="menu__lede">Agents use these files to plan and remember.</div>
      {error && <div className="menu__line menu__line--error">{error}</div>}
      {!plan && !error && <div className="menu__line">Loading…</div>}
      {plan && (
        <ul className="menu__list">
          {lines(plan.items).map((line) => (
            <li key={line.key} className="menu__row">
              <span className="menu__name menu__name--mono">{line.label}</span>
              <span className={line.isNew ? 'menu__meta menu__meta--accent' : 'menu__meta'}>{line.isNew ? 'new' : 'kept'}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="menu__separator" />
      <div className="menu__footer">
        {plan && !plan.setUp ? (
          <button className="btn-text" onClick={onDontAsk}>
            Don’t ask for this folder
          </button>
        ) : (
          <span />
        )}
        <button
          className={nothingToAdd ? 'btn-sm btn-sm--quiet' : 'btn-sm'}
          data-action="setup"
          disabled={busy || (!plan && !error)}
          onClick={() => void setUp()}
        >
          {nothingToAdd ? 'Nothing to add' : busy ? 'Setting up…' : 'Set up'}
        </button>
      </div>
    </div>,
    document.body
  )
}
