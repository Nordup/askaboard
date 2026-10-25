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

/** A rendered line: its length, and where the voice is audible in it (s). */
interface LineAudio {
  seconds: number
  speechStart: number
  speechEnd: number
  /** Silent stretches inside the speech: [start, length] in seconds. */
  gaps: Array<[number, number]>
}

const audioCache = new Map<string, LineAudio>()

/** A 16-bit PCM WAV file: its length and where its samples rise above silence, in seconds. */
function wavAudio(data: Buffer): LineAudio | null {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let byteRate = 0
  let channels = 1
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = data.readUInt16LE(offset + 10) || 1
      byteRate = data.readUInt32LE(offset + 16)
    }
    if (id === 'data') {
      if (!byteRate) return null
      const from = offset + 8
      const bytes = Math.min(size, data.length - from)
      const frame = 2 * channels
      const frames = Math.floor(bytes / frame)
      // Audible: above about -34 dB of full scale.
      const LOUD = 650
      const perFrame = frame / byteRate
      let first = -1
      let last = -1
      let quiet = -1
      const gaps: Array<[number, number]> = []
      for (let i = 0; i < frames; i++) {
        if (Math.abs(data.readInt16LE(from + i * frame)) > LOUD) {
          if (first < 0) first = i
          // A silence of 0.15 s or more between sounds.
          if (quiet >= 0 && (i - quiet) * perFrame >= 0.15) gaps.push([quiet * perFrame, (i - quiet) * perFrame])
          quiet = -1
          last = i
        } else if (quiet < 0 && first >= 0) quiet = i
      }
      return { seconds: bytes / byteRate, speechStart: first < 0 ? 0 : first * perFrame, speechEnd: last < 0 ? 0 : (last + 1) * perFrame, gaps }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

async function renderOne(text: string, voice: string, dir: string, index: number): Promise<LineAudio | null> {
  const file = join(dir, `line-${index}.wav`)
  // The text goes through a file, never as an argument (a line that starts with "-" must not read as an option).
  const input = join(dir, `line-${index}.txt`)
  try {
    if (!SAFE_VOICE.test(voice)) return null
    await writeFile(input, text, { encoding: 'utf8', mode: 0o600 })
    await run('/usr/bin/say', ['-v', voice, '-o', file, '--data-format=LEI16@22050', '-f', input])
    const audio = wavAudio(await readFile(file))
    return audio && Number.isFinite(audio.seconds) && audio.seconds > 0 ? audio : null
  } catch {
    return null
  }
}

/** Render lines (each once per voice; cached). */
async function renderAll(texts: string[], voice: string): Promise<void> {
  const missing = [...new Set(texts)].filter((text) => text && !audioCache.has(`${voice}\n${text}`))
  if (!missing.length) return
  const dir = await mkdtemp(join(tmpdir(), 'ls-speech-'))
  try {
    const results = await Promise.all(missing.map((text, i) => renderOne(text, voice, dir, i)))
    missing.forEach((text, i) => {
      const audio = results[i]
      if (audio) audioCache.set(`${voice}\n${text}`, audio)
    })
  } finally {
    void rm(dir, { recursive: true, force: true })
  }
}

/** The gap between the end of the words before a mark and the start of the word after it (s), in the voice's own rendering. */
const WORD_GAP_S = 0.04
/**
 * A voice slows the word before a pause, so with the measuring silence the
 * word after a mark comes later than in the line as spoken. Measured
 * 2026-10-25 (Samantha, Web Speech in Electron): the voice reached the marks
 * 0.11 to 0.20 s (about 0.15 s) before the silence-based time plus the word gap.
 */
const PAUSE_LENGTHENING_S = 0.11
/** The silence put at each mark when measuring (ms); a pause this long is found again in the audio. */
const MARK_SILENCE_MS = 600

const WORDS = /[\p{L}\p{N}]/u
/** A mark with words before and after it (a mark at the start or the end of the line needs no measuring silence). */
const innerMark = (text: string, char: number): boolean => WORDS.test(text.slice(0, char)) && WORDS.test(text.slice(char))

/** The line as it is rendered to measure its marks: a silence at each mark inside it. */
export function markedLine(text: string, chars: number[]): string {
  let out = text
  for (const char of [...chars].filter((c) => innerMark(text, c)).sort((a, b) => b - a)) out = `${out.slice(0, char)}[[slnc ${MARK_SILENCE_MS}]] ${out.slice(char)}`
  return out
}

/**
 * A line's duration on the timeline and, for each mark (a character index in
 * text), when the word after it starts (s from the start of the line). One
 * render: the line with a silence at each mark inside it; the k longest
 * silences are those marks, and the line without them is the line as
 * spoken. A mark at the start is 0; a mark after the last word is the end of
 * the speech. When the silences are not found, the marks are placed by their
 * share of the characters within the measured speech.
 */
export async function measureMarks(text: string, chars: number[]): Promise<{ dur: number | null; offsets: Array<number | null> }> {
  const voice = await speechVoice()
  if (!voice) return { dur: null, offsets: chars.map(() => null) }
  const marked = markedLine(text, chars)
  await renderAll([marked], voice)
  const audio = audioCache.get(`${voice}\n${marked}`)
  if (!audio) return { dur: null, offsets: chars.map(() => null) }
  const r3 = (value: number): number => Math.round(value * 1000) / 1000
  const inner = chars.filter((char) => innerMark(text, char)).length
  const found = audio.gaps
    .filter(([, length]) => length >= (MARK_SILENCE_MS / 1000) * 0.8)
    .sort((x, y) => y[1] - x[1])
    .slice(0, inner)
    .sort((x, y) => x[0] - y[0])
  if (found.length !== inner) {
    // The silences are not where they should be: the inserted silence is taken off the measured length, and marks go by their share of the characters.
    const speech = audio.speechEnd - audio.speechStart - (inner * MARK_SILENCE_MS) / 1000
    return {
      dur: r3(audio.seconds - (inner * MARK_SILENCE_MS) / 1000 + SPEAK_TAIL_S),
      offsets: chars.map((char) => (WORDS.test(text.slice(0, char)) ? r3(audio.speechStart + (speech * char) / Math.max(1, text.length)) : 0))
    }
  }
  let extra = 0
  let k = 0
  const offsets = chars.map((char) => {
    if (!WORDS.test(text.slice(0, char))) return 0
    if (!WORDS.test(text.slice(char))) return r3(audio.speechEnd - extra)
    const [at, length] = found[k++]
    const offset = at - extra - PAUSE_LENGTHENING_S
    extra += length - WORD_GAP_S
    return r3(offset)
  })
  return { dur: r3(audio.seconds - extra + SPEAK_TAIL_S), offsets }
}

/** Render lines ahead of a program (its say() calls then find them measured). */
export async function prefetchSpeech(texts: string[]): Promise<void> {
  const voice = await speechVoice()
  if (voice) await renderAll(texts, voice)
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
  await renderAll(texts, voice)
  for (const text of texts) {
    const audio = audioCache.get(`${voice}\n${text}`)
    if (audio) out[text] = Math.round((audio.seconds + SPEAK_TAIL_S) * 1000) / 1000
  }
  return out
}
