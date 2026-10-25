import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Speech for live scenes (say()). The renderer speaks the lines with the
 * system voice (Web Speech API); here the main process measures how long each
 * line takes with the same voice (macOS `say` into a WAV file), so a scene's
 * timeline holds the real speech time. Off unless SPACE_SPEECH=1 (no UI yet);
 * when off, the sandbox estimates the time and nothing is spoken.
 */

/** Voices to prefer, best first; the first one installed is used. SPACE_VOICE overrides. */
const PREFERRED = ['Ava (Premium)', 'Zoe (Premium)', 'Evan (Premium)', 'Ava (Enhanced)', 'Zoe (Enhanced)', 'Evan (Enhanced)', 'Samantha (Enhanced)', 'Samantha', 'Daniel', 'Karen', 'Alex']

export function speechOn(): boolean {
  return process.env.SPACE_SPEECH === '1' && process.platform === 'darwin'
}

let voicePromise: Promise<string | null> | null = null

function run(file: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

/** A voice name that `say -v` can only read as a voice name (no leading dash, plain characters). */
const SAFE_VOICE = /^[A-Za-z0-9()._][A-Za-z0-9 ()._-]*$/

/** The voice name used for measuring and speaking (the renderer picks the voice with this name); only an installed one. */
export function speechVoice(): Promise<string | null> {
  voicePromise ??= (async () => {
    try {
      const list = await run('/usr/bin/say', ['-v', '?'])
      const names = list
        .split('\n')
        .map((line) => /^(.+?)\s{2,}(\w\w[_-]\w+)/.exec(line))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ name: m[1].trim(), lang: m[2] }))
      const installed = names.filter((v) => SAFE_VOICE.test(v.name))
      // SPACE_VOICE picks a voice, but only one that is installed.
      const asked = process.env.SPACE_VOICE
      if (asked && installed.some((v) => v.name === asked)) return asked
      for (const want of PREFERRED) if (installed.some((v) => v.name === want)) return want
      return installed.find((v) => v.lang.startsWith('en'))?.name ?? null
    } catch {
      return null
    }
  })()
  return voicePromise
}

const cache = new Map<string, number>()

/** The duration of a WAV file's audio, in seconds. */
function wavSeconds(data: Buffer): number | null {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = data.readUInt32LE(offset + 16)
    if (id === 'data') return byteRate ? Math.min(size, data.length - offset - 8) / byteRate : null
    offset += 8 + size + (size % 2)
  }
  return null
}

async function measureOne(text: string, voice: string, dir: string, index: number): Promise<number | null> {
  const file = join(dir, `line-${index}.wav`)
  // The text goes through a file, never as an argument (a line that starts with "-" must not read as an option).
  const input = join(dir, `line-${index}.txt`)
  try {
    if (!SAFE_VOICE.test(voice)) return null
    await writeFile(input, text, { encoding: 'utf8', mode: 0o600 })
    await run('/usr/bin/say', ['-v', voice, '-o', file, '--data-format=LEI16@22050', '-f', input])
    const seconds = wavSeconds(await readFile(file))
    return seconds && Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null
  } catch {
    return null
  }
}

/**
 * The window's voice (Web Speech, player.ts) takes longer per line than the WAV
 * `say` renders: 0.11 to 0.12 s more per line (start of the utterance and its end
 * event; measured 2026-10-25 in Electron on macOS). Without it, queued lines
 * fall behind the timeline by that much per line.
 */
const SPEAK_TAIL_S = 0.15

/** Real speech durations for these lines (all at once); lines that could not be measured are left out. */
export async function measureSpeech(texts: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const voice = await speechVoice()
  if (!voice) return out
  const missing = [...new Set(texts)].filter((text) => !cache.has(`${voice}\n${text}`))
  if (missing.length) {
    const dir = await mkdtemp(join(tmpdir(), 'ls-speech-'))
    try {
      const results = await Promise.all(missing.map((text, i) => measureOne(text, voice, dir, i)))
      missing.forEach((text, i) => {
        const seconds = results[i]
        if (seconds !== null) cache.set(`${voice}\n${text}`, seconds + SPEAK_TAIL_S)
      })
    } finally {
      void rm(dir, { recursive: true, force: true })
    }
  }
  for (const text of texts) {
    const seconds = cache.get(`${voice}\n${text}`)
    if (seconds !== undefined) out[text] = seconds
  }
  return out
}
