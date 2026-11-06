import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, CheckCircle2, Loader2, Play } from 'lucide-react'
import type { SettingsChange, SettingsSnapshot } from '@shared/space-api'
import { markFocus, returnFocus } from '../lib/focus'
import { errorMessage } from '../lib/errors'
import { tip } from './Tooltip'

const space = window.space

/**
 * The Settings panel (decision U8): a simple first panel, which the founder redesigns later. A modal
 * `.menu--panel` over a `.backdrop`, as the search panel, opened from Settings… (⌘,) and from the
 * daily-limit notice. Main owns every value (main/settings.ts); the panel shows its snapshot and sends changes.
 * The Gemini key goes to main only; the panel hears only whether one is saved.
 */
export function SettingsPanel({ onClose }: { onClose(): void }) {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [sampleError, setSampleError] = useState<string | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [opener] = useState(markFocus)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let live = true
    void space.getSettings().then((value) => {
      if (live) setSettings(value)
    })
    const off = space.onSettings(setSettings)
    return () => {
      live = false
      off()
    }
  }, [])

  // Open: an open menu or popover closes, then the panel takes the focus. Close: the focus goes back as it was.
  useLayoutEffect(() => {
    backdropRef.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    panelRef.current?.focus({ preventScroll: true })
    return () => returnFocus(opener)
  }, [opener])

  // While open, no key reaches the board, the tools or the sidebar: a key outside the panel goes back to it.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (panelRef.current?.contains(event.target as Node)) return
      event.stopPropagation()
      if (!event.metaKey && !event.ctrlKey) event.preventDefault()
      if (event.key === 'Escape') onCloseRef.current()
      else panelRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  // A sample stops when the panel closes.
  useEffect(
    () => () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        URL.revokeObjectURL(audio.src)
      }
    },
    []
  )

  const change = (value: SettingsChange): void => {
    void space.setSettings(value).catch((error: unknown) => console.error(`settings: ${errorMessage(error)}`))
  }

  const playSample = async (): Promise<void> => {
    if (sampleState === 'loading') return
    audioRef.current?.pause()
    setSampleError(null)
    setSampleState('loading')
    try {
      const bytes = await space.playVoiceSample()
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }))
      const audio = new Audio(url)
      if (audioRef.current) URL.revokeObjectURL(audioRef.current.src)
      audioRef.current = audio
      audio.onended = () => setSampleState('idle')
      setSampleState('playing')
      await audio.play()
    } catch (error) {
      setSampleState('idle')
      setSampleError(errorMessage(error))
    }
  }

  const saveKey = async (): Promise<void> => {
    setKeyError(null)
    try {
      await space.saveGeminiKey(key)
      setKey('')
    } catch (error) {
      setKeyError(errorMessage(error))
    }
  }

  const removeKey = (): void => {
    setKeyError(null)
    space.removeGeminiKey().catch((error: unknown) => setKeyError(errorMessage(error)))
  }

  const install = (): void => {
    space.installLocalVoice().catch((error: unknown) => console.error(`local voice: ${errorMessage(error)}`))
  }

  const local = settings?.local ?? { state: 'absent' as const }
  const localReady = local.state === 'installed'

  let localControl: ReactNode = null
  if (settings) {
    if (local.state === 'absent') {
      localControl = (
        <button
          className="btn-sm"
          onClick={(event) => {
            event.stopPropagation()
            install()
          }}
        >
          Install · {settings.localDownloadMb} MB
        </button>
      )
    } else if (local.state === 'installing') {
      const percent = Math.round(Math.max(0, Math.min(1, local.progress)) * 100)
      localControl = (
        <>
          <span className="menu__progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span className="menu__progress-bar" style={{ width: `${percent}%` }} />
          </span>
          {/* The last part (unpack and a test run) takes about 15 s after the download reaches 99%. */}
          <span className="menu__meta menu__meta--mono">{percent >= 99 ? 'Preparing…' : `${percent}%`}</span>
        </>
      )
    } else if (local.state === 'installed') {
      localControl = (
        <>
          <span className="menu__meta">Installed</span>
          <button
            className="btn-text"
            onClick={(event) => {
              event.stopPropagation()
              space.removeLocalVoice().catch((error: unknown) => console.error(`local voice: ${errorMessage(error)}`))
            }}
          >
            Remove
          </button>
        </>
      )
    }
  }

  const modelRow = (model: 'cloud' | 'local', label: string, control: ReactNode, enabled: boolean): ReactNode => {
    const chosen = settings?.model === model
    return (
      <div
        className={chosen ? 'menu__item menu__item--current settings-panel__choice' : 'menu__item settings-panel__choice'}
        role="radio"
        aria-checked={chosen}
        aria-disabled={!enabled}
        tabIndex={enabled ? 0 : -1}
        onClick={() => enabled && !chosen && change({ model })}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
            event.preventDefault()
            if (enabled && !chosen) change({ model })
          }
        }}
      >
        <span className="menu__label">{label}</span>
        {control}
        <span className="menu__icon">{chosen && <Check size={14} strokeWidth={2} />}</span>
      </div>
    )
  }

  return createPortal(
    <div
      ref={backdropRef}
      className="backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="menu menu--panel settings-panel"
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(event) => {
          // No key in the panel reaches the board (its tool keys); Escape closes.
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      >
        <div className="menu__scroll">
          <div className="menu__heading">Voice</div>
          <div className="menu__row">
            <span className="menu__name">Read lines aloud</span>
            <span className="menu__control">
              <button
                className="menu__switch"
                role="switch"
                aria-checked={settings?.readLines ?? false}
                aria-label="Read lines aloud"
                disabled={!settings}
                onClick={() => settings && change({ readLines: !settings.readLines })}
              />
            </span>
          </div>
          <div className="menu__separator" />
          <div role="radiogroup" aria-label="Voice model">
            {modelRow('cloud', 'Cloud voice', <span className="menu__meta">Free, a daily limit</span>, true)}
            {modelRow('local', 'On this Mac · Kokoro', localControl, localReady)}
          </div>
          {local.state === 'failed' && (
            <div className="menu__line menu__line--error">
              <AlertCircle size={12} strokeWidth={2} />
              <span className="menu__line-text">
                {local.error}
              </span>
              <button className="menu__fix" onClick={install}>
                Retry
              </button>
            </div>
          )}
          <div className="menu__separator" />
          <div className="menu__row">
            <span className="menu__name">Voice</span>
            <span className="menu__control">
              <select className="menu__select" aria-label="Voice" value={settings?.voice ?? ''} disabled={!settings} onChange={(event) => change({ voice: event.target.value })}>
                {settings?.voices.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
              <button className="icon-button" {...tip('Play a sample')} aria-label="Play a sample" disabled={!settings} onClick={() => void playSample()}>
                {sampleState === 'loading' ? <Loader2 className="menu__spinner" size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
              </button>
            </span>
          </div>
          {sampleError && (
            <div className="menu__line menu__line--error">
              <AlertCircle size={12} strokeWidth={2} />
              <span className="menu__line-text">
                {sampleError}
              </span>
            </div>
          )}
          <div className="menu__row">
            <span className="menu__name">Pace</span>
            <span className="menu__control">
              <select className="menu__select" aria-label="Pace" value={settings?.pace ?? ''} disabled={!settings} onChange={(event) => change({ pace: event.target.value })}>
                {settings?.paces.map((pace) => (
                  <option key={pace.id} value={pace.id}>
                    {pace.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="menu__separator" />
          <div className="menu__heading">Gemini key</div>
          {settings?.keySaved ? (
            <div className="menu__row">
              <span className="menu__status">
                <CheckCircle2 size={12} strokeWidth={2} />
                Key saved
              </span>
              <button className="btn-text" onClick={removeKey}>
                Remove
              </button>
            </div>
          ) : (
            <form
              className="menu__row"
              onSubmit={(event) => {
                event.preventDefault()
                void saveKey()
              }}
            >
              <input
                className="menu__text"
                type="password"
                value={key}
                placeholder="Your Gemini API key"
                aria-label="Gemini API key"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  // Enter saves also when the key arrives without a form submit (an IME composition keeps its Enter).
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  if (key.trim()) void saveKey()
                }}
              />
              <button className="btn-sm" type="submit" disabled={!key.trim()}>
                Save
              </button>
            </form>
          )}
          {keyError && (
            <div className="menu__line menu__line--error">
              <AlertCircle size={12} strokeWidth={2} />
              <span className="menu__line-text">{keyError}</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
