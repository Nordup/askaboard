/**
 * The one param evaluator of worlds. Playback
 * (player.ts) and world stills
 * (world/worker) use it, so a preview and a pause of playback
 * at the same time show the same params.
 */

/** Two samples this close are frames of one motion: blend between them. Farther apart, the earlier sample holds (a jump). */
export const BLEND_GAP = 0.05

/** A params sample of a live item in a scene: [scene time, params]. The stage gives params on every sample of a live object. */
export type ParamSample = [number, Record<string, number>]

/**
 * The params of a live item at scene time t, from its samples in time order:
 * before the first sample, the first; after the last, the last. Between two
 * samples closer than `gap`, each number of the earlier sample blends
 * linearly to the later one; otherwise the earlier sample holds. Null
 * without samples (the item's own params show). A held sample gives its own
 * object, so an unchanged result is the same object.
 *
 * The function is self-contained (no outer names): world/worker/index.ts puts its
 * source into the worker script. Give `gap` as BLEND_GAP.
 */
export function paramsAtTime(samples: readonly ParamSample[], t: number, gap: number): Record<string, number> | null {
  if (!samples.length) return null
  let lo = 0
  let hi = samples.length - 1
  if (t > samples[0][0]) {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (samples[mid][0] <= t) lo = mid
      else hi = mid - 1
    }
  }
  const [at, a] = samples[lo]
  const [bt, b] = samples[Math.min(lo + 1, samples.length - 1)]
  if (lo === samples.length - 1 || bt - at > gap || t <= at) return a
  const k = (t - at) / (bt - at)
  const out: Record<string, number> = {}
  for (const key of Object.keys(a)) {
    const from = a[key]
    const to = b[key]
    out[key] = typeof to === 'number' ? from + (to - from) * k : from
  }
  return out
}

const cache = new WeakMap<readonly { t: number; params?: Record<string, number> }[], { read: number; out: ParamSample[] }>()

/** The params samples of a live object's samples (compile.ts). One list per sample list: it grows as the samples of a stream arrive. */
export function paramSamplesOf(samples: readonly { t: number; params?: Record<string, number> }[]): ParamSample[] {
  let entry = cache.get(samples)
  if (!entry) cache.set(samples, (entry = { read: 0, out: [] }))
  for (; entry.read < samples.length; entry.read++) {
    const sample = samples[entry.read]
    if (sample.params) entry.out.push([sample.t, sample.params])
  }
  return entry.out
}
