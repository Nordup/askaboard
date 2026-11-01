/**
 * Measuring switches for the render benchmark (env SPACE_WORLD_TUNE, read once at boot). An absent key changes nothing.
 * scripts/perf/README.md lists them. They are not settings for users.
 */
export interface WorldTune {
  /** Samples of the scene target. */
  msaa?: number
  /** 0: 8-bit targets where the pipeline allows it. */
  hdr?: number
  /** A cap on the pixel ratio of the live path. */
  dpr?: number
  /** 0: resolution stays at full share, so dynamic resolution hides no cost. */
  adaptive?: number
  /** 0: that part is off for every world. */
  bloom?: number
  dof?: number
  floor?: number
  env?: number
  shadows?: number
  /** Overscan in CSS pixels per side. */
  surfaceMargin?: number
  /** 1: no picture waits for a page paint or a display frame, and Chromium starts with its frame limit off. */
  uncapped?: number
  /** The fence time per picture (ms) over which a moving world lowers its quality: a small value acts as a weak machine. */
  budget?: number
  /** 1: act as on an Intel GPU, whatever this machine has. */
  integrated?: number
  /** 1: show pictures through a 2D canvas, as where bitmaprenderer is missing. */
  flat?: number
}
