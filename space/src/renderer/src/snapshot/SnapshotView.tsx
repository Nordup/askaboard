import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BoardNode } from '@shared/board-format'
import type { SnapshotRequest } from '@shared/space-api'
import { ContentLayer, measureContent, type ContentContext } from '../board/content'
import { paintItems } from '../board/paint'
import { addInkLayout, buildIndex, inkOffset, inkPaintOrder, type SceneIndex } from '../board/scene'
import '../board/board.css'
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

export function SnapshotView() {
  const [request, setRequest] = useState<{ request: SnapshotRequest; index: SceneIndex } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<HTMLImageElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const markerRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      window.space.onSnapshotRequest((next) => {
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
      const missingImages = await imagesSettled(root)
      await frame()
      if (cancelled) return
      const layout = measureContent(root, elements.current, req.scale)
      addInkLayout(index, layout)
      const inks = inkPaintOrder(index).map((node) => {
        const box = layout.get(node.id)
        return { node, offset: (box ? [box.ox, box.oy] : inkOffset(node, index.byId, layout)) as [number, number] }
      })
      const camera = { center: [req.rect.x + req.rect.width / 2, req.rect.y + req.rect.height / 2] as [number, number], zoom: req.scale }
      // Ink goes through a decoded <img>, not a live canvas: in an offscreen window a canvas can reach the
      // compositor a frame after the DOM, and the marker below must never show before the ink.
      const canvas = document.createElement('canvas')
      paintItems(canvas, inks, [req.width, req.height], camera)
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
      if (marker) marker.style.background = `rgb(${req.requestId % 256}, ${Math.floor(req.requestId / 256) % 256}, 255)`
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
