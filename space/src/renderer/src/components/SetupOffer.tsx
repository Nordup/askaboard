import { useEffect, useState } from 'react'
import { File, Folder, GraduationCap, X } from 'lucide-react'
import type { SetupPlan } from '@shared/space-api'
import { errorMessage } from '../lib/errors'

interface SetupOfferProps {
  /** "offer": the quiet offer for a folder that is not set up. "menu": File > Set Up Folder for Learning…, preview open. */
  source: 'offer' | 'menu'
  /** Changes when the folder changes on disk, so an open preview reloads. */
  version: number
  onSetUp(): Promise<void>
  /** "Not now" or Cancel. */
  onClose(): void
  /** "Don't ask for this folder". */
  onDontAsk(): void
}

/** A small card at the top of the canvas: "Set up this folder for learning?" with a preview of the files. */
export function SetupOffer({ source, version, onSetUp, onClose, onDontAsk }: SetupOfferProps) {
  const [expanded, setExpanded] = useState(source === 'menu')
  const [plan, setPlan] = useState<SetupPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!expanded) return
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
  }, [expanded, version])

  const missing = plan ? plan.items.filter((item) => !item.exists).length : null
  const nothingToAdd = expanded && missing === 0

  const setUp = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSetUp()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-offer" role="dialog" aria-label="Set up this folder for learning">
      <div className="setup-offer__head">
        <span className="setup-offer__icon">
          <GraduationCap size={16} strokeWidth={1.75} />
        </span>
        <div className="setup-offer__title">{source === 'menu' ? 'Set up this folder for learning' : 'Set up this folder for learning?'}</div>
        <button className="icon-button" aria-label="Close" title={source === 'menu' ? 'Cancel' : 'Not now'} onClick={onClose}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="setup-offer__body">
        {plan?.setUp && source === 'menu'
          ? 'This folder is set up. Setup adds only the items that are missing.'
          : 'Adds AGENTS.md, so Codex and Claude Code know how to keep a plan, notes about you, session logs and topic notes here.'}
      </div>

      {expanded && (
        <div className="setup-offer__preview">
          {error && <div className="setup-offer__error">{error}</div>}
          {!plan && !error && <div className="setup-offer__loading">Loading…</div>}
          {plan && (
            <ul className="setup-list">
              {plan.items.map((item) => (
                <li key={item.path} className={`setup-list__row${item.exists ? ' setup-list__row--kept' : ''}`}>
                  {item.kind === 'dir' ? <Folder size={13} strokeWidth={1.75} /> : <File size={13} strokeWidth={1.75} />}
                  <span className="setup-list__path mono">{item.kind === 'dir' ? `${item.path}/` : item.path}</span>
                  <span className="setup-list__note">{item.note}</span>
                  <span className={`setup-list__tag${item.exists ? '' : ' setup-list__tag--new'}`}>{item.exists ? 'kept' : 'new'}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="setup-offer__fine">Existing files are never changed. New folders get an empty .gitkeep.</div>
        </div>
      )}

      <div className="setup-offer__actions">
        {source === 'offer' && (
          <button className="button-ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <button className="button-ghost" onClick={onClose}>
          {source === 'menu' ? 'Cancel' : 'Not now'}
        </button>
        <button className="button-small-primary" disabled={busy || nothingToAdd || (expanded && !plan)} onClick={() => void setUp()}>
          {nothingToAdd ? 'Nothing to add' : busy ? 'Setting up…' : 'Set up'}
        </button>
      </div>
      {source === 'offer' && (
        <button className="setup-offer__dont-ask" onClick={onDontAsk}>
          Don’t ask for this folder
        </button>
      )}
    </div>
  )
}
