import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { record } from './analytics'
import { telemetryIdentity } from './analytics-id'
import { readVoiceKey } from './voice-key'
import { LOCAL_MODEL, localVoiceState, speakLocal } from './kokoro'
import { resourcePath } from './resources'
import { getLocalVoice, getPace, getVoice, getVoiceModel } from './state'
import { PACES, SAMPLE_DIR, SAMPLE_TEXT, sampleFile, speechRequest, voiceHost, type PaceName } from './voice-choices'
import type { VoiceFailure } from '@shared/space-api'

/**
 * The voice of say() lines (docs/history/voice-lines-plan.md): the only
 * caller of the speech API. The app holds no AI; it reads lines aloud with the
 * learner's own key, which stays in this process, and with no key through our
 * voice server (decision T39), which sends the same request with its own key. With
 * the local model chosen (Settings), Kokoro makes the audio on this Mac (kokoro.ts, T40).
 *
 * write_scene sends all lines of a scene as one request, as one continuous
 * narration: the API allows few requests a minute, a short line alone comes
 * back padded, and a pause tag gives long gaps with a broken intonation. The
 * answer is one WAV. Each line's place in it comes from the natural silences
 * (findLines). The WAV and the places stay in the learning folder, so the same
 * text in the same voice never costs a second request.
 *
 * The voice never holds a scene up or fails it: every failure is a reason in
 * the result, and the scene runs at the reading pace.
 */

const MODEL = 'gemini-3.8-flash-lite-tts'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
/** Between lines in the joined text: plain prose, so the model pauses as it does between any two sentences. */
const LINE_JOIN = ' '
/** Clips, from the learning folder's root. renderer/live/voice.ts plays them, and folder.ts readAsset serves only this folder. */
export const CLIP_DIR = '.askaboard/voice'
/** The whole request with its retry. */
const REQUEST_LIMIT_MS = 45_000
const RETRY_WAIT_MS = 1000
/** What a retry needs of the limit: a request takes 4 to 8 s, and a wait that leaves less gives no audio after it. */
const RETRY_ROOM_MS = 10_000

/** Where one line is in its clip, in seconds. from: in the silence just before its words; speech_end: where its words end; to: where the next line starts, so to - from holds the pause. */
interface LinePlace {
  from: number
  speech_end: number
  to: number
}

/** What a voiced say() gets from main (stage/live-prelude.js voiceOf). */
export type VoiceAnswer = LinePlace & { clip: string }

export const hasVoiceKey = (): boolean => readVoiceKey() !== null

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
/** Where a sentence ends inside a line. */
const SENTENCE_END = /(?<=[.?!])\s+/
/** In the fit, one second of silence is worth this many seconds of difference from the length that the characters say: a sentence end pauses longer than a comma. */
const GAP_WEIGHT = 2
/** One line's speech may be this many times longer or shorter than its characters say, plus a little for a short line. */
const LINE_STRETCH = 2.2
const LINE_SLACK_S = 0.5
/** A line starts this long before the silence ends: the first consonant of a word can be softer than the silence limit, and a seek in silence is not heard. */
const LINE_LEAD_S = 0.05

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
 * The silences that end the lines, in order. A line can hold several sentences, with gaps as long as
 * the gap after a line, so size and place alone choose wrong. The fit places every sentence: each
 * sentence's speech must have the length that its characters say, which is a local test, so an error
 * does not carry on along the clip. A sentence end inside a line can have no silence; a line end must
 * have one. Null when the fit has no sense: a wrong line under a drawing is worse than no voice.
 */
function fitGaps(lines: readonly string[], speech: { start: number; end: number; silences: Silence[] }): Silence[] | null {
  // chars[s]: the characters before sentence s. lineEnds: the values of s that start a new line.
  const chars = [0]
  const lineEnds = new Set<number>()
  for (const line of lines) {
    for (const sentence of line.split(SENTENCE_END)) chars.push(chars[chars.length - 1] + sentence.length)
    lineEnds.add(chars.length - 1)
  }
  const sentences = chars.length - 1
  // The start and the end of the speech act as two silences of no length.
  const stops = [{ start: speech.start, end: speech.start }, ...speech.silences, { start: speech.end, end: speech.end }]
  const last = stops.length - 1
  const silent = [0]
  for (const stop of stops) silent.push(silent[silent.length - 1] + stop.end - stop.start)
  /** The speech between two stops, without the silences between them. */
  const spoken = (i: number, j: number): number => stops[j].start - stops[i].end - (silent[j] - silent[i + 1])
  const rate = spoken(0, last) / chars[sentences]
  // best[s][j]: the lowest cost with sentence s - 1 ending at stop j. It comes from fromSentence[s][j], fromStop[s][j].
  const best = chars.map(() => new Float64Array(stops.length).fill(Infinity))
  const fromSentence = chars.map(() => new Int32Array(stops.length))
  const fromStop = chars.map(() => new Int32Array(stops.length))
  best[0][0] = 0
  for (let s = 1; s <= sentences; s++) {
    for (let j = s === sentences ? last : 1; j <= (s === sentences ? last : last - 1); j++) {
      const reward = GAP_WEIGHT * (stops[j].end - stops[j].start)
      // p < s - 1: the sentence ends between have no silence of their own.
      for (let p = s - 1; ; p--) {
        for (let i = 0; i < j; i++) {
          const cost = best[p][i] + Math.abs(spoken(i, j) - rate * (chars[s] - chars[p])) - reward
          if (cost < best[s][j]) {
            best[s][j] = cost
            fromSentence[s][j] = p
            fromStop[s][j] = i
          }
        }
        if (p === 0 || lineEnds.has(p)) break
      }
    }
  }
  if (best[sentences][last] === Infinity) return null
  const chosen: number[] = []
  for (let s = sentences, j = last; s > 0; ) {
    const before = fromSentence[s][j]
    j = fromStop[s][j]
    s = before
    if (lineEnds.has(s)) chosen.unshift(j)
  }
  for (let k = 0; k < lines.length; k++) {
    const seconds = spoken(k > 0 ? chosen[k - 1] : 0, k < chosen.length ? chosen[k] : last)
    const want = lines[k].length * rate
    if (seconds > want * LINE_STRETCH + LINE_SLACK_S || seconds < want / LINE_STRETCH - LINE_SLACK_S) return null
  }
  return chosen.map((j) => stops[j])
}

const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** Each line's place in the WAV. Between two lines, the next line starts just before the silence ends. */
function findLines(wav: Wav, lines: readonly string[]): LinePlace[] | null {
  const speech = speechOf(wav)
  if (!speech) return null
  const gaps = lines.length > 1 ? fitGaps(lines, speech) : []
  if (!gaps) return null
  const start = (k: number): number => ms(k > 0 ? gaps[k - 1].end - LINE_LEAD_S : Math.max(0, speech.start - LINE_LEAD_S))
  return lines.map((_, k) => ({
    from: start(k),
    speech_end: ms(k < gaps.length ? gaps[k].start : speech.end),
    to: k < gaps.length ? start(k + 1) : ms(speech.length)
  }))
}

// ---------- The request ----------

export type { VoiceFailure }

/** The reason of daily_cap, as the agent reads it. */
const CAP_REASON = 'Not enough voice credits left for today.'

/** Why a request gave no audio, as the write_scene result says it. */
class VoiceFailed extends Error {
  constructor(
    message: string,
    /** The voice server's daily cap for this user. */
    readonly capped = false
  ) {
    super(message)
  }
}

/** Who makes the audio: Kokoro on this Mac when the learner chose it; else Gemini with the learner's own key, else our voice server, which counts the cap by the analytics distinct_id. */
type Speaker = { source: 'local' } | { source: 'own_key'; key: string } | { source: 'backend'; host: string; user: string }

const speakerName = (speaker: Speaker): string => (speaker.source === 'local' ? 'the local voice' : speaker.source === 'own_key' ? 'the speech API' : 'the voice server')

/** The reason when the learner chose the local voice and it is not installed. */
const NOT_INSTALLED = 'The local voice is chosen in Settings but is not installed.'

/** The speaker of the current choice, or a failure: the local voice not installed, or no install id for the voice server. */
async function currentSpeaker(): Promise<Speaker | { reason: string }> {
  if (getVoiceModel() === 'local') return localVoiceState().state === 'installed' ? { source: 'local' } : { reason: NOT_INSTALLED }
  const key = readVoiceKey()
  if (key) return { source: 'own_key', key }
  const user = await voiceUser()
  return user ? { source: 'backend', host: voiceHost(), user } : { reason: 'the voice server needs an install id, and none could be read or made' }
}

/** The user of the voice server: the analytics distinct_id, also with usage data off. Null when no id could be read or made. */
const voiceUser = (): Promise<string | null> =>
  telemetryIdentity().then(
    (id) => id.distinctId,
    () => null
  )

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

/** The voice server's reason field ({"reason": "rate_limited"}), else the start of the body. */
function serverReason(body: string): string {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  } catch {
    // Not JSON: a proxy's page.
  }
  return body.slice(0, 200)
}

/** The audio of the local voice: no limit of time (a long scene takes long on this Mac), only the scene's cancel. */
async function localAudio(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer> {
  try {
    return await speakLocal(text, voice, speed, signal)
  } catch (error) {
    if (signal.aborted) throw error
    throw new VoiceFailed(`the local voice failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** One request, and one retry after a failure that a retry can help: all of it within REQUEST_LIMIT_MS. signal: the scene was cancelled. */
async function requestAudio(speaker: Exclude<Speaker, { source: 'local' }>, text: string, voice: string, style: string, signal: AbortSignal): Promise<Buffer> {
  const name = speakerName(speaker)
  const [url, init]: [string, RequestInit] =
    speaker.source === 'own_key'
      ? [
          ENDPOINT,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': speaker.key },
            body: JSON.stringify({
              model: MODEL,
              input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
              response_format: { type: 'audio' },
              generation_config: { speech_config: [{ voice }] },
              // Gemini keeps no copy of the request or the response (the default is store: true)
              store: false
            })
          }
        ]
      : speechRequest(speaker.host, speaker.user, text, voice, style)
  const deadline = Date.now() + REQUEST_LIMIT_MS
  const limited = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_LIMIT_MS)])
  let failed = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    let wait = RETRY_WAIT_MS
    try {
      const response = await fetch(url, { ...init, signal: limited })
      if (response.ok) {
        // The voice server answers the WAV itself; Gemini answers JSON with the audio in base64.
        const audio = speaker.source === 'own_key' ? audioOf(await response.json()) : Buffer.from(await response.arrayBuffer())
        if (!audio?.length) throw new VoiceFailed(`the answer of ${name} holds no audio`)
        return audio
      }
      const reason = await response.text()
      if (speaker.source === 'backend' && response.status === 402) throw new VoiceFailed(CAP_REASON, true)
      failed = `${name} answered ${response.status}`
      if (response.status === 429) {
        wait = retryAfter(response, reason)
        failed += ` and named a wait of ${Math.ceil(wait / 1000)} s`
      } else if (response.status < 500) throw new VoiceFailed(`${failed}: ${speaker.source === 'backend' ? serverReason(reason) : reason.slice(0, 200)}`)
      else if (speaker.source === 'backend') failed += ` (${serverReason(reason)})`
    } catch (error) {
      if (error instanceof VoiceFailed || signal.aborted) throw error
      if (limited.aborted) {
        failed = ''
        break
      }
      failed = `${name} could not be reached (${error instanceof Error ? error.message : String(error)})`
    }
    if (attempt === 1 || Date.now() + wait + RETRY_ROOM_MS >= deadline) break
    await sleep(wait, limited)
  }
  throw new VoiceFailed(failed || `${name} gave no audio within ${REQUEST_LIMIT_MS / 1000} s`)
}

// ---------- A scene's lines ----------

export type SpokenLines = { answers: Map<string, string>; seconds: number; cached: boolean } | { reason: string; code: VoiceFailure }

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

/** A clip that is used again gets a new date: the clean-up goes by age (main/storage.ts), and a draft has no record yet. A file that is not there throws. */
async function touch(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now)
}

async function readPlaces(path: string, wav: string, count: number): Promise<{ seconds: number; places: LinePlace[] } | null> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { seconds: number; places: LinePlace[] }
    await touch(wav)
    await touch(path)
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
  const start = Date.now()
  const { spoken, source } = await speakLinesOnce(root, lines, choice, signal)
  // voice.requested (main/analytics.ts): a cancel throws above and is not counted.
  const outcome = 'reason' in spoken ? (spoken.code === 'daily_cap' ? 'capped' : 'failed') : spoken.cached ? 'cached' : 'ok'
  record('voice.requested', { source, outcome, audioSeconds: 'reason' in spoken ? 0 : spoken.seconds, requestMs: Date.now() - start })
  return spoken
}

/** source: where the audio came from, for voice.requested; cache when no request was made. */
async function speakLinesOnce(root: string, lines: readonly string[], choice: { voice: string; pace: PaceName }, signal: AbortSignal): Promise<{ spoken: SpokenLines; source: 'cache' | Speaker['source'] }> {
  const unique = [...new Set(lines)]
  const text = unique.join(LINE_JOIN)
  const { style, speed } = PACES[choice.pace]
  // The local voice has its own voices (Settings), so choice.voice (a cloud voice) counts only for the cloud.
  const local = getVoiceModel() === 'local'
  const voice = local ? getLocalVoice() : choice.voice
  // Every failure names the voice that failed, so the learner's notice tells the cap, the cloud and the local voice apart.
  const failure = (reason: string, capped = false): { reason: string; code: VoiceFailure } => ({ reason, code: capped ? 'daily_cap' : local ? 'local' : 'cloud' })
  // The model is in the key, so a cloud clip and a local clip of the same text never mix.
  const sha = createHash('sha256').update(JSON.stringify(local ? [LOCAL_MODEL, voice, speed, text] : [MODEL, voice, style, text])).digest('hex')
  const clip = `${CLIP_DIR}/${sha}.wav`
  const wavPath = join(root, clip)
  const placesPath = join(root, CLIP_DIR, `${sha}.json`)
  const answersOf = (places: LinePlace[]): Map<string, string> => new Map(unique.map((line, i) => [voiceRequest(line), JSON.stringify({ clip, ...places[i] } satisfies VoiceAnswer)]))
  const saved = await readPlaces(placesPath, wavPath, unique.length)
  if (saved) return { spoken: { answers: answersOf(saved.places), seconds: saved.seconds, cached: true }, source: 'cache' }
  let source: 'cache' | Speaker['source'] = 'cache'
  let name = local ? 'the local voice' : 'the speech API'
  try {
    // A clip without places: the same text costs no second request, also when its lines could not be found.
    let file: Buffer | null = await readFile(wavPath).catch(() => null)
    const cached = file !== null
    if (file) await touch(wavPath)
    else {
      const speaker = await currentSpeaker()
      if ('reason' in speaker) return { spoken: failure(speaker.reason), source: local ? 'local' : 'backend' }
      source = speaker.source
      name = speakerName(speaker)
      file = speaker.source === 'local' ? await localAudio(text, voice, speed, signal) : await requestAudio(speaker, text, voice, style, signal)
      await mkdir(join(root, CLIP_DIR), { recursive: true })
      // A learning folder is often a git repository, and a clip is megabytes that the same text makes again.
      await writeFile(join(root, CLIP_DIR, '.gitignore'), '*\n')
      await writeAtomic(wavPath, file)
    }
    const wav = parseWav(file)
    if (!wav) return { spoken: failure(`the audio of ${name} is not a 16-bit WAV`), source }
    const places = findLines(wav, unique)
    if (!places) return { spoken: failure('the lines could not be found in the audio'), source }
    const seconds = ms(wav.pcm.length / (2 * wav.channels * wav.rate))
    await writeAtomic(placesPath, JSON.stringify({ seconds, places }))
    return { spoken: { answers: answersOf(places), seconds, cached }, source }
  } catch (error) {
    if (signal.aborted) throw error
    return { spoken: error instanceof VoiceFailed ? failure(error.message, error.capped) : failure(error instanceof Error ? error.message : String(error)), source }
  }
}

// ---------- The sample ----------

/** A sample's audio and its media type, for the renderer's Blob. */
export interface VoiceSample {
  bytes: Uint8Array
  type: 'audio/mp4' | 'audio/wav'
}

/**
 * A short sample in the current model, voice and pace (Settings, ▶). The cloud voice's sample ships with the app
 * (decision U14: resources/voice-samples/, an AAC clip per voice and pace), so it plays at once and needs no network;
 * the local voice makes its sample on this Mac (a 16-bit WAV). No cache and no analytics. Throws an Error with one short line.
 */
export async function voiceSample(signal: AbortSignal): Promise<VoiceSample> {
  const pace = getPace()
  if (getVoiceModel() !== 'local') {
    const file = resourcePath(SAMPLE_DIR, sampleFile(getVoice(), pace))
    const bytes = await readFile(file).catch(() => null)
    if (!bytes) throw new Error(`the voice sample ${file} is missing (scripts/voice/make-samples.mjs makes it)`)
    return { bytes: new Uint8Array(bytes), type: 'audio/mp4' }
  }
  const speaker = await currentSpeaker()
  if ('reason' in speaker) throw new Error(speaker.reason)
  try {
    return { bytes: new Uint8Array(await localAudio(SAMPLE_TEXT, getLocalVoice(), PACES[pace].speed, signal)), type: 'audio/wav' }
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

let sample: AbortController | null = null

/** Settings' play button: one sample at a time (a new one stops the last), at most 45 s. */
export async function playVoiceSample(): Promise<VoiceSample> {
  sample?.abort()
  const controller = new AbortController()
  sample = controller
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    return await voiceSample(controller.signal)
  } finally {
    clearTimeout(timer)
    if (sample === controller) sample = null
  }
}
