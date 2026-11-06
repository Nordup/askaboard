'use client'

import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import { mountHero, type Engine, type HeroState } from './hero/engine'
import { SPRITES } from './hero/layout'
import { Icon, LOCK_KEY, TOOLS, toolKeys } from './hero/tools'
import styles from './Hero.module.css'

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
 * The hero board (decision D11): the windows and the loose ink round the headline, the visitor's
 * marks, and the app's tool pill. The section around it (Hero.tsx) takes the presses.
 */
export function HeroBoard() {
  const layerRef = useRef<HTMLDivElement>(null)
  const marksRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const engine = useRef<Engine | null>(null)
  const [state, setState] = useState<HeroState>({ tool: 'select', lock: false })

  useEffect(() => {
    const layer = layerRef.current
    const marks = marksRef.current
    const field = fieldRef.current
    const host = layer?.closest<HTMLElement>('[data-hero]')
    if (!layer || !marks || !field || !host) return
    const e = mountHero({ host, layer, marks, field, sprites: SPRITES, onChange: setState })
    engine.current = e
    return () => {
      e.stop()
      engine.current = null
    }
  }, [])

  return (
    <>
      <div className={styles.layer} ref={layerRef} aria-hidden="true">
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
      <canvas className={styles.marks} ref={marksRef} aria-hidden="true" />
      <input className={styles.field} ref={fieldRef} data-ui="" aria-label="Text" autoComplete="off" spellCheck={false} />

      <div className={styles.pill} role="toolbar" aria-label="Tools" data-ui="">
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
