'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AgentTerminal, AgentTitle } from './AgentWindow'
import { mountBoard, type Engine, type HeroState } from './hero/engine'
import { SPRITES } from './hero/layout'
import { ToolPill } from './ToolPill'
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
  const backRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const engine = useRef<Engine | null>(null)
  const [state, setState] = useState<HeroState>({ tool: 'select', lock: false })

  useEffect(() => {
    const layer = layerRef.current
    const back = backRef.current
    const draft = draftRef.current
    const field = fieldRef.current
    const host = layer?.closest<HTMLElement>('[data-board]')
    const hero = host?.querySelector<HTMLElement>('[data-hero]')
    if (!layer || !back || !draft || !field || !host || !hero) return
    const e = mountBoard({ host, hero, layer, back, draft, field, sprites: SPRITES, onChange: setState })
    engine.current = e
    return () => {
      e.stop()
      engine.current = null
    }
  }, [])

  return (
    <>
      {/* The use cases' steps: behind the app shell's window, which scrolls them past (steps.ts). */}
      <div className={`${styles.layer} ${styles.back}`} ref={backRef} aria-hidden="true">
        {SPRITES.filter((def) => def.step).map((def) => (
          <div key={def.id} className={styles.sprite} data-sprite={def.id} data-phone={def.phone ? 'on' : 'off'} data-desk={def.deskOff ? 'off' : 'on'} style={placeVars(def)}>
            <canvas className={styles.body} />
          </div>
        ))}
      </div>
      <div className={styles.layer} ref={layerRef} data-mark-class={styles.sprite} aria-hidden="true">
        {SPRITES.filter((def) => !def.step).map((def) =>
          def.window ? (
            <div key={def.id} className={`${styles.sprite} ${styles.window}`} data-sprite={def.id} data-phone={def.phone ? 'on' : 'off'} style={placeVars(def)}>
              <div className={styles.titlebar}>
                <i />
                <i />
                <i />
                {def.agent && <AgentTitle agent={def.agent} />}
              </div>
              {def.agent ? <AgentTerminal agent={def.agent} /> : <canvas className={styles.body} />}
            </div>
          ) : (
            <div key={def.id} className={styles.sprite} data-sprite={def.id} data-phone={def.phone ? 'on' : 'off'} style={placeVars(def)}>
              <canvas className={styles.body} />
            </div>
          )
        )}
      </div>
      <canvas className={styles.draft} ref={draftRef} aria-hidden="true" />
      <input className={styles.field} ref={fieldRef} data-ui="" aria-label="Text" autoComplete="off" spellCheck={false} />

      <ToolPill className={styles.pill} tool={state.tool} lock={state.lock} onTool={(tool) => engine.current?.setTool(tool)} onLock={() => engine.current?.toggleLock()} />
    </>
  )
}
