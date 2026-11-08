/**
 * The cloud voice's choices and its one request to our voice server, with no Electron import: main (voice.ts) and the
 * sample build (scripts/voice/make-samples.mjs, which runs this file in Node) share this one copy.
 */

/** Our voice server (decision P25): POST /v1/speech. ASKABOARD_VOICE_HOST changes it. */
const DEFAULT_VOICE_HOST = 'https://api.askaboard.com'
export const voiceHost = (): string => (process.env.ASKABOARD_VOICE_HOST?.trim() || DEFAULT_VOICE_HOST).replace(/\/+$/, '')

export const VOICES = ['Charon', 'Kore', 'Aoede', 'Leda', 'Puck', 'Orus'] as const
/** style: the cloud voice's direction; speed: the local voice's speed (Kokoro). */
export const PACES = {
  calm: { label: 'Calm', style: 'calm and unhurried teacher', speed: 0.9 },
  natural: { label: 'Natural', style: 'a natural, friendly teacher at a normal conversational pace', speed: 1 },
  brisk: { label: 'Brisk', style: 'an energetic teacher, speaking quickly and clearly', speed: 1.1 }
} as const
export type PaceName = keyof typeof PACES

/** The sentence of the Settings sample. */
export const SAMPLE_TEXT = 'This is how the lines of a scene will sound.'

/**
 * The cloud voice's samples ship with the app (decision U14): one AAC clip of SAMPLE_TEXT per voice and pace, in
 * resources/voice-samples/. scripts/voice/make-samples.mjs makes them again when VOICES, PACES or SAMPLE_TEXT change.
 */
export const SAMPLE_DIR = 'voice-samples'
export const sampleFile = (voice: string, pace: string): string => `${voice.toLowerCase()}-${pace}.m4a`

/** The voice server's request for one text: its URL and the fetch options. It answers a 16-bit WAV. user: the install id the server counts its daily cap by. */
export function speechRequest(host: string, user: string, text: string, voice: string, style: string): [string, { method: 'POST'; headers: Record<string, string>; body: string }] {
  return [`${host}/v1/speech`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-install-user': user }, body: JSON.stringify({ text, voice, style }) }]
}
