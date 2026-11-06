import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC, type SettingsChange, type SettingsSnapshot } from '@shared/space-api'
import { agentHomeDir } from './agent-home'
import { LOCAL_VOICES, LOCAL_VOICE_DOWNLOAD_MB, installLocalVoice, localVoiceState, onLocalVoiceState, removeLocalVoice } from './kokoro'
import * as store from './state'
import { PACES, VOICES, voiceSample, type PaceName } from './voice'

/**
 * The Settings panel's main side (decision U8): one snapshot of the voice
 * settings, the changes the panel makes, the local voice's install, a voice
 * sample and the Gemini key. Every change sends the snapshot again, also a
 * change from the View menu (settingsChanged) and the install's progress.
 *
 * The key goes into ~/.learning-space/.env (voice.ts reads it at each use).
 * It never goes back to the renderer, into a log, analytics or state.json:
 * the panel only hears whether one is saved.
 */

export interface SettingsHooks {
  /** Every invoke handler goes through index.ts handle (errors as plain messages). */
  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void
  send(channel: string, payload?: unknown): void
  /** View > Read Lines Aloud: index.ts saves it and updates the menu and the board. */
  setReadLines(on: boolean): void
  /** The View menu's Voice and Pace radio items follow a change from the panel. */
  menuChanged(): void
}

const KEY_LINE = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=.*$/m
const envPath = (): string => join(agentHomeDir(), '.env')

let hooks: SettingsHooks | null = null
let keySaved = false

async function readEnv(): Promise<string> {
  try {
    return await readFile(envPath(), 'utf8')
  } catch {
    return ''
  }
}

/** The file without its GEMINI_API_KEY lines, the other lines as they were. */
const withoutKey = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !KEY_LINE.test(line))
    .join('\n')

async function writeEnv(text: string): Promise<void> {
  await mkdir(agentHomeDir(), { recursive: true })
  await writeFile(envPath(), text, { mode: 0o600 })
  // An existing file keeps its mode on a write.
  await chmod(envPath(), 0o600)
}

async function refreshKeySaved(): Promise<void> {
  keySaved = KEY_LINE.test(await readEnv())
}

function snapshot(): SettingsSnapshot {
  const model = store.getVoiceModel()
  return {
    readLines: store.readLinesOn(),
    model,
    voice: model === 'local' ? store.getLocalVoice() : store.getVoice(),
    voices: model === 'local' ? [...LOCAL_VOICES] : [...VOICES],
    pace: store.getPace(),
    paces: (Object.keys(PACES) as PaceName[]).map((id) => ({ id, label: PACES[id].label })),
    local: localVoiceState(),
    localDownloadMb: LOCAL_VOICE_DOWNLOAD_MB,
    keySaved
  }
}

/** Send the snapshot to the panel: after any change of a voice setting. */
export function settingsChanged(): void {
  hooks?.send(IPC.settings, snapshot())
}

let sample: AbortController | null = null

export function registerSettings(given: SettingsHooks): void {
  hooks = given
  void refreshKeySaved().then(settingsChanged)
  onLocalVoiceState(() => settingsChanged())
  const { handle } = given

  handle(IPC.getSettings, async () => {
    await refreshKeySaved()
    return snapshot()
  })

  handle(IPC.setSettings, (change: SettingsChange) => {
    if (typeof change.readLines === 'boolean') given.setReadLines(change.readLines)
    if (change.model === 'cloud') store.setVoiceModel('cloud')
    // The local voice is chosen only once it is on this Mac.
    if (change.model === 'local' && localVoiceState().state === 'installed') store.setVoiceModel('local')
    if (typeof change.voice === 'string') {
      if (store.getVoiceModel() === 'local') {
        if (LOCAL_VOICES.includes(change.voice)) store.setLocalVoice(change.voice)
      } else if ((VOICES as readonly string[]).includes(change.voice)) store.setVoice(change.voice)
    }
    if (typeof change.pace === 'string' && change.pace in PACES) store.setPace(change.pace as PaceName)
    given.menuChanged()
    settingsChanged()
  })

  handle(IPC.installLocalVoice, async () => {
    await installLocalVoice()
    settingsChanged()
  })

  handle(IPC.removeLocalVoice, async () => {
    if (store.getVoiceModel() === 'local') store.setVoiceModel('cloud')
    await removeLocalVoice()
    settingsChanged()
  })

  // One sample at a time: a new one stops the last.
  handle(IPC.playVoiceSample, async () => {
    sample?.abort()
    const controller = new AbortController()
    sample = controller
    const timer = setTimeout(() => controller.abort(), 45_000)
    try {
      return new Uint8Array(await voiceSample(controller.signal))
    } finally {
      clearTimeout(timer)
      if (sample === controller) sample = null
    }
  })

  handle(IPC.saveGeminiKey, async (key: unknown) => {
    const value = typeof key === 'string' ? key.trim() : ''
    if (!value) throw new Error('Paste a key first.')
    if (/[\s'"#]/.test(value)) throw new Error('This does not look like a Gemini key.')
    const rest = withoutKey(await readEnv()).replace(/\n*$/, '')
    await writeEnv(`${rest ? `${rest}\n` : ''}GEMINI_API_KEY=${value}\n`)
    await refreshKeySaved()
    settingsChanged()
  })

  handle(IPC.removeGeminiKey, async () => {
    const text = await readEnv()
    if (KEY_LINE.test(text)) await writeEnv(withoutKey(text))
    await refreshKeySaved()
    settingsChanged()
  })
}
