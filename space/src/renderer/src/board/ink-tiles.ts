import { regionsIntersect } from './geometry'
import type { Region } from './types'

/**
 * Two parts of the board's ink cache (decision B28): a grid over the strokes,
 * so a paint never scans the strokes outside its region, and cached tiles, so
 * a pan moves pixels and an edit draws only the tiles that it touched.
 */

/** The side of a grid cell, in board points. */
const CELL = 256
/** A stroke over more cells than this on a side goes on a list that every query reads. */
const WIDE_CELLS = 32
/** Grid coordinates stay inside this range, so that a cell key stays an exact number. */
const CELL_LIMIT = 2 ** 25

/** The strokes of the paint order by place: a position in the order for each cell. */
export class InkGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly wide: number[] = []
  private readonly seen: Uint32Array
  private stamp = 0

  constructor(bounds: readonly (Region | null)[]) {
    this.seen = new Uint32Array(bounds.length)
    bounds.forEach((region, at) => {
      if (!region) return
      const x0 = Math.floor(region.x / CELL)
      const x1 = Math.floor((region.x + region.width) / CELL)
      const y0 = Math.floor(region.y / CELL)
      const y1 = Math.floor((region.y + region.height) / CELL)
      if (!(x1 - x0 < WIDE_CELLS && y1 - y0 < WIDE_CELLS && Math.abs(x0) < CELL_LIMIT && Math.abs(y0) < CELL_LIMIT)) {
        this.wide.push(at)
        return
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = x * CELL_LIMIT * 4 + y
          const cell = this.cells.get(key)
          if (cell) cell.push(at)
          else this.cells.set(key, [at])
        }
      }
    })
  }

  /** The positions of the strokes in the cells of `region`, each once, in paint order. The caller checks the bounds. */
  query(region: Region): number[] {
    const stamp = ++this.stamp
    const seen = this.seen
    const out: number[] = []
    const add = (list: readonly number[]): void => {
      for (const at of list) {
        if (seen[at] === stamp) continue
        seen[at] = stamp
        out.push(at)
      }
    }
    add(this.wide)
    const x0 = Math.floor(region.x / CELL)
    const x1 = Math.floor((region.x + region.width) / CELL)
    const y0 = Math.floor(region.y / CELL)
    const y1 = Math.floor((region.y + region.height) / CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const cell of this.cells.values()) add(cell)
    } else {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const cell = this.cells.get(x * CELL_LIMIT * 4 + y)
          if (cell) add(cell)
        }
      }
    }
    return out.sort((a, b) => a - b)
  }
}

/** The side of a tile, in device pixels. */
const TILE_PX = 512
/** The bytes of one tile. */
const TILE_BYTES = TILE_PX * TILE_PX * 4
/** All tiles together stay under this, unless the view alone needs more. The oldest go first. */
const CACHE_BYTES = 96 * 1024 * 1024
/** A paint draws missing tiles for this long when a picture at another scale can show in their place. */
const RASTER_BUDGET_MS = 6
/** A paint with no other tile to draw prepares the tiles around the view for this long, so a pan finds them. */
const RING_BUDGET_MS = 3
/** Device pixels around a region that a stroke's edge can reach. */
const EDGE_PX = 2

/** A tile with no ink has no bitmap. */
interface Tile {
  bitmap: ImageBitmap | null
  /** The paint that last showed it. */
  used: number
}

/** One paint of the cached ink, in device pixels. */
export interface TileView {
  /** Device pixels per board point on the screen now. */
  scale: number
  /** The scale of the tiles to show: `scale`, or a fixed level while the zoom moves. */
  target: number
  /** The screen place of board point 0,0: whole pixels. */
  tx: number
  ty: number
  width: number
  height: number
  /** Prepare the tiles around the view too. */
  ring: boolean
}

export type TileContext = OffscreenCanvasRenderingContext2D

/** The fixed scale nearest to a scale, for the time that the zoom moves. */
export const tileLevel = (scale: number): number => 2 ** Math.round(Math.log2(scale))

/**
 * Pictures of the ink at fixed scales, on a grid of tiles from board point
 * 0,0. A tile at the scale of the screen, at a whole pixel offset, shows the
 * same pixels as a direct paint at any pan. A tile at another scale shows in
 * place of a tile that is not ready. So a pan and a zoom never wait for all
 * of the board, and no part of the view stays empty.
 */
export class TileCache {
  private readonly sets = new Map<number, Map<string, Tile>>()
  private bytes = 0
  private paints = 0
  private scratch: OffscreenCanvas | null = null
  /** Counts the changes that a paint must show. */
  version = 0

  /** `draw`: the ink of a board region on a context with the board transform. False: nothing in that region. */
  constructor(private readonly draw: (context: TileContext, region: Region) => boolean) {}

  /** Tiles that touch a region are out of date, at each scale. */
  invalidate(region: Region): void {
    for (const [scale, set] of this.sets) {
      const pad = EDGE_PX / scale
      const size = TILE_PX / scale
      const i0 = Math.floor((region.x - pad) / size)
      const i1 = Math.floor((region.x + region.width + pad) / size)
      const j0 = Math.floor((region.y - pad) / size)
      const j1 = Math.floor((region.y + region.height + pad) / size)
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > set.size) {
        const hit = { x: i0 * size, y: j0 * size, width: (i1 - i0 + 1) * size, height: (j1 - j0 + 1) * size }
        for (const [key, tile] of set) {
          const [i, j] = key.split(',').map(Number)
          if (regionsIntersect({ x: i * size, y: j * size, width: size, height: size }, hit)) this.drop(set, key, tile)
        }
      } else {
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const key = `${i},${j}`
            const tile = set.get(key)
            if (tile) this.drop(set, key, tile)
          }
        }
      }
    }
  }

  clear(): void {
    for (const set of this.sets.values()) for (const tile of set.values()) tile.bitmap?.close()
    this.sets.clear()
    this.bytes = 0
    this.version++
  }

  private drop(set: Map<string, Tile>, key: string, tile: Tile): void {
    set.delete(key)
    this.version++
    if (!tile.bitmap) return
    tile.bitmap.close()
    this.bytes -= TILE_BYTES
  }

  private raster(scale: number, i: number, j: number): Tile {
    const canvas = (this.scratch ??= new OffscreenCanvas(TILE_PX, TILE_PX))
    const context = canvas.getContext('2d')
    let bitmap: ImageBitmap | null = null
    if (context) {
      context.setTransform(scale, 0, 0, scale, -i * TILE_PX, -j * TILE_PX)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      const size = TILE_PX / scale
      const pad = EDGE_PX / scale
      if (this.draw(context, { x: i * size - pad, y: j * size - pad, width: size + pad * 2, height: size + pad * 2 })) {
        bitmap = canvas.transferToImageBitmap()
        this.bytes += TILE_BYTES
      }
    }
    return { bitmap, used: this.paints }
  }

  private blit(context: CanvasRenderingContext2D, bitmap: ImageBitmap, ratio: number, view: TileView, i: number, j: number): void {
    const x0 = Math.round(i * TILE_PX * ratio + view.tx)
    const y0 = Math.round(j * TILE_PX * ratio + view.ty)
    const x1 = Math.round((i + 1) * TILE_PX * ratio + view.tx)
    const y1 = Math.round((j + 1) * TILE_PX * ratio + view.ty)
    context.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0)
  }

  /** The nearest other scale that holds all of a tile's region, drawn inside it. False: none does. */
  private stand(context: CanvasRenderingContext2D, view: TileView, i: number, j: number): boolean {
    const ratio = view.scale / view.target
    const size = TILE_PX / view.target
    const near = [...this.sets.keys()].filter((scale) => scale !== view.target).sort((a, b) => Math.abs(Math.log(a / view.target)) - Math.abs(Math.log(b / view.target)))
    for (const scale of near) {
      const set = this.sets.get(scale) as Map<string, Tile>
      const their = TILE_PX / scale
      const i0 = Math.floor((i * size) / their)
      const i1 = Math.ceil(((i + 1) * size) / their) - 1
      const j0 = Math.floor((j * size) / their)
      const j1 = Math.ceil(((j + 1) * size) / their) - 1
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 16) continue
      const tiles: Array<[number, number, Tile]> = []
      for (let a = i0; a <= i1; a++) {
        for (let b = j0; b <= j1; b++) {
          const tile = set.get(`${a},${b}`)
          if (tile) tiles.push([a, b, tile])
        }
      }
      if (tiles.length < (i1 - i0 + 1) * (j1 - j0 + 1)) continue
      const x0 = Math.round(i * TILE_PX * ratio + view.tx)
      const y0 = Math.round(j * TILE_PX * ratio + view.ty)
      const x1 = Math.round((i + 1) * TILE_PX * ratio + view.tx)
      const y1 = Math.round((j + 1) * TILE_PX * ratio + view.ty)
      context.save()
      context.beginPath()
      context.rect(x0, y0, x1 - x0, y1 - y0)
      context.clip()
      context.imageSmoothingEnabled = true
      for (const [a, b, tile] of tiles) {
        tile.used = this.paints
        if (tile.bitmap) this.blit(context, tile.bitmap, view.scale / scale, view, a, b)
      }
      context.restore()
      return true
    }
    return false
  }

  /** Show the view on a context in device pixels. True: a later paint has more to do. */
  compose(context: CanvasRenderingContext2D, view: TileView): boolean {
    const paint = ++this.paints
    let set = this.sets.get(view.target)
    if (!set) this.sets.set(view.target, (set = new Map()))
    const ratio = view.scale / view.target
    const size = TILE_PX * ratio
    const i0 = Math.floor(-view.tx / size)
    const i1 = Math.ceil((view.width - view.tx) / size) - 1
    const j0 = Math.floor(-view.ty / size)
    const j1 = Math.ceil((view.height - view.ty) / size) - 1
    context.imageSmoothingEnabled = ratio !== 1
    const deadline = performance.now() + RASTER_BUDGET_MS
    let waiting = false
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = `${i},${j}`
        let tile = set.get(key)
        if (!tile) {
          // A tile that an edit touched has no stand-in at any scale, so it draws now.
          if (performance.now() > deadline && this.stand(context, view, i, j)) {
            waiting = true
            continue
          }
          tile = this.raster(view.target, i, j)
          set.set(key, tile)
        }
        tile.used = paint
        if (tile.bitmap) this.blit(context, tile.bitmap, ratio, view, i, j)
      }
    }
    if (!waiting && view.ring) waiting = this.prepareRing(set, view.target, { i0, i1, j0, j1 })
    this.evict(view.target)
    return waiting
  }

  /** Tiles one step outside the view, within the cache's bytes. True: more wait. */
  private prepareRing(set: Map<string, Tile>, scale: number, range: { i0: number; i1: number; j0: number; j1: number }): boolean {
    const deadline = performance.now() + RING_BUDGET_MS
    for (let j = range.j0 - 1; j <= range.j1 + 1; j++) {
      for (let i = range.i0 - 1; i <= range.i1 + 1; i++) {
        if (i >= range.i0 && i <= range.i1 && j >= range.j0 && j <= range.j1) continue
        const key = `${i},${j}`
        const tile = set.get(key)
        if (tile) {
          tile.used = this.paints
          continue
        }
        if (this.bytes + TILE_BYTES > CACHE_BYTES) return false
        if (performance.now() > deadline) return true
        set.set(key, this.raster(scale, i, j))
      }
    }
    return false
  }

  /** Down to the byte limit, oldest first. A tile of this paint stays. Scales with no pictures go. */
  private evict(target: number): void {
    if (this.bytes > CACHE_BYTES) {
      const found: Array<{ set: Map<string, Tile>; key: string; tile: Tile }> = []
      for (const set of this.sets.values()) for (const [key, tile] of set) if (tile.bitmap && tile.used !== this.paints) found.push({ set, key, tile })
      found.sort((a, b) => a.tile.used - b.tile.used)
      for (const { set, key, tile } of found) {
        if (this.bytes <= CACHE_BYTES) break
        tile.bitmap?.close()
        this.bytes -= TILE_BYTES
        set.delete(key)
      }
    }
    if (this.sets.size < 2) return
    for (const [scale, set] of this.sets) {
      if (scale === target) continue
      let held = false
      for (const tile of set.values()) {
        if (tile.bitmap) {
          held = true
          break
        }
      }
      if (!held) this.sets.delete(scale)
    }
  }
}
