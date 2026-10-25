import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardNode } from '@shared/board-format'
import type { SnapshotOverlays, SnapshotRequest } from '@shared/space-api'
import { ContentLayer, measureContent, type ContentContext } from '../board/content'
import { paintItems } from '../board/paint'
import { applyElementOverride, clearElementOverride, type NodeOverride, type PlaybackTip } from '../board/playback'
import { addInkLayout, buildIndex, inkOffset, inkPaintOrder, type SceneIndex } from '../board/scene'
import '../board/board.css'
import { setSnapshotPlayback, stillsSettled } from '../live-pixels/snapshot-stills'
import './snapshot.css'

/**
 * Snapshot mode (`?snapshot=1`): the hidden offscreen window the main process
 * captures for agent screenshots. It draws one board region with the app's
 * own content layer and ink painter, at the requested scale, then answers.
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

/**
 * The frame marker for a request id, as a CSS hex colour. This encodes data, not a design colour:
 * it must match `markerColor` in main/snapshot.ts (r = id % 256, g = (id / 256) % 256, b = 255).
 */
function markerColour(id: number): string {
  const channels = [id % 256, Math.floor(id / 256) % 256, 255]
  return '#' + channels.map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function SnapshotView() {
  const [request, setRequest] = useState<{ request: SnapshotRequest; index: SceneIndex } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLImageElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const markerRef = useRef<HTMLDivElement>(null)
  const overridden = useRef(new Set<HTMLElement>())

  useEffect(
    () =>
      window.space.onSnapshotRequest((next) => {
        setSnapshotPlayback(next.playback)
        setRequest({ request: next, index: buildIndex(next.nodes as BoardNode[]) })
      }),
    []
  )

  const ctx = useRef<ContentContext>(null as unknown as ContentContext)
  ctx.current = {
    index: request?.index ?? buildIndex([]),
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
    if (!request) return
    const { request: req, index } = request
    let cancelled = false
    const root = rootRef.current
    if (root) root.style.transform = `translate(${-req.rect.x * req.scale}px, ${-req.rect.y * req.scale}px) scale(${req.scale})`
    document.body.style.background = req.background
    const run = async (): Promise<void> => {
      if (!root) throw new Error('The snapshot page has no content root.')
      await document.fonts.ready
      await stillsSettled()
      const missingImages = await imagesSettled(root)
      await frame()
      if (cancelled) return
      for (const element of overridden.current) clearElementOverride(element)
      overridden.current.clear()
      const layout = measureContent(root, elements.current, req.scale)
      addInkLayout(index, layout)
      // A moment of a live scene: its look of each node (measured without it first).
      const overrides = new Map((req.playback?.overrides ?? []) as Array<[string, NodeOverride]>)
      for (const [id, override] of overrides) {
        const element = elements.current.get(id)
        const box = layout.get(id)
        if (!element || !box) continue
        const node = index.byId.get(id) as { style?: { opacity?: string } } | undefined
        applyElementOverride(element, override, [box.x, box.y], Number(node?.style?.opacity ?? '1') || 1)
        overridden.current.add(element)
      }
      const inks = inkPaintOrder(index).map((node) => {
        const box = layout.get(node.id)
        return { node, offset: (box ? [box.ox, box.oy] : inkOffset(node, index.byId, layout)) as [number, number] }
      })
      const camera = { center: [req.rect.x + req.rect.width / 2, req.rect.y + req.rect.height / 2] as [number, number], zoom: req.scale }
      // Ink goes through a decoded <img>, not a live canvas: in an offscreen window a canvas can reach the
      // compositor a frame after the DOM, and the marker below must never show before the ink.
      const canvas = document.createElement('canvas')
      paintItems(canvas, inks, [req.width, req.height], camera, new Set(), req.playback ? { overrides, ghosts: [], tips: (req.playback.tips ?? []) as PlaybackTip[] } : null)
      const ink = inkRef.current
      if (ink) {
        ink.src = canvas.toDataURL('image/png')
        ink.style.width = `${req.width}px`
        ink.style.height = `${req.height}px`
        await ink.decode().catch(() => undefined)
      }
      if (cancelled) return
      // The frame marker (see main/snapshot.ts): set in the same task as the ink, so a frame that shows it shows the ink.
      const marker = markerRef.current
      if (marker) marker.style.background = markerColour(req.requestId)
      await frame()
      if (!cancelled) window.space.snapshotReady({ requestId: req.requestId, ok: true, missingImages })
    }
    run().catch((error: unknown) => {
      window.space.snapshotReady({ requestId: req.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      cancelled = true
    }
  }, [request])

  const req = request?.request
  return (
    <div className="snapshot" style={req ? { width: req.width, height: req.height + 1, background: req.background } : undefined}>
      {request && <ContentLayer index={request.index} editingId={null} ctx={ctx} rootRef={rootRef} />}
      <img className="snapshot__ink" ref={inkRef} alt="" />
      {req?.overlays && <Overlays req={req} overlays={req.overlays} />}
      <div className="snapshot__marker" ref={markerRef} style={req ? { top: req.height } : undefined} />
      {req?.outlines.map((outline, i) => (
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
    </div>
  )
}
