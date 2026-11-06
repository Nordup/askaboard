'use client'

import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import { mountBoard, type Engine, type HeroState } from './hero/engine'
import { SPRITES } from './hero/layout'
import { Icon, LOCK_KEY, TOOLS, toolKeys } from './hero/tools'
import styles from './Board.module.css'

/** The place of a sprite as CSS variables: the desktop place, and the phone place (Hero.module.css picks one). */
function placeVars(def: (typeof SPRITES)[number]): CSSProperties {
  const d = def.desk
  const p = def.phone ?? def.desk
  return {
    '--w': String(def.w),
    '--h': String(def.h),
    '--dx': String(d.x),
    '--dy': String(d.y),
    '--dr': String(d.r),
    '--ds': String(d.s),
    '--px': String(p.x),
    '--py': String(p.y),
    '--pr': String(p.r),
    '--ps': String(p.s)
  } as CSSProperties
}

/**
 * The board over the whole page (decision D11, "The whole page is one board"): the windows and
 * the loose ink round the headline, the visitor's marks, the draft canvas and the app's tool
 * pill. The page (app/page.tsx, data-board) takes the presses.
 */
export function Board() {
  const layerRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const spotRef = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  const [state, setState] = useState<HeroState>({ tool: 'select', lock: false })
  const [docked, setDocked] = useState(false)

  // The pill sits under the headline; once that spot leaves the viewport it docks at the bottom.
  useEffect(() => {
    const spot = spotRef.current
    if (!spot) return
    const observer = new IntersectionObserver(([entry]) => setDocked(entry.intersectionRatio < 1), { threshold: [0, 1] })
    observer.observe(spot)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const layer = layerRef.current
    const draft = draftRef.current
    const field = fieldRef.current
    const host = layer?.closest<HTMLElement>('[data-board]')
    const hero = host?.querySelector<HTMLElement>('[data-hero]')
    if (!layer || !draft || !field || !host || !hero) return
    const e = mountBoard({ host, hero, layer, draft, field, sprites: SPRITES, onChange: setState })
    engine.current = e
    return () => {
      e.stop()
      engine.current = null
    }
  }, [])

  return (
    <>
      <div className={styles.layer} ref={layerRef} data-mark-class={styles.sprite} aria-hidden="true">
        {SPRITES.map((def) =>
          def.window ? (
            <div key={def.id} className={`${styles.sprite} ${styles.window}`} data-sprite={def.id} data-phone={def.phone ? 'on' : 'off'} style={placeVars(def)}>
              <div className={styles.titlebar}>
                <i />
                <i />
                <i />
              </div>
              <canvas className={styles.body} />
            </div>
          ) : (
            <div key={def.id} className={styles.sprite} data-sprite={def.id} data-phone={def.phone ? 'on' : 'off'} style={placeVars(def)}>
              <canvas className={styles.body} />
            </div>
          )
        )}
      </div>
      <canvas className={styles.draft} ref={draftRef} aria-hidden="true" />
      <div className={styles.spot} ref={spotRef} aria-hidden="true" />
      <input className={styles.field} ref={fieldRef} data-ui="" aria-label="Text" autoComplete="off" spellCheck={false} />

      <div className={docked ? `${styles.pill} ${styles.docked}` : styles.pill} role="toolbar" aria-label="Tools" data-ui="">
        <button
          className={state.lock ? styles.tool : `${styles.tool} ${styles.quiet}`}
          title={`Keep tool ${LOCK_KEY}`}
          aria-label="Keep tool"
          aria-pressed={state.lock}
          onClick={() => engine.current?.toggleLock()}
        >
          <Icon name={state.lock ? 'lock' : 'lockOpen'} />
        </button>
        <span className={styles.divider} />
        {TOOLS.map((tool, i) => (
          <Fragment key={tool.id}>
            {i > 0 && TOOLS[i - 1].group !== tool.group && <span className={styles.divider} />}
            <button
              className={styles.tool}
              title={`${tool.label} ${toolKeys(tool)}`}
              aria-label={tool.label}
              aria-pressed={state.tool === tool.id}
              onClick={() => engine.current?.setTool(tool.id)}
            >
              <Icon name={tool.id} />
            </button>
          </Fragment>
        ))}
      </div>
    </>
  )
}
