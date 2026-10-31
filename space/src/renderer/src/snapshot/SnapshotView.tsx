import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isLive, type BoardNode } from '@shared/board-format'
import type { SnapshotMark, SnapshotOverlays, SnapshotRequest } from '@shared/space-api'
import { ContentLayer, measureContent, type ContentContext } from '../board/content'
import { paintItems } from '../board/paint'
import { applyElementOverride, type NodeOverride, type PlaybackTip } from '../board/playback'
import { addInkLayout, buildIndex, inkOffset, inkPaintOrder, type SceneIndex } from '../board/scene'
import type { LayoutBox } from '../board/types'
import '../board/board.css'
import './snapshot.css'

/**
 * Snapshot mode (`?snapshot=1`): the hidden offscreen window the main process
 * captures for agent screenshots. It draws one board region with the app's
 * own content layer and ink painter, at the requested scale, then answers.
 * A grid request (preview_scene) draws the region once per frame, each
 * frame with its own moment, so that one capture holds all frames.
 */

const IMAGE_WAIT_MS = 4000

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

async function imagesSettled(root: HTMLElement): Promise<number> {
  const images = [...root.querySelectorAll('img')]
  await Promise.race([
    Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener('load', () => resolve(), { once: true })
              image.addEventListener('error', () => resolve(), { once: true })
            })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS))
  ])
  return images.filter((image) => !image.complete || image.naturalWidth === 0).length
}

/** The agent-only overlays: a board-coordinate grid and id tags. Clipped to the image. */
function Overlays({ req, overlays }: { req: SnapshotRequest; overlays: SnapshotOverlays }) {
  const toX = (x: number): number => (x - req.rect.x) * req.scale
  const toY = (y: number): number => (y - req.rect.y) * req.scale
  const pitch = overlays.grid
  const xs: number[] = []
  const ys: number[] = []
  if (pitch > 0) {
    for (let x = Math.ceil(req.rect.x / pitch) * pitch; x <= req.rect.x + req.rect.width; x += pitch) xs.push(x)
    for (let y = Math.ceil(req.rect.y / pitch) * pitch; y <= req.rect.y + req.rect.height; y += pitch) ys.push(y)
  }
  return (
    <div className="snapshot__overlays" style={{ width: req.width, height: req.height }}>
      {pitch > 0 && (
        <svg className="snapshot__grid" width={req.width} height={req.height}>
          {xs.map((x) => (
            <line key={`x${x}`} x1={toX(x)} x2={toX(x)} y1={0} y2={req.height} className={x === 0 ? 'snapshot__axis' : undefined} />
          ))}
          {ys.map((y) => (
            <line key={`y${y}`} y1={toY(y)} y2={toY(y)} x1={0} x2={req.width} className={y === 0 ? 'snapshot__axis' : undefined} />
          ))}
          {xs.map((x) => (
            <text key={`tx${x}`} x={toX(x) + 3} y={11}>
              {x}
            </text>
          ))}
          {ys.map((y) => (
            <text key={`ty${y}`} x={3} y={toY(y) - 3}>
              {y}
            </text>
          ))}
        </svg>
      )}
      {overlays.labels.map((label, i) => {
        const left = Math.round(toX(label.rect.x))
        const top = Math.round(toY(label.rect.y))
        // The tag sits just above the box, or inside its top-left when there is no room above.
        const tagTop = top >= 16 ? top - 16 : Math.max(0, top)
        return (
          <div key={i}>
            <div
              className="snapshot__label-box"
              style={{
                left,
                top,
                width: Math.max(2, Math.round(label.rect.width * req.scale)),
                height: Math.max(2, Math.round(label.rect.height * req.scale)),
                borderColor: label.color
              }}
            />
            <div className="snapshot__tag" style={{ left: Math.max(0, left), top: tagTop, background: label.color, color: label.textColor }}>
              {label.text}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** A tag's size in pixels (snapshot.css .snapshot__mark-tag: 11 px monospace, line 14, padding 1 5): one character's advance, the padding and the height. */
const TAG_CHAR = 6.65
const TAG_PAD = 10
const TAG_H = 16

/**
 * The marks of one preview frame (the learner's view, the parts that app UI covers), in pixels
 * of the frame; each tag is DOM in image pixels, so it stays the same size at every scale.
 * A tag sits as the id tags do (Overlays): just above its mark at its left, or inside the top-left
 * of the mark's visible part when there is no room above (the frame's edge or its label).
 * Every tag stays inside the frame and clear of the tags before it.
 */
function Marks({ req, cell }: { req: SnapshotRequest; cell: CellPlan }) {
  const taken: Array<{ left: number; top: number; right: number; bottom: number }> = []
  const placed = cell.marks.flatMap((mark) => {
    const left = Math.round((mark.rect.x - req.rect.x) * req.scale)
    const top = Math.round((mark.rect.y - req.rect.y) * req.scale)
    const width = Math.max(2, Math.round(mark.rect.width * req.scale))
    const height = Math.max(2, Math.round(mark.rect.height * req.scale))
    const visible = { left: Math.max(0, left), top: Math.max(cell.markTop, top), right: Math.min(cell.width, left + width), bottom: Math.min(cell.height, top + height) }
    if (visible.right <= visible.left || visible.bottom <= visible.top) return []
    const tagW = Math.ceil(mark.tag.length * TAG_CHAR + TAG_PAD)
    const tag = { left: visible.left, top: top - TAG_H >= cell.markTop && top < cell.height ? top - TAG_H : visible.top }
    // Inside the frame, and clear of the tags placed before it (moved down past them).
    tag.left = Math.max(0, Math.min(tag.left, cell.width - tagW))
    for (let moved = true, guard = 0; moved && guard < cell.marks.length; guard++) {
      moved = false
      for (const other of taken) {
        if (tag.left < other.right && tag.left + tagW > other.left && tag.top < other.bottom && tag.top + TAG_H > other.top) {
          tag.top = other.bottom + 2
          moved = true
        }
      }
    }
    tag.top = Math.min(tag.top, cell.height - TAG_H)
    taken.push({ left: tag.left, top: tag.top, right: tag.left + tagW, bottom: tag.top + TAG_H })
    return [{ mark, box: { left, top, width, height }, tag }]
  })
  return (
    <>
      {placed.map(({ mark, box }, i) => (
        <div key={`m${i}`} className={`snapshot__mark snapshot__mark--${mark.kind}`} style={box} />
      ))}
      {placed.map(({ mark, tag }, i) => (
        <div key={`t${i}`} className="snapshot__mark-tag" style={tag}>
          {mark.tag}
        </div>
      ))}
    </>
  )
}

/**
 * The frame marker for a request id, as a CSS hex colour. This encodes data, not a design colour:
 * it must match `markerColor` in main/snapshot.ts (r = id % 256, g = (id / 256) % 256, b = 255).
 */
function markerColour(id: number): string {
  const channels = [id % 256, Math.floor(id / 256) % 256, 255]
  return '#' + channels.map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** One frame of a request: its place and size in the image, its nodes and its playback. */
interface CellPlan {
  left: number
  top: number
  width: number
  height: number
  index: SceneIndex
  playback?: SnapshotRequest['playback']
  marks: SnapshotMark[]
  /** The pixels at the top that the frame's label takes (mark tags stay below). */
  markTop: number
}

/** The frames of a request: one for a plain request, one per cell for a grid (shared nodes, then the cell's own nodes, live items as their stills). */
function cellsOf(req: SnapshotRequest): CellPlan[] {
  if (!req.cells) return [{ left: 0, top: 0, width: req.width, height: req.height, index: buildIndex(req.nodes as BoardNode[]), playback: req.playback, marks: [], markTop: 0 }]
  const { width, height, markTop = 0 } = req.cells
  return req.cells.list.map((cell) => {
    const stills = cell.stills
    const boxes = cell.stillBoxes
    const shared = stills ? (req.nodes as BoardNode[]).map((node) => (stills[node.id] ? ({ ...node, still: stills[node.id], ...(boxes?.[node.id] ? { stillBox: boxes[node.id] } : {}) } as BoardNode) : node)) : (req.nodes as BoardNode[])
    return { left: cell.left, top: cell.top, width, height, index: buildIndex([...shared, ...(cell.nodes as BoardNode[])]), playback: cell.playback, marks: cell.marks ?? [], markTop }
  })
}

/**
 * The world stills of a frame, as on the board: above the content, below the
 * ink, in board order, with no clip at the world's rect.
 */
async function showWorlds(layer: HTMLDivElement | null, root: HTMLElement, index: SceneIndex, layout: ReadonlyMap<string, LayoutBox>, overrides: ReadonlyMap<string, NodeOverride>): Promise<void> {
  if (!layer) return
  layer.style.transform = root.style.transform
  const worlds = [...index.byId.values()].filter(isLive).filter((node) => node.mode === 'world').sort((a, b) => a.z - b.z)
  for (const node of worlds) {
    const { still, stillBox: place } = node as unknown as { still?: unknown; stillBox?: { x: number; y: number; w: number; h: number } }
    const box = layout.get(node.id)
    if (typeof still !== 'string' || !still || !place || !box) continue
    const image = new Image()
    image.className = 'snapshot__world'
    image.src = still
    image.style.left = `${box.x + place.x}px`
    image.style.top = `${box.y + place.y}px`
    image.style.width = `${place.w}px`
    image.style.height = `${place.h}px`
    const opacity = Number(node.style?.opacity ?? '1') || 1
    image.style.opacity = String(opacity)
    layer.appendChild(image)
    await image.decode().catch(() => undefined)
    const override = overrides.get(node.id)
    if (override) applyElementOverride(image, override, [box.x + place.x, box.y + place.y], opacity)
  }
}

/**
 * One frame: the board region with the app's own content layer and ink
 * painter, its playback moment applied. It reports when it is drawn
 * (fonts, math, images and ink decoded) or failed.
 */
function SnapshotFrame({ req, cell, onDone }: { req: SnapshotRequest; cell: CellPlan; onDone: (result: number | Error) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLImageElement>(null)
  const worldsRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const ctx = useRef<ContentContext>(null as unknown as ContentContext)
  ctx.current = {
    index: cell.index,
    editingId: null,
    editorRef,
    editorInitial: '',
    onEditorCommit: () => undefined,
    register: (id, element) => {
      if (element) elements.current.set(id, element)
      else elements.current.delete(id)
    },
    onMedia: () => undefined
  }

  useLayoutEffect(() => {
    let cancelled = false
    const root = rootRef.current
    if (root) root.style.transform = `translate(${-req.rect.x * req.scale}px, ${-req.rect.y * req.scale}px) scale(${req.scale})`
    const run = async (): Promise<number> => {
      if (!root) throw new Error('The snapshot page has no content root.')
      await document.fonts.ready
      // Live items come as finished stills (images): they settle with the other images.
      const missingImages = await imagesSettled(root)
      await frame()
      if (cancelled) return missingImages
      const layout = measureContent(root, elements.current, req.scale)
      addInkLayout(cell.index, layout)
      // A moment of a live scene: its look of each node (measured without it first).
      const overrides = new Map((cell.playback?.overrides ?? []) as Array<[string, NodeOverride]>)
      for (const [id, override] of overrides) {
        const element = elements.current.get(id)
        const box = layout.get(id)
        if (!element || !box) continue
        const node = cell.index.byId.get(id) as { style?: { opacity?: string } } | undefined
        applyElementOverride(element, override, [box.x, box.y], Number(node?.style?.opacity ?? '1') || 1)
      }
      await showWorlds(worldsRef.current, root, cell.index, layout, overrides)
      const inks = inkPaintOrder(cell.index).map((node) => {
        const box = layout.get(node.id)
        return { node, offset: (box ? [box.ox, box.oy] : inkOffset(node, cell.index.byId, layout)) as [number, number] }
      })
      const camera = { center: [req.rect.x + req.rect.width / 2, req.rect.y + req.rect.height / 2] as [number, number], zoom: req.scale }
      // Ink goes through a decoded <img>, not a live canvas: in an offscreen window a canvas can reach the
      // compositor a frame after the DOM, and the marker must never show before the ink.
      const canvas = document.createElement('canvas')
      paintItems(canvas, inks, [cell.width, cell.height], camera, new Set(), cell.playback ? { overrides, ghosts: [], tips: (cell.playback.tips ?? []) as PlaybackTip[] } : null)
      const ink = inkRef.current
      if (ink) {
        ink.src = canvas.toDataURL('image/png')
        ink.style.width = `${cell.width}px`
        ink.style.height = `${cell.height}px`
        await ink.decode().catch(() => undefined)
      }
      return missingImages
    }
    run().then(
      (missing) => !cancelled && onDone(missing),
      (error: unknown) => !cancelled && onDone(error instanceof Error ? error : new Error(String(error)))
    )
    return () => {
      cancelled = true
    }
    // One run per frame: the parent mounts a new frame for each request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="snapshot__frame" style={{ left: cell.left, top: cell.top, width: cell.width, height: cell.height, background: req.background }}>
      <ContentLayer index={cell.index} editingId={null} ctx={ctx} rootRef={rootRef} />
      <div className="snapshot__worlds" ref={worldsRef} />
      <img className="snapshot__ink" ref={inkRef} alt="" />
      {req.overlays && <Overlays req={req} overlays={req.overlays} />}
      {req.outlines.map((outline, i) => (
        <div
          key={i}
          className="snapshot__outline"
          style={{
            left: Math.round((outline.rect.x - req.rect.x) * req.scale),
            top: Math.round((outline.rect.y - req.rect.y) * req.scale),
            width: Math.max(2, Math.round(outline.rect.width * req.scale)),
            height: Math.max(2, Math.round(outline.rect.height * req.scale)),
            borderColor: outline.color
          }}
        />
      ))}
      <Marks req={req} cell={cell} />
    </div>
  )
}

export function SnapshotView() {
  const [request, setRequest] = useState<{ request: SnapshotRequest; cells: CellPlan[] } | null>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  /** The frames of the current request that are drawn, and the images that did not load. */
  const progress = useRef({ requestId: 0, done: 0, missing: 0, failed: false })

  // Every font face of the page (board fonts, KaTeX) loads now, so the first capture with text or maths does not wait for them.
  useEffect(() => {
    document.fonts.forEach((face) => void face.load().catch(() => undefined))
  }, [])

  useEffect(
    () =>
      window.space.onSnapshotRequest((next) => {
        progress.current = { requestId: next.requestId, done: 0, missing: 0, failed: false }
        setRequest({ request: next, cells: cellsOf(next) })
      }),
    []
  )

  const req = request?.request
  useLayoutEffect(() => {
    if (req) document.body.style.background = req.cells?.gapColor ?? req.background
  }, [req])

  /** A frame is drawn (or failed): when all are, set the marker (see main/snapshot.ts) and answer. */
  const frameDone = (requestId: number, count: number, result: number | Error): void => {
    const state = progress.current
    if (state.requestId !== requestId || state.failed) return
    if (result instanceof Error) {
      state.failed = true
      window.space.snapshotReady({ requestId, ok: false, error: result.message })
      return
    }
    state.missing += result
    if (++state.done < count) return
    // The marker goes on after every frame's ink is set, so a frame that shows it shows all the ink.
    const marker = markerRef.current
    if (marker) marker.style.background = markerColour(requestId)
    void frame().then(() => {
      if (progress.current.requestId === requestId) window.space.snapshotReady({ requestId, ok: true, missingImages: state.missing })
    })
  }

  return (
    <div className="snapshot" style={req ? { width: req.width, height: req.height + 1, background: req.cells?.gapColor ?? req.background } : undefined}>
      {/* A fresh tree per request: nothing of an earlier capture (styles of a scene moment, measured boxes) carries over. */}
      {request?.cells.map((cell, i) => (
        <SnapshotFrame key={`${request.request.requestId}-${i}`} req={request.request} cell={cell} onDone={(result) => frameDone(request.request.requestId, request.cells.length, result)} />
      ))}
      <div className="snapshot__marker" ref={markerRef} style={req ? { top: req.height } : undefined} />
    </div>
  )
}
