#!/usr/bin/env node
/**
 * The council's videos, made after the app has stopped: video-real.mp4 and the
 * watch video video.mp4 from the screencast frames, both with the agent's voice
 * when the job has it (job.voice: the WAV that council.mjs made from the played
 * scenes; the watch video never cuts where a line sounds), then meta.json gets the
 * numbers and the gallery is rebuilt. council.mjs starts it in the background
 * (so the next run can start), or waits for it with --wait-media.
 *
 *   node scripts/lab/media.mjs <job.json>
 *
 * The job file and the frames are in one scratch folder per run; the script
 * deletes that folder at the end. Two jobs can run at once: every file they
 * write is inside their own run folder or their own scratch folder, and the
 * gallery is written with a rename.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeVideo, encodeWatchVideo, log } from './common.mjs'
import { writeGallery } from './gallery.mjs'

/** job: { dir, framesDir, frames, from, to, crop, labels, playing, voice: {wav, lines} | null } */
export function makeMedia(job) {
  const say = (...p) => log('media', ...p)
  const errors = []
  const step = (what, fn) => {
    const t = Date.now()
    try {
      const value = fn()
      say(`${what} in ${((Date.now() - t) / 1000).toFixed(1)} s`)
      return value
    } catch (error) {
      const message = `${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
      errors.push(message)
      say(message)
      return null
    }
  }
  // Write to a part file and rename, so the gallery never links a half-written video.
  const encode = (name, fn) => {
    const part = join(job.dir, `.${name}.part.mp4`)
    const value = fn(part)
    renameSync(part, join(job.dir, name))
    return value
  }
  const { dir, frames, from, to, crop } = job
  step('real-speed video', () => encode('video-real.mp4', (out) => encodeVideo(frames, out, { from, to, crop, audio: job.voice?.wav ?? null })))
  const watch = step('watch video', () => encode('video.mp4', (out) => encodeWatchVideo(frames, out, { from, to, crop, labels: job.labels, playing: job.playing, voice: job.voice ?? null })))
  if (watch) say(`watch video ${watch.watch_s} s of ${watch.real_s} s real (${watch.cuts.length} cuts)`)

  const metaFile = join(dir, 'meta.json')
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    meta.numbers = { ...meta.numbers, watch_s: watch?.watch_s ?? null }
    meta.cuts = watch?.cuts ?? []
    meta.media_errors = [...(meta.media_errors ?? []), ...errors]
    meta.media = 'done'
    writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  }
  rmSync(job.framesDir, { recursive: true, force: true })
  say(`gallery ${writeGallery()}`)
  return { watch, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) throw new Error('usage: node scripts/lab/media.mjs <job.json>')
  makeMedia(JSON.parse(readFileSync(file, 'utf8')))
}
