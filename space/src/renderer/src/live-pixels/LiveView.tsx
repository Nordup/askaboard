import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { isOldLive, type LiveNode } from '@shared/board-format'
import { LiveItem, type LiveStatus } from './registry'
import { askTrust } from './trust'
import './live.css'

/**
 * The view of one world in the content layer: an invisible anchor, so that
 * selection, moving, undo and the layout cache work. The pixels are on the
 * world surface. A failed world shows a quiet note here, and so does a world in
 * a folder the learner has not trusted (U19), with the way to trust it.
 *
 * In the snapshot window (agent screenshots, preview frames) a world shows on
 * the frame's world layer, from the still that the request carries (made on the
 * main window, stills.ts). The snapshot window runs no code.
 *
 * An item saved by an older app (a shader, canvas or program item) keeps its
 * data, and it shows a note at its place.
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

function Note({ style, common, title, detail }: Pick<Props, 'style' | 'common'> & { title: string; detail?: string }) {
  return (
    <div {...common} className="node node-live node-live--note" style={style}>
      <div className="node-live__note">
        <span className="node-live__note-title">{title}</span>
        {detail && <span className="node-live__note-detail">{detail}</span>}
      </div>
    </div>
  )
}

function LiveRunner({ node, style, common }: Props) {
  const box = useRef<HTMLDivElement | null>(null)
  const item = useRef<LiveItem | null>(null)
  const [status, setStatus] = useState<LiveStatus>({ state: 'paused', frames: 0 })

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const created = new LiveItem(node.id, node, element, setStatus)
    item.current = created
    return () => {
      created.dispose()
      item.current = null
    }
    // A new id is a new item; node changes go through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  useEffect(() => {
    item.current?.update(node)
  }, [node])

  const failed = status.state === 'error'
  const untrusted = status.state === 'untrusted'
  return (
    <div
      {...common}
      ref={(element) => {
        box.current = element as HTMLDivElement | null
        common.ref(element)
      }}
      className={`node node-live${failed || untrusted ? ' node-live--note' : ''}`}
      style={style}
    >
      {failed && (
        <div className="node-live__note">
          <span className="node-live__note-title">World error</span>
          <span className="node-live__note-detail">{firstLine(status.error)}</span>
        </div>
      )}
      {untrusted && (
        <div className="node-live__note">
          <span className="node-live__note-title">World paused</span>
          <span className="node-live__note-detail">This folder is not trusted</span>
          {/* The press is the button's own: it starts no selection, drag or ink on the board. */}
          <button
            className="btn-text node-live__note-action"
            data-action="trust-folder"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={askTrust}
          >
            Trust folder…
          </button>
        </div>
      )}
    </div>
  )
}

function LiveStill({ node, style, common }: Props) {
  const given = (node as unknown as { still?: unknown }).still
  if (typeof given === 'string' && given.startsWith('data:image/')) return <div {...common} className="node node-live" style={style} />
  return <Note style={style} common={common} title="World" />
}

export function LiveView(props: Props) {
  if (isOldLive(props.node)) return <Note style={props.style} common={props.common} title="Made with an older kind of item. Ask to rebuild it as a world." />
  return SNAPSHOT ? <LiveStill {...props} /> : <LiveRunner {...props} />
}
