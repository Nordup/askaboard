'use client'

import { useEffect, useRef, useState } from 'react'
import type { Agent } from '@/lib/agents'
import styles from './AgentWindow.module.css'

/** Characters typed per second, and the wait after the window comes into view. */
const SPEED = 70
const DELAY = 250

/** The app's name and the copy button, in the window's title strip (Board.tsx draws the strip and its buttons). */
export function AgentTitle({ agent }: { agent: Agent }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])
  const copy = (): void => {
    if (!agent.copy) return
    navigator.clipboard?.writeText(agent.copy).then(
      () => setCopied(true),
      () => {}
    )
  }
  return (
    <>
      <span className={styles.name}>{agent.name}</span>
      {agent.copy && (
        <button type="button" className={styles.copy} data-ui="" onClick={copy} aria-label={copied ? 'Copied' : `Copy the ${agent.name} steps`} title={copied ? 'Copied' : 'Copy'}>
          {copied ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="8" width="13" height="13" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </button>
      )}
    </>
  )
}

/**
 * The terminal in the window's body: the install steps type out once when the window first comes
 * into view, then rest. The untyped part is laid out but hidden, so the lines never reflow.
 */
export function AgentTerminal({ agent }: { agent: Agent }) {
  const ref = useRef<HTMLDivElement>(null)
  const total = agent.lines.reduce((sum, line) => sum + line.text.length, 0)
  const [typed, setTyped] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTyped(total)
      return
    }
    let frame = 0
    let timer = 0
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        seen.disconnect()
        timer = window.setTimeout(() => {
          const t0 = performance.now()
          const step = (now: number): void => {
            const n = Math.min(total, Math.floor(((now - t0) / 1000) * SPEED))
            setTyped(n)
            if (n < total) frame = requestAnimationFrame(step)
          }
          frame = requestAnimationFrame(step)
        }, DELAY)
      },
      { threshold: 0.5 }
    )
    seen.observe(el)
    return () => {
      seen.disconnect()
      clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [total])

  let left = typed
  const done = typed >= total
  return (
    <div className={styles.terminal} ref={ref}>
      <div className={styles.lines}>
        {agent.lines.map((line, i) => {
          const shown = Math.max(0, Math.min(line.text.length, left))
          const typing = !done && left >= 0 && shown < line.text.length && (shown > 0 || left === 0)
          left -= line.text.length
          const head = line.text.slice(0, shown)
          const rest = line.text.slice(shown)
          const text = (
            <>
              {head}
              {typing && <span className={styles.caret} />}
              <span className={styles.hidden}>{rest}</span>
            </>
          )
          return (
            <div key={i} className={`${styles.line} ${styles[line.kind]}`}>
              {line.kind === 'cmd' && <span className={styles.prompt}>$ </span>}
              {line.kind === 'link' ? (
                <>
                  <span className={styles.prompt}>↓ </span>
                  <a href={line.href} className={styles.link} data-ui="" download>
                    {text}
                  </a>
                </>
              ) : (
                text
              )}
            </div>
          )
        })}
      </div>
      <div className={`${styles.plan} ${done ? styles.planShown : ''}`}>Uses your {agent.plan} plan</div>
    </div>
  )
}
