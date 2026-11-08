#!/usr/bin/env node
// Makes the cloud voice's Settings samples that ship with the app (decision U14): one clip of SAMPLE_TEXT for each
// voice and pace, from our voice server, as AAC in resources/voice-samples/. Run it again when VOICES, PACES or
// SAMPLE_TEXT change (src/main/voice-choices.ts, the one copy the app uses too). macOS only (afconvert).
//
//   node --no-warnings scripts/voice/make-samples.mjs        # all clips (Node 23.6+: it runs the .ts module)
//   node --no-warnings scripts/voice/make-samples.mjs Kore   # only the voices named
//
// ASKABOARD_VOICE_HOST changes the server, as in the app. The server counts its daily cap by the install id;
// this script sends ASKABOARD_VOICE_USER, by default "voice-sample-build".
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACES, SAMPLE_DIR, SAMPLE_TEXT, VOICES, sampleFile, speechRequest, voiceHost } from '../../src/main/voice-choices.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', SAMPLE_DIR)
/** AAC at 40 kbit/s: the server's 24 kHz mono speech stays clear, about 30 KB a clip. */
const BITRATE = '40000'
const user = process.env.ASKABOARD_VOICE_USER?.trim() || 'voice-sample-build'
const voices = process.argv.length > 2 ? process.argv.slice(2) : [...VOICES]
const scratch = mkdtempSync(join(tmpdir(), 'voice-samples-'))
mkdirSync(OUT, { recursive: true })

async function speech(voice, style) {
  let failed = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    const [url, init] = speechRequest(voiceHost(), user, SAMPLE_TEXT, voice, style)
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) }).catch((error) => ({ ok: false, status: 0, headers: new Headers(), text: async () => String(error) }))
    if (response.ok) return Buffer.from(await response.arrayBuffer())
    failed = `${response.status} ${(await response.text()).slice(0, 200)}`
    // The server limits requests per minute (429): wait as it says, else 20 s.
    const wait = Number(response.headers.get('retry-after')) * 1000 || (response.status === 429 ? 20_000 : 2000)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error(`the voice server gave no audio for ${voice}: ${failed}`)
}

let total = 0
try {
  // One request at a time: the server's per-minute limit.
  for (const voice of voices)
    for (const [pace, { style }] of Object.entries(PACES)) {
      const wav = join(scratch, `${voice}-${pace}.wav`)
      writeFileSync(wav, await speech(voice, style))
      const out = join(OUT, sampleFile(voice, pace))
      execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', BITRATE, wav, out])
      const size = statSync(out).size
      total += size
      console.log(`${sampleFile(voice, pace)}  ${(size / 1024).toFixed(1)} KB`)
    }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${(total / 1024).toFixed(0)} KB in ${OUT}`)
