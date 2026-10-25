import { isContent, isFrame, isInk, isKnown, newItemId, type BoardNode, type ContentNode, type FrameNode, type InkNode, type InkPoint, type LiveNode, type SvgNode, type TextNode } from '@shared/board-format'
import type { SceneBounds, SceneDescription, SceneGroupObject, SceneInkObject, SceneLiveObject, SceneObjectDesc, SceneSample, SceneShapeObject, SceneStyle, SceneTextObject } from '@shared/live-scene'
import { MAX_COORD } from '@shared/limits'
import { humanize, svgPathPolylines } from '../agent/ink'
import type { Scene } from '../agent/placement'
import { inkOffset, isFlowed, normalizeInk, removeNodes, ROOT, withDescendants, zAbove } from '../board/scene'
import type { Point, Region } from '../board/types'
import { textHtml } from '../board/content'
import { sceneColor, withOpacity } from './colors'
import { apply, IDENTITY, invert, isIdentity, multiply, scaleOf, Timeline, type Matrix } from './timeline'

/**
 * Turn a scene description into board items (the final state, committed as
 * one undo step) and the data the player needs to show every moment before
 * that: which nodes each object made, what transform is baked into them, and
 * the share of the object's drawing each ink stroke takes.
 */

/** One sample of a changing object, ready to show (see SceneSample). */
export interface DynSample {
  t: number
  bounds: SceneBounds
  d?: string
  /** d split into its numbers and the text between them, to blend two samples of the same form. */
  skeleton?: string
  numbers?: number[]
  width?: number
  lines?: Point[][]
  html?: string
  params?: Record<string, number>
}

/** How a changing object shows over time. Before `end`, the samples hold; after it, the committed node shows. */
export interface PlayDyn {
  kind: 'shape' | 'ink' | 'text' | 'live'
  samples: DynSample[]
  end: number
  /** The bounds of the end state (the committed node). */
  finalBounds: SceneBounds
  /** Text placed by its centre (else by its top-left). */
  centered: boolean
  /** Ink: how the strokes of now are painted. */
  ink?: { color: string; width: number; tool: 'pen' | 'highlighter' }
}

/** One node an object shows through. */
export interface PlayTarget {
  nodeId: string
  ink: boolean
  /** The transform already in the node's geometry (override = now ∘ baked⁻¹). */
  inverseBaked: Matrix
  /** Ink: the part of the object's draw share this stroke takes. */
  range?: [number, number]
  /** Ink: world offset of the node's points. */
  offset?: Point
  /** For the pen tip: world polylines of the final geometry and their total length. */
  tipLines?: Point[][]
  tipLength?: number
  tipWidth?: number
}

export interface PlayObject {
  id: number
  targets: PlayTarget[]
  /** Removed at the end: its targets are ghosts. */
  ghost: boolean
  /** The object's own last action. After it (and its groups' moves), it shows as committed. */
  settled: number
  /** The object's final opacity (the share baked into its nodes). */
  finalOpacity: number
  tipColor: string
  /** The object writes or draws (the pen tip shows while it does). */
  drawn: boolean
  /** The object changes shape over time (values, labels that follow, tweened options). */
  dyn?: PlayDyn
  /** Its board item (ink group id, node id or group frame id), filled in by run.ts. */
  item?: string
}

export interface ScenePlay {
  id: string
  /** The agent's label for it (run_scene name). */
  name: string | null
  timeline: Timeline
  duration: number
  steps: Array<{ name: string; at: number; pause?: boolean }>
  objects: PlayObject[]
  ghosts: BoardNode[]
  camera: SceneDescription['camera']
  pointer: SceneDescription['pointer']
  cues: SceneDescription['cues']
}

/** What a scene's commit changed, to undo it when a queued scene is skipped. */
export interface SceneRevert {
  created: string[]
  /** Existing nodes the scene changed, as they were. */
  changed: BoardNode[]
  /** Existing nodes the scene removed, as they were (with their descendants). */
  removed: BoardNode[]
}

export interface CompiledScene {
  /** The board after the scene: commit as one undo step. */
  next: BoardNode[]
  play: ScenePlay
  /** Ink strokes per object, to pin as one ink group each. */
  inkGroups: Array<{ object: number; strokes: string[] }>
  /** Content nodes made, in order. */
  contentIds: string[]
  /** Text nodes to centre on a point once their size is measured. */
  centers: Array<{ nodeId: string; center: Point; object: number }>
  /** Frames made for named groups, innermost first: fit them to their children once measured. */
  frames: Array<{ id: string; object: number }>
  /** The node ids each object made (not ghosts). */
  nodesOf: Map<number, string[]>
  revert: SceneRevert
  warnings: string[]
}

const END = Number.POSITIVE_INFINITY
const r1 = (value: number): number => Math.round(value * 10) / 10
const r2 = (value: number): number => Math.round(value * 100) / 100
/** Pen lift between strokes of one ink object, in board points of drawing time. */
const LIFT = 9

function linesBounds(lines: readonly Point[][]): Region {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const line of lines) {
    for (const [x, y] of line) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return x0 === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function lineLength(line: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  return length
}

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Every node id of a board item: a node (with its ink descendants, which the canvas draws) or an ink group. */
function refIds(s: Scene, ref: string): string[] {
  const group = s.groupById.get(ref)
  if (group) return [...group.strokes]
  const node = s.index.byId.get(ref)
  if (!node) throw new Error(`The board item "${ref}" is gone (the learner may have erased it). Run the scene again.`)
  const ids = withDescendants([ref], s.index)
  return [...ids].filter((id) => id === ref || isInk(s.index.byId.get(id) as BoardNode))
}

/** The world offset of an ink node's points. */
function offsetOf(s: Scene, node: InkNode): Point {
  const box = s.layout.get(node.id)
  return box ? [box.ox, box.oy] : inkOffset(node, s.index.byId, s.layout)
}

/** Ink ranges: each stroke's share of the object's drawing, by length, with a short lift between strokes. */
function ranges(lengths: number[]): Array<[number, number]> {
  const total = lengths.reduce((sum, length) => sum + length, 0) + LIFT * Math.max(0, lengths.length - 1) || 1
  let at = 0
  return lengths.map((length, i) => {
    const range: [number, number] = [at / total, (at + length) / total]
    at += length + (i < lengths.length - 1 ? LIFT : 0)
    return range
  })
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

function splitNumbers(d: string): { skeleton: string; numbers: number[] } {
  const numbers: number[] = []
  const skeleton = d.replace(NUMBER, (match) => {
    numbers.push(Number(match))
    return '#'
  })
  return { skeleton, numbers }
}

/** Samples of a changing object, prepared for playback. */
function prepareDyn(object: SceneObjectDesc, samples: SceneSample[]): PlayDyn | undefined {
  if (!samples.length) return undefined
  const kind = object.kind === 'shape' || object.kind === 'ink' || object.kind === 'text' || object.kind === 'live' ? object.kind : null
  if (!kind) return undefined
  const out: DynSample[] = samples.map((sample) => {
    const next: DynSample = { t: sample.t, bounds: sample.bounds }
    if (kind === 'shape' && sample.d) {
      next.d = sample.d
      Object.assign(next, splitNumbers(sample.d))
      if (sample.width !== undefined) next.width = sample.width
    } else if (kind === 'ink') {
      try {
        next.lines = sample.lines ? sample.lines.map((line) => line.map((p) => [p[0], p[1]] as Point)) : sample.d ? svgPathPolylines(sample.d, false) : []
      } catch {
        next.lines = []
      }
      if (sample.width !== undefined) next.width = sample.width
    } else if (kind === 'text' && sample.text !== undefined) {
      const text = object as SceneTextObject
      next.html = textHtml(text.math ? `$\\displaystyle ${sample.text.replace(/\$/g, '\\$')}$` : sample.text)
    } else if (kind === 'live' && sample.params) next.params = sample.params
    return next
  })
  return {
    kind,
    samples: out,
    end: out[out.length - 1].t,
    finalBounds: object.bounds,
    centered: object.kind === 'text' && !!(object as SceneTextObject).center
  }
}

export function compileScene(desc: SceneDescription, s: Scene, sceneId: string, name: string | null = null): CompiledScene {
  const warnings: string[] = []
  const warn = (text: string): void => {
    if (!warnings.includes(text)) warnings.push(text)
  }
  const nodeColor = (object: SceneObjectDesc): string | undefined => {
    if (object.kind !== 'node') return undefined
    const ids = refIds(s, object.ref)
    const first = s.index.byId.get(ids[0])
    if (!first || !isKnown(first)) return undefined
    if (first.kind === 'ink') return first.color
    return first.style.color
  }
  const timeline = new Timeline(desc, nodeColor)
  const objects: PlayObject[] = []
  const created: BoardNode[] = []
  const ghosts: BoardNode[] = []
  const inkGroups: CompiledScene['inkGroups'] = []
  const contentIds: string[] = []
  const centers: CompiledScene['centers'] = []
  const nodesOf = new Map<number, string[]>()
  const madeBy = (object: number, id: string): void => {
    const list = nodesOf.get(object)
    if (list) list.push(id)
    else nodesOf.set(object, [id])
  }
  const changed = new Map<string, BoardNode>()
  const removed = new Set<string>()
  let z = zAbove(s.index.children.get(ROOT) ?? [])

  const finalOpacity = (id: number, style?: SceneStyle): number => Math.max(0, Math.min(1, timeline.number(id, 'opacity', END))) * (style?.opacity ?? 1)
  const finalColor = (id: number): string => timeline.color(id, END) ?? '#ececef'
  /** A final colour for board material: the token when the colour never changed, else the concrete end colour. */
  const materialColor = (id: number, style: SceneStyle): string => (timeline.hasTrack(id, 'color') ? finalColor(id) : sceneColor(style.color).css)

  for (const object of desc.objects) {
    if (object.kind === 'group') continue
    const end = timeline.matrix(object.id, END)
    const isRemoved = object.removed || timeline.number(object.id, 'opacity', END) < 0.02
    const play: PlayObject = {
      id: object.id,
      targets: [],
      ghost: isRemoved,
      settled: timeline.settled(object.id),
      finalOpacity: isRemoved ? 1 : Math.max(0.02, timeline.number(object.id, 'opacity', END)),
      tipColor: '#ececef',
      drawn: timeline.hasTrack(object.id, 'draw')
    }
    if (object.dyn?.length) {
      play.dyn = prepareDyn(object, object.dyn)
      if (play.dyn) play.settled = Math.max(play.settled, play.dyn.end)
    }
    objects.push(play)
    const out = isRemoved ? ghosts : created

    if (object.kind === 'ink') {
      const ink = object as SceneInkObject
      let local: Array<Array<[number, number, number?]>>
      try {
        local = ink.lines ? ink.lines.map((line) => line.map((p) => [p[0], p[1], p[2]] as [number, number, number?])) : svgPathPolylines(String(ink.d ?? ''), false).map((line) => line.map(([x, y]) => [x, y] as [number, number, number?]))
      } catch (error) {
        warn(`${ink.api} ${object.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const scale = scaleOf(end)
      const jitter = ink.style.jitter ?? 0.3
      const color = withOpacity(finalColor(object.id), isRemoved ? ink.style.opacity : finalOpacity(object.id, ink.style))
      play.tipColor = finalColor(object.id)
      const tool = ink.style.tool === 'highlighter' ? 'highlighter' : 'pen'
      const width = r2(Math.max(0.5, ink.style.width * (tool === 'highlighter' ? 4 : 1) * scale))
      const strokes: InkNode[] = []
      for (const line of local) {
        if (line.length < 2) continue
        // A changing ink object shows its samples without wobble while it changes, so its end state has none either.
        const points: InkPoint[] = ink.pressure
          ? line.map(([x, y, p]) => [x, y, p === undefined ? 0.5 : Math.max(0, Math.min(1, p))])
          : play.dyn
            ? line.map(([x, y]) => [x, y, 0.5])
            : humanize(line.map(([x, y]) => [x, y] as Point), jitter)
        const world = points.map(([x, y, p]) => {
          const [wx, wy] = apply(end, [x, y])
          return [wx, wy, p] as InkPoint
        })
        if (world.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD)) {
          warn(`${ink.api} ${object.id}: a stroke went outside ±${MAX_COORD} board points and was left out`)
          continue
        }
        strokes.push(
          normalizeInk({
            id: newItemId('s'),
            kind: 'ink',
            x: 0,
            y: 0,
            z: z++,
            author: 'agent',
            seq: 0,
            tool,
            color,
            width,
            points: world,
            ...(object.name ? { name: object.name } : {}),
            scene: sceneId
          } as InkNode)
        )
      }
      const lengths = strokes.map((stroke) => lineLength(stroke.points.map(([x, y]) => [x, y] as Point)))
      const inkRanges = ranges(lengths)
      strokes.forEach((stroke, i) => {
        out.push(stroke)
        if (!isRemoved) madeBy(object.id, stroke.id)
        play.targets.push({ nodeId: stroke.id, ink: true, inverseBaked: invert(end), range: inkRanges[i], offset: [stroke.x, stroke.y], tipWidth: width })
      })
      if (play.dyn) play.dyn.ink = { color: withOpacity(finalColor(object.id), ink.style.opacity), width: r2(Math.max(0.5, ink.style.width * (tool === 'highlighter' ? 4 : 1))), tool }
      if (!isRemoved && strokes.length) inkGroups.push({ object: object.id, strokes: strokes.map((stroke) => stroke.id) })
      continue
    }

    if (object.kind === 'shape') {
      const shape = object as SceneShapeObject
      let lines: Point[][]
      try {
        lines = svgPathPolylines(shape.d, false)
      } catch (error) {
        warn(`${shape.api} ${object.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const world = lines.map((line) => line.map((p) => apply(end, p)))
      const scale = scaleOf(end)
      const pad = (shape.style.width * scale) / 2 + 2
      const box = linesBounds(world)
      const bx = Math.floor(box.x - pad)
      const by = Math.floor(box.y - pad)
      const bw = Math.ceil(box.width + pad * 2) + 1
      const bh = Math.ceil(box.height + pad * 2) + 1
      if (![bx, by, bw, bh].every(Number.isFinite) || Math.abs(bx) > MAX_COORD || Math.abs(by) > MAX_COORD) {
        warn(`${shape.api} ${object.id}: outside ±${MAX_COORD} board points; left out`)
        continue
      }
      const style = shape.style
      const defs: string[] = []
      let fill = 'none'
      if (style.gradient) {
        const stops = style.gradient.map((c, i) => `<stop offset="${r2(i / (style.gradient!.length - 1))}" stop-color="${escapeAttr(sceneColor(c).hex)}"/>`)
        defs.push(`<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">${stops.join('')}</linearGradient>`)
        fill = 'url(#fill)'
      } else if (style.hatch) {
        const gap = Math.max(4, style.width * 2.4)
        defs.push(
          `<pattern id="fill" patternUnits="userSpaceOnUse" width="${gap}" height="${gap}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${gap}" stroke="${escapeAttr(sceneColor(style.hatch).hex)}" stroke-width="${r2(Math.max(1, style.width * 0.5))}"/></pattern>`
        )
        fill = 'url(#fill)'
      } else if (style.fill) fill = sceneColor(style.fill).hex
      const fillOpacity = style.fillOpacity ?? 1
      const attrs = [
        `d="${escapeAttr(shape.d)}"`,
        `fill="${escapeAttr(fill)}"`,
        fill !== 'none' && fillOpacity < 1 ? `fill-opacity="${r2(fillOpacity)}"` : '',
        'stroke="currentColor"',
        `stroke-width="${r2(style.width)}"`,
        'stroke-linecap="round"',
        'stroke-linejoin="round"',
        style.dash ? `stroke-dasharray="${style.dash.map(r2).join(' ')}"` : ''
      ].filter(Boolean)
      const matrix = isIdentity(end) ? '' : ` transform="matrix(${end.map((v) => r2(v * 1000) / 1000).join(' ')})"`
      const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bx} ${by} ${bw} ${bh}" width="${bw}" height="${bh}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<g${matrix}><path ${attrs.join(' ')}/></g></svg>`
      const opacity = isRemoved ? style.opacity : finalOpacity(object.id, style)
      const node: SvgNode = {
        id: newItemId('n'),
        kind: 'svg',
        x: bx,
        y: by,
        z: z++,
        author: 'agent',
        seq: 0,
        style: {
          width: `${bw}px`,
          height: `${bh}px`,
          color: materialColor(object.id, style),
          ...(opacity < 1 ? { opacity: String(r2(opacity)) } : {})
        },
        markup,
        ...(object.name ? { name: object.name } : {}),
        ...({ scene: sceneId } as object)
      }
      out.push(node)
      if (!isRemoved) {
        contentIds.push(node.id)
        madeBy(object.id, node.id)
      }
      play.tipColor = finalColor(object.id)
      play.targets.push({ nodeId: node.id, ink: false, inverseBaked: invert(end), tipLines: world, tipLength: world.reduce((sum, line) => sum + lineLength(line), 0), tipWidth: style.width * scale })
      continue
    }

    if (object.kind === 'text') {
      const text = object as SceneTextObject
      const scale = scaleOf(end)
      if (Math.abs(end[1]) > 1e-3 || Math.abs(end[2]) > 1e-3) warn(`${text.api} ${object.id}: text cannot stay rotated; it rotates while the scene plays and ends upright`)
      // Text keeps translation and scale only: that is what is baked.
      const anchor: Point = text.at ?? [text.bounds.x, text.bounds.y]
      const [x, y] = apply(end, anchor)
      // An upright version of `end` with the same effect on the anchor.
      const upright: Matrix = [scale, 0, 0, scale, x - scale * anchor[0], y - scale * anchor[1]]
      const size = (text.style.size ?? 22) * scale
      const opacity = isRemoved ? text.style.opacity : finalOpacity(object.id, text.style)
      const source = text.math ? `$\\displaystyle ${text.text.replace(/\$/g, '\\$')}$` : text.text
      const node: TextNode = {
        id: newItemId('n'),
        kind: 'text',
        x: r1(x),
        y: r1(y),
        z: z++,
        author: 'agent',
        seq: 0,
        text: source,
        style: {
          fontSize: `${r1(size)}px`,
          color: materialColor(object.id, text.style),
          whiteSpace: 'pre',
          lineHeight: '1.3',
          ...(opacity < 1 ? { opacity: String(r2(opacity)) } : {})
        },
        ...(object.name ? { name: object.name } : {}),
        ...({ scene: sceneId } as object)
      }
      out.push(node)
      if (!isRemoved) {
        contentIds.push(node.id)
        madeBy(object.id, node.id)
      }
      if (text.center && !isRemoved) centers.push({ nodeId: node.id, center: apply(end, text.center), object: object.id })
      play.targets.push({ nodeId: node.id, ink: false, inverseBaked: invert(upright) })
      continue
    }

    if (object.kind === 'live') {
      const live = object as SceneLiveObject
      const scale = scaleOf(end)
      if (Math.abs(end[1]) > 1e-3 || Math.abs(end[2]) > 1e-3) warn(`${live.api} ${object.id}: a live item cannot stay rotated; it rotates while the scene plays and ends upright`)
      const anchor: Point = [live.bounds.x, live.bounds.y]
      const [x, y] = apply(end, anchor)
      const upright: Matrix = [scale, 0, 0, scale, x - scale * anchor[0], y - scale * anchor[1]]
      const liveOpacity = isRemoved ? (live.style?.opacity ?? 1) : finalOpacity(object.id, live.style)
      const node: LiveNode = {
        id: newItemId('n'),
        kind: 'live',
        mode: live.mode,
        code: live.code,
        params: { ...live.params },
        x: r1(x),
        y: r1(y),
        w: r1(live.width * scale),
        h: r1(live.height * scale),
        style: liveOpacity < 1 ? { opacity: String(r2(liveOpacity)) } : {},
        z: z++,
        author: 'agent',
        seq: 0,
        ...(object.name ? { name: object.name } : {}),
        ...({ scene: sceneId } as object)
      }
      out.push(node)
      if (!isRemoved) {
        contentIds.push(node.id)
        madeBy(object.id, node.id)
      }
      play.targets.push({ nodeId: node.id, ink: false, inverseBaked: invert(upright) })
      continue
    }

    if (object.kind === 'node') {
      const ids = refIds(s, object.ref)
      // Ink inside a moved frame moves with the frame: its own points stay.
      const contentRefs = new Set(ids.filter((id) => {
        const node = s.index.byId.get(id)
        return !!node && isKnown(node) && !isInk(node)
      }))
      const insideMoved = (node: BoardNode): boolean => {
        for (let parent = node.parent as string | undefined; parent; parent = s.index.byId.get(parent)?.parent as string | undefined) if (contentRefs.has(parent)) return true
        return false
      }
      const rigidMove: Matrix = [1, 0, 0, 1, apply(end, object.pivot)[0] - object.pivot[0], apply(end, object.pivot)[1] - object.pivot[1]]
      const translation: Point = [apply(end, object.pivot)[0] - object.pivot[0], apply(end, object.pivot)[1] - object.pivot[1]]
      const rigid = Math.abs(end[0] - 1) < 1e-3 && Math.abs(end[1]) < 1e-3 && Math.abs(end[2]) < 1e-3 && Math.abs(end[3] - 1) < 1e-3
      const lengths: number[] = []
      for (const id of ids) {
        const node = s.index.byId.get(id)
        if (!node || !isKnown(node)) continue
        if (isInk(node) && insideMoved(node)) {
          // Shown and moved through its frame; the frame keeps its size and angle, so only the move is baked.
          const offset = offsetOf(s, node)
          lengths.push(lineLength(node.points.map(([x, y]) => [x, y] as Point)))
          const flowed = [...contentRefs].some((ref) => isFlowed(s.index.byId.get(ref) as BoardNode, s.index.byId))
          play.targets.push({ nodeId: id, ink: true, inverseBaked: isRemoved || flowed ? IDENTITY : invert(rigidMove), offset, tipWidth: node.width })
          if (isRemoved) {
            removed.add(id)
            ghosts.push({ ...node, parent: undefined, x: offset[0], y: offset[1] } as BoardNode)
          }
          continue
        }
        if (isInk(node)) {
          const offset = offsetOf(s, node)
          const target: PlayTarget = { nodeId: id, ink: true, inverseBaked: isRemoved ? IDENTITY : invert(end), offset, tipWidth: node.width }
          lengths.push(lineLength(node.points.map(([x, y]) => [x, y] as Point)))
          play.targets.push(target)
          if (isRemoved) {
            removed.add(id)
            ghosts.push({ ...node, parent: undefined, x: offset[0], y: offset[1] } as BoardNode)
            continue
          }
          let next: InkNode = node
          if (!isIdentity(end)) {
            const points = node.points.map(([x, y, p]) => {
              const [wx, wy] = apply(end, [offset[0] + x, offset[1] + y])
              return [wx - offset[0], wy - offset[1], p] as InkPoint
            })
            next = normalizeInk({ ...next, points, width: r2(node.width * scaleOf(end)) })
          }
          if (timeline.hasTrack(object.id, 'color')) next = { ...next, color: finalColor(object.id) }
          const opacity = timeline.number(object.id, 'opacity', END)
          if (opacity < 0.999) next = { ...next, color: withOpacity(next.color.startsWith('var(') ? sceneColor(next.color).hex : next.color, opacity) }
          if (next !== node) changed.set(id, next)
          continue
        }
        const content = node as ContentNode
        const box = s.layout.get(id)
        if (isRemoved) {
          removed.add(id)
          // The ghost shows the item where it was, at the top level.
          const descendants = [...withDescendants([id], s.index)].filter((d) => d !== id).map((d) => s.index.byId.get(d) as BoardNode)
          ghosts.push({ ...content, parent: undefined, x: box?.x ?? content.x, y: box?.y ?? content.y, style: { ...content.style, ...(box ? { width: `${box.width}px` } : {}) } } as BoardNode)
          for (const child of descendants) if (isContent(child)) ghosts.push(child)
          play.targets.push({ nodeId: id, ink: false, inverseBaked: IDENTITY })
          continue
        }
        let baked: Matrix = IDENTITY
        let next: ContentNode = content
        if (!rigid) warn(`board.node("${object.ref}"): a ${content.kind} keeps its size and angle on the board; it scales or rotates only while the scene plays`)
        if (Math.abs(translation[0]) > 0.05 || Math.abs(translation[1]) > 0.05) {
          if (isFlowed(content, s.index.byId)) warn(`board.node("${object.ref}"): it is placed by its flex frame, so it goes back to its place when the scene ends`)
          else {
            next = { ...next, x: r1(content.x + translation[0]), y: r1(content.y + translation[1]) }
            baked = [1, 0, 0, 1, translation[0], translation[1]]
          }
        }
        if (timeline.hasTrack(object.id, 'color')) next = { ...next, style: { ...next.style, color: finalColor(object.id) } } as ContentNode
        const opacity = timeline.number(object.id, 'opacity', END)
        if (opacity < 0.999) next = { ...next, style: { ...next.style, opacity: String(r2(opacity * Number(content.style.opacity ?? '1'))) } } as ContentNode
        if (next !== content) changed.set(id, next)
        play.targets.push({ nodeId: id, ink: false, inverseBaked: invert(baked) })
      }
      const inkTargets = play.targets.filter((target) => target.ink)
      const inkRanges = ranges(lengths)
      inkTargets.forEach((target, i) => (target.range = inkRanges[i]))
      play.tipColor = nodeColor(object) ?? '#ececef'
      if (play.tipColor.startsWith('var(')) play.tipColor = sceneColor(play.tipColor).hex
      continue
    }
  }

  // Named groups become one board item each: a frame that holds the group's items (innermost first).
  const frames: CompiledScene['frames'] = []
  const byId = new Map(created.map((node) => [node.id, node]))
  const frameOf = new Map<number, FrameNode>()
  const groupObjects = desc.objects.filter((object): object is SceneGroupObject => object.kind === 'group')
  const depth = (object: SceneObjectDesc): number => (object.parent === undefined ? 0 : 1 + depth(desc.objects[object.parent]))
  const named = groupObjects.filter((group) => group.name).sort((a, b) => depth(b) - depth(a))
  /** The top-level items under a group object: the frames of named subgroups, else the nodes its leaves made. */
  const itemsUnder = (object: SceneObjectDesc): BoardNode[] => {
    if (object.kind === 'group') {
      const frame = frameOf.get(object.id)
      if (frame) return [frame]
      return (object as SceneGroupObject).members.flatMap((member) => itemsUnder(desc.objects[member]))
    }
    if (object.kind === 'node') {
      warn(`group "${desc.objects[object.parent ?? 0]?.name ?? ''}": board.node("${object.ref}") is an item from before the scene; it moves with the group while the scene plays but stays its own item`)
      return []
    }
    return (nodesOf.get(object.id) ?? []).map((id) => byId.get(id)).filter((node): node is BoardNode => !!node)
  }
  const boxOf = (node: BoardNode): Region | null => {
    if (isInk(node)) {
      const box = linesBounds([node.points.map(([x, y]) => [node.x + x, node.y + y] as Point)])
      return { x: box.x - node.width, y: box.y - node.width, width: box.width + node.width * 2, height: box.height + node.width * 2 }
    }
    if (node.kind === 'live') {
      const live = node as LiveNode
      return { x: live.x, y: live.y, width: live.w, height: live.h }
    }
    if (node.kind === 'frame' || node.kind === 'svg') {
      const content = node as ContentNode
      return { x: content.x, y: content.y, width: parseFloat(String(content.style.width ?? '0')) || 0, height: parseFloat(String(content.style.height ?? '0')) || 0 }
    }
    if (node.kind === 'text') {
      // Estimated from the scene's bounds; run.ts fits the frame to the measured size.
      const owner = [...nodesOf.entries()].find(([, ids]) => ids.includes(node.id))
      const object = owner ? desc.objects[owner[0]] : null
      const content = node as TextNode
      if (!object) return { x: content.x, y: content.y, width: 40, height: 30 }
      const m = timeline.matrix(object.id, END)
      const scale = scaleOf(m)
      return { x: content.x, y: content.y, width: object.bounds.width * scale, height: object.bounds.height * scale }
    }
    return null
  }
  const PAD = 6
  for (const group of named) {
    if (desc.objects[group.id].removed) continue
    const items = group.members.flatMap((member) => itemsUnder(desc.objects[member])).filter((node) => !node.parent)
    if (!items.length) continue
    const boxes = items.map(boxOf).filter((box): box is Region => !!box)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const box of boxes) {
      x0 = Math.min(x0, box.x)
      y0 = Math.min(y0, box.y)
      x1 = Math.max(x1, box.x + box.width)
      y1 = Math.max(y1, box.y + box.height)
    }
    if (x0 === Infinity) continue
    const fx = Math.floor(x0 - PAD)
    const fy = Math.floor(y0 - PAD)
    const frame: FrameNode = {
      id: newItemId('n'),
      kind: 'frame',
      x: fx,
      y: fy,
      z: z++,
      author: 'agent',
      seq: 0,
      name: group.name,
      style: { width: `${Math.ceil(x1 - fx + PAD)}px`, height: `${Math.ceil(y1 - fy + PAD)}px`, background: 'transparent', overflow: 'visible' },
      ...({ scene: sceneId } as object)
    } as FrameNode
    // The items keep their world place: their x, y become relative to the frame.
    for (const item of items) {
      const index = created.indexOf(item)
      const moved = { ...item, parent: frame.id, x: r1((item.x as number) - fx), y: r1((item.y as number) - fy) } as BoardNode
      created[index] = moved
      byId.set(item.id, moved)
    }
    for (const [id, f] of frameOf) if (items.includes(f)) frameOf.set(id, byId.get(f.id) as FrameNode)
    created.push(frame)
    byId.set(frame.id, frame)
    frameOf.set(group.id, frame)
    frames.push({ id: frame.id, object: group.id })
  }

  // The board after the scene: existing nodes changed or removed, then the new ones on top.
  let next: BoardNode[] = s.nodes.map((node) => changed.get(node.id) ?? node)
  if (removed.size) next = removeNodes(next, removed, s.index)
  next = [...next, ...created]
  for (const ghost of ghosts) if (isFrame(ghost)) warn(`A frame faded out with everything in it`)
  const removedAll = removed.size ? [...withDescendants(removed, s.index)].map((id) => s.index.byId.get(id) as BoardNode).filter(Boolean) : []
  return {
    next,
    play: { id: sceneId, name, timeline, duration: desc.duration, steps: desc.steps, objects, ghosts, camera: desc.camera ?? [], pointer: desc.pointer ?? [], cues: desc.cues ?? [] },
    inkGroups,
    contentIds,
    centers,
    frames,
    nodesOf,
    revert: { created: created.map((node) => node.id), changed: [...changed.keys()].map((id) => s.index.byId.get(id) as BoardNode).filter(Boolean), removed: removedAll },
    warnings
  }
}

/** The world matrix of an object now, relative to what its node shows when the scene has ended. */
export function overrideMatrix(timeline: Timeline, object: number, t: number, inverseBaked: Matrix): Matrix {
  return multiply(timeline.matrix(object, t), inverseBaked)
}
