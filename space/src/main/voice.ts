import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentHomeDir } from './agent-home'

/**
 * The voice of say() lines (docs/learning-space/voice-lines-plan.md): the only
 * caller of the speech API. The app holds no AI; it reads lines aloud with the
 * learner's own key, which stays in this process.
 *
 * write_scene sends all lines of a scene as one request, joined with a long
 * pause: the API allows few requests a minute, and a short line alone comes
 * back padded. The answer is one WAV. Each line's place in it comes from the
 * silences (findLines). The WAV and the places stay in the learning folder, so
 * the same text in the same voice never costs a second request.
 *
 * The voice never holds a scene up or fails it: every failure is a reason in
 * the result, and the scene runs at the reading pace.
 */

const MODEL = 'gemini-3.8-flash-lite-tts'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
/** Between lines in the joined text: the speech model reads this as a pause. */
const LINE_JOIN = ' <long pause> '
/** Clips, from the learning folder's root. renderer/live/voice.ts plays them, and folder.ts readAsset serves only this folder. */
const CLIP_DIR = '.learning-space/voice'
/** The records of the scenes (main/scene-store.ts). Their host answers name the clips they use. */
const RECORD_DIR = '.learning-space/scenes'
/** A clip that no record uses goes after this long: it can be the draft of a scene to come. */
const CLIP_KEEP_MS = 7 * 24 * 60 * 60 * 1000
/** The whole request with its retry. */
const REQUEST_LIMIT_MS = 45_000
const RETRY_WAIT_MS = 1000
/** What a retry needs of the limit: a request takes 4 to 8 s, and a wait that leaves less gives no audio after it. */
const RETRY_ROOM_MS = 10_000

export const VOICES = ['Kore', 'Aoede', 'Leda', 'Puck', 'Charon', 'Orus'] as const
export const PACES = {
  calm: { label: 'Calm', style: 'calm and unhurried teacher' },
  natural: { label: 'Natural', style: 'a natural, friendly teacher at a normal conversational pace' },
  brisk: { label: 'Brisk', style: 'an energetic teacher, speaking quickly and clearly' }
} as const
export type PaceName = keyof typeof PACES

/** Where one line is in its clip, in seconds. speech_end: where its words end; to: where the next line starts, so to - from holds the pause. */
interface LinePlace {
  from: number
  speech_end: number
  to: number
}

/** What a voiced say() gets from main (stage/live-prelude.js voiceOf). */
export type VoiceAnswer = LinePlace & { clip: string }

/** The key: the environment first, then ~/.learning-space/.env. Read at each use, so a key added later counts at the next scene. */
function readKey(): string | null {
  const own = process.env.GEMINI_API_KEY?.trim()
  if (own) return own
  try {
    const line = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/m.exec(readFileSync(join(agentHomeDir(), '.env'), 'utf8'))
    // A quoted value, else a value up to white space: a comment can follow it.
    return (line && (/^(['"])(.*?)\1/.exec(line[1].trim())?.[2] ?? /^\S*/.exec(line[1].trim())?.[0])) || null
  } catch {
    return null
  }
}

export const hasVoiceKey = (): boolean => readKey() !== null

/** The host request of a voiced line, as stage/live-prelude.js writes it: the key of its answer. */
const voiceRequest = (text: string): string => JSON.stringify({ kind: 'voiceLine', text })

/** The voice answers of a run's answers: what a new run of the same program needs, without what the board must answer again. */
export function voiceAnswers(answers: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...answers].filter(([request]) => request.startsWith('{"kind":"voiceLine"')))
}

// ---------- The WAV ----------

interface Wav {
  rate: number
  channels: number
  /** The 16-bit samples, interleaved. */
  pcm: Buffer
}

function parseWav(file: Buffer): Wav | null {
  if (file.length < 12 || file.toString('latin1', 0, 4) !== 'RIFF' || file.toString('latin1', 8, 12) !== 'WAVE') return null
  let format: { channels: number; rate: number } | null = null
  for (let at = 12; at + 8 <= file.length; ) {
    const name = file.toString('latin1', at, at + 4)
    const size = file.readUInt32LE(at + 4)
    const body = at + 8
    if (name === 'fmt ' && body + 16 <= file.length) {
      if (file.readUInt16LE(body + 14) !== 16) return null
      format = { channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4) }
    } else if (name === 'data') {
      // A streamed WAV can say 0 or the largest size here: the data then runs to the end of the file.
      const end = size === 0 ? file.length : Math.min(file.length, body + size)
      return format && format.channels > 0 && format.rate > 0 ? { ...format, pcm: file.subarray(body, end) } : null
    }
    at = body + size + (size % 2)
  }
  return null
}

// ---------- The lines in the WAV ----------

const FRAME_S = 0.02
/** Below this share of the peak frame's loudness (root mean square, about -34 dB), a frame is silence. A soft word end stays speech. */
const SILENCE_SHARE = 0.02
/** A shorter silence is a stop inside a word. */
const MIN_SILENCE_S = 0.18
/** A shorter sound between two silences is a breath: one pause. */
const MAX_BREATH_S = 0.12
/** In the fit, one second of silence is worth this many seconds of distance from the expected place: a short line next to long pauses is far from its place. */
const GAP_WEIGHT = 3
/** One line's speech may be this many times longer or shorter than its characters say, plus a little for a short line. */
const LINE_STRETCH = 2.2
const LINE_SLACK_S = 0.5

interface Silence {
  start: number
  end: number
}

/** Mean squared sample of each frame of one channel. */
function frameEnergies({ rate, channels, pcm }: Wav): Float64Array {
  const size = Math.round(rate * FRAME_S)
  const count = Math.floor(pcm.length / (2 * channels) / size)
  const energies = new Float64Array(count)
  for (let frame = 0; frame < count; frame++) {
    let sum = 0
    for (let i = 0; i < size; i++) sum += pcm.readInt16LE((frame * size + i) * channels * 2) ** 2
    energies[frame] = sum / size
  }
  return energies
}

/** Where speech starts and ends, and the silences inside it: silence before the first and after the last word is no boundary. */
function speechOf(wav: Wav): { start: number; end: number; length: number; silences: Silence[] } | null {
  const energies = frameEnergies(wav)
  const quiet = energies.reduce((peak, energy) => Math.max(peak, energy), 0) * SILENCE_SHARE ** 2
  const frameS = Math.round(wav.rate * FRAME_S) / wav.rate
  let first = 0
  while (first < energies.length && energies[first] < quiet) first++
  let last = energies.length - 1
  while (last > first && energies[last] < quiet) last--
  if (first >= energies.length) return null
  const silences: Silence[] = []
  for (let frame = first; frame <= last; frame++) {
    if (energies[frame] >= quiet) continue
    const from = frame
    while (frame <= last && energies[frame] < quiet) frame++
    const previous = silences[silences.length - 1]
    if ((frame - from) * frameS < MIN_SILENCE_S) continue
    if (previous && from * frameS - previous.end <= MAX_BREATH_S) previous.end = frame * frameS
    else silences.push({ start: from * frameS, end: frame * frameS })
  }
  return { start: first * frameS, end: (last + 1) * frameS, length: energies.length * frameS, silences }
}

/**
 * The silences that end the lines: one per boundary, in order, each near the place the characters of
 * the lines before it say, and long where the fit can choose. A sentence inside a line can leave a gap
 * as long as a line's, so the place decides. Null when the fit has no sense: a wrong line under a
 * drawing is worse than no voice.
 */
function fitGaps(lengths: readonly number[], speech: { start: number; end: number; silences: Silence[] }): Silence[] | null {
  const need = lengths.length - 1
  const { silences } = speech
  if (silences.length < need) return null
  const chars = lengths.reduce((sum, length) => sum + length, 0)
  const span = speech.end - speech.start
  const expected: number[] = []
  for (let k = 0, before = 0; k < need; k++) expected.push(speech.start + span * ((before += lengths[k]) / chars))
  const cost = (k: number, j: number): number => Math.abs((silences[j].start + silences[j].end) / 2 - expected[k]) - GAP_WEIGHT * (silences[j].end - silences[j].start)
  // best[k][j]: the lowest cost of the first k + 1 boundaries with boundary k at silence j.
  const best = expected.map(() => new Float64Array(silences.length).fill(Infinity))
  const from = expected.map(() => new Int32Array(silences.length).fill(-1))
  for (let k = 0; k < need; k++) {
    let low = k === 0 ? 0 : Infinity
    let lowAt = -1
    for (let j = k; j < silences.length - (need - 1 - k); j++) {
      if (k > 0 && best[k - 1][j - 1] < low) {
        low = best[k - 1][j - 1]
        lowAt = j - 1
      }
      best[k][j] = low + cost(k, j)
      from[k][j] = lowAt
    }
  }
  const chosen = new Array<Silence>(need)
  let at = best[need - 1].reduce((lowest, value, j, row) => (value < row[lowest] ? j : lowest), 0)
  for (let k = need - 1; k >= 0; k--) {
    chosen[k] = silences[at]
    at = from[k][at]
  }
  const rate = (span - chosen.reduce((sum, gap) => sum + gap.end - gap.start, 0)) / chars
  for (let k = 0; k <= need; k++) {
    const seconds = (k < need ? chosen[k].start : speech.end) - (k > 0 ? chosen[k - 1].end : speech.start)
    const want = lengths[k] * rate
    if (seconds > want * LINE_STRETCH + LINE_SLACK_S || seconds < want / LINE_STRETCH - LINE_SLACK_S) return null
  }
  return chosen
}

const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** Each line's place in the WAV. Between two lines, the next line starts where the silence ends. */
function findLines(wav: Wav, lines: readonly string[]): LinePlace[] | null {
  const speech = speechOf(wav)
  if (!speech) return null
  const gaps = lines.length > 1 ? fitGaps(lines.map((line) => line.length), speech) : []
  if (!gaps) return null
  return lines.map((_, k) => ({
    from: ms(k > 0 ? gaps[k - 1].end : speech.start),
    speech_end: ms(k < gaps.length ? gaps[k].start : speech.end),
    to: ms(k < gaps.length ? gaps[k].end : speech.length)
  }))
}

// ---------- The request ----------

/** Why a request gave no audio, as the write_scene result says it. */
class VoiceFailed extends Error {}

function sleep(wait: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, wait)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })
}

/** The seconds a 429 says to wait, from its header or its body, in ms. */
function retryAfter(response: Response, body: string): number {
  const seconds = Number(response.headers.get('retry-after') ?? /retry\s*(?:delay|in)?\W*([\d.]+)\s*s/i.exec(body)?.[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RETRY_WAIT_MS
}

function audioOf(answer: unknown): Buffer | null {
  const steps = (answer as { steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }> }).steps
  if (!Array.isArray(steps)) return null
  for (const step of steps) {
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue
    const audio = step.content.find((part) => part.type === 'audio' && typeof part.data === 'string')
    if (audio) return Buffer.from(audio.data as string, 'base64')
  }
  return null
}

/** One request, and one retry after a failure that a retry can help: all of it within REQUEST_LIMIT_MS. signal: the scene was cancelled. */
async function requestAudio(key: string, text: string, voice: string, style: string, signal: AbortSignal): Promise<Buffer> {
  const body = JSON.stringify({
    model: MODEL,
    input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] }
  })
  const deadline = Date.now() + REQUEST_LIMIT_MS
  const limited = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_LIMIT_MS)])
  let failed = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    let wait = RETRY_WAIT_MS
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: limited })
      if (response.ok) {
        const audio = audioOf(await response.json())
        if (!audio) throw new VoiceFailed('the answer of the speech API holds no audio')
        return audio
      }
      const reason = await response.text()
      failed = `the speech API answered ${response.status}`
      if (response.status === 429) {
        wait = retryAfter(response, reason)
        failed += ` and named a wait of ${Math.ceil(wait / 1000)} s`
      } else if (response.status < 500) throw new VoiceFailed(`${failed}: ${reason.slice(0, 200)}`)
    } catch (error) {
      if (error instanceof VoiceFailed || signal.aborted) throw error
      if (limited.aborted) {
        failed = ''
        break
      }
      failed = `the speech API could not be reached (${error instanceof Error ? error.message : String(error)})`
    }
    if (attempt === 1 || Date.now() + wait + RETRY_ROOM_MS >= deadline) break
    await sleep(wait, limited)
  }
  throw new VoiceFailed(failed || `the speech API gave no audio within ${REQUEST_LIMIT_MS / 1000} s`)
}

// ---------- A scene's lines ----------

export type SpokenLines = { answers: Map<string, string>; seconds: number; cached: boolean } | { reason: string }

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

async function readPlaces(path: string, wav: string, count: number): Promise<{ seconds: number; places: LinePlace[] } | null> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { seconds: number; places: LinePlace[] }
    await stat(wav)
    return Array.isArray(saved.places) && saved.places.length === count ? saved : null
  } catch {
    return null
  }
}

/**
 * The voice of a scene's lines: an answer for each line. Equal lines share their audio, as equal words do. A cancel (signal)
 * throws; every other failure is a reason.
 */
export async function speakLines(root: string, lines: readonly string[], choice: { voice: string; pace: PaceName }, signal: AbortSignal): Promise<SpokenLines> {
  const unique = [...new Set(lines)]
  const text = unique.join(LINE_JOIN)
  const { style } = PACES[choice.pace]
  const sha = createHash('sha256').update(JSON.stringify([MODEL, choice.voice, style, text])).digest('hex')
  const clip = `${CLIP_DIR}/${sha}.wav`
  const wavPath = join(root, clip)
  const placesPath = join(root, CLIP_DIR, `${sha}.json`)
  const answersOf = (places: LinePlace[]): Map<string, string> => new Map(unique.map((line, i) => [voiceRequest(line), JSON.stringify({ clip, ...places[i] } satisfies VoiceAnswer)]))
  const saved = await readPlaces(placesPath, wavPath, unique.length)
  if (saved) return { answers: answersOf(saved.places), seconds: saved.seconds, cached: true }
  try {
    // A clip without places: the same text costs no second request, also when its lines could not be found.
    let file: Buffer | null = await readFile(wavPath).catch(() => null)
    const cached = file !== null
    if (!file) {
      const key = readKey()
      if (!key) return { reason: 'no GEMINI_API_KEY in the environment or in ~/.learning-space/.env' }
      file = await requestAudio(key, text, choice.voice, style, signal)
      await mkdir(join(root, CLIP_DIR), { recursive: true })
      // A learning folder is often a git repository, and a clip is megabytes that the same text makes again.
      await writeFile(join(root, CLIP_DIR, '.gitignore'), '*\n')
      await writeAtomic(wavPath, file)
    }
    const wav = parseWav(file)
    if (!wav) return { reason: 'the audio of the speech API is not a 16-bit WAV' }
    const places = findLines(wav, unique)
    if (!places) return { reason: 'the lines could not be found in the audio' }
    const seconds = ms(wav.pcm.length / (2 * wav.channels * wav.rate))
    await writeAtomic(placesPath, JSON.stringify({ seconds, places }))
    return { answers: answersOf(places), seconds, cached }
  } catch (error) {
    if (signal.aborted) throw error
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---------- Old clips ----------

/**
 * Remove the clips that no scene record uses and that are old: every changed draft leaves one. Records are read only when an old
 * clip exists, and a record that cannot be read stops the clean-up, so a clip that a record uses never goes.
 */
export async function cleanVoiceClips(root: string): Promise<void> {
  const dir = join(root, CLIP_DIR)
  const names = await readdir(dir).catch(() => [])
  const now = Date.now()
  const old: Array<{ name: string; sha: string }> = []
  for (const name of names) {
    const sha = /^([0-9a-f]{64})\.(?:wav|json)$/.exec(name)?.[1]
    if (sha && now - (await stat(join(dir, name))).mtimeMs > CLIP_KEEP_MS) old.push({ name, sha })
  }
  if (!old.length) return
  const records = join(root, RECORD_DIR)
  const used = new Set<string>()
  for (const name of await readdir(records)) {
    if (!name.endsWith('.jsonl')) continue
    const text = await readFile(join(records, name))
    for (const clip of old) if (text.includes(clip.sha)) used.add(clip.sha)
  }
  const gone = old.filter((clip) => !used.has(clip.sha))
  await Promise.all(gone.map((clip) => rm(join(dir, clip.name), { force: true })))
  if (gone.length) console.log(`voice clips: removed ${gone.length} old files`)
}
