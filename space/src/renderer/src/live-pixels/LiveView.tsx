import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { LiveNode } from '@shared/board-format'
import { LiveItem, observe, unobserve, type LiveStatus } from './registry'
import { shaderEngine } from './shader'
import './live.css'

/**
 * The view of one live pixel item in the content layer. The pixels come from
 * a LiveItem (registry.ts); this component only gives it a box and shows a
 * quiet note when the code fails or stops answering.
 *
 * In the snapshot window (agent screenshots) the item shows a still image:
 * the main window's current pixels when the screenshot plan carries them
 * (`still`), else one frame of a shader at t = 0.
 */

const SNAPSHOT = new URLSearchParams(window.location.search).get('snapshot') === '1'

interface Props {
  node: LiveNode
  style: CSSProperties
  common: { 'data-node-id': string; 'data-kind': string; ref: (element: HTMLElement | null) => void }
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').find((line) => line.trim()) ?? ''
}

function LiveRunner({ node, style, common }: Props) {
  const box = useRef<HTMLDivElement | null>(null)
  const item = useRef<LiveItem | null>(null)
  const [status, setStatus] = useState<LiveStatus>({ state: 'starting', frames: 0 })

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const created = new LiveItem(node.id, node, element, setStatus)
    item.current = created
    observe(element, created)
    return () => {
      unobserve(element)
      created.dispose()
      item.current = null
    }
    // A new id is a new item; node changes go through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  useEffect(() => {
    item.current?.update(node)
  }, [node])

  const note =
    status.state === 'error'
      ? { title: node.mode === 'shader' ? 'Shader error' : 'Canvas error', detail: firstLine(status.error) }
      : status.state === 'stalled'
        ? { title: 'Not responding', detail: 'The canvas code has not finished a frame.' }
        : null

  return (
    <div
      {...common}
      ref={(element) => {
        box.current = element as HTMLDivElement | null
        common.ref(element)
      }}
      className={`node node-live${note ? ' node-live--note' : ''}`}
      style={style}
    >
      {note && (
        <div className="node-live__note" title={status.error}>
          <span className="node-live__note-title">{note.title}</span>
          {note.detail && <span className="node-live__note-detail">{note.detail}</span>}
        </div>
      )}
    </div>
  )
}

function LiveStill({ node, style, common }: Props) {
  const given = (node as unknown as { still?: unknown }).still
  const url = useMemo(() => {
    if (typeof given === 'string' && given.startsWith('data:image/')) return given
    if (node.mode !== 'shader') return null
    // One frame at t = 0, drawn synchronously into an image (the snapshot waits for images).
    const result = shaderEngine.compile(node.code, node.params)
    if (!result.ok) return null
    const pw = Math.max(1, Math.round(node.w * 2))
    const ph = Math.max(1, Math.round(node.h * 2))
    const canvas = document.createElement('canvas')
    canvas.width = pw
    canvas.height = ph
    const ctx = canvas.getContext('2d')
    if (!ctx || !shaderEngine.render(result.program, pw, ph, 0, 0, node.params, ctx)) return null
    return canvas.toDataURL('image/png')
  }, [given, node])
  if (!url) {
    return (
      <div {...common} className="node node-live node-live--note" style={style}>
        <div className="node-live__note">
          <span className="node-live__note-title">{node.mode === 'shader' ? 'Shader' : 'Live canvas'}</span>
        </div>
      </div>
    )
  }
  return (
    <div {...common} className="node node-live" style={style}>
      <img className="node-live__canvas" src={url} alt="" draggable={false} />
    </div>
  )
}

export function LiveView(props: Props) {
  return SNAPSHOT ? <LiveStill {...props} /> : <LiveRunner {...props} />
}
