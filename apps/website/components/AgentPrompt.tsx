'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { LOGO_PATHS } from '@/lib/logos'
import board from './Board.module.css'
import styles from './AgentPrompt.module.css'
import { USE_CASES } from './usecases'

/** Milliseconds per typed character, and the pause after the reply line before the board starts. */
const TYPE_MS = 55
const WORK_MS = 650

/**
 * The chat app's window in front of the app shell's lower-left corner: each use case starts the
 * way it really happens. The person types the request in their own chat app (Claude, ChatGPT: the
 * app's mark and name in the title bar; the request types into their message bubble), the app
 * answers with "Drawing it on the board…", and only then the board in the shell starts drawing
 * (`onDone`). Learning Space has no input box of its own, so the question is
 * never inside the shell. The window has the hero windows' quiet look, wakes on hover and drags.
 * `index` is the use case asked now (-1: none yet).
 */
export function AgentPrompt({ index, onDone }: { index: number; onDone: (i: number) => void }) {
  const useCase = index >= 0 ? USE_CASES[index] : null
  const [typed, setTyped] = useState(0)
  const [working, setWorking] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  /** The use cases whose request was typed out once: asked again, the request shows whole and the board plays at once. */
  const typedOnce = useRef(new Set<number>())

  useEffect(() => {
    setTyped(0)
    setWorking(false)
    if (index < 0) return
    const text = USE_CASES[index].request
    if (typedOnce.current.has(index) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(text.length)
      setWorking(true)
      done.current(index)
      return
    }
    let frame = 0
    let timer = 0
    const t0 = performance.now()
    const step = (now: number): void => {
      const n = Math.min(text.length, Math.floor((now - t0) / TYPE_MS))
      setTyped(n)
      if (n < text.length) {
        frame = requestAnimationFrame(step)
        return
      }
      // Marked only when the typing ends, so StrictMode's second effect run still types it.
      typedOnce.current.add(index)
      setWorking(true)
      timer = window.setTimeout(() => done.current(index), WORK_MS)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [index])

  // ---------- Drag: the window moves like the board's windows; hover or a grab wakes it ----------
  const [offset, setOffset] = useState<[number, number]>([0, 0])
  const [active, setActive] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; from: [number, number] } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: offset }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setOffset([d.from[0] + e.clientX - d.x, d.from[1] + e.clientY - d.y])
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setActive(false)
  }

  const text = useCase?.request ?? ''
  return (
    <div
      className={`${board.window} ${board.quiet} ${styles.app}`}
      data-ui=""
      data-agent-window=""
      data-active={active ? '' : undefined}
      style={{ translate: `${offset[0]}px ${offset[1]}px` }}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => !drag.current && setActive(false)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-label={useCase ? `${useCase.app}: ${text}` : undefined}
    >
      <div className={board.titlebar}>
        <i />
        <i />
        <i />
        <span className={styles.title}>
          {useCase && (
            <svg viewBox="0 0 24 24" className={styles[useCase.logo]} aria-hidden="true">
              <path d={LOGO_PATHS[useCase.logo]} />
            </svg>
          )}
          {useCase?.app ?? ''}
        </span>
      </div>
      <div className={styles.body}>
        <div className={styles.message}>
          {/* The whole request, hidden: it holds the window's height while the bubble grows. */}
          <span className={`${styles.bubble} ${styles.ghost}`} aria-hidden="true">
            {text || '\u00a0'}
          </span>
          {useCase && (
            <span className={styles.bubble}>
              {text.slice(0, typed)}
              {!working && <span className={styles.caret} />}
            </span>
          )}
        </div>
        <div className={styles.reply} data-shown={working ? '' : undefined}>
          {useCase && (
            <svg viewBox="0 0 24 24" className={styles[useCase.logo]} aria-hidden="true">
              <path d={LOGO_PATHS[useCase.logo]} />
            </svg>
          )}
          Drawing it on the board…
        </div>
      </div>
    </div>
  )
}
