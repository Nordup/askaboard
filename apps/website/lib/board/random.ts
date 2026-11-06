// Copied from space/src/shared/live-scene.ts (mulberry32) and space/src/stage/live-prelude.js (seeded).
/** A seeded random source (mulberry32): the same seed gives the same numbers. A scene that runs again (a restage, a rebuild of the stage) gets the same numbers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A mulberry32 stream that counts its draws, so its state can be made again: seededAt(r.seed, r.n). */
export function seeded(seed: number): (() => number) & { seed: number; n: number } {
  const next = mulberry32(seed)
  const draw = (() => {
    draw.n++
    return next()
  }) as (() => number) & { seed: number; n: number }
  draw.seed = seed
  draw.n = 0
  return draw
}
