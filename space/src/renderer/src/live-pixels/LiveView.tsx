import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { LiveNode } from '@shared/board-format'
import { LiveItem, enteredLive, observe, subscribeEntered, unobserve, type LiveStatus } from './registry'
import { shaderEngine } from './shader'
import { ProgramHost } from './program'
import { snapshotClock, snapshotParams, trackStill } from './snapshot-stills'
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
      : status.state === 'stalled'
        ? { title: 'Not responding', detail: node.mode === 'program' ? 'The program is busy and does not answer.' : 'The canvas code has not finished a frame.' }
        : null
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
    </div>
  )
}

function LiveStill({ node, style, common }: Props) {
  const given = (node as unknown as { still?: unknown }).still
  const clock = snapshotClock(node.id)
  const atParams = snapshotParams(node.id)
  const params = useMemo(() => (atParams ? { ...node.params, ...atParams } : node.params), [atParams, node.params])
  const time = clock ? Math.max(0, clock.t) : 0
  const givenUrl = typeof given === 'string' && given.startsWith('data:image/') && !clock ? given : null
  const shaderUrl = useMemo(() => {
    if (givenUrl || node.mode !== 'shader') return null
    // One frame at the scene's moment (or t = 0), drawn synchronously into an image (the snapshot waits for images).
    const result = shaderEngine.compile(node.code, params)
    if (!result.ok) return null
    const pw = Math.max(1, Math.round(node.w * 2))
    const ph = Math.max(1, Math.round(node.h * 2))
    const canvas = document.createElement('canvas')
    canvas.width = pw
    canvas.height = ph
    const ctx = canvas.getContext('2d')
    if (!ctx || !shaderEngine.render(result.program, pw, ph, time, 0, params, ctx)) return null
    return canvas.toDataURL('image/png')
  }, [givenUrl, node, params, time])

  // A program item: run it in a hidden frame at this moment until it paints, then show its picture.
  const runner = useRef<HTMLDivElement | null>(null)
  const sim = clock?.sim ?? null
  const runKey = node.mode === 'program' && !givenUrl ? `${node.id}|${node.code}|${time}|${clock?.step ?? ''}|${JSON.stringify(params)}|${node.w}x${node.h}|${sim ? JSON.stringify(sim) : ''}` : ''
  const [ran, setRan] = useState<{ key: string; url: string | null } | null>(null)
  useLayoutEffect(() => {
    const element = runner.current
    if (!runKey || !element) return
    let settled = false
    let host: ProgramHost | null = null
    let timer = 0
    let release = (): void => undefined
    const work = new Promise<void>((resolve) => {
      release = resolve
      let asked = false
      const finish = (url: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        host?.dispose()
        setRan({ key: runKey, url })
        resolve()
      }
      const ask = (): void => {
        if (asked || !host) return
        asked = true
        void host.still(1500).then(finish)
      }
      const pw = Math.max(1, Math.round(node.w * 2))
      const ph = Math.max(1, Math.round(node.h * 2))
      host = new ProgramHost(
        element,
        { code: node.code, size: { w: node.w, h: node.h, pw, ph }, params, start: performance.timeOrigin + performance.now() - time * 1000, visible: true, clock, sim },
        {
          onTick: (frames) => frames >= 3 && ask(),
          onError: () => finish(null),
          onInput: () => undefined,
          onReport: () => undefined,
          onEscape: () => undefined,
          // A storyboard run computes the program up to this moment: it takes as long as it needs, while it moves on.
          onProgress: () => {
            clearTimeout(timer)
            timer = window.setTimeout(ask, 3000)
          }
        }
      )
      timer = window.setTimeout(ask, sim ? 10000 : 3000)
    })
    trackStill(work)
    return () => {
      // A run that ends early (a new request, StrictMode's second mount) no longer holds the snapshot.
      settled = true
      clearTimeout(timer)
      host?.dispose()
      release()
    }
    // runKey holds everything the run depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey])

  const url = givenUrl ?? shaderUrl ?? (ran && ran.key === runKey ? ran.url : null)
  const waiting = !!runKey && !(ran && ran.key === runKey)
  if (!url) {
    return (
      <div {...common} className={`node node-live${waiting ? '' : ' node-live--note'}`} style={style}>
        {waiting ? (
          <div ref={runner} className="node-live__runner" />
        ) : (
          <div className="node-live__note">
            <span className="node-live__note-title">{node.mode === 'shader' ? 'Shader' : node.mode === 'program' ? 'Program' : 'Live canvas'}</span>
          </div>
        )}
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
