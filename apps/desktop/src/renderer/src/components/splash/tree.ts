/**
 * "Blossom tree": a plum tree in blossom in front of a pale moon, after an ink painting the founder chose (a dark
 * gnarled trunk at the lower right, an S-twist, one long limb across to the far left, a crown of fine branches at the
 * upper right, clusters of small five-petal flowers in crimson, rose, pink and a few white, an ink wash at the base).
 *
 * The tree lives in 2 × 1 units (x by the band's width ÷ 2, y and all widths by its height). The big skeleton (trunk
 * into the long limb) is art-directed as a curve through jittered points; the crown and all twigs grow procedurally
 * (angular plum kinks, side shoots along the branches, upward tropism for thick parts and droop for thin ones). Widths
 * follow the pipe model: a point's width² is proportional to the twig tips beyond it, so the trunk is heavy and the
 * twigs are hair fine. Branches are filled tapered shapes with a little edge noise; thick parts get a dark core, a lit
 * rim and dry-brush streaks so they read on the dark band.
 *
 * Motion: the tree grows for GROW s (fast at first; the front tapers; the trunk comes up thick), the blossoms open after
 * their twig (a small overshoot), then a slow wind with gusts sways the thin parts, more toward the tips, travelling
 * outward; a few petals let go and drift left. What never moves (moon, wash, trunk, thick limbs and their blossoms) is
 * drawn once per size into a bitmap; a frame draws that bitmap, the live twigs in one path and the blossoms as sprites.
 */
import { seeded, type Artwork, type RGB, type Size } from './artworks'

/** Seconds: the skeleton's growth; blossoms open between OPEN_FROM and OPEN_TO; after DONE the still parts are cached. */
const GROW = 3.5
const OPEN_FROM = 1.6
const OPEN_TO = 5
const OPEN_DUR = 0.55
const DONE = OPEN_TO + OPEN_DUR + 0.1
/** The twigs' step, in units. */
const STEP = 0.012
/** The trunk's width at its base (× band height), before the flare. */
const TRUNK_W = 0.054
/** The growth front's taper length, in units. */
const TAPER = 0.06
/** Falling petals at most at once. */
const PETALS = 56

/** The wind's reach in band heights (A1 the slow spring, A2 the quick one, A3 the travelling wave) and the wave's speeds: one source for the 2D painter and the GPU (gl.ts). */
export const WIND = { A1: 0.013, A2: 0.005, A3: 0.0012, xt: 1.1, xs: 2.2, yt: 0.9, ys: 1.8, yk: 0.6 } as const
/**
 * The parallax as depth, in CSS px at the band's edge per unit of depth: the trunk and the main limb at depth 1 (DEPTH.tree
 * px), the moon and the ground wash behind (fewer px), the crown's branches spread in front of and behind the limb, the
 * falling petals nearest. One source for the 2D painter and the GPU.
 */
export const DEPTH = { tree: 15, moon: 5, wash: 3, petals: 1.3, crown: 0.4, limb: 0.25, twig: 0.1 } as const
/** Atlas of the flower sprites for the GPU: one row of cells, each flower at FLOWER_FILL of its cell (room for mipmaps). */
export const ATLAS = { cell: 64, cells: 16, fill: 0.8 } as const

/** What the GPU paints of the tree after its growth (gl.ts); built once per size, the wind and petals per frame. */
export interface TreeLayer {
  /** The size it was built for (a new size builds a new layer, which the GPU uploads again). */
  key: string
  /** The moon and the ground wash, each a bitmap at device pixels on its own depth. */
  moon: HTMLCanvasElement
  wash: HTMLCanvasElement
  /** The still trunk, its flowers, splatter and fallen petals (depth 1). */
  still: HTMLCanvasElement
  /** Triangles of the swaying bark: x, y (CSS px at rest), arm, flex, path length, depth, premultiplied r, g, b, a. */
  mesh: Float32Array
  /** One per flower or bud: x, y, half size, atlas cell (−1 for a bud's disc), premultiplied r, g, b, a, arm, flex, path length, depth. */
  sprites: Float32Array
}
export interface TreeFrame {
  layer: TreeLayer
  /** slow x, slow y, quick x, quick y, t, A1, A2, A3 (CSS px). */
  sway: Float32Array
  /** Per petal: x, y, rx, ry, turn, alpha, colour index, 0 (CSS px); `petalCount` of them. */
  petals: Float32Array
  petalCount: number
}
export interface TreeGpu {
  /** The flower atlas (ATLAS), drawn once. */
  atlas: HTMLCanvasElement
  /** The petal colours, 0…255. */
  petalColours: number[][]
  /** True when the GPU can paint the tree at t (after its growth; before, the 2D painter draws it). */
  ready(t: number): boolean
  frame(t: number, size: Size, dpr: number, pointer: readonly [number, number]): TreeFrame
}

const css = ([r, g, b]: RGB, a: number): string => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1]
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOut = (u: number): number => 1 - Math.pow(1 - clamp01(u), 2.4)
const easeOutInv = (v: number): number => 1 - Math.pow(1 - clamp01(v), 1 / 2.4)
const backOut = (u: number): number => {
  const c = 1.9
  const x = clamp01(u) - 1
  return 1 + (c + 1) * x * x * x + c * x * x
}
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
const steer = (a: number, target: number, k: number): number => a + wrap(target - a) * k

interface Branch {
  first: number
  /** One past the last point. */
  end: number
  parent: number
  /** The parent's point it grows from (-1 for the trunk). */
  attach: number
  level: number
  /** The first point that sways (end when none does). */
  split: number
}

interface Grow {
  x: number
  y: number
  angle: number
  length: number
  level: number
  maxLevel: number
  attach: number
  parent: number
}

export const tree: Artwork = {
  id: 'tree',
  parallax: DEPTH.tree,
  init(seed, palette) {
    const random = seeded(seed)
    const range = (a: number, b: number): number => a + (b - a) * random()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // ---------- Colours ----------
    // Every colour as drawn in this theme (artworks.ts: the dark tokens, or the light band by hand).
    const bark = palette.colour('splash-tree-bark')
    const core = palette.colour('splash-tree-core')
    const rim = palette.colour('splash-tree-rim')
    const moon = palette.colour('splash-moon')
    const moonEdge = palette.colour('splash-moon-edge')
    const blossomColours = ['crimson', 'rose', 'pink', 'pale', 'white'].map((n) => palette.colour(`splash-blossom-${n}`))
    const stamen = palette.colour('splash-stamen')
    const flowerDeep = palette.colour('splash-flower-deep')
    const budDeep = palette.colour('splash-bud-deep')
    const washRim = palette.colour('splash-wash')
    const washPool = palette.colour('splash-wash-pool')
    const A = (name: string, dark: number): number => palette.alpha(name, dark)
    // This launch's colour mix: crimson and rose lead, a few white.
    const weights = [0.42, 0.3, 0.15, 0.08, 0.05].map((w) => w * range(0.6, 1.45))
    const weightSum = weights.reduce((a, b) => a + b, 0)
    const pickColour = (): number => {
      let r = random() * weightSum
      for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return i
      return 0
    }

    // ---------- The skeleton: points of all branches in flat arrays ----------
    const PX: number[] = []
    const PY: number[] = []
    const PS: number[] = [] // path length from the root, in units
    const branches: Branch[] = []

    const addBranch = (pts: number[], parent: number, attach: number, level: number): number => {
      const first = PX.length
      let s = attach >= 0 ? PS[attach] : 0
      for (let i = 0; i < pts.length; i += 2) {
        if (i) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1])
        PX.push(pts[i])
        PY.push(pts[i + 1])
        PS.push(s)
      }
      branches.push({ first, end: PX.length, parent, attach, level, split: PX.length })
      return branches.length - 1
    }

    // Trunk into the long limb: a Catmull-Rom curve through art-directed points, jittered per launch.
    const lean = range(-0.02, 0.02)
    const sway = range(0.6, 1.25)
    const control: [number, number][] = [
      [1.665, 1.04],
      [1.688 + 0.012 * sway, 0.925],
      [1.684 + 0.018 * sway, 0.815],
      [1.645, 0.725],
      [1.632 + 0.012 * sway, 0.625],
      [1.582 + lean, 0.535],
      [1.45, 0.47 + range(-0.02, 0.01)],
      [1.26, 0.485 + range(-0.02, 0.02)],
      [1.03, 0.535 + range(-0.02, 0.025)],
      [0.78, 0.56 + range(-0.025, 0.02)],
      [0.52, 0.535 + range(-0.02, 0.02)],
      [0.3, 0.5 + range(-0.03, 0.02)],
      [0.15 + range(-0.02, 0.02), 0.46 + range(-0.03, 0.02)]
    ]
    for (let i = 1; i < control.length; i++) {
      const k = i < 5 ? 0.005 : 0.028
      control[i][0] += range(-k, k)
      control[i][1] += range(-k, k)
    }
    // The tree at 84 % of the band, scaled about its base: more air around it.
    for (const p of control) {
      p[0] = 1.665 + (p[0] - 1.665) * 0.84
      p[1] = 1.0 + (p[1] - 1.0) * 0.84
    }
    const BEND = 5
    const curve: number[] = []
    let bendAt = 0
    {
      // Dense samples, then resampled by arc length at 0.01.
      const dense: number[] = []
      for (let i = 0; i < control.length - 1; i++) {
        const p0 = control[Math.max(0, i - 1)]
        const p1 = control[i]
        const p2 = control[i + 1]
        const p3 = control[Math.min(control.length - 1, i + 2)]
        for (let j = 0; j < 24; j++) {
          const u = j / 24
          const u2 = u * u
          const u3 = u2 * u
          const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3)
          dense.push(f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]))
          if (i === BEND && j === 0) bendAt = dense.length / 2 - 1
        }
      }
      dense.push(...control[control.length - 1])
      let acc = 0
      let next = 0
      let bendS = 0
      for (let i = 0; i < dense.length; i += 2) {
        if (i) acc += Math.hypot(dense[i] - dense[i - 2], dense[i + 1] - dense[i - 1])
        if (i / 2 === bendAt) bendS = acc
        if (acc >= next) {
          curve.push(dense[i], dense[i + 1])
          next += 0.01
        }
      }
      bendAt = Math.round(bendS / 0.01)
    }
    addBranch(curve, -1, -1, 0)

    // Branches and twigs: smooth curves. The heading turns continuously (two slow waves of curvature per branch, a
    // light-seeking pull, a slight bow under the weight of long branches, a curl at the end); side branches leave at
    // 25–45° and sweep upward. Parents before children, from a queue.
    const queue: Grow[] = []
    const inTitle = (x: number, y: number): boolean => (x < 0.82 && y > 0.74) || y > 0.9
    const grow = (g: Grow): void => {
      const pts = [g.x, g.y]
      const shoots: Grow[] = []
      let a = g.angle
      let x = g.x
      let y = g.y
      const bend = g.level <= 1 ? 1.2 : 2.4
      const w1 = { f: range(7, 14), amp: range(1.4, 3.2) * bend * (random() < 0.5 ? -1 : 1), p: range(0, 6.28) }
      const w2 = { f: range(18, 32), amp: range(0.6, 1.6) * bend, p: range(0, 6.28) }
      const curl = (random() < 0.5 ? -1 : 1) * range(0.6, 1.3)
      const long = g.length > 0.15
      let nextShoot = range(0.025, 0.05)
      let side = random() < 0.5 ? -1 : 1
      for (let d = STEP; d <= g.length; d += STEP) {
        const frac = d / g.length
        a += (w1.amp * Math.sin(w1.f * d + w1.p) + w2.amp * Math.sin(w2.f * d + w2.p)) * STEP
        // Seek the light; the thinnest twigs droop a little; long branches bow under their weight toward the end.
        if (g.level >= 4) a = steer(a, Math.PI / 2, 0.006)
        else a = steer(a, -Math.PI / 2, g.level <= 1 ? 0.01 : 0.014)
        if (long) a = steer(a, Math.PI / 2, 0.012 * frac * frac)
        if (frac > 0.75) a += (curl * 2 * ((frac - 0.75) / 0.25) * STEP) / (0.25 * g.length)
        // Keep the top margin and the band's sides.
        if (y < 0.16 && Math.sin(a) < 0.2) a = steer(a, Math.cos(a) >= 0 ? 0.25 : Math.PI - 0.25, 0.1)
        if (x > 1.9 && Math.cos(a) > 0) a = steer(a, Math.PI / 2, 0.08)
        if (d >= nextShoot) {
          nextShoot += range(0.03, 0.065)
          if (random() < 0.7) side = -side
          const left = g.length - d
          if (g.level < g.maxLevel && left > 0.025 && random() < (g.level <= 1 ? 0.8 : 0.66)) {
            shoots.push({ ...g, angle: a + side * range(0.44, 0.78), length: Math.min(left * range(0.5, 0.85), g.length * 0.62), level: g.level + 1, attach: pts.length / 2, x: 0, y: 0 })
          } else if (g.level < 5 && random() < 0.5) {
            // A short spur: a carrier for blossoms.
            shoots.push({ ...g, angle: a + side * range(0.45, 0.8), length: range(0.018, 0.036), level: Math.max(g.level + 1, 4), maxLevel: 0, attach: pts.length / 2, x: 0, y: 0 })
          }
        }
        x += Math.cos(a) * STEP
        y += Math.sin(a) * STEP
        if (y < 0.075 || x > 1.975 || x < 0.03 || inTitle(x, y)) break
        pts.push(x, y)
        if (PX.length + pts.length / 2 > 9000) break
      }
      if (pts.length < 4) return
      const b = addBranch(pts, g.parent, g.attach, g.level)
      const first = branches[b].first
      for (const sh of shoots) {
        const local = Math.min(sh.attach, pts.length / 2 - 1)
        queue.push({ ...sh, attach: first + local, parent: b, x: PX[first + local], y: PY[first + local] })
      }
    }

    // The crown: 3 to 5 branches from the bend, up and to the right.
    const crownSpecs = [
      { deg: -62, len: 0.5 },
      { deg: -88, len: 0.42 },
      { deg: -34, len: 0.4 },
      { deg: -116, len: 0.3 },
      { deg: -12, len: 0.28 }
    ]
    const crownCount = 3 + Math.floor(random() * 3)
    for (let c = 0; c < crownCount; c++) {
      const spec = crownSpecs[c]
      const at = Math.max(4, Math.min(curve.length / 2 - 1, bendAt + Math.round(range(-7, 4))))
      queue.push({ x: PX[at], y: PY[at], angle: (spec.deg + range(-10, 10)) * (Math.PI / 180), length: spec.len * 0.84 * range(0.85, 1.15), level: 1, maxLevel: 4, attach: at, parent: 0 })
    }
    // Along the long limb: shoots mostly on the upper side, a few hanging.
    {
      const n = curve.length / 2
      for (let i = bendAt + Math.round(range(4, 8)); i < n - 3; i += Math.round(range(4, 8))) {
        const frac = (i - bendAt) / (n - bendAt)
        const up = random() < 0.8
        // The limb's own heading here; a shoot leaves it at 25–45° forward, upward (a few hang down), then rises.
        const heading = Math.atan2(PY[i + 2] - PY[i - 2], PX[i + 2] - PX[i - 2])
        const angle = up ? heading + range(0.44, 0.8) : heading - range(0.4, 0.7)
        const len = (0.06 + 0.2 * Math.pow(1 - frac, 0.8)) * range(0.6, 1.25) * (up ? 1 : 0.55)
        queue.push({ x: PX[i], y: PY[i], angle, length: len, level: 2, maxLevel: 5, attach: i, parent: 0 })
      }
    }
    while (queue.length) grow(queue.shift()!)

    const N = PX.length
    const level = new Uint8Array(N)
    const branchOf = new Int32Array(N)
    branches.forEach((b, bi) => {
      for (let i = b.first; i < b.end; i++) {
        level[i] = b.level
        branchOf[i] = bi
      }
    })

    // ---------- Widths: the pipe model, by the length of wood beyond each point ----------
    // A point's width^(1/0.45) grows with all the branch length it carries (its own rest and every side branch beyond
    // it), so a branch thins all along its way, and at a fork the way on keeps nearly its width while a side twig
    // starts thin.
    const W = new Float32Array(N)
    {
      const L0 = 0.03
      const contrib = new Float64Array(N)
      const down = new Float64Array(N)
      for (let bi = branches.length - 1; bi >= 0; bi--) {
        const b = branches[bi]
        let acc = 0
        for (let i = b.end - 1; i >= b.first; i--) {
          if (i < b.end - 1) acc += PS[i + 1] - PS[i]
          acc += contrib[i]
          down[i] = acc
        }
        if (b.attach >= 0) contrib[b.attach] += acc
      }
      const c = TRUNK_W / Math.pow(down[0] + L0, 0.45)
      const knots = Array.from({ length: 3 }, () => ({ s: range(0.1, 0.5), k: range(0.06, 0.12) }))
      for (const b of branches) {
        for (let i = b.first; i < b.end; i++) {
          let w = c * Math.pow(down[i] + L0, 0.45)
          if (b.level === 0) {
            w *= 1 + 0.55 * Math.exp(-PS[i] / 0.045)
            for (const kn of knots) w *= 1 + kn.k * Math.exp(-(((PS[i] - kn.s) / 0.025) ** 2))
          }
          W[i] = w
        }
      }
    }

    // ---------- What sways: the whole tree above the lower trunk, as one ----------
    // `arm`: how far along the tree from the still trunk (the limb and the big branches carry everything on them);
    // `flex`: the extra give of thin wood on top. The lower trunk is still and goes into the bitmap.
    const still = new Uint8Array(N)
    const arm = new Float32Array(N)
    const flex = new Float32Array(N)
    const sStill = PS[Math.min(bendAt, branches[0].end - 1)] - 0.08
    {
      let maxFlex = 0
      for (const b of branches) {
        let f = b.attach >= 0 ? flex[b.attach] : 0
        for (let i = b.first; i < b.end; i++) {
          const st = b.level === 0 && PS[i] < sStill
          still[i] = st ? 1 : 0
          if (!st && i > b.first) f += (PS[i] - PS[i - 1]) * (0.0025 / Math.max(W[i], 0.0012))
          flex[i] = st ? 0 : f
          arm[i] = Math.pow(clamp01((PS[i] - sStill) / 0.9), 1.1)
          if (!st && b.split === b.end) b.split = i
          if (f > maxFlex) maxFlex = f
        }
      }
      for (let i = 0; i < N; i++) flex[i] = maxFlex ? Math.pow(flex[i] / maxFlex, 0.8) : 0
    }
    const live: number[] = []
    for (let i = 0; i < N; i++) if (!still[i]) live.push(i)
    const maxS = PS.reduce((m, s) => Math.max(m, s), 0)
    /** The time the growth front reaches path length s. */
    const reachAt = (s: number): number => GROW * easeOutInv(s / maxS)

    // ---------- Depth: each branch at its own distance, for the parallax ----------
    // The trunk and the limb at 1; a crown branch eases from its parent's depth to its own within its first stretch, so
    // branches slide against each other and never come apart at a fork. Its own random source keeps the tree's look.
    const depth = new Float32Array(N)
    {
      const r = seeded(seed ^ 0x5eedde97)
      const spread = (k: number): number => (r() * 2 - 1) * k
      for (const b of branches) {
        const from = b.attach >= 0 ? depth[b.attach] : 1
        const target = b.level === 0 ? 1 : b.level === 1 ? 1 + spread(DEPTH.crown) : b.parent === 0 ? 1 + spread(DEPTH.limb) : from + spread(DEPTH.twig)
        const s0 = PS[b.first]
        for (let i = b.first; i < b.end; i++) {
          const u = clamp01((PS[i] - s0) / 0.12)
          depth[i] = from + (target - from) * u * u * (3 - 2 * u)
        }
      }
    }
    /** The eased pointer (−1…1 each way), for the depth offsets. */
    const pointer: [number, number] = [0, 0]

    // Edge noise per point (smooth): bark is not a clean curve.
    const edgeA = new Float32Array(N)
    const edgeB = new Float32Array(N)
    {
      let a = 0
      let b = 0
      for (let i = 0; i < N; i++) {
        a = a * 0.8 + (random() - 0.5) * 0.9
        b = b * 0.8 + (random() - 0.5) * 0.9
        edgeA[i] = a
        edgeB[i] = b
      }
    }

    // Dry-brush streaks and knots on the thick bark.
    const streaks: { from: number; to: number; off: number; alpha: number; dash: number[]; lw: number }[] = []
    for (const b of branches) {
      if (b.level > 1) continue
      const thick = (i: number): boolean => W[i] > 0.011 && still[i] === 1
      const count = b.level === 0 ? 9 : 2
      for (let k = 0; k < count; k++) {
        const a = b.first + Math.floor(random() * (b.end - b.first))
        if (!thick(a)) continue
        let e = a
        const len = Math.round(range(8, b.level === 0 ? 40 : 18))
        while (e < b.end - 1 && e - a < len && thick(e + 1)) e++
        if (e - a < 4) continue
        const dash: number[] = []
        for (let j = 0; j < 6; j++) dash.push(range(4, 26), range(1.5, 6))
        streaks.push({ from: a, to: e, off: range(-0.55, 0.55), alpha: range(0.06, 0.16), dash, lw: range(0.5, 1.1) })
      }
    }
    const rimDash: number[] = []
    for (let j = 0; j < 8; j++) rimDash.push(range(10, 60), range(1.5, 8))
    const knotList = Array.from({ length: 3 + Math.floor(random() * 3) }, () => {
      const i = Math.floor(range(0.08, 0.95) * Math.min(N, branches[0].split))
      return { i, side: random() < 0.5 ? -1 : 1, r: range(0.1, 0.17), stretch: range(1.1, 1.5) }
    })

    // ---------- Blossoms ----------
    interface Bloom {
      at: number
      ox: number
      oy: number
      r: number
      colour: number
      bud: boolean
      open: number
      variant: number
    }
    const blooms: Bloom[] = []
    const addCluster = (at: number, density: number): void => {
      const flowers = Math.round(range(1.5, 5.5) * density)
      const buds = Math.floor(range(0, 2.6))
      for (let k = 0; k < flowers + buds; k++) {
        const ang = range(0, Math.PI * 2)
        const rad = Math.sqrt(random()) * 0.016
        const ox = Math.cos(ang) * rad
        const oy = Math.sin(ang) * rad * 0.8 - 0.003
        const x = PX[at] + ox
        const y = PY[at] + oy
        if (inTitle(x, y) || (x > 1.74 && y > 0.86)) continue
        const bud = k >= flowers
        const open = Math.min(OPEN_TO, Math.max(OPEN_FROM, reachAt(PS[at]) + range(0.1, 0.9)))
        blooms.push({ at, ox, oy, r: bud ? range(0.0018, 0.003) : range(0.0042, 0.0082), colour: bud ? (random() < 0.7 ? 0 : 1) : pickColour(), bud, open, variant: Math.floor(random() * 3) })
      }
    }
    for (const b of branches) {
      const n = b.end - b.first
      for (let j = 1; j < n; j++) {
        const i = b.first + j
        if (W[i] > 0.016) continue
        const frac = j / n
        const x = PX[i]
        const y = PY[i]
        const crown = x > 1.22 && y < 0.6 ? 1 : 0
        let p = b.level === 0 ? 0.3 : b.level === 1 ? 0.22 : 0.36
        p *= crown ? 1.35 : 0.85
        if (frac > 0.88) p *= 0.45
        if (b.level >= 4) p *= 1.3
        if (random() < p) addCluster(i, crown ? 1.15 : 0.9)
      }
    }
    // Draw order: a light flower may sit on a dark one, buds last.
    blooms.sort((a, b) => Number(a.bud) - Number(b.bud) || a.colour - b.colour)

    // Ink splatter around the crown, and petals already fallen at the base.
    const splatter = Array.from({ length: 34 }, () => {
      const crown = random() < 0.8
      const ang = range(0, Math.PI * 2)
      const rad = Math.pow(random(), 0.6) * (crown ? 0.36 : 0.5)
      return {
        x: crown ? 1.66 + Math.cos(ang) * rad * 1.1 : range(0.3, 1.4),
        y: crown ? 0.3 + Math.sin(ang) * rad * 0.7 : 0.45 + range(-0.12, 0.08),
        r: range(0.0012, 0.0045),
        colour: random() < 0.75 ? 0 : 1,
        alpha: range(0.18, 0.45)
      }
    }).filter((d) => d.y > 0.06 && d.y < 0.9 && d.x < 1.98)
    const fallen = Array.from({ length: 16 }, () => ({
      x: 1.66 + range(-0.34, 0.2),
      y: range(0.955, 0.99),
      r: range(0.003, 0.006),
      rot: range(0, Math.PI),
      colour: pickColour(),
      alpha: range(0.35, 0.7)
    }))

    // Falling petals: deterministic in t (slot, cycle) so a still frame needs no history.
    const sources = blooms.filter((b) => !b.bud && PY[b.at] < 0.7)
    const slots = Array.from({ length: PETALS }, () => ({ period: range(5, 9), offset: range(0, 9), drift: range(0.8, 1.25), spin: range(1.2, 3.2), wob: range(0, 6.28) }))
    const hash = (a: number, b: number): number => {
      let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
      h ^= h >>> 15
      return (Math.imul(h, 0x27d4eb2f) >>> 0) / 4294967296
    }

    // Wind: a slow lean with gusts, the moon's place, per launch.
    const gustPhase = [range(0, 6.28), range(0, 6.28)]
    const moonX = 1.1 + range(-0.04, 0.04)
    const moonY = 0.45 + range(-0.03, 0.03)
    const moonR = 0.36 * range(0.95, 1.05)

    // ---------- Flower sprites: per colour, three turns ----------
    const SPRITE = 40
    /** One five-petal flower of radius R centred at the origin of `g`. */
    const drawFlower = (g: CanvasRenderingContext2D, R: number, c: RGB, v: number): void => {
      const turn = (v * 2 * Math.PI) / 15
      const deep = mix(c, flowerDeep, 0.35)
      for (let k = 0; k < 5; k++) {
        const a = turn + (k * 2 * Math.PI) / 5
        g.beginPath()
        g.ellipse(Math.cos(a) * R * 0.46, Math.sin(a) * R * 0.46, R * 0.5, R * 0.4, a, 0, Math.PI * 2)
        g.fillStyle = css(c, 0.95)
        g.fill()
      }
      g.beginPath()
      g.arc(0, 0, R * 0.26, 0, Math.PI * 2)
      g.fillStyle = css(deep, 0.9)
      g.fill()
      for (let k = 0; k < 5; k++) {
        const a = turn + 0.6 + (k * 2 * Math.PI) / 5
        g.beginPath()
        g.arc(Math.cos(a) * R * 0.2, Math.sin(a) * R * 0.2, R * 0.07, 0, Math.PI * 2)
        g.fillStyle = css(stamen, 0.9)
        g.fill()
      }
    }
    const sprites = blossomColours.map((c) =>
      [0, 1, 2].map((v) => {
        const cv = document.createElement('canvas')
        cv.width = cv.height = SPRITE
        const g = cv.getContext('2d')!
        g.translate(SPRITE / 2, SPRITE / 2)
        drawFlower(g, SPRITE / 2, c, v)
        return cv
      })
    )
    /** The same flowers in one row for the GPU: cell colour × 3 + turn. */
    const atlas = document.createElement('canvas')
    atlas.width = ATLAS.cell * ATLAS.cells
    atlas.height = ATLAS.cell
    {
      const g = atlas.getContext('2d')!
      blossomColours.forEach((c, ci) =>
        [0, 1, 2].forEach((v) => {
          g.setTransform(1, 0, 0, 1, (ci * 3 + v + 0.5) * ATLAS.cell, ATLAS.cell / 2)
          drawFlower(g, (ATLAS.cell / 2) * ATLAS.fill, c, v)
        })
      )
    }
    /** A bud's colour (also on the GPU). */
    const budColour = (c: number): RGB => mix(blossomColours[c], budDeep, 0.2)

    // ---------- Per-size state ----------
    let sizeKey = ''
    let sx = 1
    let sy = 1
    const X = new Float32Array(N)
    const Y = new Float32Array(N)
    const baseX = new Float32Array(N)
    const baseY = new Float32Array(N)
    // Scratch for one branch shape's outline: its spine (C), left (L) and right (R) edges, half-widths and spine points.
    const CX = new Float32Array(4096)
    const CY = new Float32Array(4096)
    const LX = new Float32Array(4096)
    const LY = new Float32Array(4096)
    const RX = new Float32Array(4096)
    const RY = new Float32Array(4096)
    const HW = new Float32Array(4096)
    const IDX = new Int32Array(4096)

    let moonCache: HTMLCanvasElement | null = null
    let washCache: HTMLCanvasElement | null = null
    let fullCache: HTMLCanvasElement | null = null

    const setSize = (size: Size, dpr: number): void => {
      const key = `${size.w}x${size.h}@${dpr}`
      if (key === sizeKey) return
      sizeKey = key
      sx = size.w / 2
      sy = size.h
      for (let i = 0; i < N; i++) {
        baseX[i] = X[i] = PX[i] * sx
        baseY[i] = Y[i] = PY[i] * sy
      }
      moonCache = null
      washCache = null
      fullCache = null
    }

    /**
     * The outline of one branch range [a, b] as a tapered shape: up to the growth front D, widths × k, into the scratch
     * arrays (left edge L, right edge R, spine point IDX). Returns the number of points.
     */
    const outline = (a: number, b: number, D: number, k: number, noise: number, core: boolean): number => {
      let n = 0
      const H = sy
      for (let i = a; i <= b && n < 4095; i++) {
        if (PS[i] > D) {
          // The front: a point between the last visible one and this one.
          if (i > a) {
            const p = i - 1
            const u = (D - PS[p]) / Math.max(1e-6, PS[i] - PS[p])
            CX[n] = X[p] + (X[i] - X[p]) * u
            CY[n] = Y[p] + (Y[i] - Y[p]) * u
            HW[n] = core ? 0 : 0.15
            IDX[n] = p
            n++
          }
          break
        }
        CX[n] = X[i]
        CY[n] = Y[i]
        const front = D === Infinity ? 1 : Math.min(1, 0.2 + (D - PS[i]) / TAPER)
        const hw = W[i] * H * 0.5 * k * front
        HW[n] = core ? Math.max(0, hw * 0.84 - 0.5) : Math.max(0.12, hw)
        IDX[n] = i
        n++
      }
      if (n < 2) return 0
      for (let j = 0; j < n; j++) {
        const p = j ? j - 1 : 0
        const q = j < n - 1 ? j + 1 : n - 1
        let tx = CX[q] - CX[p]
        let ty = CY[q] - CY[p]
        const len = Math.hypot(tx, ty) || 1
        tx /= len
        ty /= len
        const i = IDX[j]
        const hw = HW[j]
        const na = hw * (1 + noise * 0.12 * edgeA[i])
        const nb = hw * (1 + noise * 0.1 * edgeB[i])
        // The core sits toward the shadow side (away from the upper left), so the lit bark shows on one side.
        let cx = CX[j]
        let cy = CY[j]
        if (core) {
          const lit = -ty + tx > 0 ? -1 : 1
          const shift = W[i] * sy * 0.5 * k * 0.24 * lit
          cx += ty * shift
          cy -= tx * shift
        }
        RX[j] = cx + ty * nb
        RY[j] = cy - tx * nb
        LX[j] = cx - ty * na
        LY[j] = cy + tx * na
      }
      return n
    }

    /** One branch range as a filled tapered shape into the current path (see outline). */
    const branchShape = (ctx: CanvasRenderingContext2D, a: number, b: number, D: number, k: number, noise: number, core = false): void => {
      const n = outline(a, b, D, k, noise, core)
      if (!n) return
      ctx.moveTo(LX[0], LY[0])
      for (let j = 1; j < n; j++) ctx.lineTo(LX[j], LY[j])
      for (let j = n - 1; j >= 0; j--) ctx.lineTo(RX[j], RY[j])
      ctx.closePath()
    }

    /** A line along the spine of [a, b] at `off` × half-width to the lit (upper-left) side, into CX, CY and IDX. */
    const alongPoints = (a: number, b: number, D: number, off: number, k: number): number => {
      let n = 0
      for (let i = a; i <= b && n < 4095; i++) {
        if (PS[i] > D) break
        const p = i > a ? i - 1 : i
        const q = i < b ? i + 1 : i
        let tx = X[q] - X[p]
        let ty = Y[q] - Y[p]
        const len = Math.hypot(tx, ty) || 1
        tx /= len
        ty /= len
        let nx = -ty
        let ny = tx
        if (nx + ny > 0) {
          nx = -nx
          ny = -ny
        }
        const hw = W[i] * sy * 0.5 * k * (D === Infinity ? 1 : Math.min(1, 0.2 + (D - PS[i]) / TAPER))
        CX[n] = X[i] + nx * hw * off
        CY[n] = Y[i] + ny * hw * off
        IDX[n] = i
        n++
      }
      return n
    }
    const along = (ctx: CanvasRenderingContext2D, a: number, b: number, D: number, off: number, k: number): void => {
      const n = alongPoints(a, b, D, off, k)
      for (let j = 0; j < n; j++) {
        if (j) ctx.lineTo(CX[j], CY[j])
        else ctx.moveTo(CX[j], CY[j])
      }
    }

    // ---------- Painting ----------

    const paintMoon = (ctx: CanvasRenderingContext2D): void => {
      const cx = moonX * sx
      const cy = moonY * sy
      const r = moonR * sy
      // A soft halo, the disc, its faint embossed rim.
      const halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.45)
      halo.addColorStop(0, css(moon, A('moon-halo', 0.025)))
      halo.addColorStop(1, css(moon, 0))
      ctx.fillStyle = halo
      ctx.fillRect(cx - r * 1.5, cy - r * 1.5, r * 3, r * 3)
      const disc = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r)
      disc.addColorStop(0, css(moon, A('moon-disc-0', 0.085)))
      disc.addColorStop(0.7, css(moon, A('moon-disc-1', 0.065)))
      disc.addColorStop(1, css(moon, A('moon-disc-2', 0.05)))
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = disc
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = css(moonEdge, A('moon-edge', 0.11))
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx - 0.8, cy - 0.8, r - 1.2, Math.PI * 0.75, Math.PI * 1.6)
      ctx.strokeStyle = css(moonEdge, A('moon-emboss', 0.07))
      ctx.stroke()
    }

    const paintWash = (ctx: CanvasRenderingContext2D): void => {
      // The ink wash at the base: a dark pool under the trunk, soft warm smears and dry-brush lines to the left.
      const bx = 1.665 * sx
      const by = 0.985 * sy
      const smear = (x: number, y: number, rx: number, ry: number, colour: RGB, alpha: number): void => {
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(1, ry / rx)
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
        g.addColorStop(0, css(colour, alpha))
        g.addColorStop(1, css(colour, 0))
        ctx.fillStyle = g
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
        ctx.restore()
      }
      smear(bx - 0.25 * sx, by + 0.01 * sy, 0.6 * sx, 0.05 * sy, washRim, 0.05 * A('wash', 1))
      smear(bx - 0.05 * sx, by, 0.28 * sx, 0.04 * sy, washRim, 0.05 * A('wash', 1))
      smear(bx, by + 0.01 * sy, 0.16 * sx, 0.035 * sy, washPool, A('wash-pool', 0.7))
      ctx.lineCap = 'round'
      for (let k = 0; k < 7; k++) {
        const y = by + (hash(k, 7) - 0.3) * 0.03 * sy
        const x0 = bx + (hash(k, 3) * 0.2 - 0.05) * sx
        const x1 = x0 - (0.2 + hash(k, 5) * 0.75) * sx
        const g = ctx.createLinearGradient(x0, 0, x1, 0)
        g.addColorStop(0, css(washRim, (0.07 + 0.05 * hash(k, 9)) * A('wash', 1)))
        g.addColorStop(1, css(washRim, 0))
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(x1, y + (hash(k, 11) - 0.5) * 2)
        ctx.strokeStyle = g
        ctx.lineWidth = 0.6 + hash(k, 13) * 1.2
        ctx.stroke()
      }
    }

    /** The bark of branch ranges: fill and the dark core, the lit rim along `rimRanges`, and with `marks` the streaks and knots. */
    const paintBark = (ctx: CanvasRenderingContext2D, ranges: [number, number][], D: number, k: number, rimRanges: [number, number][], marks: boolean): void => {
      ctx.beginPath()
      for (const [a, b] of ranges) branchShape(ctx, a, b, D, k, 1)
      ctx.fillStyle = css(bark, 1)
      ctx.fill()
      ctx.beginPath()
      for (const [a, b] of ranges) if (W[a] * sy * k > 2.4) branchShape(ctx, a, b, D, k, 1.4, true)
      ctx.fillStyle = css(core, 1)
      ctx.fill()
      // The lit rim: broken, on the upper-left side.
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.setLineDash(rimDash)
      ctx.beginPath()
      for (const [a, b] of rimRanges) if (W[a] * sy > 2.6) along(ctx, a, b, D, 0.86, k)
      ctx.strokeStyle = css(rim, 0.3)
      ctx.lineWidth = 0.9
      ctx.stroke()
      ctx.setLineDash([])
      if (!marks) return
      for (const s of streaks) {
        if (PS[s.from] > D) continue
        ctx.setLineDash(s.dash)
        ctx.beginPath()
        along(ctx, s.from, s.to, D, s.off, k)
        ctx.strokeStyle = css(rim, s.alpha)
        ctx.lineWidth = s.lw
        ctx.stroke()
      }
      ctx.setLineDash([])
      for (const kn of knotList) {
        if (PS[kn.i] > D) continue
        const i = kn.i
        const p = Math.max(0, i - 1)
        const q = Math.min(N - 1, i + 1)
        const ang = Math.atan2(Y[q] - Y[p], X[q] - X[p])
        const hw = W[i] * sy * 0.5 * k
        const x = X[i] - Math.sin(ang) * hw * 0.35 * kn.side
        const y = Y[i] + Math.cos(ang) * hw * 0.35 * kn.side
        ctx.beginPath()
        ctx.ellipse(x, y, hw * kn.r * kn.stretch, hw * kn.r, ang, 0, Math.PI * 2)
        ctx.fillStyle = css(core, 1)
        ctx.fill()
        ctx.beginPath()
        ctx.ellipse(x, y, hw * kn.r * kn.stretch, hw * kn.r, ang, Math.PI * 0.9, Math.PI * 1.9)
        ctx.strokeStyle = css(rim, 0.2)
        ctx.lineWidth = 0.7
        ctx.stroke()
      }
    }

    const paintBlooms = (ctx: CanvasRenderingContext2D, t: number, which: 'all' | 'still' | 'live'): void => {
      const H = sy
      const budPaths: number[][] = [[], []]
      for (const b of blooms) {
        if (which !== 'all' && (still[b.at] === 1) !== (which === 'still')) continue
        const u = (t - b.open) / OPEN_DUR
        if (u <= 0) continue
        const scale = u >= 1 ? 1 : backOut(u)
        const x = X[b.at] + b.ox * H
        const y = Y[b.at] + b.oy * H
        const r = b.r * H * scale
        if (b.bud) {
          budPaths[b.colour].push(x, y, Math.max(0.5, r))
          continue
        }
        ctx.drawImage(sprites[b.colour][b.variant], x - r, y - r, r * 2, r * 2)
      }
      for (let c = 0; c < 2; c++) {
        const list = budPaths[c]
        if (!list.length) continue
        ctx.beginPath()
        for (let j = 0; j < list.length; j += 3) {
          ctx.moveTo(list[j] + list[j + 2], list[j + 1])
          ctx.arc(list[j], list[j + 1], list[j + 2], 0, Math.PI * 2)
        }
        ctx.fillStyle = css(budColour(c), 0.95)
        ctx.fill()
      }
    }

    const paintSplatter = (ctx: CanvasRenderingContext2D, alpha: number): void => {
      if (alpha <= 0) return
      for (const d of splatter) {
        ctx.beginPath()
        ctx.arc(d.x * sx, d.y * sy, d.r * sy, 0, Math.PI * 2)
        ctx.fillStyle = css(blossomColours[d.colour], d.alpha * alpha)
        ctx.fill()
      }
      for (const f of fallen) {
        ctx.beginPath()
        ctx.ellipse(f.x * sx, f.y * sy, f.r * sy, f.r * sy * 0.45, f.rot, 0, Math.PI * 2)
        ctx.fillStyle = css(blossomColours[f.colour], f.alpha * alpha)
        ctx.fill()
      }
    }

    // The lit rim follows the trunk, the limb and the big branches.
    const rimAll: [number, number][] = []
    const rimLive: [number, number][] = []
    for (const b of branches) {
      if (b.level > 1) continue
      rimAll.push([b.first, b.end - 1])
      if (b.split < b.end) rimLive.push([Math.max(b.first, b.split - 1), b.end - 1])
    }
    const stillRanges: [number, number][] = []
    const liveRanges: [number, number][] = []
    const allRanges: [number, number][] = []
    for (const b of branches) {
      allRanges.push([b.first, b.end - 1])
      if (b.split > b.first) stillRanges.push([b.first, Math.min(b.split, b.end - 1)])
      if (b.split < b.end) liveRanges.push([Math.max(b.first, b.split - 1), b.end - 1])
    }
    /** A bitmap of the band at device pixels, painted once. */
    const bitmap = (dpr: number, size: Size, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement => {
      const cv = document.createElement('canvas')
      cv.width = Math.max(1, Math.round(size.w * dpr))
      cv.height = Math.max(1, Math.round(size.h * dpr))
      const g = cv.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint(g)
      return cv
    }
    /** The still trunk, its flowers, splatter and fallen petals. */
    const makeStill = (dpr: number, size: Size): HTMLCanvasElement =>
      bitmap(dpr, size, (g) => {
        for (let i = 0; i < N; i++) {
          X[i] = baseX[i]
          Y[i] = baseY[i]
        }
        paintSplatter(g, 1)
        paintBark(g, stillRanges, Infinity, 1, stillRanges, true)
        paintBlooms(g, DONE + 10, 'still')
      })
    /** The moon and the wash on their own depths, inside a context already shifted for depth 1. */
    const paintBack = (ctx: CanvasRenderingContext2D, size: Size, alpha: number): void => {
      ctx.globalAlpha = alpha
      ctx.drawImage(moonCache!, pointer[0] * (DEPTH.tree - DEPTH.moon), pointer[1] * (DEPTH.tree - DEPTH.moon), size.w, size.h)
      ctx.drawImage(washCache!, pointer[0] * (DEPTH.tree - DEPTH.wash), pointer[1] * (DEPTH.tree - DEPTH.wash), size.w, size.h)
    }

    // ---------- Motion: one tree on two damped springs ----------
    // The slow spring moves the limb and the big branches, which carry their twigs; the quicker one adds the give of
    // thin wood. Wind drives both: a lean to the left that breathes, with gusts.
    const slow = { x: 0, y: 0, vx: 0, vy: 0, w: 2 * Math.PI * 0.32, z: 0.28 }
    const quick = { x: 0, y: 0, vx: 0, vy: 0, w: 2 * Math.PI * 0.8, z: 0.32 }
    const springStep = (sp: typeof slow, fx: number, fy: number, dt: number): void => {
      sp.vx += (sp.w * sp.w * (fx - sp.x) - 2 * sp.z * sp.w * sp.vx) * dt
      sp.vy += (sp.w * sp.w * (fy - sp.y) - 2 * sp.z * sp.w * sp.vy) * dt
      sp.x += sp.vx * dt
      sp.y += sp.vy * dt
    }
    const advance = (t: number, dt: number): void => {
      for (let left = dt; left > 1e-6; left -= 1 / 120) {
        const h = Math.min(left, 1 / 120)
        const gust = Math.max(0.1, 0.55 + 0.35 * Math.sin(t * 0.17 + gustPhase[0]) + 0.25 * Math.sin(t * 0.43 + gustPhase[1]))
        const fx = -(0.25 + 0.5 * gust) + 0.18 * Math.sin(t * 0.61 + gustPhase[1])
        const fy = 0.1 * gust + 0.08 * Math.sin(t * 0.37 + gustPhase[0])
        springStep(slow, fx, fy, h)
        springStep(quick, fx, fy, h)
      }
    }

    /** Place the swaying points from the springs (a slight lag outward keeps it alive, never a jitter). */
    const windAt = (t: number): void => {
      const A1 = WIND.A1 * sy
      const A2 = WIND.A2 * sy
      const A3 = WIND.A3 * sy
      // The art is already shifted by the pointer at depth 1; a point at another depth moves by the difference.
      const ox = -pointer[0] * DEPTH.tree
      const oy = -pointer[1] * DEPTH.tree
      for (let j = 0; j < live.length; j++) {
        const i = live[j]
        const am = arm[i]
        const f = flex[i]
        const d = depth[i] - 1
        X[i] = baseX[i] + d * ox + am * A1 * slow.x + f * (A2 * quick.x + A3 * Math.sin(t * WIND.xt - PS[i] * WIND.xs))
        Y[i] = baseY[i] + d * oy + am * A1 * slow.y + f * (A2 * quick.y + A3 * WIND.yk * Math.cos(t * WIND.yt - PS[i] * WIND.ys))
      }
    }

    // ---------- Petals ----------
    let lastT = 0
    /** The petal colours as fill styles, made once: a petal's fade goes through globalAlpha, not a new colour string. */
    const petalFills = blossomColours.map((c) => css(c, 1))

    /** The petals in the air at t into `out` (8 floats each: x, y, rx, ry, turn, alpha, colour, 0); returns how many. */
    const petalsAt = (t: number, out: Float32Array): number => {
      if (reduced || !sources.length || t < DONE) return 0
      let n = 0
      const H = sy
      for (let j = 0; j < slots.length; j++) {
        const s = slots[j]
        const local = t - DONE - s.offset
        if (local < 0) continue
        const cycle = Math.floor(local / s.period)
        const tau = local - cycle * s.period
        const src = sources[Math.floor(hash(j, cycle) * sources.length)]
        const life = s.period * 0.9
        if (tau > life) continue
        // It drifts left and down with the wind, turns and fades.
        const x = (PX[src.at] + src.ox) * sx - tau * 0.05 * H * s.drift - tau * tau * 0.004 * H + Math.sin(tau * 1.3 + s.wob) * 0.012 * H
        const y = (PY[src.at] + src.oy) * sy + tau * 0.03 * H + tau * tau * 0.0012 * H
        if (y > H * 1.02 || x < -10) continue
        const r = src.r * 0.75 * H
        const spin = tau * s.spin + s.wob
        const o = n * 8
        out[o] = x
        out[o + 1] = y
        out[o + 2] = r
        out[o + 3] = Math.max(0.3, r * 0.55 * Math.abs(Math.cos(spin)))
        out[o + 4] = spin * 0.5
        out[o + 5] = Math.min(1, tau / 0.25) * Math.min(1, (life - tau) / (life * 0.45)) * 0.85
        out[o + 6] = src.colour
        out[o + 7] = 0
        n++
      }
      return n
    }
    const petalBuffer = new Float32Array(PETALS * 8)

    const paintPetals = (ctx: CanvasRenderingContext2D, t: number): void => {
      const n = petalsAt(t, petalBuffer)
      if (!n) return
      const base = ctx.globalAlpha
      // The petals are the nearest layer.
      const px = -pointer[0] * DEPTH.tree * (DEPTH.petals - 1)
      const py = -pointer[1] * DEPTH.tree * (DEPTH.petals - 1)
      ctx.translate(px, py)
      for (let j = 0; j < n; j++) {
        const o = j * 8
        ctx.globalAlpha = base * petalBuffer[o + 5]
        ctx.beginPath()
        ctx.ellipse(petalBuffer[o], petalBuffer[o + 1], petalBuffer[o + 2], petalBuffer[o + 3], petalBuffer[o + 4], 0, Math.PI * 2)
        ctx.fillStyle = petalFills[petalBuffer[o + 6]]
        ctx.fill()
      }
      ctx.translate(-px, -py)
      ctx.globalAlpha = base
    }

    // ---------- The GPU layer (after the growth) ----------
    let layer: TreeLayer | null = null
    /** The rim's dashes as thin quads (the 2D painter strokes them with setLineDash). */
    const buildLayer = (dpr: number, size: Size): TreeLayer => {
      if (!fullCache) fullCache = makeStill(dpr, size)
      if (!moonCache) moonCache = bitmap(dpr, size, paintMoon)
      if (!washCache) washCache = bitmap(dpr, size, paintWash)
      for (let i = 0; i < N; i++) {
        X[i] = baseX[i]
        Y[i] = baseY[i]
      }
      const mesh: number[] = []
      const vert = (x: number, y: number, i: number, c: RGB, a: number): void => {
        mesh.push(x, y, arm[i], flex[i], PS[i], depth[i], (c[0] / 255) * a, (c[1] / 255) * a, (c[2] / 255) * a, a)
      }
      const fillOutline = (n: number, c: RGB): void => {
        for (let j = 0; j < n - 1; j++) {
          const i0 = IDX[j]
          const i1 = IDX[j + 1]
          vert(LX[j], LY[j], i0, c, 1)
          vert(RX[j], RY[j], i0, c, 1)
          vert(LX[j + 1], LY[j + 1], i1, c, 1)
          vert(LX[j + 1], LY[j + 1], i1, c, 1)
          vert(RX[j], RY[j], i0, c, 1)
          vert(RX[j + 1], RY[j + 1], i1, c, 1)
        }
      }
      for (const [a, b] of liveRanges) fillOutline(outline(a, b, Infinity, 1, 1, false), bark)
      for (const [a, b] of liveRanges) if (W[a] * sy > 2.4) fillOutline(outline(a, b, Infinity, 1, 1.4, true), core)
      // The lit rim along the live limb and big branches: 0.9 px dashes at alpha 0.3.
      for (const [a, b] of rimLive) {
        if (W[a] * sy <= 2.6) continue
        const n = alongPoints(a, b, Infinity, 0.86, 1)
        let dash = 0
        let left = rimDash[0]
        let on = true
        for (let j = 0; j < n - 1; j++) {
          let x0 = CX[j]
          let y0 = CY[j]
          const x1 = CX[j + 1]
          const y1 = CY[j + 1]
          let seg = Math.hypot(x1 - x0, y1 - y0)
          const ux = seg ? (x1 - x0) / seg : 0
          const uy = seg ? (y1 - y0) / seg : 0
          while (seg > 1e-6) {
            const step = Math.min(seg, left)
            if (on) {
              const nx = -uy * 0.45
              const ny = ux * 0.45
              const xe = x0 + ux * step
              const ye = y0 + uy * step
              vert(x0 + nx, y0 + ny, IDX[j], rim, 0.3)
              vert(x0 - nx, y0 - ny, IDX[j], rim, 0.3)
              vert(xe + nx, ye + ny, IDX[j + 1], rim, 0.3)
              vert(xe + nx, ye + ny, IDX[j + 1], rim, 0.3)
              vert(x0 - nx, y0 - ny, IDX[j], rim, 0.3)
              vert(xe - nx, ye - ny, IDX[j + 1], rim, 0.3)
            }
            x0 += ux * step
            y0 += uy * step
            seg -= step
            left -= step
            if (left <= 1e-6) {
              dash = (dash + 1) % rimDash.length
              left = rimDash[dash]
              on = dash % 2 === 0
            }
          }
        }
      }
      const spritesOut: number[] = []
      const H = sy
      for (const b of blooms) {
        if (still[b.at] === 1) continue
        const x = baseX[b.at] + b.ox * H
        const y = baseY[b.at] + b.oy * H
        const r = b.r * H
        if (b.bud) {
          const c = budColour(b.colour)
          spritesOut.push(x, y, Math.max(0.5, r), -1, (c[0] / 255) * 0.95, (c[1] / 255) * 0.95, (c[2] / 255) * 0.95, 0.95, arm[b.at], flex[b.at], PS[b.at], depth[b.at])
        } else spritesOut.push(x, y, r / ATLAS.fill, b.colour * 3 + b.variant, 0, 0, 0, 0, arm[b.at], flex[b.at], PS[b.at], depth[b.at])
      }
      // Buds are drawn after all flowers, as in 2D (blooms are sorted with buds last).
      return { key: sizeKey, moon: moonCache, wash: washCache, still: fullCache, mesh: new Float32Array(mesh), sprites: new Float32Array(spritesOut) }
    }
    const swayUniforms = new Float32Array(8)
    const gpuTree: TreeGpu = {
      atlas,
      petalColours: blossomColours.map((c) => [c[0], c[1], c[2]]),
      ready: (t) => t >= DONE,
      frame(t, size, dpr, at) {
        pointer[0] = at[0]
        pointer[1] = at[1]
        const dt = Math.max(0, Math.min(0.05, t - lastT))
        lastT = t
        if (!reduced) advance(t, dt)
        setSize(size, Math.round(dpr * 100) / 100)
        if (!layer || layer.key !== sizeKey) layer = buildLayer(dpr, size)
        const k = reduced ? 0 : sy
        swayUniforms[0] = slow.x
        swayUniforms[1] = slow.y
        swayUniforms[2] = quick.x
        swayUniforms[3] = quick.y
        swayUniforms[4] = t
        swayUniforms[5] = WIND.A1 * k
        swayUniforms[6] = WIND.A2 * k
        swayUniforms[7] = WIND.A3 * k
        return { layer, sway: swayUniforms, petals: petalBuffer, petalCount: petalsAt(t, petalBuffer) }
      }
    }

    return {
      gpu: { tree: gpuTree },
      draw(ctx, t, size, fade, at) {
        pointer[0] = at[0]
        pointer[1] = at[1]
        const dt = Math.max(0, Math.min(0.05, t - lastT))
        lastT = t
        if (!reduced) advance(t, dt)
        const dpr = ctx.getTransform().a || 1
        setSize(size, Math.round(dpr * 100) / 100)
        if (!moonCache) moonCache = bitmap(dpr, size, paintMoon)
        if (!washCache) washCache = bitmap(dpr, size, paintWash)
        const treeAlpha = Math.min(1, 0.55 + fade)

        if (t >= DONE) {
          if (!fullCache) fullCache = makeStill(dpr, size)
          paintBack(ctx, size, fade)
          ctx.drawImage(fullCache, 0, 0, size.w, size.h)
          ctx.globalAlpha = treeAlpha
          if (!reduced) windAt(t)
          paintBark(ctx, liveRanges, Infinity, 1, rimLive, false)
          paintBlooms(ctx, t, 'live')
          paintPetals(ctx, t)
          ctx.globalAlpha = 1
          return
        }

        // Growing: everything live, up to the front.
        paintBack(ctx, size, fade)
        ctx.globalAlpha = treeAlpha
        const g = easeOut(t / GROW)
        const D = t >= GROW ? Infinity : g * maxS
        windAt(t)
        paintSplatter(ctx, clamp01((t - 2.6) / 2))
        paintBark(ctx, allRanges, D, 0.62 + 0.38 * g, rimAll, true)
        paintBlooms(ctx, t, 'all')
        ctx.globalAlpha = 1
      }
    }
  }
}
