import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Play } from 'lucide-react'
import type { SettingsSnapshot } from '@shared/space-api'
import { errorMessage } from '../../lib/errors'
import { changeSettings } from '../../lib/settings'
import { tip } from '../Tooltip'
import { SettingRow } from './parts'

const space = window.space

function ErrorLine({ text, fix }: { text: string; fix?: { label: string; run(): void } }) {
  return (
    <div className="menu__line menu__line--error">
      <AlertCircle size={12} strokeWidth={2} />
      <span className="menu__line-text">{text}</span>
      {fix && (
        <button className="menu__fix" onClick={fix.run}>
          {fix.label}
        </button>
      )}
    </div>
  )
}

/**
 * Settings > Voice (decision U8, in the dialog of U12): Read lines aloud, the voice model (the cloud voice, or Kokoro
 * on this Mac with its install), the voice with a sample, the pace, and the learner's own Gemini key. Main owns every
 * value (main/settings.ts); the key goes to main only, and the section hears only whether one is saved.
 */
export function VoiceSection({ voice }: { voice: SettingsSnapshot['voice'] }) {
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [sampleError, setSampleError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** False once the section closed: a sample that arrives later does not play. */
  const liveRef = useRef(true)

  // A sample stops when the section closes (another section, or the dialog closes), also one still loading.
  useEffect(() => {
    // StrictMode runs the effect twice in dev: the second run makes the section live again.
    liveRef.current = true
    return () => {
      liveRef.current = false
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        URL.revokeObjectURL(audio.src)
      }
    }
  }, [])

  const playSample = async (): Promise<void> => {
    if (sampleState === 'loading') return
    audioRef.current?.pause()
    setSampleError(null)
    setSampleState('loading')
    try {
      const bytes = await space.playVoiceSample()
      if (!liveRef.current) return
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }))
      const audio = new Audio(url)
      if (audioRef.current) URL.revokeObjectURL(audioRef.current.src)
      audioRef.current = audio
      audio.onended = () => setSampleState('idle')
      setSampleState('playing')
      await audio.play()
    } catch (error) {
      if (!liveRef.current) return
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

  const { local } = voice
  let localControl: ReactNode = null
  if (local.state === 'absent')
    localControl = (
      <button
        className="btn-sm"
        onClick={(event) => {
          // The row is the model choice: the button installs only.
          event.stopPropagation()
          install()
        }}
      >
        Install · {voice.localDownloadMb} MB
      </button>
    )
  else if (local.state === 'installing') {
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
  } else if (local.state === 'installed')
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

  return (
    <>
      <SettingRow name="Read lines aloud" description="A scene's lines are spoken as it plays">
        <button className="menu__switch" role="switch" aria-checked={voice.readLines} aria-label="Read lines aloud" onClick={() => changeSettings({ readLines: !voice.readLines })} />
      </SettingRow>
      <div className="menu__settings" role="radiogroup" aria-label="Voice model">
        <SettingRow name="Cloud voice" description="Free, with a daily limit" choice={{ chosen: voice.model === 'cloud', enabled: true, onChoose: () => changeSettings({ model: 'cloud' }) }} />
        <SettingRow
          name="On this Mac · Kokoro"
          description="No limit, works offline"
          choice={{ chosen: voice.model === 'local', enabled: local.state === 'installed', onChoose: () => changeSettings({ model: 'local' }) }}
          lines={local.state === 'failed' && <ErrorLine text={local.error} fix={{ label: 'Retry', run: install }} />}
        >
          {localControl}
        </SettingRow>
      </div>
      <SettingRow name="Voice" description="The voice that reads the lines" lines={sampleError && <ErrorLine text={sampleError} />}>
        <select className="menu__select" aria-label="Voice" value={voice.voice} onChange={(event) => changeSettings({ voice: event.target.value })}>
          {voice.voices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button className="icon-button" {...tip('Play a sample')} aria-label="Play a sample" onClick={() => void playSample()}>
          {sampleState === 'loading' ? <Loader2 className="menu__spinner" size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
        </button>
      </SettingRow>
      <SettingRow name="Pace" description="How fast the lines are read">
        <select className="menu__select" aria-label="Pace" value={voice.pace} onChange={(event) => changeSettings({ pace: event.target.value })}>
          {voice.paces.map((pace) => (
            <option key={pace.id} value={pace.id}>
              {pace.label}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow name="Gemini key" description="Optional: your own key removes the daily limit" lines={keyError && <ErrorLine text={keyError} />}>
        {voice.keySaved ? (
          <>
            <span className="menu__status">
              <CheckCircle2 size={12} strokeWidth={2} />
              Key saved
            </span>
            <button className="btn-text" onClick={removeKey}>
              Remove
            </button>
          </>
        ) : (
          <form
            className="menu__control"
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
      </SettingRow>
    </>
  )
}
