import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { agentHomeDir } from './agent-home'

/**
 * The local voice (decision D9; docs/learning-space/decisions.md T40): Kokoro on the learner's Mac.
 *
 * The app is MIT, and espeak-ng (which Kokoro uses for words outside its word list, numbers among
 * them) is GPL-3.0. So nothing of it is in the app: on Install the app downloads sherpa-onnx's
 * prebuilt command-line program and the Kokoro model from sherpa-onnx's own GitHub releases into
 * ~/.learning-space/models/kokoro/<VERSION>/, and runs the program as a separate process with
 * command-line arguments. It reads the WAV that the program writes. It never links or loads it.
 *
 * sherpa-onnx stays on 1.13.x: since 2.0 it no longer uses espeak-ng and skips every word that is
 * not in the word list, "42" and "3.14" too (spike, 2026-11-06).
 *
 * An install is a temp folder that is renamed into place when it is complete and checked, so a half
 * download is never installed. The archives are checked against the SHA-256 sums below.
 */

export type LocalVoiceState =
  | { state: 'absent' }
  | { state: 'installing'; progress: number } // 0..1
  | { state: 'installed' }
  | { state: 'failed'; error: string } // one short line for the learner

interface Archive {
  url: string
  bytes: number
  sha256: string
  /** The archive's members to keep, and where they go in the install folder (tar --strip-components 1). */
  members: string[]
  into: string
}

const SHERPA = 'v1.13.8'
const PROGRAM: Record<'arm64' | 'x64', Omit<Archive, 'members' | 'into'> & { folder: string }> = {
  arm64: {
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA}/sherpa-onnx-${SHERPA}-osx-arm64-shared.tar.bz2`,
    bytes: 20_314_448,
    sha256: 'b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56',
    folder: `sherpa-onnx-${SHERPA}-osx-arm64-shared`
  },
  x64: {
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA}/sherpa-onnx-${SHERPA}-osx-x64-shared.tar.bz2`,
    bytes: 22_846_038,
    sha256: '54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40',
    folder: `sherpa-onnx-${SHERPA}-osx-x64-shared`
  }
}
const program = PROGRAM[process.arch === 'x64' ? 'x64' : 'arm64']

/**
 * Kokoro v1.0 in full precision. The int8 package (132 MB) is smaller, but on the M1 Air it made
 * 8.8 s of speech in 10 to 11 s, slower than the speech; this one makes it in 5.6 to 7.2 s.
 */
const MODEL_FOLDER = 'kokoro-multi-lang-v1_0'
const MODEL: Archive = {
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL_FOLDER}.tar.bz2`,
  bytes: 349_886_476,
  sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
  members: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'espeak-ng-data', 'LICENSE'].map((name) => `${MODEL_FOLDER}/${name}`),
  into: 'model'
}
const ARCHIVES: Archive[] = [{ ...program, members: [`${program.folder}/bin/sherpa-onnx-offline-tts`, `${program.folder}/lib/libonnxruntime.dylib`], into: '.' }, MODEL]

/** A new pin gives a new folder; an install removes the folders of older pins. */
const VERSION = `sherpa-${SHERPA}-${MODEL_FOLDER}`

/** The model in voice.ts's clip key: a new pin makes new clips. */
export const LOCAL_MODEL = `kokoro ${VERSION}`

export const LOCAL_VOICE_DOWNLOAD_MB: number = Math.round(ARCHIVES.reduce((sum, archive) => sum + archive.bytes, 0) / 1_000_000)

/** The model's speakers in sid order (its speaker_names metadata). */
const SPEAKERS = 'af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis'.split(',')

/** The English voices (American a*, British b*), af_heart first. */
export const LOCAL_VOICES: readonly string[] = ['af_heart', ...SPEAKERS.filter((name) => name !== 'af_heart')]

/**
 * The pause after punctuation, as a share of the model's own. At the default 0.2 a sentence end was
 * 0.16 s, too short for voice.ts to find the lines; at 0.5 it is about 0.4 s and a comma about 0.15 s.
 */
const SILENCE_SCALE = 0.5

/** Three threads were the fastest on the M1 Air (four and six were slower, the cores are shared with the app). */
const THREADS = 3

const kokoroDir = (): string => join(agentHomeDir(), 'models', 'kokoro')
const installDir = (): string => join(kokoroDir(), VERSION)
/** Written last, before the rename: an install folder without it is not an install. */
const MARKER = 'installed.json'

// ---------- State ----------

let current: LocalVoiceState | null = null
const listeners = new Set<(state: LocalVoiceState) => void>()

export function localVoiceState(): LocalVoiceState {
  current ??= existsSync(join(installDir(), MARKER)) ? { state: 'installed' } : { state: 'absent' }
  return current
}

function setState(next: LocalVoiceState): void {
  current = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch (error) {
      console.error(`local voice: a state listener failed: ${String(error)}`)
    }
  }
}

export function onLocalVoiceState(listener: (state: LocalVoiceState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------- Install ----------

/** A failure with the line the learner reads. */
class InstallFailed extends Error {}

let installing: { promise: Promise<void>; abort: AbortController } | null = null

export function installLocalVoice(): Promise<void> {
  if (installing) return installing.promise
  if (localVoiceState().state === 'installed') return Promise.resolve()
  const abort = new AbortController()
  const promise = install(abort.signal).finally(() => {
    installing = null
  })
  installing = { promise, abort }
  return promise
}

async function install(signal: AbortSignal): Promise<void> {
  setState({ state: 'installing', progress: 0 })
  const temp = join(kokoroDir(), `.${VERSION}.${randomUUID()}.tmp`)
  try {
    await mkdir(temp, { recursive: true })
    const total = ARCHIVES.reduce((sum, archive) => sum + archive.bytes, 0)
    let done = 0
    let shown = -1
    for (const archive of ARCHIVES) {
      const file = join(temp, `download-${randomUUID()}.tar.bz2`)
      await download(archive, file, signal, (bytes) => {
        // About 200 updates for the whole download: enough for a smooth bar, few IPC messages.
        const progress = Math.min(0.99, (done + bytes) / total)
        if (Math.floor(progress * 200) === shown) return
        shown = Math.floor(progress * 200)
        setState({ state: 'installing', progress })
      })
      done += archive.bytes
      const into = join(temp, archive.into)
      await mkdir(into, { recursive: true })
      await run('/usr/bin/tar', ['-xjf', file, '-C', into, '--strip-components', '1', ...archive.members], signal).catch(() => {
        throw new InstallFailed('The voice files could not be unpacked. Try again.')
      })
      await rm(file, { force: true })
    }
    await checkProgram(temp, signal)
    await writeFile(join(temp, MARKER), `${JSON.stringify({ version: VERSION, at: new Date().toISOString() })}\n`)
    await rm(installDir(), { recursive: true, force: true })
    await rename(temp, installDir())
    await removeOtherVersions()
    setState({ state: 'installed' })
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    if (signal.aborted) {
      setState({ state: 'absent' })
      return
    }
    console.error(`local voice: install failed: ${error instanceof Error ? error.message : String(error)}`)
    setState({ state: 'failed', error: learnerLine(error) })
  }
}

function learnerLine(error: unknown): string {
  if (error instanceof InstallFailed) return error.message
  const code = (error as { code?: string }).code
  if (code === 'ENOSPC') return `Not enough disk space: the voice needs about ${Math.round(LOCAL_VOICE_DOWNLOAD_MB * 1.1)} MB.`
  return 'The voice could not be installed. Try again.'
}

/** One archive to file, with its SHA-256 checked. progress: the bytes of this archive so far. */
async function download(archive: Archive, file: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  let response: Response
  try {
    response = await fetch(archive.url, { signal, redirect: 'follow' })
  } catch (error) {
    if (signal.aborted) throw error
    throw new InstallFailed('The download failed. Check the internet connection and try again.')
  }
  if (!response.ok || !response.body) throw new InstallFailed(`The download failed (${response.status}). Try again later.`)
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  // A write error (ENOSPC among them) is the disk's, not the network's: learnerLine reads its code.
  let writeError: Error | null = null
  out.once('error', (error) => {
    writeError = error
  })
  let bytes = 0
  try {
    // pipeline ends on the first error of either side or on the signal, and closes both.
    await pipeline(
      response.body as unknown as AsyncIterable<Uint8Array>,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          bytes += chunk.length
          // More than the pinned size is never the pinned archive: stop at once.
          if (bytes > archive.bytes) throw new InstallFailed('The download was damaged. Try again.')
          hash.update(chunk)
          progress(bytes)
          yield chunk
        }
      },
      out,
      { signal }
    )
  } catch (error) {
    if (signal.aborted) throw error
    if (writeError) throw writeError
    if (error instanceof InstallFailed) throw error
    throw new InstallFailed('The download stopped. Check the internet connection and try again.')
  }
  if (bytes !== archive.bytes || hash.digest('hex') !== archive.sha256) throw new InstallFailed('The download was damaged. Try again.')
}

/** The program must run on this Mac and make speech before the install counts. */
async function checkProgram(folder: string, signal: AbortSignal): Promise<void> {
  try {
    const wav = await synthesize(folder, 'Hello.', 'af_heart', 1, signal)
    if (wav.length < 1000) throw new Error('no audio')
  } catch (error) {
    if (signal.aborted) throw error
    throw new InstallFailed('The voice program does not run on this Mac.')
  }
}

async function removeOtherVersions(): Promise<void> {
  for (const name of await readdir(kokoroDir()).catch(() => [] as string[])) {
    if (name !== VERSION) await rm(join(kokoroDir(), name), { recursive: true, force: true }).catch(() => {})
  }
}

export async function removeLocalVoice(): Promise<void> {
  if (installing) {
    installing.abort.abort()
    await installing.promise.catch(() => {})
  }
  await rm(kokoroDir(), { recursive: true, force: true }).catch(() => {})
  setState({ state: 'absent' })
}

// ---------- Speech ----------

/** A child process with arguments; stderr's last lines in the error. signal kills it. */
function run(command: string, args: string[], signal: AbortSignal, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf8')).slice(-2000)
    })
    const kill = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', kill)
      reject(error)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (signal.aborted) reject(signal.reason)
      else if (code === 0) resolve()
      else reject(new Error(`${command.split('/').pop()} exited with ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`))
    })
  })
}

/** One program run: text in, a 16-bit PCM WAV (mono, 24 kHz) out. */
async function synthesize(folder: string, text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer> {
  const sid = SPEAKERS.indexOf(voice)
  const british = voice.startsWith('b')
  const model = join(folder, 'model')
  const out = join(folder, `speech-${randomUUID()}.wav`)
  try {
    await run(
      join(folder, 'bin', 'sherpa-onnx-offline-tts'),
      [
        `--kokoro-model=${join(model, 'model.onnx')}`,
        `--kokoro-voices=${join(model, 'voices.bin')}`,
        `--kokoro-tokens=${join(model, 'tokens.txt')}`,
        `--kokoro-data-dir=${join(model, 'espeak-ng-data')}`,
        `--kokoro-lexicon=${join(model, british ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt')}`,
        `--kokoro-lang=${british ? 'en-gb' : 'en-us'}`,
        `--kokoro-length-scale=${(1 / Math.min(2, Math.max(0.5, speed))).toFixed(3)}`,
        `--tts-silence-scale=${SILENCE_SCALE}`,
        `--num-threads=${THREADS}`,
        `--sid=${sid < 0 ? SPEAKERS.indexOf('af_heart') : sid}`,
        `--output-filename=${out}`,
        // The program reads an argument that starts with "--" as an option.
        text.replace(/^\s*-+/, ' ')
      ],
      signal,
      folder
    )
    return await readFile(out)
  } finally {
    await rm(out, { force: true }).catch(() => {})
  }
}

/** One run at a time: a run takes about 550 MB and three cores. */
let queue: Promise<unknown> = Promise.resolve()

/** A 16-bit PCM WAV of text. Throws when the voice is not installed, the program fails or signal aborts. */
export function speakLocal(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer> {
  const turn = queue.then(() => {
    if (signal.aborted) throw signal.reason
    if (localVoiceState().state !== 'installed') throw new Error('the local voice is not installed')
    return synthesize(installDir(), text, voice, speed, signal)
  })
  queue = turn.catch(() => {})
  return turn
}
