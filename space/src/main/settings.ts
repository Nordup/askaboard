import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { IPC, type InterfaceSizeSetting, type SettingsChange, type SettingsSnapshot } from '@shared/space-api'
import { INTERFACE_SIZES, stepSize } from './interface-size'
import { LOCAL_VOICES, LOCAL_VOICE_DOWNLOAD_MB, installLocalVoice, localVoiceState, onLocalVoiceState, removeLocalVoice } from './kokoro'
import * as store from './state'
import { playVoiceSample } from './voice'
import { PACES, VOICES, type PaceName } from './voice-choices'
import { removeVoiceKey, saveVoiceKey, voiceKeySaved } from './voice-key'

/**
 * The one owner of the user settings (decision U12): General (Interface Size, Show performance) and Voice (Read lines
 * aloud, the voice model, voice, pace, the Gemini key). It reads and writes them (state.json through state.ts), builds
 * the one SettingsSnapshot, and is the only path for a change: the Settings dialog (setSettings) and the View menu
 * (menu.ts calls changeSettings) go through changeSettings. After a change the menu is built again from the snapshot
 * and the snapshot goes to the renderer, which shows it in the dialog, the top bar and the board's voice.
 *
 * Voice work lives in the voice modules and is only called from here: kokoro.ts (the local voice's install), voice.ts
 * (the sample), voice-key.ts (the Gemini key file). Folder and agent actions are not settings: the dialog runs them
 * through their own IPC (the folder session, connect.ts).
 */

export interface SettingsHooks {
  /** Every invoke handler goes through index.ts handle (errors as plain messages). */
  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void
  send(channel: string, payload?: unknown): void
  /** Build the app menu again (index.ts buildMenu, which reads settingsSnapshot). */
  rebuildMenu(): void
  /** The main window's page zoom follows Interface Size (index.ts applyInterfaceSize). */
  applyInterfaceSize(): void
  /** The factor of 'auto' for the main window's display. */
  automaticSize(): number
}

let hooks: SettingsHooks | null = null
let keySaved = false
let license: string | null | undefined

/** package.json's license, read once (app.getAppPath() holds package.json in dev and in the packaged app). */
function appLicense(): string | null {
  if (license !== undefined) return license
  try {
    const value = (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { license?: unknown }).license
    license = typeof value === 'string' && value ? value : null
  } catch {
    license = null
  }
  return license
}

export function settingsSnapshot(): SettingsSnapshot {
  const model = store.getVoiceModel()
  return {
    general: {
      interfaceSize: store.getInterfaceSize(),
      interfaceSizes: [...INTERFACE_SIZES],
      automaticSize: hooks?.automaticSize() ?? 1,
      showPerformance: store.getShowPerformance()
    },
    voice: {
      readLines: store.readLinesOn(),
      model,
      voice: model === 'local' ? store.getLocalVoice() : store.getVoice(),
      voices: model === 'local' ? [...LOCAL_VOICES] : [...VOICES],
      pace: store.getPace(),
      paces: (Object.keys(PACES) as PaceName[]).map((id) => ({ id, label: PACES[id].label })),
      local: localVoiceState(),
      localDownloadMb: LOCAL_VOICE_DOWNLOAD_MB,
      keySaved
    },
    about: { name: app.name, version: app.getVersion(), license: appLicense() }
  }
}

/** Send the snapshot to the renderer (the local voice's progress: nothing in the menu changes). */
function push(): void {
  hooks?.send(IPC.settings, settingsSnapshot())
}

/** A setting or what the snapshot shows changed: the menu is built again from it, and the renderer hears it. */
export function settingsChanged(): void {
  hooks?.rebuildMenu()
  push()
}

const isInterfaceSize = (value: unknown): value is InterfaceSizeSetting => value === 'auto' || (INTERFACE_SIZES as readonly unknown[]).includes(value)

/** The one change path for every setting, from the dialog and from the menu. Values that are not valid are left out. */
export function changeSettings(change: SettingsChange): void {
  const sizeBefore = store.getInterfaceSize()
  if (isInterfaceSize(change.interfaceSize) && change.interfaceSize !== sizeBefore) store.setInterfaceSize(change.interfaceSize)
  if (typeof change.showPerformance === 'boolean' && change.showPerformance !== store.getShowPerformance()) store.setShowPerformance(change.showPerformance)
  if (typeof change.readLines === 'boolean' && change.readLines !== store.readLinesOn()) store.setReadLines(change.readLines)
  if (change.model === 'cloud') store.setVoiceModel('cloud')
  // The local voice is chosen only once it is on this Mac.
  if (change.model === 'local' && localVoiceState().state === 'installed') store.setVoiceModel('local')
  if (typeof change.voice === 'string') {
    if (store.getVoiceModel() === 'local') {
      if (LOCAL_VOICES.includes(change.voice)) store.setLocalVoice(change.voice)
    } else if ((VOICES as readonly string[]).includes(change.voice)) store.setVoice(change.voice)
  }
  if (typeof change.pace === 'string' && Object.hasOwn(PACES, change.pace)) store.setPace(change.pace as PaceName)
  settingsChanged()
  if (store.getInterfaceSize() !== sizeBefore) hooks?.applyInterfaceSize()
}

/** View > Interface Size > Larger / Smaller: the next size from the factor that shows now. */
export function stepInterfaceSize(direction: 1 | -1): void {
  const size = store.getInterfaceSize()
  changeSettings({ interfaceSize: stepSize(size === 'auto' ? (hooks?.automaticSize() ?? 1) : size, direction) })
}

async function refreshKeySaved(): Promise<void> {
  keySaved = await voiceKeySaved()
}

export function registerSettings(given: SettingsHooks): void {
  hooks = given
  void refreshKeySaved().then(push)
  onLocalVoiceState(push)
  const { handle } = given

  handle(IPC.getSettings, async () => {
    await refreshKeySaved()
    return settingsSnapshot()
  })

  handle(IPC.setSettings, (change: SettingsChange) => changeSettings(change ?? {}))

  handle(IPC.installLocalVoice, async () => {
    await installLocalVoice()
    push()
  })

  handle(IPC.removeLocalVoice, async () => {
    if (store.getVoiceModel() === 'local') changeSettings({ model: 'cloud' })
    await removeLocalVoice()
    push()
  })

  handle(IPC.playVoiceSample, playVoiceSample)

  handle(IPC.saveGeminiKey, async (key: unknown) => {
    await saveVoiceKey(key)
    await refreshKeySaved()
    push()
  })

  handle(IPC.removeGeminiKey, async () => {
    await removeVoiceKey()
    await refreshKeySaved()
    push()
  })
}
