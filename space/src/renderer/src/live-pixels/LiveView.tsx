import { RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { LiveNode } from '@shared/board-format'
import { LiveItem, enteredLive, observe, subscribeEntered, unobserve, type LiveStatus } from './registry'
import './live.css'

/**
 * The view of one live pixel item in the content layer. The pixels come from
 * a LiveItem (registry.ts); this component only gives it a box and shows a
 * quiet note when the code fails or waits for a slot. An item that stops
 * answering keeps its last picture and shows a small pill with a Restart button.
 *
 * In the snapshot window (agent screenshots, preview frames) the item shows
 * the still image that the request carries (`still`: made on the main window
 * by the item's host or a step host, stills.ts). The snapshot window runs no
 * live code.
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
  const [status, setStatus] = useState<LiveStatus>({ state: 'paused', frames: 0 })
  const entered = useSyncExternalStore(subscribeEntered, enteredLive) === node.id

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
      ? { title: node.mode === 'shader' ? 'Shader error' : node.mode === 'program' ? 'Program error' : 'Canvas error', detail: firstLine(status.error) }
      : status.state === 'waiting'
        ? { title: 'Waiting', detail: 'Too many live items run at once.' }
        : null
  const stalled = status.state === 'stalled'
  const input = entered ? ' node-live--entered' : status.input === 'direct' && !note ? ' node-live--direct' : ''

  return (
    <div
      {...common}
      ref={(element) => {
        box.current = element as HTMLDivElement | null
        common.ref(element)
      }}
      className={`node node-live${note ? ' node-live--note' : ''}${input}`}
      style={style}
    >
      {note && (
        <div className="node-live__note" title={status.error}>
          <span className="node-live__note-title">{note.title}</span>
          {note.detail && <span className="node-live__note-detail">{note.detail}</span>}
        </div>
      )}
      {stalled && (
        // The board does not see presses on the pill: no ink, no selection, no double-click.
        <div
          className="pill pill--static pill--item"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="status-dot status-dot--small status-dot--error" />
          <span className="pill__label">Not responding</span>
          <button className="pill__action" title="Restart" aria-label="Restart" onClick={() => item.current?.retry()}>
            <RotateCcw size={12} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  )
}

function LiveStill({ node, style, common }: Props) {
  const given = (node as unknown as { still?: unknown }).still
  const url = typeof given === 'string' && given.startsWith('data:image/') ? given : null
  if (!url) {
    return (
      <div {...common} className="node node-live node-live--note" style={style}>
        <div className="node-live__note">
          <span className="node-live__note-title">{node.mode === 'shader' ? 'Shader' : node.mode === 'program' ? 'Program' : 'Live canvas'}</span>
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
